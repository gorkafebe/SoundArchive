"""Shared pytest fixtures.

Two kinds of database tests:

- test_database.py checks the dev database itself (versions, privileges).
- test_places.py needs rows. It never writes to the dev database: the
  ``test_db`` fixture creates a separate, empty database for the test run,
  sets it up like the real one (same privileges, all migrations), and drops it
  at the end, even if the tests fail. Creating a database needs the admin
  user, so these tests run only where TEST_ADMIN_DB_* is set (the dev stack).
"""

import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, get_settings, settings
from app.db import get_session
from app.main import app

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def client() -> TestClient:
    # TestClient calls the app in-process: no network, no running server needed.
    return TestClient(app)


def admin_credentials() -> tuple[str, str] | None:
    user = os.environ.get("TEST_ADMIN_DB_USER")
    password = os.environ.get("TEST_ADMIN_DB_PASSWORD")
    return (user, password) if user and password else None


def alembic_config() -> Config:
    # No alembic.ini here on purpose: its logging section would reconfigure
    # pytest's logging. Only the location of the migrations is needed.
    cfg = Config()
    cfg.set_main_option("script_location", os.path.join(BACKEND_DIR, "alembic"))
    return cfg


@dataclass
class ScratchDatabase:
    name: str
    admin: Engine  # the admin user, like the migrate service
    app: Engine  # the limited app user, like the API

    def migrate(self, revision: str, *, down: bool = False) -> None:
        cfg = alembic_config()
        with self.admin.begin() as conn:
            cfg.attributes["connection"] = conn
            (command.downgrade if down else command.upgrade)(cfg, revision)


@pytest.fixture(scope="session")
def test_db() -> Iterator[ScratchDatabase]:
    creds = admin_credentials()
    if creds is None:
        pytest.skip("TEST_ADMIN_DB_USER / TEST_ADMIN_DB_PASSWORD not set (dev stack only)")
    user, password = creds
    name = f"sa_test_{uuid.uuid4().hex[:10]}"
    admin_url = settings.database_url.set(username=user, password=password)

    # CREATE DATABASE cannot run inside a transaction: AUTOCOMMIT.
    server = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with server.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin = create_engine(admin_url.set(database=name))
    app_engine = create_engine(settings.database_url.set(database=name))
    try:
        # The same default privileges as infra/postgres/init/20-create-app-user.sh.
        # Those are stored per database, so a new database needs them again.
        with admin.begin() as conn:
            conn.execute(
                text(
                    f'ALTER DEFAULT PRIVILEGES FOR ROLE "{user}" IN SCHEMA public '
                    f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{settings.db_user}"'
                )
            )
            conn.execute(
                text(
                    f'ALTER DEFAULT PRIVILEGES FOR ROLE "{user}" IN SCHEMA public '
                    f'GRANT USAGE ON SEQUENCES TO "{settings.db_user}"'
                )
            )
        db = ScratchDatabase(name=name, admin=admin, app=app_engine)
        db.migrate("head")
        yield db
    finally:
        app_engine.dispose()
        admin.dispose()
        with server.connect() as conn:
            # FORCE closes any connection still open, so the drop never hangs.
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        server.dispose()


@pytest.fixture
def clean_places(test_db: ScratchDatabase) -> Iterator[ScratchDatabase]:
    """Every test starts with an empty places table."""
    with test_db.admin.begin() as conn:
        conn.execute(text("TRUNCATE places"))
    yield test_db


@pytest.fixture
def writes_enabled() -> bool:
    """Override in a test module or with @pytest.mark.parametrize."""
    return True


@pytest.fixture
def api(clean_places: ScratchDatabase, writes_enabled: bool) -> Iterator[TestClient]:
    """A client whose API talks to the test database as the app user."""
    sessions = sessionmaker(bind=clean_places.app, expire_on_commit=False)

    def test_session() -> Iterator[Session]:
        with sessions() as session:
            yield session

    def test_settings() -> Settings:
        return settings.model_copy(update={"allow_anonymous_writes": writes_enabled})

    app.dependency_overrides[get_session] = test_session
    app.dependency_overrides[get_settings] = test_settings
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
