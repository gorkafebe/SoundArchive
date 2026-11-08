"""The audit log: one row per significant action.

Only identifiers and short facts: no passwords, codes, cookies or file paths.
The caller commits, so the entry and the change it describes succeed together.
"""

from typing import Any

from sqlalchemy.orm import Session

from app.deps import Viewer
from app.models import AuditLog, User


def record(
    db: Session,
    actor: Viewer | User | None,
    action: str,
    *,
    target_type: str | None = None,
    target_id: object | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    user = actor.user if isinstance(actor, Viewer) else actor
    db.add(
        AuditLog(
            actor_id=user.id if user else None,
            actor_name=user.username if user else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            detail=detail,
        )
    )
