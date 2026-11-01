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

`make up` builds the API image, starts everything in order and waits until all
services are healthy. The first run downloads images and takes a few minutes.
Then:

- Test page: <http://localhost:8080>. Both boxes should be green.
- API docs (interactive): <http://localhost:8080/api/docs>
- From your phone on the same Wi-Fi: `http://<laptop-IP>:8080`. Find the IP
  with `hostname -I` on Linux, `ipconfig getifaddr en0` on macOS, or
  `ipconfig` on Windows.

## Daily commands

```sh
make up        # start (or apply changes to compose files / dependencies)
make down      # stop; database data is kept
make ps        # what is running, and is it healthy?
make logs                  # follow all logs (Ctrl+C to stop following)
make logs SERVICE=api      # just one service: api, db, caddy, migrate
make test      # run the tests
make psql      # SQL shell in the database (type \q to leave)
```

**Editing code:** `backend/` is mounted into the api container, and the
server restarts itself when you save a `.py` file. `web/` is mounted into
Caddy, so refresh the browser after editing `index.html`. You only need
`make up` again after changing dependencies, the Dockerfile or the compose
files.

**Adding a Python dependency:** `cd backend && uv add <package>`, then
`make up` to rebuild the image. Commit both `pyproject.toml` and `uv.lock`.

## Tests

```sh
make test
```

This runs `pytest` inside a fresh api container connected to the dev
database. The tests are in `backend/tests/`:

- `test_health.py`: `/api/health` returns 200 (no database needed).
- `test_database.py`: `/api/health/db` returns the versions; the app user can
  use tables created by the admin (default privileges); the app user cannot
  create tables.

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
