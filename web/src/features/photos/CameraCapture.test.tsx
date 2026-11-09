import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../i18n/i18n";
import { CameraCapture } from "./CameraCapture";

function fakeStream() {
  const track = { stop: vi.fn(), kind: "video" };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function stubCamera(getUserMedia: ReturnType<typeof vi.fn>, devices: Partial<MediaDeviceInfo>[] = []) {
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => devices) },
  });
}

function renderCamera() {
  const onUse = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <I18nProvider language="es">
      <CameraCapture onUse={onUse} onClose={onClose} />
    </I18nProvider>,
  );
  return { onUse, onClose, ...view };
}

beforeEach(() => {
  // jsdom has no video or canvas. These stand in for a working camera frame.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })));
  URL.createObjectURL = vi.fn(() => "blob:shot");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TURN_ON = { name: "Activar la cámara" };
const TAKE = { name: "Hacer foto" };

describe("CameraCapture", () => {
  it("explains first and does not touch the camera until the tap", () => {
    const getUserMedia = vi.fn();
    stubCamera(getUserMedia);
    renderCamera();
    expect(screen.getByText(/La imagen solo sale de este dispositivo si eliges usarla/)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("asks for video only, with the rear camera preferred", async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    stubCamera(getUserMedia);
    renderCamera();
    await userEvent.click(screen.getByRole("button", TURN_ON));
    await screen.findByRole("button", TAKE);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: "environment" } });
  });

  it("takes a photo, releases the camera, repeats, and hands over a JPEG", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    stubCamera(getUserMedia);
    const { onUse } = renderCamera();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", TURN_ON));
    await u.click(await screen.findByRole("button", TAKE));
    expect(await screen.findByRole("img", { name: "Foto que acabas de hacer" })).toBeInTheDocument();
    expect(first.track.stop).toHaveBeenCalled();

    await u.click(screen.getByRole("button", { name: "Repetir" }));
    await u.click(await screen.findByRole("button", TAKE));
    expect(second.track.stop).toHaveBeenCalled();

    await u.click(await screen.findByRole("button", { name: "Usar esta foto" }));
    const file = onUse.mock.calls[0][0] as File;
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toBe("camera.jpg");
  });

  it("stops the camera when closed", async () => {
    const { stream, track } = fakeStream();
    stubCamera(vi.fn(async () => stream));
    const { onClose } = renderCamera();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", TURN_ON));
    await screen.findByRole("button", TAKE);
    await u.click(screen.getByRole("button", { name: "Elegir un archivo en su lugar" }));
    expect(track.stop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("stops the camera when the component goes away", async () => {
    const { stream, track } = fakeStream();
    stubCamera(vi.fn(async () => stream));
    const { unmount } = renderCamera();
    await userEvent.click(screen.getByRole("button", TURN_ON));
    await screen.findByRole("button", TAKE);
    unmount();
    expect(track.stop).toHaveBeenCalled();
  });

  it("stops the camera when the tab is hidden", async () => {
    const { stream, track } = fakeStream();
    stubCamera(vi.fn(async () => stream));
    renderCamera();
    await userEvent.click(screen.getByRole("button", TURN_ON));
    await screen.findByRole("button", TAKE);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(track.stop).toHaveBeenCalled();
    expect(await screen.findByRole("button", TURN_ON)).toBeInTheDocument();
  });

  it("a stream that arrives after closing is stopped at once", async () => {
    const { stream, track } = fakeStream();
    let deliver: (value: MediaStream) => void = () => {};
    stubCamera(vi.fn(() => new Promise<MediaStream>((resolve) => (deliver = resolve))));
    const { unmount } = renderCamera();
    await userEvent.click(screen.getByRole("button", TURN_ON));
    unmount();
    deliver(stream);
    await waitFor(() => expect(track.stop).toHaveBeenCalled());
  });

  it("blocked: says how to allow it and offers the file instead", async () => {
    stubCamera(vi.fn().mockRejectedValue(new DOMException("no", "NotAllowedError")));
    renderCamera();
    await userEvent.click(screen.getByRole("button", TURN_ON));
    expect(await screen.findByRole("alert")).toHaveTextContent("El navegador tiene bloqueada la cámara");
    expect(screen.getByText(/abre los ajustes del sitio/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elegir un archivo en su lugar" })).toBeInTheDocument();
  });

  it("no camera: says so, with no pointless retry", async () => {
    stubCamera(vi.fn().mockRejectedValue(new DOMException("no", "NotFoundError")));
    renderCamera();
    await userEvent.click(screen.getByRole("button", TURN_ON));
    expect(await screen.findByRole("alert")).toHaveTextContent("No encontramos ninguna cámara");
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });

  it("a browser without the camera API gets the same message", async () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: undefined });
    renderCamera();
    await userEvent.click(screen.getByRole("button", TURN_ON));
    expect(await screen.findByRole("alert")).toHaveTextContent("No encontramos ninguna cámara");
  });

  it("offers a choice when there are several cameras", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    stubCamera(getUserMedia, [
      { kind: "videoinput", deviceId: "a", label: "Frontal" },
      { kind: "videoinput", deviceId: "b", label: "Trasera" },
      { kind: "audioinput", deviceId: "m", label: "Micro" },
    ]);
    renderCamera();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", TURN_ON));
    const select = await screen.findByLabelText("Cámara");
    expect(screen.queryByText("Micro")).not.toBeInTheDocument();
    await u.selectOptions(select, "b");
    await waitFor(() => expect(getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: "b" } } }));
    expect(first.track.stop).toHaveBeenCalled();
  });
});
