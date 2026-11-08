"""Places API, against a separate test database (see conftest.py).

Run with: make test
"""

import pytest
from sqlalchemy import select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import ProgrammingError

from app.models import Place
from app.places import bbox_filter, parse_bbox


def create(api, name="A place", lat=0.0, lon=0.0, description=None):
    body = {"name": name, "latitude": lat, "longitude": lon}
    if description is not None:
        body["description"] = description
    response = api.post("/api/places", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def names_in(api, bbox):
    response = api.get("/api/places", params={"bbox": bbox})
    assert response.status_code == 200, response.text
    return sorted(f["properties"]["name"] for f in response.json()["features"])


# --- Create and read ---------------------------------------------------------


def test_create_then_read(api):
    created = create(api, name="  Old market  ", lat=43.2630, lon=-2.9350, description="Rain on a tin roof")

    assert created["name"] == "Old market"  # spaces around the name are trimmed
    assert created["latitude"] == pytest.approx(43.2630)
    assert created["longitude"] == pytest.approx(-2.9350)
    assert created["description"] == "Rain on a tin roof"
    assert created["created_at"] and created["updated_at"]

    one = api.get(f"/api/places/{created['id']}")
    assert one.status_code == 200
    assert one.json() == created


def test_post_sets_location_header(api):
    response = api.post("/api/places", json={"name": "X", "latitude": 1, "longitude": 2})
    assert response.headers["location"] == f"/api/places/{response.json()['id']}"


def test_blank_description_is_stored_as_none(api):
    assert create(api, description="   ")["description"] is None


def test_unknown_place_is_404(api):
    response = api.get("/api/places/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def test_malformed_id_is_422(api):
    assert api.get("/api/places/not-a-uuid").status_code == 422


# --- Validation --------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"latitude": 0, "longitude": 0},  # no name
        {"name": "", "latitude": 0, "longitude": 0},
        {"name": "   ", "latitude": 0, "longitude": 0},  # only spaces = empty
        {"name": "x" * 121, "latitude": 0, "longitude": 0},
        {"name": "ok", "description": "x" * 2001, "latitude": 0, "longitude": 0},
        {"name": "ok", "latitude": 90.0001, "longitude": 0},
        {"name": "ok", "latitude": -90.0001, "longitude": 0},
        {"name": "ok", "latitude": 0, "longitude": 180.0001},
        {"name": "ok", "latitude": 0, "longitude": -180.0001},
        {"name": "ok", "latitude": "north", "longitude": 0},
        {"name": "ok", "longitude": 0},  # no latitude
        {"name": "ok", "lat": 0, "latitude": 0, "longitude": 0},  # unknown field
    ],
)
def test_invalid_bodies_are_rejected(api, body):
    response = api.post("/api/places", json=body)
    assert response.status_code == 422, response.text


def test_limits_are_inclusive(api):
    create(api, name="x" * 120, lat=90, lon=180, description="y" * 2000)
    create(api, name="z", lat=-90, lon=-180)


# --- Map rectangle (bbox) ------------------------------------------------------


def test_bbox_returns_geojson_in_lon_lat_order(api):
    created = create(api, name="Bilbao", lat=43.26, lon=-2.93)

    body = api.get("/api/places", params={"bbox": "-3,43,-2,44"}).json()

    assert body["type"] == "FeatureCollection"
    assert body["truncated"] is False
    [feature] = body["features"]
    assert feature["type"] == "Feature"
    assert feature["id"] == created["id"]
    assert feature["geometry"]["type"] == "Point"
    # GeoJSON: [longitude, latitude]
    assert feature["geometry"]["coordinates"] == pytest.approx([-2.93, 43.26])
    assert feature["properties"] == {"name": "Bilbao"}


