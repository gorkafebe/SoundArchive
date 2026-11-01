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
