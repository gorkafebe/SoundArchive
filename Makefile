# Shortcuts for common commands. Run `make` (or `make help`) to list them.
#
# Every target is just a docker compose command, printed before it runs, so you
# can learn the real command and type it yourself (e.g. on Windows without make).

# The two ways to combine the Compose files. See compose.yaml.
DEV  = docker compose -f compose.yaml -f compose.dev.yaml
PROD = docker compose -f compose.yaml -f compose.prod.yaml

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
.PHONY: help up down ps logs test migrate seed-dev psql reset-db \
        web-install web-check web-build web-dev check \
        prod-config prod-check prod-up prod-down prod-ps prod-logs

# The first target is the default: `make` alone prints this list.
# It reads the "## description" comments on the target lines below.
help: ## Show this list of commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-12s %s\n", $$1, $$2}'

# --- Development (this laptop) ------------------------------------------------

up: ## Dev: build and start everything, wait until healthy
	$(DEV) up -d --build --wait

down: ## Dev: stop and remove containers (database data is kept)
	$(DEV) down

ps: ## Dev: show containers and their health
	$(DEV) ps -a

logs: ## Dev: follow logs (all, or SERVICE=api|db|caddy|migrate)
	$(DEV) logs -f --tail=100 $(SERVICE)

test: ## Dev: run the test suite inside the api container
	$(DEV) run --rm api pytest

migrate: ## Dev: apply database migrations (alembic upgrade head)
	$(DEV) run --rm migrate

# Runs only against the dev stack ($(DEV)); the prod image does not even
# contain backend/scripts/. SEED_DEV=1 is the script's second safety catch.
seed-dev: ## Dev: add a few hundred made-up places (replaces earlier ones)
	$(DEV) run --rm -e SEED_DEV=1 api python -m scripts.seed_dev

psql: ## Dev: open a SQL shell in the database as the admin user
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
web-dev: ## Web: live-reloading dev server on port 5173 (after make up)
	$(DEV) --profile web-dev run --rm --service-ports web-dev

check: test web-check ## Dev: every check (API tests + web checks)

reset-db: ## Dev: DELETE all database data and volumes, then start fresh
	@printf 'This deletes ALL database data in the dev Docker volumes. Type y to continue: '; \
	  read answer; [ "$$answer" = y ] || { echo "Cancelled."; exit 1; }
	$(DEV) down -v
	$(DEV) up -d --build --wait

# --- Production (the MSI) -------------------------------------------------------

prod-config: ## Prod: print the merged prod configuration
	$(PROD) config

# TEST_ADMIN_* variables carry the admin password for the dev-only privilege
# test (compose.dev.yaml) and must never reach prod. The check matches the
# name only: grep -q prints nothing, so no value and no config is shown.
prod-check: ## Prod: validate the config; no db/api ports, no TEST_ADMIN_* vars
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

prod-up: ## Prod: build and start everything in the background
	$(PROD) up -d --build --wait

prod-down: ## Prod: stop and remove containers (data is kept)
	$(PROD) down

prod-ps: ## Prod: show containers and their health
	$(PROD) ps -a

prod-logs: ## Prod: follow logs (all, or SERVICE=...)
	$(PROD) logs -f --tail=100 $(SERVICE)
