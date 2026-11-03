"""Request and response shapes for the API (Pydantic models).

FastAPI uses them to validate what comes in (and answer 422 with the reason
when something is wrong), to shape what goes out, and to write the docs at
/api/docs.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.models import DESCRIPTION_MAX, NAME_MAX

# strip_whitespace runs before the length check, so "   " counts as empty.
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=NAME_MAX)]
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]


class PlaceCreate(BaseModel):
    """Body of POST /api/places."""

    # Unknown fields are an error, not silently ignored: a typo such as
    # "lat" instead of "latitude" is reported instead of lost.
    model_config = ConfigDict(extra="forbid")

    name: Name
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX)
    latitude: Latitude
    longitude: Longitude

    @field_validator("description")
    @classmethod
    def blank_description_is_none(cls, value: str | None) -> str | None:
        # An empty or whitespace-only description means "no description".
        if value is None:
            return None
        value = value.strip()
        return value or None


class PlaceOut(BaseModel):
    """One place, as GET /api/places/{id} and the list return it."""

    id: uuid.UUID
    name: str
    description: str | None
    latitude: float
    longitude: float
    created_at: datetime
    updated_at: datetime


class PlaceList(BaseModel):
    """A page of places for the list view."""

    items: list[PlaceOut]
    total: int  # matches in all pages, so the UI can say "page 2 of 7"
    limit: int
    offset: int


# --- GeoJSON (RFC 7946), the format MapLibre reads directly -----------------


class PointGeometry(BaseModel):
    type: Literal["Point"] = "Point"
    # GeoJSON order is [longitude, latitude] (x, y), the opposite of how
    # people usually say coordinates. Getting it backwards puts Madrid in Somalia.
    coordinates: tuple[float, float]


class PlaceFeatureProperties(BaseModel):
    name: str


class PlaceFeature(BaseModel):
    type: Literal["Feature"] = "Feature"
    id: uuid.UUID
    geometry: PointGeometry
    properties: PlaceFeatureProperties


class PlaceFeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[PlaceFeature]
    # Extra member (GeoJSON allows them): true when there were more places in
    # the area than the limit, so the map can say "zoom in to see all".
    truncated: bool


class PublicConfig(BaseModel):
    """What the web app reads once at start-up (GET /api/config)."""

    writes_enabled: bool
    map_style_url: str
    map_style_url_dark: str
