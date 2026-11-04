# Setting up the MSI server (Ubuntu Server)

A checklist to turn the MSI laptop into a headless Ubuntu server, from a blank
USB stick to a machine you manage over SSH with the lid closed. Follow it by
hand. When it is done, continue with [DEPLOY_MSI.md](DEPLOY_MSI.md), which
installs Docker and runs the app.

This is also the record of the first installation, done on **2026-11-02**.
Each section says whether it is **done** (and verified) on the MSI or still
**pending**. If you ever have to start again (new disk, disk failure), the
same steps apply; the "Why" notes explain each choice.

Commands starting with `sudo` change the system. Unless a step says
"on the Lenovo", run it on the MSI.

---

## The machine

| | |
|---|---|
| Model | MSI Katana GF66 12UE-091XES (laptop), x86_64 |
| CPU | Intel Core i7-12700H, 14 cores / 20 threads, 400–4700 MHz (verified with `lscpu`, 2026-11-02) |
| RAM | 16 GB (`free -h` shows `15Gi`), swap 4 GiB (verified) |
| GPU | NVIDIA GeForce RTX 3060 Mobile (GA106M), open-source `nouveau` driver, powered down while unused (see [section 12](#12-power-saving-plan-nothing-applied-yet)) |
| BIOS / EC firmware | BIOS `E1583IMS.10F` (2023-07-03, from `hostnamectl`); embedded controller `1583EMS1.109` (see [section 10](#10-battery-charge-limit-msi-ec)) |
| Disk | one NVMe SSD, Micron 2450 (MTFDKBA512TFK), the only disk. Sold as 512 GB; `lsblk` shows `476.9G` because it counts in GiB. |
| Second M.2 slot | unknown. Check it: a second SSD is the cheapest way to add space. |
| Wired network | `enp4s0` |
| Wi-Fi | `wlo1` (also named `wlp0s20f3`) |
| Hostname / user | `soundarchive` / `gorka` |
| OS | Ubuntu Server 24.04.5 LTS, kernel 6.8.0-147-generic (2026-11-02) |

The MSI's own screen and keyboard are enough for the installation. No
external monitor is needed. After installation everything happens over SSH.

---

## 1. Prepare the USB stick (on the Lenovo)

Status: **done** 2026-11-02.

You need a USB stick of **8 GB or more**. Everything on it will be erased.

- [ ] Download the **Ubuntu Server 24.04.x LTS** ISO from
      <https://ubuntu.com/download/server>, and the `SHA256SUMS` file from the
      same release page.
      *Why 24.04:* it matches the development laptop, so both machines run the
      same base system.
- [ ] Verify the download (a corrupt ISO gives strange installer errors):

  ```sh
  cd ~/Downloads
  sha256sum -c SHA256SUMS --ignore-missing
  ```

  Expected: the ISO's line ends in `OK`.

- [ ] Write the ISO to the USB stick. The easiest way is Ubuntu's
      **Startup Disk Creator** app. With `dd`, first find the stick's device
      name with `lsblk` (e.g. `/dev/sdb`, **not** a partition like `/dev/sdb1`).
      A wrong name overwrites another disk.

  ```sh
  sudo dd if=ubuntu-24.04.5-live-server-amd64.iso of=/dev/sdX bs=4M status=progress conv=fsync
  ```

  (The tool used on 2026-11-02 was not recorded.)

---

## 2. Boot the MSI from the USB stick

Status: **done** 2026-11-02 (boot menu with F11, factory BIOS settings,
nothing changed in the BIOS).

These keys come from general MSI information, not from an official page for
this exact model:

| Key | What it opens |
|---|---|
| **Del** | BIOS setup |
| **F11** | one-time boot menu (pick the boot device once) |
| **F2** | alternative to try if Del does not work |
| **F10** | in the BIOS: save and exit |
| **F7** | in the BIOS: may switch to advanced mode (not verified on this model) |

- [ ] Plug in the USB stick. **Power the MSI off completely** (not restart).
- [ ] Power on and **tap F11 repeatedly** until the boot menu appears.
- [ ] Choose the USB entry that starts with **"UEFI"**.
      *Why:* the non-UEFI (legacy) entry would install in an old boot mode.
- [ ] If the USB does not boot: in the BIOS (Del), disable **Fast Boot** if
      present. **Secure Boot** can stay on; disable it only if the stick still
      does not boot. Save with F10.

---

## 3. Installer choices

Status: **done** 2026-11-02.

In order, as they appear in the installer:

| Screen | Choice | Why |
|---|---|---|
| Language | English | Error messages and online help are easier to search in English. |
| Keyboard | Spanish | Matches the physical keyboard. |
| Installer update | Skip | Not needed for a standard install. |
| Type of install | **Ubuntu Server** (not "minimized") | The minimized variant leaves out tools you expect when working by hand. |
| Network | Wired `enp4s0` with DHCP (got `192.168.1.162/24`); leave Wi-Fi unconfigured | The cable works without extra packages. Wi-Fi is set up later (section 6). |
| Proxy | empty | No proxy at home. |
| Mirror | default | |
| Storage | "Use an entire disk" on the Micron SSD. **Untick "Set up this disk as an LVM group"**, no encryption | See the note below. |
| Profile | server name `soundarchive`, user `gorka`, a strong password | Never write the password down in any file. |
| Ubuntu Pro | Skip | Not needed. |
| SSH | **Install OpenSSH server** | This is how the server is managed. |
| Featured snaps | none | Docker comes from Docker's own apt repository (see DEPLOY_MSI.md), not from snap. |

> **Storage: LVM and encryption.**
> The plan was a plain layout without LVM and without disk encryption. Without
> encryption the server boots by itself after a power cut (nobody has to type
> a passphrase at the keyboard).
>
> On 2026-11-02 the LVM box stayed ticked (it is the default). Ubuntu's guided
> LVM layout creates a root volume of about **100 GB** and leaves the rest of the
> disk **unallocated**. The fix is in section 5. Next time, either untick
> "Set up this disk as an LVM group", or keep LVM and extend the volume right
> after the first boot.

The installation **erases the factory Windows**.

- [ ] When asked, remove the USB stick and let the machine reboot.

---

## 4. First login and updates

Status: **done** 2026-11-02.

- [ ] Log in at the MSI's own keyboard, or from the Lenovo (on the Lenovo):

  ```sh
  ssh gorka@192.168.1.162
  ```

  The first time, SSH asks you to accept the server's host key fingerprint.
  Type `yes`. (Fingerprints are not recorded in these docs.)

- [ ] Note the login banner. On 2026-11-02, right after installation: system
      load 1.03, memory 3% used, temperature 60 °C (normal while it was still
      busy; at idle it later read about 37 °C, see section 8), 27 updates
      pending, 329 processes.
- [ ] Update everything and reboot:

  ```sh
  sudo apt update && sudo apt full-upgrade -y
  sudo reboot
  ```

> The banner also offered an upgrade to **26.04.1 LTS**. It was **not** done
> (`do-release-upgrade` was not run): the project stays on 24.04 to match the
> development laptop. Revisit later, deliberately, on both machines.

---

## 5. Give the root filesystem the whole disk (LVM)

Status: **done and verified** 2026-11-02.

Only needed if LVM was left on in section 3.

Symptom: `df -h /` shows a root of about 98 GB (it showed 97.87 GB, 6.8% used)
on a 477 GiB disk.

- [ ] Look at the layout. The volume group should have free space:

  ```sh
  lsblk
  sudo vgs        # VFree = unallocated space in the volume group
  sudo lvs
  ```

- [ ] Extend the logical volume into all the free space and grow the
      filesystem in the same command (`-r`). This works with the system
      running:

  ```sh
  sudo lvextend -l +100%FREE -r /dev/ubuntu-vg/ubuntu-lv
  df -h /
  ```

Result on 2026-11-02 (the names matched the command above):

```
df -h /   ->  /dev/mapper/ubuntu--vg-ubuntu--lv  466G  6.7G  440G  2%  /
lvs       ->  LV ubuntu-lv, VG ubuntu-vg, LSize <473.89g
lsblk     ->  nvme0n1 476.9G
                nvme0n1p1    1G  /boot/efi
                nvme0n1p2    2G  /boot
                nvme0n1p3  473.9G  (LVM) -> ubuntu--vg-ubuntu--lv 473.9G  /
```

The volume is 473.9 GiB but `df` shows 466G: the difference is space that
ext4 keeps for its own bookkeeping. That is normal.

---

## 6. Wi-Fi with netplan (optional)

Status: **done and verified** 2026-11-02.

The cable is the reliable connection for real use. Wi-Fi is a convenience for
administration and testing.

Ubuntu Server configures the network with **netplan**: YAML files in
`/etc/netplan/`. Netplan **merges all the files** in that folder, so Wi-Fi goes
in its own file and the installer's file is left untouched.

- [ ] **First, with the cable connected**, install the Wi-Fi authentication
      program. Ubuntu Server does not always include it, and without the cable
      you cannot download it:

  ```sh
  sudo apt install -y wpasupplicant
  ```

- [ ] Leave the installer's file as it is. `/etc/netplan/50-cloud-init.yaml`:

  ```yaml
  network:
    version: 2
    ethernets:
      enp4s0:
        dhcp4: true
  ```

- [ ] Create `/etc/netplan/60-wifi.yaml` (`sudo nano /etc/netplan/60-wifi.yaml`).
      Replace the placeholders with your network's name and password. Never
      commit or paste the real values anywhere.

  ```yaml
  network:
    version: 2
    wifis:
      wlo1:
        dhcp4: true
        optional: true        # boot does not wait for Wi-Fi
        access-points:
          "<WIFI_NAME>":
            password: "<WIFI_PASSWORD>"
  ```

- [ ] Make it readable by root only, because it contains the Wi-Fi password:

  ```sh
  sudo chmod 600 /etc/netplan/60-wifi.yaml
  ```

- [ ] Apply it safely. `netplan try` reverts by itself after 120 seconds unless
      you press Enter to confirm, so a mistake cannot cut you off for good:

  ```sh
  sudo netplan try
  ```

- [ ] Check both interfaces have an address:

  ```sh
  ip -br addr
  ip route
  ```

  Result on 2026-11-02: cable `enp4s0` = `192.168.1.162/24` (route metric 100),
  Wi-Fi `wlo1` = `192.168.1.145/24` (route metric 600). The lower metric wins,
  so outgoing traffic prefers the cable.

**If Wi-Fi does not connect** (what happened on 2026-11-02):

- `wlo1` stayed `NO-CARRIER`, and the service `netplan-wpa-wlo1` failed with
  `status=203/EXEC`. That code means the program to run does not exist:
  `/sbin/wpa_supplicant` was missing because `wpasupplicant` was not installed.
  Fix: `sudo apt install -y wpasupplicant`, then `sudo netplan apply`.
- With netplan, the service is called `netplan-wpa-wlo1`, **not**
  `wpa_supplicant@wlo1`. Check it with `systemctl status netplan-wpa-wlo1`.
- If Wi-Fi works but a **5 GHz** network is not seen, add
  `regulatory-domain: ES` under `wlo1:` (this tells the card which country's
  radio rules apply).

> **Addresses can change.** Both addresses come from the router's DHCP. To keep
> them stable, reserve a fixed IP for each interface in the router, using each
> interface's MAC address (see it with `ip link`), and/or use Tailscale names
> (section 10). Both are pending.

---

## 7. SSH: key-only login

Status: **done and verified** 2026-11-02 (all five steps).

*Why:* with passwords turned off, nobody can guess their way in. That matters
once the server is reachable from the internet.

Do it **in this order**, so you cannot lock yourself out:

- [ ] **1. On the Lenovo**, use your existing ed25519 key or create one. Look
      first, and never overwrite an existing key:

  ```sh
  ls -la ~/.ssh
  ssh-keygen -t ed25519 -C "lenovo-dev"      # only if there is no key yet
  ssh-copy-id gorka@192.168.1.162
  ```

- [ ] **2. On the Lenovo**, check that you log in **without** the account
      password: `ssh gorka@192.168.1.162`.
- [ ] **3. Only then**, on the MSI, create
      `/etc/ssh/sshd_config.d/99-hardening.conf` with:

  ```
  PasswordAuthentication no
  PermitRootLogin no
  ```

- [ ] **4.** Check the syntax and restart SSH (if `sshd -t` prints an error,
      nothing is restarted):

  ```sh
  sudo sshd -t && sudo systemctl restart ssh
  ```

- [ ] **5.** Keep the current session open. From a **new terminal on the
      Lenovo**, test both ways:

  ```sh
  ssh gorka@192.168.1.162                                   # must work
  ssh -o PubkeyAuthentication=no gorka@192.168.1.162        # must fail
  ```

  The second one must answer `Permission denied (publickey).`

> **Run SSH tests from the Lenovo, not on the MSI.** On 2026-11-02 one test
> (`ssh ... soundarchive`) was typed on the MSI itself. There, `soundarchive`
> is the machine's own name (it resolves to `127.0.1.1`), so the MSI connected
> to itself and the test proved nothing. From other machines, the name
> `soundarchive` only works once Tailscale (or an `/etc/hosts` entry) provides
> it.

**If the Lenovo's key is lost:** the restriction only applies to SSH. Log in at
the MSI's own keyboard and screen with the username and password, and add a
new public key to `~/.ssh/authorized_keys`.

Pending, before the server is opened to the internet: back up the Lenovo's
private key (`~/.ssh/id_ed25519`, protected with a passphrase) to a USB stick
or a password manager, and/or authorize a second key that is kept outside the
Lenovo.

---

## 8. Run it headless with the lid closed

Status: lid and screen settings **done and verified** 2026-11-02; closed-lid
temperatures **measured** over one day (2026-11-03, see
[Temperatures](#temperatures)); BIOS settings **pending**.

### Ignore the lid

By default, closing the lid suspends the laptop and the server disappears.

- [ ] Edit `/etc/systemd/logind.conf` (`sudo nano /etc/systemd/logind.conf`),
      uncomment these lines (remove the leading `#`) and set them to `ignore`:

  ```ini
  HandleLidSwitch=ignore
  HandleLidSwitchExternalPower=ignore
  HandleLidSwitchDocked=ignore
  ```

  (On battery, on mains power, and with an external display or dock.)

- [ ] Apply it:

  ```sh
  sudo systemctl restart systemd-logind
  ```

Verified on 2026-11-02: with the MSI plugged in and an SSH session open, the
lid was closed and the session stayed alive.

### Never sleep

A server should never suspend or hibernate, whatever triggers it (the lid,
a key, an idle timer, a command). Masking the sleep targets makes systemd
refuse all of them:

- [ ] Mask the four sleep targets:

  ```sh
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```

- [ ] Check: each line must say `masked`.

  ```sh
  systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```

  To undo it one day: `sudo systemctl unmask` with the same four names.

Status: **done** 2026-11-02 at 13:30 UTC (the command is in the system log)
and **verified** at 17:21 UTC (all four `masked`). This step was not written
down when it was done; it is recorded here from the log.

Why it was done then: at 12:45 UTC that day the MSI stopped responding. The
lid had been closed since 12:07 (ignored, as configured) and the machine was
idle (99% idle at 12:40 according to `sar`). The kernel log ends with
`xhci_hcd 0000:00:14.0: xHCI host controller not responding, assume dead`,
there is no clean shutdown, and the next boot (13:20) found the journal
"uncleanly shut down". No `PM: suspend` message appears, so it is **not
proven** that it tried to sleep. The cause is **unknown**; the masking is a
precaution. If it happens again, note the time and check
`journalctl -b -1 | tail -n 50` after the reboot.

### Turn the screen off when idle

Only matters with the lid open; with the lid closed the laptop turns its
screen off by itself.

- [ ] In `/etc/default/grub`, add `consoleblank=60` to
      `GRUB_CMDLINE_LINUX_DEFAULT`. Keep any values already there, separated by
      a space, e.g. `GRUB_CMDLINE_LINUX_DEFAULT="<existing values> consoleblank=60"`.
- [ ] Apply it and reboot:

  ```sh
  sudo update-grub && sudo reboot
  ```

The text console now blanks after 60 seconds without input. Verified on
2026-11-02.

### Temperatures

- [ ] Install the sensor tools and detect the sensors (accept the default
      answers):

  ```sh
  sudo apt install -y lm-sensors
  sudo sensors-detect
  sensors                 # one reading
  watch -n 2 sensors      # live view, every 2 seconds (Ctrl+C to stop)
  ```

What the blocks in the `sensors` output are:

| Block | What it measures |
|---|---|
| `coretemp` | The CPU. **`Package id 0`** is the whole chip; the `Core N` lines are individual cores. |
| `nvme` | The SSD. **`Composite`** is the drive's overall temperature; `Sensor 1/2` are internal sensors. |
| `iwlwifi` | The Wi-Fi card. |
| `acpitz` | A thermal zone reported by the firmware (ACPI), usually near the motherboard. |
| `BAT1-acpi` | The battery, as reported by the firmware. |

`high` is the temperature the component itself considers hot; `crit` is the
critical limit, where it slows down hard or shuts down to protect itself.

Readings on 2026-11-02, at idle with the lid open:

| Sensor | Reading | Limits |
|---|---|---|
| CPU `Package id 0` | 37 °C | high 100 °C, crit 100 °C |
| SSD `Composite` | 29.9 °C | high 82.8 °C, crit 84.8 °C |
| Wi-Fi (`iwlwifi`) | 42 °C | |
| `acpitz` | 42 °C | |

Ignore the limits printed for the SSD's `Sensor 1` (+65261.8 °C is a
meaningless value). The two values to watch are **`Package id 0`** and
**`Composite`**. Rough rule: 40–60 °C at idle is normal; above about 85–90 °C
for a sustained time, improve the cooling.

**One day with the lid closed (verified 2026-11-03, from Prometheus).** The
monitoring panel keeps every reading, so this is measured, not guessed. Data
from 2026-11-02 15:10 UTC (when Prometheus started) to 2026-11-03 15:05 UTC,
about 24 hours. The lid read `closed` at the end
(`cat /proc/acpi/button/lid/*/state`); its state is not recorded over time,
so "closed the whole day" rests on the owner's word.

| Sensor | Max | Average | Median | Min | Night (00–06 UTC, average) |
|---|---|---|---|---|---|
| CPU `Package id 0` | **95 °C** | 33.7 °C | 33 °C | 26 °C | 29.2 °C |
| SSD `Composite` | 30.9 °C | 24.5 °C | | 18.9 °C | 21.5 °C |
| `acpitz` | 96 °C | 37.8 °C | | 30 °C | |

The CPU spent **1.25 minutes** in total above 90 °C and 5.25 minutes above
80 °C that day (99 % of the time below 67 °C). The 95 °C peaks match the
Docker builds and browser tests of the work sessions (2026-11-02 around
16–17 h and 20–21 h UTC, 2026-11-03 around 09–10 h UTC). PromQL used, for
reference:

```promql
max_over_time(node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp1"}[2d])
avg_over_time(node_hwmon_temp_celsius{chip="nvme_nvme0",sensor="temp1"}[2d])
count_over_time((node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp1"} > 90)[2d:15s]) * 15 / 60
```

Reading: at idle the closed lid is no problem; under a long heavy load the
CPU reaches its limit region within minutes. Audio processing (phase 5)
should be measured the same way before it runs unattended.

### Cooling

With the lid closed the laptop cools less well. Keep the air vents free, put
it on a hard surface (not fabric), and raise it slightly if possible.

### BIOS settings (searched, not changed)

- **Power on after a power cut** ("Restore after AC power loss"): MSI desktop
  boards have it under Advanced / Power Management Setup. Not confirmed on
  this laptop.
- **Battery charge limit:** on MSI laptops this is not a BIOS option. Windows
  programs handle it (Battery Master in Dragon Center / MSI Center), and
  Windows has been erased. On Linux the `msi-ec` driver exposes it: **done**,
  the limit is 60%. See [section 10](#10-battery-charge-limit-msi-ec).

> **The battery bridges short power cuts, but it is not a UPS you can rely
> on.** It holds about 66% of its design capacity, and with the 60% limit it
> sits at about 20 Wh (section 10). Time on battery under the server's load
> has not been measured. A long cut drains it, and then someone has to press
> the power button unless the BIOS has an automatic power-on. Wake-on-LAN is a
> possible plan B (not verified).

---

## 9. How much audio fits

These are estimates, not measurements.

After the system and the Docker images, about **430 GB** is usable. Keeping
20–30% free (a full disk slows down and breaks things) leaves roughly
**300–340 GB for audio**.

| Format | Per hour | Per 5 minutes | 5-minute recordings in 300 GB |
|---|---|---|---|
| WAV 48 kHz / 24-bit stereo | ≈ 1 GB | ≈ 87 MB | ≈ 3,400 |
| WAV 44.1 kHz / 16-bit stereo | ≈ 635 MB | ≈ 53 MB | ≈ 5,600 |
| Phone AAC, 128–256 kbps | ≈ 58–115 MB | ≈ 5–10 MB | |
| Streaming copy, AAC 192 kbps (added to every original) | ≈ 86 MB | ≈ 7 MB | |

`lsblk` and `df` count in GiB (1 GiB ≈ 1.074 GB), while the audio sizes above are
decimal GB and MB. The difference (about 7%) is within the margin of these
estimates.

The SSD is **not a backup**. Before storing any real recording, set up backups
(see the pending list).

---

## 10. Battery charge limit (msi-ec)

Status: limit **done and verified** 2026-11-02 (start 50%, end 60%), and
again 2026-11-03 at 15:04 UTC. Survives reboots: **verified for two reboots**
without any extra service (see "Does it survive a reboot?" below); **not
verified** after a cold boot with all power removed. A boot-time service
that re-applies it **exists and is enabled** since 2026-11-03, but has **not
yet run at a real boot** (see "The boot service").

*Why:* a server that is always plugged in keeps its battery at 100%, and a
lithium battery held full and warm wears out faster. Holding it at 60% slows
that down. The laptop's **embedded controller** (EC, a small chip with its
own firmware that handles the keyboard, fans and charging) applies the limit,
not Linux. It does not drain the battery and does not limit performance: it
only stops charging above the end value.

### What was done

1. Ubuntu's kernel 6.8 has an `msi_ec` driver, but it refused this machine:
   `Firmware version is not supported: '1583EMS1.109'` (seen by the owner on
   2026-11-02; no longer in the system log).
2. The newer version of the same driver, the external project
   [BeardOverflow/msi-ec](https://github.com/BeardOverflow/msi-ec), lists
   `1583EMS1.109` in its `ALLOWED_FW_G2_1` group (`msi-ec.c`, commented
   "Pulse GL66 12UEK"; `1583EMS1.110` is commented "Katana GF66 12UG"). The
   driver recognises a laptop by its **EC firmware**, not by its model name,
   so this Katana is supported through a sister model's firmware.
3. It was built and installed with **DKMS** (Dynamic Kernel Module Support:
   it rebuilds the module automatically for every new kernel). It needs
   kernel 6.5 or newer:

   ```sh
   sudo apt install -y build-essential linux-headers-generic dkms
   git clone https://github.com/BeardOverflow/msi-ec ~/msi-ec
   cd ~/msi-ec
   sudo make dkms-install
   ```

   The module goes to `/lib/modules/<kernel>/updates/dkms/`, which takes
   priority over the kernel's own `msi_ec`. `make dkms-install` also writes
   `/etc/modules-load.d/msi-ec.conf` (one line, `msi-ec`), so the module
   loads at every boot. Secure Boot needed one extra step: see
   [section 11](#11-secure-boot-and-the-mok).
4. After the module loaded, both thresholds read `0`. The limit was set
   on purpose:

   ```sh
   echo 60 | sudo tee /sys/class/power_supply/BAT1/charge_control_end_threshold
   ```

   The thresholds then read **start 50, end 60**, and within about 5 seconds
   `upower` changed from `charging` to `fully-charged` at 95%: the EC had
   stopped charging. (Observed by the owner at the time; the command itself
   is in the system log at 12:19 UTC.)

Start and end are **one setting** inside the EC: start is always end minus
10. The driver accepts an end value from 10 to 100; MSI's own three modes are
end 60 / start 50, end 80 / start 70 and end 100 / start 90 (msi-ec README
and `msi-ec.c`). The battery stays at 95% because the EC does not discharge
it; it will only charge again once it drops below 50%.

### Check it

```sh
cat /sys/class/power_supply/BAT1/charge_control_{start,end}_threshold   # 50, 60
cat /sys/class/power_supply/BAT1/{status,capacity}    # Not charging, 95 (until it drifts below 50)
dkms status                                           # msi_ec/0.13, <kernel>, x86_64: installed
lsmod | grep msi_ec
cat /sys/devices/platform/msi-ec/fw_version           # 1583EMS1.109
```

Readings on 2026-11-02 at 17:20 UTC (verified): `50` and `60`;
`Not charging`, 95%; `msi_ec/0.13, 6.8.0-147-generic, x86_64: installed`;
module file `/lib/modules/6.8.0-147-generic/updates/dkms/msi-ec.ko.zst`;
firmware `1583EMS1.109`.

Readings on 2026-11-03 at 15:04 UTC (verified, same commands): `50` and
`60`; `Not charging`, **91%**; the same DKMS line and module file; firmware
`1583EMS1.109`; `modinfo -F signer msi_ec` →
`soundarchive Secure Boot Module Signature key`.

Why 91% and not 95%: the EC stops charging but does not discharge, and the
battery loses charge slowly by itself. Prometheus shows the drift: 95% on
2026-11-02, 93% at 18:10 UTC, 92% at 00:10, 91% from 06:10 on 2026-11-03,
with the charger connected the whole time (`node_power_supply_online` for
`ADP1` never left 1). It will start charging again only below 50%.

### Battery health

The battery reports charge in ampere-hours (`charge_full`,
`charge_full_design`), not watt-hours. On 2026-11-02:
`charge_full` 3,014,000 µAh against `charge_full_design` 4,562,000 µAh,
that is **66% of its design capacity**. `upower` gives the same in energy:
34.36 Wh against 52.01 Wh. At the 60% limit that is about **20 Wh**. The
cycle count always reads 0 (the firmware does not report it).

Verified again on 2026-11-03 at 15:04 UTC: the same two values (66.1%);
`upower` reports `capacity: 66.0675%` and 31.4 Wh stored at 91%.

### Does it survive a reboot?

On 2026-11-02 there was no service that wrote the limit at boot
(`systemctl status battery-charge-limit.service` said the unit could not be
found). Even so, the system log shows the limit was written **once**, at
12:19 UTC, and the machine then went through an abrupt stop (12:45), a boot
(13:20) and a clean reboot (14:58), with no later command touching it. At
17:20 it still read 50/60. So the EC **keeps the setting across reboots**
while the charger is connected.

**Not verified:** a cold boot after removing all power, a fully drained
battery, or a BIOS update; any of them might reset the EC to its default (no
limit, so charging to 100%). That is why the boot service below exists.

### The boot service

`/etc/systemd/system/battery-charge-limit.service` writes `60` to the end
threshold at every boot. It was created and enabled by the owner on
**2026-11-03 at 08:41 UTC** (`systemctl enable --now`); the file is the one
proposed in the first version of section 14:

```ini
[Unit]
Description=Limit battery charge to 60 percent (msi-ec)
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for i in $$(seq 1 30); do [ -w /sys/class/power_supply/BAT1/charge_control_end_threshold ] && break; sleep 1; done; echo 60 > /sys/class/power_supply/BAT1/charge_control_end_threshold'

[Install]
WantedBy=multi-user.target
```

It waits up to 30 s for the driver's file to appear (the module may load a
little later than the service starts), then writes 60. `$$` is how a unit
file writes a literal `$` (systemd itself expands `$NAME`). The start value
follows by itself (end − 10 = 50).

State on 2026-11-03 at 15:04 UTC (verified): `enabled`, `active (exited)`
since 08:41:56 UTC, `status=0/SUCCESS`. The last boot was on 2026-11-02 at
14:58 UTC, **before** the service existed, so it has **never run at a
boot**: the reboot test (docs/MSI_REBOOT_AND_POWER_TESTS.md, test 1) is what
verifies it. Check after any boot:

```sh
systemctl status battery-charge-limit.service     # active (exited) since <this boot>
journalctl -b -u battery-charge-limit.service     # "Finished ..." in this boot
make msi-check                                    # thresholds and service, ✔/✘
```

### After a kernel update: is DKMS still working?

Ubuntu installs updates by itself on the MSI (unattended upgrades on,
automatic reboot off: verified 2026-11-03), so a new kernel can arrive any
night and runs from the next reboot. DKMS should rebuild `msi_ec` for it and
sign it with the same MOK key, so no new enrolment is needed. If that fails,
this is what you see **after the reboot into the new kernel**:

| Where | Working | DKMS did not build the module |
|---|---|---|
| `ls /sys/class/power_supply/BAT1/charge_control_*` | two files | **missing**: no limit, the battery charges to 100% |
| `dkms status` | `msi_ec/0.13, <new kernel>, x86_64: installed` | no line for the new kernel, or `built` without `installed`, or an error |
| `lsmod \| grep msi_ec` | one line | nothing, or the kernel's own old `msi_ec` refused the firmware: `journalctl -k -b \| grep -i msi` shows `Firmware version is not supported: '1583EMS1.109'` |
| `systemctl status battery-charge-limit.service` | `active (exited)` | **failed** (after its 30 s wait it could not write the file) |
| `make msi-check` | ✔ | ✘ on thresholds, the service, `msi_ec` and DKMS |

Fix (with `sudo`): make sure the headers for the running kernel exist, then
build, load and re-apply:

```sh
uname -r                                          # the new kernel
sudo apt install linux-headers-$(uname -r)        # usually already there via linux-headers-generic
sudo dkms install msi_ec/0.13 -k "$(uname -r)"
sudo modprobe msi_ec
sudo systemctl restart battery-charge-limit.service
cat /sys/class/power_supply/BAT1/charge_control_{start,end}_threshold   # 50, 60
```

If `modprobe` answers `Key was rejected by service`, the module is signed
with a key the firmware does not trust: the MOK enrolment was lost (section
11). Until it is fixed, booting the previous kernel from the GRUB menu
(*Advanced options*) brings the limit back.

---

## 11. Secure Boot and the MOK

Status: **done and verified** 2026-11-02 (`mokutil --sb-state` →
`SecureBoot enabled`; the msi-ec module is signed and loads). Verified again
2026-11-03 at 15:04 UTC: `SecureBoot enabled`, `msi_ec` loaded, signer
`soundarchive Secure Boot Module Signature key`.

**Secure Boot** stays on, on purpose: the firmware only starts a boot loader
and kernel signed by a trusted key, and the kernel only loads signed modules.
An out-of-tree module such as `msi-ec` is not signed by Ubuntu, so:

- DKMS created a key of its own for this machine, the **MOK** (Machine Owner
  Key), and signs every module it builds with it
  (`modinfo -F signer msi_ec` → `soundarchive Secure Boot Module Signature key`).
- That key had to be **enrolled** in the firmware once. During the
  installation a one-time password was chosen for it; at the next reboot a
  blue screen, **"MOK management"**, appeared before Ubuntu, and the key was
  enrolled there with that password (the usual steps are *Enroll MOK* →
  *Continue* → *Yes* → password → *Reboot*).
- The one-time password was letters and digits only, in case that screen
  used a US keyboard layout (on a Spanish keyboard some symbols are in other
  places). It is used once and **never written down anywhere**.

When to repeat the enrolment: only after a reinstall, if the firmware's
Secure Boot keys are reset, or if the blue screen was missed (it appears only
once). Then:

```sh
sudo mokutil --import /var/lib/shim-signed/mok/MOK.der    # asks for a new one-time password
sudo reboot                                               # enrol in the blue screen
```

Kernel updates reuse the same key, so they need nothing.

Not recorded in these docs, on purpose: the one-time password and the key's
fingerprint.

---

## 12. Power saving (plan; nothing applied yet)

Status: **plan only**. Nothing below has been changed on the MSI.

A gaming laptop running 24/7 as a server wastes power on parts it does not
need. Before changing anything, measure; after each change, measure again.

### Starting point (read on 2026-11-02 at 17:20 UTC, verified)

| What | Reading | Command |
|---|---|---|
| NVIDIA GPU | `nouveau` driver; **`suspended`** (power control `auto`): 2.38 h suspended against 24 s active since boot | `cat /sys/bus/pci/devices/0000:01:00.0/power/{runtime_status,control}`, `lspci -k -s 01:00` |
| CPU frequency driver | `intel_pstate`, status `active`, governor `powersave`, preference `balance_performance`, turbo allowed (`no_turbo` = 0) | `/sys/devices/system/cpu/cpu0/cpufreq/`, `/sys/devices/system/cpu/intel_pstate/` |
| PCIe power saving (ASPM) | policy `default` (whatever the firmware chose) | `cat /sys/module/pcie_aspm/parameters/policy` |
| Power tools | TLP not installed; `power-profiles-daemon` inactive; `thermald` active | `systemctl is-active tlp power-profiles-daemon thermald` |
| Idle use | CPU about 1% busy; memory about 2.3 GB of 16 GB | Prometheus, 2026-11-02 |

`powersave` with `intel_pstate` active does not mean "slow": the CPU still
speeds up under load; `balance_performance` tells it how eagerly.

One oddity: the 1-minute load average never drops below about 1.0 although
the CPU is almost idle. Kernel threads for USB power management (`kworker/...+usb`,
`+pm`) keep entering the "waiting for I/O" state (`D` in `ps`), which counts
towards the load average without using CPU. At boot the kernel also logs
`usb usb1-port8: connect-debounce failed`. No effect has been measured;
**to confirm** whether it costs power (step 3).

### The plan

The ordered plan, with the exact `sudo` commands, how to measure before and
after, a table for the numbers and how to undo each step, is in
[POWER_TUNING_PLAN.md](POWER_TUNING_PLAN.md) (2026-11-03). Nothing in it has
been applied.

Re-read on 2026-11-03 at 15:05 UTC (verified): the GPU still `suspended`
(`D3cold`, 86,734 s suspended against 37 s active since boot; note that
`lspci` itself wakes it for a few seconds); the CPU settings unchanged; the
embedded controller in `comfort` mode (`/sys/devices/platform/msi-ec/shift_mode`,
choices `eco`, `comfort`, `turbo`).

---

## 13. Time zone

Status: **done** by the owner on 2026-11-03 at about 08:40 UTC, **verified**
the same day at 15:03 UTC: `timedatectl` → `Time zone: Europe/Madrid (CET,
+0100)`, NTP synchronised; `/etc/localtime` → `/usr/share/zoneinfo/Europe/Madrid`.
One loose end: `/etc/timezone` still says `Etc/UTC` (a few programs read that
file instead). **To confirm** how the zone was changed; running
`sudo timedatectl set-timezone Europe/Madrid` once more should leave both in
agreement (not tested).

Before the change, the MSI ran on UTC (`timedatectl` → `Time zone: Etc/UTC
(UTC, +0000)`, verified 2026-11-02); the Lenovo runs on Madrid time. So everything made on
the MSI shows times one hour behind Spain in winter (two in summer): logs,
`date`, and the dates of git commits made there. The two commits of the
guide's repository show it: one made on the MSI is dated `+0000`, one made on
the Lenovo `+0100`, so their times look out of order.

The fix (as applied):

```sh
sudo timedatectl set-timezone Europe/Madrid
timedatectl        # Time zone: Europe/Madrid (CET, +0100)
```

`last`, `uptime` and `journalctl` now print Madrid time; the session logs of
the agent keep writing UTC (`date -u`) and say so.

Containers keep their own time zone (UTC) unless told otherwise. That is
fine: Grafana shows times in the browser's zone.

---

## 14. Still to do

Done since the first version of this list (2026-11-02):

- [x] CPU and RAM recorded (table at the top).
- [x] Docker Engine and the Compose plugin installed, with global log
      rotation ([DEPLOY_MSI.md](DEPLOY_MSI.md), section 1).
- [x] Battery limit at 60% with `msi-ec` (section 10), Secure Boot kept on
      (section 11).
- [x] Sleep disabled for good (section 8, "Never sleep").
- [x] A full rehearsal of DEPLOY_MSI.md on the MSI itself, in a throwaway
      copy that was deleted afterwards (DEPLOY_MSI.md, section 11).
- [x] **Tailscale** installed on the MSI and in the tailnet (verified
      2026-11-03: version 1.104.5, `Running`, MagicDNS on; two more devices
      in the tailnet, a Linux laptop and an Android phone). The MSI's node
      shows no key expiry (it looks disabled; inferred from
      `tailscale status --json`).
- [x] **The real app deployed** (walking skeleton) in `/srv/sound-archive`,
      project `sound-archive`: `caddy`, `api` and `db` healthy, only Caddy
      publishing 80/443 (verified 2026-11-03). The places interface (phase
      3b) is **not** deployed yet.
- [x] **Time zone** Europe/Madrid (section 13), with one loose end
      (`/etc/timezone`).
- [x] **Battery service** `battery-charge-limit.service` created and
      enabled (section 10); **not yet run at a boot**.
- [x] **Firewall: declared enabled by the owner**, 2026-11-03. Without `sudo`
      only indirect signs can be read (verified 2026-11-03):
      `/etc/ufw/ufw.conf` has `ENABLED=yes` (changed 08:42 UTC), `ufw.service`
      is active, `/etc/default/ufw` has `DEFAULT_INPUT_POLICY="DROP"` and
      `IPV6=yes`. **The rules themselves are not verified**: run
      `sudo ufw status verbose`. Remember: ports published by Docker bypass
      ufw. That is why production publishes only Caddy's ports (see
      [DEPLOY_MSI.md](DEPLOY_MSI.md#2-firewall-docker-ports-bypass-ufw)).
- [x] **Backups designed and rehearsed** on dev data:
      [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md). **No real backup yet**:
      the device is an open owner decision.
- [x] Temperatures with the lid closed for a day (section 8, measured from
      Prometheus).
- [x] Read-only checks for after a reboot: `make msi-check` and
      `make msi-snapshot` (`ops/check/`).

Not done yet, roughly in order. Tick them as they are completed, and record
each one in the project log.

- [ ] **Reboot, cold boot and on-battery tests**, then the IPv6 test from
      mobile data and the phone over Tailscale: step by step in
      [MSI_REBOOT_AND_POWER_TESTS.md](MSI_REBOOT_AND_POWER_TESTS.md). The
      last boot was 2026-11-02 14:58 UTC; nothing has been rebooted since
      (verified with Prometheus: `changes(node_boot_time_seconds[3d])` = 0).
      These tests also verify the battery service at a real boot.
- [ ] **Check the ufw rules** (`sudo ufw status verbose`): SSH allowed, and
      nothing else needed outside Docker.
- [ ] **Choose the backup device** and make the first real backup and
      restore test (BACKUP_AND_RESTORE.md, section 5). **Before any real
      recording is stored**, and after accounts exist (no audio in
      production without accounts).
- [ ] **Incoming IPv6:** ports 80/443 (and 22) listen on IPv6 on every
      interface. Check from a phone on mobile data that they are closed
      (MSI_REBOOT_AND_POWER_TESTS.md, test 4).
- [ ] **Wired network:** on 2026-11-03 `enp4s0` was `down` and the server ran
      on Wi-Fi (`wlo1`). If the cable is meant to be connected, check it;
      a cable is more reliable for a server.
- [ ] Router: reserve a fixed IP for each interface by MAC address (or rely on
      Tailscale names).
- [ ] Back up the Lenovo's SSH private key and/or authorize a second key.
- [ ] Check whether there is a free second M.2 slot.
- [ ] Temperatures under audio processing load (phase 5).
- [ ] BIOS: look for an automatic power-on option after a power cut, and for
      a switch that turns the NVIDIA GPU off completely.
- [ ] Power saving: [POWER_TUNING_PLAN.md](POWER_TUNING_PLAN.md), starting
      with a wattmeter.
- [ ] NVMe health (SMART): `sudo smartctl -a /dev/nvme0` (needs
      `smartmontools`; phase B, owner approval pending).
- [ ] Battery: check now and then that it is not swelling (a swollen battery
      lifts the case or the touchpad).
- [ ] If the MSI stops responding again (as at 12:45 UTC on 2026-11-02,
      section 8), note the time and read the end of the previous boot's log:
      `journalctl -b -1 | tail -n 50`.
