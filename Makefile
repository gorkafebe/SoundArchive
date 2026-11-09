# Shortcuts for common commands. Run `make` (or `make help`) to list them.
#
# Every target is just a docker compose command, printed before it runs, so you
# can learn the real command and type it yourself (e.g. on Windows without make).

# The two ways to combine the Compose files. See compose.yaml.
#
# Every Compose command gets its project name explicitly (-p), and the variable
# too, because compose.yaml uses it to name the images. Compose has no default
# name any more: a project name decides which containers and volumes a command
# acts on, and "sound-archive" is the real app on the MSI.
# See "The project-name guard" in docs/DEV_SETUP.md.
#
# Where the name comes from, same order as Compose: the make command line, the
# environment, then .env. Only that one line of .env is read.
ifeq ($(origin COMPOSE_PROJECT_NAME),undefined)
COMPOSE_PROJECT_NAME := $(shell sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}COMPOSE_PROJECT_NAME=//p' .env 2>/dev/null | tail -n 1 | tr -d "\r\"' ")
endif
DEV  = COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) docker compose -p $(COMPOSE_PROJECT_NAME) -f compose.yaml -f compose.dev.yaml
PROD = COMPOSE_PROJECT_NAME=sound-archive docker compose -p sound-archive -f compose.yaml -f compose.prod.yaml

# Where the real app lives. "override": it cannot be changed from the command
# line, or the check below would mean nothing.
override PROD_DIR := /srv/sound-archive

# Optional: limit logs to one service, e.g. `make logs SERVICE=api`.
SERVICE ?=

# The web app's tools (npm, TypeScript, Vite, tests) run in this Node image,
# so Node never has to be installed on the machine. Same version as
# NODE_IMAGE in web/Dockerfile: change both together.
#   -u: run as you, so files written into web/ (node_modules, dist) are yours
#   npm_config_cache: npm's download cache, inside the container
NODE_IMAGE = node:26.13.0-alpine3.24
NODE = docker run --rm -u "$$(id -u):$$(id -g)" -v "$(CURDIR)/web:/app" -w /app \
       -e npm_config_cache=/tmp/.npm -e npm_config_update_notifier=false -e npm_config_fund=false \
       $(NODE_IMAGE)

# These targets are command names, not files to build.
.PHONY: help guard-project guard-prod guard-test up down ps logs test migrate seed-dev psql reset-db \
        web-install web-check web-build web-dev check e2e e2e-real-tiles e2e-manual \
        e2e-image e2e-up e2e-down tailnet-up tailnet-down tailnet-ps tailnet-logs tailnet-ca-export exposure-check need-username need-id admin-create admin-reset-password invite-create purge-recording purge-place \
        prod-config prod-check prod-up prod-down prod-ps prod-logs \
        msi-check msi-snapshot shellcheck backup restore-test need-backup-vars

# The first target is the default: `make` alone prints this list.
# It reads the "## description" comments on the target lines below.
help: ## Show this list of commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-12s %s\n", $$1, $$2}'

