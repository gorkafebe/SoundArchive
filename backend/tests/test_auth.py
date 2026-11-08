"""Accounts: invitations, signing in, CSRF, limits, administration."""

import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text, update

from app.deps import SESSION_COOKIE
from app.main import app
from app.models import AuthSession
from app.security import csrf_token_for, password_problem, verify_password, hash_password

from .conftest import ORIGIN, PASSWORD

H = {"Origin": ORIGIN}


def register(browser, code, name="ana", password=PASSWORD):
    return browser.post("/api/auth/register", headers=H, json={"code": code, "username": name, "password": password})


def login(browser, name="ana", password=PASSWORD):
    return browser.post("/api/auth/login", headers=H, json={"username": name, "password": password})


def test_register_with_invitation_sets_a_host_cookie(harness):
    browser = harness.browser()
    response = register(browser, harness.invite())
    assert response.status_code == 201
    assert response.json()["username"] == "ana"
    assert "password" not in response.text
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{SESSION_COOKIE}=")
    for attribute in ("HttpOnly", "Secure", "Path=/", "SameSite=lax"):
        assert attribute.lower() in cookie.lower()
    assert "domain" not in cookie.lower()
    assert browser.get("/api/auth/me").json()["username"] == "ana"


@pytest.mark.parametrize("kind", ["expired", "used", "revoked", "unknown"])
def test_invalid_invitations_all_give_the_same_answer(harness, kind):
    code = {
        "expired": lambda: harness.invite(days=-1),
        "used": lambda: harness.invite(used=True),
        "revoked": lambda: harness.invite(revoked=True),
        "unknown": lambda: "SA-AAAA-BBBB-CCCC-DDDD",
    }[kind]()
    response = register(harness.browser(), code)
    assert response.status_code == 400
    assert response.json()["detail"] == {"code": "invalid_invitation"}


def test_an_invitation_works_only_once(harness):
    code = harness.invite()
    assert register(harness.browser(), code, "first").status_code == 201
    assert register(harness.browser(), code, "second").status_code == 400


def test_username_is_unique_ignoring_case(harness):
    assert register(harness.browser(), harness.invite(), "Ana").status_code == 201
    assert register(harness.browser(), harness.invite(), "aNA").status_code == 409


@pytest.mark.parametrize(
    "password,code",
    [
        ("short", "password_too_short"),
        ("password1234", "password_too_common"),
        ("aaaaaaaaaaaaaaaa", "password_too_common"),
        ("xx-ana-is-my-name", "password_contains_username"),
    ],
)
def test_weak_passwords_are_refused(harness, password, code):
    response = register(harness.browser(), harness.invite(), "ana", password)
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": code}


def test_password_rules_have_no_composition_requirements():
    assert password_problem("only lowercase words here") is None


def test_passwords_are_stored_as_argon2id(harness):
    register(harness.browser(), harness.invite())
    with harness.db.admin.connect() as conn:
        stored = conn.execute(text("SELECT password_hash FROM users")).scalar_one()
    assert stored.startswith("$argon2id$")
    assert PASSWORD not in stored
    assert verify_password(hash_password("x" * 12), "x" * 12)


def test_login_and_wrong_password_do_not_reveal_whether_the_user_exists(harness):
    register(harness.browser(), harness.invite())
    assert login(harness.browser()).status_code == 200
    wrong = login(harness.browser(), password="not the right one at all")
    unknown = login(harness.browser(), name="nobody")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


def test_session_token_is_stored_only_as_a_hash(harness):
    browser = harness.browser()
    register(browser, harness.invite())
    token = browser.cookies[SESSION_COOKIE]
    assert len(token) >= 43  # 256 bits in URL-safe base64
    with harness.db.admin.connect() as conn:
        stored = conn.execute(text("SELECT token_hash FROM sessions")).scalar_one()
    assert token not in stored


def test_logout_ends_the_session(harness):
    browser = harness.signed_in("ana")
    assert browser.write("POST", "/api/auth/logout").status_code == 204
    assert browser.get("/api/auth/me").status_code == 401


def test_logout_all_ends_every_session(harness):
    one = harness.signed_in("ana")
    two = harness.browser()
    other = login(two)
    assert other.status_code == 200
    two.csrf = other.json()["csrf_token"]
    assert one.write("POST", "/api/auth/logout-all").status_code == 204
    assert two.get("/api/auth/me").status_code == 401


