"""Application settings, read from environment variables.

pydantic-settings checks the types when the app starts. If a variable is
missing or has the wrong type, the app refuses to start and tells you which
one, instead of failing later in a confusing way.
"""

from pydantic import SecretStr
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

    # Write protection. There are no user accounts yet (phase 6), so anyone
    # who reaches the site could create places. Off unless set to true on
    # purpose: the dev stack turns it on, prod leaves it off. When off,
    # POST /api/places answers 403 and /api/config tells the web app.
    allow_anonymous_writes: bool = False

    # Basemap styles (MapLibre style JSON URLs), one per theme. They live in
    # configuration, not in the web app's code, so the map provider can change
    # without rebuilding anything: edit .env and restart the api.
    # OpenFreeMap needs no key and no sign-up. A relative URL (starting with /)
    # is resolved against the site itself, e.g. a local test style.
    map_style_url: str = "https://tiles.openfreemap.org/styles/positron"
    map_style_url_dark: str = "https://tiles.openfreemap.org/styles/dark"

    # Interactive API docs at /api/docs. On in dev; compose.prod.yaml turns it
    # off, because the docs page loads its script from a public CDN and
    # there is no need to publish it.
    api_docs_enabled: bool = True

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
