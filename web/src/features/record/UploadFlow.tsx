// Uploading a file (screen 07): choose, describe, send with real progress.
// A dropped connection only pauses it (lib/upload.ts), and nothing typed is
// lost when something fails.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { Icon } from "../../components/Icon";
import { useToast } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { getPlace, type Place, type Recording } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { formatBytes } from "../player/format";
import { initialValues, JobStatus, PublishFields, usePublishJob, type PublishValues } from "./publish";

import "./record.css";

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ACCEPT = ".wav,.flac,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,audio/*";

export function UploadFlow({ placeId }: { placeId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const { navigate } = useRouter();
  const [place, setPlace] = useState<Place | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [values, setValues] = useState<PublishValues>(() => initialValues(new Date()));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const controller = new AbortController();
    getPlace(placeId, controller.signal)
      .then(setPlace)
      .catch(() => {});
    return () => controller.abort();
  }, [placeId]);

  const onReady = useCallback(
    (recording: Recording) => {
      toast(t("publish.done"));
      navigate(`/recordings/${recording.id}`);
    },
    [navigate, t, toast],
  );
  const job = usePublishJob(onReady);
  const busy = job.state.kind === "uploading" || job.state.kind === "processing";

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    if (!chosen) return;
    if (chosen.size > MAX_BYTES) {
      setFile(null);
      setFileError(t("publish.error.tooLarge"));
      return;
    }
    setFileError(null);
    setFile(chosen);
    job.reset();
    // Its date is the best guess of when it was recorded; it can be changed.
    setValues((v) => ({ ...initialValues(new Date(chosen.lastModified)), title: v.title, heard: v.heard }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setFileError(t("upload.chooseFirst"));
      return;
    }
    if (!values.title.trim()) {
      setTitleError(t("publish.titleRequired"));
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    void job.start(placeId, values, file, file.name, { method: "upload", settings: null });
  }

  return (
    <div className="page">
      <form className="page__inner record" onSubmit={submit} noValidate>
        <div className="page__bar">
          <button type="button" className="sa-btn sa-btn--quiet" onClick={() => navigate(`/?place=${placeId}`)} disabled={busy}>
            <Icon name="close" size={20} />
            {t("common.cancel")}
          </button>
        </div>
        <h1 ref={headingRef} tabIndex={-1} className="page__title">
          {t("upload.title")}
        </h1>
        {place && <p className="page__eyebrow">{place.name}</p>}

        <div className="upload-drop">
          <Icon name="upload" size={32} />
          <p>{t("upload.choose")}</p>
          <p className="caption">{t("upload.formats")}</p>
          <input ref={inputRef} className="visually-hidden" type="file" accept={ACCEPT} onChange={choose} data-testid="file-input" tabIndex={-1} aria-hidden="true" />
          <button type="button" className="sa-btn sa-btn--primary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {t("upload.chooseButton")}
          </button>
        </div>
        {fileError && (
          <p className="field__error" role="alert">
            {fileError}
          </p>
        )}
        {file && (
          <div className="card">
            <p className="upload-file">
              <span>{file.name}</span>
              <span className="meta">{formatBytes(file.size)}</span>
            </p>
          </div>
        )}

        <PublishFields values={values} onChange={setValues} titleError={titleError} titleRef={titleRef} />
        <JobStatus state={job.state} formatBytes={formatBytes} />
        <p className="caption">{t("upload.keepOpen")}</p>
        <div className="actions">
          <button type="submit" className="sa-btn sa-btn--primary" disabled={busy}>
            <Icon name="upload" size={20} />
            {t("upload.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
