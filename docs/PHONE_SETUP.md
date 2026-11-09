# Using Sound Archive on an Android phone

For the owner, when the phone joins the private network. The app has only been tested on a phone **in emulation** (Chromium at 390 x 844 with touch). Nothing on this page has been tried on a real device yet.

## 1. Join the tailnet

1. Install Tailscale from the Play Store.
2. Sign in with the same account as the MSI and the Lenovo.
3. Check the MSI appears in the Tailscale app, and is reachable.

## 2. Install the root certificate

The app uses a private certificate authority (see `docs/SECURITY.md`). The phone has to trust it, or the browser will warn and the microphone will not work: browsers only allow the microphone on HTTPS pages they trust.

1. Copy `root.crt` to the phone. It is the public part only, so sending it to yourself is fine.
2. Compare its SHA-256 fingerprint with the one in `PARA-GORKA.md`.
3. Open **Settings → Security → Encryption and credentials → Install a certificate → CA certificate**. The exact names vary a little by manufacturer.
4. Accept the warning. Android shows it for every certificate authority a user adds.

**Which browser:** Chrome on Android trusts certificates a user installs. **Firefox for Android does not** by default, so use Chrome.

## 3. Open the app

Go to `https://soundarchive:8443/` with Tailscale connected. If the short name does not resolve, use the full MagicDNS name from the Tailscale app.

With Tailscale off, the address must **not** open. That is the design: it is only reachable inside the tailnet.

## 4. What to check

| Check | Expected |
|---|---|
| The page loads with no certificate warning | Padlock shown, no interstitial |
| Record: press Continue | The browser asks for the microphone only then |
| Recording, meter moving | Bars react to sound |
| After recording, "How it was recorded" | Says honestly whether the phone could turn off echo cancellation, noise suppression and automatic gain. Phones often cannot |
| Use my location, when adding a place | The browser asks; the accuracy is shown |
| Playback with the screen locked | Sound continues; lock-screen controls show the title and place (Media Session API) |
| Ambient mode with "Keep the screen on" | The screen stays on while the page is open |
| Dragging the place sheet | Moves between its three heights |
| Uploading a large file, then switching to Wi-Fi off and on | The upload pauses and continues by itself |

Report anything different; each row is a real unknown until tried.

## Location and camera (added 2026-11-09)

To try after updating, none of it tested on a real phone yet:

- **Location.** "Use my current location" asks for permission only after the tap. It keeps refining for up to 8 s and shows the accuracy as "±N m"; above 100 m it says the position is approximate and lets you drag the marker. Indoors expect a rough reading: that is the GPS, not a fault.
- If you refused once, Chrome on Android does not ask again: tap the icon next to the address, Permissions, Location, Allow.
- **Camera.** "Take a photo" opens the phone's camera app directly (`capture="environment"`). Without the certificate from step 2 the page is not a secure context and the location will not work.
- **Known risks.** A browser may ignore `capture` and show the file picker instead, which still works. On iOS, Safari's location and camera were not tested. Very large photos are refused above 20 MB or 40 megapixels; a phone at maximum resolution can come close.

## The "show my location" button (added 2026-11-09)

Bottom right of the map. None of this has been tried on a real phone yet.

- The first time it explains what it does; the browser asks for permission only after you accept.
- **If you refused:** on Android, Chrome does not ask again by itself. Tap the icon next to the address, Permissions, Location, Allow. On iOS: Settings, Privacy & Security, Location Services, and the browser's entry; then the site's own setting.
- **Indoors** expect tens or hundreds of metres of doubt, and a position that wanders: the circle shows how much. Above 1000 m it says "approximate".
- **With the screen off or the tab in the background it stops**, on purpose, to save battery and because a page cannot rely on running then. It resumes when you come back.
- iOS Safari may not have the Permissions API, so the explanation can appear once per visit.

## 5. Known risks

- **Recording in the background.** Browsers stop or silence capture when the page is hidden or the phone locks. Keep the screen on and the page in front while recording. This is a platform limit that a web app cannot remove.
- **Long lossless recordings.** WAV capture stays on the device until it is sent, up to the 30-minute limit (about 520 MB). A phone short of memory may kill the tab; for long takes, use "Compressed".
- **Wake lock** is released whenever the page is hidden, and is taken again when it comes back. It needs a recent browser.
- **Battery optimisation** on some manufacturers' phones can stop background audio.
- **Formats on iPhone (Safari).** Not tested and not part of this phase. The listening copy is Opus in WebM, which is not guaranteed to play on every iOS version, so a decision is pending (see `PARA-GORKA.md`). Chrome on iOS uses the same engine, so it does not avoid this.
- **Microphone quality** varies widely. The server re-analyses each file, so the facts shown are measured, but a phone's capture chain may process sound in ways it does not report.
