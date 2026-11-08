"""Who is asking, and whether they may: the checks every route builds on.

Sessions
    The browser holds a random token in a cookie (HttpOnly, so JavaScript
    cannot read it; Secure, so only over HTTPS; SameSite=Lax, so it is not
    sent with cross-site POSTs). The database keeps only its SHA-256.

    __Host- is a browser-enforced prefix: such a cookie must be Secure, on
    Path=/, and cannot set a Domain, so no other host can overwrite it.

CSRF (cross-site request forgery)
    A hostile page could otherwise make your browser send a request with your
    cookie. Every state-changing request must carry:
      - an Origin header from ALLOWED_ORIGINS (browsers set it; a page cannot
        forge it);
      - the session's CSRF token in X-CSRF-Token. The app reads it from
        /api/auth/me; another site cannot.
"""

import hmac
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_session
from app.models import AuthSession, User
from app.security import csrf_token_for, token_hash

SESSION_COOKIE = "__Host-sa_session"

# How often the sliding expiry and "last used" are written. Not on every
# request, which would turn each read into a write.
_TOUCH_INTERVAL = timedelta(minutes=5)

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


@dataclass
class Viewer:
    """Who is making this request. user is None only with anonymous mode on."""

    user: User | None
    session_token: str | None

    @property
    def id(self) -> uuid.UUID | None:
        return self.user.id if self.user else None

    @property
    def is_admin(self) -> bool:
        return self.user is not None and self.user.role == "admin"


def unauthorized() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "not_signed_in"})


def forbidden(code: str = "forbidden") -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN, detail={"code": code})


def _load_session(request: Request, db: Session, settings: Settings) -> Viewer | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    now = datetime.now(UTC)
    row = db.execute(
        select(AuthSession, User)
        .join(User, User.id == AuthSession.user_id)
        .where(AuthSession.token_hash == token_hash(token))
    ).one_or_none()
    if row is None:
        return None
    auth, user = row
    if auth.expires_at <= now or auth.absolute_expires_at <= now or not user.is_active:
        db.execute(delete(AuthSession).where(AuthSession.id == auth.id))
        db.commit()
        return None
    if now - auth.last_used_at >= _TOUCH_INTERVAL:
        new_expiry = min(now + timedelta(days=settings.session_idle_days), auth.absolute_expires_at)
        db.execute(
            update(AuthSession)
            .where(AuthSession.id == auth.id)
            .values(last_used_at=now, expires_at=new_expiry)
        )
        db.commit()
    return Viewer(user=user, session_token=token)


def optional_viewer(request: Request, db: SessionDep, settings: SettingsDep) -> Viewer | None:
    return _load_session(request, db, settings)


def require_viewer(request: Request, db: SessionDep, settings: SettingsDep) -> Viewer:
    """Anyone signed in. ALLOW_ANONYMOUS_WRITES (tests only) waives it."""
    viewer = _load_session(request, db, settings)
    if viewer is not None:
        return viewer
    if settings.allow_anonymous_writes:
        return Viewer(user=None, session_token=None)
    raise unauthorized()


def check_origin(request: Request, settings: SettingsDep) -> None:
    """Refuse a state-changing request whose Origin is not one of ours.

    For requests made before there is a session (login, registration).
    """
    if settings.allow_anonymous_writes:
        return
    origin = request.headers.get("origin")
    if origin is None or origin not in settings.allowed_origin_list:
        raise forbidden("bad_origin")


def require_writer(
    request: Request,
    viewer: Annotated[Viewer, Depends(require_viewer)],
    settings: SettingsDep,
) -> Viewer:
    """Signed in, right Origin and right CSRF token: for anything that changes data."""
    check_origin(request, settings)
    if viewer.user is None:
        return viewer  # anonymous test mode only
    sent = request.headers.get("x-csrf-token", "")
    expected = csrf_token_for(viewer.session_token or "")
    if not hmac.compare_digest(sent, expected):
        raise forbidden("bad_csrf")
    return viewer


def require_admin(viewer: Annotated[Viewer, Depends(require_viewer)]) -> Viewer:
    if not viewer.is_admin:
        raise forbidden()
    return viewer


def require_admin_writer(viewer: Annotated[Viewer, Depends(require_writer)]) -> Viewer:
    if not viewer.is_admin:
        raise forbidden()
    return viewer


ViewerDep = Annotated[Viewer, Depends(require_viewer)]
WriterDep = Annotated[Viewer, Depends(require_writer)]
AdminDep = Annotated[Viewer, Depends(require_admin)]
AdminWriterDep = Annotated[Viewer, Depends(require_admin_writer)]
