# Backup and restore

Status (2026-11-03): **design and scripts ready, rehearsed on dev data; no
real backup exists yet.** The backup device has not been chosen (an owner
decision, see [Destinations](#destinations-pending-owner-decision)). Until
it is chosen and the first real backup has been restored once, **the MSI has
no backup**.

> **The rehearsal repository is not a backup.** The rehearsal ran against a
> folder on the MSI's own disk (`~/sa-ops-ensayo-copias/`, deleted
> afterwards). A copy on the same disk dies with the disk.

Owner decisions this design follows:

- **No audio goes into production before accounts exist.** Invitation-only
  accounts (D-47) come first, then audio. So today production holds only
  places; the audio part of the backup is designed and rehearsed with
  synthetic files, ready for when audio arrives.
- **restic** is the backup tool; the database is dumped with **`pg_dump`
  inside the database container**, and the dump goes into the restic
  repository.
- Recordings can be up to **2 GB** each (D-48).
- Backups are prepared now; the device is chosen later. The scripts take the
  destination as a required setting, never a default.

---

## 1. What is backed up, and why

| What | How | Why |
|---|---|---|
| **Database** | `pg_dump --format=custom` run inside the `db` container, as the admin user, with the container's own variables | Every place (and later every recording's metadata) lives here. A dump is a consistent snapshot even while the app runs: PostgreSQL gives `pg_dump` one frozen view of the data (MVCC), so nobody has to stop the site. The custom format is compressed and lets `pg_restore` pick or reorder objects. |
| **Media files** (audio, later photos) | restic reads the folder directly | The recordings themselves. They do not exist yet. |
| **Caddy's certificates** (`caddy_data` volume) | restic, once there is a domain | Not essential (Let's Encrypt can issue new ones), but Let's Encrypt limits how many certificates per week a domain gets; a restore that has to re-issue them all can hit that limit. Today the site has no domain, so there is nothing to copy. |
| **Configuration without secrets** | it is in git (`compose*.yaml`, `infra/`, `.env.example`); the backup records **which commit** was running (`git rev-parse HEAD` of `/srv/sound-archive`) | The code is already backed up by GitHub. What a restore needs to know is the exact version that wrote the dump. |
| **Panel configuration** (`~/msi-monitor`, optional) | restic, **excluding `.env`** | That repository has **no remote**: its dashboards and settings exist only on the MSI disk. The metrics themselves are not worth backing up. |

### The media folder: `MEDIA_DIR`

The app does not store files yet. When it does (phase 5), the folder will be
set by one variable in `.env`:

```sh
MEDIA_DIR=/srv/sound-archive-media     # proposed path on the MSI
```

*Why outside `/srv/sound-archive`:* that folder is a git checkout. Keeping
the recordings elsewhere means no `git clean`, re-clone or `rm -rf` of the
code can touch them, and the folder can later become the mount point of a
second disk. The backup scripts already take this folder as an argument
(`--media`); in the rehearsal it was a folder of synthetic files.

### What is deliberately NOT in the automatic backup: secrets

`.env` (database passwords, `GRAFANA_ADMIN_PASSWORD`) and the restic
password are **not** in the automatic backup.

*Why:*

- The restic password is needed **to open** the backup, so it cannot be
  inside it. It must exist outside the MSI anyway.
- If `.env` were inside, whoever obtained the restic password would get every
  other password with it. Separate keeping limits the damage of one leak.
- `.env` changes rarely and is small: a manual copy is enough.

How the owner keeps them: each value in the **password manager** (one entry
per secret: "Sound Archive: POSTGRES_PASSWORD", "...: APP_DB_PASSWORD",
"...: restic", "...: Grafana admin"), and the restic password also on
**paper**, in a safe place at home. After any change to `.env`, update the
password manager the same day.

Passwords can be **new** after a restore: the scripts create the database
users from the new `.env`. What must stay the same are the **user names**
(`POSTGRES_USER`, `APP_DB_USER`, `POSTGRES_DB`), because the dump's
permissions (`GRANT ... TO sound_app`) name them.

---

## 2. What is NOT a backup

