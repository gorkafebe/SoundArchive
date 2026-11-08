"""Accounts: users, invitations, sessions, audit log; authorship of places.

Existing places keep working: the new columns on `places` are all optional,
so places from before accounts simply have no author.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NOW = sa.func.now()
UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), server_default=UUID_DEFAULT, primary_key=True),
        sa.Column("username", sa.String(32), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("role", sa.String(10), server_default="user", nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("language", sa.String(5)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("role IN ('user', 'admin')", name="role_valid"),
    )
    op.create_index("ix_users_username_lower", "users", [sa.text("lower(username)")], unique=True)

    op.create_table(
        "invitations",
        sa.Column("id", sa.Uuid(), server_default=UUID_DEFAULT, primary_key=True),
        sa.Column("code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("code_hint", sa.String(16), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column("used_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )

    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), server_default=UUID_DEFAULT, primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("absolute_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_agent", sa.String(200)),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])

    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("actor_name", sa.String(32)),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("target_type", sa.String(32)),
        sa.Column("target_id", sa.String(64)),
        sa.Column("detail", JSONB),
    )
    op.create_index("ix_audit_log_at", "audit_log", ["at"])

    op.add_column("places", sa.Column("location_accuracy_m", sa.Integer()))
    op.add_column("places", sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")))
    op.add_column("places", sa.Column("removed_at", sa.DateTime(timezone=True)))
    op.add_column("places", sa.Column("removed_reason", sa.Text()))
    op.add_column("places", sa.Column("removed_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")))
    op.create_index("ix_places_created_by", "places", ["created_by"])


def downgrade() -> None:
    op.drop_index("ix_places_created_by", table_name="places")
    for column in ("removed_by", "removed_reason", "removed_at", "created_by", "location_accuracy_m"):
        op.drop_column("places", column)
    op.drop_table("audit_log")
    op.drop_table("sessions")
    op.drop_table("invitations")
    op.drop_table("users")
