// Sends a file in pieces, and resumes after a dropped connection: on any
// failure it asks the server how much it has and continues from there. The
// server's count is the truth, not ours.
import { ApiError, apiFetch, getUploadState, parseFailure } from "./api";

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_WAIT_MS = 30_000;

export interface UploadProgress {
  sent: number;
  total: number;
  /** True while waiting for the connection to come back. */
  waiting: boolean;
}

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

// Errors worth retrying: no connection, a server restarting, a lock left by a
// connection that is still dying.
function retriable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 0 || error.status >= 502 || error.code === "upload_in_progress" || error.status === 408;
}

export async function uploadFile(
  recordingId: string,
  file: Blob,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = `/api/recordings/${encodeURIComponent(recordingId)}/upload`;
  const total = file.size;
  let offset = 0;
  let attempt = 0;
  let needState = true;

  while (true) {
    try {
      if (needState) {
        const state = await getUploadState(recordingId, signal);
        if (state.status !== "uploading") return; // already complete
        offset = state.received;
        needState = false;
        onProgress({ sent: offset, total, waiting: false });
      }
      if (offset >= total) return;

      const end = Math.min(offset + CHUNK_BYTES, total);
      const response = await apiFetch(url, {
        method: "PATCH",
        body: file.slice(offset, end),
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        },
        signal,
      });
      if (!response.ok) {
        const failure = await parseFailure(response);
        if (failure.code === "wrong_offset" && failure.received !== undefined) {
          offset = failure.received;
          continue;
        }
        throw failure;
      }
      offset = end;
      attempt = 0;
      onProgress({ sent: offset, total, waiting: false });
      if (offset >= total) return;
    } catch (error) {
      if (!retriable(error)) throw error;
      onProgress({ sent: offset, total, waiting: true });
      await wait(backoffMs(attempt++), signal);
      needState = true;
    }
  }
}
