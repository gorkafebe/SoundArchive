#!/usr/bin/env bash
# snapshot-state.sh: save a dated photo of the MSI's state, to compare later.
#
#   ops/check/snapshot-state.sh [label]
#   ops/check/snapshot-state.sh antes-reinicio
#   ops/check/snapshot-state.sh despues-reinicio
#   diff -r <folder-before> <folder-after>     (the script prints the folders)
#
# Read-only, no sudo, no secrets: the same rules as verify-msi.sh, whose
# output is the first file of the snapshot. Every file goes through
# ops/lib/redact.sed, so the folder can be read or shared without exposing
# addresses, MACs or the tailnet name.
#
# Where: $SNAPSHOT_DIR (default ~/SoundArchive-Informe/estado), outside every
# git repository, one folder per snapshot: <UTC date>-<label>/.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REDACT="$HERE/../lib/redact.sed"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-$HOME/SoundArchive-Informe/estado}"

label="${1:-foto}"
# Keep the label safe as a folder name.
label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-')"
stamp="$(date -u '+%Y%m%d-%H%M%SZ')"
out="$SNAPSHOT_DIR/$stamp-$label"

if [ ! -r "$REDACT" ]; then
    echo "snapshot-state: no encuentro $REDACT" >&2
    exit 2
fi
mkdir -p "$out"

# save NAME COMMAND...: run a command, redact its output into NAME.txt.
save() {
    local name="$1"; shift
    { printf '$ %s\n' "$*"; "$@" 2>&1; } | sed -E -f "$REDACT" > "$out/$name.txt"
}

# 01: the full checklist (its exit status is kept in the file).
{ "$HERE/verify-msi.sh"; echo "(salida de verify-msi.sh: $?)"; } > "$out/01-verify-msi.txt" 2>&1

# 02: containers. Same columns as the reference table of the session logs:
# the IDs show whether a container was re-created, RestartCount whether it
# restarted by itself.
save 02-docker-ps docker ps -a --format 'table {{.Names}}\t{{.ID}}\t{{.Status}}\t{{.Ports}}'
{
    printf '$ docker inspect (solo nombre, inicio y reinicios)\n'
    docker ps -aq | xargs -r docker inspect -f '{{.Name}} started={{.State.StartedAt}} restarts={{.RestartCount}}' 2>&1
} | sed -E -f "$REDACT" > "$out/03-docker-restarts.txt"
save 04-docker-volumes docker volume ls

# 05-07: network listeners and Tailscale (summary only, no peer names).
save 05-ss-tcp ss -tlnp
save 06-ss-udp ss -ulnp
{
    printf '$ tailscale status --json (resumen)\n'
    tailscale status --json 2>/dev/null | python3 -c '
import json, sys
s = json.load(sys.stdin)
peers = s.get("Peer") or {}
print("BackendState:", s.get("BackendState"))
print("Self online:", s["Self"].get("Online"))
print("MagicDNS:", (s.get("CurrentTailnet") or {}).get("MagicDNSEnabled"))
print("HTTPS certificates enabled:", bool(s.get("CertDomains")))
print("Peers:", len(peers), "online:", sum(1 for p in peers.values() if p.get("Online")))
' 2>&1
    printf '$ tailscale serve status\n'; tailscale serve status 2>&1
    printf '$ tailscale funnel status\n'; tailscale funnel status 2>&1
} | sed -E -f "$REDACT" > "$out/07-tailscale.txt"

# 08-10: power, temperatures, boot.
{
    for f in status capacity charge_control_start_threshold charge_control_end_threshold charge_full charge_full_design; do
        printf 'BAT1/%s: %s\n' "$f" "$(cat "/sys/class/power_supply/BAT1/$f" 2>&1)"
    done
    printf 'ADP1/online: %s\n' "$(cat /sys/class/power_supply/ADP1/online 2>&1)"
    printf 'battery-charge-limit.service: %s, %s\n' \
        "$(systemctl is-enabled battery-charge-limit.service 2>&1)" "$(systemctl is-active battery-charge-limit.service 2>&1)"
    printf 'dkms: %s\n' "$(dkms status 2>&1)"
    printf 'lid: %s\n' "$(cat /proc/acpi/button/lid/*/state 2>&1 | tr -s ' ')"
    printf 'GPU: %s, %s\n' "$(cat /sys/bus/pci/devices/0000:01:00.0/power/runtime_status 2>&1)" \
        "$(cat /sys/bus/pci/devices/0000:01:00.0/power_state 2>&1)"
} | sed -E -f "$REDACT" > "$out/08-power.txt"
save 09-sensors sensors
{
    printf '$ uptime -s; uptime\n'; uptime -s; uptime
    printf '$ last reboot | head -5\n'; last reboot 2>&1 | head -5
    printf '$ systemd-analyze time\n'; systemd-analyze time 2>&1
    printf '$ systemd-analyze blame | head -10\n'; systemd-analyze blame 2>&1 | head -10
    printf '$ systemctl --failed\n'; systemctl --failed --no-pager 2>&1
    printf '$ journalctl -b -1 -n 30 (final del arranque anterior)\n'; journalctl -b -1 -n 30 --no-pager 2>&1
} | sed -E -f "$REDACT" > "$out/10-boot.txt"

# 11: disk and memory.
{
    printf '$ df -h /\n'; df -h /
    printf '$ free -h\n'; free -h
    printf '$ docker system df\n'; docker system df 2>&1
} | sed -E -f "$REDACT" > "$out/11-disk-memory.txt"

echo "Foto guardada en: $out"
ls "$out"
prev="$(find "$SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -type d ! -path "$out" | sort | tail -1)"
if [ -n "$prev" ]; then
    echo "Para comparar con la anterior:"
    echo "  diff -r \"$prev\" \"$out\""
fi
