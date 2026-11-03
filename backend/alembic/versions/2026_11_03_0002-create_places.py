"""Create the places table.

A place is a point on the map; recordings (phase 4) will belong to it.

- id: random UUID (see app/models.py for why not 1, 2, 3...).
- location: geography(Point, 4326), a longitude/latitude point on the Earth.
- Two GiST indexes, the index type PostGIS uses for shapes. A normal
  (B-tree) index sorts values on a line, which works for numbers and text but
  not for "which points fall inside this rectangle". GiST groups nearby
  shapes into boxes inside boxes, so the database skips whole regions at once.
    ix_places_location       on the geography itself: for distance queries
                             in metres ("places within 500 m"), coming later.
    ix_places_location_geom  on geometry(location), the point as plain
                             lon/lat numbers: for the map rectangle query in
                             app/places.py, which must use this exact expression.

The table belongs to the admin user (the migrate service runs as admin). The
API's limited user can read and write its rows thanks to the default
privileges set by infra/postgres/init/20-create-app-user.sh; no GRANT needed.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geography

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "places",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "location",
            Geography(geometry_type="POINT", srid=4326, spatial_index=False),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("char_length(btrim(name)) BETWEEN 1 AND 120", name="name_length"),
        sa.CheckConstraint(
            "description IS NULL OR char_length(description) <= 2000", name="description_length"
        ),
    )
    op.create_index("ix_places_location", "places", ["location"], postgresql_using="gist")
    op.create_index(
        "ix_places_location_geom",
        "places",
        [sa.text("geometry(location)")],
        postgresql_using="gist",
    )
    # For the list view, which shows the newest places first.
    op.create_index("ix_places_created_at", "places", ["created_at"])


def downgrade() -> None:
    # Dropping the table drops its indexes too. This deletes every place:
    # only run it on purpose (see docs/DEPLOY_MSI.md, "Roll back").
    op.drop_table("places")
