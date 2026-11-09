# Security model

The instance runs only inside a private Tailscale network today, for a handful of known accounts. It is still built as if it could be opened later: the private network is one layer, not the whole defence.

## What protects it

### The private network

| Control | Where | Effect |
|---|---|---|
| Caddy publishes only on `127.0.0.1:9443` and `:9080` | `compose.tailnet.yaml` | Nothing listens on a real interface |
| One way in: the Tailscale forward to `127.0.0.1:9443` | Set up by the owner | Only devices on the tailnet reach it |
| `make exposure-check` | `ops/tailnet/exposure-check.sh` | Docker-published ports bypass `ufw`, so this check, not the firewall, is the guarantee |
| No Funnel, no public IP, no public certificate | Owner's decision | The machine's name is not published in Certificate Transparency logs |

### The application

These work the same whatever network the app is on.

| Threat | Control |
|---|---|
| Stolen database | Passwords hashed with Argon2id. Session tokens and invitation codes stored only as SHA-256 |
| Password guessing | Minimum 12 characters, a list of common passwords, attempts limited per username and per address with a growing wait, refused rather than unlimited if Redis is down |
| Finding out who has an account | Same message for a wrong password and an unknown name, and the slow hash runs in both cases |
| Cross-site request forgery | `SameSite=Lax` cookie, an exact `Origin` allow-list, and a per-session CSRF token on every state-changing request. A test walks the OpenAPI schema and fails if any route lacks this |
| Stolen session | Cookie is `__Host-`, `Secure`, `HttpOnly`. Sliding and absolute expiry. Deactivating a user or changing a password closes sessions |
| Script injection | Strict Content-Security-Policy: no inline scripts, no other origins except the configured map tiles. React escapes text |
| DNS rebinding | Caddy answers 421 to host names it does not know, and only issues certificates for its own names |
| Malicious audio files | Type decided by `ffprobe`, never by name. Allow-list of container and codec. `ffmpeg` limited to `file` and `pipe` protocols, runs in the worker with no route to the Internet, no extra capabilities, and limits on memory, CPU and processes |
| Malicious images | Pixel count checked from the header before decoding. Every image is re-encoded, which removes EXIF and anything hidden |
| Path tricks | Files stored under random ids. The person's file name is never part of a path, and every path is checked against the media root |
| Filling the disk | 2 GiB limit counted on real bytes, not headers. Free space checked first. Abandoned uploads deleted |
| Seeing what is not yours | "Only me" recordings answer 404 to others. Removed content answers 410. Disk paths never leave the server |
| Destroying content | Purging exists only on the command line, needs the content already removed, and a typed confirmation |
| Too much in the logs | Caddy's log drops headers and client address. The audit log holds actions and ids only |

### Secrets

`.env` (mode 600, ignored by git) holds the database and Redis passwords. The private key of the certificate authority stays in the `caddy_data` volume; only `root.crt`, the public part, is ever exported.

## HTTPS and the private CA

Browsers offer the microphone and geolocation only in a secure context. Caddy's internal CA provides HTTPS without any public record of the name.

**HSTS is off on purpose.** It applies to the whole host name on every port, so it would break the plain-HTTP monitoring panel on the same name, and with a private CA a browser that loses trust would show an error the person cannot click through. Turn it on only for a public site with a public certificate.

The CA's root key lives in the `sa-tailnet_caddy_data` volume. Deleting that volume creates a new CA, and every device would need the new root installed.

## Who else the application talks to

Licences, limits and the provider list: `docs/THIRD_PARTY_DATA.md`.

### Suggestions from OpenStreetMap (server to Overpass)

When someone adds a place, **our server** asks the public Overpass API which named sites exist nearby. The browser never does.

