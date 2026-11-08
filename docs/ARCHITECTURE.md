# Architecture

## The services

The whole app is four Docker containers, described in `compose.yaml`.

| Service | Image | What it does | Why it exists |
|---|---|---|---|
| **caddy** | built from `web/Dockerfile` (Caddy `2.11.7-alpine` + the built web app) | Web server and reverse proxy. Serves the React app (and `/status.html`), forwards `/api/*` to the API, adds security headers. | The only service the outside world can reach. One place for HTTPS (automatic certificates once there is a domain), compression and access logs. The browser sees one address for both the page and the API, so there are no cross-origin (CORS) problems. |
| **api** | built from `backend/Dockerfile` | Python + FastAPI application. Answers JSON requests. | Holds the app logic: health checks, places, the public config. Later: recordings, photos. |
| **db** | `postgis/postgis:18-3.6` | PostgreSQL 18 with the PostGIS 3.6 extension. | Stores all data. PostGIS adds geographic types and queries ("pins within this map area"), which the map needs. |
| **migrate** | same image as api | Runs `alembic upgrade head` once, then exits. | Brings the database schema up to date **before** the API starts, so the API never runs against an old schema. |

Planned later (not built yet): a Redis + RQ worker with ffmpeg for audio
processing, file storage for uploads, and user accounts.

## How a request flows

```mermaid
sequenceDiagram
    participant B as Browser
    participant C as Caddy (:80)
    participant A as API (FastAPI :8000)
    participant D as PostgreSQL + PostGIS (:5432)

    participant T as Tile server (OpenFreeMap)

    B->>C: GET /?view=map&lat=43.26&lon=-2.93&z=13
    C-->>B: index.html + /assets/*.js, *.css (the built React app)
    B->>C: GET /api/config
    C->>A: GET /api/config (forwarded unchanged)
    A-->>B: {"writes_enabled": false, "map_style_url": "https://tiles.openfreemap.org/styles/positron", ...}
    B->>T: style, tiles, fonts, icons (basemap only)
    B->>C: GET /api/places?bbox=-3.1,43.1,-2.8,43.4
    C->>A: (forwarded unchanged)
    A->>D: SELECT ... WHERE geometry(location) && ST_MakeEnvelope(...)
    D-->>A: rows (found through the GiST index)
    A-->>B: GeoJSON FeatureCollection
    Note over B: supercluster groups the points;<br/>each pin or cluster is an HTML button
```

The same flow as text:

```
Browser ──HTTP──▶ Caddy ──┬── /api/*     ──▶ api:8000 ──SQL──▶ db:5432
   │                      ├── /assets/*  ──▶ built JS/CSS (cached for a year)
   │                      └── anything   ──▶ that file if it exists, else index.html
   └──HTTPS──▶ tile server (basemap only; its address comes from /api/config)
```

1. The browser asks Caddy for any page. Caddy returns the React app's
   `index.html` (or `/status.html`, the system check page, which still works
   even if the app is broken).
