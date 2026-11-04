#!/usr/bin/env bash
# backup.sh: back up one Sound Archive Compose project with restic.
#
#   ops/backup/backup.sh --repo <repo> --password-file <file> --project <name> \
#       [--media <dir>] [--status-file <file.prom>] [--code-dir <git checkout>] \
#       [--init] [--forget]
#
#   --repo           restic repository: a local path (/mnt/usb/sound-archive-restic)
#                    or a remote one (s3:..., needs RESTIC_NETWORK=bridge).
#                    Also RESTIC_REPOSITORY. NO default: missing = error.
#   --password-file  file holding the restic password (chmod 600, outside
#                    any git repository). Also RESTIC_PASSWORD_FILE. The
#                    script passes the PATH to restic, never the value.
#   --project        Compose project whose `db` container is dumped
#                    (sound-archive for the real app; sa-ops in dev).
#   --media          media folder to include (MEDIA_DIR). Optional while
#                    there is no audio.
#   --status-file    where to write the result for node_exporter's textfile
#                    collector (see docs/BACKUP_AND_RESTORE.md). Default:
#                    ~/.local/state/sound-archive-backup/backup.prom
#   --code-dir       git checkout of the running code, to record its commit
#                    (default: this repository).
#   --init           create the repository if it does not exist yet.
#   --forget         apply the retention policy afterwards (7 daily, 4
#                    weekly, 12 monthly) and prune.
#
# Steps: 1) pg_dump inside the db container (custom format), checked with
# pg_restore --list; 2) a small metadata file (date, commit, alembic
# revision, row count, user NAMES); 3) restic backup of dump + metadata +
# media, in a container with --network none; 4) restic check; 5) status file.
# Exit 0 only if everything succeeded.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/backup/lib.sh
. "$HERE/lib.sh"

repo="${RESTIC_REPOSITORY:-}"
pwfile="${RESTIC_PASSWORD_FILE:-}"
project=""
media=""
status_file="$HOME/.local/state/sound-archive-backup/backup.prom"
code_dir="$(cd "$HERE/../.." && pwd)"
do_init=0
do_forget=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --password-file) pwfile="$2"; shift 2 ;;
        --project) project="$2"; shift 2 ;;
        --media) media="$2"; shift 2 ;;
        --status-file) status_file="$2"; shift 2 ;;
        --code-dir) code_dir="$2"; shift 2 ;;
        --init) do_init=1; shift ;;
        --forget) do_forget=1; shift ;;
        -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

check_repo_arg "$repo"
check_password_file "$pwfile"
[ -n "$project" ] || die "missing --project (the Compose project to back up, e.g. sound-archive)"
if [ -n "$media" ]; then
    [ -d "$media" ] || die "media folder not found: $media"
    media="$(cd "$media" && pwd)"
fi
if repo_is_local "$repo"; then
    # A local repository on a removable disk must really be on that disk.
    # REQUIRE_MOUNTPOINT=/mnt/usb makes the script refuse to write to the
    # internal SSD when the disk is unplugged (the folder would still exist).
    if [ -n "${REQUIRE_MOUNTPOINT:-}" ]; then
        mountpoint -q "$REQUIRE_MOUNTPOINT" || die "$REQUIRE_MOUNTPOINT is not a mounted disk"
    fi
fi

started="$(now)"
host="$(hostname)"
mkdir -p "$(dirname "$status_file")"

# --- status file (always written, also on failure) ---------------------------------
dump_bytes=0
added_bytes=0
snapshot_id=""
write_status() {
    local ok="$1" end prev_ok tmp
    end="$(now)"
    # Keep the time of the last SUCCESS when this run failed.
    prev_ok="$(awk '/^sound_archive_backup_last_success_timestamp_seconds/ {print $2}' "$status_file" 2>/dev/null || true)"
    [ "$ok" = 1 ] && prev_ok="$end"
    tmp="$status_file.tmp.$$"
    {
        echo "# HELP sound_archive_backup_last_run_timestamp_seconds When the last backup run ended (Unix time)."
        echo "# TYPE sound_archive_backup_last_run_timestamp_seconds gauge"
        echo "sound_archive_backup_last_run_timestamp_seconds{project=\"$project\"} $end"
        echo "# HELP sound_archive_backup_last_success_timestamp_seconds When the last SUCCESSFUL backup ended (Unix time)."
        echo "# TYPE sound_archive_backup_last_success_timestamp_seconds gauge"
        echo "sound_archive_backup_last_success_timestamp_seconds{project=\"$project\"} ${prev_ok:-0}"
        echo "# HELP sound_archive_backup_last_result 1 if the last run succeeded (backup and check), 0 if not."
        echo "# TYPE sound_archive_backup_last_result gauge"
        echo "sound_archive_backup_last_result{project=\"$project\"} $ok"
        echo "# HELP sound_archive_backup_duration_seconds Duration of the last run."
        echo "# TYPE sound_archive_backup_duration_seconds gauge"
        echo "sound_archive_backup_duration_seconds{project=\"$project\"} $((end - started))"
        echo "# HELP sound_archive_backup_dump_bytes Size of the database dump."
        echo "# TYPE sound_archive_backup_dump_bytes gauge"
        echo "sound_archive_backup_dump_bytes{project=\"$project\"} $dump_bytes"
        echo "# HELP sound_archive_backup_added_bytes New data the last run added to the repository (after deduplication and compression)."
        echo "# TYPE sound_archive_backup_added_bytes gauge"
        echo "sound_archive_backup_added_bytes{project=\"$project\"} $added_bytes"
    } > "$tmp"
    # Rename = atomic: node_exporter never reads a half-written file.
    mv "$tmp" "$status_file"
}

