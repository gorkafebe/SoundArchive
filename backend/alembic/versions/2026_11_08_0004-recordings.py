"""Recordings, place photos and reports.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NOW = sa.func.now()
UUID_DEFAULT = sa.text("gen_random_uuid()")


def user_fk(name: str, *, index: bool = False) -> sa.Column:
    return sa.Column(name, sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), index=index)


def upgrade() -> None:
    op.create_table(
        "recordings",
        sa.Column("id", sa.Uuid(), server_default=UUID_DEFAULT, primary_key=True),
        sa.Column("place_id", sa.Uuid(), sa.ForeignKey("places.id", ondelete="RESTRICT"), nullable=False),
        user_fk("author_id", index=True),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("heard", sa.Text()),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recorded_tz", sa.String(64)),
        sa.Column("status", sa.String(12), server_default="uploading", nullable=False, index=True),
        sa.Column("failure_code", sa.String(40)),
        sa.Column("visibility", sa.String(8), server_default="public", nullable=False),
        sa.Column("show_author", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("license", sa.String(24), server_default="all-rights-reserved", nullable=False),
        sa.Column("capture_method", sa.String(8), nullable=False),
        sa.Column("capture_settings", JSONB),
        sa.Column("device_note", sa.String(160)),
        sa.Column("declared_size", sa.BigInteger()),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("original_filename", sa.String(255)),
        sa.Column("sha256", sa.String(64)),
        sa.Column("duration_seconds", sa.Float()),
        sa.Column("container", sa.String(40)),
        sa.Column("codec", sa.String(40)),
        sa.Column("sample_rate", sa.Integer()),
        sa.Column("channels", sa.Integer()),
        sa.Column("bit_depth", sa.Integer()),
        sa.Column("loudness_lufs", sa.Float()),
        sa.Column("true_peak_dbfs", sa.Float()),
        sa.Column("original_path", sa.Text()),
        sa.Column("derived_path", sa.Text()),
        sa.Column("peaks_path", sa.Text()),
        sa.Column("removed_at", sa.DateTime(timezone=True)),
        sa.Column("removed_reason", sa.Text()),
        user_fk("removed_by"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint(
            "status IN ('uploading','processing','ready','failed','removed')", name="status_valid"
        ),
        sa.CheckConstraint("visibility IN ('public','private')", name="visibility_valid"),
        sa.CheckConstraint(
            "license IN ('all-rights-reserved','cc-by','cc-by-nc','cc-by-sa','cc-by-nc-sa','cc0')",
            name="license_valid",
        ),
        sa.CheckConstraint("capture_method IN ('browser','upload')", name="capture_method_valid"),
        sa.CheckConstraint("char_length(btrim(title)) BETWEEN 1 AND 160", name="title_length"),
    )
    op.create_index(
        "ix_recordings_place_recorded", "recordings", ["place_id", sa.text("recorded_at DESC")]
    )

    op.create_table(
        "place_photos",
        sa.Column("id", sa.Uuid(), server_default=UUID_DEFAULT, primary_key=True),
        sa.Column("place_id", sa.Uuid(), sa.ForeignKey("places.id", ondelete="RESTRICT"), nullable=False, index=True),
        user_fk("uploader_id", index=True),
        sa.Column("caption", sa.String(300)),
        sa.Column("alt_text", sa.String(500)),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("large_path", sa.Text(), nullable=False),
        sa.Column("medium_path", sa.Text(), nullable=False),
        sa.Column("thumb_path", sa.Text(), nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True)),
        sa.Column("removed_reason", sa.Text()),
        user_fk("removed_by"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
    )

    op.create_table(
        "reports",
        sa.Column("id", sa.Uuid(), server_default=UUID_DEFAULT, primary_key=True),
        sa.Column("recording_id", sa.Uuid(), sa.ForeignKey("recordings.id", ondelete="CASCADE"), nullable=False),
        user_fk("reporter_id"),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        user_fk("resolved_by"),
    )
    op.create_index(
        "ix_reports_open", "reports", ["recording_id"], postgresql_where=sa.text("resolved_at IS NULL")
    )


def downgrade() -> None:
    op.drop_table("reports")
    op.drop_table("place_photos")
    op.drop_table("recordings")
