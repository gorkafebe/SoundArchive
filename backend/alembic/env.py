"""Alembic environment: how Alembic connects to the database.

Runs whenever you call an alembic command (the migrate service runs
`alembic upgrade head`). It reuses the API's settings class, so the
connection details come from environment variables, never from a file.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from app.config import settings

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# There are no SQLAlchemy models yet. When tables arrive (next phase), set this
# to the models' MetaData so `alembic revision --autogenerate` can compare them.
target_metadata = None


def run_migrations_online() -> None:
    # NullPool: a one-shot command needs one connection, not a pool.
    engine = create_engine(settings.database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        # Each migration runs inside a transaction: if it fails half-way,
        # Postgres rolls back everything it did.
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("Offline mode (--sql) is not used in this project.")
run_migrations_online()