work="$(mktemp -d -t sa-bk.XXXXXX)"
chmod 700 "$work"
cleanup() {
    local rc=$?
    rm -rf "$work"
    if [ "$rc" -ne 0 ]; then
        write_status 0 || true
        log "backup FAILED (exit $rc); status written to $status_file"
    fi
}
trap cleanup EXIT

# --- 1. database dump ------------------------------------------------------------------
db="$(service_container "$project" db)"
[ -n "$db" ] || die "no running 'db' container in Compose project '$project'"
mkdir -p "$work/db" "$work/meta"
log "1/5 pg_dump inside the db container of '$project'"
t0="$(now)"
# Custom format (-Fc): compressed, restorable with pg_restore. The command
# runs inside the container with its own variables, so no password passes
# through this script.
docker exec "$db" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    > "$work/db/database.dump"
chmod 600 "$work/db/database.dump"
dump_bytes="$(stat -c %s "$work/db/database.dump")"
# A dump that pg_restore cannot list is not a dump.
entries="$(docker exec -i "$db" pg_restore --list < "$work/db/database.dump" | grep -cv '^;')"
log "    dump $(human "$dump_bytes"), $entries entries, $(( $(now) - t0 )) s"

# --- 2. metadata -------------------------------------------------------------------------
revision="$(psql_admin "$db" -Atc 'SELECT version_num FROM alembic_version' 2>/dev/null || echo unknown)"
places="$(psql_admin "$db" -Atc 'SELECT count(*) FROM places' 2>/dev/null || echo unknown)"
# User and database NAMES (not passwords): a restore must use the same names.
names="$(docker exec "$db" sh -c 'echo "POSTGRES_USER=$POSTGRES_USER"; echo "POSTGRES_DB=$POSTGRES_DB"; echo "APP_DB_USER=$APP_DB_USER"')"
commit="$(git -C "$code_dir" rev-parse HEAD 2>/dev/null || echo unknown)"
{
    echo "backup_started_utc=$(date -u -d "@$started" '+%FT%TZ')"
    echo "host=$host"
    echo "project=$project"
    echo "code_commit=$commit"
    echo "alembic_revision=$revision"
    echo "places_rows=$places"
    echo "dump_bytes=$dump_bytes"
    echo "$names"
    echo "postgres_image=$(docker inspect -f '{{.Config.Image}}' "$db")"
    echo "restic_image=$RESTIC_IMAGE"
} > "$work/meta/backup-info.txt"
log "2/5 metadata: commit ${commit:0:7}, alembic $revision, $places places"

# --- 3. restic backup --------------------------------------------------------------------
if [ "$do_init" = 1 ] && repo_is_local "$repo" && [ ! -f "$repo/config" ]; then
    log "    creating a new restic repository at $repo"
    restic_run "$repo" "$pwfile" -- init >&2
fi
mounts=(-v "$work/db:/data/db:ro" -v "$work/meta:/data/meta:ro")
paths=(/data/db /data/meta)
if [ -n "$media" ]; then
    mounts+=(-v "$media:/data/media:ro")
    paths+=(/data/media)
fi
log "3/5 restic backup (${paths[*]})"
t0="$(now)"
# Fixed paths inside the container (/data/...) and an explicit --host keep
# every snapshot comparable with the previous one, so restic only reads and
# stores what changed (incremental).
summary="$(restic_run "$repo" "$pwfile" "${mounts[@]}" -- \
    backup --host "$host" --tag sound-archive --tag "project=$project" --json "${paths[@]}" \
    | grep '"message_type":"summary"')"
read -r snapshot_id added_bytes files_new files_changed total_bytes < <(python3 -c '
import json, sys
s = json.loads(sys.argv[1])
print(s.get("snapshot_id", "")[:8], s.get("data_added", 0), s.get("files_new", 0),
      s.get("files_changed", 0), s.get("total_bytes_processed", 0))' "$summary")
log "    snapshot $snapshot_id: $files_new new files, $files_changed changed, $(human "$total_bytes") read, $(human "$added_bytes") added, $(( $(now) - t0 )) s"

# --- 4. check ----------------------------------------------------------------------------
log "4/5 restic check"
restic_run "$repo" "$pwfile" -- check >&2

if [ "$do_forget" = 1 ]; then
    log "    retention: keep 7 daily, 4 weekly, 12 monthly; prune"
    restic_run "$repo" "$pwfile" -- forget --host "$host" --tag "project=$project" \
        --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune >&2
fi

# --- 5. status ---------------------------------------------------------------------------
write_status 1
log "5/5 OK in $(( $(now) - started )) s; status: $status_file"
echo "$snapshot_id"
