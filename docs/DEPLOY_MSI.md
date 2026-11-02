# Deploying to the MSI (Ubuntu Server)

A checklist to follow by hand over SSH. Commands starting with `sudo` change
the system; everything else runs as your normal user.

The MSI runs the **same containers** as the dev laptop, combined with
`compose.prod.yaml` instead of `compose.dev.yaml`. Code arrives through git,
never by copying files.

---

## 0. Prerequisites (do these yourself first)

- [ ] The machine is prepared following [MSI_SERVER_SETUP.md](MSI_SERVER_SETUP.md):
      OS install, disk, network, key-only SSH, running with the lid closed,
      firewall, Tailscale and a read-only deploy key. This file starts where
      that one ends.
- [ ] Ubuntu Server on the MSI, x86_64, up to date: `sudo apt update && sudo apt upgrade`
- [ ] **SSH key-only login**: your public key is in `~/.ssh/authorized_keys`,
      and `PasswordAuthentication no` is set in the SSH server config. Test
      that a key login works **before** turning passwords off.
- [ ] **Tailscale** installed on the MSI and on your laptop, both in your
      tailnet. Note the MSI's Tailscale name or IP (`tailscale ip -4` on the MSI).
- [ ] You can `ssh <user>@<msi-tailscale-name>` from your laptop.
- [ ] The repository is pushed to a remote (GitHub, GitLab...) that the MSI
      can clone from.

Lessons from the first install (2026-11-02). Details are in
[MSI_SERVER_SETUP.md](MSI_SERVER_SETUP.md):

- **Disk size.** Ubuntu's guided LVM layout gives the root filesystem only
  about 100 GB and leaves the rest of the disk unallocated. Check `df -h /`;
  if it is small, extend it (section 5 there). Otherwise Docker images and the
  database run out of space long before the disk is full.
- **Wi-Fi.** Ubuntu Server may not include `wpasupplicant`. Install it, with
  the cable connected, **before** applying a Wi-Fi netplan config (section 6
  there).
- **Netplan files.** Leave the installer's `50-cloud-init.yaml` untouched and
  put Wi-Fi in its own file (`60-wifi.yaml`, `chmod 600`). Apply changes with
  `sudo netplan try`, which rolls back by itself if you lose the connection.
- **Lid closed.** The server must ignore the lid switch, or closing the lid
  suspends it. See section 8 there.

---

## 1. Install Docker Engine and the Compose plugin

These are Docker's official steps for Ubuntu (source:
<https://docs.docker.com/engine/install/ubuntu/>; check it if anything below
fails). Don't use the `docker.io` package from Ubuntu or the snap; they
lag behind and conflict with these packages.

- [ ] Remove conflicting packages. It's normal if apt says none are installed.

  ```sh
  sudo apt remove $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc | cut -f1)
  ```

- [ ] Add Docker's signing key and apt repository:

  ```sh
  sudo apt update
  sudo apt install ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc

  sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
  Types: deb
  URIs: https://download.docker.com/linux/ubuntu
  Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
  Components: stable
  Architectures: $(dpkg --print-architecture)
  Signed-By: /etc/apt/keyrings/docker.asc
  EOF

  sudo apt update
  ```

- [ ] Install Docker, the Compose plugin, plus git and make:

  ```sh
  sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git make
  ```

- [ ] Let your user run `docker` without `sudo`, then **log out and SSH in again**:

  ```sh
  sudo usermod -aG docker $USER
  ```

- [ ] Verify (both should print versions, with no "permission denied"):

  ```sh
  docker version
  docker compose version
  ```

Docker starts automatically at boot (systemd service `docker`). With
`restart: unless-stopped` in `compose.prod.yaml`, the app comes back after a
reboot too.

---

## 2. Firewall: Docker ports bypass ufw

> **Important.** When Docker publishes a container port (a `ports:` entry in
> Compose), it writes its own iptables rules, and those are checked
> **before** ufw's rules. So `sudo ufw deny 5432` would **not** block a
> published database port: it would still be open to the network.
>
> The real protection is to **not publish what should stay private**. That
> is why `compose.prod.yaml` publishes only Caddy's **80, 443 and
> 443/udp**, and never the database (5432) or the API (8000). Those are
> reachable only on Docker's internal network. `make prod-check` verifies
> this.
>
> ufw is still useful for everything *outside* Docker (e.g. SSH). If you
> enable it, allow SSH first so you don't lock yourself out:
> `sudo ufw allow OpenSSH && sudo ufw enable`.

---

## 3. Get the code

