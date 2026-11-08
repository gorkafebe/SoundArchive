// What grabar and subir share: the publication form and the job that creates
// the recording, sends the file and waits until the server has processed it.
import { useCallback, useRef, useState, type ReactNode } from "react";

import { Field, ProgressBar, Segmented } from "../../components/ui";
import { Badge } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { ApiError, createRecording, getRecording, LICENSES, type License, type Recording } from "../../lib/api";
import { uploadFile, type UploadProgress } from "../../lib/upload";

export interface PublishValues {
  title: string;
  heard: string;
  showAuthor: boolean;
  visibility: "public" | "private";
  license: License;
  deviceNote: string;
  recordedAt: string; // for <input type="datetime-local">
}

/** A date as <input type="datetime-local"> wants it, in this device's time. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function initialValues(recordedAt: Date): PublishValues {
  return {
    title: "",
    heard: "",
    showAuthor: true,
    visibility: "public",
    // Preselected, and the choice is always shown: an open question for the owner.
    license: "all-rights-reserved",
    deviceNote: "",
    recordedAt: toLocalInput(recordedAt),
  };
}

export function PublishFields({
  values,
  onChange,
  titleError,
  titleRef,
}: {
  values: PublishValues;
  onChange: (values: PublishValues) => void;
  titleError?: string | null;
  titleRef?: React.Ref<HTMLInputElement>;
}) {
  const { t } = useI18n();
  const set = <K extends keyof PublishValues>(key: K, value: PublishValues[K]) => onChange({ ...values, [key]: value });
  return (
    <div className="publish-fields">
      <Field label={t("publish.title")} error={titleError}>
        {(props) => <input {...props} ref={titleRef} className="input" maxLength={160} value={values.title} onChange={(e) => set("title", e.target.value)} />}
      </Field>
      <Field label={t("publish.heard")} hint={t("publish.heardHint")}>
        {(props) => (
          <textarea {...props} className="textarea" maxLength={2000} placeholder={t("publish.heardPlaceholder")} value={values.heard} onChange={(e) => set("heard", e.target.value)} />
        )}
      </Field>
      <Field label={t("publish.when")}>
        {(props) => <input {...props} className="input" type="datetime-local" value={values.recordedAt} onChange={(e) => set("recordedAt", e.target.value)} />}
      </Field>
      <Segmented
        label={t("publish.author")}
        value={values.showAuthor ? "name" : "anon"}
        options={[
          { value: "name", label: t("publish.myName") },
          { value: "anon", label: t("recording.anonymous") },
        ]}
        onChange={(value) => set("showAuthor", value === "name")}
      />
      <Segmented
        label={t("publish.visibility")}
        value={values.visibility}
        hint={t("publish.visibilityHint")}
        options={[
          { value: "public", label: t("publish.public") },
          { value: "private", label: t("publish.private") },
        ]}
        onChange={(value) => set("visibility", value as "public" | "private")}
      />
      <Field label={t("publish.license")} hint={t("publish.licenseHint")}>
        {(props) => (
          <select {...props} className="select publish-fields__select" value={values.license} onChange={(e) => set("license", e.target.value as License)}>
            {LICENSES.map((license) => (
              <option key={license} value={license}>
                {t(`license.${license}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t("publish.device")} hint={t("publish.deviceHint")}>
        {(props) => <input {...props} className="input" maxLength={160} value={values.deviceNote} onChange={(e) => set("deviceNote", e.target.value)} />}
      </Field>
    </div>
  );
}

type JobState =
  | { kind: "idle" }
  | { kind: "uploading"; progress: UploadProgress }
  | { kind: "processing" }
  | { kind: "failed"; message: string };

export function publishErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "publish.error.network";
    if (error.status === 413) return "publish.error.tooLarge";
    if (error.status === 507) return "publish.error.diskFull";
    if (error.status === 401) return "auth.expired";
  }
  return "publish.error.server";
}

const POLL_START_MS = 2000;
const POLL_MAX_MS = 10000;

/** Create the recording, send the file, wait for the server's verdict. */
export function usePublishJob(onReady: (recording: Recording) => void) {
  const { t } = useI18n();
  const [state, setState] = useState<JobState>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);

  const start = useCallback(
    async (
      placeId: string,
      values: PublishValues,
      file: Blob,
      filename: string | null,
      capture: { method: "browser" | "upload"; settings: Record<string, unknown> | null },
    ) => {
      const abort = new AbortController();
      controller.current = abort;
      setState({ kind: "uploading", progress: { sent: 0, total: file.size, waiting: false } });
      try {
        const recording = await createRecording({
          place_id: placeId,
          title: values.title.trim(),
          heard: values.heard.trim() || null,
          recorded_at: new Date(values.recordedAt).toISOString(),
          recorded_tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
          visibility: values.visibility,
          show_author: values.showAuthor,
          license: values.license,
          capture_method: capture.method,
          capture_settings: capture.settings,
          device_note: values.deviceNote.trim() || null,
          size: file.size,
          filename,
        });
        await uploadFile(recording.id, file, (progress) => setState({ kind: "uploading", progress }), abort.signal);
        setState({ kind: "processing" });
        // Polite polling: it starts quickly and slows down.
        let delay = POLL_START_MS;
        while (!abort.signal.aborted) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          const current = await getRecording(recording.id, abort.signal);
          if (current.status === "ready") {
            onReady(current);
            return;
          }
          if (current.status === "failed") {
            setState({ kind: "failed", message: t(`publish.failure.${current.failure_code ?? "processing_error"}`) });
            return;
          }
          delay = Math.min(delay * 1.5, POLL_MAX_MS);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "failed", message: t(publishErrorKey(error)) });
      }
    },
    [onReady, t],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => setState({ kind: "idle" }), []);
  return { state, start, cancel, reset };
}

export function JobStatus({ state, formatBytes }: { state: JobState; formatBytes: (n: number) => string }): ReactNode {
  const { t } = useI18n();
  if (state.kind === "uploading") {
    const percent = state.progress.total ? (state.progress.sent / state.progress.total) * 100 : 0;
    return (
      <div className="card" role="status" data-testid="upload-progress">
        <p className="meta">
          {formatBytes(state.progress.sent)} / {formatBytes(state.progress.total)}
        </p>
        <ProgressBar value={percent} label={t("publish.uploading")} />
        <p className="caption">
          {state.progress.waiting ? t("publish.waitingConnection") : t("publish.uploadingPercent", { percent: Math.round(percent) })}
        </p>
      </div>
    );
  }
  if (state.kind === "processing") {
    return (
      <div className="card" role="status" data-testid="processing">
        <div>
          <Badge tone="warning" icon="timer">
            {t("recording.status.processing")}
          </Badge>
        </div>
        <p className="caption">{t("publish.processingBody")}</p>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <p className="notice notice--error" role="alert">
        {state.message}
      </p>
    );
  }
  return null;
}
