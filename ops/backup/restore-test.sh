#!/usr/bin/env bash
# restore-test.sh: prove the latest backup can be restored, then destroy it.
#
#   ops/backup/restore-test.sh --repo <repo> --password-file <file> \
#       --source-project <name> [--source-url <url>] [--media <dir>] [--keep]
#
#   --source-project  the project that was backed up (sa-ops in dev). Its
#                     running stack is the reference the restore is compared with.
#   --source-url      that stack's web address, for the API comparison
#                     (default http://127.0.0.1:8080, the dev stack).
#   --media           the original media folder, to compare SHA-256 sums.
#   --keep            do not destroy sa-restore at the end (to look around;
#                     then: docker compose -p sa-restore down -v).
#
# Restores into the throwaway project sa-restore (restore.sh, no ports
# published), then checks:
#   1. same number of rows in places;
#   2. the API returns the same places (/api/places, whole world, and the
#      /api/places/list total);
#   3. alembic current = the revision recorded in the backup, at head;
#   4. the API connects as the LIMITED user, which can read and write rows
#      but cannot alter or drop the table, and is not a superuser;
#   5. SHA-256 of every restored media file equals the original.
# Always destroys sa-restore (containers, network, volumes, its images) and
# its temporary files at the end, even if a check failed.
#
# Compare with the source right after a backup: if the source changes in
# between, check 1 and 2 report the difference (which is correct).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/backup/lib.sh
. "$HERE/lib.sh"
CODE_DIR="$(cd "$HERE/../.." && pwd)"

repo="${RESTIC_REPOSITORY:-}"
pwfile="${RESTIC_PASSWORD_FILE:-}"
source_project=""
source_url="http://127.0.0.1:8080"
media=""
keep=0
TARGET=sa-restore

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --password-file) pwfile="$2"; shift 2 ;;
        --source-project) source_project="$2"; shift 2 ;;
        --source-url) source_url="$2"; shift 2 ;;
        --media) media="$2"; shift 2 ;;
        --keep) keep=1; shift ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done
check_repo_arg "$repo"
check_password_file "$pwfile"
[ -n "$source_project" ] || die "missing --source-project (the project that was backed up)"
src_db="$(service_container "$source_project" db)"
[ -n "$src_db" ] || die "the source project '$source_project' has no running db container"

work="$(mktemp -d -t sa-restore-test.XXXXXX)"
chmod 700 "$work"
dc() {
    COMPOSE_PROJECT_NAME="$TARGET" docker compose -p "$TARGET" --env-file "$work/env" \
        --project-directory "$CODE_DIR" -f "$CODE_DIR/compose.yaml" -f "$HERE/compose.restore.yaml" "$@"
}
teardown() {
    local rc=$?
    if [ "$keep" = 1 ]; then
        log "--keep: $TARGET left running; remove it with: docker compose -p $TARGET down -v"
    else
        log "teardown: removing $TARGET (containers, network, volumes, images)"
        if [ -f "$work/env" ]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
        docker image rm "$TARGET-backend:prod" "$TARGET-web:prod" >/dev/null 2>&1 || true
    fi
    rm -rf "$work"
    exit "$rc"
}
trap teardown EXIT

# --- throwaway .env for sa-restore ------------------------------------------------------
# Same user and database NAMES as the source (read from its db container:
# names only), new random passwords that nobody sees.
read -r a_user a_db app_user < <(docker exec "$src_db" sh -c 'echo "$POSTGRES_USER $POSTGRES_DB $APP_DB_USER"')
umask 077
{
    echo "POSTGRES_USER=$a_user"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "POSTGRES_DB=$a_db"
    echo "APP_DB_USER=$app_user"
    echo "APP_DB_PASSWORD=$(openssl rand -hex 24)"
} > "$work/env"
umask 022

# --- restore -------------------------------------------------------------------------------
log "restore into $TARGET"
media_args=()
[ -n "$media" ] && media_args=(--media-target "$work/media")
"$HERE/restore.sh" --repo "$repo" --password-file "$pwfile" --project "$TARGET" \
    --env-file "$work/env" --source-project "$source_project" --timings "$work/timings" "${media_args[@]}"
dst_db="$(service_container "$TARGET" db)"
dst_api="$(service_container "$TARGET" api)"

fails=0
pass() { printf '✔ %s\n' "$*"; }
fail() { printf '✘ %s\n' "$*"; fails=$((fails + 1)); }

echo
echo "== restore-test checks ($(date -u '+%F %T') UTC)"

# 1. rows
src_rows="$(psql_admin "$src_db" -Atc 'SELECT count(*) FROM places')"
dst_rows="$(psql_admin "$dst_db" -Atc 'SELECT count(*) FROM places')"
if [ "$src_rows" = "$dst_rows" ]; then pass "1 rows in places: source $src_rows, restored $dst_rows"
else fail "1 rows in places: source $src_rows, restored $dst_rows"; fi

# 2. API. The same query on both, the whole world. The features are sorted by
# id before hashing: places created in one transaction share created_at, so
# the order of ties is not guaranteed.
api_get() { docker exec "$dst_api" python -c 'import sys, urllib.request; sys.stdout.write(urllib.request.urlopen("http://127.0.0.1:8000" + sys.argv[1], timeout=10).read().decode())' "$1"; }
norm='import json, sys, hashlib
d = json.load(sys.stdin)
if "features" in d:
    d["features"].sort(key=lambda f: f["id"])
