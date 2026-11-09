# Acceptance record: tailnet-only instance

Session of 2026-11-08, branch `feat/tailnet-functional`. Each row was run; the output is in the owner's evidence folder (`~/SoundArchive-Informe/tailnet-2026-11-08/evidencias/`). "Not verified" means exactly that.

Test stacks were throwaway Compose projects on `127.0.0.1`, with the same `compose.tailnet.yaml` as the real instance.

## Network and HTTPS

| Criterion | How | Result |
|---|---|---|
| Only loopback published | `make exposure-check` | OK: Caddy on `127.0.0.1:9443` and `:9080`, nothing else. No new listener outside loopback |
| HTTPS trusted by a real browser | Chromium with the root in its NSS store; `web/e2e/https.spec.ts` | Passes. Negative control without the root: `ERR_CERT_AUTHORITY_INVALID` |
| Secure context | Same test: `isSecureContext`, `getUserMedia` | True, function present |
| `curl` with the CA, by name and through the Tailscale forward | `h1-curl-3.txt` | Short name, `*.ts.net` name and `localhost`: `{"status":"ok"}` |
| HTTP redirects | `curl -I http://127.0.0.1:9080` | 308 to `https://soundarchive:8443/` |
| Unknown host | Other `Host` / SNI | 421 / no certificate |
| Body limit | 2 MB to `/api/places` | 413 |
| Security headers | `https.spec.ts`, `curl -I` | CSP, nosniff, Referrer-Policy, Permissions-Policy present; HSTS absent on purpose |

## Accounts

| Criterion | How | Result |
|---|---|---|
| Invitation valid, expired, used, revoked | `backend/tests/test_auth.py` | Same refusal for every invalid case; valid works once |
| Sign in, sign out, everywhere | API tests; `web/e2e/auth.spec.ts` | Pass |
| CSRF and Origin | API tests; a test walks every state-changing route in OpenAPI | 401 or 403 without them |
| Attempt limits | API tests | 429 with `Retry-After`, growing wait, no hint of whether the name exists |
| Deactivating a user | API and browser tests | Sessions end at once; login refused |
| Command line, password from standard input | Used for every test stack | Works. `make admin-create` with hidden input on a terminal: **not verified** (no terminal in this session) |
| Cookie attributes | `auth.spec.ts` | `__Host-`, HttpOnly, Secure, SameSite=Lax, Path=/ |

## Recording and uploading

Audio synthesised with ffmpeg. Tolerances: LUFS within 0.5 LU of the reference, duration within 50 ms.

| Criterion | How | Result |
|---|---|---|
| 572 MiB WAV over HTTPS, hash checked | `ops/tailnet/upload-acceptance.py` | Ready; SHA-256 identical |
| Cut and resume | Same script, connection closed mid-chunk; `audio.spec.ts` in the browser | Resumes from the server's count |
| Memory of the API during upload | 15 samples of `docker stats` over 30 s | 112 to 117 MiB |
| Refused above 2 GiB | Declared 2 GiB + 1; `Content-Range`; a real 2.2 GiB body claiming 2 GiB | 413 in all three; 0 bytes kept |
| Not audio with a `.wav` name | Script; browser test | `failed`, `not_audio`, clear message |
| Reference tone | 1 kHz at -23 dBFS, 52 min | -23.0 LUFS, 3125.0 s |
| Record in browser, fake microphone | `audio.spec.ts`: 10 s, review, publish, processed, play to `ended` | Pass, lossless and compressed |
| Upload in the browser, es and en | `audio.spec.ts` | Pass |
| Permission denied | Project with no microphone, es and en | Blocked state and upload alternative |

## Listening

| Criterion | How | Result |
|---|---|---|
| Range requests, through Caddy | `audio.spec.ts`; API tests | 206, exact bytes, 416 when out of range, no compression |
| Waveform from peaks | API test | Peaks match the tone's level |
| No autoplay | `audio.spec.ts` | Paused until a click |
| Time advances, `ended` fires | `audio.spec.ts` | Pass |
| Plays in Firefox | `firefox.spec.ts` | Pass. Safari and iOS: **not verified** |

## Photos, ambient, comparison

| Criterion | How | Result |
|---|---|---|
| GPS EXIF removed | API test with a real GPS block; browser test with hidden PNG text | Gone from every size |
| False image, bomb, oversize, limit per person | API tests | 415, 413, 413, 409 |
| Loop | `audio.spec.ts`: wraps without stopping | Pass. Measured gap on a test tone: 3 to 11 ms at the seam, once 32 ms (`loop-gap.json`, headless) |
| Sleep timer, simulated clock | `audio.spec.ts` | Stops with a message |
| Mini-player across screens; closing stops it | `audio.spec.ts` | Pass |
| A/B keeps the position, changes the source | `audio.spec.ts` | Within 0.8 s (includes the click), other source |

## Administration

| Criterion | How | Result |
|---|---|---|
| Report, remove, gone everywhere, restore | `moderation.spec.ts`, API tests | Pass |
| Non-admin gets 403 | Browser and API | Pass |
| Purge | Against a test stack: wrong confirmation, published item, right confirmation | Refused, refused, deleted (files and row) |

