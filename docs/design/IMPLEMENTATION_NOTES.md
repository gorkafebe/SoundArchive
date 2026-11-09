# Design implementation notes (2026-11-08)

What was built from `docs/design/handoff/`, what was invented where the design was silent, and what differs. The older notes on phase 3 follow below.

## Implemented from the design

- `tokens.css` copied unchanged. Newsreader, Atkinson Hyperlegible and IBM Plex Mono self-hosted through `@fontsource`, with no third-party request.
- The components, in `web/src/components/ui.tsx`, `features/player/components.tsx` and `styles/components.css`, keeping the `sa-*` class names. Button and RecordButton are CSS classes on native `<button>` elements rather than React components.
- All screens, in both themes and languages. The real basemap is recoloured at run time with the `--map-*` tokens.

## Invented, following the brand book

Sign-out and account page; account menu on phones (the design shows it only on desktop); "Add place" button on the map; Photo form and enlarged view; report form; invitation code shown once; audit log tab; users tab; 404 page; sleep-timer message; quality choice (lossless or compressed); the warning when a browser could not turn processing off; all English text.

## Differences

| Design | Built | Why |
|---|---|---|
| "Guardar borrador" on the review screen | Not present | A draft is not implemented. Better no button than one that does nothing |
| Licence preselected CC BY-NC in the mock | "All rights reserved" preselected | The owner's decision |
| Grabar and Subir at the end of the panel on desktop | Right below the title | So they are reachable with the sheet at its lowest height |
| "Puedes cerrar esta pantalla: seguiremos en segundo plano" | "Keep this tab open" | Honest: navigating is fine, closing the tab stops the upload |
| Map / List 40 px inside a 44 px frame | 44 px each | The target check measures the button itself |
| Waveform and meter drawn from invented data | From real peaks and real levels | A pure test tone therefore looks like a flat block, as it should |

Photo restoration by an administrator exists in the API (`/api/admin/photos/{id}/restore`), with no button yet.

## The loop

Ambient mode uses the audio element's own `loop`. Measured on a continuous tone in headless Chromium (`web/e2e/loop-gap.spec.ts`, a 2 s file over 9 s): silences of about 3 to 11 ms at the seam, and one of 32 ms that may be the start of playback. Both the browser and Opus's encoder padding contribute. So a small gap exists, and may be audible on steady sounds like a tone; on most ambient recordings it is likely to pass unnoticed, though that was not tested by ear. Avoiding it would mean decoding the whole file with Web Audio, which does not suit recordings of hundreds of megabytes.

---

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

# Invented for places, camera and layers (2026-11-09)

None of these screens were in the design. They use the existing components and tokens.

- **Add place, first step:** the `PrePrompt` component now takes the heading level (`as="h3"`), because this page already has its `h2`. The recommended button is taller (56 px) and carries a small outlined tag instead of a `Badge`, because it sits on a solid accent.
- **Advanced coordinates:** a native `<details>` with the design's border and a 44 px `summary`.
- **"Is it the same place?" and suggestions:** a bordered block (`.known`); the same-place one uses the accent border, as it is the one that needs a decision. The list rows have the name, a caption and one button.
- **Accuracy:** a `Badge` with "±N m"; the warning is a `notice`, not an error, because nothing is wrong with what the person did.
- **In-page camera:** a 4:3 frame on `surface-300`, like the photos, and `PrePrompt` for the explanation.
- **Layer selector:** a floating button under the zoom controls; the options open to its left and upwards so they fit in the small map. The current option is shown with a check mark and bold, not by colour alone.
- **New tokens** (`--map-marker-ring`, `--map-marker-outline`, `--map-label-on-image`, `--map-halo-on-image`, `--map-road-on-image`): the design's map colours assume a quiet basemap, and a photograph is not one. A pin over imagery gets a light ring with a dark edge, so it keeps 3:1 against anything underneath.
- **Credits on a phone:** imagery credits are long and wrap, so at phone width they move above the floating "add place" button.

# Invented for the "show my location" button (2026-11-09)

- **The marker is a target, not a dot.** The brief described the places as pins and the person as a round dot with a white ring. In the real interface places are round discs, and a selected place is a larger disc with a halo. A plain dot with a ring would have looked like one. So: a small dot inside a thick white ring with a dark edge, inside a larger halo with a visible outline. In greyscale it still reads as concentric rings against solid discs (`capturas/gris/` in the session's folder).
- **`--map-me` (magenta, `#c2185b`)** is a colour used nowhere else: not the accent (places, actions), and not one of the status colours, which carry meaning. It has 5.87:1 against its white ring. Against the place colour the lightness is close in the light theme (1.07:1), which is why the difference never relies on colour.
- **Ring and edge together give 3:1 everywhere.** A white ring disappears on a pale map and a dark edge on a dark one. `web/scripts/check-contrast.mjs` calculates the better of the two against each background, including white, mid grey and black for photographs: lowest value 4.76:1, on mid grey.
- **`--map-me-accuracy`** is a lighter tone in the dark theme, so the circle's line can be seen there.
- **The halo pulses gently**, and is still with `prefers-reduced-motion`. It is the one decorative movement on the map, requested for this marker.
- **The explanation** is a floating `PrePrompt` under the search bar, so the attribution stays visible while it is open.
- **Messages** go with the map's other status lines, top left, away from the crowded bottom corners.
