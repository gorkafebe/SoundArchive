# shellcheck shell=bash
# Shared helpers for backup.sh, restore.sh and restore-test.sh.
# Sourced, not run. Never prints a secret: passwords are passed to restic as
# a file path, and database commands use the container's own variables.

# Pinned image: the same restic version everywhere. Change it on purpose,
# after reading the release notes (the repository format is stable).
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1}"

# Local repositories run restic with no network at all. A remote repository
# (s3:, b2:, sftp:, rest:) needs one: set RESTIC_NETWORK=bridge on purpose.
RESTIC_NETWORK="${RESTIC_NETWORK:-none}"

# restic's cache (speeds up later runs); outside every repository.
RESTIC_CACHE_HOST="${RESTIC_CACHE_HOST:-$HOME/.cache/sound-archive-restic}"

# Projects that the scripts must never restore into or delete.
PROTECTED_PROJECTS="${PROTECTED_PROJECTS:-sound-archive msi-monitor}"

log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
now()  { date +%s; }

# A repository given as a plain path is local; anything with "scheme:" is remote.
repo_is_local() { [[ "$1" == /* ]]; }

# Refuse a password file that is missing, readable by others, or inside a git
# working tree (where a careless `git add` could publish it).
check_password_file() {
    local f="$1" mode
    [ -n "$f" ] || die "missing --password-file (a file containing the restic password)"
    [ -f "$f" ] || die "password file not found: $f"
    mode="$(stat -c '%a' "$f")"
    case "$mode" in
        600|400) ;;
        *) die "password file $f has mode $mode; run: chmod 600 $f" ;;
    esac
    if git -C "$(dirname "$f")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        die "password file $f is inside a git repository; keep it outside"
    fi
}

check_repo_arg() {
    [ -n "$1" ] || die "missing --repo (or RESTIC_REPOSITORY): the backup destination. There is no default, on purpose."
    if repo_is_local "$1"; then
        [ "$RESTIC_NETWORK" = none ] || log "note: local repository with RESTIC_NETWORK=$RESTIC_NETWORK"
    else
        [ "$RESTIC_NETWORK" != none ] || die "remote repository '$1' needs a network: set RESTIC_NETWORK=bridge (not tested in the rehearsal)"
    fi
}

# restic_run REPO PASSWORD_FILE [docker options...] -- restic arguments...
# Runs restic in a throwaway container named sa-bk-restic-<pid>-<n>, as the
# current user, with the repository and the password file mounted. The
# password reaches restic as a file path (RESTIC_PASSWORD_FILE), never as a
# value.
_restic_n=0
restic_run() {
    local repo="$1" pwfile="$2"; shift 2
    local -a dopts=()
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do dopts+=("$1"); shift; done
    [ "${1:-}" = -- ] && shift
    _restic_n=$((_restic_n + 1))
    mkdir -p "$RESTIC_CACHE_HOST"
    local -a repo_opts
    if repo_is_local "$repo"; then
        mkdir -p "$repo"
        repo_opts=(-v "$repo:/repo" -e RESTIC_REPOSITORY=/repo)
    else
        repo_opts=(-e "RESTIC_REPOSITORY=$repo")
        # Credentials for a remote service: a file of KEY=value lines, read by
        # Docker (never by this script). Optional.
        [ -n "${RESTIC_ENV_FILE:-}" ] && repo_opts+=(--env-file "$RESTIC_ENV_FILE")
    fi
    docker run --rm -i \
        --name "sa-bk-restic-$$-$_restic_n" \
        --network "$RESTIC_NETWORK" \
        -u "$(id -u):$(id -g)" \
        "${repo_opts[@]}" \
        -v "$pwfile:/run/secrets/restic-password:ro" \
        -e RESTIC_PASSWORD_FILE=/run/secrets/restic-password \
        -v "$RESTIC_CACHE_HOST:/cache" -e RESTIC_CACHE_DIR=/cache \
        "${dopts[@]}" \
        "$RESTIC_IMAGE" "$@"
}

# ID of the running container of SERVICE in Compose project PROJECT.
service_container() {
    docker ps -q --filter "label=com.docker.compose.project=$1" \
        --filter "label=com.docker.compose.service=$2" | head -1
}

# Run SQL as the database admin inside the db container, using the
# container's own POSTGRES_USER / POSTGRES_DB: no password crosses this
# script. Extra arguments go to psql; the SQL comes on stdin.
psql_admin() {
    local cid="$1"; shift
    docker exec -i "$cid" sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}

is_protected_project() {
    local p
    for p in $PROTECTED_PROJECTS; do [ "$1" = "$p" ] && return 0; done
    return 1
}

# Bytes to a short human form (MiB/GiB), for logs.
human() { numfmt --to=iec-i --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-0} B"; }
