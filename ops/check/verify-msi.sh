#!/usr/bin/env bash
# verify-msi.sh: is the MSI server healthy? A read-only checklist.
#
# Run it after a reboot, a cold boot, a power cut or any change, and compare
# with the previous run. It changes nothing, needs no sudo and prints no
# secrets: no environment variables, no `docker compose config`, and every
# line goes through ops/lib/redact.sed (addresses, MACs, tailnet name).
#
#   ops/check/verify-msi.sh            or   make msi-check
#
# Each line is one check:
#   ✔  as expected          ✘  not as expected (the script exits with 1)
#   !  worth a look, not a failure
#   ·  information only     OMITIDO  needs sudo: the exact command is printed
#
# Expected values can be changed with environment variables (defaults below),
# e.g. EXPOSED_TCP_PORTS="22 80 443 8443" ops/check/verify-msi.sh
#   PROD_PROJECT        Compose project of the real app   (sound-archive)
#   MONITOR_PROJECT     Compose project of the panel      (msi-monitor)
#   EXPOSED_TCP_PORTS   TCP ports allowed on every interface (22 80 443)
#   EXPOSED_UDP_PORTS   UDP ports allowed on every interface
#                       (443 = HTTP/3, 41641 = Tailscale's WireGuard,
#                        68 and 546 = the DHCP clients)
#   MIN_FREE_GB         free space on / below which it fails (50)
#   CPU_WARN_C          CPU package temperature for "!" (85)
#   NVME_WARN_C         NVMe temperature for "!" (70)
#   BAT_START/BAT_END   expected charge thresholds (50 / 60)
#   PROD_URL            the real app, seen from the MSI (http://127.0.0.1)
#   MONITOR_URL         optional: the panel's Tailscale HTTPS address
#                       (https://<name>.<tailnet>.ts.net:8443). Checked only
#                       if set; never stored in a file.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REDACT="$HERE/../lib/redact.sed"

PROD_PROJECT="${PROD_PROJECT:-sound-archive}"
MONITOR_PROJECT="${MONITOR_PROJECT:-msi-monitor}"
EXPOSED_TCP_PORTS="${EXPOSED_TCP_PORTS:-22 80 443}"
EXPOSED_UDP_PORTS="${EXPOSED_UDP_PORTS:-443 41641 68 546}"
MIN_FREE_GB="${MIN_FREE_GB:-50}"
CPU_WARN_C="${CPU_WARN_C:-85}"
NVME_WARN_C="${NVME_WARN_C:-70}"
BAT_START="${BAT_START:-50}"
BAT_END="${BAT_END:-60}"
PROD_URL="${PROD_URL:-http://127.0.0.1}"
MONITOR_URL="${MONITOR_URL:-}"

BAT=/sys/class/power_supply/BAT1
ADP=/sys/class/power_supply/ADP1
GPU=/sys/bus/pci/devices/0000:01:00.0

FAILS=0
WARNS=0

# One output line: mark, check name, detail.
line() { printf '%-8s %-44s %s\n' "$1" "$2" "$3"; }
ok()   { line '✔' "$1" "$2"; }
ko()   { line '✘' "$1" "$2"; FAILS=$((FAILS + 1)); }
warn() { line '!' "$1" "$2"; WARNS=$((WARNS + 1)); }
info() { line '·' "$1" "$2"; }
skip() { line 'OMITIDO' "$1" "(necesita sudo): ejecuta $2"; }
section() { printf '\n== %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Read a sysfs file, or print "-" if it is missing or unreadable.
read_file() { cat "$1" 2>/dev/null || echo '-'; }

# HTTP status code of a URL (000 = no answer), with a short timeout.
http_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }

# --- Containers ----------------------------------------------------------------

# Check that every container of a Compose project is running and healthy.
# Reads the state with a Go template that names only the fields it needs, so
# no environment variable (password) is ever printed.
check_project() {
    local project="$1" label="$2" names name state
    names="$(docker ps -a --filter "label=com.docker.compose.project=$project" \
        --format '{{.Names}}' 2>/dev/null | sort)"
    if [ -z "$names" ]; then
        ko "$label: contenedores" "no hay ninguno del proyecto '$project'"
        return
    fi
    while IFS= read -r name; do
        state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} {{.RestartCount}} {{.State.ExitCode}}' "$name" 2>/dev/null)"
        # shellcheck disable=SC2086  # split the four fields on purpose
        set -- $state
        local status="${1:-?}" health="${2:-?}" restarts="${3:-?}" exitcode="${4:-?}"
        if [ "$status" = running ] && [ "$health" = healthy ]; then
            ok "$label: $name" "running, healthy, reinicios $restarts"
        elif [ "$status" = exited ] && [ "$exitcode" = 0 ] && [[ "$name" == *migrate* ]]; then
            # The migrate service is a one-shot job: exited with 0 is success.
            ok "$label: $name" "trabajo de una vez, terminó con código 0"
        else
            ko "$label: $name" "estado $status, salud $health, reinicios $restarts"
        fi
    done <<< "$names"
}