- **Sent:** a rectangle aligned to a fixed grid of 0.003 degrees (about 300 m) with a small margin, the list of tags to look for, and the header `User-Agent: SoundArchive/<version> (self-hosted)`.
- **Never sent:** the exact position, a user, a session, a cookie, an email address. `backend/tests/test_suggest.py` captures the real request and checks it.
- **Why cells:** the provider learns "someone looked at this square", not where. Every point in a cell produces exactly the same request. The answer is cached for 30 days, so the second person sends nothing.
- If the circle around the point touches several uncached cells, one rectangle covering those whole cells is requested. That reveals the point is near a cell border, which narrows it slightly; it is the price of one request instead of four.
- **Being a good guest:** at least 2 s between requests, at most `OVERPASS_DAILY_CAP` uncached requests a day for the whole instance, at least 30 s of silence after 429 or 406, 10 minutes after three failures in a row, 15 s maximum per request. All of that is in Redis; if Redis is down, no call is made.
- **Where it can go:** only the host names listed in `backend/app/overpass.py`, with no redirects and no proxies, whatever the configuration says.
- **If it fails** the add-place flow continues without suggestions and shows no error. The check for places already here does not depend on it.
- **To turn it off:** `EXTERNAL_PLACES_ENABLED=no` in `.env`, for the whole instance; or the "Suggest sites from OpenStreetMap" box, per person (then `external=false` goes to our own API and nothing leaves).
- The API is the only service with a route to the Internet that needs one for this; the worker and maintenance containers stay on the internal network.

### Map imagery (browser to the provider)

The basemap already worked this way: each browser asks the tile server directly. The satellite and topographic layers add two more servers.

- **Nothing is requested until a person chooses the layer.** The source is added to the map at that moment; `web/e2e/layers.spec.ts` checks that no request goes out before.
- **What the provider sees:** the person's IP address and the area being looked at, as with any map. That is why the IP is not hidden: it would take a proxy on our server, which is the documented plan B and was not needed because both providers allow CORS.
- `Referrer-Policy: same-origin` means they do not learn this site's address.
- The choice of layer stays in the browser's `localStorage` and is not sent to our server.

### Content-Security-Policy and permissions

- `MAP_RASTER_ORIGINS` adds `https://www.ign.es` and `https://tiles.maps.eox.at` to `connect-src` and `img-src` on the tailnet instance, and nothing else. They are the final domains, checked: no redirects. Empty by default elsewhere.
- `Permissions-Policy` now allows `camera=(self)`, as it already did the microphone and geolocation, for this site only and never for embedded pages. The camera is released after taking the photo, on closing, when the tab is hidden and when leaving.
- Photos taken with the camera go through the same path as any upload: decoded and encoded again as a new JPEG on the server, which drops all metadata.

### Duplicates cannot be skipped from another client

`POST /api/places` refuses a place within the radius of an existing one unless the request says `confirm_distinct`. It also refuses a second place with the same outside reference. Confirmed cases are recorded in the audit log (`place.created_despite_nearby`). A transaction-level advisory lock makes concurrent requests take turns.

## Known limits

- The per-address login limit sees only the Docker gateway behind the Tailscale TCP forward, so today it works as a global ceiling. The per-username limit is the effective one.
- A person who has the certificate's private key could impersonate the site on the tailnet. It stays on the MSI, like the rest of the data.
- Dependencies are pinned, but nothing here rebuilds them automatically when a vulnerability appears.
- Backups are the owner's to place somewhere else. Encrypted with restic, they are only as safe as their password.

## What changes before opening to more people

Everything in the application section stays. Needed in addition:

1. A real domain, public certificates, and HSTS.
2. A trusted client address (`trusted_proxies`), so that the per-address limit means something.
3. A decision on open registration or a larger invitation policy, and on e-mail for password recovery.
4. Reports, retention and legal terms: who hears complaints, how long removed content is kept, the terms under which people upload.
5. Limits per user (storage, uploads per day).
6. Moderation capacity: people listening to what is reported.
7. A privacy review of location: exact coordinates may reveal where someone lives.
8. A scan of dependencies, and a review by someone other than the author.
