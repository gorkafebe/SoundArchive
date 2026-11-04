# MSI: reboot, cold boot, power and network tests

Five tests the **owner** runs by hand, in this order. None of them has been
run yet (status of each: **planned**). They answer questions that no
read-only check can: does everything come back by itself after a restart,
does the battery limit survive a full power-off, does the server ride out a
power cut, and is the site really closed to the internet.

| # | Test | Needs | Time |
|---|---|---|---|
| 1 | Normal reboot | `sudo`, SSH | 10 min |
| 2 | Cold boot (full power-off) | `sudo`, **someone at the MSI** | 15 min |
| 3 | Unplugged charger (running on battery) | someone at the MSI, the panel | 20–40 min |
| 4 | IPv6 and IPv4 from mobile data (must fail) | a phone with mobile data | 10 min |
| 5 | Access from the phone over Tailscale (must work) | the Tailscale app | 10 min |

## Rules for every test

- **Never during a session of the coding agent** (or any long job: a
  backup, a `docker build`, an upgrade). A reboot cuts the session in the
  middle and can leave half-written files. Check first:
  `docker ps --format '{{.Names}}' | grep -vE '^(sound-archive|msi-monitor)-'`
  must print nothing (no `sa-ops`, `sa-restore` or `sa-bk-` containers), and
  nobody else is logged in (`who`).
- **Take a snapshot before and after** and compare them:

  ```sh
  cd ~/sa-ops                         # or wherever the repository is
  make msi-snapshot LABEL=antes-<test>
  # ... the test ...
  make msi-snapshot LABEL=despues-<test>
  diff -r ~/SoundArchive-Informe/estado/<before> ~/SoundArchive-Informe/estado/<after>
  ```

  The snapshot is read-only and redacted (no addresses, MACs or tailnet
  name); `make msi-check` prints the same checklist without saving it.
- Write the result (date, time, what was seen, ✔ or ✘) in the project log.
- What "the same containers" means: the container **IDs** stay the same
  after a reboot (Docker restarts the existing containers because of
  `restart: unless-stopped`; it does not re-create them). New IDs would mean
  someone ran `docker compose up` with a change. `StartedAt` changes, and
  that is expected.

---

## Test 1: normal reboot

*Why:* nothing has proved yet that everything starts again by itself. The
last boot was 2026-11-02 14:58 UTC; since then the battery service
(`battery-charge-limit.service`, created 2026-11-03) and ufw have been
enabled, and neither has gone through a boot.

**Before**

1. `make msi-check`: every line ✔ (fix anything ✘ first, or you will not
   know whether the reboot caused it).
2. `make msi-snapshot LABEL=antes-reinicio`.
3. Note the time.

**During**

```sh
sudo reboot
```

The SSH session closes. The MSI took about **40 s** to boot last time
(`systemd-analyze time`: firmware 10 s + loader 12 s + kernel 8 s + userspace
10 s); the containers then need up to a minute to become healthy. From the
Lenovo, wait until it answers:

```sh
tailscale ping soundarchive          # repeats until it answers; Ctrl+C to stop
ssh gorka@soundarchive
```

**After**

```sh
make msi-check
make msi-snapshot LABEL=despues-reinicio
systemctl status battery-charge-limit.service    # "active (exited)" since this boot
journalctl -b -u battery-charge-limit.service    # "Finished ..." in this boot
```

**Success:** every line of `make msi-check` ✔; the six containers with the
**same IDs** as before; thresholds 50/60; `battery-charge-limit.service`
active since this boot; `systemctl --failed` empty; Grafana shows a short gap
in the charts at the reboot and then continues.

**If it fails**

| Symptom | What to do |
|---|---|
| No SSH after 5 minutes | Go to the MSI, open the lid: a login prompt means the network or SSH failed (log in there, `ip -br a`, `systemctl status ssh.socket tailscaled`). A black screen: hold the power button 10 s, start it again, and afterwards read `journalctl -b -1 -n 50`. |
| A container is not healthy | `docker ps -a`, `docker logs --tail 50 <name>`. Production: `cd /srv/sound-archive && make prod-up`. Panel: `cd ~/msi-monitor && docker compose up -d`. |
| Thresholds not 50/60, files missing | `lsmod | grep msi_ec`, `dkms status`. If the module is missing: `sudo modprobe msi_ec`, then `sudo systemctl restart battery-charge-limit.service`. See MSI_SERVER_SETUP.md, section 10. |
| `battery-charge-limit.service` failed | `journalctl -b -u battery-charge-limit.service`; usually the module did not load in the 30 s the service waits. |

---

## Test 2: cold boot (full power-off)

*Why:* a reboot keeps the embedded controller (EC) powered. A full power-off
with the charger removed is closer to a real power cut, and is what might
reset the EC's charge limit to its default (100 %). The boot service should
then put it back to 60 %.

**Before:** as test 1, with `LABEL=antes-frio`. Someone must be at the MSI:
there is no automatic power-on after a power cut (no BIOS option found,
MSI_SERVER_SETUP.md section 8), so the power button has to be pressed.

**During**

```sh
sudo poweroff
```

Wait until the power LED is off, **unplug the charger**, wait **30 seconds**,
plug it in again and press the power button. (The battery is internal and
stays connected: this is as cold as the laptop gets without opening it.)

**After:** as test 1, with `LABEL=despues-frio`. In addition:

```sh
cat /sys/class/power_supply/BAT1/charge_control_{start,end}_threshold   # 50, 60
journalctl -b -u battery-charge-limit.service
```

**Success:** the same as test 1. Thresholds 50/60 prove the limit is applied
after a cold boot (by the EC, by the service, or both: this test cannot tell
which, and it does not need to).