| Not a backup | Why not |
|---|---|
| The Docker volume (`sound-archive_db_data`) | It is the live data, on the same disk. `docker compose down -v` deletes it in one command. |
| A copy on the same disk (like the rehearsal folder) | Protects against "I deleted a row", not against the disk failing, being stolen or burning. |
| RAID or a mirrored disk | Copies every change instantly, **including deletions and corruption**. It keeps the server running when a disk dies; it does not let you go back in time. |
| A synced folder (Dropbox-style) | The same: a deletion is synced too. |
| Git, for audio | Not designed for large binary files; GitHub rejects files over 100 MB. |

**The 3-2-1 rule:** keep **3** copies of the data (the live one + 2
backups), on **2** different kinds of storage, with **1** of them in another
place (offsite). Why each number: one backup can fail silently, so two; one
kind of device can share a defect or a cause of failure, so two kinds; a
fire, flood or theft takes everything in the house, so one far away. For
this project the target is: the MSI's SSD (live) + a USB disk or second SSD
at home + an encrypted restic copy outside the home.

---

## 3. Encryption and the password

restic **encrypts everything** (AES-256) before writing it, and checks that
nothing was altered (each piece carries a MAC). The repository is unreadable
without the password, which is why a remote copy on someone else's server is
acceptable.

- **Who has it:** the owner only. It lives in the password manager and on
  paper. On the MSI it is a file readable only by its user (for example
  `~/.config/sound-archive/restic-password`, `chmod 600`), which the scripts
  read by **path** (`--password-file`); its value never appears in a
  command, an environment variable or a log. The coding agent never sees
  it: the owner creates it.
- **If it is lost, the backup is lost.** There is no recovery, no reset, no
  back door: that is what encryption means. Keep it in two places outside
  the MSI. If the MSI dies, the copy on the MSI dies with it.
- restic supports several keys for one repository (`restic key add`), for
  example a second password kept by a trusted person.

The throwaway passwords used in the rehearsal were generated with
`openssl rand`, kept in a temporary file (`chmod 600`) outside every
repository, and deleted at the end.

---

## 4. Frequency, retention, RPO and RTO

**Proposal (to confirm when the device is chosen):**

| | Proposal | Why | Alternatives |
|---|---|---|---|
| When | **Every night at 03:30** (Madrid time), database + media in the same run | The site is quiet; one restic snapshot holds a dump and the files that match it | Every 6 h for the database only (the dump is small); real-time copies of the database (WAL archiving, point-in-time recovery) when there are many users: more complex, not needed now |
| Keep | **7 daily, 4 weekly, 12 monthly** (`restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune`) | A mistake noticed within a week can be undone to the day; within a year, to the month | Longer monthly retention if storage allows. Note: a recording deleted on purpose stays in old snapshots until they expire (12 months) |
| Check | `restic check` after every backup; `restic check --read-data-subset=10%` monthly; **a full restore test monthly** (`make restore-test`) | `check` proves the structure; reading data proves the bytes; only a restore proves you can get it back | Quarterly restore test, once it has passed several times |

**RPO (recovery point objective):** how much work you can lose. With a
nightly backup, at most **24 hours** of new places and recordings.

**RTO (recovery time objective):** how long getting back takes. The
rehearsal measured the restore of the database and the files themselves:
about **20 s** for 2.2 GB from a local repository (section 8); a real restore after a disk failure adds the time to get
hardware, install Ubuntu and Docker (MSI_SERVER_SETUP.md and DEPLOY_MSI.md,
a few hours by hand), and to download the data if it comes from a remote
copy (a home connection: about **1 hour per 10 GB at 25 Mbit/s**, an
estimate).

Order of the backup run, and why: **dump first, then the files**, in one
snapshot. A recording uploaded between the two steps ends up as a file with
no row (harmless, can be cleaned up); the reverse order could leave rows
pointing to files that are not in the backup.

---

## 5. Destinations (pending owner decision)

Prices are **rough estimates, not verified** (late 2026, Spain), only to
compare.

