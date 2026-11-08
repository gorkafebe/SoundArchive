#!/usr/bin/env bash
# exposure-check.sh: is anything of the tailnet instance reachable beyond
# this machine's loopback? Read-only.
#
# Docker-published ports bypass ufw, so this script, not the firewall, is what
# guarantees that sa-tailnet stays private. It fails (exit 1) if:
#   1. a container of sa-tailnet, sa-test-* or sa-e2e-* publishes a port on
#      anything other than 127.0.0.1 or ::1;
#   2. a TCP listener outside loopback exists that was not in the baseline
#      taken before this work began (the real app, the panel and SSH are in it).
#
# Exception to rule 2: Tailscale's own peer API picks a random high port bound
# to the tailscale0 interface each time it starts. Those are listed as
# information only: they are tailnet-only and belong to Tailscale.
#
#   EXPOSURE_BASELINE=<file with one address:port per line>

set -uo pipefail

baseline="${EXPOSURE_BASELINE:-$HOME/SoundArchive-Informe/tailnet-2026-11-08/evidencias/paso0-ss-listeners.txt}"
redact="$(dirname "${BASH_SOURCE[0]}")/../lib/redact.sed"
fail=0

show() { sed -E -f "$redact"; }

echo "== Puertos publicados por contenedores propios"
own=$(docker ps --format '{{.Names}}|{{.Ports}}' | grep -E '^(sa-tailnet-|sa-test-|sa-e2e-)' || true)
if [ -z "$own" ]; then
    echo "  (ninguno en marcha)"
fi
while IFS='|' read -r name ports; do
    [ -n "$name" ] || continue
    echo "  $name: ${ports:-sin puertos}"
    # Only "address:port->" entries are published; "8000/tcp" alone is not.
    published=$(printf '%s\n' "$ports" | tr ',' '\n' | grep -- '->' || true)
    while read -r entry; do
        [ -n "$entry" ] || continue
        case "$entry" in
            127.0.0.1:*|'[::1]:'*) ;;
            *) echo "  FALLO: $name publica fuera de loopback: $entry"; fail=1 ;;
        esac
    done <<< "$published"
done <<< "$own"

echo "== Escuchas TCP fuera de loopback, comparadas con la foto inicial"
if [ ! -r "$baseline" ]; then
    echo "  FALLO: no puedo leer la foto inicial: $baseline"
    exit 1
fi
current=$(ss -tlnH | awk '{print $4}' | sort -u)
while read -r addr; do
    [ -n "$addr" ] || continue
    case "$addr" in
        127.*|'[::1]'*) continue ;;
    esac
    if grep -qxF -- "$addr" "$baseline"; then
        echo "  ya existía: $addr" | show
        continue
    fi
    port="${addr##*:}"
    case "$addr" in
        *%tailscale0:*)
            if [ "$port" -ge 32768 ]; then
                echo "  info (API interna de Tailscale, solo tailnet): $addr" | show
                continue
            fi
            ;;
    esac
    echo "  FALLO: escucha nueva fuera de loopback: $addr" | show
    fail=1
done <<< "$current"

if [ "$fail" -eq 0 ]; then
    echo "OK: nada propio publicado fuera de loopback y ninguna escucha nueva."
else
    echo "FALLO: revisa las líneas anteriores."
fi
exit "$fail"
