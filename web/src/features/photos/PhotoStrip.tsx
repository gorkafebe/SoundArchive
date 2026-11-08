// Photos of a place: a strip of 4:3 thumbnails, an accessible enlarged view,
// and the small form to add one.
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { Icon } from "../../components/Icon";
import { Field, useToast } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { ApiError, listPhotos, photoUrl, removePhoto, uploadPhoto, type Photo } from "../../lib/api";

import "./photos.css";

const MAX_BYTES = 20 * 1024 * 1024;

function errorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "not_an_image") return "photos.error.notImage";
    if (error.code === "image_too_large" || error.status === 413) return "photos.error.tooLarge";
    if (error.code === "photo_limit") return "photos.error.limit";
    if (error.status === 0) return "photos.error.network";
  }
  return "photos.error.server";
}

export function PhotoStrip({ placeId, isAdmin }: { placeId: string; isAdmin: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [open, setOpen] = useState<Photo | null>(null);
  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listPhotos(placeId, controller.signal)
      .then(setPhotos)
      .catch(() => {});
    return () => controller.abort();
  }, [placeId, version]);

  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);

  function close() {
    dialogRef.current?.close();
    setOpen(null);
    opener.current?.focus();
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    if (chosen && chosen.size > MAX_BYTES) {
      setFile(null);
      setError(t("photos.error.tooLarge"));
      return;
    }
    setError(null);
    setFile(chosen);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setError(t("photos.chooseFirst"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadPhoto(placeId, file, caption.trim(), alt.trim());
      setAdding(false);
      setFile(null);
      setAlt("");
      setCaption("");
      setVersion((n) => n + 1);
      toast(t("photos.added"));
    } catch (failure) {
      setError(t(errorKey(failure)));
    } finally {
      setBusy(false);
    }
  }

  async function remove(photo: Photo) {
    await removePhoto(photo.id);
    close();
    setVersion((n) => n + 1);
    toast(t("photos.removed"));
  }

  return (
    <section aria-label={t("photos.title")}>
      {photos.length > 0 && (
        <ul className="photo-strip">
          {photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                className="photo-strip__item"
                aria-label={t("photos.open", { description: photo.alt_text ?? photo.caption ?? t("photos.noDescription") })}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setOpen(photo);
                }}
              >
                <img src={photoUrl(photo.id, "thumb")} alt="" loading="lazy" />
              </button>
              {photo.caption && <p className="caption">{photo.caption}</p>}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form className="card photo-form" onSubmit={submit} noValidate>
          <Field label={t("photos.file")} hint={t("photos.fileHint")}>
            {(props) => <input {...props} className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} data-testid="photo-input" />}
          </Field>
          <Field label={t("photos.alt")} hint={t("photos.altHint")}>
            {(props) => <input {...props} className="input" maxLength={500} value={alt} onChange={(e) => setAlt(e.target.value)} />}
          </Field>
          <Field label={t("photos.caption")}>
            {(props) => <input {...props} className="input" maxLength={300} value={caption} onChange={(e) => setCaption(e.target.value)} />}
          </Field>
          {error && (
            <p className="field__error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="sa-btn sa-btn--primary" disabled={busy}>
              {t("photos.add")}
            </button>
            <button type="button" className="sa-btn sa-btn--quiet" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="sa-btn sa-btn--quiet" onClick={() => setAdding(true)}>
          <Icon name="camera" size={20} />
          {t("photos.add")}
        </button>
      )}

      {/* <dialog> with showModal() traps the focus and closes with Esc by itself. */}
      {open && (
        <dialog ref={dialogRef} className="photo-dialog" aria-label={t("photos.enlarged")} onClose={() => setOpen(null)}>
          <img src={photoUrl(open.id, "large")} alt={open.alt_text ?? ""} />
          <div className="photo-dialog__foot">
            <div>
              {open.caption && <p>{open.caption}</p>}
              {open.alt_text && <p className="caption">{open.alt_text}</p>}
            </div>
            <div className="actions">
              {(open.is_owner || isAdmin) && (
                <button type="button" className="sa-btn sa-btn--danger" onClick={() => remove(open)}>
                  <Icon name="trash" size={20} />
                  {t("photos.remove")}
                </button>
              )}
              <button type="button" className="sa-btn" onClick={close}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </section>
  );
}
