# Backing up and restoring the tailnet instance

For the owner. This covers the instance `sa-tailnet`, which keeps audio and photos in a Docker volume. The general design of the backups (restic, encryption, retention, what a good destination is) is in [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md); the scripts here reuse those.

No backup destination has been chosen yet. Until one is, **there is no automatic backup of this instance**.

## What is in a backup

| Part | How | Why that way |
|---|---|---|
| Database | `pg_dump` inside the `db` container, custom format | A consistent picture, even while the app runs |
| Audio originals, listening copies, photos | The `media` volume, copied and then stored by restic | restic only stores what changed, encrypted |
| Certificate authority | **Not included** | Its private key is in `caddy_data`. See below |
| `.env` | **Not included** | It holds passwords. Keep a copy somewhere safe yourself, or be ready to write a new one |

The media is copied first and the database second, so each row refers to a file that is already in the backup.

## Making a backup

```sh
# One time: a password file outside any git repository, mode 600.
openssl rand -base64 32 > ~/.config/sound-archive/restic-password
chmod 600 ~/.config/sound-archive/restic-password

ops/tailnet/backup-instance.sh \
  --repo /path/to/restic-repository \
  --password-file ~/.config/sound-archive/restic-password \
  --project sa-tailnet --init    # --init only the first time
```

It needs free disk space for one extra copy of the media while it runs. Losing the restic password means losing the backups: keep it somewhere other than the MSI.

## Proving a backup can be restored

```sh
ops/tailnet/restore-rehearsal.sh \
  --repo /path/to/restic-repository \
  --password-file ~/.config/sound-archive/restic-password \
  --source sa-tailnet
```

It restores into the throwaway project `sa-test-restore`, with no published ports, and checks that:

1. every table has the same number of rows as the source;
2. every media file has the same SHA-256;
3. restored recordings are served, and each original matches its fingerprint.

It destroys the copy at the end. Run it right after a backup: later changes in the source show up as differences. Do this rehearsal periodically; an untested backup is a hope.

## A real recovery

1. Start from a checkout of the code and a `.env` with the same database user and database names.
2. Restore with `ops/backup/restore.sh --project sa-tailnet --env-file .env --media-target <empty folder> --source-project sa-tailnet --compose-override compose.tailnet.yaml --with-web`. The project must not exist yet.
3. Load the files into the volume:

   ```sh
   docker run --rm -v <empty folder>:/in:ro -v sa-tailnet_media:/media busybox:1.37.0 \
     sh -c 'cp -a /in/. /media/ && chown -R 10001:10001 /media'
   ```

4. If the `caddy_data` volume was lost, Caddy creates a **new certificate authority**: export the new `root.crt` (`make tailnet-ca-export`) and install it again on every device.

## Rehearsed

Results of the rehearsal against a test stack are in `docs/ACCEPTANCE.md`. Step 2 of a real recovery, with `--compose-override compose.tailnet.yaml`, has not been run: the rehearsal used `compose.restore.yaml`, which differs only in publishing no ports.
