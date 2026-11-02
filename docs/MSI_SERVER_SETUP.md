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
| CPU | to check: `lscpu \| head -20` (the core layout, 6 performance + 8 efficient, suggests an i7-12700H) |
| RAM | to check: `free -h` |
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

Status: lid and screen settings **done and verified** 2026-11-02; BIOS settings
and closed-lid temperatures **pending**.

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

### Cooling

With the lid closed the laptop cools less well. Keep the air vents free, put
it on a hard surface (not fabric), and raise it slightly if possible.

### BIOS settings (searched, not changed)

- **Power on after a power cut** ("Restore after AC power loss"): MSI desktop
  boards have it under Advanced / Power Management Setup. Not confirmed on
  this laptop.
- **Battery charge limit:** on MSI laptops this is not a BIOS option. Windows
  programs handle it (Battery Master in Dragon Center / MSI Center), and
  Windows has been erased. Check whether Linux exposes it:

  ```sh
  ls /sys/class/power_supply/BAT1/      # look for charge_control_end_threshold
  ```

  Until then there is no limit. MSI's default behaviour: charging stops at
  100% and resumes below 89%.

> **The battery works as a UPS.** Short power cuts do not turn the server off.
> Only a long cut that drains the battery would need someone to press the
> power button, if the BIOS has no automatic power-on. Wake-on-LAN is a
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

## 10. Still to do

Not done yet. Tick them as they are completed, and record each one in the
project log.

- [ ] Record CPU and RAM: `lscpu | head -20` and `free -h`.
- [ ] Firewall (allow SSH **before** enabling, or you lock yourself out):

  ```sh
  sudo ufw allow OpenSSH
  sudo ufw enable
  sudo ufw status verbose
  ```

  Remember: ports published by Docker bypass ufw. That is why production
  publishes only Caddy's ports (see [DEPLOY_MSI.md](DEPLOY_MSI.md#2-firewall-docker-ports-bypass-ufw)).

- [ ] **Tailscale:** install it on the MSI (<https://tailscale.com/download/linux>),
      run `sudo tailscale up`, install it on the Lenovo and the phone. Consider
      disabling key expiry for the MSI in the Tailscale admin console, so it
      does not drop off the network every few months.
- [ ] **Read-only deploy key** so the MSI can clone the private repository:

  ```sh
  ssh-keygen -t ed25519 -C "msi-deploy" -f ~/.ssh/sound_archive_deploy
  cat ~/.ssh/sound_archive_deploy.pub
  ```

  Add the public key on GitHub under the repository's **Settings → Deploy
  keys**, **without** write access. Because the key does not have the default
  name, tell SSH to use it for GitHub, in `~/.ssh/config`:

  ```
  Host github.com
      IdentityFile ~/.ssh/sound_archive_deploy
  ```

- [ ] Continue with [DEPLOY_MSI.md](DEPLOY_MSI.md): Docker Engine and the
      Compose plugin from Docker's apt repository, the `docker` group, a first
      test with `docker run --rm hello-world`, `git clone`, and the first real
      run of the production stack. Fix anything unclear in that file as you go.
- [ ] Router: reserve a fixed IP for each interface by MAC address (or rely on
      Tailscale names).
- [ ] Back up the Lenovo's SSH private key and/or authorize a second key.
- [ ] External USB disk for backups, before any real recording is stored.
- [ ] Check whether there is a free second M.2 slot.
- [ ] Temperatures with the lid closed, and under audio processing load.
- [ ] BIOS: look for an automatic power-on option after a power cut.
- [ ] Battery: check for `charge_control_end_threshold`; check now and then
      that the battery is not swelling (a swollen battery lifts the case or the
      touchpad).
