"""Fill the DEV database with made-up places, to see the map and the list working.

Run it with `make seed-dev`, never by hand on the server. Two guards keep it
out of production:

- the prod image does not contain this folder (backend/Dockerfile copies
  only app/ and alembic/), so there it cannot even start;
- it refuses to run unless SEED_DEV=1, which only the Makefile target sets.

Every place it makes has a description ending in SEED_MARK. Running it again
first deletes those places, so it never piles up duplicates, and never
touches places you created yourself.

Names are generic ("Fountain 12"): no real people, no real businesses.
"""

import os
import random
import sys

from geoalchemy2 import WKTElement
from sqlalchemy import delete

from app.db import SessionLocal
from app.models import Place

SEED_MARK = "(example data from make seed-dev)"

# Areas with many places, so the map shows clusters, plus scattered ones.
# (longitude, latitude, spread in degrees, how many)
AREAS = [
    (-2.935, 43.263, 0.05, 90),  # Bilbao
    (-3.703, 40.417, 0.08, 90),  # Madrid
    (2.170, 41.387, 0.06, 60),  # Barcelona
    (-0.376, 39.470, 0.05, 30),  # Valencia
]
SCATTERED = 50  # anywhere on Earth, including near the 180° meridian

KINDS = [
    ("Fountain", "Water falling into a stone basin."),
    ("Market", "Voices and carts in the morning."),
    ("Harbour", "Ropes, gulls and engines idling."),
    ("Forest path", "Wind in the leaves, distant birds."),
    ("Station", "Announcements echoing under a glass roof."),
    ("Square", "Footsteps, a bell, children playing."),
    ("Beach", "Small waves on sand."),
    ("Bridge", "Traffic above, the river below."),
    ("Cloister", "A quiet courtyard with a dripping tap."),
    ("Riverside", "Running water and a cycling path."),
]


def main() -> int:
    if os.environ.get("SEED_DEV") != "1":
        print("Refusing to run: this script is for the dev database only (make seed-dev).")
        return 1

    rng = random.Random(20261103)  # fixed seed: the same places every time
    places = []

    def add(lon: float, lat: float) -> None:
        kind, sound = rng.choice(KINDS)
        n = len(places) + 1
        places.append(
            Place(
                name=f"{kind} {n}",
                description=f"{sound} {SEED_MARK}",
                location=WKTElement(f"POINT({lon:.6f} {lat:.6f})", srid=4326),
            )
        )

    for lon, lat, spread, count in AREAS:
        for _ in range(count):
            add(lon + rng.gauss(0, spread), lat + rng.gauss(0, spread))
    for _ in range(SCATTERED):
        add(rng.uniform(-180, 180), rng.uniform(-60, 70))
    add(179.9, -17.8)  # just west of the date line
    add(-179.9, -17.8)  # just east of it

    with SessionLocal() as session:
        removed = session.execute(
            delete(Place).where(Place.description.endswith(SEED_MARK))
        ).rowcount
        session.add_all(places)
        session.commit()
    print(f"Removed {removed} old example places; added {len(places)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
