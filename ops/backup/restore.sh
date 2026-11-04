#!/usr/bin/env bash
# restore.sh: restore a restic snapshot into a NEW, EMPTY Compose project.
#
#   ops/backup/restore.sh --repo <repo> --password-file <file> \
#       --project <new project> --env-file <.env for it> \
#       [--media-target <dir>] [--snapshot <id>] [--source-project <name>] \
#       [--compose-override <file>] [--with-web] [--timings <file>]
#
#   --project           the project to create (sa-restore in tests). It must
#                       not exist yet: no containers, no volumes. The real
#                       app's project (sound-archive) is refused unless
#                       ALLOW_PROTECTED=1 (a real disaster recovery on a
#                       freshly installed machine).
#   --env-file          .env for the new project: same user and database
#                       NAMES as the backup (the script checks), passwords
#                       may be new.
#   --media-target      where to put the media files (MEDIA_DIR); must be
#                       empty or missing. Needed if the snapshot has media.
#   --snapshot          restic snapshot ID; default: the latest one of
#                       --source-project (default sound-archive).
#   --compose-override  default ops/backup/compose.restore.yaml (no ports);
#                       compose.prod.yaml for a real recovery.
#   --with-web          also start Caddy (real recovery). Tests skip it.
#   --timings           append "step seconds" lines to this file.
#
# Order (docs/BACKUP_AND_RESTORE.md, section 6): restic restore -> db only
# (its first start creates the limited API user) -> pg_restore as admin ->
# media files -> alembic (migrate) -> api (limited user) -> caddy.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/backup/lib.sh
. "$HERE/lib.sh"
CODE_DIR="$(cd "$HERE/../.." && pwd)"

repo="${RESTIC_REPOSITORY:-}"
pwfile="${RESTIC_PASSWORD_FILE:-}"
project=""
env_file=""
media_target=""
snapshot=""
source_project="sound-archive"
override="$HERE/compose.restore.yaml"
with_web=0
timings=/dev/null

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --password-file) pwfile="$2"; shift 2 ;;
        --project) project="$2"; shift 2 ;;
        --env-file) env_file="$2"; shift 2 ;;
        --media-target) media_target="$2"; shift 2 ;;
        --snapshot) snapshot="$2"; shift 2 ;;
        --source-project) source_project="$2"; shift 2 ;;
        --compose-override) override="$2"; shift 2 ;;
        --with-web) with_web=1; shift ;;
        --timings) timings="$2"; shift 2 ;;
        -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

check_repo_arg "$repo"
check_password_file "$pwfile"
[ -n "$project" ] || die "missing --project (a NEW Compose project name, e.g. sa-restore)"
[ -f "${env_file:-/nonexistent}" ] || die "missing --env-file (the .env for the new project)"
if is_protected_project "$project" && [ "${ALLOW_PROTECTED:-0}" != 1 ]; then
    die "refusing to restore into protected project '$project' (set ALLOW_PROTECTED=1 only for a real recovery on a new machine)"
fi
# "New and empty": no container and no volume of that project may exist.
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] ||
   [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]; then
    die "project '$project' already has containers or volumes; it must be new and empty"
fi
if [ -n "$media_target" ] && [ -d "$media_target" ] && [ -n "$(ls -A "$media_target")" ]; then
    die "media target $media_target is not empty"
fi

dc() {
    COMPOSE_PROJECT_NAME="$project" docker compose -p "$project" --env-file "$env_file" \
        --project-directory "$CODE_DIR" -f "$CODE_DIR/compose.yaml" -f "$override" "$@"
}
step() { echo "$1 $2" >> "$timings"; }

work="$(mktemp -d -t sa-restore.XXXXXX)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
t_all="$(now)"

# --- 1. which snapshot ---------------------------------------------------------------
if [ -z "$snapshot" ]; then
    snapshots_json="$(restic_run "$repo" "$pwfile" -- snapshots --json --latest 1 --tag "project=$source_project")" ||
        die "cannot open the repository $repo (wrong password, or not a restic repository?)"
    snapshot="$(python3 -c 'import json,sys; s=json.loads(sys.argv[1]); print(s[-1]["short_id"] if s else "")' "$snapshots_json")"
    [ -n "$snapshot" ] || die "no snapshot with tag project=$source_project in the repository"
