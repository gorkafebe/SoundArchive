"""Database tables, as SQLAlchemy 2 classes.

The migrations in alembic/versions/ create the real tables; these classes
describe the same tables so the code can query them. When you change a
class, write a migration too (alembic revision --autogenerate helps).
"""

import uuid
from datetime import datetime

from geoalchemy2 import Geography
from geoalchemy2.elements import WKBElement
from sqlalchemy import CheckConstraint, DateTime, String, Text, func, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Text limits, shared by the table checks, the API schemas and (copied) the
# web form, so all three layers agree.
NAME_MAX = 120
DESCRIPTION_MAX = 2000


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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
