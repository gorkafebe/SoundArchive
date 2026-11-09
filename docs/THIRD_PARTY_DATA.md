# Third-party data and services

Who the running application talks to, what they receive, and under what terms.
Checked on 2026-11-09. Terms change: re-check the **Re-check** column before relying on a row.

**This is not legal advice.** It records what the providers publish, as understood by the people building this project. The open questions at the end are for the owner, and possibly a lawyer.

## In use

| Provider | Used for | Asked by | Licence and credit | Limits | Terms | Re-check |
|---|---|---|---|---|---|---|
| **OpenFreeMap** | Vector basemap | Each person's browser | Data: OpenStreetMap, ODbL. Credit: "© OpenStreetMap" | The project states no view limits, keys or cookies; offered "as is" and may change | <https://openfreemap.org> | That it still exists and is free |
| **Overpass API** (`overpass-api.de`) | Names of known sites near a new place | **Our server only** | Data: OpenStreetMap, ODbL. Credit: "© OpenStreetMap contributors", shown with the suggestions | Under 10 000 queries and 1 GB a day is considered safe; for regular use the OSM wiki suggests dividing by 100. Limits are per application. Pause 30 s after 429 or 406. Commercial use should run its own or a paid server | <https://wiki.openstreetmap.org/wiki/Overpass_API> | Commercial-use line; figures |
| **IGN España, PNOA máxima actualidad** (`www.ign.es/wmts/pnoa-ma`) | Satellite layer in Spain | Each person's browser, after choosing the layer | CC BY 4.0 (the service's own `AccessConstraints`: "CC BY 4.0 scne.es"). Credit: "PNOA cedido por © Instituto Geográfico Nacional" | No key. `Fees`: none. No published rate; no bulk download here | `AccessConstraints` in GetCapabilities | Licence text; that CORS stays open |
| **IGN España, Mapa ráster** (`www.ign.es/wmts/mapa-raster`, layer `MTN`) | Topographic layer in Spain | Each person's browser, after choosing the layer | CC BY 4.0 ("CC BY 4.0 ign.es"). Credit used: "Mapa topográfico cedido por © Instituto Geográfico Nacional" | As above | `AccessConstraints` in GetCapabilities | Whether a different credit wording is required |
| **EOX, Sentinel-2 cloudless 2025** (`tiles.maps.eox.at`) | Satellite layer outside Spain | Each person's browser, after choosing the layer and only outside Spain | **CC BY-NC-SA 4.0: non-commercial only.** Credit (from the layer's own description): "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)" | Free for non-commercial use; commercial use needs an agreement | <https://cloudless.eox.at> | **Whether the project is still non-commercial**; newer years |

### Layer facts, from each service's GetCapabilities

| Layer | Tile size | Formats | Zoom declared | Zoom used | Coverage declared |
|---|---|---|---|---|---|
| `OI.OrthoimageCoverage` | 256 | JPEG, PNG | 0..20 | 0..19 ("pregeneradas hasta el nivel 19" in the layer description) | **None.** No `WGS84BoundingBox`; tile limits are almost the whole world |
| `MTN` | 256 | JPEG, PNG | 0..20 | 0..20 | **None**, same |
| `s2cloudless-2025_3857` | 256 | JPEG | 0..21 | 0..14 (imagery is 10 m per pixel, about zoom 14) | World |

Because GetCapabilities gives no coverage for Spain, the rectangle (`-18.5, 27.4, 4.6, 44.1`) and the outline used to decide "is this view in Spain?" are our own, in `web/src/features/map/layers.ts`. They only choose which imagery to show.

The IGN answers outside Spain too, with low-detail or empty tiles; those are not useful and the application does not request them for a view centred elsewhere. EOX is declared up to zoom 21, but anything past 14 only returns the same 10 m pixels larger.

### CORS and redirects (checked with a request carrying `Origin: https://soundarchive:8443`)

| Domain | `access-control-allow-origin` | Redirects | `cache-control` on a tile |
|---|---|---|---|
| `www.ign.es` | `*` | none | `max-age=31536000` |
| `tiles.maps.eox.at` | the Origin sent | none | `max-age=604800` |

## Considered and not used

| Option | Why not |
|---|---|
| Esri World Imagery | An Esri employee states on their forum that the service needs an ArcGIS licence and is not for commercial use, and the public terms contradict each other. Not without an account of our own |
| Google, Mapbox, Stadia Alidade Satellite | Need a key, and Google a billing account. Not evaluated further |
| MapTiler | The free plan is non-commercial only, needs a key and a visible logo, and stops at the quota (5 000 sessions and 100 000 requests a month). A possible future step, with the key kept in a server proxy |
| Nominatim (public) | Forbids autocomplete, requires 1 request a second at most, and is not meant for "sites near a point" |
| Photon (public or self-hosted) | Public instance: reasonable use with no guarantees. Self-hosting the planet needs about 95 GB of disk and 64 GB of RAM: too much for the MSI |
| Private.coffee Overpass | Reasonable alternative, no stated limit, asks not to receive personal data (none is sent). Allowed by the code as `OVERPASS_URL_FALLBACK`; **off by default**, the owner decides |
| Overture Maps Places, Geofabrik extracts | Data to download, not an API. See next steps |

## Next steps, not built

**A local copy instead of Overpass.** The recommended way to stop depending on an outside server: import a regional OpenStreetMap extract from Geofabrik (Madrid 74 MB, Andalucía 150 MB, Cataluña 236 MB) into the PostGIS the project already has, with `osm2pgsql`, into one table of named sites. Then write a second `PlaceSuggestionProvider` that queries it (`backend/app/place_suggestions.py`); nothing else changes. It needs a download, an import and a periodic update, which is why it was left out. Overture's licence depends on the source (CDLA 2.0; Apache 2.0 for what comes from Foursquare).

## Open questions for the owner

1. **Is the project still non-commercial?** If it may stop being so: set `SATELLITE_GLOBAL_FALLBACK=no`, take `tiles.maps.eox.at` out of `MAP_RASTER_ORIGINS`, and re-read the Overpass line on commercial use.
2. **ODbL and the places database.** A place chosen from OpenStreetMap keeps its `external_source` and `external_id`, and its name comes from OpenStreetMap. If the places database is ever published or shared, the part derived from OpenStreetMap carries the ODbL's obligations (attribution and share-alike). It is not clear from here how much of a mixed database that covers.
3. **Exact credit for the topographic map.** The IGN asks for its citation; the wording used for the `MTN` layer follows the PNOA one. Confirm in its conditions of use.
