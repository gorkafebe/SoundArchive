# Sound Archive

A web app with an interactive map where people pin a place and attach an audio
recording (plus optional photos), so the sound of a place at a given moment is
preserved. Sound is the main content.

**Current state: walking skeleton.** No product features yet. The whole
infrastructure runs end to end: a browser opens a test page, the page calls the
API, and the API reads from the database, all in Docker Compose.

## Quick start (development)

You need Docker (with the Compose plugin), Git and `make`. See
[docs/DEV_SETUP.md](docs/DEV_SETUP.md).

```sh
cp .env.example .env     # local config; the placeholder values work for dev
make up                  # build, start, wait until every service is healthy
```

Open <http://localhost:8080>. Both boxes should be green.

```sh
curl http://localhost:8080/api/health       # {"status":"ok"}
curl http://localhost:8080/api/health/db    # PostgreSQL + PostGIS versions
```

## Make commands

Run `make` with no arguments to print this list. Each command prints the real
`docker compose` command it runs, so you can also type that directly.

| Command | What it does |
|---|---|
| `make up` | Dev: build and start everything, wait until healthy |
| `make down` | Dev: stop and remove containers (database data is kept) |
| `make ps` | Dev: show containers and their health |
| `make logs` | Dev: follow logs (`make logs SERVICE=api` for one service) |
| `make test` | Dev: run the test suite inside the api container |
| `make migrate` | Dev: apply database migrations |
| `make psql` | Dev: SQL shell in the database, as the admin user |
| `make reset-db` | Dev: **delete all database data** and start fresh (asks first) |
| `make prod-config` | Prod: print the merged prod configuration |
| `make prod-check` | Prod: validate the config; check db and api publish no ports and no dev-only `TEST_ADMIN_*` variable reaches prod |
| `make prod-up` | Prod: build and start in the background (on the MSI) |
| `make prod-down` | Prod: stop and remove containers (data is kept) |
| `make prod-ps` | Prod: show containers and their health |
| `make prod-logs` | Prod: follow logs |

## Repository map

```
.
├── README.md             you are here
├── Makefile              shortcuts for the commands above
├── .env.example          every configuration variable, documented (copy to .env)
├── compose.yaml          services that are the same everywhere
├── compose.dev.yaml      dev overrides (ports, live code reload)
├── compose.prod.yaml     prod overrides (restart policy, log rotation, ports 80/443)
├── backend/              the API (Python, FastAPI)
│   ├── app/              application code: settings, database, endpoints
│   ├── alembic/          database migrations
│   ├── tests/            pytest tests
│   ├── Dockerfile        builds the dev and prod images
│   ├── pyproject.toml    Python dependencies...
│   └── uv.lock           ...and their exact pinned versions
├── web/                  static test page (replaced by React in phase 3)
├── infra/
│   ├── caddy/Caddyfile   web server / reverse proxy configuration
│   └── postgres/init/    runs once when the database is first created
└── docs/
    ├── ARCHITECTURE.md   what each service does and how a request flows
    ├── DEV_SETUP.md      setting up and working on a development machine
    ├── MSI_SERVER_SETUP.md  turning the MSI laptop into the server (OS, network, SSH, battery)
    └── DEPLOY_MSI.md     deploying to the Ubuntu server, step by step
```