check_containers() {
    section "Contenedores"
    if ! have docker || ! docker info >/dev/null 2>&1; then
        ko "Docker" "no responde (¿está en marcha? systemctl is-active docker)"
        return
    fi
    check_project "$PROD_PROJECT" "producción"
    check_project "$MONITOR_PROJECT" "panel"

    # Published ports. Only the production Caddy may publish on all
    # interfaces; anything else may only publish on 127.0.0.1.
    local name ports bad=""
    while IFS=$'\t' read -r name ports; do
        [ -z "$ports" ] && continue
        # Keep only the published parts ("addr:port->port/proto").
        local p
        for p in $(printf '%s' "$ports" | tr ',' '\n' | grep -- '->' | tr -d ' '); do
            case "$p" in
                127.0.0.1:*) ;;  # loopback only: fine
                *) [ "$name" = "$PROD_PROJECT-caddy-1" ] || bad="$bad $name($p)" ;;
            esac
        done
    done < <(docker ps --format '{{.Names}}\t{{.Ports}}')
    if [ -z "$bad" ]; then
        ok "Puertos publicados por Docker" "solo $PROD_PROJECT-caddy-1 fuera de 127.0.0.1"
    else
        ko "Puertos publicados por Docker" "también publican:$bad"
    fi
}

# --- HTTP ------------------------------------------------------------------------

check_http() {
    section "Aplicación y panel (HTTP desde el propio MSI)"
    local code
    local path
    for path in /api/health /api/health/db; do
        code="$(http_code "$PROD_URL$path")"
        if [ "$code" = 200 ]; then ok "App: $path" "HTTP $code"; else ko "App: $path" "HTTP $code"; fi
    done

    local body
    body="$(curl -s -m 5 http://127.0.0.1:3000/api/health 2>/dev/null | tr -d ' \n')"
    if [[ "$body" == *'"database":"ok"'* ]]; then
        ok "Grafana: 127.0.0.1:3000/api/health" "database ok"
    else
        ko "Grafana: 127.0.0.1:3000/api/health" "respuesta: ${body:-ninguna}"
    fi
    body="$(curl -s -m 5 http://127.0.0.1:9090/-/healthy 2>/dev/null)"
    if [[ "$body" == *Healthy* ]]; then
        ok "Prometheus: 127.0.0.1:9090/-/healthy" "Healthy"
    else
        ko "Prometheus: 127.0.0.1:9090/-/healthy" "respuesta: ${body:-ninguna}"
    fi

    if [ -n "$MONITOR_URL" ]; then
        case "$MONITOR_URL" in
            https://*) ;;
            *) ko "MONITOR_URL" "debe empezar por https://"; return ;;
        esac
        # Grafana answers 302 (to /login) or 200; anything else is a problem.
        code="$(http_code "$MONITOR_URL/api/health")"
        case "$code" in
            200) ok "Panel por Tailscale (MONITOR_URL)" "HTTP $code" ;;
            *)   ko "Panel por Tailscale (MONITOR_URL)" "HTTP $code" ;;
        esac
    else
        info "Panel por Tailscale (MONITOR_URL)" "no definida: omitida"
    fi
}

# --- Listening sockets -------------------------------------------------------------

