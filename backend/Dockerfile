# syntax=docker/dockerfile:1
#
# Image for the API (also used by the one-shot migrate service).
#
# Multi-stage build: the first stages install dependencies with uv; the final
# stages copy only the finished virtualenv. So the prod image contains Python,
# the libraries and our code, and no uv, no pytest, no build tools.
#
#   target "prod" (default, last stage)  what runs on the MSI
#   target "dev"                         adds test tools; compose.dev.yaml picks it
#
# Python and uv are pinned to exact versions so every build is the same.
# Both images are published for amd64 and arm64.

ARG PYTHON_IMAGE=python:3.14.10-slim-trixie

# --- uv: only used to copy its binary into the build stages -----------------
FROM ghcr.io/astral-sh/uv:0.13.6 AS uv

# --- deps: production dependencies --------------------------------------------
FROM ${PYTHON_IMAGE} AS deps
COPY --from=uv /uv /usr/local/bin/uv
# UV_COMPILE_BYTECODE: precompile .pyc files now, so the container starts faster.
# UV_LINK_MODE=copy:  real copies instead of links (the uv cache is not in the image).
# UV_PYTHON_DOWNLOADS=never: use this image's Python, never download another one.
# UV_PROJECT_ENVIRONMENT: put the virtualenv in /opt/venv, outside /app, so the
#                      dev bind mount of the source code does not hide it.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
# Copy only the dependency files first. Docker caches this layer, so editing
# code later does not reinstall every library.
COPY pyproject.toml uv.lock ./
# --locked: fail if uv.lock is out of date with pyproject.toml, instead of
# silently resolving different versions.
RUN uv sync --locked --no-dev

# --- dev-deps: production + development dependencies (pytest, ...) -----------
FROM deps AS dev-deps
RUN uv sync --locked

# --- runtime: shared base for the final stages --------------------------------
FROM ${PYTHON_IMAGE} AS runtime
# PYTHONDONTWRITEBYTECODE: don't write __pycache__ folders at runtime (in dev
#                          they would appear in your source folder).
# PYTHONUNBUFFERED: print logs immediately, so `docker compose logs` is live.
# PATH: use the virtualenv's python, uvicorn and alembic.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"
# Run as an unprivileged user, not root: if the app were ever compromised,
# the attacker would not be root inside the container.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
EXPOSE 8000

# --- dev ------------------------------------------------------------------------
FROM runtime AS dev
COPY --from=dev-deps /opt/venv /opt/venv
COPY . .
USER app
# --reload restarts the server when a .py file changes. In dev the source is
# bind-mounted from the laptop (compose.dev.yaml), so saving in VS Code is enough.
# Plain uvicorn polls files for changes, which also works on Docker Desktop
# for Windows and macOS (file-change events don't always cross into containers).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# --- prod (last stage = what `docker build` produces by default) -----------------
FROM runtime AS prod
COPY --from=deps /opt/venv /opt/venv
# Only what the server needs: no tests, no lockfile.
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
USER app
# --host 0.0.0.0: listen on the container's network so Caddy can reach it.
# Port 8000 is never published to the host; only Caddy talks to it.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
