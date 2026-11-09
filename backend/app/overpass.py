"""The one module that talks to OpenStreetMap's Overpass API.

The rest of the application only knows the PlaceSuggestionProvider interface
(app/place_suggestions.py), so this file can be replaced by a local copy of
the data without touching anything else.

What is sent: a rectangle aligned to a fixed grid, the list of tags to look
for, and a generic User-Agent. Never a user, a cookie, an email address or the
exact position. tests/test_suggest.py captures the real request and checks it.

Overpass is a free public service with published limits, so this client is
deliberately timid. All the counters live in Redis, so they hold across the
API's processes and restarts:

- at least OVERPASS_MIN_INTERVAL_S between requests;
- at most OVERPASS_DAILY_CAP requests that miss the cache, per day;
- after 429 or 406, silence for at least 30 s (the published rule);
- after 3 failures in a row, silence for 10 minutes (a circuit breaker);
- if Redis is down, no call at all: the limits could not be kept.

Why urllib and not a richer HTTP library: one POST does not justify a new
dependency, and it lets redirects and proxies be switched off explicitly.
"""

import json
import logging
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import redis

from app.config import Settings
from app.place_suggestions import Box, ExternalPlace, ProviderUnavailable

logger = logging.getLogger(__name__)

APP_VERSION = "0.1.0"
USER_AGENT = f"SoundArchive/{APP_VERSION} (self-hosted)"
ATTRIBUTION = "© OpenStreetMap contributors"

# The code cannot call anywhere else, whatever the configuration says. The last
# name only exists on the throwaway network of the end-to-end tests.
ALLOWED_HOSTS: dict[str, str] = {
    "overpass-api.de": "https",
    "overpass.private.coffee": "https",
    "sa-e2e-overpass-mock": "http",
}

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
RESULT_LIMIT = 800
PAUSE_AFTER_LIMITED_S = 30
BREAKER_FAILURES = 3
BREAKER_PAUSE_S = 600

# Tags that describe somewhere a person might say "I recorded this at...".
CATEGORY_KEYS = ("amenity", "shop", "tourism", "leisure", "historic", "craft", "office")

# Street furniture and the like: named sometimes, never a place to record at.
EXCLUDED: dict[str, frozenset[str]] = {
    "amenity": frozenset(
        {
            "atm",
            "bench",
            "bicycle_parking",
            "bicycle_rental",
            "charging_station",
            "fuel",
            "hunting_stand",
            "motorcycle_parking",
            "parcel_locker",
            "parking",
            "parking_entrance",
            "parking_space",
            "post_box",
            "recycling",
            "shower",
            "taxi",
            "telephone",
            "toilets",
            "vending_machine",
            "waste_basket",
            "waste_disposal",
            "watering_place",
        }
    ),
    "leisure": frozenset({"pitch", "picnic_table", "firepit", "slipway"}),
    "tourism": frozenset({"information"}),
    "historic": frozenset({"boundary_stone", "milestone"}),
}


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


# ProxyHandler({}): ignore any proxy variables in the environment.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects())


def build_query(box: Box, timeout_s: int) -> str:
    def clause(key: str) -> str:
        excluded = EXCLUDED.get(key)
        condition = f'["{key}"!~"^({"|".join(sorted(excluded))})$"]' if excluded else ""
        return f'nwr["name"]["{key}"]{condition};'

    bbox = f"{box.south:.6f},{box.west:.6f},{box.north:.6f},{box.east:.6f}"
    body = "".join(clause(key) for key in CATEGORY_KEYS)
    return f"[out:json][timeout:{timeout_s}][bbox:{bbox}];({body});out center tags {RESULT_LIMIT};"


def parse_elements(payload: dict[str, Any]) -> list[ExternalPlace]:
    """Turn an Overpass answer into the short list that is cached."""
    places: dict[str, ExternalPlace] = {}
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        name = str(tags.get("name") or "").strip()[:120]
        kind = element.get("type")
        if not name or kind not in ("node", "way", "relation") or "id" not in element:
            continue
        center = element.get("center") or element
        lat, lon = center.get("lat"), center.get("lon")
        if not isinstance(lat, int | float) or not isinstance(lon, int | float):
            continue
        category = None
        for key in CATEGORY_KEYS:
            value = tags.get(key)
            if value and value not in EXCLUDED.get(key, ()):
                category = value
                break
        if category is None:
            continue
        osm_id = f"{kind}/{element['id']}"
        places[osm_id] = ExternalPlace(osm_id=osm_id, kind=kind, name=name, category=category, latitude=lat, longitude=lon)
    return list(places.values())


class _Limited(Exception):
    def __init__(self, retry_after: int) -> None:
        self.retry_after = retry_after