# --- Guards ---------------------------------------------------------------------
# Internal targets, first prerequisite of every target that runs Compose.
# They stop make before any docker command. scripts/check-make-guards.sh fails
# if a target forgets them; both messages are one line, Spanish / English.
#
# guard-project allows exactly: sa-dev, sa-tailnet, sa-test-<something>,
# sa-e2e-<something>. Lowercase letters, digits, - and _ only.
guard-project:
	@case "$(COMPOSE_PROJECT_NAME)" in \
	  "") echo "ERROR: falta COMPOSE_PROJECT_NAME; ejecuta 'cp .env.example .env' o usa COMPOSE_PROJECT_NAME=sa-dev / missing COMPOSE_PROJECT_NAME; run 'cp .env.example .env' or set COMPOSE_PROJECT_NAME=sa-dev" >&2; exit 1 ;; \
	  sound-archive) echo "ERROR: 'sound-archive' es el nombre reservado de la app real; usa sa-dev, o make prod-* desde $(PROD_DIR) / 'sound-archive' is reserved for the real app; use sa-dev, or make prod-* from $(PROD_DIR)" >&2; exit 1 ;; \
	  *[!a-z0-9_-]*) echo "ERROR: COMPOSE_PROJECT_NAME='$(COMPOSE_PROJECT_NAME)' tiene caracteres no válidos; usa minúsculas, cifras, - o _ / has invalid characters; use lowercase, digits, - or _" >&2; exit 1 ;; \
	  sa-dev|sa-tailnet|sa-test-?*|sa-e2e-?*) ;; \
	  *) echo "ERROR: COMPOSE_PROJECT_NAME='$(COMPOSE_PROJECT_NAME)' no está permitido; usa sa-dev, sa-tailnet, sa-test-* o sa-e2e-* / is not allowed; use sa-dev, sa-tailnet, sa-test-* or sa-e2e-*" >&2; exit 1 ;; \
	esac
	@case "$(E2E_PROJECT)" in \
	  *[!a-z0-9_-]*) echo "ERROR: E2E_PROJECT='$(E2E_PROJECT)' tiene caracteres no válidos; usa sa-test-* o sa-e2e-* / has invalid characters; use sa-test-* or sa-e2e-*" >&2; exit 1 ;; \
	  sa-test-?*|sa-e2e-?*) ;; \
	  *) echo "ERROR: E2E_PROJECT='$(E2E_PROJECT)' no está permitido, porque e2e-down borra sus volúmenes; usa sa-test-* o sa-e2e-* / is not allowed, because e2e-down deletes its volumes; use sa-test-* or sa-e2e-*" >&2; exit 1 ;; \
	esac

# The real app runs only from its own folder, and needs its own .env.
guard-prod:
	@here="$$(realpath .)"; [ "$$here" = "$(PROD_DIR)" ] || { echo "ERROR: make prod-* solo se ejecuta en $(PROD_DIR) y esto es $$here; ve a esa carpeta o usa make up / make prod-* runs only in $(PROD_DIR) and this is $$here; go there or use make up" >&2; exit 1; }
	@[ -f .env ] || { echo "ERROR: falta $(PROD_DIR)/.env, con las contraseñas reales; restáuralo antes de seguir / $(PROD_DIR)/.env is missing, it holds the real passwords; restore it first" >&2; exit 1; }

# --- Development (this laptop) ------------------------------------------------

up: guard-project ## Dev: build and start everything, wait until healthy
	$(DEV) up -d --build --wait

down: guard-project ## Dev: stop and remove containers (database data is kept)
	$(DEV) down

ps: guard-project ## Dev: show containers and their health
	$(DEV) ps -a

logs: guard-project ## Dev: follow logs (all, or SERVICE=api|db|caddy|migrate)
	$(DEV) logs -f --tail=100 $(SERVICE)

test: guard-project ## Dev: run the test suite inside the api container
	$(DEV) run --rm api pytest

migrate: guard-project ## Dev: apply database migrations (alembic upgrade head)
	$(DEV) run --rm migrate

# Runs only against the dev stack ($(DEV)); the prod image does not even
# contain backend/scripts/. SEED_DEV=1 is the script's second safety catch.
seed-dev: guard-project ## Dev: add a few hundred made-up places (replaces earlier ones)
	$(DEV) run --rm -e SEED_DEV=1 api python -m scripts.seed_dev

psql: guard-project ## Dev: open a SQL shell in the database as the admin user
	$(DEV) exec db sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

# --- Web app (web/) ------------------------------------------------------------

web-install: ## Web: install the exact versions from package-lock.json
	$(NODE) npm ci --no-audit

web-check: ## Web: types, lint, translations, tokens, contrast, unit tests
	$(NODE) npm run check

web-build: ## Web: build the app into web/dist (make up builds its own copy)
	$(NODE) npm run build

# Vite's dev server with instant reload, at http://localhost:5173, sending
# /api to the dev stack's Caddy. Needs `make up` first. Ctrl+C to stop.
web-dev: guard-project ## Web: live-reloading dev server on port 5173 (after make up)
	$(DEV) --profile web-dev run --rm --service-ports web-dev

