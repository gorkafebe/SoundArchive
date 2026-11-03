#!/usr/bin/env bash
# make-test-media.sh: fill a folder with SYNTHETIC "recordings" for backup
# rehearsals. Random bytes (head -c from /dev/urandom), no real audio.
#
#   ops/backup/make-test-media.sh <dir> [count] [max-MiB]
#   ops/backup/make-test-media.sh --big <dir> <MiB>     one large file
#
# Random data is the worst case for a backup: it cannot be compressed or
# deduplicated, like real compressed audio (AAC, MP3, FLAC) and close to WAV.
# The files are named like the app might store them (<place>/<uuid>.wav) and
# have fixed sizes from a seeded sequence, so a rerun gives the same layout.
# Refuses any folder under /srv (where the real app lives).

set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
guard() {
    case "$(realpath -m "$1")" in
        /srv|/srv/*) die "refusing to write test media under /srv" ;;
    esac
}

if [ "${1:-}" = --big ]; then
    dir="${2:?folder}"; mib="${3:?size in MiB}"
    guard "$dir"
    mkdir -p "$dir/big"
    head -c "$((mib * 1024 * 1024))" /dev/urandom > "$dir/big/large-recording.wav"
    ls -l "$dir/big/large-recording.wav"
    exit 0
fi

dir="${1:?usage: make-test-media.sh <dir> [count] [max-MiB]}"
count="${2:-20}"
max="${3:-20}"
guard "$dir"
mkdir -p "$dir"
RANDOM=20261103   # fixed seed: same sizes every run
for i in $(seq 1 "$count"); do
    place="place-$(( (i - 1) / 4 + 1 ))"
    mkdir -p "$dir/$place"
    size_kib=$(( (RANDOM % (max * 1024)) + 64 ))
    head -c "$((size_kib * 1024))" /dev/urandom > "$dir/$place/$(printf 'rec-%03d' "$i").wav"
done
find "$dir" -type f | wc -l | xargs printf '%s files, '
du -sh "$dir" | cut -f1