| | USB disk | Second SSD in the MSI | Remote encrypted restic |
|---|---|---|---|
| What | An external 2–4 TB hard disk, connected to the MSI | An M.2 SSD in the second slot, **if the MSI has one free** (not checked yet) | A restic repository on a storage service (Backblaze B2, Hetzner Storage Box, S3-compatible) or a `rest-server` at a relative's house |
| Cost (estimate) | 70–120 € once | 50–90 € per TB once | about 4–7 € per TB per month |
| Protects against | SSD failure, deleted data | SSD failure, deleted data | **everything at home**: fire, theft, flood, power surge |
| Does not protect against | fire/theft (same house); a surge if plugged in | **anything that affects the laptop** (same machine, same power supply, same theft) | — |
| Speed | fast (USB 3) | fastest | limited by the home **upload** speed: the first full copy of 300 GB at 20 Mbit/s takes about 33 h |
| Weak points | must stay connected (or be connected weekly by hand); USB disks disconnect; needs mounting (`/etc/fstab` with `nofail`, `sudo`) | slot not confirmed; opening the laptop | credentials for the service; monthly cost; restore is slow |
| What changes in the scripts | `--repo /mnt/<disk>/sound-archive-restic`; the script checks the folder is a mounted disk (`mountpoint -q`), so it never writes to the internal SSD by mistake when the disk is unplugged | `--repo /mnt/<ssd>/sound-archive-restic`, same check | `--repo s3:...`, `b2:...`, `sftp:...` or `rest:...`; the service's credentials in a second file read by the container; the restic container needs a network (`RESTIC_NETWORK=bridge`), while local repositories run with `--network none` |

**Recommendation for later (not a decision):** start with the **USB disk**
(cheap, fast, enough for the first real recordings), and add the **remote
copy** before the archive holds recordings that cannot be made again. Both
together satisfy 3-2-1. The second SSD is better used as **space** for the
live media than as a backup.

---

## 6. Restore: order and why

A restore goes into an **empty** Compose project: after a disk failure, a
fresh install; in a test, the throwaway project `sa-restore`.

1. **Secrets and code.** `.env` from the password manager (same user names,
   passwords may be new); the code at the commit recorded in the backup.
   *Why first:* nothing starts without them.
2. **Restore the snapshot** from restic into a folder (`restic restore
   latest --target ...`): the dump and the files.
3. **Database container only** (`docker compose up -d --wait db`). On its
   first start it runs `infra/postgres/init/20-create-app-user.sh`, which
   creates the **limited API user** and its default privileges.
   *Why not the API yet:* it would serve an empty site; and do **not** run
   `migrate` before the restore, or it would create empty tables that clash
   with the dump.
4. **`pg_restore`** of the dump, as the admin user, inside the container
   (`--no-owner --exit-on-error`): tables belong to the admin user, as on
   the original, and the dump's `GRANT`s give the limited user its rights
   back. The PostGIS extensions already exist (the image creates them) and
   the dump uses `CREATE EXTENSION IF NOT EXISTS`.
5. **Media files** back into `MEDIA_DIR`, **before** the API starts, so no
   row points to a missing file.
6. **`migrate`** (`alembic upgrade head`): `alembic current` must show the
   revision recorded in the dump; if the code is newer, this applies the new
   migrations on top. *Why after the restore:* migrations expect the data to
   be there.
7. **API** (connects as the **limited** user, never the admin) and then
   **Caddy**, the only public part, last.
8. **Checks** (what `make restore-test` does): same number of rows, the API
   returns the same places, `alembic current` correct, the limited user can
   read and write rows but **cannot** alter or drop tables, SHA-256 of every
   file equal to the original.

The restore must end with the API using its **limited account**. Restoring
"as admin, and fixing permissions later" is how an app ends up running as
a superuser for months.

---

## 7. The scripts

All in `ops/backup/`, checked with ShellCheck (`make shellcheck`). None has a
default destination: a missing repository is an error, so nobody backs up
"somewhere" by accident.

| Script | What it does |
|---|---|
| `backup.sh --repo R --password-file F --project P [--media DIR] [--status-file S]` | Dumps the database of Compose project `P` inside its `db` container, backs up the dump (and `DIR`) with restic in a container (`--network none` for local repositories, pinned image), runs `restic check`, writes a status file. |
| `restore.sh --repo R --password-file F --project P --env-file E --target DIR` | Restores the latest snapshot into a new, empty Compose project `P`, in the order of section 6. |
| `restore-test.sh --repo R --password-file F --source-project S [--media DIR]` | Restores into `sa-restore`, compares it with the source project (rows, API, `alembic current`, limited user, SHA-256), and destroys `sa-restore` at the end, even if a check failed. |

Make targets (the destination is always explicit):

```sh
make backup       RESTIC_REPO=<repo> RESTIC_PASSWORD_FILE=<file> [MEDIA_DIR=<dir>]
make restore-test RESTIC_REPO=<repo> RESTIC_PASSWORD_FILE=<file> [MEDIA_DIR=<dir>]
```

