"""Shared pytest fixtures."""

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    # TestClient calls the app in-process: no network, no running server needed.
    return TestClient(app)
