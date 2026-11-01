"""Database connection.

The engine holds a small pool of open connections that requests reuse.
Creating it does not connect yet: the first connection opens on first use,
so the API can start (and answer /api/health) even when the database is down.
"""

from sqlalchemy import create_engine

from app.config import settings

engine = create_engine(
    settings.database_url,
    # Check a pooled connection still works before handing it out. Without
    # this, the first request after a database restart would fail.
    pool_pre_ping=True,
    # Give up connecting after 5 seconds, so /api/health/db answers 503
    # quickly instead of hanging when the database is unreachable.
    connect_args={"connect_timeout": 5},
)
