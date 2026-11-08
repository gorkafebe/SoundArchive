#!/usr/bin/env bash
# restore-rehearsal.sh: prove the last backup can be restored, then destroy the copy.
#
#   ops/tailnet/restore-rehearsal.sh --repo <repo> --password-file <file> \
#       --source <project backed up> [--keep]
#
# Restores into the throwaway project sa-test-restore with ops/backup/restore.sh
# (no published ports), loads the media into its volume, and checks:
#   1. the same number of rows in every table as the source;
#   2. the same SHA-256 for every media file;
#   3. a restored recording is served and its original matches its fingerprint.
# Compare right after a backup: later changes to the source show as differences.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

repo="" ; pwfile="" ; source="" ; keep=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --password-file) pwfile="$2"; shift 2 ;;
        --source) source="$2"; shift 2 ;;
        --keep) keep=1; shift ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
done
target=sa-test-restore
dc() { COMPOSE_PROJECT_NAME=$target docker compose -p $target --env-file "$ROOT/.env" --project-directory "$ROOT" -f "$ROOT/compose.yaml" -f "$ROOT/ops/backup/compose.restore.yaml" "$@"; }

media="$(mktemp -d "$HOME/sa-restore-media.XXXXXX")"
cleanup() {
    chmod -R u+rwX "$media" 2>/dev/null || true
    rm -rf "$media"
    if [ "$keep" = 0 ]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

COMPOSE_PROJECT_NAME=$target "$ROOT/ops/backup/restore.sh" --repo "$repo" --password-file "$pwfile" \
    --project $target --env-file "$ROOT/.env" --media-target "$media" --source-project "$source"

docker run --rm --name sa-e2e-load-media -v "$media:/in:ro" -v "${target}_media:/media" busybox:1.37.0 \
    sh -c 'cp -a /in/. /media/ && chown -R 10001:10001 /media'
dc up -d --wait --no-deps redis

fail=0
tables="users invitations sessions audit_log places recordings place_photos reports"
count() { docker exec "$1-db-1" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc 'SELECT count(*) FROM $2'"; }
echo "== Filas por tabla (origen / restaurado)"
for table in $tables; do
    a="$(count "$source" "$table")"; b="$(count "$target" "$table")"
    echo "  $table: $a / $b"
    [ "$a" = "$b" ] || fail=1
done

echo "== Huellas de los archivos"
sums() { docker run --rm --name "sa-e2e-sums-$$" -v "$1_media:/media:ro" busybox:1.37.0 sh -c 'cd /media && find . -type f ! -path "./tmp/*" | sort | xargs -r sha256sum'; }
a="$(sums "$source")"; b="$(sums "$target")"
echo "  archivos: $(printf '%s\n' "$a" | wc -l) / $(printf '%s\n' "$b" | wc -l)"
if [ "$a" = "$b" ]; then echo "  todas las huellas coinciden"; else echo "  FALLO: las huellas no coinciden"; fail=1; fi

echo "== Escuchar una grabación restaurada"
export USERNAME=restore-check
PASSWORD="$(openssl rand -hex 16)"
export PASSWORD
api="$target-api-1"
printf '%s\n' "$PASSWORD" | docker exec -i "$api" python -m app.cli admin-create --username "$USERNAME" >/dev/null
docker exec -i -e USERNAME -e PASSWORD "$api" python - < "$HERE/restore_check.py" || fail=1

if [ "$fail" != 0 ]; then
    echo "RESULTADO: FALLO"
    exit 1
fi
echo "RESULTADO: restauración correcta"
