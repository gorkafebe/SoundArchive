"""Database tables, as SQLAlchemy 2 classes.

The migrations in alembic/versions/ create the real tables; these classes
describe the same tables so the code can query them. When you change a
class, write a migration too (alembic revision --autogenerate helps).
"""

import uuid
from datetime import datetime
from typing import Any

from geoalchemy2 import Geography
from geoalchemy2.elements import WKBElement
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Text limits, shared by the table checks, the API schemas and (copied) the
# web form, so all three layers agree.
NAME_MAX = 120
DESCRIPTION_MAX = 2000
TITLE_MAX = 160
HEARD_MAX = 2000
REASON_MAX = 500
CAPTION_MAX = 300
ALT_MAX = 500

ROLES = ("user", "admin")
RECORDING_STATUSES = ("uploading", "processing", "ready", "failed", "removed")
VISIBILITIES = ("public", "private")
LICENSES = ("all-rights-reserved", "cc-by", "cc-by-nc", "cc-by-sa", "cc-by-nc-sa", "cc0")
CAPTURE_METHODS = ("browser", "upload")


class Base(DeclarativeBase):
    pass


class Place(Base):
    """A place on the map. Recordings (phase 4) will belong to a place."""

    __tablename__ = "places"
    __table_args__ = (
        # The database enforces the limits too, so a bug in the API (or a
        # manual INSERT) cannot store an empty or oversized name.
        CheckConstraint(
            f"char_length(btrim(name)) BETWEEN 1 AND {NAME_MAX}", name="name_length"
        ),
        CheckConstraint(
            f"description IS NULL OR char_length(description) <= {DESCRIPTION_MAX}",
            name="description_length",
        ),
    )

    # A random UUID, not 1, 2, 3...: the id appears in shareable links, and a
    # counter would reveal how many places exist and invite guessing.
    # gen_random_uuid() is built into PostgreSQL 13 and later.
    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(String(NAME_MAX))
    description: Mapped[str | None] = mapped_column(Text)
    # geography = a point on the round Earth (longitude, latitude in degrees,
    # WGS 84, the GPS system: SRID 4326). Distances come out in metres.
    # spatial_index=False: the migration creates the indexes explicitly.
    location: Mapped[WKBElement] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False), nullable=False
    )
    # How precise the point is, in metres, when the person said so or the
    # device reported it. None = not known.
    location_accuracy_m: Mapped[int | None] = mapped_column(Integer)
    # Who added it. NULL for places from before accounts existed, or whose
    # author's account was removed.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # Taken down by a person or an admin: hidden from everyone, files and row kept.
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_reason: Mapped[str | None] = mapped_column(Text)
    removed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Where the place came from, when it was picked from an outside list:
    # ('osm', 'node/123'). The migration adds a unique index on the pair.
    external_source: Mapped[str | None] = mapped_column(String(16))
    external_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class User(Base):
    """An account. Created through an invitation or the admin command line."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('user', 'admin')", name="role_valid"),
        # Case-insensitive uniqueness: "Ana" and "ana" are the same person.
        Index("ix_users_username_lower", text("lower(username)"), unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))
    username: Mapped[str] = mapped_column(String(32))
    # Argon2id hash (argon2-cffi); the password itself is never stored.
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(10), server_default="user")
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    language: Mapped[str | None] = mapped_column(String(5))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Invitation(Base):
    __tablename__ = "invitations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))
    # SHA-256 of the code. The code itself is shown once, when it is created.
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # The start of the code, so an admin can tell invitations apart.
    code_hint: Mapped[str] = mapped_column(String(16))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    used_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthSession(Base):
    """A signed-in browser. The cookie holds a random token; only its hash is here."""

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Sliding: moves forward with use. Absolute: never moves.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(String(200))


class AuditLog(Base):
    """Who did what, and when. Never passwords, codes, cookies or file paths."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Kept as text so the entry still reads well after the account is gone.
    actor_name: Mapped[str | None] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str | None] = mapped_column(String(32))
    target_id: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class Recording(Base):
    """One sound, in one place, at one moment."""

    __tablename__ = "recordings"
    __table_args__ = (
        CheckConstraint(
            "status IN ('uploading','processing','ready','failed','removed')", name="status_valid"
        ),
        CheckConstraint("visibility IN ('public','private')", name="visibility_valid"),
        CheckConstraint(
            "license IN ('all-rights-reserved','cc-by','cc-by-nc','cc-by-sa','cc-by-nc-sa','cc0')",
            name="license_valid",
        ),
        CheckConstraint("capture_method IN ('browser','upload')", name="capture_method_valid"),
        CheckConstraint(f"char_length(btrim(title)) BETWEEN 1 AND {TITLE_MAX}", name="title_length"),
        Index("ix_recordings_place_recorded", "place_id", text("recorded_at DESC")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))
    place_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("places.id", ondelete="RESTRICT"))
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str] = mapped_column(String(TITLE_MAX))
    # "What you can hear": the written description, for people who cannot listen.
    heard: Mapped[str | None] = mapped_column(Text)
    # When the sound was captured (UTC) and the time zone it happened in.
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    recorded_tz: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(12), server_default="uploading", index=True)
    # Why processing failed, in a short code the interface can translate.
    failure_code: Mapped[str | None] = mapped_column(String(40))
    visibility: Mapped[str] = mapped_column(String(8), server_default="public")
    show_author: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    license: Mapped[str] = mapped_column(String(24), server_default="all-rights-reserved")
    capture_method: Mapped[str] = mapped_column(String(8))
    # What the browser really applied (echo cancellation and so on), or the
    # device the person named for an uploaded file. Declared, not verified.
    capture_settings: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    device_note: Mapped[str | None] = mapped_column(String(160))
    # Size the client promised, and what actually arrived.
    declared_size: Mapped[int | None] = mapped_column(BigInteger)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    original_filename: Mapped[str | None] = mapped_column(String(255))
    # Technical facts, from ffprobe and ebur128: the server's own measurement.
    sha256: Mapped[str | None] = mapped_column(String(64))
    duration_seconds: Mapped[float | None] = mapped_column(Float)
    container: Mapped[str | None] = mapped_column(String(40))
    codec: Mapped[str | None] = mapped_column(String(40))
    sample_rate: Mapped[int | None] = mapped_column(Integer)
    channels: Mapped[int | None] = mapped_column(Integer)
    bit_depth: Mapped[int | None] = mapped_column(Integer)
    loudness_lufs: Mapped[float | None] = mapped_column(Float)
    true_peak_dbfs: Mapped[float | None] = mapped_column(Float)
    # Paths relative to the media root. Never sent to a client.
    original_path: Mapped[str | None] = mapped_column(Text)
    derived_path: Mapped[str | None] = mapped_column(Text)
    peaks_path: Mapped[str | None] = mapped_column(Text)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_reason: Mapped[str | None] = mapped_column(Text)
    removed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PlacePhoto(Base):
    __tablename__ = "place_photos"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))
    place_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("places.id", ondelete="RESTRICT"), index=True)
    uploader_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    caption: Mapped[str | None] = mapped_column(String(CAPTION_MAX))
    alt_text: Mapped[str | None] = mapped_column(String(ALT_MAX))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    # Paths relative to the media root. Never sent to a client.
    large_path: Mapped[str] = mapped_column(Text)
    medium_path: Mapped[str] = mapped_column(Text)
    thumb_path: Mapped[str] = mapped_column(Text)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_reason: Mapped[str | None] = mapped_column(Text)
    removed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Report(Base):
    """Someone flagged a recording for an administrator to look at."""

    __tablename__ = "reports"
    __table_args__ = (Index("ix_reports_open", "recording_id", postgresql_where=text("resolved_at IS NULL")),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))
    recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"))
    reporter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reason: Mapped[str] = mapped_column(String(REASON_MAX))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
