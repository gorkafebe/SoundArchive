// Taking a photo with the computer's own camera, inside the page.
//
// On a phone the file picker with capture="environment" (see PhotoStrip) opens
// the real camera app, which is better. A computer has no such thing, hence
// this: a live preview, take the photo, repeat or use it.
//
// The camera is asked for only after a tap on a screen that says why, and it
// is released as soon as it is not needed: after taking the photo, on closing,
// when the tab is hidden, and when this component goes away. The light on the
// camera must go off.
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { PrePrompt } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";

type Stage = "intro" | "starting" | "live" | "review" | "blocked" | "none" | "error";

const LONGEST_SIDE = 4096;
const JPEG_QUALITY = 0.9;

function stopAll(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** A file made from one frame of the video, never larger than the server takes. */
function frameToBlob(video: HTMLVideoElement): Promise<Blob | null> {
  const scale = Math.min(1, LONGEST_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

export function CameraCapture({ onUse, onClose }: { onUse: (photo: File) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [stage, setStage] = useState<Stage>("intro");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Which attempt is current: a stream that arrives after a newer attempt, or
  // after closing, is stopped at once instead of being shown.
  const attemptRef = useRef(0);

  const release = useCallback(() => {
    attemptRef.current += 1;
    stopAll(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => release, [release]);

  // Not watching the tab: no reason for the camera to stay on.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && streamRef.current) {
        release();
        setStage("intro");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [release]);

  useEffect(() => {
    return () => {
      if (shot) URL.revokeObjectURL(shot.url);
    };
  }, [shot]);

  async function start(deviceId = cameraId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStage("none");
      return;
    }
    release();
    const attempt = attemptRef.current;
    setStage("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" },
      });
      if (attempt !== attemptRef.current) {
        stopAll(stream);
        return;
      }
      streamRef.current = stream;
      setStage("live");
      // Names of the cameras are only available once permission is given.
      const devices = await navigator.mediaDevices.enumerateDevices?.();
      if (attempt === attemptRef.current) setCameras((devices ?? []).filter((device) => device.kind === "videoinput"));
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      const name = error instanceof DOMException ? error.name : "";
      setStage(name === "NotAllowedError" ? "blocked" : name === "NotFoundError" || name === "OverconstrainedError" ? "none" : "error");
    }
  }

  // The <video> exists from the "live" stage on.
  useEffect(() => {
    const video = videoRef.current;
    if (stage !== "live" || !video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    video.play().catch(() => {});
  }, [stage]);

  async function take() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const blob = await frameToBlob(video);
    release();
    if (!blob) {
      setStage("error");
      return;
    }
    setShot({ blob, url: URL.createObjectURL(blob) });
    setStage("review");
  }

  function repeat() {
    setShot(null);
    void start();
  }

  function use() {
    if (!shot) return;
    onUse(new File([shot.blob], "camera.jpg", { type: "image/jpeg" }));
  }

  function close() {
    release();
    onClose();
  }

  const closeButton = (
    <button type="button" className="sa-btn sa-btn--quiet" onClick={close}>
      {t("photos.camera.useFile")}
    </button>
  );

  if (stage === "intro" || stage === "starting") {
    return (
      <PrePrompt
        as="h3"
        icon="camera"
        title={t("photos.camera.introTitle")}
        actions={
          <>
            <button type="button" className="sa-btn sa-btn--primary" disabled={stage === "starting"} onClick={() => void start()}>
              {stage === "starting" ? t("photos.camera.starting") : t("photos.camera.turnOn")}
            </button>
            {closeButton}
          </>
        }
      >
        {t("photos.camera.introBody")}
      </PrePrompt>
    );
  }

  if (stage === "blocked" || stage === "none" || stage === "error") {
    return (
      <div className="notice notice--error" role="alert">
        <p>{t(`photos.camera.${stage}`)}</p>
        {stage === "blocked" && <p>{t("photos.camera.blockedHelp")}</p>}
        <div className="actions">
          {stage !== "none" && (
            <button type="button" className="sa-btn" onClick={() => void start()}>
              {t("common.retry")}
            </button>
          )}
          {closeButton}
        </div>
      </div>
    );
  }

  return (
    <div className="photo-camera">
      {stage === "live" && (
        <>
          <video ref={videoRef} className="photo-camera__frame" muted playsInline aria-label={t("photos.camera.preview")} />
          {cameras.length > 1 && (
            <label className="field">
              <span className="field__label">{t("photos.camera.choose")}</span>
              <select
                className="input"
                value={cameraId}
                onChange={(event) => {
                  setCameraId(event.target.value);
                  void start(event.target.value);
                }}
              >
                <option value="">{t("photos.camera.default")}</option>
                {cameras.map((camera, index) => (
                  <option key={camera.deviceId || index} value={camera.deviceId}>
                    {camera.label || t("photos.camera.numbered", { number: index + 1 })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="actions">
            <button type="button" className="sa-btn sa-btn--primary" onClick={() => void take()}>
              <Icon name="camera" size={20} />
              {t("photos.camera.take")}
            </button>
            {closeButton}
          </div>
        </>
      )}
      {stage === "review" && shot && (
        <>
          <img className="photo-camera__frame" src={shot.url} alt={t("photos.camera.taken")} />
          <div className="actions">
            <button type="button" className="sa-btn sa-btn--primary" onClick={use}>
              {t("photos.camera.use")}
            </button>
            <button type="button" className="sa-btn" onClick={repeat}>
              {t("photos.camera.repeat")}
            </button>
            {closeButton}
          </div>
        </>
      )}
    </div>
  );
}