## Quality

| Criterion | How | Result |
|---|---|---|
| `make check` | API + web | 128 and 70 tests pass |
| `make e2e` | Fresh stack | 79 pass: Chromium, no-microphone, Firefox, mobile emulation |
| Languages, themes, sizes | `journey.spec.ts` (es/en, light/dark, 390/1440) | Pass |
| axe | Main screens and states in the journey, both themes | No serious or critical issue. One justified exception: a pin under the floating bar |
| Keyboard | `quality.spec.ts`: map, pin, panel, list, add place; slider and A/B in others | Pass. The complete recording flow by keyboard alone: not run as one test |
| 44 px targets | `quality.spec.ts`, `mobile.spec.ts` | Pass |
| Screen reader | Roles and live regions reviewed in code | **Not verified** with a real screen reader |
| `make prod-check` | | Pass |

## Robustness

| Criterion | How | Result |
|---|---|---|
| Restart and stop/start | `h10.log` | Session and data intact; all services `unless-stopped`, healthy |
| Backup and restore | restic in a temporary folder, restored to `sa-test-restore` | 8 tables equal; 223 files with the same hash; 57 recordings served and matching |
| Performance, 10 000 places and 2000 recordings | `h10.log`, on this laptop | Map area query 0.3 ms in the database, 8 to 21 ms through HTTPS; list 24 ms; 200 recordings of one place 66 ms. Both queries use their indexes |
| Logs | `h10.log` | No cookies or headers; no password |

## Not verified

- A real phone, Safari and iOS.
- `https://soundarchive:8443/` from another device. Tested from the MSI through the forward only.
- A real screen reader.
- A real backup destination; none is chosen.
- `make admin-create` on a terminal with hidden input.

# Acceptance record: places without duplicates, camera, map layers

Session of 2026-11-09, branch `feat/place-dedupe-camera`. Output in the owner's evidence folder (`~/SoundArchive-Informe/lugares-camara-2026-11-09/evidencias/`).

| Criterion | How | Result (2026-11-09) |
|---|---|---|
| `make check` | API, guards, web | 209 and 159 tests pass |
| `make e2e` | Fresh stack, no internet | 109 pass: Chromium, no-microphone, Firefox, mobile emulation. es/en, light/dark, 390 and 1440 on the new flows |
| Production configuration | `config --quiet` and the `prod-check` tests, from a checkout under the throwaway name `sa-test-prodcheck` (`make prod-check` runs only in `/srv/sound-archive`, by design) | Valid; db and api publish no ports; no `TEST_ADMIN_*` |
| Current location is the main way; permission after a tap; accuracy shown; coordinates under Advanced | `AddPlaceFlow.test.tsx`, `places-flow.spec.ts` | Pass |
| Duplicates: 409 and `confirm_distinct`; race; unique outside reference | `test_nearby.py` (six concurrent requests: one 201, five 409) | Pass |
| The distance query uses the index, 10 000 places | `h1-explain.txt` | `ix_places_location`, 0.06 ms |
| Migrations up and down | `test_migration_goes_down_and_up`; applied to `sa-tailnet` | Pass; instance at `0006` |
| Only the cell leaves the server; no user data | `test_only_the_cell_leaves_the_server`, real HTTP to a local stand-in | Pass |
| Cache, limits, breaker, silent failure, switches off | `test_suggest.py` | Pass |
| Suggestions with the real Overpass | One query each to the main server and to Private.coffee, Zaragoza centre | **Not verified.** `overpass-api.de` answered 502; Private.coffee timed out at 15 s. Both handled silently, nothing cached |
| Camera: `capture` on touch, in-page on desktop, tracks stopped, permission explained, fallback | `CameraCapture.test.tsx`, `camera.spec.ts` with the fake camera, `mobile.spec.ts`, `denied.spec.ts` | Pass |
| No EXIF | Fake-camera photo in `camera.spec.ts`; GPS-tagged JPEG in `test_gps_exif_does_not_survive` | Pass |
| `camera=(self)` and tile domains in the headers | `curl -I` on `sa-tailnet`, `h8-cabeceras.txt` | Present, and nothing else new |
| Layers: selector on both maps, keyboard, memory, credit per layer, no request until chosen, pins intact, tile failure | `layers.test.tsx` (50 tests), `layers.spec.ts` | Pass |
| Real imagery under the real CSP | `make e2e-manual E2E_ARGS=real-layers` | IGN 54 and 20 tiles, EOX 35, all 200; MTN loads; no CSP error |
| axe | New screens and states, both themes | No serious or critical issue |
| Keyboard only | Whole location flow; selector | Pass |
| 44 px | `quality.spec.ts`, `mobile.spec.ts` | Pass |
| `sa-tailnet` updated, data kept | restic copy; row counts before and after | Identical; 6 services healthy |
| Exposure | `make exposure-check` | OK |
| Production and panel untouched | Container ids, first and last | Identical, 26 h up |

## Not verified

- The real Overpass (above).
- A real phone: real GPS, real camera, Android or iOS.
- A real webcam on a computer.
- A real screen reader.
