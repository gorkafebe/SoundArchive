Sound Archive is a quiet place to keep how a place sounded. The interface gets out of the way of the recordings: sound is the content, the map is only the index.

## Principles

- Sound first. Never autoplay; nothing makes noise until a person presses play. Show a written "what you can hear" description before audio.
- Quiet map, loud sound. The basemap uses only `map-land`, `map-water`, `map-road` and `map-label`; the single `accent` appears on pins, play, record and waveform progress, nowhere else.
- Be honest about provenance. Always show date, capture method, location accuracy and licence next to a recording, in `meta` or `caption`.
- Time is a first-class dimension: lists are ordered by date, and the same place can be compared across years.
- Privacy is visible. Every place has a privacy chip; authorship defaults to showing the person's name (this is a community); "Anonymous" is always one tap away and never hidden or discouraged.
- One interface for everyone: same flows for first-time and expert users, light and dark themes, Spanish and English (labels grow up to ~30% in Spanish; never truncate a verb).
- The map is always visible and easy to reach: on mobile the sheet never covers it fully except in full-page views; on desktop it sits beside it.
- Calm: no decorative motion. Honour `prefers-reduced-motion`; fades of 150 ms at most.

## Content fundamentals

Write in second person, plain and warm, sentence case, no exclamation marks, no emoji. Name things by what they are: "Add a recording", "What you can hear", "Where was this recorded?". Errors say what happened and what to do: "We could not reach the server. Your recording is still on this device." Never blame the person. Spanish uses "tú"; dates in the person's locale (`12 oct 2026`, `Oct 12, 2026`); durations as `2:41`.

## Visual foundations

- Colour: `surface-100` for the page, `surface-200` for sheets, cards and inputs, `surface-300` for sunken tracks and chips. Text is `ink`; secondary text `ink-muted` (never for the only copy of an instruction). `accent` text sits on `surface-100`, `surface-200`, `surface-300` and `accent-soft`. A solid `accent` fill takes `on-accent` text. Status colours (`success`, `warning`, `danger`) always come with a word and an icon; success is teal with a check icon and the word, never told from danger by hue alone.
- Focus: a solid 2 px `focus-ring` outline with a 2 px offset on every interactive element.
- Type: `display`, `title`, `heading` (Newsreader, serif) for places and recordings; `body`, `label`, `caption` (Atkinson Hyperlegible) for everything else; `meta` and `timecode` (IBM Plex Mono) for technical data. Body never below `body` 16 px on mobile; `caption` 13 px is the floor.
- Spacing and targets: use the `space-*` steps. Every control is at least `target-min` (44 px) in both directions, with `space-2` between neighbours. The record button is `target-record`.
- Shape: `radius-md` for controls and cards, `radius-lg` for sheets and dialogs, `radius-pill` for pins, chips and the record button.
- Elevation: borders before shadows. Only the place sheet, mini-player and pins use `shadow-sheet` / `shadow-pin`.
- Layout: mobile first (390 px), a bottom sheet with three heights (peek, half, full). On desktop (1440 px) the sheet becomes a 420 px side panel and the map fills the rest. Always offer a list view as an alternative to the map.
- Motion: none by default; sheet height changes and the waveform progress may animate for 150 ms unless reduced motion is on.
- Imagery: place photos are shown 4:3 with a visible caption; EXIF is stripped on upload. No stock imagery, no illustrations of people.

## Iconography

Line icons, 24 px grid, 1.75 px stroke, round caps, drawn inline as SVG with `currentColor`; every icon-only button has an `aria-label`. No emoji, no icon fonts. The product uses: play, pause, record, stop, pin, list, map, upload, camera, loop, timer, compare, lock, globe, trash, flag, check, alert, close, chevron.

## Maps and attribution

Basemap: OpenFreeMap vector tiles styled with the map tokens above. The OpenStreetMap / OpenFreeMap attribution is always visible, `caption` size, `ink-muted` on a `surface-200` chip.

## Fonts

Newsreader, Atkinson Hyperlegible and IBM Plex Mono are open-licence Google Fonts, loaded by name from Google Fonts in previews. For the self-hosted product build, ship the woff2 files with the app (no third-party requests at runtime) and list them in `type.fonts`.

## Components

Button, Badge, Field, Pin, Cluster, Waveform, RecordButton, RecordingCard, MiniPlayer, PlaceSheet, PrePrompt, Toast, EmptyState. Use the bundle (`window.SoundArchive`) in prototypes; in production re-implement the same classes (`sa-*`) from `components/bundle.css` and keep the tokens as CSS variables.
