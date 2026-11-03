# Development setup

Everything runs in Docker, so Python and Postgres don't need to be installed
on your machine. This works the same on Linux, macOS and Windows.

## Prerequisites

| Tool | Linux | macOS | Windows |
|---|---|---|---|
| Docker + Compose plugin | [Docker Engine](https://docs.docker.com/engine/install/) (same apt steps as in [DEPLOY_MSI.md](DEPLOY_MSI.md)) | [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) | [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with the WSL 2 backend |
| Git | `sudo apt install git` | `xcode-select --install` | install Ubuntu in WSL 2, then `sudo apt install git` |
| make | `sudo apt install make` | included with `xcode-select --install` | inside WSL: `sudo apt install make` |

**Windows:** clone and work **inside WSL 2** (the Ubuntu terminal), not in
`C:\`. Files under `C:\` are slow to share with containers, and auto-reload
may not notice changes. VS Code opens WSL folders with the WSL extension.

**Linux:** after installing Docker Engine, let your user run `docker` without
`sudo`, then log out and back in:

```sh
sudo usermod -aG docker $USER
```

Check:

```sh
docker version          # shows both Client and Server
docker compose version  # "Docker Compose version v2..." or newer
```

Optional: [uv](https://docs.astral.sh/uv/getting-started/installation/), only
needed to **add or update Python dependencies** and to give VS Code a local
Python environment for autocompletion (`cd backend && uv sync` creates
`backend/.venv`, which git ignores).

### VS Code extensions worth having

- **Container Tools** (`ms-azuretools.vscode-containers`): see containers, logs, images.
- **Python** (`ms-python.python`): autocompletion and navigation. Select
  `backend/.venv` as the interpreter after `uv sync`.
- **PostgreSQL** (`ms-ossdata.vscode-pgsql`): browse the database
  (connection details below).
- **YAML** (`redhat.vscode-yaml`): checks Compose files as you type.
- **WSL** (`ms-vscode-remote.remote-wsl`): Windows only.

## First start

```sh
git clone <repo-url> sound-archive
cd sound-archive
cp .env.example .env
make up
```

`make up` builds the API image and the web image (Caddy with the React app
inside; Node runs inside Docker, you do not need it installed), starts
everything in order and waits until all services are healthy. The first run
downloads images and takes a few minutes. Then:

```sh
make seed-dev   # optional: a few hundred made-up places to look at
```

- The app: <http://localhost:8080>. The map opens on Spain.
- System check page: <http://localhost:8080/status.html>. Both boxes green.
- API docs (interactive): <http://localhost:8080/api/docs>

### Opening the dev site from a phone

By default the dev site listens on `127.0.0.1` only (this computer). To try it
from a phone on the same Wi-Fi, add to `.env`:

```sh
DEV_HTTP_BIND=0.0.0.0
```

then `make up`, and open `http://<laptop-IP>:8080` on the phone. Find the IP
with `hostname -I` on Linux, `ipconfig getifaddr en0` on macOS, or `ipconfig`
on Windows. Remove the line again when you are done: `0.0.0.0` means every
device on the network can reach your dev stack. Never set it on the MSI.

Note: browsers allow "use my location" only on `https://` or `localhost`, so
on a phone over `http://<laptop-IP>` that button will say the location is not
available; tapping the map and typing coordinates still work.

## Daily commands

```sh
make up        # start (or apply changes: compose files, dependencies, web/, Caddyfile)
make down      # stop; database data is kept
make ps        # what is running, and is it healthy?
make logs                  # follow all logs (Ctrl+C to stop following)
make logs SERVICE=api      # just one service: api, db, caddy, migrate
make test      # API tests
make check     # API tests + every web check
make seed-dev  # replace the made-up example places
make psql      # SQL shell in the database (type \q to leave)
```

Web app (all run inside a Node container):

```sh
make web-install   # install the exact dependencies into web/node_modules (once, and after package-lock.json changes)
make web-check     # types, lint, translations, tokens, contrast, unit tests
make web-build     # build into web/dist (to look at the output; make up builds its own)
make web-dev       # live-reload server at http://localhost:5173 (needs make up and make web-install)
make e2e           # browser tests (Playwright in Docker)
```

**Editing code:**

- `backend/` is mounted into the api container, and the server restarts
  itself when you save a `.py` file.
- `web/` is **built into the Caddy image**, so after editing it either run
  `make up` (rebuilds in about 15 seconds) or keep `make web-dev` running and
  use <http://localhost:5173>, which reloads as you save.
- `infra/caddy/Caddyfile` is in the same image: `make up` applies it.

**Adding a Python dependency:** `cd backend && uv add <package>`, then
`make up` to rebuild the image. Commit both `pyproject.toml` and `uv.lock`.
Without uv on your machine, run it in the build image as done for
GeoAlchemy2: `docker build --target deps -t sa-backend-deps backend/`, then
`docker run --rm -u "$(id -u):$(id -g)" -e UV_CACHE_DIR=/tmp/uv -v "$PWD/backend:/app" -w /app sa-backend-deps uv add --no-sync <package>`.

**Adding a web dependency:** pin an exact version (no `^`):
`docker run --rm -u "$(id -u):$(id -g)" -e npm_config_cache=/tmp/.npm -v "$PWD/web:/app" -w /app node:26.13.0-alpine3.24 npm install --save-exact <package>@<version>`.
Commit `package.json` and `package-lock.json`.

**Texts and colours:** every text goes into both `web/src/i18n/es.json` and
`en.json` (`make web-check` fails if the keys differ). Colours, fonts,
spacing and radii live only in `web/src/styles/tokens.css` (`make web-check`
fails if a colour or a font name appears anywhere else in `web/src/`).

## Tests

```sh
make test     # API (pytest)
make web-check  # web unit tests and checks (Vitest + scripts)
make e2e      # whole app in a browser (Playwright)
```

**API** (`backend/tests/`), inside a fresh api container:

- `test_health.py`: `/api/health` returns 200 (no database needed).
- `test_database.py`: `/api/health/db` returns the versions; the app user can
  use tables created by the admin (default privileges); the app user cannot
  create tables.
- `test_places.py`: the places API. It **never writes to the dev database**:
  the `test_db` fixture (`conftest.py`) creates a separate database
  `sa_test_<random>` with the admin test account, gives it the same default
  privileges as the init script, runs all migrations, and drops it at the end.
  Covers validation, create/read, rectangle edges and the 180° meridian,
  pages, search, the 403 with writes disabled, the app user's privileges
  (can read and write, cannot alter the table), migration down and up, and
  that the rectangle query uses the GiST index with 10 000 rows
  (`docker compose -f compose.yaml -f compose.dev.yaml run --rm api pytest -s -k gist`
  prints the `EXPLAIN`).

**Web unit tests** (`web/src/**/*.test.ts(x)`, Vitest + Testing Library in a
simulated browser, jsdom): translations, URL state, the map rectangle,
clustering, the list, the place panel, the view switch and the add form. The
map itself is replaced by a stand-in (jsdom has no WebGL). `make web-check`
also runs three scripts in `web/scripts/`: same keys in both translation
files, no colour or font outside `tokens.css`, and WCAG contrast of the token
pairs in both themes.

**End-to-end** (`web/e2e/`, `make e2e`): starts the dev stack, adds the
example places, and runs the official Playwright image
(`mcr.microsoft.com/playwright`, same version as `@playwright/test`) on the
stack's Docker network as a container named `sa-e2e-playwright`, removed when
it ends. Nothing is installed on the machine. Inside:

- No internet: `/api/config` is intercepted to use a flat local map style,
  and any request to another site is answered locally.
- WebGL (MapLibre needs it) runs on SwiftShader, Chromium's CPU renderer.
- Flows: map with data, open a place, list, search, create a place, the
  disabled state, in Spanish and English; axe accessibility audit of six
  screens in both themes; a keyboard-only walk; every control at least
  44 x 44 px; nothing animates with reduced motion; screenshots at 390 x 844
  and 1440 x 900 in `web/test-results/screens/`.
- The tests create places named `E2E ...` in the dev database.

`make e2e-real-tiles` is a separate, manual check with the real basemap
provider (internet needed): style, tiles and fonts load, the CSP lets them
through, and the attribution shows.

## Database access from a GUI tool

| Setting | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `5433` (`DEV_DB_PORT` in `.env`) |
| Database | `sound_archive` (`POSTGRES_DB`) |
| User / password | `POSTGRES_USER` / `POSTGRES_PASSWORD` from `.env` (admin), or `APP_DB_USER` / `APP_DB_PASSWORD` (what the API sees) |

The port is 5433 rather than Postgres's usual 5432, so it doesn't clash with
a Postgres installed directly on your machine.

## Reset the database

```sh
make reset-db
```

It asks for confirmation, then runs `docker compose down -v`, which **deletes
the Docker volumes**: all database data, plus Caddy's (dev-only) certificate
storage. Then it starts everything again with an empty database. The init
script and migrations run again.

Do this when:

- you changed `POSTGRES_*` or `APP_DB_*` in `.env`. They are only applied when
  the database is created, so a reset is needed for changes to take effect.
- you want a clean slate.

If you set `DB_DATA_DIR` to a folder, `down -v` does **not** delete it.
Delete that folder yourself while the stack is down.

## Troubleshooting

- **"port is already allocated"**: something else uses 8080 or 5433. Change
  `DEV_HTTP_PORT` or `DEV_DB_PORT` in `.env` and run `make up`.
- **A service is unhealthy or the API won't start**: `make ps`, then
  `make logs SERVICE=<name>`. If `migrate` exited with code 1, its log shows
  the failing migration.
- **"set POSTGRES_USER in .env"**: you have no `.env` yet. Run
  `cp .env.example .env`.
- **Linux: "permission denied ... docker.sock"**: you are not in the `docker`
  group yet. Run the `usermod` command above, then log out and back in.
