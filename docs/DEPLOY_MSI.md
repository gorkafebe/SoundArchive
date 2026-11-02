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

- [ ] Rotate the logs of **every** container by default. `compose.prod.yaml`
      already caps this app's logs; this sets the same limit for any other
      container on the machine (for example the monitoring panel). Create
      `/etc/docker/daemon.json` (`sudo nano /etc/docker/daemon.json`) with:

  ```json
  {
    "log-driver": "json-file",
    "log-opts": { "max-size": "10m", "max-file": "5" }
  }
  ```

  Then restart Docker: `sudo systemctl restart docker`. Running containers
  are restarted too, and the setting applies only to containers created
  after the change.

Status on the MSI: **done** 2026-11-02 (Docker Engine 29.9.2, Compose v5.6.1,
`daemon.json` as above; checked with `cat /etc/docker/daemon.json`).

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

- [ ] The same check without a second machine, on the MSI. Nothing should
      listen on the database or API ports, and only Caddy should publish:

  ```sh
  ss -tln | grep -E ':(5432|5433|8000) '        # prints nothing
  docker ps --format 'table {{.Names}}\t{{.Ports}}'
  ```

  Only the `caddy` line shows published ports (`0.0.0.0:80->80/tcp`,
  `[::]:80->80/tcp`, the same for 443 and `443/udp`). `api` shows `8000/tcp`
  and `db` `5432/tcp`: those are internal, not published.

> **Who can reach the site.** `"80:80"` publishes on **every** network
> interface, IPv4 and IPv6 (that is what `0.0.0.0` and `[::]` mean). So the
> site is reachable from any device on the home network, not only over
> Tailscale, and ufw does not change that (section 2). The MSI also has
> public (global) IPv6 addresses (`ip -6 addr show scope global`). If the
> router lets incoming IPv6 connections through, ports 80 and 443 are open to
> the internet **without** any port forwarding. Most home routers block
> incoming IPv6 by default; check yours (look for an IPv6 firewall setting),
> or test from a phone on mobile data, Wi-Fi off, while the stack runs.
> Status: published on IPv6 **verified** in a rehearsal on the MSI
> (2026-11-02); reachable from outside **not verified**.

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

What each kind of change needs (checked in a rehearsal on the MSI,
2026-11-02):

| What changed in the pull | What applies it |
|---|---|
| `web/` (the page) | Nothing: it is live as soon as `git pull` finishes, because Caddy serves the folder directly. |
| `backend/`, dependencies, migrations | `make prod-up` |
| `.env` or a `compose*.yaml` file | `make prod-up` |
| `infra/caddy/Caddyfile` | **also** `docker compose -f compose.yaml -f compose.prod.yaml restart caddy` (see below) |

- **Caddyfile changes are not picked up by `make prod-up`.** The Caddyfile is
  mounted into the container as a single file. `git pull` replaces that file
  with a new one, and the running container keeps reading the old one; Caddy
  also does not reload its configuration by itself. `make prod-up` does not
  re-create Caddy, because its Compose settings did not change. So after a
  pull that touches the Caddyfile, restart Caddy:

  ```sh
  docker compose -f compose.yaml -f compose.prod.yaml restart caddy
  ```

  To see which files a pull changed, run `git diff --stat HEAD@{1} HEAD`
  right after it.

- **The API restarts on every `make prod-up`, even with no changes.** Every
  build produces a new image ID, so Compose re-creates `api` and `migrate`
  each time. Measured: during a `make prod-up` with nothing to change,
  `/api/*` answered `502` for about 3 seconds; the page itself stayed up.
  Harmless today; worth knowing once people use the site.

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

Caddy's access log records every request with the visitor's IP address and
request headers. That is useful for debugging, and it is personal data once
the site is public.

### When a service is down

`restart: unless-stopped` brings a service back when its **process** dies,
but not when **you** stop it. Measured in a rehearsal on the MSI
(2026-11-02):

| What happened | Result |
|---|---|
| The API process exited | Docker restarted it; healthy again after about 2 s |
| PostgreSQL crashed (`pg_ctl stop -m immediate`) | Docker restarted it; it recovered by itself; `/api/health/db` back to 200 after about 1 s |
| `docker stop` or `docker kill` on a container | It stays down (Docker treats both as "stopped by you"). `make prod-up` starts it again |

While the database is down, `/api/health/db` answers `503` and `/api/health`
stays `200`, so the test page paints the database box red and the API box
green (read from the page's code; not seen in a browser).
Whether everything comes back after a full reboot of the MSI is **not
verified** yet.

---

## 9. Roll back to a previous commit

If an update breaks something:

```sh
cd /srv/sound-archive
git log --oneline                 # find the last good commit, e.g. a1b2c3d
git switch --detach a1b2c3d       # check out that exact version
make prod-up                      # rebuild and restart with the old code
```

If the commits you are undoing changed `infra/caddy/Caddyfile`, also run
`docker compose -f compose.yaml -f compose.prod.yaml restart caddy`, for the
reason given in section 7. Without it, Caddy keeps the newer configuration.

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

Today the site is plain HTTP, reachable from the home network and over
Tailscale (and maybe over IPv6, see the note in section 6). To serve it
publicly over HTTPS:

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
- To try the HTTPS setup before having a domain, set
  `CADDY_SITE_ADDRESS=localhost` and `make prod-up`. Then, on the MSI:
  `curl -k https://localhost/api/health` (`-k` because the certificate comes
  from Caddy's own local authority, which no browser trusts) and
  `curl -I http://localhost/` (expect `308 Permanent Redirect` to `https://`).
  Rehearsed on 2026-11-02: it works, and the certificate survives a Caddy
  restart and re-creation because it is stored in `caddy_data`. It does
  **not** test Let's Encrypt, DNS or the router. Set `:80` back afterwards.
- Opening ports on your router makes the MSI reachable from the whole
  internet. Only Caddy is published (section 2), but keep the system updated.
