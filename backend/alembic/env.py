"""Alembic environment: how Alembic connects to the database.

Runs whenever you call an alembic command (the migrate service runs
`alembic upgrade head`). It reuses the API's settings class, so the
connection details come from environment variables, never from a file.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from app.config import settings
from app.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# The tables as the code describes them (app/models.py), so
# `alembic revision --autogenerate` can compare them with the database.
target_metadata = Base.metadata


def run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    # Each migration runs inside a transaction: if it fails half-way,
    # Postgres rolls back everything it did.
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # The tests pass their own connection (to a separate test database);
    # see backend/tests/conftest.py. Otherwise connect with the settings.
    connection = config.attributes.get("connection")
    if connection is not None:
        run_migrations(connection)
        return
    # NullPool: a one-shot command needs one connection, not a pool.
    engine = create_engine(settings.database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        run_migrations(connection)


if context.is_offline_mode():
    raise SystemExit("Offline mode (--sql) is not used in this project.")
run_migrations_online()
