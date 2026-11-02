# Sound Archive: interface research and design brief (for Claude Design)

Date: 2026-11-02. Status: research done; no screens designed yet. Companion to the project plan, kept in Claude, section "Interface design".

How to read it: **Evidence** is something found in a linked source. **Decision** is our own choice, not a rule from a source. Section 9 lists what was not verified.

## 1. What "Claude Design" means in this project

- Two artifact types in Claude: **Design System** (README, tokens in themes, type, spacing, radius, components with live previews) and **Design** (a canvas of live artboards: UI screens, wireframes, posters).
- The Design type's own instructions ask for: using a design system if one exists, touch targets of at least 44 px, text contrast of 4.5:1, real buttons and labels (not clickable divs), phone artboards of 390x844 and page artboards of 1280 to 1440 px, placeholders instead of invented content, and no copying of other companies' proprietary designs. These agree with the accessibility baseline below.
- The VS Code agent (Claude Code) does not draw in Claude Design. The hand-off is files: exported `tokens.json`, screenshots, a component inventory and the canvas link. The Design System type also mentions a `/design-sync` command in Claude Code for syncing a system from code; we have not tried it.

## 2. Existing sound maps (what to study)

| Project | What it does (evidence) | What we take or avoid (decision) |
| --- | --- | --- |
| [Radio Aporee](https://aporee.org/mobile) | Global sound map of field recordings, [running since 2000](https://earth.fm/details/global-sound-archive-soundmaps-projects-and-the-perspective-of-future/). A 24-hour stream plays recordings from the map and reacts to uploads and listeners. Contributors read posting guidelines first. Press called its interface [Google-Maps-like and easy](https://www.vice.com/en/article/what-every-place-on-earth-sounds-like); the [Acoustic Ecology Institute](https://www.aeinews.org/tag/sound-maps/) found it beautiful but a bit opaque to navigate. | Take: a radio or shuffle mode as an ambience feature, short posting guidelines. Avoid: opaque navigation; the first screen must explain itself. |
| [Cities and Memory](https://citiesandmemory.com/city-country-sound-maps/) | Maps per city and country. Each location pairs [two sounds](https://amp.cbc.ca/radio/spark/365-turning-the-economy-upside-down-emoji-url-shorteners-surrogate-robot-students-and-more-1.4309290/mapping-the-sounds-of-protest-1.4309468): an original recording and a reimagined one. | Take: a place holds several versions of its sound. Ours is open to everyone, not curated. |
| Montréal Sound Map ([Wikipedia: Sound map](https://en.wikipedia.org/wiki/Sound_map)) | Users upload field recordings to a map of Montréal; it describes itself as a sonic time capsule. | Same idea as our time-capsule use. Study how it shows several recordings of one place (not checked). |
| Sound Around You (same page) | Contributors share recordings and why they chose them. | Take: a short "why this place" story field. |
| Freesound geotags ([blog post](https://blog.freesound.org/?p=145)) | Browse sounds on a map, share or embed a portion of the map, API call for sounds inside a rectangle. | Take: a shareable map view (centre and zoom) and a bounding-box query; both are already in our plan. |
| [Freesound Explorer](https://github.com/ffont/freesound-explorer) | Arranges sounds in a 2-D space by timbre similarity instead of geography. | Not for version 1; an idea for "similar sounds" later. |
| Others, named in an [academic article](https://bibliotekanauki.pl/articles/2016572.pdf) | Soundcities, Sons de Barcelona, Brussels Sound Map. | Open three maps for 15 minutes each and note what confuses you; I could not read their live interfaces. |

These are references for patterns, not designs to copy.

## 3. Rules from established guidelines

### Map
- **Evidence ([SAP Fiori map guidance](https://experience.sap.com/fiori-design-android/map)):** enable clustering when there are many markers; clusters split as you zoom in; objects at the same location show as one marker with a count; a mixed cluster uses a neutral colour. Tapping a marker opens a detail preview and the selected marker doubles in size. On mobile the detail is a bottom sheet the user can drag between collapsed, half and full; on tablet landscape it is a side sheet. The add action is a floating button at the bottom right.
- **Evidence ([Material bottom sheets, via KivyMD docs quoting the guideline](https://kivymd.readthedocs.io/en/latest/_sources/components/bottomsheet/index.rst)):** a standard bottom sheet lives beside the main UI so both can be used at once, and an audio player in a music app is the stated example; a modal sheet blocks the rest. A [design system's guidance](https://design-system-test.c3t.yle.fi/docs/components/BottomSheet) says not to use a sheet for complex multi-step workflows.
- **Evidence ([Esri Press, contents list only](https://www.esri.com/content/dam/esrisites/en-us/esri-press/browse/designing-map-interfaces-toc.pdf)):** the book names patterns such as cluster marker, info panel, timeline slider, spatial filter, locate me and search this area, and mistakes called desert fog and kitchen sink. I read only the contents, not the chapters.
- **Decision:** the place sheet is a standard (non-modal) sheet so the map stays usable; recording and upload are full-screen steps, not sheets; a timeline slider belongs in the "this place over time" view; the first view must show data (avoid an empty map).

### Listening
- **Evidence:** audio that plays automatically for more than 3 seconds needs a pause, stop or independent volume control ([WCAG 1.4.2 rule](https://dequeuniversity.com/rules/axe/4.13/no-autoplay-audio)). Prerecorded audio-only content needs a text alternative, usually a transcript ([WCAG 1.2.1 test guidance](https://digitalaccessibility.nyu.edu/testing/sc121.html)).
- **Evidence:** a native audio element gives accessible controls for free; a custom player needs labelled buttons, a slider with spoken time text and a landmark region ([DEV guide](https://dev.to/stanlymt/make-your-embedded-audio-player-accessible-2od)). Deezer's write-up describes a seek slider with value text and arrow-key steps of about 5 seconds and Page keys of 30 seconds ([Deezer, from the article excerpt](https://newsroom-deezer.com/2017/05/towards-an-accessible-player)).
- **Decision:** sound starts only after a tap; "Play as ambience" is an explicit button with a sleep timer; every recording has a written "what you can hear" description (not a speech transcript; we discourage speech) that also feeds search; the waveform is for orientation and seeking, never the only control; respect `prefers-reduced-motion` and offer a dark theme for night listening.

### Recording and permissions
- **Evidence ([web.dev](https://web.dev/articles/permissions-best-practices)):** ask only after a user action, explain first in a pre-prompt, offer an alternative, and detect a denied permission to show browser-specific recovery steps. Chrome desktop data: prompts shown with no sign of intent were allowed 12% of the time; after an interaction, 30%.
- **Evidence:** browsers apply echo cancellation, noise suppression and automatic gain by default (Firefox's own [test](https://searchfox.org/firefox-main/source/dom/media/webrtc/tests/mochitests/test_defaultAudioConstraints.html) checks that they are on). [Addpipe's tests](https://blog.addpipe.com/getusermedia-audio-constraints/) found Chrome ignoring the gain constraint unless echo cancellation is also turned off, and Safari unable to control noise suppression and gain. Those tests are from 2017 (page updated 2026), so browser versions differ.
- **Evidence:** Chrome and Firefox record Opus in WebM or Ogg ([polyfill README](https://github.com/ai/audio-recorder-polyfill/blob/master/README.md)). Safari 18.4 rewrote MediaRecorder and added WebM and new codecs, including ALAC and PCM, according to an [Apple engineer's comment](https://bugs.webkit.org/show_bug.cgi?id=290002); Ogg Opus in Safari is [reported as buggy](https://frequal.com/java/OggOpusStillNotWorkingInSafari18_4.html). On iOS the audio context starts suspended until a tap ([OpenReplay](https://blog.openreplay.com/record-audio-browser-web-audio-api/)).
- **Decision:** microphone: pre-prompt on the record button, with "upload a file instead" as the alternative. Location: a "use my location" button beside place search and manual pin dropping. Request echo cancellation, noise suppression and gain off, then read back `track.getSettings()` and store what was actually applied in `capture_info`; warn when a browser ignored it. Check `MediaRecorder.isTypeSupported()` and store the real MIME type. Label browser recordings "recorded in browser (compressed)" unless a lossless type was really produced, and steer serious recordists to upload a lossless file from their recorder.

### Basemap and licences
- **Evidence:** a map using the Protomaps basemap must visibly show © OpenStreetMap, for example in the corner ([Protomaps styles](https://github.com/protomaps/styles)). Protomaps ships light, dark, white, black and grayscale themes ([docs](https://docs.protomaps.com/basemaps/maplibre)). Required attribution must not be covered, the style URL should live in config so the provider can change, and OpenFreeMap's public instance is provided as-is, so use a provider with guarantees or self-host for anything critical ([MapLibre guide](https://scripts.nuxt.com/scripts/maplibre/guides/styles-and-providers)).
- **Decision:** a grayscale or light basemap (and a dark one for the dark theme); our accent colour only on sound pins; the place sheet never covers the attribution.

### Accessibility baseline (WCAG 2.2 AA)
- **Evidence ([W3C 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)):** targets are at least 24 by 24 CSS pixels, with exceptions (spacing, an equivalent control, inline text). The page points to the stricter 2.5.5 for important controls. Other sources give 44 points for Apple and 48 dp for Android ([summary](https://www.webability.io/glossary/target-size)).
- **Decision:** design every control at 44 px or more; text contrast 4.5:1 and interface parts 3:1 in both themes; colours that must be told apart also differ in lightness; visible focus; everything keyboard-operable, which means the map needs a **list view of the same recordings** with search and filters (maps are hard to use without a pointer); reduced-motion and colour-scheme preferences respected.

## 4. Design principles for Sound Archive (decisions)

1. **Sound first, map second.** The object is a recording; photos are a smaller strip of context.
2. **One interface for everyone.** No modes or tiers. "Play this place" and "Compare over time" are two entry points into the same screens.
3. **Quiet map, loud sound.** Muted basemap, one accent colour for sound.
4. **Never surprise with sound.**
5. **Honest about quality and provenance.** Show format, sample rate, bit depth, channels, microphone, setup and date on every recording.
6. **Time is a first-class thing.** The recording date is always visible; a place has a timeline.
7. **Privacy in the interface.** Option to blur the exact position, a notice about voices at publish time, pre-prompts for permissions.
8. **Mobile first.** People record in the field, usually one-handed. Desktop gets a side panel.
9. **Calm.** Restrained motion, no autoplay, generous spacing.

## 5. Screens and states to design

Phone first (390x844), then desktop (1440):
1. Map home: pins, clusters, search, locate me, the add button, list-view toggle, attribution.
2. Place sheet: peek, half and full states; recordings of the place by date; photo strip.
3. Recording page: player with waveform, description of what you hear, capture details (recorder, microphones, setup, placement, processing), date, licence, location accuracy.
4. Ambience mode and mini-player: loop, sleep timer, background-friendly.
5. Record flow: pre-prompt, level meter, review, details, place and privacy, publish.
6. Upload flow: pick file, read technical facts, same details form.
7. Compare over time: timeline slider for one place.
8. Permission pre-prompts and blocked states (microphone, location).
9. Empty, loading, error and offline states; processing state ("making the streaming copy").
10. Dark theme of the above; desktop layout with side panel.
Account screens come in phase 6 and are not part of this round.

## 6. Process with Claude Design

1. Settle the visual direction (questions in section 8).
2. Create the Design System "Sound Archive": tokens in light and dark, a README with the principles and accessibility rules above, and components: pin, cluster, selected pin, place sheet, recording card, mini-player, full player, waveform, record button with level meter, capture form fields, pre-prompt, toast, empty states.
3. Create the Design canvas using that system, with the screens in section 5; review together and iterate.
4. Check the designs against section 7.
5. Hand off to the repository: `docs/design/` with the tokens, screenshots, the component inventory and the canvas link. The phase 3 front-end prompt for the VS Code agent carries the component list and the checks (contrast, target size, keyboard).
6. Change tokens in the design system first; code reads them as CSS variables.

## 7. Acceptance checks for the designs (before any code)

- Contrast checked in both themes; every control at least 44 px.
- Every screen has loading, empty and error states.
- Microphone and location pre-prompts and blocked states are designed.
- The map has a list alternative; there is no autoplay anywhere.
- Attribution is visible and never covered by the sheet.
- Spanish and English text lengths fit.

## 8. Open design questions

1. Visual mood: calm and natural, technical and studio-like, or warm and editorial?
2. Light or dark by default?
3. Languages at launch (Spanish, English)?
4. Name and logo: is "Sound Archive" final?
5. Is ambience mode with a sleep timer a headline feature or a later one?
6. Public or private by default for new recordings (affects the publish step)?
7. Are contributor names shown on recordings?

## 9. What was not verified

- I did not open the live interfaces of the reference maps, only articles and pages about them. Several descriptions come from press and Wikipedia.
- The Deezer article loaded only as a search excerpt (its page redirected in a loop); the Esri book was read only as a contents list.
- Safari recording facts rely on an Apple engineer's comment and a third-party summary that did not load; test on real devices.
- The Addpipe browser tests are from 2017: re-test echo cancellation, noise suppression, gain, sample rate and channel count on the target browsers, including iOS Safari.
- `/design-sync` was not tried.
- Browser-side lossless capture (an AudioWorklet writing WAV) was not researched.
