import { afterEach, describe, expect, it, vi } from "vitest";

import { json, mockFetch } from "../test/fakeApi";
import { uploadFile, type UploadProgress } from "./upload";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ID = "11111111-1111-4111-8111-111111111111";

function sentRanges(mock: ReturnType<typeof mockFetch>) {
  return mock.mock.calls
    .filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => (init?.headers as Record<string, string>)["Content-Range"]);
}

describe("uploadFile", () => {
  it("sends the file in order and reports progress", async () => {
    const received: number[] = [];
    const mock = mockFetch(async (url, init) => {
      if (init?.method === "PATCH") return json({ received: 0, total: 10, status: "uploading" });
      expect(url.pathname).toContain("/upload");
      return json({ received: 0, total: 10, status: "uploading" });
    });
    await uploadFile(ID, new Blob(["0123456789"]), (p: UploadProgress) => received.push(p.sent), new AbortController().signal);
    expect(sentRanges(mock)).toEqual(["bytes 0-9/10"]);
    expect(received.at(-1)).toBe(10);
  });

  it("starts from where the server says it stopped", async () => {
    const mock = mockFetch(async (_url, init) =>
      init?.method === "PATCH" ? json({}) : json({ received: 4, total: 10, status: "uploading" }),
    );
    await uploadFile(ID, new Blob(["0123456789"]), () => {}, new AbortController().signal);
    expect(sentRanges(mock)).toEqual(["bytes 4-9/10"]);
  });

  it("after a lost connection it asks again and continues", async () => {
    vi.useFakeTimers();
    let state = 0;
    let failures = 1;
    const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        if (failures-- > 0) {
          state = 6; // part of the piece arrived before the cut
          throw new TypeError("network down");
        }
        return json({});
      }
      return json({ received: state, total: 10, status: "uploading" });
    });
    vi.stubGlobal("fetch", mock);
    const seen: UploadProgress[] = [];
    const done = uploadFile(ID, new Blob(["0123456789"]), (p) => seen.push(p), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(seen.some((p) => p.waiting)).toBe(true);
    expect(sentRanges(mock as never)).toEqual(["bytes 0-9/10", "bytes 6-9/10"]);
  });

  it("follows the server when the offset is wrong", async () => {
    let calls = 0;
    const mock = mockFetch(async (_url, init) => {
      if (init?.method !== "PATCH") return json({ received: 0, total: 10, status: "uploading" });
      calls += 1;
      return calls === 1 ? json({ detail: { code: "wrong_offset", received: 3 } }, 409) : json({});
    });
    await uploadFile(ID, new Blob(["0123456789"]), () => {}, new AbortController().signal);
    expect(sentRanges(mock)).toEqual(["bytes 0-9/10", "bytes 3-9/10"]);
  });

  it("does not retry what can never succeed", async () => {
    mockFetch(async (_url, init) =>
      init?.method === "PATCH" ? json({ detail: { code: "too_large" } }, 413) : json({ received: 0, total: 10, status: "uploading" }),
    );
    await expect(uploadFile(ID, new Blob(["0123456789"]), () => {}, new AbortController().signal)).rejects.toMatchObject({ status: 413 });
  });

  it("stops at once when the upload is already complete", async () => {
    const mock = mockFetch(async () => json({ received: 10, total: 10, status: "processing" }));
    await uploadFile(ID, new Blob(["0123456789"]), () => {}, new AbortController().signal);
    expect(sentRanges(mock)).toEqual([]);
  });
});
