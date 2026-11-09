"""Detect likely duplicate places, and link a place to an outside source.

- pg_trgm: compares texts by the groups of three letters they share, so
  "Panaderia Paco" and "Panadería  Paco" score as nearly equal. It is one of
  PostgreSQL's "trusted" extensions and ships with the database image.
- sa_normalize_name(): lower case and no accents. An index can only be built
  on a function that always gives the same result for the same input
  (IMMUTABLE). The usual tool, unaccent(), is not marked that way because its
  rules live in a file that could change, so this small fixed version is used.
- external_source / external_id: where a place came from ('osm', 'node/123').
  The unique index stops two live places from pointing at the same object;
  a place that was taken down does not block it being added again.

The GiST index on places.location that the distance queries need already
exists (migration 0002).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        """
        CREATE FUNCTION sa_normalize_name(value text) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE
        RETURN translate(
            lower(value),
            'áàäâãåéèëêíìïîóòöôõúùüûñç',
            'aaaaaaeeeeiiiiooooouuuunc'
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_places_name_trgm ON places USING gin (sa_normalize_name(name) gin_trgm_ops)"
    )
    op.add_column("places", sa.Column("external_source", sa.String(16), nullable=True))
    op.add_column("places", sa.Column("external_id", sa.String(64), nullable=True))
    op.create_check_constraint(
        "external_ref_complete",
        "places",
        "(external_source IS NULL) = (external_id IS NULL)",
    )
    op.create_index(
        "ix_places_external_ref",
        "places",
        ["external_source", "external_id"],
        unique=True,
        postgresql_where=sa.text("external_id IS NOT NULL AND removed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_places_external_ref", table_name="places")
    op.drop_constraint("external_ref_complete", "places", type_="check")
    op.drop_column("places", "external_id")
    op.drop_column("places", "external_source")
    op.execute("DROP INDEX ix_places_name_trgm")
    op.execute("DROP FUNCTION sa_normalize_name(text)")
    op.execute("DROP EXTENSION IF EXISTS pg_trgm")
