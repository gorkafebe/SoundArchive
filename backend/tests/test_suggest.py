"""Suggestions from OpenStreetMap, against a local stand-in for Overpass.

The stand-in is a real HTTP server on this machine, so the test sees exactly
the bytes that would leave the application. Nothing here reaches the internet.

Run with: make test
"""

import json
import threading
import time
import urllib.parse
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app import overpass
from app.overpass import OverpassProvider, build_query, parse_elements
from app.place_suggestions import Box, cell_for, cells_around, delete_expired_cells, distance_m
from app.ratelimit import get_redis

SAMPLE = (Path(__file__).parent / "data" / "overpass_centre.json").read_text()

# The middle of one grid cell, so the circle stays inside it.
SIZE = 0.003
LAT = (13885 + 0.5) * SIZE
LON = (-293 + 0.5) * SIZE


class FakeOverpass:
    """Records every request; answers as told."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.status = 200
        self.body = SAMPLE
        self.delay = 0.0
        self.headers: dict[str, str] = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length).decode()
                outer.calls.append({"headers": dict(self.headers.items()), "body": raw, "path": self.path})
                time.sleep(outer.delay)
                payload = outer.body.encode()
                self.send_response(outer.status)
                for key, value in outer.headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/interpreter"

    def query(self, index: int = 0) -> str:
        return urllib.parse.parse_qs(self.calls[index]["body"])["data"][0]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake(monkeypatch):
    server = FakeOverpass()
    monkeypatch.setitem(overpass.ALLOWED_HOSTS, "127.0.0.1", "http")
    yield server
    server.close()


@pytest.fixture
def stack(harness, secure_settings, fake):
    secure_settings.external_places_enabled = True
    secure_settings.overpass_url = fake.url
    secure_settings.overpass_min_interval_s = 0
    with harness.db.admin.begin() as conn:
        conn.execute(text("TRUNCATE external_place_cells"))
    return harness


def suggest(browser, lat=LAT, lon=LON, **params):
    response = browser.get("/api/places/suggest", params={"lat": lat, "lon": lon, **params})
    assert response.status_code == 200, response.text
    return response.json()


def use_sample_at(fake, lat=LAT, lon=LON):
    """The recorded answer, moved so its sites are around this point."""
    data = json.loads(SAMPLE)
    for element in data["elements"]:
        spot = element.get("center") or element
        if "lat" in spot:
            spot["lat"] = round(spot["lat"] - 41.6565 + lat, 6)
            spot["lon"] = round(spot["lon"] + 0.8775 + lon, 6)
    fake.body = json.dumps(data)


# --- Cells --------------------------------------------------------------------


def test_the_circle_in_the_middle_of_a_cell_needs_one_cell():
    assert [c.key for c in cells_around(LAT, LON, 80, SIZE)] == ["0.003:13885:-293"]


def test_near_a_corner_up_to_four_cells_and_the_points_own_first():
    lat = 13885 * SIZE + 0.0001
    lon = -293 * SIZE + 0.0001
    cells = cells_around(lat, lon, 80, SIZE)
    assert len(cells) == 4
    assert cells[0] == cell_for(lat, lon, SIZE)


def test_cells_stop_at_the_date_line_and_the_pole():
    assert all(c.box().east <= 180 for c in cells_around(0.0, 179.9999, 80, SIZE))
    assert all(c.box().north <= 90 for c in cells_around(89.9999, 10.0, 80, SIZE))


def test_never_more_than_four_cells_near_the_pole():
    assert len(cells_around(89.9, 10.0, 150, SIZE)) <= 4


def test_distance_across_the_date_line():
    assert 21 < distance_m(0.0, 179.9999, 0.0, -179.9999) < 24


# --- The query and the parsing -----------------------------------------------------


def test_query_is_bounded_and_excludes_street_furniture():
    query = build_query(Box(41.655, -0.879, 41.658, -0.876), 15)
    assert query.startswith("[out:json][timeout:15][bbox:41.655000,-0.879000,41.658000,-0.876000];")
    assert 'nwr["name"]["amenity"]["amenity"!~"^(' in query
    assert "bench" in query and "parking" in query
    assert query.endswith("out center tags 800;")


def test_parsing_keeps_named_places_only():
    places = {p.osm_id: p for p in parse_elements(json.loads(SAMPLE))}
    assert set(places) == {"node/1001", "way/2002", "relation/3003", "node/1009"}
    assert places["way/2002"].category == "cafe"
    assert places["way/2002"].latitude == pytest.approx(41.6567)


def test_parsing_survives_a_strange_answer():
    assert parse_elements({}) == []
    assert parse_elements({"elements": [{"type": "node"}, {"id": 1, "type": "node", "tags": {"name": "x"}}]}) == []


# --- Privacy --------------------------------------------------------------------


def test_only_the_cell_leaves_the_server(stack, fake, secure_settings):
    use_sample_at(fake)
    # An exact position, inside the cell but not at any grid line.
    lat, lon = LAT + 0.000213, LON - 0.000177
    browser = stack.signed_in("ana")
    suggest(browser, lat, lon)

    assert len(fake.calls) == 1
    call = fake.calls[0]
    query = fake.query()
    cell = cell_for(lat, lon, SIZE).box(secure_settings.external_cell_margin_deg)
    assert f"[bbox:{cell.south:.6f},{cell.west:.6f},{cell.north:.6f},{cell.east:.6f}]" in query
    for digits in (f"{lat:.6f}", f"{lon:.6f}", f"{lat:.4f}", f"{lon:.4f}", str(lat), str(lon)):
        assert digits not in query

    headers = {key.lower(): value for key, value in call["headers"].items()}
    assert headers["user-agent"] == f"SoundArchive/{overpass.APP_VERSION} (self-hosted)"
    assert "@" not in headers["user-agent"]
    for private in ("cookie", "authorization", "x-csrf-token", "referer", "origin", "x-forwarded-for"):
        assert private not in headers
    assert "ana" not in call["body"]
    assert browser.cookies, "the browser did have a session to leak"
    for value in browser.cookies.values():
        assert value not in call["body"]


def test_the_same_box_for_every_point_in_a_cell(stack, fake):
    use_sample_at(fake)
    browser = stack.signed_in("ana")
    suggest(browser, LAT + 0.0002, LON + 0.0002)
    first = fake.query()
    with stack.db.admin.begin() as conn:
        conn.execute(text("TRUNCATE external_place_cells"))
    suggest(browser, LAT - 0.0002, LON - 0.0002)
    assert fake.query(1) == first


# --- Results --------------------------------------------------------------------


def test_results_closest_first_named_and_within_the_radius(stack, fake):
    use_sample_at(fake)
    result = suggest(stack.signed_in("ana"))
    assert result["external_available"] is True
    assert result["attribution"] == "© OpenStreetMap contributors"
    # Panadería is at the centre, the others ~22 m away, and "Lejos" 280 m.
    names = [site["name"] for site in result["external"]]
    assert names[0] == "Panadería Paco"
    assert set(names) == {"Panadería Paco", "Café Central", "Museo del Agua"}
    distances = [site["distance_m"] for site in result["external"]]
    assert distances == sorted(distances)
    assert result["external"][0]["external_source"] == "osm"
    assert result["external"][0]["external_id"] == "node/1001"
    assert result["external"][0]["category"] == "bakery"


def test_at_most_eight_suggestions(stack, fake):
    fake.body = json.dumps(
        {
            "elements": [
                {"type": "node", "id": n, "lat": LAT + n / 1e6, "lon": LON, "tags": {"name": f"Sitio {n}", "shop": "books"}}
                for n in range(1, 21)
            ]
        }
    )
    assert len(suggest(stack.signed_in("ana"))["external"]) == 8


def test_a_site_that_is_already_a_place_is_not_suggested(stack, fake):
    use_sample_at(fake)
    browser = stack.signed_in("ana")
    body = {
        "name": "Panadería Paco",
        "latitude": LAT,
        "longitude": LON,
        "external_source": "osm",
        "external_id": "node/1001",
    }
    assert browser.write("POST", "/api/places", json=body).status_code == 201
    result = suggest(browser)
    assert "node/1001" not in [site["external_id"] for site in result["external"]]
    assert [place["name"] for place in result["existing"]] == ["Panadería Paco"]


def test_a_site_with_the_name_of_a_nearby_place_is_marked(stack, fake):
    use_sample_at(fake)
    browser = stack.signed_in("ana")
    created = browser.write(
        "POST", "/api/places", json={"name": "panaderia paco", "latitude": LAT, "longitude": LON}
    ).json()
    sites = {site["name"]: site for site in suggest(browser)["external"]}
    assert sites["Panadería Paco"]["matches_place_id"] == created["id"]
    assert sites["Café Central"]["matches_place_id"] is None


# --- Cache ----------------------------------------------------------------------


def test_second_request_does_not_go_outside(stack, fake):
    use_sample_at(fake)
    browser = stack.signed_in("ana")
    first = suggest(browser)
    second = suggest(browser)
    assert len(fake.calls) == 1
    assert second["external"] == first["external"]


def test_an_empty_cell_is_remembered_too(stack, fake):
    fake.body = json.dumps({"elements": []})
    browser = stack.signed_in("ana")
    assert suggest(browser)["external"] == []
    assert suggest(browser)["external_available"] is True
    assert len(fake.calls) == 1


def test_an_expired_cell_is_asked_for_again(stack, fake, secure_settings):
    use_sample_at(fake)
    browser = stack.signed_in("ana")
    suggest(browser)
    with stack.db.admin.begin() as conn:
        conn.execute(
            text("UPDATE external_place_cells SET fetched_at = now() - make_interval(days => :d)"),
            {"d": secure_settings.external_cache_days + 1},
        )
    suggest(browser)
    assert len(fake.calls) == 2


def test_cleaning_removes_only_old_cells(stack, fake, secure_settings):
    use_sample_at(fake)
    suggest(stack.signed_in("ana"))
    sessions = sessionmaker(bind=stack.db.app)
    now = datetime.now(UTC)
    with sessions() as db:
        assert delete_expired_cells(db, secure_settings.external_cache_days, now) == 0
    with sessions() as db:
        assert delete_expired_cells(db, 1, now + timedelta(days=2)) == 1
    with stack.db.admin.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM external_place_cells")).scalar_one() == 0


def test_several_uncached_cells_are_one_request(stack, fake):
    fake.body = json.dumps({"elements": []})
    suggest(stack.signed_in("ana"), 13885 * SIZE + 0.0001, -293 * SIZE + 0.0001)
    assert len(fake.calls) == 1
    with stack.db.admin.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM external_place_cells")).scalar_one() == 4


# --- When the outside fails: never an error, never a loop ------------------------


def assert_quietly_unavailable(result):
    assert result["external"] == []
    assert result["external_available"] is False
    assert result["attribution"] is None


def test_existing_places_still_come_back_when_the_outside_fails(stack, fake):
    fake.status = 500
    browser = stack.signed_in("ana")
    browser.write("POST", "/api/places", json={"name": "Fuente", "latitude": LAT, "longitude": LON})
    result = suggest(browser)
    assert_quietly_unavailable(result)
    assert [place["name"] for place in result["existing"]] == ["Fuente"]


def test_a_slow_server_times_out(stack, fake, secure_settings):
    secure_settings.overpass_timeout_s = 1
    fake.delay = 3
    started = time.monotonic()
    assert_quietly_unavailable(suggest(stack.signed_in("ana")))
    assert time.monotonic() - started < 2.5


def test_not_json_and_runtime_errors_count_as_failures(stack, fake):
    browser = stack.signed_in("ana")
    fake.body = "<html>busy</html>"
    assert_quietly_unavailable(suggest(browser))
    fake.body = json.dumps({"elements": [], "remark": "runtime error: Query timed out"})
    assert_quietly_unavailable(suggest(browser))
    with stack.db.admin.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM external_place_cells")).scalar_one() == 0


@pytest.mark.parametrize("status", [429, 406])
def test_being_limited_means_silence_for_at_least_30_s(stack, fake, status):
    fake.status = status
    browser = stack.signed_in("ana")
    assert_quietly_unavailable(suggest(browser))
    assert get_redis().ttl("overpass:pause") >= 29
    fake.status = 200
    use_sample_at(fake)
    assert_quietly_unavailable(suggest(browser))
    assert len(fake.calls) == 1


def test_retry_after_is_respected_up_to_ten_minutes(stack, fake):
    fake.status = 429
    fake.headers = {"Retry-After": "90"}
    suggest(stack.signed_in("ana"))
    assert 85 <= get_redis().ttl("overpass:pause") <= 90


def test_three_failures_open_the_breaker_and_it_recovers(stack, fake):
    fake.status = 503
    browser = stack.signed_in("ana")
    for _ in range(3):
        assert_quietly_unavailable(suggest(browser))
    assert len(fake.calls) == 3
    assert get_redis().ttl("overpass:pause") > 590
    assert_quietly_unavailable(suggest(browser))
    assert len(fake.calls) == 3, "open breaker: nothing goes out"

    get_redis().delete("overpass:pause")
    fake.status = 200
    use_sample_at(fake)
    assert suggest(browser)["external_available"] is True
    assert len(fake.calls) == 4


def test_a_success_resets_the_failure_count(stack, fake):
    browser = stack.signed_in("ana")
    fake.status = 500
    suggest(browser, LAT, LON)
    suggest(browser, LAT, LON)
    fake.status = 200
    fake.body = json.dumps({"elements": []})
    suggest(browser, LAT, LON)
    assert not get_redis().exists("overpass:failures")


def test_daily_cap(stack, fake, secure_settings):
    secure_settings.overpass_daily_cap = 2
    fake.body = json.dumps({"elements": []})
    browser = stack.signed_in("ana")
    for step in range(4):
        suggest(browser, LAT + step * 3 * SIZE, LON)
    assert len(fake.calls) == 2


def test_minimum_interval_between_requests(stack, fake, secure_settings):
    secure_settings.overpass_min_interval_s = 0.5
    fake.body = json.dumps({"elements": []})
    browser = stack.signed_in("ana")
    started = time.monotonic()
    suggest(browser, LAT, LON)
    suggest(browser, LAT + 3 * SIZE, LON)
    assert len(fake.calls) == 2
    assert time.monotonic() - started >= 0.5


def test_fallback_is_tried_when_the_main_server_fails(stack, fake, secure_settings, monkeypatch):
    other = FakeOverpass()
    try:
        fake.status = 504
        use_sample_at(other)
        secure_settings.overpass_url_fallback = other.url
        result = suggest(stack.signed_in("ana"))
        assert result["external_available"] is True
        assert len(fake.calls) == 1 and len(other.calls) == 1
    finally:
        other.close()


def test_a_host_not_on_the_list_is_never_called(stack, fake, monkeypatch):
    monkeypatch.delitem(overpass.ALLOWED_HOSTS, "127.0.0.1")
    assert_quietly_unavailable(suggest(stack.signed_in("ana")))
    assert fake.calls == []


def test_redis_down_means_no_call(stack, fake, secure_settings):
    class Broken:
        def __getattr__(self, name):
            def fail(*args, **kwargs):
                import redis

                raise redis.ConnectionError("down")

            return fail

    provider = OverpassProvider(secure_settings, Broken())
    from app.place_suggestions import ProviderUnavailable

    with pytest.raises(ProviderUnavailable):
        provider.fetch(Box(0, 0, 0.1, 0.1))
    assert fake.calls == []


# --- The two switches -------------------------------------------------------------


def test_with_the_server_switch_off_nothing_goes_out(stack, fake, secure_settings):
    secure_settings.external_places_enabled = False
    assert_quietly_unavailable(suggest(stack.signed_in("ana")))
    assert fake.calls == []


def test_the_persons_own_switch_sends_nothing(stack, fake):
    assert_quietly_unavailable(suggest(stack.signed_in("ana"), external="false"))
    assert fake.calls == []


# --- Who may ask, and configuration ------------------------------------------------


def test_suggest_needs_a_session(stack):
    assert stack.browser().get("/api/places/suggest", params={"lat": 1, "lon": 1}).status_code == 401


def test_suggest_has_a_limit_per_person(stack, fake, secure_settings):
    secure_settings.suggest_rate_per_minute = 2
    fake.body = json.dumps({"elements": []})
    browser = stack.signed_in("ana")
    codes = [browser.get("/api/places/suggest", params={"lat": LAT, "lon": LON}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


@pytest.mark.parametrize(("value", "expected"), [("si", True), ("sí", True), ("SI", True), ("no", False), ("true", True)])
def test_the_switches_understand_si_and_no(value, expected, monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("EXTERNAL_PLACES_ENABLED", value)
    assert Settings().external_places_enabled is expected