guard-test: ## Dev: prove the Compose guards work (fake docker, nothing real runs)
	scripts/test-make-guard.sh

check: guard-test test web-check ## Dev: every check (guards, API tests, web checks)

# End-to-end tests in a real (headless) browser, inside Docker, against a
# throwaway copy of the REAL configuration (HTTPS with the private CA, the
# same cookies and headers):
#   1. start the stack as project $(E2E_PROJECT), on 127.0.0.1 only;
#   2. copy its public root certificate out, for the browser to trust;
#   3. run the Playwright image on the stack's network, where Caddy answers
#      as https://soundarchive. No "ignore certificate errors".
# Extra options:  make e2e E2E_ARGS="--grep keyboard"
# The stack stays up between runs; make e2e-down destroys it.
E2E_PROJECT ?= sa-test-e2e
E2E_STACK = COMPOSE_PROJECT_NAME=$(E2E_PROJECT) TAILNET_HTTP_PORT=19080 TAILNET_HTTPS_PORT=19443 \
            docker compose -p $(E2E_PROJECT) -f compose.yaml -f compose.tailnet.yaml -f compose.e2e.yaml
E2E_IMAGE = sa-e2e-playwright:v1.64.1
E2E_ARGS ?=
E2E_CA_DIR = $(CURDIR)/web/test-results/ca
e2e-image: guard-project
	docker build -q -t $(E2E_IMAGE) infra/e2e
e2e-up: guard-project e2e-image
	$(E2E_STACK) up -d --build --wait
	mkdir -p $(E2E_CA_DIR)
	$(E2E_STACK) cp caddy:/data/caddy/pki/authorities/local/root.crt $(E2E_CA_DIR)/root.crt
	infra/e2e/seed.sh $(E2E_PROJECT)-api-1 throwaway-e2e-stack-only
e2e: e2e-up ## Dev: end-to-end browser tests over HTTPS (Playwright in Docker)
	docker run --rm --name sa-e2e-playwright --network $(E2E_PROJECT)_default --shm-size=1g \
	  -u "$$(id -u):$$(id -g)" -e HOME=/tmp/home -v "$(CURDIR)/web:/app" -w /app \
	  -e NODE_EXTRA_CA_CERTS=/app/test-results/ca/root.crt \
	  $(E2E_IMAGE) e2e-run npx playwright test $(E2E_ARGS)
e2e-down: guard-project ## Dev: destroy the end-to-end stack and its data
	$(E2E_STACK) down -v --remove-orphans

# A manual check against the REAL basemap provider (internet needed): the
# style, tiles and fonts load and the attribution shows. Not part of `e2e`.
e2e-real-tiles: e2e-up ## Dev: one manual browser check with the real map tiles
	docker run --rm --name sa-e2e-real-tiles --network $(E2E_PROJECT)_default --shm-size=1g \
	  -u "$$(id -u):$$(id -g)" -e HOME=/tmp/home -e E2E_REAL_TILES=1 -v "$(CURDIR)/web:/app" -w /app \
	  -e NODE_EXTRA_CA_CERTS=/app/test-results/ca/root.crt \
	  $(E2E_IMAGE) e2e-run npx playwright test --project=chromium real-tiles
# Other manual browser checks (web/e2e/*.manual.spec.ts). real-layers needs the
# internet; screens does not. Example: make e2e-manual E2E_ARGS=screens
e2e-manual: e2e-up ## Dev: run a manual browser check (E2E_ARGS=real-layers or screens)
	docker run --rm --name sa-e2e-manual --network $(E2E_PROJECT)_default --shm-size=1g \
	  -u "$$(id -u):$$(id -g)" -e HOME=/tmp/home -e E2E_REAL_TILES=1 -v "$(CURDIR)/web:/app" -w /app \
	  -e NODE_EXTRA_CA_CERTS=/app/test-results/ca/root.crt \
	  $(E2E_IMAGE) e2e-run npx playwright test --project=chromium $(E2E_ARGS)
