# Sound Archive — design handoff (v1, 2026-11-08)

Source of truth: the "Sound Archive" design system and the "Sound Archive · pantallas" canvas in Claude Design (owner's account). This folder is a static export so the implementation does not depend on them.

## Files

- `tokens.json` — tokens as designed (colour in light/dark, type, spacing, radius, shadow). Edit values here first if the design changes.
- `tokens.css` — the same tokens as CSS custom properties. Copy to `web/src/styles/tokens.css` (replaces the provisional file). Theme is selected with `data-theme="light|dark"` on `<html>`.
- `components.css` — reference CSS for the 13 designed components (`sa-*` classes): Button, Badge, Field, Pin, Cluster, Waveform, RecordButton, RecordingCard, MiniPlayer, PlaceSheet, PrePrompt, Toast, EmptyState. Re-implement them as React components using only token variables.
- `README.md` — the brand book (principles, content tone, visual foundations, iconography, maps/attribution). Treat its rules as requirements.
- `screens/*.html` — 15 static mock screens (Spanish copy). Open them in a browser (or render with Playwright at the stated size) to see the intended layout:
  - 390×844 mobile light: `01-mapa-claro`, `02-lugar`, `03-grabacion`, `04-grabar-permiso`, `05-grabando`, `06-revisar-publicar`, `07-subir-archivo`, `08-modo-ambiente`, `09-comparar`
  - 390×844 mobile dark: `10-mapa-oscuro`, `11-grabacion-oscuro`
  - 1440 desktop light: `12-escritorio-mapa` (map + 420 px side panel), `13-escritorio-admin` (content removal + invitations), `14-escritorio-acceso` (login + invitation signup), `15-estados` (empty, loading, network error, offline, processing, mic blocked, location denied, toast, removed content)

## What the mocks are, and are not

They are layout and copy references, not pixel specs. The map is a drawn placeholder (the real map is MapLibre + OpenFreeMap). Photos are labelled placeholders. Spanish copy is the source for `es.json`; write the English equivalents yourself, same tone (second person, sentence case, no exclamation marks, no emoji).

## Decisions that came with the design

- One blue accent, reserved for sound (pins, play, record, waveform progress). Everything else is neutral blue-grey.
- Authorship defaults to showing the person's name; "Anónimo" is a visible, equal option (not hidden, not discouraged).
- Sound never autoplays. Loudness is shown, never normalised. Capture details (device, format, LUFS, SHA-256 of the untouched original, licence, location accuracy) are always visible on a recording page.
- Map: quiet basemap tokens (`--map-*`), OSM/OpenFreeMap attribution always visible, list view as a full alternative.
- Fonts: Newsreader (display), Atkinson Hyperlegible (text), IBM Plex Mono (data). Self-host them in the build (npm `@fontsource/*` packages); no third-party requests at runtime. The mocks load Google Fonts only because they are static references.
- Controls are at least 44×44 px; text contrast 4.5:1 (3:1 for large text, borders, focus ring) in both themes; focus ring is a solid 2 px `--focus-ring` outline with 2 px offset.

## Not designed yet (build with the same system, keep it simple)

Photo upload/crop UI, user profile page, report dialog, invitation sign-up success state, 404/500 pages, sleep-timer end state, English copy. Follow the README rules; list what you invented in `docs/design/IMPLEMENTATION_NOTES.md`.