# ss prints "address:port"; the address may be [v6], may carry %interface.
# Classifies every listener as loopback, Tailscale-only or exposed.
check_listeners() {
    section "Qué escucha en la red"
    local proto allowed local_addr addr port exposed tailnet bad
    for proto in tcp udp; do
        if [ "$proto" = tcp ]; then allowed=" $EXPOSED_TCP_PORTS "; else allowed=" $EXPOSED_UDP_PORTS "; fi
        exposed=""; tailnet=""; bad=""
        while read -r local_addr; do
            port="${local_addr##*:}"
            addr="${local_addr%:*}"
            case "$addr" in
                127.*|'[::1]'|'[::ffff:127.'*) continue ;;          # loopback
                *%lo) continue ;;                                     # loopback interface
                # Tailscale only: bound to its interface, or to an address of
                # its ranges (100.64.0.0/10, fd7a:115c:a1e0::/48), as a
                # "tailscale serve" listener may be.
                *%tailscale0|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|'[fd7a:115c:a1e0:'*)
                    tailnet="$tailnet $port"; continue ;;
            esac
            exposed="$exposed $port"
            [[ "$allowed" == *" $port "* ]] || bad="$bad $addr:$port"
        done < <(if [ "$proto" = tcp ]; then ss -Htln; else ss -Huln; fi 2>/dev/null | awk '{print $4}')
        exposed="$(tr ' ' '\n' <<< "$exposed" | grep . | sort -nu | tr '\n' ' ')"
        if [ -z "$bad" ]; then
            ok "${proto^^}: fuera de 127.0.0.1" "solo ${exposed:-nada} (permitidos:${allowed% })"
        else
            ko "${proto^^}: fuera de 127.0.0.1" "inesperados:$bad"
        fi
        [ -n "$tailnet" ] && info "${proto^^}: solo en tailscale0" "puertos$tailnet (tailscaled)"
    done

    # The panel must stay on loopback: Tailscale serve reaches it there.
    local p where
    for p in 3000 9090 9100; do
        where="$(ss -Htln "sport = :$p" 2>/dev/null | awk '{print $4}' | sed 's/:[0-9]*$//' | sort -u | tr '\n' ' ')"
        if [ -z "$where" ]; then
            ko "Puerto $p (panel)" "nada escucha"
        elif [ "$where" = "127.0.0.1 " ]; then
            ok "Puerto $p (panel)" "solo 127.0.0.1"
        else
            ko "Puerto $p (panel)" "escucha en: $where"
        fi
    done
}

# --- Tailscale ---------------------------------------------------------------------

check_tailscale() {
    section "Tailscale"
    if systemctl is-active --quiet tailscaled; then
        ok "tailscaled" "active"
    else
        ko "tailscaled" "$(systemctl is-active tailscaled 2>&1)"
    fi
    if ! have tailscale; then
        ko "tailscale (orden)" "no instalada"
        return
    fi
    local state
    state="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState","?"))' 2>/dev/null)"
    if [ "$state" = Running ]; then
        ok "Tailscale conectado" "BackendState Running"
    else
        ko "Tailscale conectado" "BackendState ${state:-?}"
    fi

    # serve/funnel status: readable without sudo on 1.104; if a version asks
    # for permissions, print the command instead.
    local out
    if out="$(tailscale funnel status 2>&1)"; then
        if [[ "$out" == *"No serve config"* ]] || ! grep -qi 'funnel on' <<< "$out"; then
            ok "tailscale funnel" "nada publicado en Internet"
        else
            ko "tailscale funnel" "¡hay algo publicado en Internet! (tailscale funnel status)"
        fi
    else
        skip "tailscale funnel status" "sudo tailscale funnel status"
    fi
    if out="$(tailscale serve status 2>&1)"; then
        if [[ "$out" == *"No serve config"* ]]; then
            info "tailscale serve" "sin configuración"
        else
            info "tailscale serve" "$(grep -E 'https://|proxy' <<< "$out" | tr -s ' ' | tr '\n' ';')"
        fi
    else
        skip "tailscale serve status" "sudo tailscale serve status"
    fi
}

# --- Battery and power -------------------------------------------------------------

check_power() {
    section "Batería y energía"
    local start end
    start="$(read_file "$BAT/charge_control_start_threshold")"
    end="$(read_file "$BAT/charge_control_end_threshold")"
    if [ "$start" = "$BAT_START" ] && [ "$end" = "$BAT_END" ]; then
        ok "Umbrales de carga" "inicio $start, fin $end"
    else
        ko "Umbrales de carga" "inicio $start, fin $end (esperado $BAT_START y $BAT_END; ¿msi-ec cargado?)"
    fi
    info "Batería" "$(read_file "$BAT/status"), $(read_file "$BAT/capacity") %"
    local full design
    full="$(read_file "$BAT/charge_full")"; design="$(read_file "$BAT/charge_full_design")"
    if [ "$full" != - ] && [ "$design" != - ] && [ "$design" -gt 0 ] 2>/dev/null; then
        info "Salud de la batería" "$((full * 100 / design)) % de la capacidad de diseño"
    fi
    if [ "$(read_file "$ADP/online")" = 1 ]; then
        ok "Cargador" "conectado (ADP1 online)"
    else
        warn "Cargador" "DESCONECTADO: funcionando con batería"
    fi

    local en act
    en="$(systemctl is-enabled battery-charge-limit.service 2>/dev/null)"
    act="$(systemctl is-active battery-charge-limit.service 2>/dev/null)"
    if [ "$en" = enabled ] && [ "$act" = active ]; then
        ok "battery-charge-limit.service" "enabled, active"
    else
        ko "battery-charge-limit.service" "is-enabled: ${en:-no existe}; is-active: ${act:-?}"
    fi

    if lsmod 2>/dev/null | grep -q '^msi_ec '; then
        ok "Módulo msi_ec" "cargado; firmware $(read_file /sys/devices/platform/msi-ec/fw_version)"
    else
        ko "Módulo msi_ec" "no cargado (mira dkms status)"
    fi
    local dk
    dk="$(dkms status 2>/dev/null | grep "$(uname -r)")"
    if [[ "$dk" == *installed* ]]; then
        ok "DKMS para el kernel $(uname -r)" "$dk"
    else
        ko "DKMS para el kernel $(uname -r)" "${dk:-msi_ec no está compilado para este kernel}"
    fi

    # Read the GPU state before anything (like lspci) wakes it up.
    info "GPU NVIDIA (01:00.0)" "$(read_file "$GPU/power/runtime_status"), $(read_file "$GPU/power_state"), control $(read_file "$GPU/power/control")"
}

