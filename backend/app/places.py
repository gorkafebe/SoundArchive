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
"""

import math
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from geoalchemy2 import WKTElement
from sqlalchemy import ColumnElement, Select, func, or_, select
from sqlalchemy.orm import Session

from app.db import get_session
from app.deps import ViewerDep, WriterDep
from app.models import Place, Recording, User
from app.schemas import (
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
    ).outerjoin(User, User.id == Place.created_by)


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


@router.post("", response_model=PlaceOut, status_code=status.HTTP_201_CREATED)
def create_place(
    body: PlaceCreate,
    response: Response,
    viewer: WriterDep,
    session: Annotated[Session, Depends(get_session)],
) -> PlaceOut:
    place = Place(
        name=body.name,
        description=body.description,
        location_accuracy_m=body.location_accuracy_m,
        created_by=viewer.id,
        # WKT ("well-known text") is the standard text form of a shape.
        # Longitude first, like GeoJSON.
        location=WKTElement(f"POINT({body.longitude!r} {body.latitude!r})", srid=4326),
    )
    session.add(place)
    session.commit()
    response.headers["Location"] = f"/api/places/{place.id}"
    return get_place(place.id, viewer, session)
