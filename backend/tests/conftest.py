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
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text, update
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, get_settings, settings
from app.db import get_session
from app import recordings
from app.main import app
from app.models import Invitation, User
from app.ratelimit import get_redis
from app.security import new_invitation_code, token_hash
from app.worker import tasks

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
        conn.execute(text("TRUNCATE places CASCADE"))
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


ORIGIN = "https://testserver"


@pytest.fixture
def media_dir(tmp_path, monkeypatch) -> Path:
    """Files go to a temporary folder, not to the dev stack's media volume."""
    monkeypatch.setattr(settings, "media_root", str(tmp_path))
    monkeypatch.setattr(settings, "min_free_bytes", 0)
    return tmp_path


@pytest.fixture
def secure_settings(media_dir) -> Settings:
    return settings.model_copy(
        update={"allow_anonymous_writes": False, "allowed_origins": ORIGIN, "rate_limit_user": 5, "rate_limit_ip": 1000}
    )


class Account(TestClient):
    """A browser with its own cookies, sending the Origin and CSRF headers."""

    csrf: str = ""
    user_id: str = ""

    def write(self, method: str, url: str, **kwargs):
        headers = {"Origin": ORIGIN, "X-CSRF-Token": self.csrf, **kwargs.pop("headers", {})}
        return self.request(method, url, headers=headers, **kwargs)


class Harness:
    """Creates accounts and invitations straight in the test database."""

    def __init__(self, db: ScratchDatabase) -> None:
        self.db = db
        self.sessions = sessionmaker(bind=db.app, expire_on_commit=False)

    def browser(self) -> Account:
        # https, or the client would not send a Secure cookie back.
        return Account(app, base_url=ORIGIN, follow_redirects=False)

    def invite(self, *, days: int = 7, used: bool = False, revoked: bool = False) -> str:
        code = new_invitation_code()
        now = datetime.now(UTC)
        with self.sessions() as session:
            session.add(
                Invitation(
                    code_hash=token_hash(code),
                    code_hint=code[:7],
                    expires_at=now + timedelta(days=days),
                    used_at=now if used else None,
                    revoked_at=now if revoked else None,
                )
            )
            session.commit()
        return code

    def signed_in(self, name: str, *, admin: bool = False) -> Account:
        browser = self.browser()
        response = browser.post(
            "/api/auth/register",
            headers={"Origin": ORIGIN},
            json={"code": self.invite(), "username": name, "password": PASSWORD},
        )
        assert response.status_code == 201, response.text
        browser.csrf = response.json()["csrf_token"]
        browser.user_id = response.json()["id"]
        if admin:
            with self.sessions() as session:
                session.execute(update(User).where(User.id == uuid.UUID(browser.user_id)).values(role="admin"))
                session.commit()
        return browser


PASSWORD = "a long enough passphrase"


@pytest.fixture
def harness(test_db: ScratchDatabase, secure_settings: Settings, monkeypatch) -> Iterator[Harness]:
    """A real API with accounts on, on a clean test database."""
    with test_db.admin.begin() as conn:
        conn.execute(
            text("TRUNCATE reports, place_photos, recordings, places, sessions, invitations, audit_log, users CASCADE")
        )
    sessions = sessionmaker(bind=test_db.app, expire_on_commit=False)

    def test_session() -> Iterator[Session]:
        with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = test_session
    app.dependency_overrides[get_settings] = lambda: secure_settings
    get_redis().flushdb()
    # Jobs run at once, in this process and on the test database.
    monkeypatch.setattr(tasks, "SessionLocal", sessions)
    monkeypatch.setattr(recordings, "_enqueue", lambda _client, recording_id: tasks.process_recording(str(recording_id)))
    try:
        yield Harness(test_db)
    finally:
        app.dependency_overrides.clear()