# --- System --------------------------------------------------------------------------

check_system() {
    section "Sistema"
    local free_gb
    free_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
    if [ "${free_gb:-0}" -ge "$MIN_FREE_GB" ]; then
        ok "Espacio libre en /" "${free_gb} GB (mínimo $MIN_FREE_GB)"
    else
        ko "Espacio libre en /" "${free_gb} GB (mínimo $MIN_FREE_GB)"
    fi

    local cpu nvme
    # Package temperature: coretemp's temp1. NVMe: the Composite sensor.
    cpu="$(sensors 2>/dev/null | awk '/^Package id 0:/ {gsub(/[+°C]/, "", $4); print int($4); exit}')"
    nvme="$(sensors 2>/dev/null | awk '/^Composite:/ {gsub(/[+°C]/, "", $2); print int($2); exit}')"
    if [ -z "$cpu" ]; then
        warn "Temperatura CPU" "sin lectura (¿lm-sensors?)"
    elif [ "$cpu" -lt "$CPU_WARN_C" ]; then
        ok "Temperatura CPU (Package id 0)" "$cpu °C (aviso desde $CPU_WARN_C)"
    else
        warn "Temperatura CPU (Package id 0)" "$cpu °C (aviso desde $CPU_WARN_C)"
    fi
    if [ -z "$nvme" ]; then
        warn "Temperatura NVMe" "sin lectura"
    elif [ "$nvme" -lt "$NVME_WARN_C" ]; then
        ok "Temperatura NVMe (Composite)" "$nvme °C (aviso desde $NVME_WARN_C)"
    else
        warn "Temperatura NVMe (Composite)" "$nvme °C (aviso desde $NVME_WARN_C)"
    fi

    local failed
    failed="$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
    if [ -z "$failed" ]; then ok "Servicios fallidos" "ninguno"; else ko "Servicios fallidos" "$failed"; fi
    local s
    for s in docker ssh.socket; do
        if systemctl is-active --quiet "$s"; then ok "$s" "active"; else ko "$s" "$(systemctl is-active "$s")"; fi
    done

    info "Arrancado desde" "$(uptime -s) (hora local), $(uptime -p)"
    info "Tiempo de arranque" "$(systemd-analyze time 2>/dev/null | head -1 | sed 's/^Startup finished in //')"
    info "Kernel" "$(uname -r)"
    if [ -e /var/run/reboot-required ]; then
        warn "Reinicio pendiente" "/var/run/reboot-required existe"
    fi

    # ufw needs root to show its rules. Without sudo, report what is readable.
    info "ufw (ufw.conf)" "$(grep -E '^ENABLED=' /etc/ufw/ufw.conf 2>/dev/null || echo 'sin leer')"
    skip "Reglas de ufw" "sudo ufw status verbose"
    skip "Salud del NVMe (SMART)" "sudo smartctl -H /dev/nvme0"
}

main() {
    printf 'verify-msi: %s en %s (%s UTC)\n' "$(whoami)" "$(hostname)" "$(date -u '+%F %T')"
    check_containers
    check_http
    check_listeners
    check_tailscale
    check_power
    check_system
    printf '\nResultado: %d ✘, %d !\n' "$FAILS" "$WARNS"
    [ "$FAILS" -eq 0 ]
}

if [ ! -r "$REDACT" ]; then
    echo "verify-msi: no encuentro $REDACT" >&2
    exit 2
fi
# Everything printed goes through the redaction filter. pipefail keeps
# main's exit status (1 if any check failed).
main "$@" 2>&1 | sed -E -f "$REDACT"
