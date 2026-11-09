"""Places near a point and the "is this the same place?" check.

Run with: make test
"""

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.main import app

# About 11 m per 0.0001 degrees of latitude.
NEAR = 0.0001
MADRID = (40.4168, -3.7038)


def create(api, name="A place", lat=MADRID[0], lon=MADRID[1], **extra):
    response = api.post("/api/places", json={"name": name, "latitude": lat, "longitude": lon, "confirm_distinct": True, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def nearby(api, lat, lon, **params):
    response = api.get("/api/places/nearby", params={"lat": lat, "lon": lon, **params})
    assert response.status_code == 200, response.text
    return response.json()


# --- Distance -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("lat", "lon", "other_lat", "other_lon", "low", "high"),
    [
        pytest.param(40.4168, -3.7038, 40.4170, -3.7038, 20, 25, id="madrid"),
        pytest.param(-33.8688, 151.2093, -33.8690, 151.2093, 20, 25, id="sydney"),
        # 0.0002 degrees of longitude across the date line, at the equator.
        pytest.param(0.0, 179.9999, 0.0, -179.9999, 21, 24, id="date-line"),
        # Meridians converge: a big change of longitude is few metres here.
        pytest.param(89.9999, 0.0, 89.9999, 90.0, 13, 18, id="near-north-pole"),
        pytest.param(-89.9999, 10.0, -89.9999, 100.0, 13, 18, id="near-south-pole"),
    ],
)
def test_distance_on_the_round_earth(api, lat, lon, other_lat, other_lon, low, high):
    create(api, lat=lat, lon=lon)
    items = nearby(api, other_lat, other_lon, radius=100)["items"]
    assert len(items) == 1
    assert low < items[0]["distance_m"] < high


def test_edge_of_the_radius(api):
    create(api)
    distance = nearby(api, MADRID[0] + 3 * NEAR, MADRID[1], radius=100)["items"][0]["distance_m"]
    assert len(nearby(api, MADRID[0] + 3 * NEAR, MADRID[1], radius=distance + 0.5)["items"]) == 1
    assert nearby(api, MADRID[0] + 3 * NEAR, MADRID[1], radius=distance - 0.5)["items"] == []


def test_closest_first_and_limited(api):
    for step in (5, 1, 3):
        create(api, name=f"at {step}", lat=MADRID[0] + step * NEAR)
    names = [item["name"] for item in nearby(api, *MADRID, radius=100)["items"]]
    assert names == ["at 1", "at 3", "at 5"]
    for n in range(12):
        create(api, name=f"more {n}", lat=MADRID[0] + 0.5 * NEAR)
    assert len(nearby(api, *MADRID, radius=100)["items"]) == 10


def test_default_radius_widens_with_accuracy_up_to_the_maximum(api):
    create(api, name="about 100 m", lat=MADRID[0] + 9 * NEAR)
    create(api, name="about 170 m", lat=MADRID[0] + 15.3 * NEAR)

    plain = nearby(api, *MADRID)
    assert plain["radius_m"] == 50
    assert plain["items"] == []

    widened = nearby(api, *MADRID, accuracy=60)
    assert widened["radius_m"] == 110
    assert [item["name"] for item in widened["items"]] == ["about 100 m"]

    capped = nearby(api, *MADRID, accuracy=5000)
    assert capped["radius_m"] == 150
    assert [item["name"] for item in capped["items"]] == ["about 100 m"]


def test_removed_places_are_ignored(api, clean_places):
    created = create(api)
    with clean_places.admin.begin() as conn:
        conn.execute(text("UPDATE places SET removed_at = now() WHERE id = :id"), {"id": created["id"]})
    assert nearby(api, *MADRID)["items"] == []


@pytest.mark.parametrize("query", ["panaderia paco", "PANADERÍA  PACO", "Panadería Paco"])
def test_similar_names_ignore_accents_and_case(api, query):
    create(api, name="Panadería Paco")
    similarity = nearby(api, *MADRID, name=query)["items"][0]["name_similarity"]
    assert similarity > 0.9


def test_a_different_name_scores_low(api):
    create(api, name="Panadería Paco")
    assert nearby(api, *MADRID, name="Estación de autobuses")["items"][0]["name_similarity"] < 0.2


def test_no_name_means_no_score(api):
    create(api, name="Panadería Paco")
    assert nearby(api, *MADRID)["items"][0]["name_similarity"] is None


@pytest.mark.parametrize(
    "params",
    [
        {"lat": 91, "lon": 0},
        {"lat": 0, "lon": 181},
        {"lat": 0},
        {"lat": 0, "lon": 0, "radius": 0},
        {"lat": 0, "lon": 0, "accuracy": -1},
    ],
)
def test_bad_nearby_requests_are_422(api, params):
    assert api.get("/api/places/nearby", params=params).status_code == 422


def test_counts_only_recordings_the_viewer_can_see_is_zero_for_a_new_place(api):
    create(api)
    assert nearby(api, *MADRID)["items"][0]["recording_count"] == 0


# --- Creating next to an existing place -----------------------------------------


def post(api, name="Second", lat=MADRID[0], lon=MADRID[1], **extra):
    return api.post("/api/places", json={"name": name, "latitude": lat, "longitude": lon, **extra})


def test_a_place_nearby_is_a_409_with_the_candidates(api):
    first = create(api, name="Fuente")
    response = post(api, lat=MADRID[0] + NEAR)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "possible_duplicate"
    assert detail["radius_m"] == 50
    assert [c["id"] for c in detail["candidates"]] == [first["id"]]
    assert detail["candidates"][0]["name"] == "Fuente"
    assert 8 < detail["candidates"][0]["distance_m"] < 14
    assert detail["candidates"][0]["recording_count"] == 0


def test_nothing_is_created_on_a_409(api):
    create(api)
    post(api)
    assert len(nearby(api, *MADRID)["items"]) == 1


def test_far_enough_away_needs_no_confirmation(api):
    create(api)
    assert post(api, lat=MADRID[0] + 10 * NEAR).status_code == 201


def test_accuracy_widens_the_check_on_create(api):
    create(api)
    assert post(api, lat=MADRID[0] + 10 * NEAR, location_accuracy_m=80).status_code == 409


def test_confirm_distinct_creates_and_is_audited(harness):
    browser = harness.signed_in("ana")
    body = {"name": "Uno", "latitude": MADRID[0], "longitude": MADRID[1]}
    assert browser.write("POST", "/api/places", json=body).status_code == 201
    again = {**body, "name": "Dos"}
    assert browser.write("POST", "/api/places", json=again).status_code == 409
    created = browser.write("POST", "/api/places", json={**again, "confirm_distinct": True})
    assert created.status_code == 201
    with harness.db.admin.connect() as conn:
        rows = conn.execute(
            text("SELECT target_id, detail FROM audit_log WHERE action = 'place.created_despite_nearby'")
        ).all()
    assert [r.target_id for r in rows] == [created.json()["id"]]
    assert rows[0].detail["nearby"] == 1


def test_confirm_distinct_with_nothing_nearby_is_not_audited(harness):
    browser = harness.signed_in("ana")
    body = {"name": "Uno", "latitude": 10.0, "longitude": 10.0, "confirm_distinct": True}
    assert browser.write("POST", "/api/places", json=body).status_code == 201
    with harness.db.admin.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM audit_log WHERE action LIKE 'place.%'")).scalar_one() == 0


def test_two_people_adding_the_same_spot_at_once(api):
    # Without the lock both would see "nothing nearby" and both would insert.
    bodies = [
        {"name": f"Same {n}", "latitude": MADRID[0], "longitude": MADRID[1]}
        for n in range(6)
    ]

    def send(body):
        with TestClient(app) as client:
            return client.post("/api/places", json=body).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = sorted(pool.map(send, bodies))
    assert codes == [201, 409, 409, 409, 409, 409]


# --- External references --------------------------------------------------------


def test_external_reference_is_saved(api):
    created = create(api, external_source="osm", external_id="node/123")
    assert (created["external_source"], created["external_id"]) == ("osm", "node/123")


def test_same_external_reference_is_a_409_even_when_confirmed(api):
    first = create(api, name="Panadería Paco", external_source="osm", external_id="node/123")
    response = post(api, lat=10, lon=10, external_source="osm", external_id="node/123", confirm_distinct=True)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "external_exists"
    assert [c["id"] for c in detail["candidates"]] == [first["id"]]


def test_a_removed_place_does_not_block_its_reference(api, clean_places):
    first = create(api, external_source="osm", external_id="node/123")
    with clean_places.admin.begin() as conn:
        conn.execute(text("UPDATE places SET removed_at = now() WHERE id = :id"), {"id": first["id"]})
    assert post(api, external_source="osm", external_id="node/123").status_code == 201


def test_the_database_itself_refuses_a_repeated_reference(api, clean_places):
    create(api, external_source="osm", external_id="way/7")
    with pytest.raises(IntegrityError), clean_places.app.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO places (name, location, external_source, external_id) "
                "VALUES ('x', 'SRID=4326;POINT(1 1)', 'osm', 'way/7')"
            )
        )