class _Failed(Exception):
    pass


class OverpassProvider:
    name = "osm"
    enabled = True
    attribution = ATTRIBUTION

    def __init__(self, config: Settings, client: redis.Redis) -> None:
        self.config = config
        self.redis = client

    # --- Limits -------------------------------------------------------------

    @staticmethod
    def _daily_key() -> str:
        return f"overpass:daily:{time.strftime('%Y%m%d', time.gmtime())}"

    def _under_daily_cap(self) -> bool:
        used = self.redis.get(self._daily_key())
        return int(used or 0) < self.config.overpass_daily_cap

    def _count_request(self) -> None:
        key = self._daily_key()
        self.redis.incr(key)
        self.redis.expire(key, 2 * 24 * 60 * 60)

    def _wait_for_turn(self) -> bool:
        """Claim the next slot; wait at most one interval for it."""
        interval = self.config.overpass_min_interval_s
        if interval <= 0:
            return True
        milliseconds = math.ceil(interval * 1000)
        deadline = time.monotonic() + interval
        while True:
            if self.redis.set("overpass:spacing", 1, nx=True, px=milliseconds):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)

    def _pause(self, seconds: int) -> None:
        self.redis.set("overpass:pause", 1, ex=max(seconds, 1))

    def _on_success(self) -> None:
        self.redis.delete("overpass:failures")

    def _on_failure(self) -> None:
        failures = int(self.redis.incr("overpass:failures"))
        self.redis.expire("overpass:failures", BREAKER_PAUSE_S)
        if failures >= BREAKER_FAILURES:
            logger.warning("Overpass: %d failures in a row; pausing %d s", failures, BREAKER_PAUSE_S)
            self._pause(BREAKER_PAUSE_S)
            self.redis.delete("overpass:failures")

    # --- HTTP ---------------------------------------------------------------

    def _urls(self) -> list[str]:
        urls = [self.config.overpass_url, self.config.overpass_url_fallback]
        allowed = []
        for url in urls:
            if not url:
                continue
            parts = urllib.parse.urlsplit(url)
            if ALLOWED_HOSTS.get(parts.hostname or "") != parts.scheme:
                logger.error("Overpass: address not on the allowed list; ignored")
                continue
            allowed.append(url)
        return allowed

    def _post(self, url: str, query: str) -> dict[str, Any]:
        timeout = self.config.overpass_timeout_s
        request = urllib.request.Request(
            url,
            data=urllib.parse.urlencode({"data": query}).encode(),
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        deadline = time.monotonic() + timeout
        try:
            with _opener.open(request, timeout=timeout) as response:
                body = bytearray()
                while chunk := response.read(64 * 1024):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise _Failed("response too large")
                    if time.monotonic() > deadline:
                        raise _Failed("too slow")
        except urllib.error.HTTPError as error:
            if error.code in (429, 406):
                raise _Limited(self._retry_after(error)) from None
            raise _Failed(f"HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise _Failed(type(error).__name__) from None
        try:
            payload = json.loads(bytes(body))
        except ValueError:
            raise _Failed("not JSON") from None
        if not isinstance(payload, dict):
            raise _Failed("unexpected JSON")
        # Overpass reports a query that ran out of time inside a 200 answer.
        if "runtime error" in str(payload.get("remark", "")):
            raise _Failed("runtime error")
        return payload

    @staticmethod
    def _retry_after(error: urllib.error.HTTPError) -> int:
        try:
            value = int(error.headers.get("Retry-After", ""))
        except ValueError:
            return PAUSE_AFTER_LIMITED_S
        return min(max(value, PAUSE_AFTER_LIMITED_S), BREAKER_PAUSE_S)

    # --- The interface ------------------------------------------------------

    def fetch(self, box: Box) -> list[ExternalPlace]:
        query = build_query(box, self.config.overpass_timeout_s)
        try:
            if self.redis.exists("overpass:pause") or not self._under_daily_cap():
                raise ProviderUnavailable("paused or over the daily cap")
            if not self._wait_for_turn():
                raise ProviderUnavailable("another request is using the slot")
            for url in self._urls():
                if not self._under_daily_cap():
                    break
                self._count_request()
                try:
                    payload = self._post(url, query)
                except _Limited as limited:
                    logger.warning("Overpass: rate limited; pausing %d s", limited.retry_after)
                    self._pause(limited.retry_after)
                except _Failed as failure:
                    logger.warning("Overpass: request failed (%s)", failure)
                    self._on_failure()
                else:
                    self._on_success()
                    return parse_elements(payload)
        except redis.RedisError as error:
            raise ProviderUnavailable(f"limits unavailable: {type(error).__name__}") from None
        raise ProviderUnavailable("no server answered")
