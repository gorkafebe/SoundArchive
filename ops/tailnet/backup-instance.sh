#!/usr/bin/env bash
# backup-instance.sh: back up a stack whose media is a Docker volume.
#
#   ops/tailnet/backup-instance.sh --repo <repo> --password-file <file> \
#       --project sa-tailnet [--init]
#
# It reuses ops/backup/backup.sh, which needs the media as a folder it can
# read. The files in the volume belong to the app's user (uid 10001), so they
# are first copied to a temporary folder, owned by you. That needs free space
# for one extra copy of the media while it runs.
#
# Order matters for consistency: the database is dumped by backup.sh after
# the copy, so every file a row points to is already in the backup. A file
# added between the two steps is just not referenced yet.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

args=("$@")
project=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --project) project="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -n "$project" ] || { echo "missing --project" >&2; exit 1; }

staging="$(mktemp -d "${TMPDIR:-$HOME}/sa-media-staging.XXXXXX")"
cleanup() {
    # Read-only files inside: make them removable first.
    chmod -R u+rwX "$staging" 2>/dev/null || true
    rm -rf "$staging"
}
trap cleanup EXIT

docker run --rm --name "sa-e2e-staging-$$" -v "${project}_media:/media:ro" -v "$staging:/out" \
    busybox:1.37.0 sh -c "cp -a /media/. /out/ && rm -rf /out/tmp && chown -R $(id -u):$(id -g) /out"

"$HERE/../backup/backup.sh" "${args[@]}" --media "$staging"
