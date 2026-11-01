"""Sound Archive API.

Every route lives under /api, because Caddy forwards only /api/* to this
service and serves everything else (the web page) itself.
"""

import logging

from fastapi import APIRouter, FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db import engine

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Sound Archive API",
    # Put the interactive docs under /api too, so they are reachable through
    # Caddy: http://localhost:8080/api/docs
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
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


app.include_router(router)