reset-db: guard-project ## Dev: DELETE all database data and volumes, then start fresh
	@printf 'This deletes ALL database data in the dev Docker volumes. Type y to continue: '; \
	  read answer; [ "$$answer" = y ] || { echo "Cancelled."; exit 1; }
	$(DEV) down -v
	$(DEV) up -d --build --wait

# --- Production (the MSI) -------------------------------------------------------

prod-config: guard-prod ## Prod: print the merged prod configuration
	$(PROD) config

# TEST_ADMIN_* variables carry the admin password for the dev-only privilege
# test (compose.dev.yaml) and must never reach prod. The check matches the
# name only: grep -q prints nothing, so no value and no config is shown.
prod-check: guard-prod ## Prod: validate the config; no db/api ports, no TEST_ADMIN_* vars
	$(PROD) config --quiet
	@for svc in db api; do \
	  if $(PROD) config $$svc | grep -q 'published:'; then \
	    echo "FAIL: '$$svc' publishes a port in prod"; exit 1; \
	  fi; \
	done; \
	if $(PROD) config | grep -q 'TEST_ADMIN_'; then \
	  echo "FAIL: a TEST_ADMIN_* variable is set in the prod config (dev only)"; exit 1; \
	fi; \
	echo "OK: prod config is valid; db and api publish no ports."

prod-up: guard-prod ## Prod: build and start everything in the background
	$(PROD) up -d --build --wait

prod-down: guard-prod ## Prod: stop and remove containers (data is kept)
	$(PROD) down

prod-ps: guard-prod ## Prod: show containers and their health
	$(PROD) ps -a

prod-logs: guard-prod ## Prod: follow logs (all, or SERVICE=...)
	$(PROD) logs -f --tail=100 $(SERVICE)

# --- Tailnet instance (project sa-tailnet) ---------------------------------------
# Listens on 127.0.0.1 only; see compose.tailnet.yaml. The persistent instance
# the owner uses: its name is fixed here, not taken from .env. COMPOSE_PROJECT_NAME
# is set as well as -p because compose.yaml uses it to name the images.
TAILNET = COMPOSE_PROJECT_NAME=sa-tailnet docker compose -p sa-tailnet -f compose.yaml -f compose.tailnet.yaml
CA_EXPORT_DIR ?= $(HOME)/SoundArchive-Informe/tailnet-2026-11-08/ca
tailnet-up: guard-project ## Tailnet: build and start the instance (127.0.0.1 only)
	$(TAILNET) up -d --build --wait
tailnet-down: guard-project ## Tailnet: stop and remove containers (data is kept)
	$(TAILNET) down
tailnet-ps: guard-project ## Tailnet: show containers and their health
	$(TAILNET) ps -a
tailnet-logs: guard-project ## Tailnet: follow logs (all, or SERVICE=...)
	$(TAILNET) logs -f --tail=100 $(SERVICE)
tailnet-ca-export: guard-project ## Tailnet: copy the PUBLIC root certificate out and print its fingerprint
	mkdir -p $(CA_EXPORT_DIR)
	$(TAILNET) cp caddy:/data/caddy/pki/authorities/local/root.crt $(CA_EXPORT_DIR)/root.crt
	openssl x509 -in $(CA_EXPORT_DIR)/root.crt -noout -fingerprint -sha256
# Administrator commands, against the running instance. The password is asked
# with hidden input; it never appears as an argument or in the shell history.
USERNAME ?=
ID ?=
need-username:
	@[ -n "$(USERNAME)" ] || { echo "Set USERNAME=<name>, e.g. make admin-create USERNAME=ana"; exit 1; }
need-id:
	@[ -n "$(ID)" ] || { echo "Set ID=<uuid>"; exit 1; }
admin-create: guard-project need-username ## Tailnet: create an administrator (USERNAME=...)
	$(TAILNET) exec api python -m app.cli admin-create --username "$(USERNAME)"
admin-reset-password: guard-project need-username ## Tailnet: set a new password for an account (USERNAME=...)
	$(TAILNET) exec api python -m app.cli admin-reset-password --username "$(USERNAME)"
invite-create: guard-project ## Tailnet: create an invitation code
	$(TAILNET) exec api python -m app.cli invite-create