**If it fails:** as test 1. If the MSI does not start with the button, check
the charger LED and hold the button 10 s once.

---

## Test 3: unplugged charger (running on battery)

*Why:* to see the panel show a power cut, and to measure how fast the
battery drains under the server's real load. That number says how long the
server survives a cut (today: **not measured**).

**What to expect.** The battery holds about 66 % of its design capacity
(34.4 Wh of 52 Wh when full, 2026-11-02). It is at **91 %** today
(2026-11-03), above the 60 % limit, because the limit only stops charging; it
never discharges. So about 31 Wh are available now. The drain rate is
unknown; at an assumed 15–25 W it would last roughly 1–2 hours (an
**estimate**, to be replaced by the measurement).

**Before:** `make msi-snapshot LABEL=antes-bateria`, note
`cat /sys/class/power_supply/BAT1/capacity` and the time. Open the panel's
battery chart (Grafana: `node_power_supply_online`, `node_power_supply_capacity`,
`node_power_supply_current_ampere`).

**During:** unplug the charger. Within 15 s (Prometheus's scrape interval)
the panel must show:

| Metric | Plugged in | On battery |
|---|---|---|
| `node_power_supply_online{power_supply="ADP1"}` | 1 | **0** |
| `BAT1` status (`node_power_supply_info`) | `Not charging` | **`Discharging`** |
| `node_power_supply_current_ampere{power_supply="BAT1"}` | 0 | **> 0** |
| `node_power_supply_capacity` | flat | **falls** |

`make msi-check` shows `!  Cargador  DESCONECTADO`. Leave it **20 to 30
minutes** at most, then plug the charger in again.

**After:** `make msi-snapshot LABEL=despues-bateria`. Note the capacity at
the end: drain rate = (capacity before − after) / minutes, in % per minute;
multiply by 34.4 Wh / 100 for watt-hours per minute, × 60 for watts.

Plugged in again, the status goes back to `Not charging`, not `Charging`:
the EC only charges below 50 %. That is correct.

**Success:** no reboot (`uptime -s` unchanged), the containers untouched,
the panel showed the cut, and a drain rate written down.

**Do not:** let the battery fall below about **30 %**, and never let it run
flat: the server would stop abruptly, which can damage the database and the
filesystem. Do not run it with the lid closed on a soft surface.

---

## Test 4: IPv6 and IPv4 from mobile data (must FAIL)

*Why:* production publishes ports 80 and 443 on every interface, IPv4 and
IPv6 (`0.0.0.0` and `[::]`, verified 2026-11-03). The home router has no
port forwarding, so IPv4 is closed from the internet. But the MSI also has
**public IPv6 addresses**, and IPv6 needs no forwarding: if the router lets
incoming IPv6 through, the site and SSH are open to the whole internet.
Nothing on the MSI can prove this; only a device outside the home network
can.

**Before (on the MSI):** find the addresses. **Do not write them in any
file or message**; type them on the phone.

```sh
ip -6 addr show scope global | grep -v temporary   # the stable public IPv6 address(es)
curl -s https://ifconfig.co                          # the public IPv4 (optional)
```

**On the phone:** Wi-Fi **off**, Tailscale **off**, mobile data on. First
make sure the phone has IPv6 at all: open <https://test-ipv6.com> (if it
says "no IPv6", this test cannot be done from this phone; try another
network or operator).

| Try | Expected |
|---|---|
| `http://[<IPv6-global>]/` in the browser (with the square brackets) | **fails** (timeout or "can't reach") |
| `https://[<IPv6-global>]/` | **fails** |
| `http://<IP-publica>/` | **fails** |
| SSH to `<IPv6-global>` port 22 (an SSH or port-check app, e.g. Termux: `nc -zv -w 5 <IPv6-global> 22`) | **fails** |

**Success:** all four fail. **If any one works, the site is on the
internet.** Then, in this order: block incoming IPv6 in the router (look for
an "IPv6 firewall" setting), or, until that is done, stop publishing on IPv6
(a change to `compose.prod.yaml`: `"0.0.0.0:80:80"` instead of `"80:80"`)
and make sure ufw allows SSH only on `tailscale0`. Write down which one was
open.

---

## Test 5: access from the phone over Tailscale (must WORK)

*Why:* Tailscale is the intended way in from anywhere. The phone is already
in the tailnet (an Android device appears in `tailscale status`).

**Steps (phone):** Wi-Fi off, mobile data on, Tailscale app **on** and
connected.

| Try | Expected |
|---|---|
| `http://soundarchive/` (MagicDNS short name) or `http://soundarchive.<tailnet>.ts.net/` | **works**: the map |
| `http://soundarchive/status.html` | **works**: both boxes green |
| `http://soundarchive/api/health` | `{"status":"ok"}` |
| `http://soundarchive:3000/` (Grafana) | **fails**: Grafana listens only on `127.0.0.1` (until `tailscale serve` is set up, see `~/msi-monitor/docs/ACCESS.md`) |
| `http://soundarchive:5432/`, `:8000` | **fails** (database and API are not published) |
| The same with the Tailscale app **off** | **fails** |

On the home Wi-Fi **without** Tailscale, `http://<IP-local>/` **works**:
ports 80/443 are published on every interface, so any device at home can
reach the site. That is known and accepted for now (DEPLOY_MSI.md, section
6).

**Success:** the first three work, the rest fail. Then
`make msi-snapshot LABEL=despues-movil` on the MSI is not needed (nothing
changes on the MSI); just write the result in the log.

---

## Results

Fill in one line per test (date and time in UTC, ✔/✘, notes, the snapshot
folders):

| # | Date / time | Result | Notes |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | drain: … % per min, … W |
| 4 | | | phone has IPv6: yes/no |
| 5 | | | |
