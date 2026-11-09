"""Request and response shapes for the API (Pydantic models).

FastAPI uses them to validate what comes in (and answer 422 with the reason
when something is wrong), to shape what goes out, and to write the docs at
/api/docs.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

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
    location_accuracy_m: int | None = Field(default=None, ge=0, le=100000)
    # "I have seen the places nearby, and this one is different."
    confirm_distinct: bool = False
    # Set when the place was picked from an outside list.
    external_source: Literal["osm"] | None = None
    external_id: str | None = Field(default=None, pattern=r"^(node|way|relation)/[0-9]{1,20}$")

    @field_validator("description")
    @classmethod
    def blank_description_is_none(cls, value: str | None) -> str | None:
        # An empty or whitespace-only description means "no description".
        if value is None:
            return None
        value = value.strip()
        return value or None

    @model_validator(mode="after")
    def external_reference_is_complete(self) -> "PlaceCreate":
        if (self.external_source is None) != (self.external_id is None):
            raise ValueError("external_source and external_id go together")
        return self


class PlaceOut(BaseModel):
    """One place, as GET /api/places/{id} and the list return it."""

    id: uuid.UUID
    name: str
    description: str | None
    latitude: float
    longitude: float
    location_accuracy_m: int | None = None
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None = None
    author_name: str | None = None
    recording_count: int = 0
    latest_recorded_at: datetime | None = None
    external_source: str | None = None
    external_id: str | None = None


class PlaceList(BaseModel):
    """A page of places for the list view."""

    items: list[PlaceOut]
    total: int  # matches in all pages, so the UI can say "page 2 of 7"
    limit: int
    offset: int


class NearbyPlace(BaseModel):
    """A place close to a point: what "is this the same place?" shows."""

    id: uuid.UUID
    name: str
    latitude: float
    longitude: float
    distance_m: float
    recording_count: int = 0
    # 0 to 1, only when a name was given to compare with.
    name_similarity: float | None = None


class NearbyPlaces(BaseModel):
    items: list[NearbyPlace]
    radius_m: float


class ExternalSuggestion(BaseModel):
    """A named site from an outside list, not (yet) a place here."""

    external_source: str
    external_id: str
    name: str
    category: str
    latitude: float
    longitude: float
    distance_m: float
    # A place here that seems to be this same site, by name.
    matches_place_id: uuid.UUID | None = None


class PlaceSuggestions(BaseModel):
    existing: list[NearbyPlace]
    external: list[ExternalSuggestion]
    # False when the outside list could not be asked. Nothing to show the person.
    external_available: bool
    attribution: str | None = None
    radius_m: float


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
    external_places_enabled: bool = False
    satellite_enabled: bool = False
    satellite_global_fallback: bool = False
    topo_es_enabled: bool = False
    location_warn_accuracy_m: int = 100
