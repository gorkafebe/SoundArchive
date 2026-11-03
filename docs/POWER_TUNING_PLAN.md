# Power tuning plan for the MSI (not applied)

Status (2026-11-03): **plan only. Nothing here has been installed or
changed.** Every step is for the owner, by hand, with `sudo`.

*Why bother:* a gaming laptop running 24/7 as a server spends power on parts
it never uses. A few watts saved all year are worth more than any single
tweak, and less heat also means a quieter fan and a longer life with the lid
closed. **But only a measured saving is a saving:** each step below starts
and ends with a reading of the wattmeter.

Rules for every step:

- **One change at a time**, then measure, then decide to keep or undo it.
  Two changes at once make it impossible to know which one helped (or broke
  something).
- **Not during a session of the coding agent** or a backup: a measurement
  under a changing load is useless.
- After each step, `make msi-check` (nothing ✘) and a look at the site.
- Write the numbers in the table of the step, with the date and time.

## Starting point (verified 2026-11-03, read-only)

| What | Reading | Command |
|---|---|---|
| NVIDIA GPU | `nouveau` driver, runtime PM `auto`, **`suspended`**, `D3cold`: 86,734 s suspended against 37 s active since boot | `cat /sys/bus/pci/devices/0000:01:00.0/power/{runtime_status,control}` and `.../power_state` (read these **before** `lspci`, which wakes the GPU for a few seconds) |
| CPU | `intel_pstate` active, governor `powersave`, preference `balance_performance`, turbo allowed | `/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference`, `/sys/devices/system/cpu/intel_pstate/no_turbo` |
| EC mode (msi-ec) | `shift_mode` **comfort** (choices: `eco`, `comfort`, `turbo`); `fan_mode` auto; `super_battery` off; `cooler_boost` off | `/sys/devices/platform/msi-ec/` |
| PCIe ASPM | policy `default` (whatever the firmware set) | `cat /sys/module/pcie_aspm/parameters/policy` |
| NVMe APST | `default_ps_max_latency_us` 100000 (the kernel lets the SSD use power states with up to 100 ms wake-up: APST is probably on; **to confirm** with `nvme get-feature`) | `/sys/module/nvme_core/parameters/default_ps_max_latency_us` |
| Other | NMI watchdog on (`/proc/sys/kernel/nmi_watchdog` 1); audio codec power save 1 s; webcam on; Wi-Fi in use, wired port down | |
| Tools | TLP not installed; `power-profiles-daemon` inactive; `thermald` active; `powertop`, `nvme`, `smartctl` not installed | `systemctl is-active tlp power-profiles-daemon thermald` |
| Load | CPU idle most of the time (average package temperature 33.7 °C over a day) | Prometheus |

---

## Step 0: the baseline, with a wattmeter

A plug-in power meter between the wall and the MSI's charger (any model that
shows watts; roughly 15–25 €, an estimate). Nothing else gives the real
number: the battery's `energy-rate` reads 0 W while the charger is
connected, because the laptop then runs from the charger, not the battery.

1. Plug in the wattmeter. Leave the MSI as it normally runs (lid closed,
   containers up), and do not touch it for 10 minutes.
2. Note the idle reading for 5 minutes (minimum, typical, maximum).
3. Note the reading during a typical task, e.g. `make msi-check` in a loop or
   a backup, for 2 minutes.

| Date / time (UTC) | State | Watts min | Watts typical | Watts max |
|---|---|---|---|---|
| | idle, lid closed | | | |
| | under load (what?) | | | |

*Expectation (unverified):* gaming laptops of this class idle somewhere
between 10 and 25 W at the wall. If the reading is far above that, look for
what keeps the machine busy before tuning anything.

**Undo:** nothing to undo.

---

## Step 1: the dedicated GPU

*Why:* the RTX 3060 can draw several watts even idle if it stays awake. On
this MSI it already sleeps (`D3cold`) thanks to the open `nouveau` driver
and runtime power management (`control` = `auto`), so the likely saving is
**nothing**. This step is a check, not a change.

**Do not** install NVIDIA's proprietary driver: the server does not need the
GPU, the driver is large, and its kernel module would also need MOK signing
(MSI_SERVER_SETUP.md, section 11).

Check, now and then (no `sudo` needed):

```sh
cat /sys/bus/pci/devices/0000:01:00.0/power/runtime_status   # suspended
cat /sys/bus/pci/devices/0000:01:00.0/power_state            # D3cold
cat /sys/bus/pci/devices/0000:01:00.0/power/runtime_active_time   # ms awake; should grow very slowly
```

Optional, later: a BIOS option that disables the GPU completely (not found
yet; MSI_SERVER_SETUP.md, section 8). Measure before and after if one
appears.

| Date / time | GPU state | Watts idle before | Watts idle after |
|---|---|---|---|
| | | | |

**Undo:** BIOS setting back.

---

## Step 2: NVMe APST (SSD power states)

*Why:* APST (Autonomous Power State Transition) lets the SSD drop into deeper
sleep states by itself after a short idle time. It is usually on already;
this step confirms it before touching anything.

