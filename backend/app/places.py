"""Places: the pins on the map.

    All of these need a session (only this instance's accounts can see the map).

    GET  /api/places?bbox=minLon,minLat,maxLon,maxLat&limit=   map: GeoJSON
    GET  /api/places/list?q=&limit=&offset=                    list view
    GET  /api/places/{id}                                      one place
    POST /api/places                                           create (if allowed)

Rectangle queries and the date line
-----------------------------------
The map asks for "the places in the area on screen", as a longitude/latitude
rectangle. Two details:

- The rectangle is compared with ``geometry(location)``: the point read as
  plain longitude/latitude numbers. A geography rectangle would have curved
  (great-circle) edges and miss points near its lower edge, which is not what
  the screen shows. A GiST index on that same expression makes the query fast
  (see the migration and the EXPLAIN in the tests).
- If minLon > maxLon, the rectangle crosses the 180° meridian (the date line,
  e.g. Fiji: 170,-20,-170,-10). It is split into two rectangles, 170..180 and
  -180..-170, and a place matches if it is in either. Points exactly on an
  edge count as inside.

Likely duplicates
-----------------
POST /api/places refuses (409) a place that falls within a few metres of an
existing one, and lists those places, unless the request says
``confirm_distinct``. The web app asks the person first; the check is here too
so that no other client can skip it. See docs/ARCHITECTURE.md.

"Is anything nearby?" followed by "insert" is two steps, so two people adding
the same spot at once could both pass the check. A transaction-level advisory
lock makes them take turns. It is one lock for the whole table: people add
places by hand, a few at a time, so nobody ever waits for it noticeably, and
one lock cannot miss a pair of places that sit either side of some boundary.
"""

import math
import uuid
from typing import Annotated

import redis
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from geoalchemy2 import Geography, WKTElement
from sqlalchemy import ColumnElement, Select, cast, func, literal, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import audit
from app.config import Settings
from app.db import get_session
from app.deps import SettingsDep, Viewer, ViewerDep, WriterDep
from app.models import Place, Recording, User
from app.ratelimit import get_redis, per_minute
from app.schemas import (
    NearbyPlace,
    NearbyPlaces,
    PlaceCreate,
    PlaceFeature,
    PlaceFeatureCollection,
    PlaceFeatureProperties,
    PlaceList,
    PlaceOut,
    PointGeometry,
)

router = APIRouter(prefix="/api/places", tags=["places"])

# How many places one map request returns. The map clusters pins on the
# client, so a few thousand are fine; more would make the response slow.
MAP_LIMIT_DEFAULT = 1000
MAP_LIMIT_MAX = 5000
LIST_LIMIT_DEFAULT = 20
LIST_LIMIT_MAX = 100
SEARCH_MAX = 200
NEARBY_LIMIT = 10
# Any fixed number works, as long as nothing else in the database uses it.
PLACE_CREATE_LOCK = 7_204_911

# The point as plain lon/lat geometry. The index in the migration is built on
# exactly this expression; if you change one, change the other.
_geom = func.geometry(Place.location)
_lon = func.ST_X(_geom).label("longitude")
_lat = func.ST_Y(_geom).label("latitude")


def _recording_visible(viewer_id: uuid.UUID | None, is_admin: bool) -> ColumnElement:
    """The recordings of a place that this person can count on seeing."""
    condition = Recording.status == "ready"
    if is_admin:
        return condition
    return condition & ((Recording.visibility == "public") | (Recording.author_id == viewer_id))


def _place_columns(viewer_id: uuid.UUID | None, is_admin: bool) -> Select:
    visible = _recording_visible(viewer_id, is_admin)
    recordings = (
        select(func.count())
        .where(Recording.place_id == Place.id, visible)
        .correlate(Place)
        .scalar_subquery()
        .label("recording_count")
    )
    latest = (
        select(func.max(Recording.recorded_at))
        .where(Recording.place_id == Place.id, visible)
        .correlate(Place)
        .scalar_subquery()
        .label("latest_recorded_at")
    )
    return select(
        Place.id,
        Place.name,
        Place.description,
        _lat,
        _lon,
        Place.location_accuracy_m,
        Place.created_at,
        Place.updated_at,
        Place.created_by,
        User.username.label("author_name"),
        recordings,
        latest,
        Place.external_source,
        Place.external_id,
    ).outerjoin(User, User.id == Place.created_by)


def _visible_recordings(viewer: Viewer):
    return (
        select(func.count())
        .where(Recording.place_id == Place.id, _recording_visible(viewer.id, viewer.is_admin))
        .correlate(Place)
        .scalar_subquery()
        .label("recording_count")
    )


def effective_radius(config: Settings, requested: float | None, accuracy: float | None) -> float:
    """How far to look: the radius, plus how unsure the GPS is, up to a ceiling."""
    base = requested if requested is not None else config.duplicate_radius_m
    return float(min(base + max(accuracy or 0, 0), config.duplicate_radius_max_m))


