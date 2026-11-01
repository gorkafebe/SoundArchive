"""Enable the PostGIS extension.

PostGIS adds geographic types (points, polygons) and functions to Postgres.
The map pins in the next phase will be stored as PostGIS points.

The postgis/postgis Docker image already enables it in a fresh database, so
on our stack this is usually a no-op. Keeping it as a migration means the
schema history is complete and works against any Postgres with PostGIS
installed (for example a managed database later).

Revision ID: 0001
Revises:
Create Date: 2026-11-01
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Needs a superuser: PostGIS is not a "trusted" extension. That is why the
    # migrate service connects as the admin user and the API does not.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")


def downgrade() -> None:
    # Intentionally does nothing. Dropping PostGIS would delete every spatial
    # column and its data, and the Docker image would re-create the extension
    # on a fresh database anyway.
    pass
