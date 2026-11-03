"""Database connection.

The engine holds a small pool of open connections that requests reuse.
Creating it does not connect yet: the first connection opens on first use,
so the API can start (and answer /api/health) even when the database is down.
"""

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

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

# A Session is one unit of work: the queries of one request, in one
# transaction. expire_on_commit=False keeps the loaded values readable after
# commit, so an endpoint can return the row it has just saved.
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed afterwards.

    Tests replace it with a session on a separate test database.
    """
    with SessionLocal() as session:
        yield session
