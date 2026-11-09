"""Cache of the named sites an outside provider knows about, per grid cell.

Why a cache by grid cell: the outside service is told "someone looked at this
square of about 300 m" and never the exact point. It also means the same
square is asked for once a month, however many people add places in it.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "external_place_cells",
        sa.Column("provider", sa.String(16), primary_key=True),
        sa.Column("cell", sa.String(40), primary_key=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # A short list: osm_id, type, name, category, latitude, longitude.
        sa.Column("places", JSONB, nullable=False),
    )
    op.create_index("ix_external_place_cells_fetched_at", "external_place_cells", ["fetched_at"])


def downgrade() -> None:
    op.drop_table("external_place_cells")
