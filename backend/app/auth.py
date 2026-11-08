"""Sign up with an invitation, sign in and out, change a password.

    POST /api/auth/register       create an account with an invitation code
    POST /api/auth/login
    POST /api/auth/logout
    POST /api/auth/logout-all     sign out on every device
    GET  /api/auth/me             who am I (and the CSRF token)
    PATCH /api/auth/me            preferred language
    POST /api/auth/password       change password

Error messages never say whether a username exists, and a login for an unknown
name still runs the slow password check, so timing does not tell either.
"""

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

import redis
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import audit
from app.config import Settings
from app.deps import (
    SESSION_COOKIE,
    SessionDep,
    SettingsDep,
    ViewerDep,
    WriterDep,
    check_origin,
    unauthorized,
)
from app.models import AuthSession, Invitation, User
from app.ratelimit import AttemptLimiter, client_ip, get_redis
from app.security import (
    PASSWORD_MAX,
    csrf_token_for,
    hash_password,
    needs_rehash,
    new_token,
    normalise_code,
    password_problem,
    token_hash,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
RedisDep = Annotated[redis.Redis, Depends(get_redis)]


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(max_length=64)
    password: str = Field(max_length=PASSWORD_MAX * 4)


class Registration(Credentials):
    code: str = Field(max_length=64)
    language: str | None = Field(default=None, pattern="^(es|en)$")


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(max_length=PASSWORD_MAX * 4)
    new_password: str = Field(max_length=PASSWORD_MAX * 4)


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    language: str | None = Field(default=None, pattern="^(es|en)$")


class Me(BaseModel):
    id: uuid.UUID
    username: str
    role: str
    language: str | None
    csrf_token: str


def _set_cookie(response: Response, token: str, config: Settings) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=config.session_absolute_days * 86400,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")


def create_session(db: Session, user: User, request: Request, config: Settings) -> str:
    token = new_token()
    now = datetime.now(UTC)
    db.add(
        AuthSession(
            token_hash=token_hash(token),
            user_id=user.id,
            expires_at=now + timedelta(days=config.session_idle_days),
            absolute_expires_at=now + timedelta(days=config.session_absolute_days),
            user_agent=(request.headers.get("user-agent") or "")[:200] or None,
        )
    )
    return token


def _me(user: User, token: str) -> Me:
    return Me(
        id=user.id,
        username=user.username,
        role=user.role,
        language=user.language,
        csrf_token=csrf_token_for(token),
    )


def _problem(code: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": code})


@router.post("/register", response_model=Me, status_code=status.HTTP_201_CREATED)
def register(
    body: Registration,
    request: Request,
    response: Response,
    db: SessionDep,
    config: SettingsDep,
    client: RedisDep,
    _origin: Annotated[None, Depends(check_origin)],
) -> Me:
    limiter = AttemptLimiter(client, config, "register")
    keys = {"ip": client_ip(request)}
    limiter.check(keys)

    code_hash = token_hash(normalise_code(body.code))
    now = datetime.now(UTC)
    # FOR UPDATE: two people submitting the same code at once are queued, and
    # only the first finds it unused.
    invitation = db.execute(
        select(Invitation).where(Invitation.code_hash == code_hash).with_for_update()
    ).scalar_one_or_none()
    if (
        invitation is None
        or invitation.used_at is not None
        or invitation.revoked_at is not None
        or invitation.expires_at <= now
    ):
        limiter.failed(keys)
        # The same answer for every case: no hint about which codes exist.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_invitation"})

    username = body.username.strip()
    if not USERNAME_RE.fullmatch(username):
        raise _problem("username_invalid")
    problem = password_problem(body.password, username)
    if problem:
        raise _problem(problem)

    exists = db.scalar(select(func.count()).select_from(User).where(func.lower(User.username) == username.lower()))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "username_taken"})

    user = User(username=username, password_hash=hash_password(body.password), language=body.language)
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "username_taken"}) from None
    invitation.used_at = now
    invitation.used_by = user.id
    token = create_session(db, user, request, config)
    user.last_login_at = now
    audit.record(db, user, "account.registered", target_type="user", target_id=user.id)
    db.commit()
    _set_cookie(response, token, config)
    return _me(user, token)


@router.post("/login", response_model=Me)
def login(
    body: Credentials,
    request: Request,
    response: Response,
    db: SessionDep,
    config: SettingsDep,
    client: RedisDep,
    _origin: Annotated[None, Depends(check_origin)],
) -> Me:
    limiter = AttemptLimiter(client, config, "login")
    keys = {"user": body.username.strip(), "ip": client_ip(request)}
    limiter.check(keys)

    user = db.execute(
        select(User).where(func.lower(User.username) == body.username.strip().lower())
    ).scalar_one_or_none()
    valid = verify_password(user.password_hash if user else None, body.password)
    if not valid or user is None or not user.is_active:
        limiter.failed(keys)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "bad_credentials"})

    limiter.succeeded(keys)
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    token = create_session(db, user, request, config)
    user.last_login_at = datetime.now(UTC)
    db.commit()
    _set_cookie(response, token, config)
    return _me(user, token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response, viewer: WriterDep, db: SessionDep) -> None:
    db.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash(viewer.session_token or "")))
    db.commit()
    _clear_cookie(response)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def logout_all(response: Response, viewer: WriterDep, db: SessionDep) -> None:
    db.execute(delete(AuthSession).where(AuthSession.user_id == viewer.id))
    audit.record(db, viewer, "account.logout_all", target_type="user", target_id=viewer.id)
    db.commit()
    _clear_cookie(response)


@router.get("/me", response_model=Me)
def me(viewer: ViewerDep) -> Me:
    if viewer.user is None or viewer.session_token is None:
        raise unauthorized()
    return _me(viewer.user, viewer.session_token)


@router.patch("/me", response_model=Me)
def update_me(body: Preferences, viewer: WriterDep, db: SessionDep) -> Me:
    if viewer.user is None or viewer.session_token is None:
        raise unauthorized()
    viewer.user.language = body.language
    db.commit()
    return _me(viewer.user, viewer.session_token)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PasswordChange,
    request: Request,
    viewer: WriterDep,
    db: SessionDep,
    config: SettingsDep,
    client: RedisDep,
) -> None:
    user = viewer.user
    if user is None or viewer.session_token is None:
        raise unauthorized()
    limiter = AttemptLimiter(client, config, "password")
    keys = {"user": user.username, "ip": client_ip(request)}
    limiter.check(keys)
    if not verify_password(user.password_hash, body.current_password):
        limiter.failed(keys)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "bad_credentials"})
    limiter.succeeded(keys)
    problem = password_problem(body.new_password, user.username)
    if problem:
        raise _problem(problem)
    user.password_hash = hash_password(body.new_password)
    # Every other device is signed out; this one keeps its session.
    db.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user.id,
            AuthSession.token_hash != token_hash(viewer.session_token),
        )
    )
    db.execute(update(User).where(User.id == user.id).values(updated_at=func.now()))
    audit.record(db, viewer, "account.password_changed", target_type="user", target_id=user.id)
    db.commit()