def find_nearby(
    session: Session,
    viewer: Viewer,
    lat: float,
    lon: float,
    radius: float,
    name: str | None = None,
) -> list[NearbyPlace]:
    """Live places within ``radius`` metres of the point, closest first.

    Both sides are geography, so the distance is in metres on the round Earth
    (the date line and the poles need no special case) and ST_DWithin can use
    the GiST index on places.location.
    """
    point = cast(func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326), Geography)
    distance = func.ST_Distance(Place.location, point).label("distance_m")
    similarity = (
        func.similarity(func.sa_normalize_name(Place.name), func.sa_normalize_name(name))
        if name
        else literal(None)
    ).label("name_similarity")
    rows = session.execute(
        select(Place.id, Place.name, _lat, _lon, distance, _visible_recordings(viewer), similarity)
        .where(func.ST_DWithin(Place.location, point, radius), Place.removed_at.is_(None))
        .order_by(distance, Place.id)
        .limit(NEARBY_LIMIT)
    ).all()
    return [NearbyPlace.model_validate(row._mapping) for row in rows]


def parse_bbox(raw: str) -> tuple[float, float, float, float]:
    """Turn "minLon,minLat,maxLon,maxLat" into four checked numbers."""
    parts = raw.split(",")
    if len(parts) != 4:
        raise ValueError("bbox needs four numbers: minLon,minLat,maxLon,maxLat")
    try:
        min_lon, min_lat, max_lon, max_lat = (float(p) for p in parts)
    except ValueError:
        raise ValueError("bbox values must be numbers") from None
    if not all(math.isfinite(v) for v in (min_lon, min_lat, max_lon, max_lat)):
        raise ValueError("bbox values must be finite numbers")
    if not (-180 <= min_lon <= 180 and -180 <= max_lon <= 180):
        raise ValueError("bbox longitudes must be between -180 and 180")
    if not (-90 <= min_lat <= 90 and -90 <= max_lat <= 90):
        raise ValueError("bbox latitudes must be between -90 and 90")
    if min_lat > max_lat:
        raise ValueError("bbox minLat must not be greater than maxLat")
    return min_lon, min_lat, max_lon, max_lat


