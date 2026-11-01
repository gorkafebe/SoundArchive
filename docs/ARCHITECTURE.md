# Architecture

## The services

The whole app is four Docker containers, described in `compose.yaml`.

| Service | Image | What it does | Why it exists |
|---|---|---|---|
| **caddy** | `caddy:2.11.7-alpine` | Web server and reverse proxy. Serves the files in `web/`, forwards `/api/*` to the API. | The only service the outside world can reach. One place for HTTPS (automatic certificates once there is a domain), compression and access logs. The browser sees one address for both the page and the API, so there are no cross-origin (CORS) problems. |
| **api** | built from `backend/Dockerfile` | Python + FastAPI application. Answers JSON requests. | Holds the app logic. Today: two health checks. Later: pins, recordings, photos. |
| **db** | `postgis/postgis:18-3.6` | PostgreSQL 18 with the PostGIS 3.6 extension. | Stores all data. PostGIS adds geographic types and queries ("pins within this map area"), which the map needs. |
| **migrate** | same image as api | Runs `alembic upgrade head` once, then exits. | Brings the database schema up to date **before** the API starts, so the API never runs against an old schema. |

Planned later (not built yet): a React + MapLibre web app replacing `web/`,
a Redis + RQ worker with ffmpeg for audio processing, and file storage for
uploads.

## How a request flows

```mermaid
sequenceDiagram
    participant B as Browser
    participant C as Caddy (:80)
    participant A as API (FastAPI :8000)
    participant D as PostgreSQL + PostGIS (:5432)

    B->>C: GET /
    C-->>B: web/index.html (static file)
    B->>C: GET /api/health/db
    C->>A: GET /api/health/db (forwarded unchanged)
    A->>D: SHOW server_version; SELECT postgis_lib_version() ...
    D-->>A: "18.6", "3.6.4"
    A-->>C: 200 {"status":"ok", ...}
    C-->>B: 200 {"status":"ok", ...}
```

The same flow as text:

```
Browser ──HTTP──▶ Caddy ──┬── /api/*  ──▶ api:8000 ──SQL──▶ db:5432
                          └── else    ──▶ files in web/
```

1. The browser asks Caddy for `/`. Caddy returns `web/index.html`.
2. JavaScript on the page calls `/api/health` and `/api/health/db` on the
   **same address**. Caddy sees the `/api/` prefix and forwards the request to
   the `api` container. `api` is a hostname that Docker's internal network
   resolves to that container.
3. FastAPI handles `/api/health/db`. It borrows a connection from its pool
   (SQLAlchemy + psycopg), runs the queries and returns JSON.
4. If the database cannot be reached, the API answers **503** with a short
   error after at most about 5 seconds, and the page shows red.
   `/api/health` never touches the database, so it stays green. That tells you
   *which* layer is broken.

Only Caddy publishes a port. The API (8000) and the database (5432) are
reachable only on Compose's private network. In dev, the database is also
published on `127.0.0.1:5433` for GUI tools.

## Startup order

Healthchecks and `depends_on` conditions enforce this order:

```
db (healthy) ─▶ migrate (exited with code 0) ─▶ api (healthy) ─▶ caddy (healthy)
```

If a migration fails, the API does not start and `make ps` shows
`migrate` exited with a non-zero code. `make logs SERVICE=migrate` shows why.

## Database users

| User | From `.env` | Used by | Can do |
|---|---|---|---|
| admin (superuser) | `POSTGRES_USER` | db container, migrate service, `make psql` | everything: create extensions, tables, users |
| app | `APP_DB_USER` | api service | read and write rows (SELECT/INSERT/UPDATE/DELETE), use sequences. **Cannot** create, alter or drop tables. |

`infra/postgres/init/20-create-app-user.sh` creates the app user when the
database is first created. It sets **default privileges**: every table the
admin creates later (through migrations) is automatically usable by the app
user. `backend/tests/test_database.py` proves it: the admin creates a
throwaway table and the app user must be able to use it.

Why bother? If the API had a bug that let someone run arbitrary SQL, they still
could not drop tables or read other databases.

## Configuration: dev vs prod

The code and the images are identical. Only configuration differs:

- **`.env`** (never committed) holds passwords and per-machine values.
  `.env.example` documents every variable.
- **`compose.dev.yaml`**: dev-stage image (with pytest), source code mounted
  from the laptop with auto-reload, Caddy on port 8080 on all interfaces,
  database on `127.0.0.1:5433`.
- **`compose.prod.yaml`**: prod-stage image (no test tools), automatic
  restart, log rotation, Caddy on 80/443, database never published.

## Technology choices

- **uv** manages the Python dependencies. One fast tool creates the
  virtualenv, resolves versions and writes a lockfile (`uv.lock`), so every
  build installs exactly the same versions.
- **Alembic** for migrations from day one. Every schema change is a numbered
  file in git, applied the same way on every machine.
- **pydantic-settings** reads environment variables into a typed class
  (`backend/app/config.py`). A missing or wrong variable stops the app at
  startup with a clear message.

### Image versions and CPU architectures

| Image | Tag | amd64 | arm64 |
|---|---|---|---|
| Caddy | `caddy:2.11.7-alpine` | yes | yes |
| Python (API base) | `python:3.14.10-slim-trixie` | yes | yes |
| uv (build only) | `ghcr.io/astral-sh/uv:0.13.6` | yes | yes |
| PostGIS | `postgis/postgis:18-3.6` | yes | **no** |

- **Python 3.14, not 3.15:** 3.15 came out only weeks before this was set up,
  and libraries with compiled parts (psycopg, pydantic) may not publish
  prebuilt packages for it yet.
- **PostGIS on arm64:** the official image is built for amd64 only. That's
  fine for both current machines (dev laptop and MSI are x86_64). On an Apple
  Silicon Mac, Docker Desktop runs it through emulation: it works, but slowly.
  If that becomes a problem, `imresamu/postgis:18-3.6-trixie` is a multi-arch
  build (amd64 + arm64) published by one of the PostGIS Docker maintainers.
  Change the `image:` line of `db` in `compose.yaml`.
- **`18-3.6` is a moving tag.** The PostGIS project publishes no
  patch-level tags (like 18.6-3.6.4). The tag stays on Postgres 18 and
  PostGIS 3.6, and picks up bug-fix and security releases when you
  `docker compose pull`. These are compatible with existing data. Moving to
  Postgres 19 would need a deliberate upgrade (dump and restore).