def test_expired_session_is_refused(harness):
    browser = harness.signed_in("ana")
    with harness.sessions() as session:
        session.execute(update(AuthSession).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        session.commit()
    assert browser.get("/api/auth/me").status_code == 401


def test_absolute_expiry_applies_even_if_recently_used(harness):
    browser = harness.signed_in("ana")
    with harness.sessions() as session:
        session.execute(update(AuthSession).values(absolute_expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        session.commit()
    assert browser.get("/api/auth/me").status_code == 401


def test_csrf_token_is_required_for_changes(harness):
    browser = harness.signed_in("ana")
    body = {"name": "A place", "latitude": 1, "longitude": 2}
    assert browser.post("/api/places", headers=H, json=body).status_code == 403
    response = browser.post("/api/places", headers={**H, "X-CSRF-Token": "wrong"}, json=body)
    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "bad_csrf"}
    assert browser.write("POST", "/api/places", json=body).status_code == 201


def test_foreign_or_missing_origin_is_refused(harness):
    browser = harness.signed_in("ana")
    body = {"name": "A place", "latitude": 1, "longitude": 2}
    for headers in ({"Origin": "https://evil.example", "X-CSRF-Token": browser.csrf}, {"X-CSRF-Token": browser.csrf}):
        response = browser.post("/api/places", headers=headers, json=body)
        assert response.status_code == 403
        assert response.json()["detail"] == {"code": "bad_origin"}
    assert harness.browser().post("/api/auth/login", json={"username": "a", "password": "b"}).status_code == 403


def test_every_state_changing_route_needs_a_session_and_csrf(harness):
    """A new route that forgot the protection fails here."""
    public = {"/api/auth/login", "/api/auth/register"}
    anonymous = harness.browser()
    found = 0
    for path, operations in app.openapi()["paths"].items():
        for method in operations:
            if method == "get" or path in public:
                continue
            found += 1
            url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
            response = anonymous.request(method.upper(), url, headers=H)
            assert response.status_code in (401, 403), f"{method} {path}: {response.status_code}"
    assert found >= 20


def test_reads_need_a_session(harness):
    anonymous = harness.browser()
    assert anonymous.get("/api/places/list").status_code == 401
    assert anonymous.get(f"/api/places/{uuid.uuid4()}").status_code == 401
    assert anonymous.get("/api/places", params={"bbox": "0,0,1,1"}).status_code == 401
    assert anonymous.get("/api/health").status_code == 200
    assert anonymous.get("/api/config").status_code == 200


def test_login_attempts_are_limited_with_a_growing_wait(harness):
    register(harness.browser(), harness.invite())
    for _ in range(5):
        assert login(harness.browser(), password="wrong wrong wrong").status_code == 401
    blocked = login(harness.browser(), password="wrong wrong wrong")
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1
    # Even the right password has to wait.
    assert login(harness.browser()).status_code == 429


def test_limit_does_not_reveal_whether_the_name_exists(harness):
    for _ in range(5):
        login(harness.browser(), name="ghost", password="wrong wrong wrong")
    assert login(harness.browser(), name="ghost").status_code == 429


def test_registration_attempts_are_limited(harness, secure_settings):
    secure_settings.rate_limit_ip = 3
    for _ in range(3):
        assert register(harness.browser(), "SA-NOPE").status_code == 400
    assert register(harness.browser(), "SA-NOPE").status_code == 429


def test_password_change_keeps_this_session_and_closes_the_others(harness):
    one = harness.signed_in("ana")
    two = harness.browser()
    login(two)
    new = "another long passphrase"
    response = one.write("POST", "/api/auth/password", json={"current_password": PASSWORD, "new_password": new})
    assert response.status_code == 204
    assert one.get("/api/auth/me").status_code == 200
    assert two.get("/api/auth/me").status_code == 401
    assert login(harness.browser(), password=PASSWORD).status_code == 401
    assert login(harness.browser(), password=new).status_code == 200


def test_password_change_needs_the_current_password(harness):
    browser = harness.signed_in("ana")
    response = browser.write(
        "POST", "/api/auth/password", json={"current_password": "wrong wrong wrong", "new_password": "another long one"}
    )
    assert response.status_code == 401


# --- Administration -----------------------------------------------------------


def test_only_admins_reach_the_admin_routes(harness):
    user = harness.signed_in("ana")
    for path in ("/api/admin/users", "/api/admin/invitations", "/api/admin/content", "/api/admin/audit"):
        assert user.get(path).status_code == 403
    assert user.write("POST", "/api/admin/invitations", json={}).status_code == 403
    assert harness.browser().get("/api/admin/users").status_code == 401


def test_admin_invitation_lifecycle(harness):
    admin = harness.signed_in("root", admin=True)
    created = admin.write("POST", "/api/admin/invitations", json={"days": 3})
    assert created.status_code == 201
    code = created.json()["code"]
    assert code.startswith("SA-")
    # The list shows a hint, and never the whole code again.
    listing = admin.get("/api/admin/invitations").json()
    assert all("code" not in row for row in listing)
    assert listing[0]["code_hint"] == code[:7]
    assert admin.write("DELETE", f"/api/admin/invitations/{created.json()['id']}").status_code == 204
    assert register(harness.browser(), code).status_code == 400


def test_deactivating_a_user_ends_its_sessions_and_blocks_login(harness):
    admin = harness.signed_in("root", admin=True)
    user = harness.signed_in("ana")
    assert admin.write("POST", f"/api/admin/users/{user.user_id}/deactivate").status_code == 200
    assert user.get("/api/auth/me").status_code == 401
    assert login(harness.browser()).status_code == 401
    assert admin.write("POST", f"/api/admin/users/{user.user_id}/reactivate").status_code == 200
    assert login(harness.browser()).status_code == 200


def test_admin_cannot_deactivate_itself(harness):
    admin = harness.signed_in("root", admin=True)
    assert admin.write("POST", f"/api/admin/users/{admin.user_id}/deactivate").status_code == 403


def test_audit_log_records_actions_without_secrets(harness):
    admin = harness.signed_in("root", admin=True)
    code = admin.write("POST", "/api/admin/invitations", json={}).json()["code"]
    entries = admin.get("/api/admin/audit").json()
    assert any(entry["action"] == "invitation.created" and entry["actor_name"] == "root" for entry in entries)
    assert code not in str(entries)
    assert PASSWORD not in str(entries)


def test_csrf_token_depends_on_the_session():
    assert csrf_token_for("a") != csrf_token_for("b")