def test_bbox_filters_and_includes_edges(api):
    create(api, name="inside", lat=15, lon=15)
    create(api, name="corner-sw", lat=10, lon=10)
    create(api, name="corner-ne", lat=20, lon=20)
    create(api, name="edge-n", lat=20, lon=15)
    create(api, name="outside-n", lat=20.0001, lon=15)
    create(api, name="outside-w", lat=15, lon=9.9999)

    assert names_in(api, "10,10,20,20") == ["corner-ne", "corner-sw", "edge-n", "inside"]


def test_bbox_crossing_the_date_line(api):
    """minLon > maxLon: the rectangle wraps around 180° (decision in places.py)."""
    create(api, name="fiji-east", lat=-17, lon=179.5)
    create(api, name="samoa-west", lat=-17, lon=-179.5)
    create(api, name="on-180", lat=-17, lon=180)
    create(api, name="on-minus-180", lat=-17, lon=-180)
    create(api, name="greenwich", lat=-17, lon=0)

    wrapped = names_in(api, "179,-20,-179,-10")
    assert wrapped == ["fiji-east", "on-180", "on-minus-180", "samoa-west"]
    # The same numbers in the usual order mean "almost the whole world".
    assert "greenwich" in names_in(api, "-179,-20,179,-10")


def test_whole_world(api):
    create(api, name="a", lat=89, lon=-179)
    create(api, name="b", lat=-89, lon=179)
    assert names_in(api, "-180,-90,180,90") == ["a", "b"]


def test_bbox_limit_sets_truncated(api):
    for i in range(3):
        create(api, name=f"p{i}", lat=1, lon=1)
    body = api.get("/api/places", params={"bbox": "0,0,2,2", "limit": 2}).json()
    assert len(body["features"]) == 2
    assert body["truncated"] is True


@pytest.mark.parametrize(
    "bbox",
    ["1,2,3", "1,2,3,4,5", "a,b,c,d", "0,0,nan,1", "-181,0,0,1", "0,-91,1,0", "0,10,1,5", ""],
)
def test_bad_bbox_is_422(api, bbox):
    assert api.get("/api/places", params={"bbox": bbox}).status_code == 422


def test_bbox_is_required(api):
    assert api.get("/api/places").status_code == 422


@pytest.mark.parametrize("limit", [0, 5001])
def test_bbox_limit_bounds(api, limit):
    response = api.get("/api/places", params={"bbox": "0,0,1,1", "limit": limit})
    assert response.status_code == 422


def test_parse_bbox_accepts_spaces():
    assert parse_bbox(" -1 , -2 , 3 , 4 ") == (-1, -2, 3, 4)


# --- List, pagination, search ------------------------------------------------------


def test_list_pages_newest_first(api):
    for i in range(25):
        create(api, name=f"place {i:02d}")

    first = api.get("/api/places/list", params={"limit": 10}).json()
    assert first["total"] == 25
    assert first["limit"] == 10 and first["offset"] == 0
    assert [p["name"] for p in first["items"]][:2] == ["place 24", "place 23"]

    last = api.get("/api/places/list", params={"limit": 10, "offset": 20}).json()
    assert [p["name"] for p in last["items"]] == [f"place {i:02d}" for i in range(4, -1, -1)]

    beyond = api.get("/api/places/list", params={"offset": 100}).json()
    assert beyond["items"] == [] and beyond["total"] == 25


def test_list_search_name_and_description(api):
    create(api, name="Harbour at dawn")
    create(api, name="Forest", description="Birds near the HARBOUR wall")
    create(api, name="Station")
    create(api, name="100% rain")
    create(api, name="1000 drops")

    def found(q):
        body = api.get("/api/places/list", params={"q": q}).json()
        return sorted(p["name"] for p in body["items"]), body["total"]

    assert found("harbour") == (["Forest", "Harbour at dawn"], 2)
    assert found("  station ") == (["Station"], 1)
    # % is a LIKE wildcard; it must be searched as a plain character.
    assert found("100%") == (["100% rain"], 1)
    assert found("nothing like this") == ([], 0)
    assert found("")[1] == 5


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"offset": -1}, {"q": "x" * 201}])
def test_list_parameter_bounds(api, params):
    assert api.get("/api/places/list", params=params).status_code == 422


