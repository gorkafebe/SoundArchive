"""Application settings, read from environment variables.

pydantic-settings checks the types when the app starts. If a variable is
missing or has the wrong type, the app refuses to start and tells you which
one, instead of failing later in a confusing way.
"""

from urllib.parse import quote

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings
from sqlalchemy import URL


class Settings(BaseSettings):
    # Each field maps to an environment variable of the same name in capitals:
    # db_host <- DB_HOST, and so on. Docker Compose sets them (see compose.yaml).
    db_host: str
    db_port: int = 5432
    db_name: str
    db_user: str
    # SecretStr hides the value when the settings are printed or logged.
    db_password: SecretStr

    # Test switch, off by default: treat requests with no session as allowed,
    # and skip the CSRF and Origin checks. Only the API tests of the places
    # endpoints use it. Never turn it on for a running instance.
    allow_anonymous_writes: bool = False

    # Redis: the job queue and the login attempt counters.
    redis_host: str = "redis"
    redis_port: int = 6379
    redis_password: SecretStr = SecretStr("")

    # Browser addresses this site is opened from, comma-separated and exact
    # (scheme, host and port). The CSRF check compares the Origin header to it.
    allowed_origins: str = ""

    # Sessions: closed after this many days unused, and after this many days
    # in any case.
    session_idle_days: int = 30
    session_absolute_days: int = 180

    # Failed attempts before a wait starts (app/ratelimit.py).
    rate_limit_enabled: bool = True
    rate_limit_user: int = 5
    rate_limit_ip: int = 30

    # Where audio and photos are stored.
    media_root: str = "/media"
    # 2 GiB (decision D-48).
    max_upload_bytes: int = 2 * 1024 * 1024 * 1024
    # Do not accept an upload that would leave less than this on the disk.
    min_free_bytes: int = 5 * 1024 * 1024 * 1024
    # Uploads never finished are deleted after this long.
    draft_max_age_hours: int = 72

    photo_max_bytes: int = 20 * 1024 * 1024
    photos_per_person_per_place: int = 4
    # Refuse images above this many pixels (decompression bombs).
    photo_max_pixels: int = 40_000_000

    # Basemap styles (MapLibre style JSON URLs), one per theme. They live in
    # configuration, not in the web app's code, so the map provider can change
    # without rebuilding anything: edit .env and restart the api.
    # OpenFreeMap needs no key and no sign-up. A relative URL (starting with /)
    # is resolved against the site itself, e.g. a local test style.
    map_style_url: str = "https://tiles.openfreemap.org/styles/positron"
    map_style_url_dark: str = "https://tiles.openfreemap.org/styles/dark"

    # "Is this the same place?": how far around a new place to look, in metres.
    # The GPS accuracy is added to the radius, up to the maximum.
    duplicate_radius_m: int = 50
    duplicate_radius_max_m: int = 150
    nearby_rate_per_minute: int = 60

    # Suggestions of known sites from OpenStreetMap (app/overpass.py). Off
    # unless the instance turns it on; compose.tailnet.yaml does.
    external_places_enabled: bool = False
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    overpass_url_fallback: str = ""
    overpass_daily_cap: int = 100
    overpass_min_interval_s: float = 2.0
    overpass_timeout_s: int = 15
    external_cell_size_deg: float = 0.003
    external_cell_margin_deg: float = 0.0005
    external_cache_days: int = 30
    suggest_radius_m: int = 80
    suggest_rate_per_minute: int = 30

    # Extra map layers, passed to the web app by /api/config.
    satellite_enabled: bool = False
    satellite_global_fallback: bool = False
    topo_es_enabled: bool = False

    @field_validator(
        "external_places_enabled", "satellite_enabled", "satellite_global_fallback", "topo_es_enabled", mode="before"
    )
    @classmethod
    def spanish_yes_is_yes(cls, value: object) -> object:
        # The owner's notes say si/no; "no" is already understood.
        return "true" if isinstance(value, str) and value.strip().lower() in ("si", "sí") else value

    # Interactive API docs at /api/docs. On in dev; compose.prod.yaml turns it
    # off, because the docs page loads its script from a public CDN and
    # there is no need to publish it.
    api_docs_enabled: bool = True

    @property
    def allowed_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def redis_url(self) -> str:
        password = quote(self.redis_password.get_secret_value(), safe="")
        return f"redis://:{password}@{self.redis_host}:{self.redis_port}/0"

    @property
    def database_url(self) -> URL:
        # URL.create escapes special characters in the password for us,
        # so a password like "p@ss/word" doesn't break the connection string.
        return URL.create(
            drivername="postgresql+psycopg",  # SQLAlchemy dialect + psycopg 3 driver
            username=self.db_user,
            password=self.db_password.get_secret_value(),
            host=self.db_host,
            port=self.db_port,
            database=self.db_name,
        )


settings = Settings()


def get_settings() -> Settings:
    """FastAPI dependency. Tests replace it to try other settings."""
    return settings
