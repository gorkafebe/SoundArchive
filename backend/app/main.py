"""Sound Archive API.

Every route lives under /api, because Caddy forwards only /api/* to this
service and serves everything else (the web page) itself.
"""

import logging

from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import admin, auth, moderation, photos, places, recordings
from app.config import Settings, get_settings, settings
from app.db import engine
from app.schemas import PublicConfig

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Sound Archive API",
    # Put the interactive docs under /api too, so they are reachable through
    # Caddy: http://localhost:8080/api/docs. Caddy forwards every /api/ path
    # unchanged, so whether the docs exist is decided here: API_DOCS_ENABLED
    # (off in compose.prod.yaml). None = the route does not exist (404).
    docs_url="/api/docs" if settings.api_docs_enabled else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if settings.api_docs_enabled else None,
)

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness check: the API process is up. Does not touch the database."""
    return {"status": "ok"}


@router.get("/health/db")
def health_db():
    """Database check: runs real queries and reports the versions."""
    try:
        with engine.connect() as conn:
            postgresql_version = conn.execute(text("SHOW server_version")).scalar_one()
            # postgis_lib_version() is the short form ("3.6.1");
            # postgis_full_version() includes the libraries PostGIS was built with.
            postgis_version = conn.execute(text("SELECT postgis_lib_version()")).scalar_one()
            postgis_full_version = conn.execute(text("SELECT postgis_full_version()")).scalar_one()
    except SQLAlchemyError as exc:
        # Full details go to the container log (make logs); the response
        # only names the kind of error.
        logger.exception("Database health check failed")
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "detail": f"Database unreachable or query failed ({type(exc).__name__})",
            },
        )

    return {
        "status": "ok",
        "postgresql_version": postgresql_version,
        "postgis_version": postgis_version,
        "postgis_full_version": postgis_full_version,
    }


@router.get("/config", response_model=PublicConfig)
def public_config(settings: Annotated[Settings, Depends(get_settings)]) -> PublicConfig:
    """Settings the web app needs, read once when it starts.

    Only public values: never put a secret here, every visitor can read it.
    """
    return PublicConfig(
        # With accounts, signing in is what allows writing; the switch only
        # remains for the web app's "disabled" state.
        writes_enabled=True,
        map_style_url=settings.map_style_url,
        map_style_url_dark=settings.map_style_url_dark,
        external_places_enabled=settings.external_places_enabled,
        satellite_enabled=settings.satellite_enabled,
        satellite_global_fallback=settings.satellite_global_fallback,
        topo_es_enabled=settings.topo_es_enabled,
    )


app.include_router(router)
app.include_router(places.router)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(recordings.router)
app.include_router(photos.router)
app.include_router(moderation.router)