```sh
sudo apt install nvme-cli                               # a package: owner's decision
sudo nvme get-feature /dev/nvme0 -f 0x0c -H | head -20  # "Autonomous Power State Transition Enable (APSTE): Enabled"
sudo nvme id-ctrl /dev/nvme0 | grep -E '^ps '           # the power states and their wake-up latencies
```

If APSTE is **Enabled**: nothing to do. If it is disabled, the usual cause is
a kernel parameter (`nvme_core.default_ps_max_latency_us=0`) in
`/etc/default/grub`; remove it, `sudo update-grub`, reboot, check again.

*Risk:* some SSDs misbehave in their deepest states (the disk disappears
until a reboot). If after enabling APST the system log shows NVMe timeouts
(`journalctl -k | grep -i nvme`), undo it.

| Date / time | APSTE before | APSTE after | Watts idle before | after |
|---|---|---|---|---|
| | | | | |

**Undo:** put the old GRUB line back, `sudo update-grub`, reboot.

---

## Step 3: TLP, with the `*_ON_AC` values

*Why:* TLP applies dozens of small power settings at once (PCIe ASPM, USB
autosuspend, runtime PM of devices, CPU energy preference, Wi-Fi power
save). It keeps two sets of values: `*_ON_AC` (on mains) and `*_ON_BAT` (on
battery). Its savings are mostly in the battery set, and **this server is
always on mains**, so the useful values must be written into the `*_ON_AC`
settings. (An inference from how TLP is organised; confirm with
`sudo tlp-stat` what it really applies.)

Before installing: TLP and `power-profiles-daemon` must not run together
(both set the same things; today `power-profiles-daemon` is inactive). Do
not run `powertop --auto-tune` as well, for the same reason.

```sh
sudo apt install tlp
systemctl is-active power-profiles-daemon     # must be inactive
```

Then a file of our own, so the package's `/etc/tlp.conf` stays untouched:
`sudo nano /etc/tlp.d/90-sound-archive.conf` with:

```ini
# Sound Archive server: always on mains, so the saving values go in *_ON_AC.
CPU_ENERGY_PERF_POLICY_ON_AC=balance_power
PCIE_ASPM_ON_AC=powersupersave
RUNTIME_PM_ON_AC=auto
USB_AUTOSUSPEND=1
NMI_WATCHDOG=0
# Wi-Fi power save can add delay to SSH and to the site over Wi-Fi.
# Start with it off; try "on" later and measure both watts and ping.
WIFI_PWR_ON_AC=off
# Keep turbo: audio processing (phase 5) needs it; the CPU idles anyway.
CPU_BOOST_ON_AC=1
```

The setting names are those of TLP 1.6 as I know them, **not checked**
against the version Ubuntu installs: compare with the comments in
`/etc/tlp.conf` after installing, and `sudo tlp-stat -c` lists any unknown
name.

Apply and check:

```sh
sudo tlp start
sudo tlp-stat -s -p | head -40        # what is in force
cat /sys/module/pcie_aspm/parameters/policy   # [powersupersave]
make msi-check
```

One setting per measurement is the strict way; for TLP, measure once with
the whole file and, if something misbehaves, comment lines out one by one.

| Date / time | Setting(s) | Watts idle before | after | Problems seen |
|---|---|---|---|---|
| | whole file | | | |
| | `WIFI_PWR_ON_AC=on` | | | ping to the MSI: … ms |

Things to watch after TLP: USB devices that stop working (USB autosuspend:
add them to `USB_DENYLIST`), SSH or the site slower over Wi-Fi, the NVMe
messages of step 2.

**Undo:** `sudo rm /etc/tlp.d/90-sound-archive.conf && sudo tlp start`; to
remove TLP completely, `sudo apt remove tlp` and reboot (the kernel's own
defaults return).

---

## Step 4: the EC's `eco` mode (optional)

*Why:* the embedded controller has its own performance modes (MSI's
"shift modes"): `eco`, `comfort` (current), `turbo`. `eco` lowers the CPU's
power limits at the EC level. It could save power under load but will make
heavy tasks (builds, audio processing) slower; at idle the difference may
be zero. A test, not a recommendation.

```sh
cat /sys/devices/platform/msi-ec/shift_mode                       # comfort
echo eco | sudo tee /sys/devices/platform/msi-ec/shift_mode
```

Measure idle and the same load as in step 0 (also how long that task takes).

| Date / time | Mode | Watts idle | Watts under load | Task duration |
|---|---|---|---|---|
| | comfort | | | |
| | eco | | | |

**Undo:** `echo comfort | sudo tee /sys/devices/platform/msi-ec/shift_mode`.
The mode is not kept across reboots by this command; making it permanent
would be one more line in a boot service like the battery one.

---

## Not in this plan

- Undervolting, BIOS overclocking menus: risky, little gain.
- Turning off the webcam (`/sys/devices/platform/msi-ec/webcam`): saves
  almost nothing, but it is a reasonable **privacy** choice for a server.
- `powertop --auto-tune`: overlaps with TLP; use one or the other.