@pytest.mark.parametrize(
    "extra",
    [
        {"external_source": "osm"},
        {"external_id": "node/1"},
        {"external_source": "other", "external_id": "node/1"},
        {"external_source": "osm", "external_id": "1"},
        {"external_source": "osm", "external_id": "node/1; drop"},
    ],
)
def test_malformed_external_references_are_422(api, extra):
    assert post(api, **extra).status_code == 422


# --- Who may ask ----------------------------------------------------------------


def test_nearby_needs_a_session(harness):
    assert harness.browser().get("/api/places/nearby", params={"lat": 1, "lon": 1}).status_code == 401


def test_nearby_has_a_limit_per_person(harness, secure_settings):
    secure_settings.nearby_rate_per_minute = 3
    browser = harness.signed_in("ana")
    codes = [browser.get("/api/places/nearby", params={"lat": 1, "lon": 1}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


# --- The database -----------------------------------------------------------------


def test_the_distance_query_uses_the_index(clean_places, capsys):
    with clean_places.admin.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO places (name, location) "
                "SELECT 'Lugar ' || n, "
                "ST_SetSRID(ST_MakePoint(-4 + random() * 2, 40 + random() * 2), 4326)::geography "
                "FROM generate_series(1, 10000) AS n"
            )
        )
        conn.execute(text("ANALYZE places"))
        plan = conn.execute(
            text(
                "EXPLAIN ANALYZE SELECT id FROM places "
                "WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(-3, 41), 4326)::geography, 50) "
                "AND removed_at IS NULL ORDER BY ST_Distance(location, "
                "ST_SetSRID(ST_MakePoint(-3, 41), 4326)::geography) LIMIT 10"
            )
        ).all()
    report = "\n".join(line[0] for line in plan)
    with capsys.disabled():
        print("\n--- EXPLAIN (10 000 places) ---\n" + report)
    assert "ix_places_location" in report
    assert "Seq Scan" not in report


def test_migration_goes_down_and_up(test_db):
    def columns() -> set[str]:
        with test_db.admin.connect() as conn:
            return set(
                conn.execute(
                    text("SELECT column_name FROM information_schema.columns WHERE table_name = 'places'")
                ).scalars()
            )

    try:
        test_db.migrate("0004", down=True)
        assert "external_id" not in columns()
    finally:
        test_db.migrate("head")
    assert "external_id" in columns()
    with test_db.admin.connect() as conn:
        assert conn.execute(text("SELECT sa_normalize_name('Áñó')")).scalar_one() == "ano"