The panel can show the age of the last good backup: a proposal for
node_exporter's textfile collector and an alert is in the session's
`propuestas/` folder (not applied to the panel).

---

## 8. Rehearsal (2026-11-03, verified)

Against the **dev** stack (`sa-ops`, 322–323 made-up places from
`make seed-dev`) and **synthetic media** made by
`ops/backup/make-test-media.sh` (random bytes, the worst case: like real
compressed audio, it neither compresses nor deduplicates). Repository and
throwaway password in `~/sa-ops-ensayo-copias/`, on the MSI's own disk:
**not a backup**, deleted afterwards. Production was not touched. Same
disk for source and repository, so the speeds below are an upper bound.

| # | Test | Result | Measured |
|---|---|---|---|
| 1 | First backup (`--init`), 21 files, 196 MiB + dump | ✔, `restic check`: no errors | **6 s** total; repository 197 MB; dump 29 KiB, 33 entries |
| 2 | Second backup after changes (+2 files of 4 MiB, −1 file of 11 MiB, +1 place) | ✔ incremental: `2 new files, 2 changed ... 8.1MiB added`; `restic diff` shows exactly the changes | **2.7 s**; repository 205.1 → 213.6 MB (+8.4 MB) |
| 3 | `make restore-test` into `sa-restore` | ✔ all 11 checks: rows 323 = 323; `/api/places` identical (same hash); `alembic current` `0002 (head)`; API connected as `sound_app`, not a superuser; it reads, inserts, updates and deletes but cannot `ALTER`, `DROP`, `TRUNCATE` or `CREATE`; SHA-256 of 21 files identical | restore **17 s** (restic 3, db start 4, pg_restore 1, migrate 6, api 2); 20.7 s with teardown |
| 4 | One 2 GiB file (D-48) | ✔ backup and restore, SHA-256 identical | generate 4.2 s; backup **7.5 s** (restic 5 s, ≈ 430 MB/s); repository +2.15 GB; restore **19 s** (restic 5 s); free disk back to 421 GB after teardown |
| 5 | One byte changed in one repository file (a pack holding part of one recording) | ✔ detected by `restic check --read-data` (`ciphertext verification failed`, exit 1); **not** by plain `restic check` (exit 0) | `--read-data` over 2.3 GB: 3.5 s |
| 6 | Wrong password | ✔ the repository does not open: `Fatal: wrong password or no key found` (exit 12) for restic, `make backup` and `make restore-test`; the status file records the failure | — |

After all tests, `make restore-test` passed again from start to end (19 s
restore). Retention (`--forget`) was also tried: of 7 snapshots of the same
day, 2 were kept (the newest, and the oldest daily one, a restic 0.19 rule).

**First real value of the RTO:** about **20 seconds** to restore a
database of a few hundred rows and 2.2 GB of media, from a local repository,
onto a machine that already has Docker, the images and the code. Add the
transfer time from the real device (USB 3: minutes for hundreds of GB; a
remote copy over a home connection: hours) and, after a disk failure, the
reinstall.

**What the corruption test teaches.**

- Plain `restic check` (after every backup) checks the structure: it would
  not have noticed. The monthly `restic check --read-data-subset=10%` (or a
  full `--read-data` on a local disk, where it is fast) is what finds damaged
  bytes. On a remote repository `--read-data` downloads everything, so use a
  subset there.
- To recover, restic says what to do, and it was done in the rehearsal:
  1. `restic repair packs <id>`: keeps the intact parts of the damaged file
     and removes it (it saves a copy first in the **current folder**, which
     must be writable: in the container, mount a folder and use `-w`; the
     first attempt without it failed with `permission denied`);
  2. **back up again while the originals still exist**: the missing piece
     has the same content, so the same ID, and the old snapshots become
     complete again. After that, `restic check --read-data`: no errors.
  3. If the original is gone too, `restic repair snapshots --forget` removes
     the damaged file from the old snapshots: that recording is lost from
     this repository, and only the **second** backup can bring it back.
     That is why 3-2-1 asks for two backups.
- During the repair, `backup.sh` reported the run as **failed** (restic
  exited non-zero on the half-repaired repository; the exact reason was not
  captured) and kept the time of the last success in the status file. That
  is the behaviour the alert relies on.

Evidence (commands and trimmed output): the session's `evidencias/`
folder, files `h4-*.txt`.
