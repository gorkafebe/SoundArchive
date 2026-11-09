"""Limits on login and registration attempts, kept in Redis.

Each failure counts towards a key (per username, per client address). Past a
threshold, the key is locked for a time that doubles with every further
failure. A success clears the username's counter, not the address's.

If Redis cannot be reached the login is refused (503) rather than left without
protection: an attacker should not be able to gain unlimited tries by
overwhelming Redis, and Redis comes back within seconds of a restart.

Behind Caddy the address comes from X-Forwarded-For. With the Tailscale TCP
forward every client looks like the Docker gateway, so the per-address limit
is effectively a global ceiling today; it starts to mean more once the site
has real client addresses.
"""

import logging

import redis
from fastapi import HTTPException, Request, status

from app.config import Settings, settings

logger = logging.getLogger(__name__)

WINDOW_SECONDS = 15 * 60
MAX_LOCK_SECONDS = 15 * 60
BASE_LOCK_SECONDS = 15


def client_ip(request: Request) -> str:
    # Caddy sets this header itself, replacing whatever the client sent.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def get_redis() -> redis.Redis:
    """FastAPI dependency; tests can replace it."""
    return _client


_client = redis.Redis.from_url(settings.redis_url, socket_timeout=3, socket_connect_timeout=3)


def too_many(retry_after: int) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"code": "too_many_attempts", "retry_after": retry_after},
        headers={"Retry-After": str(retry_after)},
    )


def per_minute(client: redis.Redis, config: Settings, scope: str, who: str, limit: int) -> None:
    """A plain requests-per-minute ceiling for one person on a read endpoint.

    Unlike the login limits, this one lets the request through if Redis is
    down: it only stops someone hammering a search, and a search is harmless.
    """
    if not config.rate_limit_enabled:
        return
    key = f"ratelimit:{scope}:{who}:minute"
    try:
        count = int(client.incr(key))
        if count == 1:
            client.expire(key, 60)
        if count <= limit:
            return
        retry_after = max(int(client.ttl(key)), 1)
    except redis.RedisError as exc:
        logger.warning("Rate limiter unavailable: %s", type(exc).__name__)
        return
    raise too_many(retry_after)


class AttemptLimiter:
    def __init__(self, client: redis.Redis, config: Settings, scope: str) -> None:
        self.client = client
        self.config = config
        self.scope = scope

    def _keys(self, kind: str, value: str) -> tuple[str, str]:
        # Names are lower-cased: "Ana" and "ana" share a counter.
        base = f"ratelimit:{self.scope}:{kind}:{value.lower()[:128]}"
        return f"{base}:count", f"{base}:lock"

    def _unavailable(self, exc: Exception) -> HTTPException:
        logger.error("Rate limiter unavailable: %s", type(exc).__name__)
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail={"code": "try_later"})

    def check(self, kinds: dict[str, str]) -> None:
        """Raise 429 if any key is currently locked."""
        if not self.config.rate_limit_enabled:
            return
        try:
            for kind, value in kinds.items():
                _, lock = self._keys(kind, value)
                ttl = self.client.ttl(lock)
                if ttl and ttl > 0:
                    raise too_many(int(ttl))
        except redis.RedisError as exc:
            raise self._unavailable(exc) from None

    def failed(self, kinds: dict[str, str]) -> None:
        if not self.config.rate_limit_enabled:
            return
        thresholds = {"user": self.config.rate_limit_user, "ip": self.config.rate_limit_ip}
        try:
            for kind, value in kinds.items():
                count_key, lock_key = self._keys(kind, value)
                count = self.client.incr(count_key)
                self.client.expire(count_key, WINDOW_SECONDS)
                over = count - thresholds[kind]
                if over >= 0:
                    delay = min(BASE_LOCK_SECONDS * (2**over), MAX_LOCK_SECONDS)
                    self.client.set(lock_key, 1, ex=delay)
        except redis.RedisError as exc:
            raise self._unavailable(exc) from None

    def succeeded(self, kinds: dict[str, str]) -> None:
        if not self.config.rate_limit_enabled:
            return
        try:
            for kind, value in kinds.items():
                if kind != "user":
                    continue
                count_key, lock_key = self._keys(kind, value)
                self.client.delete(count_key, lock_key)
        except redis.RedisError as exc:
            raise self._unavailable(exc) from None