fi
log "1/7 snapshot $snapshot"

# --- 2. restic restore: dump + metadata (+ media) ---------------------------------------
t0="$(now)"
mkdir -p "$work/out"
restic_run "$repo" "$pwfile" -v "$work/out:/out" -- restore "$snapshot:/data" --target /out \
    --include /db --include /meta >&2
[ -f "$work/out/db/database.dump" ] || die "the snapshot has no database dump"
media_in_snapshot="$(restic_run "$repo" "$pwfile" -- ls "$snapshot" /data/media 2>/dev/null | grep -c '^/data/media' || true)"
if [ "${media_in_snapshot:-0}" -gt 0 ]; then
    [ -n "$media_target" ] || die "the snapshot has media files: give --media-target"
    mkdir -p "$media_target"
    restic_run "$repo" "$pwfile" -v "$(cd "$media_target" && pwd):/media" -- \
        restore "$snapshot:/data/media" --target /media >&2
fi
step restic_restore "$(( $(now) - t0 ))"
log "2/7 restic restore: $(( $(now) - t0 )) s (media top-level entries: ${media_in_snapshot:-0})"
cat "$work/out/meta/backup-info.txt" >&2

# The new .env must use the same NAMES as the backup: the dump's GRANTs name
# the limited user. Compare names only (grep never prints a password line).
for var in POSTGRES_USER POSTGRES_DB APP_DB_USER; do
    want="$(grep "^$var=" "$work/out/meta/backup-info.txt" | cut -d= -f2-)"
    have="$(grep "^$var=" "$env_file" | cut -d= -f2-)"
    [ "$want" = "$have" ] || die "$var in $env_file is '$have', the backup used '$want'"
done

# --- 3. database container only ------------------------------------------------------------
t0="$(now)"
dc up -d --wait db >&2
db="$(service_container "$project" db)"
step db_start "$(( $(now) - t0 ))"
log "3/7 db started (init script created the limited user): $(( $(now) - t0 )) s"

# --- 4. pg_restore -----------------------------------------------------------------------
# The postgis image already created its extensions (postgis, postgis_topology,
# fuzzystrmatch, postgis_tiger_geocoder) with their own schemas and reference
# data (spatial_ref_sys, tiger.*, topology.*). Restoring those entries again
# would fail ("schema already exists", duplicate keys), so they are left out
# of the restore list. Everything of the app (public tables, data, indexes,
# GRANTs, default privileges) is restored.
t0="$(now)"
docker exec -i "$db" pg_restore --list < "$work/out/db/database.dump" |
    grep -vE ' (SCHEMA - (tiger|topology)|COMMENT - SCHEMA (tiger|topology)|EXTENSION - |COMMENT - EXTENSION |TABLE DATA (public spatial_ref_sys|tiger |topology )|SEQUENCE SET topology )' \
    > "$work/restore.list"
docker cp "$work/restore.list" "$db:/tmp/restore.list" >/dev/null
docker exec -i "$db" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error -L /tmp/restore.list' \
    < "$work/out/db/database.dump"
docker exec "$db" rm -f /tmp/restore.list
step pg_restore "$(( $(now) - t0 ))"
log "4/7 pg_restore: $(( $(now) - t0 )) s"

# --- 5. media (already restored in step 2, before the API starts) -------------------------
log "5/7 media: ${media_target:-none}"

# --- 6. migrations -----------------------------------------------------------------------------
t0="$(now)"
log "6/7 alembic current (before upgrade): $(dc run --rm --no-deps migrate alembic current 2>/dev/null | tail -1)"
dc run --rm --no-deps migrate >&2
step migrate "$(( $(now) - t0 ))"

# --- 7. api (and web) ----------------------------------------------------------------------------
t0="$(now)"
if [ "$with_web" = 1 ]; then
    dc up -d --wait >&2
else
    dc up -d --wait --no-deps api >&2
fi
step api_start "$(( $(now) - t0 ))"
step total "$(( $(now) - t_all ))"
log "7/7 api up: $(( $(now) - t0 )) s. Total restore: $(( $(now) - t_all )) s"
