#!/usr/bin/env bash
# secret-scan.sh <dir>...: look for things that should never be in documents
# or in the repository. Prints only the file and line number of a match, so
# running it does not repeat the secret on the screen.
#
# Checks: private keys, tokens, assignments of real-looking passwords, e-mail
# addresses (except the noreply form), Tailscale and public IP addresses,
# *.ts.net names.

set -uo pipefail
found=0
EXCLUDE=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=test-results
         --exclude-dir=bundles --exclude-dir=capturas --exclude-dir=evidencias --exclude-dir=referencia
         --exclude=package-lock.json --exclude=uv.lock --exclude=.env --exclude='*.pdf' --exclude='*.png'
         --exclude='*.aux' --exclude='*.log' --exclude='*.toc' --exclude='*.fls' --exclude='*.fdb_latexmk'
         --exclude=secret-scan.sh --exclude=redact.sed)

check() {
    local name="$1" pattern="$2"
    shift 2
    local hits
    hits="$(grep -rInE "${EXCLUDE[@]}" -o "$pattern" "$@" 2>/dev/null \
        | grep -vE 'noreply@|@(users\.noreply\.github|example\.|anthropic\.com)' | cut -d: -f1,2 | sort -u)"
    if [ -n "$hits" ]; then
        echo "POSIBLE $name:"
        printf '%s\n' "$hits" | sed 's/^/  /'
        found=1
    else
        echo "ok: $name"
    fi
}

check "clave privada" '-----BEGIN [A-Z ]*PRIVATE KEY' "$@"
check "token conocido" '(ghp_[A-Za-z0-9]{20,}|tskey-[A-Za-z0-9-]{10,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|sk-ant-[A-Za-z0-9-]{10,})' "$@"
check "contraseña asignada" '(POSTGRES_PASSWORD|APP_DB_PASSWORD|REDIS_PASSWORD)=[A-Za-z0-9/+]{16,}' "$@"
check "correo" '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}' "$@"
check "IP de Tailscale" '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b' "$@"
check "nombre de tailnet" '\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b' "$@"
check "IPv6 global" '\b2[0-9a-f]{3}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f:]+\b' "$@"

[ "$found" = 0 ] && echo "RESULTADO: limpio" || echo "RESULTADO: revisar las coincidencias"
exit "$found"