# --- Write protection -----------------------------------------------------------


@pytest.mark.parametrize("writes_enabled", [False])
def test_post_needs_a_session(api, writes_enabled):
    response = api.post("/api/places", json={"name": "X", "latitude": 0, "longitude": 0})

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "not_signed_in"


def test_config_reports_writes_and_map_styles(api):
    body = api.get("/api/config").json()
    assert body["writes_enabled"] is True
    assert body["map_style_url"]
    assert body["map_style_url_dark"]


# --- Database: privileges, migration, index ------------------------------------------


def test_app_user_reads_and_writes_places_but_cannot_alter_them(clean_places):
    with clean_places.app.begin() as conn:
        user = conn.execute(text("SELECT current_user")).scalar_one()
        assert user != clean_places.admin.url.username  # really the limited user
        place_id = conn.execute(
            text(
                "INSERT INTO places (name, location) "
                "VALUES ('p', 'SRID=4326;POINT(1 2)') RETURNING id"
            )
        ).scalar_one()
        conn.execute(text("UPDATE places SET name = 'q' WHERE id = :id"), {"id": place_id})
        assert conn.execute(text("SELECT name FROM places")).scalar_one() == "q"
        conn.execute(text("DELETE FROM places WHERE id = :id"), {"id": place_id})

    for statement in (
        "ALTER TABLE places ADD COLUMN sneaky text",
        "DROP TABLE places",
        "CREATE INDEX sneaky ON places (name)",
    ):
        with clean_places.app.connect() as conn:
            with pytest.raises(ProgrammingError, match="must be owner|permission denied"):
                conn.execute(text(statement))


def test_database_rejects_blank_name_even_without_the_api(clean_places):
    """The CHECK constraint is a second line of defence behind the API."""
    from sqlalchemy.exc import IntegrityError

    with clean_places.app.connect() as conn:
        with pytest.raises(IntegrityError, match="name_length"):
            conn.execute(
                text("INSERT INTO places (name, location) VALUES ('  ', 'SRID=4326;POINT(0 0)')")
            )


def test_migration_down_and_up(test_db):
    def has_places() -> bool:
        with test_db.admin.connect() as conn:
            return conn.execute(text("SELECT to_regclass('public.places') IS NOT NULL")).scalar_one()

    assert has_places()
    test_db.migrate("0001", down=True)
    assert not has_places()
    test_db.migrate("head")
    assert has_places()


def test_bbox_query_uses_the_gist_index(clean_places):
    """With 10 000 places, the rectangle query must use ix_places_location_geom.

    Prints the plan; `pytest -s -k gist` shows it.
    """
    with clean_places.admin.begin() as conn:
        # Spread pseudo-random points over the whole world, in SQL (fast).
        conn.execute(
            text(
                "INSERT INTO places (name, location) "
                "SELECT 'synthetic ' || g, "
                "ST_SetSRID(ST_MakePoint(random() * 360 - 180, random() * 180 - 90), 4326)::geography "
                "FROM generate_series(1, 10000) AS g"
            )
        )
        # Refresh the planner's statistics, as autovacuum would after a while.
        conn.execute(text("ANALYZE places"))

    def plan(*box) -> str:
        query = select(Place.id).where(bbox_filter(*box))
        sql = query.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
        with clean_places.app.connect() as conn:
            lines = conn.execute(text(f"EXPLAIN (ANALYZE, COSTS OFF) {sql}")).scalars().all()
        return "\n".join(lines)

    normal = plan(-4.1, 40.2, -3.3, 40.7)  # an area the size of Madrid
    wrapped = plan(179, -20, -179, -10)  # crossing the date line
    print("\n-- bbox -4.1,40.2,-3.3,40.7\n" + normal)
    print("\n-- bbox 179,-20,-179,-10\n" + wrapped)
    assert "ix_places_location_geom" in normal
    assert "Seq Scan" not in normal
    assert "ix_places_location_geom" in wrapped