purge-recording: guard-project need-id ## Tailnet: delete a removed recording and its files for good (ID=...)
	$(TAILNET) exec api python -m app.cli purge-recording --id "$(ID)"
purge-place: guard-project need-id ## Tailnet: delete a removed place, with its recordings and photos (ID=...)
	$(TAILNET) exec api python -m app.cli purge-place --id "$(ID)"
exposure-check: ## Tailnet: fail if anything of ours is reachable beyond loopback
	ops/tailnet/exposure-check.sh

# --- MSI operations (read-only checks) -----------------------------------------
# Scripts in ops/check/. They change nothing, need no sudo and print no
# secrets (see docs/MSI_REBOOT_AND_POWER_TESTS.md).

msi-check: ## MSI: read-only health checklist (containers, ports, battery...)
	ops/check/verify-msi.sh

# LABEL names the snapshot folder, e.g. make msi-snapshot LABEL=antes-reinicio
LABEL ?= foto
msi-snapshot: ## MSI: save a dated, redacted snapshot of the state (LABEL=...)
	ops/check/snapshot-state.sh $(LABEL)

# ShellCheck (a linter for shell scripts) in a pinned Docker image, so
# nothing is installed on the machine. -x follows the files a script sources.
SHELLCHECK_IMAGE = koalaman/shellcheck:v0.11.0
# --- Backups (restic) ------------------------------------------------------------
# See docs/BACKUP_AND_RESTORE.md. Nothing has a default destination: the
# repository, the password FILE and the project are always given, e.g.
#   make backup RESTIC_REPO=/mnt/usb/sound-archive-restic \
#        RESTIC_PASSWORD_FILE=~/.config/sound-archive/restic-password \
#        BACKUP_PROJECT=sound-archive MEDIA_DIR=/srv/sound-archive-media
#   make restore-test RESTIC_REPO=... RESTIC_PASSWORD_FILE=... BACKUP_PROJECT=sa-ops
# restore-test compares with the RUNNING stack of BACKUP_PROJECT (SOURCE_URL,
# default the dev stack) and always destroys its sa-restore copy.
RESTIC_REPO ?=
RESTIC_PASSWORD_FILE ?=
BACKUP_PROJECT ?=
MEDIA_DIR ?=
SOURCE_URL ?= http://127.0.0.1:8080
BACKUP_ARGS ?=
need-backup-vars:
	@[ -n "$(RESTIC_REPO)" ] || { echo "Set RESTIC_REPO=<restic repository> (no default, on purpose)"; exit 1; }
	@[ -n "$(RESTIC_PASSWORD_FILE)" ] || { echo "Set RESTIC_PASSWORD_FILE=<file with the restic password>"; exit 1; }
	@[ -n "$(BACKUP_PROJECT)" ] || { echo "Set BACKUP_PROJECT=<Compose project> (sound-archive = the real app)"; exit 1; }

backup: need-backup-vars ## Ops: back up a project with restic (RESTIC_REPO=, RESTIC_PASSWORD_FILE=, BACKUP_PROJECT=)
	ops/backup/backup.sh --repo "$(RESTIC_REPO)" --password-file "$(RESTIC_PASSWORD_FILE)" \
	  --project "$(BACKUP_PROJECT)" $(if $(MEDIA_DIR),--media "$(MEDIA_DIR)") $(BACKUP_ARGS)

restore-test: need-backup-vars ## Ops: restore the latest backup into sa-restore, compare, destroy it
	ops/backup/restore-test.sh --repo "$(RESTIC_REPO)" --password-file "$(RESTIC_PASSWORD_FILE)" \
	  --source-project "$(BACKUP_PROJECT)" --source-url "$(SOURCE_URL)" $(if $(MEDIA_DIR),--media "$(MEDIA_DIR)")

shellcheck: ## Ops: lint every script in ops/ and scripts/ with ShellCheck (in Docker)
	docker run --rm -v "$(CURDIR):/mnt:ro" -w /mnt $(SHELLCHECK_IMAGE) -x $$(cd $(CURDIR) && find ops scripts -name '*.sh' | sort)