2. The app reads `/api/config` once: whether creating places is allowed, and
   which basemap style to use for the light and the dark theme. Caddy sees the
   `/api/` prefix and forwards the request to the `api` container (`api` is a
   hostname that Docker's internal network resolves).
3. MapLibre loads the basemap from the tile server named in that style. This
   is the only request that leaves our site; the Content-Security-Policy in
   the Caddyfile allows exactly that server (`MAP_TILE_ORIGINS`).
4. When the map stops moving, the app waits 250 ms, cancels any older request
   and asks `/api/places` for the places in the visible rectangle. FastAPI
   borrows a connection from its pool (SQLAlchemy + psycopg), PostGIS finds
   the rows through a GiST index, and the API answers GeoJSON. The browser
   groups the points into clusters and draws them as buttons.
5. Clicking a pin calls `/api/places/{id}` and opens the place panel. The
   list view calls `/api/places/list`. Adding a place sends `POST /api/places`.

The health checks are unchanged: `/api/health` never touches the database,
and `/api/health/db` answers **503** within about 5 seconds when the database
is unreachable, so `/status.html` tells you *which* layer is broken.

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

## Places: the data model

One table so far, created by migration `0002` (`backend/alembic/versions/`)
and described in `backend/app/models.py`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid`, default `gen_random_uuid()` | Random, not 1, 2, 3: ids appear in shareable links, and a counter would reveal how many places exist |
| `name` | `varchar(120)` | 1 to 120 characters after trimming spaces (CHECK constraint `name_length`) |
| `description` | `text`, nullable | At most 2000 characters (CHECK `description_length`) |
| `location` | `geography(Point, 4326)` | Longitude/latitude on the WGS 84 ellipsoid (what GPS uses). Distances on a geography come out in metres |
| `created_at`, `updated_at` | `timestamptz`, default `now()` | |

Indexes:

- `ix_places_location_geom`: GiST on `geometry(location)`, the point read as
  plain longitude/latitude numbers. The map's rectangle query uses exactly
  this expression, so PostgreSQL can answer it from the index (checked with
  `EXPLAIN` on 10 000 rows in `backend/tests/test_places.py`).
- `ix_places_location`: GiST on the geography itself, for future distance
  queries ("places within 500 m").
- `ix_places_created_at`: B-tree, for "newest first".

Why compare the rectangle as geometry and not geography? A geography
rectangle has great-circle edges (curved on a flat map), so near its lower
edge it would miss points that are visibly inside the screen. Plain
longitude/latitude matches what the map shows.

The limits live in three places that agree: the CHECK constraints, the API's
Pydantic schemas (`backend/app/schemas.py`) and the web form
(`web/src/features/add-place/validation.ts`).

## The API

All routes start with `/api`. Interactive docs at `/api/docs` in dev only
(`API_DOCS_ENABLED=false` in `compose.prod.yaml`; Caddy forwards `/api/*`
unchanged, so it is the API that decides).

| Route | What it returns |
|---|---|
| `GET /api/health` | `{"status":"ok"}`; never touches the database |
| `GET /api/health/db` | PostgreSQL and PostGIS versions, or 503 |
| `GET /api/config` | `{"writes_enabled": bool, "map_style_url": "...", "map_style_url_dark": "..."}`, read by the web app at start-up. Public values only |
| `GET /api/places?bbox=minLon,minLat,maxLon,maxLat&limit=` | GeoJSON FeatureCollection of the places in the rectangle (coordinates `[lon, lat]`, properties `{name}`), newest first. `limit` 1000 by default, 5000 at most; `"truncated": true` when there were more. Points on an edge count as inside. **minLon > maxLon means the rectangle crosses the 180° meridian** (it is split in two). Longitudes outside −180..180 are a 422: the web app wraps them first |
| `GET /api/places/list?q=&limit=&offset=` | `{"items": [...], "total", "limit", "offset"}`, newest first; `q` searches name and description, case-insensitive, `%` and `_` taken literally. `limit` 20 by default, 100 at most |
| `GET /api/places/{id}` | One place, or 404 |
| `POST /api/places` | Body `{"name", "description"?, "latitude", "longitude"}`; 201 with the place and a `Location` header. Unknown fields are a 422. **403 `{"detail": {"code": "writes_disabled"}}` unless `ALLOW_ANONYMOUS_WRITES=true`** |

Write protection: there are no user accounts until phase 6, so without it
anyone who reaches the site could create places. `ALLOW_ANONYMOUS_WRITES` is
false unless set; the dev stack sets it to true; prod leaves it false. The web
app reads `writes_enabled` from `/api/config` and shows a clear "disabled on
this server" message instead of the form.

## The web app (`web/`)

React 19 + TypeScript, built by Vite, map by MapLibre GL JS, clustering by
supercluster. No other runtime libraries; translations use a small helper.

```
web/
├── index.html              entry page (Vite fills in the scripts)
├── public/                 copied as-is: status.html/.css/.js, theme-init.js
├── src/
│   ├── App.tsx             shell: header, nav, main; state in the URL
│   ├── styles/tokens.css   THE ONLY place with colours, fonts, sizes, radii
│   ├── styles/*.css        base and layout, using tokens only
│   ├── i18n/es.json, en.json   every text (same keys, checked by a script)
│   ├── lib/                API client, URL state, theme, storage, media queries
│   ├── components/         preferences (language, theme), live announcer
│   └── features/
│       ├── map/            MapView, pins and clusters (HTML buttons), geo helpers
│       ├── places/         place panel (sheet/side panel), list view
│       └── add-place/      the three-step add flow and its validation
├── scripts/                check-i18n, check-tokens, check-contrast
└── e2e/                    Playwright tests (run in Docker by make e2e)
```

Choices worth knowing:

- **Pins are HTML buttons**, not WebGL shapes, so they are reachable with Tab,
  have names for screen readers and a 44 px target.
- **The place panel sits next to the map** in the page grid (below it on
  phones, to the right on wide screens) instead of on top, so it never covers
  the map attribution or the controls.
- **The address holds the state**: `?view=map&lat=&lon=&z=&place=` or
  `?view=list&q=&page=&place=`, so any view can be shared.
- **The basemap style comes from `/api/config`**, never from the code, so the
  provider can change without rebuilding.

## The Caddy image (web app inside)

`web/Dockerfile` builds the `caddy` service's image in two stages: Node
installs the exact dependencies and Vite builds `dist/`; then only `dist/` and
`infra/caddy/Caddyfile` are copied into the official Caddy image. The build
context is the repository root, and `web/Dockerfile.dockerignore` lets in only
`web/` and the Caddyfile (never `.env`).

Consequences: `make up` / `make prod-up` rebuild the site and re-create Caddy
whenever the app or the Caddyfile changes (before, a Caddyfile change needed a
manual restart), and each image is one exact version of the site.

The Caddyfile serves the single-page app (unknown paths get `index.html`,
missing files under `/assets/` are a real 404), caches hashed assets for a
year, and adds security headers to web responses: Content-Security-Policy,
`X-Content-Type-Options`, `Referrer-Policy: same-origin`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy`. Each is explained in a
comment there. HSTS is left out until there is HTTPS.

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
  from the laptop with auto-reload, Caddy on port 8080 on `127.0.0.1` (or on
  every interface with `DEV_HTTP_BIND=0.0.0.0`), database on
  `127.0.0.1:5433`, `ALLOW_ANONYMOUS_WRITES` on, and an optional Vite
  live-reload server (`make web-dev`).
- **`compose.prod.yaml`**: prod-stage image (no test tools), automatic
  restart, log rotation, Caddy on 80/443, database never published, no
  `/api/docs`.

Image tags start with the Compose project name
(`${COMPOSE_PROJECT_NAME:-sound-archive}-backend:prod`, `...-web:prod`), so a
test copy started with `COMPOSE_PROJECT_NAME=sa-dev` never overwrites the
images of the real app (see `docs/DEPLOY_MSI.md`, section 11).

## Backups and restore

Summary; the full design, the reasons and the rehearsal figures are in
[BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md). Status (2026-11-03):
scripts ready and rehearsed on dev data, **no real backup yet** (the device
is an open owner decision).

```
db container ──pg_dump -Fc──▶ dump ─┐
media folder (MEDIA_DIR) ───────────┼─▶ restic (container, --network none) ──▶ encrypted repository
metadata (commit, alembic, names) ──┘                                          (USB disk / SSD / remote)
```

- **What:** a `pg_dump` in custom format, made **inside** the `db` container
  with its own variables (no password passes through the scripts), plus the
  media folder (none yet: no audio in production before accounts) and a small
  metadata file. Secrets (`.env`, the restic password) are **not** in the
  automatic backup; they live in the owner's password manager.
- **How:** restic, pinned image `restic/restic:0.19.1`, encrypted and
  incremental; `restic check` after every backup; a status file for the
  monitoring panel.
- **Restore order:** restic → `db` alone (its first start creates the
  limited app user) → `pg_restore` as admin → media → `alembic` → `api` (on
  the **limited** user) → `caddy`. `make restore-test` proves it end to end
  in a throwaway project (`sa-restore`) and deletes it.
- **Measured:** about 20 s to restore 2.2 GB from a local repository.

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
| Node (web build only) | `node:26.13.0-alpine3.24` | yes | yes |
| Playwright (tests only) | `mcr.microsoft.com/playwright:v1.64.1-noble` | yes | yes |

- **Node 26** is the current LTS line (on Docker Hub, `lts-alpine` and
  `26-alpine` were the same image on 2026-11-03). It is only used to build the
  web app and run its tools; the running site is static files in Caddy.
- **TypeScript 6.0.3, not 7:** typescript-eslint 8.72 supports TypeScript
  below 6.1 only.
- **The Playwright image's version must equal `@playwright/test`** in
  `web/package.json` (both 1.64.1); the browsers inside the image are built
  for that exact version.

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

## The tailnet instance (added 2026-11-08)

Everything above describes the walking skeleton. The working application runs as the Compose project `sa-tailnet`, from `compose.yaml` + `compose.tailnet.yaml`.

```
Browser on a tailnet device
   | https://soundarchive:8443  (Tailscale forward, set up by the owner)
   v
127.0.0.1:9443 -> Caddy  (private CA, security headers, body limits)
                   |-- /api/*  --> api (FastAPI, streams uploads to disk)
                   `-- files      (the built web app)
                                     |            |
                     backend network (no route to the Internet)
                                     v            v
                            PostgreSQL + PostGIS  Redis <-- worker (ffmpeg)
                                                     ^      maintenance
                                     media volume ---+-- api, worker, maintenance
```

| Service | Job | Reaches the Internet |
|---|---|---|
| `caddy` | HTTPS with the internal CA; the only service with a published port, on `127.0.0.1` | No (only inbound) |
| `api` | Accounts, places, recordings, photos, moderation | Not needed |
| `worker` | Audio: `ffprobe`, SHA-256, `ebur128`, Opus copy, waveform peaks (RQ queue) | No: `backend` network only |
| `maintenance` | Abandoned uploads, stuck jobs, expired sessions, every 5 minutes | No |
| `redis` | Job queue and login attempt counters. Nothing on disk: `maintenance` re-queues what a restart loses | No |
| `db` | PostgreSQL 18 + PostGIS | No |

### A recording's life

1. `POST /api/recordings`: metadata; status `uploading`; empty file at `media/tmp/<id>.part`.
2. `PATCH /api/recordings/{id}/upload` with `Content-Range`, as many times as needed. The size on disk is the truth, a file lock prevents two writers, and `GET .../upload` says where to continue.
3. Last byte: moved to `media/originals/aa/bb/<id>`, made read-only, status `processing`, job queued.
4. The worker checks the allow-list, measures, and writes `media/derived/aa/bb/<id>.webm` and `.peaks.json`; status `ready` or `failed` with a code.
5. `GET .../audio` serves the copy with range requests; `GET .../original` the untouched file.

### Permissions

Every read needs a session; "public" means any account on this instance. Only `/api/health*`, `/api/config` and `/api/auth/{login,register}` work without one. See `SECURITY.md`.

### The web app

No router library: `lib/router.tsx` is a small wrapper on the History API. `PlayerProvider` holds the single `<audio>` element outside the screens, so the sound continues while navigating. Comparison uses its own two elements and pauses the shared one.
