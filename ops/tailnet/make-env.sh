#!/usr/bin/env bash
# make-env.sh: create ./.env from .env.example with fresh random secrets.
#
#   ops/tailnet/make-env.sh <tailnet-fqdn>
#
# The secrets are generated here and written only to .env (mode 600); nothing
# is printed. It refuses to overwrite an existing .env: the database keeps the
# passwords of its first start, so replacing them would lock the app out.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fqdn="${1:?usage: make-env.sh <tailnet-fqdn>}"
[ ! -e .env ] || { echo ".env already exists; not touching it." >&2; exit 1; }

# 32 random bytes, without the characters that need escaping in a URL or sed.
rand() { openssl rand -base64 32 | tr -d '/+=\n'; }

umask 077
cp .env.example .env
chmod 600 .env
sed -i \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|" \
    -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(rand)|" \
    .env

{
    echo
    echo "# --- Added by ops/tailnet/make-env.sh ---------------------------------"
    echo "# compose.yaml says name: sound-archive (the real app). This line makes a"
    echo "# bare 'make up' in this checkout use a throwaway project instead."
    echo "COMPOSE_PROJECT_NAME=sa-test-dev"
    echo "TAILNET_FQDN=$fqdn"
    echo "REDIS_PASSWORD=$(rand)"
} >> .env

echo "OK: .env created (mode 600); secrets not shown."
