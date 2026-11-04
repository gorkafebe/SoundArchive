# Sound Archive

A web app with an interactive map where people pin a place and attach an audio
recording (plus optional photos), so the sound of a place at a given moment is
preserved. Sound is the main content.

**Current state: phase 3 foundations.** A map and a list of places (with
search), a place panel, and a form to add a place, in Spanish and English,
light and dark. No audio yet (phases 4 and 5), no accounts (phase 6), no
photos. The visual design is provisional: colours, fonts and spacing live in
one file of tokens (`web/src/styles/tokens.css`) until the real design
arrives. Everything runs in Docker Compose.

## Quick start (development)

You need Docker (with the Compose plugin), Git and `make`. See
[docs/DEV_SETUP.md](docs/DEV_SETUP.md).

```sh
cp .env.example .env     # local config; the placeholder values work for dev
make up                  # build, start, wait until every service is healthy
```

Open <http://localhost:8080> for the app (`make seed-dev` adds made-up
places to look at) and <http://localhost:8080/status.html> for the system
check: both boxes should be green.

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
| `make test` | Dev: run the API tests inside the api container |
| `make seed-dev` | Dev: add a few hundred made-up places (dev database only) |
| `make web-install` | Web: install the exact npm dependencies (in a Node container) |
| `make web-check` | Web: types, lint, translations, tokens, contrast, unit tests |
| `make web-build` | Web: build the app into `web/dist` |
| `make web-dev` | Web: live-reload server on port 5173 (after `make up`) |
| `make check` | Dev: API tests + every web check |
| `make e2e` | Dev: browser tests with Playwright, in Docker |
| `make e2e-real-tiles` | Dev: one manual browser check with the real map tiles (internet) |
| `make migrate` | Dev: apply database migrations |
| `make psql` | Dev: SQL shell in the database, as the admin user |
| `make reset-db` | Dev: **delete all database data** and start fresh (asks first) |
| `make prod-config` | Prod: print the merged prod configuration |
| `make prod-check` | Prod: validate the config; check db and api publish no ports and no dev-only `TEST_ADMIN_*` variable reaches prod |
| `make prod-up` | Prod: build and start in the background (on the MSI) |
| `make prod-down` | Prod: stop and remove containers (data is kept) |
| `make prod-ps` | Prod: show containers and their health |
| `make prod-logs` | Prod: follow logs |
| `make msi-check` | MSI: read-only health checklist (containers, ports, battery, Tailscale, disk, temperatures); no `sudo`, no secrets |
| `make msi-snapshot LABEL=...` | MSI: the same state, saved with the date, to compare before and after a test |
| `make backup RESTIC_REPO=... RESTIC_PASSWORD_FILE=... BACKUP_PROJECT=...` | Backup with restic (database dump + `MEDIA_DIR`); **no default destination** |
| `make restore-test RESTIC_REPO=... RESTIC_PASSWORD_FILE=... BACKUP_PROJECT=...` | Restore the latest backup into `sa-restore`, compare it with the running project, delete it |
| `make shellcheck` | Lint every script in `ops/` with ShellCheck (in Docker) |

Backups and the MSI checks: [docs/BACKUP_AND_RESTORE.md](docs/BACKUP_AND_RESTORE.md),
[docs/MSI_REBOOT_AND_POWER_TESTS.md](docs/MSI_REBOOT_AND_POWER_TESTS.md).

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
├── web/                  the web app (React + TypeScript + Vite + MapLibre)
│   ├── src/              code; styles/tokens.css = provisional design tokens
│   ├── public/           copied as-is: status.html (system check), theme-init.js
│   ├── e2e/              Playwright browser tests
│   ├── scripts/          checks: translations, tokens, contrast
│   └── Dockerfile        builds the app into the Caddy image
├── infra/
│   ├── caddy/Caddyfile   web server / reverse proxy configuration
│   └── postgres/init/    runs once when the database is first created
├── ops/                  operations scripts (bash, checked with ShellCheck)
│   ├── check/            verify-msi.sh, snapshot-state.sh: read-only server checks
│   ├── backup/           backup.sh, restore.sh, restore-test.sh (restic)
│   └── lib/redact.sed    hides addresses, MACs and the tailnet name in their output
└── docs/
    ├── ARCHITECTURE.md   what each service does and how a request flows
    ├── DEV_SETUP.md      setting up and working on a development machine
    ├── MSI_SERVER_SETUP.md  turning the MSI laptop into the server (OS, network, SSH, battery)
    ├── DEPLOY_MSI.md     deploying to the Ubuntu server, step by step
    ├── BACKUP_AND_RESTORE.md  backups with restic: what, why, how to restore, rehearsal
    ├── MSI_REBOOT_AND_POWER_TESTS.md  reboot, power and network tests (owner)
    ├── POWER_TUNING_PLAN.md   saving power on the MSI, step by step (not applied)
    └── design/           research and brief; IMPLEMENTATION_NOTES.md (what is built, what the design will replace)
```
