"""Suggestions of named sites near a point, from an outside list.

    provider  -> who knows the sites (Overpass today; see below)
    the cache -> table external_place_cells, one row per grid cell
    suggest() -> what the endpoint calls; it never raises because of a provider

Privacy, and why cells
----------------------
The exact point reaches our own server only. The provider is asked for grid
squares of EXTERNAL_CELL_SIZE_DEG (0.003 degrees, about 300 m) with a small
margin, and the exact distance is worked out here afterwards. So the provider
only learns "someone looked at this square", and the cache answers the second
person who looks at it.

If the circle around the point touches several squares that are not cached,
one rectangle covering them is requested instead of several. It is still made
of whole squares, and it is fewer calls to a service that asks for few.

The next provider
-----------------
A provider is anything with this small interface. The recommended next one
(docs/THIRD_PARTY_DATA.md) is a regional OpenStreetMap extract imported into
our own PostGIS with osm2pgsql, which removes the outside call altogether.
"""

import logging
import math
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import ExternalPlaceCell

logger = logging.getLogger(__name__)

METERS_PER_DEGREE = 111_320
MAX_CELLS = 4


class ProviderUnavailable(Exception):
    """The provider cannot answer now. Never shown to the person."""


@dataclass(frozen=True)
class Box:
    south: float
    west: float
    north: float
    east: float

    def contains(self, lat: float, lon: float) -> bool:
        return self.south <= lat <= self.north and self.west <= lon <= self.east


@dataclass(frozen=True)
class ExternalPlace:
    osm_id: str
    kind: str
    name: str
    category: str
    latitude: float
    longitude: float


class PlaceSuggestionProvider(Protocol):
    name: str
    enabled: bool
    attribution: str | None

    def fetch(self, box: Box) -> list[ExternalPlace]:
        """The named sites inside the box. Raises ProviderUnavailable."""
        ...


class NoProvider:
    """The switch is off: nothing is ever fetched."""

    name = "none"
    enabled = False
    attribution = None

    def fetch(self, box: Box) -> list[ExternalPlace]:
        raise ProviderUnavailable("no provider configured")


@dataclass(frozen=True)
class Cell:
    lat_index: int
    lon_index: int
    size: float

    @property
    def key(self) -> str:
        return f"{self.size:g}:{self.lat_index}:{self.lon_index}"

    def box(self, margin: float = 0.0) -> Box:
        return Box(
            south=max(round(self.lat_index * self.size - margin, 6), -90.0),
            west=max(round(self.lon_index * self.size - margin, 6), -180.0),
            north=min(round((self.lat_index + 1) * self.size + margin, 6), 90.0),
            east=min(round((self.lon_index + 1) * self.size + margin, 6), 180.0),
        )

    def center_distance_from(self, lat: float, lon: float) -> float:
        box = self.box()
        return math.hypot((box.south + box.north) / 2 - lat, (box.west + box.east) / 2 - lon)


def cell_for(lat: float, lon: float, size: float) -> Cell:
    return Cell(math.floor(lat / size), math.floor(lon / size), size)


def cells_around(lat: float, lon: float, radius_m: float, size: float) -> list[Cell]:
    """The cells the circle touches, the point's own first, at most MAX_CELLS."""
    d_lat = radius_m / METERS_PER_DEGREE
    d_lon = radius_m / (METERS_PER_DEGREE * max(math.cos(math.radians(lat)), 0.01))
    # Past the date line or a pole there is nothing to ask for on this side.
    south, north = max(lat - d_lat, -90.0), min(lat + d_lat, 90.0)
    west, east = max(lon - d_lon, -180.0), min(lon + d_lon, 180.0)
    low, high = cell_for(south, west, size), cell_for(north, east, size)
    cells = [
        Cell(lat_index, lon_index, size)
        for lat_index in range(low.lat_index, high.lat_index + 1)
        for lon_index in range(low.lon_index, high.lon_index + 1)
    ]
    cells.sort(key=lambda cell: cell.center_distance_from(lat, lon))
    return cells[:MAX_CELLS]


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance; exact enough for a few hundred metres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(min(1.0, math.sqrt(a)))


def _union(cells: list[Cell], margin: float) -> Box:
    boxes = [cell.box(margin) for cell in cells]
    return Box(
        south=min(box.south for box in boxes),
        west=min(box.west for box in boxes),
        north=max(box.north for box in boxes),
        east=max(box.east for box in boxes),
    )


def sites_for(
    session: Session,
    provider: PlaceSuggestionProvider,
    config: Settings,
    cells: list[Cell],
) -> tuple[list[ExternalPlace], bool]:
    """Sites in these cells, from the cache or the provider, and whether any answered."""
    cutoff = datetime.now(UTC) - timedelta(days=config.external_cache_days)
    rows = session.scalars(
        select(ExternalPlaceCell).where(
            ExternalPlaceCell.provider == provider.name,
            ExternalPlaceCell.cell.in_([cell.key for cell in cells]),
            ExternalPlaceCell.fetched_at >= cutoff,
        )
    ).all()
    found: dict[str, ExternalPlace] = {}
    for row in rows:
        for item in row.places:
            found[item["osm_id"]] = ExternalPlace(**item)

    cached = {row.cell for row in rows}
    missing = [cell for cell in cells if cell.key not in cached]
    answered = bool(rows)
    if missing:
        try:
            fetched = provider.fetch(_union(missing, config.external_cell_margin_deg))
        except ProviderUnavailable as reason:
            logger.info("No outside suggestions: %s", reason)
        else:
            answered = True
            for cell in missing:
                box = cell.box(config.external_cell_margin_deg)
                inside = [place for place in fetched if box.contains(place.latitude, place.longitude)]
                _store(session, provider.name, cell.key, inside)
                found.update({place.osm_id: place for place in inside})
            session.commit()
    return list(found.values()), answered


def _store(session: Session, provider: str, cell: str, places: list[ExternalPlace]) -> None:
    values = {"provider": provider, "cell": cell, "places": [asdict(place) for place in places], "fetched_at": datetime.now(UTC)}
    statement = insert(ExternalPlaceCell).values(**values)
    session.execute(
        statement.on_conflict_do_update(
            index_elements=["provider", "cell"],
            set_={"places": statement.excluded.places, "fetched_at": statement.excluded.fetched_at},
        )
    )


def delete_expired_cells(session: Session, days: int, now: datetime) -> int:
    removed = session.execute(
        delete(ExternalPlaceCell).where(ExternalPlaceCell.fetched_at < now - timedelta(days=days))
    ).rowcount
    session.commit()
    return removed or 0
