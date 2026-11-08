#!/usr/bin/env bash
# Proves the Compose guards of the Makefile work. `make guard-test` runs it.
#
# Nothing real can run: it works in a temporary copy of the versioned files
# (never with the real .env), with a fake `docker` first in PATH that only
# writes each call to a log. DOCKER_HOST also points at a socket that does not
# exist, as a second barrier. A test passes only if the log shows what it should.
#
# Set GUARD_TEST_KEEP_LOG=<file> to keep a copy of the log of the fake docker.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
case "$WORK" in
    "$REPO"/*) echo "FAIL: temporary folder is inside the repository" >&2; exit 2 ;;
esac

COPY="$WORK/copy"
BIN="$WORK/bin"          # fake docker and openssl
PROD_BIN="$WORK/prodbin" # also a fake realpath, to imitate /srv/sound-archive
LOG="$WORK/docker.log"
ALL_CALLS="$WORK/all-calls.log"
OUT="$WORK/out"
mkdir -p "$COPY" "$BIN" "$PROD_BIN" "$WORK/home" "$WORK/ca"

(cd "$REPO" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | tar -x -C "$COPY"
[ ! -e "$COPY/.env" ] || { echo "FAIL: the copy has a .env" >&2; exit 2; }

# Logs what the variable and the arguments were, and succeeds.
printf '%s\n' '#!/bin/sh' \
    'printf "[env=%s] %s\n" "${COMPOSE_PROJECT_NAME:-}" "$*" >> "$FAKE_DOCKER_LOG"' \
    'exit 0' > "$BIN/docker"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$BIN/openssl"
printf '%s\n' '#!/bin/sh' 'echo /srv/sound-archive' > "$PROD_BIN/realpath"
chmod +x "$BIN/docker" "$BIN/openssl" "$PROD_BIN/realpath"
: > "$LOG"
: > "$ALL_CALLS"
printf 'y\n' > "$WORK/answer"

failures=0
fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
pass() { echo "ok    $*"; }

# run <PATH prefix> [VAR=value ...] make ... : in the copy, stdout+stderr to $OUT.
# Empties the log first and keeps everything in $ALL_CALLS. Answers "y" to the
# confirmation of make reset-db.
last_status=0
run() {
    local path_prefix="$1"
    shift
    cat "$LOG" >> "$ALL_CALLS"
    : > "$LOG"
    last_status=0
    (cd "$COPY" && env -u COMPOSE_PROJECT_NAME -u E2E_PROJECT -u MAKEFLAGS -u MFLAGS -u MAKELEVEL \
        PATH="$path_prefix:$PATH" HOME="$WORK/home" DOCKER_HOST="unix://$WORK/no-such-docker.sock" \
        FAKE_DOCKER_LOG="$LOG" "$@") < "$WORK/answer" > "$OUT" 2>&1 || last_status=$?
}

# expect_refused <label> <text in the message>, after a run.
expect_refused() {
    [ "$last_status" -ne 0 ] || fail "$1: make should have failed"
    grep -q '^ERROR: ' "$OUT" || fail "$1: no ERROR message"
    grep -qF -- "$2" "$OUT" || fail "$1: message lacks \"$2\""
    [ ! -s "$LOG" ] || fail "$1: docker was called: $(head -n 1 "$LOG")"
}

# expect_project <label> <project>, after a run: succeeded, every Compose call
# named that project and set the variable to it, and it did call Compose.
expect_project() {
    [ "$last_status" -eq 0 ] || fail "$1: make failed: $(head -n 1 "$OUT")"
    grep -q "compose -p $2 " "$LOG" || fail "$1: no 'compose -p $2' in the log"
    if grep ' compose ' "$LOG" | grep -qv "^\[env=$2\] compose -p $2 "; then
        fail "$1: a Compose call used another project: $(grep ' compose ' "$LOG" | grep -v "compose -p $2 " | head -n 1)"
    fi
}

CHECKER="$COPY/scripts/check-make-guards.sh"
VARS=(USERNAME=test-user ID=00000000-0000-0000-0000-000000000000 CA_EXPORT_DIR="$WORK/ca")

# The list comes from the checker, so a new target is tested automatically.
GUARDED=(e2e e2e-real-tiles)
PROD_TARGETS=()
while read -r target guard; do
    if [ "$guard" = guard-prod ]; then PROD_TARGETS+=("$target"); else GUARDED+=("$target"); fi
done < <("$CHECKER" --list "$COPY/Makefile" | sort)

project_for() {
    case "$1" in
        tailnet-*|admin-*|invite-create|purge-*) echo sa-tailnet ;;
        e2e*) echo sa-test-e2e ;;
        *) echo sa-dev ;;
    esac
}

for needed in up down ps logs test migrate reset-db tailnet-up admin-create e2e-down; do
    [[ " ${GUARDED[*]} " == *" $needed "* ]] || fail "target $needed is not in the list of guarded targets"
done
for needed in prod-up prod-down prod-check prod-config; do
    [[ " ${PROD_TARGETS[*]} " == *" $needed "* ]] || fail "target $needed is not in the list of production targets"
done
pass "targets found: ${#GUARDED[@]} guarded, ${#PROD_TARGETS[@]} production"

# --- The fake really is the docker that runs ------------------------------------
run "$BIN" sh -c 'docker probe; command -v docker'
grep -qF "$BIN/docker" "$OUT" || fail "docker does not resolve to the fake"
[ -s "$LOG" ] || fail "the fake docker does not log"
pass "docker resolves to the fake one, and it logs"

# --- 1. No name anywhere ---------------------------------------------------------
[ ! -e "$COPY/.env" ] || fail "the copy gained a .env"
for t in "${GUARDED[@]}"; do
    run "$BIN" make "$t" "${VARS[@]}"
    expect_refused "no .env: $t" "COMPOSE_PROJECT_NAME"
done
pass "no .env: all guarded targets refuse, docker never called"

printf 'POSTGRES_USER=x\n' > "$COPY/.env"
run "$BIN" make up
expect_refused ".env without the name: up" "COMPOSE_PROJECT_NAME"
run "$BIN" COMPOSE_PROJECT_NAME= make up
expect_refused "empty variable: up" "COMPOSE_PROJECT_NAME"
rm "$COPY/.env"
pass ".env without the name, and an empty variable: refused"

# --- 2. The reserved name, from each source ---------------------------------------
for t in "${GUARDED[@]}"; do
    run "$BIN" COMPOSE_PROJECT_NAME=sound-archive make "$t" "${VARS[@]}"
    expect_refused "environment sound-archive: $t" "sound-archive"
    run "$BIN" make "$t" COMPOSE_PROJECT_NAME=sound-archive "${VARS[@]}"
    expect_refused "command line sound-archive: $t" "sound-archive"
done
for line in 'COMPOSE_PROJECT_NAME=sound-archive' 'COMPOSE_PROJECT_NAME="sound-archive"' "export COMPOSE_PROJECT_NAME='sound-archive'"; do
    printf '%s\n' "$line" > "$COPY/.env"
    for t in "${GUARDED[@]}"; do
        run "$BIN" make "$t" "${VARS[@]}"
        expect_refused "$line: $t" "sound-archive"
    done
done
# With several lines, Compose uses the last one, so the guard must too.
printf 'COMPOSE_PROJECT_NAME=sa-dev\nCOMPOSE_PROJECT_NAME=sound-archive\n' > "$COPY/.env"
run "$BIN" make up
expect_refused "two lines in .env, last one reserved" "sound-archive"
rm "$COPY/.env"
pass "sound-archive from environment, command line or .env (any quoting): refused"

# --- 3. Names outside the list ----------------------------------------------------
for name in prod sa-devil sa-test- sa-e2e- SA-DEV 'sa-dev x' sa-tailnet2 sound-archive-2; do
    run "$BIN" "COMPOSE_PROJECT_NAME=$name" make down
    expect_refused "name '$name'" "COMPOSE_PROJECT_NAME"
done
for name in sound-archive sa-dev sa-tailnet prod sa-test-; do
    run "$BIN" COMPOSE_PROJECT_NAME=sa-dev make e2e-down "E2E_PROJECT=$name"
    expect_refused "E2E_PROJECT '$name'" "E2E_PROJECT"
done
pass "names outside the list: refused (COMPOSE_PROJECT_NAME and E2E_PROJECT)"

# --- 4. A correct name reaches docker compose with -p -----------------------------
for t in "${GUARDED[@]}"; do
    run "$BIN" COMPOSE_PROJECT_NAME=sa-dev make "$t" "${VARS[@]}"
    expect_project "sa-dev: $t" "$(project_for "$t")"
done
pass "COMPOSE_PROJECT_NAME=sa-dev: every guarded target calls compose -p <expected>"

run "$BIN" COMPOSE_PROJECT_NAME=sa-test-branch make up
expect_project "sa-test-branch" sa-test-branch
for line in 'COMPOSE_PROJECT_NAME=sa-dev' 'COMPOSE_PROJECT_NAME="sa-dev"' $'COMPOSE_PROJECT_NAME=sa-dev\r'; do
    printf '%s\n' "$line" > "$COPY/.env"
    run "$BIN" make up
    expect_project "from .env: $line" sa-dev
done
# The environment wins over .env, as in Compose.
printf 'COMPOSE_PROJECT_NAME=sa-test-file\n' > "$COPY/.env"
run "$BIN" COMPOSE_PROJECT_NAME=sa-test-shell make up
expect_project "environment over .env" sa-test-shell
rm "$COPY/.env"
pass "other allowed names, and names from .env: used with -p"

# --- 5. Production: refused outside /srv/sound-archive ---------------------------
printf 'POSTGRES_USER=placeholder\n' > "$COPY/.env"
for t in "${PROD_TARGETS[@]}"; do
    run "$BIN" COMPOSE_PROJECT_NAME=sound-archive make "$t"
    expect_refused "outside /srv: $t" "/srv/sound-archive"
    run "$BIN" COMPOSE_PROJECT_NAME=sa-dev make "$t"
    expect_refused "outside /srv, sa-dev: $t" "/srv/sound-archive"
    run "$BIN" make "$t" PROD_DIR="$COPY"
    expect_refused "PROD_DIR on the command line: $t" "/srv/sound-archive"
done
pass "production targets outside /srv/sound-archive: refused, docker never called"

# --- 6. Production: inside (a fake realpath imitates the folder) -------------------
for t in "${PROD_TARGETS[@]}"; do
    run "$PROD_BIN:$BIN" COMPOSE_PROJECT_NAME=sa-dev make "$t"
    expect_project "imitating /srv: $t" sound-archive
done
rm "$COPY/.env"
for t in "${PROD_TARGETS[@]}"; do
    run "$PROD_BIN:$BIN" make "$t"
    expect_refused "imitating /srv, no .env: $t" ".env"
done
pass "production targets: -p sound-archive in the right folder; refused there without .env"

# --- 7. The checker catches a forgotten guard --------------------------------------
"$CHECKER" "$COPY/Makefile" > "$OUT" 2>&1 || fail "the real Makefile does not pass the checker: $(head -n 1 "$OUT")"
grep -q '^OK: ' "$OUT" || fail "the checker did not report OK"

expect_checker_fails() { # label, target name, lines of the rule...
    local label="$1" target="$2"
    shift 2
    cp "$COPY/Makefile" "$WORK/Makefile.bad"
    printf '\n' >> "$WORK/Makefile.bad"
    printf '%b\n' "$@" >> "$WORK/Makefile.bad"
    if "$CHECKER" "$WORK/Makefile.bad" > "$OUT" 2>&1; then
        fail "checker missed: $label"
    fi
    grep -q "make $target " "$OUT" || fail "checker does not name $target ($label): $(head -n 1 "$OUT")"
}
expect_checker_fails 'new target with $(DEV)' oops 'oops: ## forgot the guard' '\t$(DEV) ps'
expect_checker_fails 'new target with $(COMPOSE)' oops 'oops:' '\t$(COMPOSE) ps'
expect_checker_fails 'literal docker compose' oops 'oops:' '\tdocker compose ps'
expect_checker_fails 'on a continuation line' oops 'oops:' '\t@echo a; \\\n\t  $(TAILNET) ps'
expect_checker_fails 'one-line rule' oops 'oops: ; $(DEV) ps'
expect_checker_fails 'a macro built on a macro' oops 'MINE = $(DEV) --profile x' 'oops:' '\t$(MINE) ps'
expect_checker_fails 'production with the wrong guard' oops 'oops: guard-project' '\t$(PROD) ps'
expect_checker_fails 'development with the production guard' oops 'oops: guard-prod' '\t$(DEV) ps'
expect_checker_fails 'guard not first' oops 'oops: need-id guard-project' '\t$(DEV) ps'
pass "the checker catches forgotten, wrong and misplaced guards"

# --- Result -------------------------------------------------------------------------
cat "$LOG" >> "$ALL_CALLS"
if [ -n "${GUARD_TEST_KEEP_LOG:-}" ]; then
    cp "$ALL_CALLS" "$GUARD_TEST_KEEP_LOG"
fi
echo "fake docker calls: $(wc -l < "$ALL_CALLS"); projects: $(grep -o 'compose -p [a-z0-9_-]*' "$ALL_CALLS" | sort | uniq -c | awk '{printf "%s×%s ", $4, $1}')"
if [ "$failures" -ne 0 ]; then
    echo "FAILED: $failures checks" >&2
    exit 1
fi
echo "OK: guard tests passed; only the fake docker ran."
