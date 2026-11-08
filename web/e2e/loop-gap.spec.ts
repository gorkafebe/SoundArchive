// Measures the gap of the audio element's own loop, on a continuous tone: the
// page listens to its own output and records the longest run of silence.
// Writes the figures to test-results/loop-gap.json; it does not judge them,
// because the honest result is the number (see IMPLEMENTATION_NOTES.md).
import { writeFileSync } from "node:fs";

import { expect, prepare, test } from "./fixtures";
import { createPlace, uploadAudio } from "./helpers";

test("measure the seam of the loop", async ({ page }) => {
  test.setTimeout(60_000);
  await prepare(page);
  const placeId = await createPlace(page.request, "Medida del bucle");
  const id = await uploadAudio(page.request, placeId, "short.wav", "Costura");
  await page.goto(`/recordings/${id}/ambient`);
  await page.locator(".ambient__controls").getByRole("button", { name: /^Reproducir/ }).click();
  const result = await page.evaluate(async () => {
    const audio = document.querySelector('[data-testid="global-audio"]') as HTMLAudioElement;
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const processor = context.createScriptProcessor(1024, 1, 1);
    let run = 0;
    const silences: number[] = [];
    let total = 0;
    processor.onaudioprocess = (event) => {
      for (const sample of event.inputBuffer.getChannelData(0)) {
        total += 1;
        if (Math.abs(sample) < 0.002) run += 1;
        else {
          if (run > 8) silences.push(run);
          run = 0;
        }
      }
    };
    source.connect(processor);
    processor.connect(context.destination);
    await context.resume();
    audio.currentTime = 0;
    await audio.play();
    await new Promise((resolve) => setTimeout(resolve, 9000));
    return { sampleRate: context.sampleRate, totalSamples: total, silences };
  });
  const gapsMs = result.silences.map((samples) => (samples / result.sampleRate) * 1000);
  const report = {
    sampleRate: result.sampleRate,
    seconds: result.totalSamples / result.sampleRate,
    gapsMs,
    longestGapMs: gapsMs.length ? Math.max(...gapsMs) : 0,
  };
  writeFileSync("test-results/loop-gap.json", JSON.stringify(report, null, 2));
  expect(report.seconds).toBeGreaterThan(5);
});