- [ ] Create the project directory and clone. `/srv` is the usual place for
      things a server serves.

  ```sh
  sudo mkdir -p /srv/sound-archive
  sudo chown $USER:$USER /srv/sound-archive
  git clone <repo-url> /srv/sound-archive
  cd /srv/sound-archive
  ```

  (A private repository needs credentials on the MSI, for example a
  read-only *deploy key* added to the repository. How to create it:
  [MSI_SERVER_SETUP.md, section 10](MSI_SERVER_SETUP.md#10-still-to-do).)

---

## 4. Configure `.env`

- [ ] Create it from the template and make it readable only by you:

  ```sh
  cp .env.example .env
  chmod 600 .env
  ```

- [ ] Generate two strong passwords:

  ```sh
  openssl rand -base64 32 | tr -d '/+='
  openssl rand -base64 32 | tr -d '/+='
  ```

- [ ] Edit `.env` (`nano .env`) and set:
  - `POSTGRES_PASSWORD`: the first password
  - `APP_DB_PASSWORD`: the second password (must be different)
  - `CADDY_SITE_ADDRESS=:80` (plain HTTP; see section 10 for HTTPS)
  - optional, `DB_DATA_DIR`: keep the database on a bigger disk, e.g.
    `DB_DATA_DIR=/mnt/bigdisk/sound-archive/postgres`. Create the folder first
    (`sudo mkdir -p /mnt/bigdisk/sound-archive/postgres`). The Postgres
    container sets its owner itself. Use an **absolute** path.
  - `DEV_HTTP_PORT` and `DEV_DB_PORT` are ignored in prod.

> Passwords and `DB_DATA_DIR` take effect only when the database is created
> for the first time. Decide them **before** the first start. Changing them
> later does not change an existing database.

- [ ] Back up the `.env` contents somewhere safe (a password manager). It is
      not in git, so if the MSI's disk dies, it's gone.

---

## 5. Start

- [ ] Check the configuration first:

  ```sh
  make prod-check
  ```

  Expected: `OK: prod config is valid; db and api publish no ports.`
  It also fails if a `TEST_ADMIN_*` variable (the admin password used only by
  the dev tests, see `compose.dev.yaml`) ended up in the prod configuration.
  It checks names only and never prints values.

- [ ] Build and start (first time: a few minutes to download and build):

  ```sh
  make prod-up
  ```

  It returns once every service is healthy. Then:

  ```sh
  make prod-ps
  ```

  `db`, `api`, `caddy` should be `Up ... (healthy)`; `migrate` should be
  `Exited (0)`. That is correct, because it is a one-shot job.

---

## 6. Verify

- [ ] On the MSI itself:

  ```sh
  curl http://localhost/api/health      # {"status":"ok"}
  curl http://localhost/api/health/db   # {"status":"ok","postgresql_version":...}
  ```

- [ ] From your laptop, over Tailscale:

  ```sh
  curl http://<msi-tailscale-name>/api/health
  ```

  and open `http://<msi-tailscale-name>/` in a browser: both boxes green.

- [ ] Confirm the database port is **not** reachable from outside. Run this
      from your laptop; it should fail or time out:

  ```sh
  nc -zv -w 3 <msi-tailscale-name> 5432
  ```

---

## 7. Update to a new version

```sh
cd /srv/sound-archive
git log --oneline -1          # note the current commit, in case you need to roll back
git pull
make prod-check
make prod-up                  # rebuilds the API image, re-runs migrations, restarts what changed
make prod-ps
curl http://localhost/api/health/db
```

`make prod-up` re-creates only the containers whose image or configuration
changed. The database data is untouched.

To also pick up bug-fix releases of the Postgres/PostGIS and Caddy images
(same version line, see `docs/ARCHITECTURE.md`), run this before
`make prod-up`:

```sh
docker compose -f compose.yaml -f compose.prod.yaml pull db caddy
```

Old images pile up over time. Clean them now and then with
`docker image prune`.

---

## 8. Logs

```sh
make prod-logs                    # all services, follow (Ctrl+C to stop)
make prod-logs SERVICE=api        # one service: api, db, caddy, migrate
docker compose -f compose.yaml -f compose.prod.yaml logs --since 1h caddy   # last hour
```

Logs are rotated: at most 5 files × 10 MB per container (set in
`compose.prod.yaml`), so they cannot fill the disk.

---

## 9. Roll back to a previous commit

If an update breaks something:

```sh
cd /srv/sound-archive
git log --oneline                 # find the last good commit, e.g. a1b2c3d
git switch --detach a1b2c3d       # check out that exact version
make prod-up                      # rebuild and restart with the old code
```

When the fix is pushed, return to normal updates with `git switch main`
and `git pull`.

> **Careful with migrations.** Rolling back the *code* does not roll back
> the *database schema*. If the broken update added a migration, first undo
> it **while the new code is still checked out** (the old code doesn't know
> about it):
>
> ```sh
> docker compose -f compose.yaml -f compose.prod.yaml run --rm migrate alembic downgrade -1
> ```
>
> Then do the `git switch --detach` steps above. Some migrations cannot be
> undone without losing data. There are no backups yet (planned for a later
> phase), so look at a migration before applying it in prod.

---

## 10. Later: a public domain with HTTPS

Today the site is plain HTTP, reachable over Tailscale. To serve it publicly
over HTTPS:

1. [ ] Get a domain and create a DNS **A** record (and **AAAA** for IPv6)
       pointing to your home's **public** IP.
2. [ ] On your router, forward TCP **80** and **443** (and UDP 443 for
       HTTP/3) to the MSI. Let's Encrypt must reach port 80 or 443 from the
       internet to issue the certificate.
3. [ ] In `.env`, set the domain (no `http://`, no trailing slash):

   ```sh
   CADDY_SITE_ADDRESS=archive.example.com
   ```

4. [ ] Apply it: `make prod-up` (re-creates Caddy with the new setting).
5. [ ] Watch Caddy get the certificate: `make prod-logs SERVICE=caddy`. Look
       for "certificate obtained successfully". Then open
       `https://archive.example.com`.

That is the whole switch: Caddy handles certificates, renewal and the
HTTP→HTTPS redirect automatically. Certificates are stored in the
`caddy_data` volume, so they survive restarts.

Notes:

- Once the address is a domain, Caddy answers only for that name. Visiting
  `http://<msi-tailscale-name>/` no longer shows the site. Use the domain.
- To go back to plain HTTP, set `CADDY_SITE_ADDRESS=:80` and `make prod-up`.
- Opening ports on your router makes the MSI reachable from the whole
  internet. Only Caddy is published (section 2), but keep the system updated.
