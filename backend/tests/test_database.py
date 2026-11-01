"""Tests that need the real database. Run them inside Compose: make test."""

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError

from app.config import settings
from app.db import engine as app_engine  # connects as the app user, like the API


def test_health_db_reports_versions(client):
    response = client.get("/api/health/db")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["postgresql_version"]
    assert body["postgis_version"].startswith("3.")


@pytest.fixture
def admin_engine():
    """A connection as the admin user, the same user the migrate service uses.

    Only the dev stack passes these variables to the api container
    (compose.dev.yaml), so this test is skipped anywhere else.
    """
    user = os.environ.get("TEST_ADMIN_DB_USER")
    password = os.environ.get("TEST_ADMIN_DB_PASSWORD")
    if not user or not password:
        pytest.skip("TEST_ADMIN_DB_USER / TEST_ADMIN_DB_PASSWORD not set (dev stack only)")
    engine = create_engine(settings.database_url.set(username=user, password=password))
    yield engine
    engine.dispose()


def test_app_user_can_use_tables_created_by_admin(admin_engine):
    """Proves the default privileges from infra/postgres/init/20-create-app-user.sh.

    The admin creates a throwaway table (as a migration would), and the app
    user must be able to insert, read, update and delete rows in it, with no
    GRANT run in between. The INSERT also proves USAGE on the table's sequence.
    """
    table = f"privilege_check_{uuid.uuid4().hex[:8]}"
    with admin_engine.begin() as conn:
        conn.execute(
            text(
                f"CREATE TABLE {table} ("
                " id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"
                " note text NOT NULL)"
            )
        )

    try:
        with app_engine.begin() as conn:
            # Make sure we are really testing as the app user, not the admin.
            assert conn.execute(text("SELECT current_user")).scalar_one() == settings.db_user

            row_id = conn.execute(
                text(f"INSERT INTO {table} (note) VALUES ('recorded') RETURNING id")
            ).scalar_one()
            conn.execute(text(f"UPDATE {table} SET note = 'edited' WHERE id = :id"), {"id": row_id})
            note = conn.execute(
                text(f"SELECT note FROM {table} WHERE id = :id"), {"id": row_id}
            ).scalar_one()
            assert note == "edited"
            conn.execute(text(f"DELETE FROM {table} WHERE id = :id"), {"id": row_id})
    finally:
        with admin_engine.begin() as conn:
            conn.execute(text(f"DROP TABLE {table}"))


def test_app_user_cannot_change_the_schema():
    """The API's user is limited: not a superuser, and cannot create tables."""
    with app_engine.connect() as conn:
        is_superuser = conn.execute(
            text("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
        ).scalar_one()
        assert is_superuser is False

        with pytest.raises(ProgrammingError, match="permission denied"):
            conn.execute(text("CREATE TABLE should_not_exist (id int)"))
