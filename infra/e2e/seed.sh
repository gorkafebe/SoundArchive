#!/bin/sh
# Create (or reset) the test administrator of a throwaway end-to-end stack,
# using the same command line a real administrator would.
#   seed.sh <api container> <password>
set -eu
api="$1"
password="$2"
printf '%s\n' "$password" | docker exec -i "$api" python -m app.cli admin-create --username e2e-admin >/dev/null 2>&1 \
    || printf '%s\n' "$password" | docker exec -i "$api" python -m app.cli admin-reset-password --username e2e-admin >/dev/null