def bbox_filter(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> ColumnElement:
    """WHERE clause: the place is inside the rectangle (edges included)."""

    def envelope(west: float, east: float) -> ColumnElement:
        # && = "bounding boxes overlap"; for a point that means "inside or on
        # the edge". It is the operator the GiST index can answer.
        return _geom.op("&&")(func.ST_MakeEnvelope(west, min_lat, east, max_lat, 4326))

    if min_lon <= max_lon:
        return envelope(min_lon, max_lon)
    return or_(envelope(min_lon, 180), envelope(-180, max_lon))


def _to_out(row) -> PlaceOut:
    return PlaceOut.model_validate(row._mapping)


@router.get("", response_model=PlaceFeatureCollection)
def places_in_area(
    _viewer: ViewerDep,
    session: Annotated[Session, Depends(get_session)],
    bbox: Annotated[
        str,
        Query(
            description="minLon,minLat,maxLon,maxLat in degrees. "
            "minLon > maxLon means the area crosses the 180° meridian.",
            examples=["-4.1,40.2,-3.3,40.7"],
        ),
    ],
    limit: Annotated[int, Query(ge=1, le=MAP_LIMIT_MAX)] = MAP_LIMIT_DEFAULT,
) -> PlaceFeatureCollection:
    """Places inside a map rectangle, as a GeoJSON FeatureCollection."""
    try:
        box = parse_bbox(bbox)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None

    # Ask for one more than the limit: if it comes back, there were more.
    rows = session.execute(
        select(Place.id, Place.name, _lat, _lon)
        .where(bbox_filter(*box), Place.removed_at.is_(None))
        .order_by(Place.created_at.desc(), Place.id)
        .limit(limit + 1)
    ).all()
    truncated = len(rows) > limit
    features = [
        PlaceFeature(
            id=row.id,
            geometry=PointGeometry(coordinates=(row.longitude, row.latitude)),
            properties=PlaceFeatureProperties(name=row.name),
        )
        for row in rows[:limit]
    ]
    return PlaceFeatureCollection(features=features, truncated=truncated)


@router.get("/list", response_model=PlaceList)
def list_places(
    viewer: ViewerDep,
    session: Annotated[Session, Depends(get_session)],
    q: Annotated[
        str | None,
        Query(max_length=SEARCH_MAX, description="Text to find in the name or description"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=LIST_LIMIT_MAX)] = LIST_LIMIT_DEFAULT,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PlaceList:
    """A page of places, newest first, optionally filtered by text."""
    conditions: list[ColumnElement] = [Place.removed_at.is_(None)]
    term = (q or "").strip()
    if term:
        # ILIKE = case-insensitive LIKE. % and _ are wildcards in LIKE, so
        # escape them: searching "100%" must find the text "100%", not "100".
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        conditions.append(
            or_(
                Place.name.ilike(pattern, escape="\\"),
                Place.description.ilike(pattern, escape="\\"),
            )
        )

    total = session.execute(select(func.count()).select_from(Place).where(*conditions)).scalar_one()
    rows = session.execute(
        _place_columns(viewer.id, viewer.is_admin)
        .where(*conditions)
        .order_by(Place.created_at.desc(), Place.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return PlaceList(items=[_to_out(r) for r in rows], total=total, limit=limit, offset=offset)


@router.get("/nearby", response_model=NearbyPlaces)
def nearby_places(
    viewer: ViewerDep,
    session: Annotated[Session, Depends(get_session)],
    config: SettingsDep,
    client: Annotated[redis.Redis, Depends(get_redis)],
    lat: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False)],
    lon: Annotated[float, Query(ge=-180, le=180, allow_inf_nan=False)],
    radius: Annotated[float | None, Query(gt=0, le=2000, allow_inf_nan=False)] = None,
    accuracy: Annotated[float | None, Query(ge=0, le=100000, allow_inf_nan=False)] = None,
    name: Annotated[str | None, Query(max_length=SEARCH_MAX)] = None,
) -> NearbyPlaces:
    """Places around a point, closest first."""
    if viewer.id is not None:
        per_minute(client, config, "nearby", str(viewer.id), config.nearby_rate_per_minute)
    limit = effective_radius(config, radius, accuracy)
    return NearbyPlaces(items=find_nearby(session, viewer, lat, lon, limit, (name or "").strip() or None), radius_m=limit)


@router.get("/{place_id}", response_model=PlaceOut, responses={404: {"description": "No such place"}})
def get_place(
    place_id: uuid.UUID, viewer: ViewerDep, session: Annotated[Session, Depends(get_session)]
) -> PlaceOut:
    row = session.execute(
        _place_columns(viewer.id, viewer.is_admin).where(Place.id == place_id, Place.removed_at.is_(None))
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Place not found")
    return _to_out(row)


def _conflict(code: str, candidates: list[NearbyPlace], radius: float | None = None) -> HTTPException:
    detail: dict = {"code": code, "candidates": [c.model_dump(mode="json") for c in candidates]}
    if radius is not None:
        detail["radius_m"] = radius
    return HTTPException(status.HTTP_409_CONFLICT, detail=detail)


def _existing_with_reference(session: Session, viewer: Viewer, source: str, external_id: str) -> list[NearbyPlace]:
    row = session.execute(
        select(Place.id, Place.name, _lat, _lon, _visible_recordings(viewer)).where(
            Place.external_source == source, Place.external_id == external_id, Place.removed_at.is_(None)
        )
    ).one_or_none()
    return [NearbyPlace(**row._mapping, distance_m=0.0)] if row else []


@router.post("", response_model=PlaceOut, status_code=status.HTTP_201_CREATED)
def create_place(
    body: PlaceCreate,
    response: Response,
    viewer: WriterDep,
    session: Annotated[Session, Depends(get_session)],
    config: SettingsDep,
) -> PlaceOut:
    # One at a time from here to the commit, which releases the lock.
    session.execute(select(func.pg_advisory_xact_lock(PLACE_CREATE_LOCK)))

    if body.external_source and body.external_id:
        same = _existing_with_reference(session, viewer, body.external_source, body.external_id)
        if same:
            raise _conflict("external_exists", same[:1])

    radius = effective_radius(config, None, body.location_accuracy_m)
    candidates = find_nearby(session, viewer, body.latitude, body.longitude, radius, body.name)
    if candidates and not body.confirm_distinct:
        raise _conflict("possible_duplicate", candidates, radius)

    place = Place(
        name=body.name,
        description=body.description,
        location_accuracy_m=body.location_accuracy_m,
        created_by=viewer.id,
        external_source=body.external_source,
        external_id=body.external_id,
        # WKT ("well-known text") is the standard text form of a shape.
        # Longitude first, like GeoJSON.
        location=WKTElement(f"POINT({body.longitude!r} {body.latitude!r})", srid=4326),
    )
    session.add(place)
    try:
        session.flush()
    except IntegrityError:
        # The lock makes this very unlikely; the unique index is the last word.
        session.rollback()
        if body.external_source and body.external_id:
            raise _conflict(
                "external_exists",
                _existing_with_reference(session, viewer, body.external_source, body.external_id)[:1],
            ) from None
        raise
    if body.confirm_distinct and candidates:
        audit.record(
            session,
            viewer,
            "place.created_despite_nearby",
            target_type="place",
            target_id=place.id,
            detail={"nearby": len(candidates), "closest_m": round(candidates[0].distance_m, 1)},
        )
    session.commit()
    response.headers["Location"] = f"/api/places/{place.id}"
    return get_place(place.id, viewer, session)
