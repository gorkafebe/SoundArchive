# Implementation notes: phase 3 foundations (places and web interface)

Date: 2026-11-03. Branch `feat/places-foundation`. For the owner and for
whoever applies the Claude Design output to the code.

What this is: the structure, behaviour and accessibility of the first
interface, built **before** the visual design exists. Everything visual is a
provisional placeholder kept in one file, so the design can replace it
without touching the components.

## 1. What was built

- **Map** (MapLibre GL JS): basemap style from `/api/config` (OpenFreeMap
  `positron` for light, `dark` for dark), places of the visible area loaded
  as the map moves, clusters with a count, the selected pin grows, zoom
  buttons, attribution always fully visible.
- **Place panel**: name, description, coordinates, date added, and an empty
  space marked "No recordings yet" where recordings go in phase 4. A
  non-modal bottom sheet with three heights on phones (drag the handle, or
  press it / use the arrow keys), a side panel on wide screens. Escape or
  "Close" closes it.
- **List view**: the same places, newest first, with search and pages; a full
  alternative to the map.
- **Add a place**: a full-screen flow in three steps (location, name and
  description, confirm). Location by tapping a small map, typing coordinates,
  or "use my location".
- **Writes disabled state**: when the server does not allow creating places,
  "Add place" stays visible and explains why.
- **Spanish and English**, **light and dark**, remembered; the view, map
  position, open place, search and page are in the address.

Not built (by decision): audio (phases 4-5), accounts (phase 6), photos,
address search (needs a geocoding provider, open question), ambience mode.

## 2. Rules of UI_RESEARCH_AND_BRIEF.md: kept, partly kept, not yet

| Rule (brief section) | State | Where / how |
|---|---|---|
| Sound starts only after a tap (3, Listening; 4.4) | Kept by architecture | There is no audio yet and nothing plays on load; the panel has a reserved space, no player. |
| Controls at least 44 px (3, Accessibility) | Kept, tested | `--target-min` in tokens; the e2e test measures every control on six screens. Exception: the links inside the attribution line (inline text, allowed by WCAG 2.5.8). |
| Text contrast 4.5:1, interface parts 3:1, both themes | Kept for the token pairs, tested | `web/scripts/check-contrast.mjs` checks 21 pairs per theme; axe found no contrast issue. Not measurable automatically: pins over real map tiles (they have a ring in the panel colour for that reason). |
| Visible focus | Kept | 3 px ring with a gap (`--focus-width`), so it sits on the background, never on the accent. |
| Everything keyboard-operable; list as alternative to the map | Kept, tested | Pins are buttons; the map pans with arrows and zooms with +/-; a keyboard-only e2e test walks the main flow. |
| Permissions only after a tap, with an explanation first and an alternative; detect a denied permission and show recovery | Kept, tested | "Use my location": explanation shown next to the button (and linked to it); map and coordinate fields always available; Permissions API detects "denied" and shows how to unblock it. |
| Quiet basemap, one accent colour for sound | Kept | Positron (grey) basemap; moss accent only on pins, clusters and the main button. |
| Selected marker grows; clusters with a count; mixed cluster neutral | Partly | Selected pin scales 1.6x with a halo; clusters show a count. All clusters use the accent (there is only one kind of thing yet). |
| Place sheet non-modal, beside the map; never covers attribution | Kept | The panel takes its own space in the page grid (below or right of the map), so it cannot cover the map. |
| Recording and upload are full-screen steps, not sheets | Kept for "add a place" | Same pattern ready for phases 4-5. |
| First view shows data (no empty map) | Kept | Opens on Spain at zoom 5, where the first places are expected. |
| Respect prefers-reduced-motion | Kept, tested | Motion tokens become 0; map camera moves become instant; MapLibre's own marker fade overridden. |
| Dark theme for night listening | Kept | Light by default; dark or "same as system" on request, remembered. |
| Loading, empty and error states on every screen | Kept | Map status line, list, panel, add flow, start-up config error with retry. |
| Spanish and English text lengths fit | Checked in screenshots | Header wraps to two lines at 390 px (does not overflow). |
| Shareable map view (centre and zoom) | Kept | In the URL. |
| Search by address, "locate me" on the map | Not yet | Address search is an open question (geocoding provider). Location is only used in the add flow. |
| Timeline, ambience mode, waveform, capture details | Not yet | Phases 4-5. |
| Privacy: blur exact position, notice about voices | Not yet | Phase 5 publish step. |

Automatic audit: axe-core (WCAG 2.0/2.1/2.2 A and AA, plus best practices) on
six screens in both themes: no violations of any impact after one fix (the
language button's name now contains its visible text, WCAG 2.5.3).

## 3. What changes when the design arrives

**Tokens: replace one file.** `web/src/styles/tokens.css` holds every colour,
font, size, spacing, radius, shadow and motion timing as CSS variables, with a
light block (`:root, [data-theme="light"]`) and a dark block
(`[data-theme="dark"]`). Replace the values (or map the exported names onto
these). Keep the variable names, or rename them everywhere with search and
replace. Then run `make web-check`:

- `check-tokens` fails if a colour or font name appears outside tokens.css;
- `check-contrast` re-checks the 21 colour pairs in both themes (it reads the
  hex values; keep colours as `#rrggbb` there, or extend the script);
- the unit tests do not depend on colours.

Then `make e2e` re-runs axe and the size checks, and re-takes the screenshots.

**Components** (all styles use only tokens):

| Component | Files |
|---|---|
| App shell: header, nav, skip link | `web/src/App.tsx`, `web/src/styles/layout.css` |
| Buttons, fields, notices, focus, skip link | `web/src/styles/base.css` |
| Language and theme switches | `web/src/components/Preferences.tsx` |
| Map, pins, clusters, map controls and attribution | `web/src/features/map/MapView.tsx`, `markers.ts`, `map.css` |
| Place panel (sheet / side) | `web/src/features/places/PlaceSheet.tsx`, `place-sheet.css` |
| List view | `web/src/features/places/PlaceList.tsx`, `place-list.css` |
| Add-place flow and its small map | `web/src/features/add-place/AddPlaceFlow.tsx`, `LocationPicker.tsx`, `add-place.css` |

**Texts:** `web/src/i18n/es.json` and `en.json`. Same keys in both (checked).
The design's copy goes there, never into components.

**Things the design should decide** (seen in the screenshots in the session
report):

- The name is plain text in the header; no logo was invented.
- Fonts: the system font stack (`--font-sans`), no web fonts.
- Basemap styles for both themes: OpenFreeMap "dark" is near-black and colder
  than the "calm and natural" mood; consider "fiord", a custom style (must
  then be self-hosted), or another provider (`MAP_STYLE_URL*` and
  `MAP_TILE_ORIGINS`).
- Pin and cluster shapes, the selected-pin look, cluster sizes.
- Header on phones: two lines at 390 px.
- The focus ring on the panel title after a tap is very visible; it is correct
  for keyboard users, but the design may want a softer style for it.
- The attribution credits OpenStreetMap twice with OpenFreeMap (ours, always
  present, plus the style's).

## 4. Owner decisions recorded for later phases

- Recordings will be **public by default**; when publishing, the app will ask
  whether to show the recordist's name or stay anonymous. **Open question:**
  does that question come with an option preselected, and which?
- No accounts until phase 6 (invitation-only sign-up, D-47). Until then,
  `ALLOW_ANONYMOUS_WRITES` controls whether anyone can create places
  (false in prod).
- No address search yet: it needs a geocoding provider, which means sending
  what people type to a third party. **Open question.**