print(len(d.get("features", [])), d.get("total", "-"), hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:16])'
q='/api/places?bbox=-180,-90,180,90&limit=5000'
src_api="$(curl -s -m 10 "$source_url$q" | python3 -c "$norm")"
dst_api_out="$(api_get "$q" | python3 -c "$norm")"
if [ "$src_api" = "$dst_api_out" ]; then pass "2 /api/places (features, -, sha256): source [$src_api] = restored [$dst_api_out]"
else fail "2 /api/places: source [$src_api] restored [$dst_api_out]"; fi
src_list="$(curl -s -m 10 "$source_url/api/places/list?limit=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')"
dst_list="$(api_get '/api/places/list?limit=1' | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')"
if [ "$src_list" = "$dst_list" ]; then pass "2 /api/places/list total: source $src_list, restored $dst_list"
else fail "2 /api/places/list total: source $src_list, restored $dst_list"; fi

# 3. alembic
src_rev="$(psql_admin "$src_db" -Atc 'SELECT version_num FROM alembic_version')"
cur="$(dc run --rm --no-deps migrate alembic current 2>/dev/null | tail -1)"
if [[ "$cur" == "$src_rev (head)"* ]]; then pass "3 alembic current: '$cur' (source $src_rev)"
else fail "3 alembic current: '$cur' (source $src_rev)"; fi

# 4. the limited user. Which user does the API use? Its open pooled
# connection (made by the requests above) shows in pg_stat_activity.
api_user="$(psql_admin "$dst_db" -Atc "SELECT string_agg(DISTINCT usename, ',') FROM pg_stat_activity WHERE datname = current_database() AND client_addr IS NOT NULL")"
super="$(psql_admin "$dst_db" -Atc "SELECT rolsuper FROM pg_roles WHERE rolname = '$app_user'")"
owner="$(psql_admin "$dst_db" -Atc "SELECT tableowner FROM pg_tables WHERE tablename = 'places'")"
if [ "$api_user" = "$app_user" ] && [ "$super" = f ] && [ "$owner" = "$a_user" ]; then
    pass "4 API connects as '$api_user' (superuser: $super); places owned by '$owner'"
else
    fail "4 API connects as '$api_user' (expected $app_user), superuser $super, owner $owner"
fi
# As the limited user, inside the db container with ITS variables (the
# password goes from the container's environment to psql, never through here).
as_app() {
    docker exec -i "$dst_db" sh -c 'PGPASSWORD="$APP_DB_PASSWORD" psql -X -q -h 127.0.0.1 -U "$APP_DB_USER" -d "$POSTGRES_DB" -At "$@"' psql "$@"
}
rw="$(as_app -v ON_ERROR_STOP=1 <<'SQL' 2>&1
BEGIN;
SELECT count(*) FROM places;
INSERT INTO places (name, location) VALUES ('restore-test', 'SRID=4326;POINT(0 0)'::geography) RETURNING 'insert ok';
UPDATE places SET description = 'x' WHERE name = 'restore-test' RETURNING 'update ok';
DELETE FROM places WHERE name = 'restore-test' RETURNING 'delete ok';
ROLLBACK;
SQL
)"
if [[ "$rw" == *"insert ok"*"update ok"*"delete ok"* ]]; then pass "4 limited user reads ($(head -1 <<< "$rw") rows) and writes (insert, update, delete; rolled back)"
else fail "4 limited user read/write: $(tr '\n' ' ' <<< "$rw")"; fi
for sql in 'ALTER TABLE places ADD COLUMN restore_test integer' 'DROP TABLE places' 'TRUNCATE places' 'CREATE TABLE restore_test (id int)'; do
    out="$(as_app -c "$sql" 2>&1 || true)"
    if [[ "$out" == *"must be owner"* || "$out" == *"permission denied"* ]]; then
        pass "4 limited user cannot: $sql ($(grep -o 'ERROR: .*' <<< "$out" | head -1))"
    else
        fail "4 limited user COULD: $sql ($out)"
    fi
done

# 5. media checksums
if [ -n "$media" ]; then
    (cd "$media" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$work/sha-src"
    (cd "$work/media" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$work/sha-dst"
    n="$(wc -l < "$work/sha-src")"
    if [ "$n" -gt 0 ] && cmp -s "$work/sha-src" "$work/sha-dst"; then
        pass "5 SHA-256 of $n media files: identical ($(du -sh "$work/media" | cut -f1) restored)"
    else
        fail "5 SHA-256 media: $n source files, $(wc -l < "$work/sha-dst") restored; differences: $(diff "$work/sha-src" "$work/sha-dst" | grep -c '^[<>]')"
    fi
else
    echo "· 5 media: no --media given, skipped"
fi

echo
echo "== restore times (seconds)"
cat "$work/timings"
echo
if [ "$fails" -eq 0 ]; then echo "RESTORE TEST PASSED"; else echo "RESTORE TEST FAILED: $fails check(s)"; fi
[ "$fails" -eq 0 ]
