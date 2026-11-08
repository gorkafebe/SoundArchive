"""Administration: invitations and users. Content moderation is in moderation.py.

    GET    /api/admin/invitations
    POST   /api/admin/invitations
    DELETE /api/admin/invitations/{id}        revoke
    GET    /api/admin/users
    POST   /api/admin/users/{id}/deactivate   and closes its sessions
    POST   /api/admin/users/{id}/reactivate
    GET    /api/admin/audit
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select

from app import audit
from app.deps import AdminDep, AdminWriterDep, SessionDep, forbidden
from app.models import AuditLog, AuthSession, Invitation, User
from app.security import new_invitation_code, token_hash

router = APIRouter(prefix="/api/admin", tags=["admin"])


class InvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days: int = Field(default=7, ge=1, le=90)


class InvitationOut(BaseModel):
    id: uuid.UUID
    code_hint: str
    created_at: datetime
    expires_at: datetime
    used_at: datetime | None
    used_by_name: str | None
    revoked_at: datetime | None


class InvitationCreated(InvitationOut):
    # Shown once: the server keeps only a hash.
    code: str


class UserOut(BaseModel):
    id: uuid.UUID
    username: str
    role: str
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None


class AuditOut(BaseModel):
    id: int
    at: datetime
    actor_name: str | None
    action: str
    target_type: str | None
    target_id: str | None
    detail: dict | None


def _invitation_out(invitation: Invitation, used_by_name: str | None) -> dict:
    return {
        "id": invitation.id,
        "code_hint": invitation.code_hint,
        "created_at": invitation.created_at,
        "expires_at": invitation.expires_at,
        "used_at": invitation.used_at,
        "used_by_name": used_by_name,
        "revoked_at": invitation.revoked_at,
    }


@router.get("/invitations", response_model=list[InvitationOut])
def list_invitations(_admin: AdminDep, db: SessionDep) -> list[dict]:
    rows = db.execute(
        select(Invitation, User.username)
        .outerjoin(User, User.id == Invitation.used_by)
        .order_by(Invitation.created_at.desc())
        .limit(200)
    ).all()
    return [_invitation_out(invitation, name) for invitation, name in rows]


@router.post("/invitations", response_model=InvitationCreated, status_code=status.HTTP_201_CREATED)
def create_invitation(body: InvitationCreate, admin: AdminWriterDep, db: SessionDep) -> dict:
    code = new_invitation_code()
    invitation = Invitation(
        code_hash=token_hash(code),
        code_hint=code[:7],
        created_by=admin.id,
        expires_at=datetime.now(UTC) + timedelta(days=body.days),
    )
    db.add(invitation)
    db.flush()
    audit.record(db, admin, "invitation.created", target_type="invitation", target_id=invitation.id)
    db.commit()
    db.refresh(invitation)
    return {**_invitation_out(invitation, None), "code": code}


@router.delete("/invitations/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invitation(invitation_id: uuid.UUID, admin: AdminWriterDep, db: SessionDep) -> None:
    invitation = db.get(Invitation, invitation_id)
    if invitation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found"})
    if invitation.used_at is None and invitation.revoked_at is None:
        invitation.revoked_at = datetime.now(UTC)
        audit.record(db, admin, "invitation.revoked", target_type="invitation", target_id=invitation.id)
        db.commit()


@router.get("/users", response_model=list[UserOut])
def list_users(_admin: AdminDep, db: SessionDep) -> list[User]:
    return list(db.scalars(select(User).order_by(User.created_at.desc()).limit(500)))


def _get_user(db: SessionDep, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found"})
    return user


@router.post("/users/{user_id}/deactivate", response_model=UserOut)
def deactivate_user(user_id: uuid.UUID, admin: AdminWriterDep, db: SessionDep) -> User:
    if user_id == admin.id:
        # Locking yourself out would leave the instance with no administrator.
        raise forbidden("cannot_deactivate_self")
    user = _get_user(db, user_id)
    user.is_active = False
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    audit.record(db, admin, "user.deactivated", target_type="user", target_id=user.id)
    db.commit()
    return user


@router.post("/users/{user_id}/reactivate", response_model=UserOut)
def reactivate_user(user_id: uuid.UUID, admin: AdminWriterDep, db: SessionDep) -> User:
    user = _get_user(db, user_id)
    user.is_active = True
    audit.record(db, admin, "user.reactivated", target_type="user", target_id=user.id)
    db.commit()
    return user


@router.get("/audit", response_model=list[AuditOut])
def audit_log(
    _admin: AdminDep, db: SessionDep, limit: int = Query(default=100, ge=1, le=500)
) -> list[AuditLog]:
    return list(db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)))
