// Adding a place: a full-screen flow in three steps (not a sheet: the design
// brief keeps sheets for quick looks and gives multi-step work its own screen).
//
//   1. Location: tap the small map, type latitude and longitude (the keyboard
//      way), or "use my location" (asks the browser, only after a tap).
//   2. Name and description.
//   3. Confirm, then create.
//
// Forms: real <label>s; hints and errors are linked to their field with
// aria-describedby; when a step has errors the focus goes to the first one.
// Nothing typed is lost on errors, going back, or a failed request.
import "./add-place.css";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { useAnnounce } from "../../components/Announcer";
import { useI18n } from "../../i18n/i18n";
import { ApiError, createPlace, type Place, type PublicConfig } from "../../lib/api";
import type { Camera } from "../map/MapView";
import { formatCoordinates } from "../map/geo";
import { LocationPicker } from "./LocationPicker";
import {
  DESCRIPTION_MAX,
  formatCoordinateInput,
  NAME_MAX,
  parseCoordinate,
  validateDetails,
  validateLocation,
  type Draft,
  type Errors,
  type Field,
} from "./validation";

type Step = 1 | 2 | 3;
const STEP_NAMES = { 1: "location", 2: "details", 3: "confirm" } as const;

type Geo =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "found"; meters: number }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "timeout" }
  | { kind: "unsupported" };

type Submit =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; reason: "network" | "server" | "validation" | "disabled"; status?: number };

interface AddPlaceFlowProps {
  config: PublicConfig;
  initialCamera: Camera;
  onCancel: () => void;
  onCreated: (place: Place) => void;
}

export function AddPlaceFlow(props: AddPlaceFlowProps) {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  if (!props.config.writes_enabled) {
    // The button stays visible, but on this server it leads to a clear
    // explanation instead of a form that would fail.
    return (
      <section className="add-place" aria-labelledby="add-place-heading">
        <div className="add-place__inner">
          <h2 id="add-place-heading" ref={headingRef} tabIndex={-1}>
            {t("add.title")}
          </h2>
          <div className="notice add-place__disabled">
            <p className="add-place__disabled-title">{t("add.disabled.title")}</p>
            <p>{t("add.disabled.body")}</p>
          </div>
          <div className="add-place__actions">
            <button type="button" className="sa-btn" onClick={props.onCancel}>
              {t("add.disabled.back")}
            </button>
          </div>
        </div>
      </section>
    );
  }
  return <AddPlaceForm {...props} />;
}

function AddPlaceForm({ config, initialCamera, onCancel, onCreated }: AddPlaceFlowProps) {
  const { t, language } = useI18n();
  const announce = useAnnounce();
  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<Draft>({ latitude: "", longitude: "", name: "", description: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [geo, setGeo] = useState<Geo>({ kind: "idle" });
  const [submit, setSubmit] = useState<Submit>({ kind: "idle" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fieldRefs = useRef<Partial<Record<Field, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const ids = {
    latitude: useId(),
    longitude: useId(),
    name: useId(),
    description: useId(),
  };

  // A new step (and the first one): start reading at its heading.
  useEffect(() => headingRef.current?.focus(), [step]);

  const lat = parseCoordinate(draft.latitude);
  const lon = parseCoordinate(draft.longitude);
  const point =
    lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;

  function update(field: Field, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
    // Clear a field's error as soon as it is being fixed.
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function setPoint(newLat: number, newLon: number) {
    setDraft((d) => ({
      ...d,
      latitude: formatCoordinateInput(newLat, language),
      longitude: formatCoordinateInput(newLon, language),
    }));
    setErrors((e) => ({ ...e, latitude: undefined, longitude: undefined }));
  }

  /** Show errors and put the focus on the first wrong field. */
  function check(found: Errors, order: Field[]): boolean {
    setErrors(found);
    const first = order.find((field) => found[field]);
    if (!first) return true;
    window.setTimeout(() => fieldRefs.current[first]?.focus(), 0);
    const count = order.filter((field) => found[field]).length;
    announce(t("validation.summary", { count }));
    return false;
  }

  function next(event: FormEvent) {
    event.preventDefault();
    if (step === 1 && check(validateLocation(draft), ["latitude", "longitude"])) setStep(2);
    else if (step === 2 && check(validateDetails(draft), ["name", "description"])) setStep(3);
  }

  async function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setGeo({ kind: "unsupported" });
      return;
    }
    // If the browser already blocks it, say how to unblock it instead of
    // asking again (the browser would refuse silently).
    try {
      const status = await navigator.permissions?.query({ name: "geolocation" });
      if (status?.state === "denied") {
        setGeo({ kind: "denied" });
        return;
      }
    } catch {
      // The Permissions API is missing or does not know "geolocation": just ask.
    }
    setGeo({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setPoint(position.coords.latitude, position.coords.longitude);
        const meters = Math.round(position.coords.accuracy);
        setGeo({ kind: "found", meters });
        announce(t("add.location.found", { meters }));
      },
      (error) => {
        const kind = error.code === error.PERMISSION_DENIED ? "denied" : error.code === error.TIMEOUT ? "timeout" : "unavailable";
        setGeo({ kind });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  async function create() {
    if (lat === null || lon === null) return;
    setSubmit({ kind: "submitting" });
    try {
      const place = await createPlace({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        latitude: lat,
        longitude: lon,
        ...(geo.kind === "found" ? { location_accuracy_m: geo.meters } : {}),
      });
      announce(t("add.success", { name: place.name }));
      onCreated(place);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const reason =
        status === 0 ? "network" : status === 403 ? "disabled" : status === 422 ? "validation" : "server";
      setSubmit({ kind: "error", reason, status });
    }
  }

  const describedBy = (field: Field, hint = true) =>
    [hint ? `${ids[field]}-hint` : null, errors[field] ? `${ids[field]}-error` : null].filter(Boolean).join(" ") ||
    undefined;

  const errorText = (field: Field) => {
    const error = errors[field];
    return error ? (
      <p id={`${ids[field]}-error`} className="field__error">
        {t(error.key, error.vars)}
      </p>
    ) : null;
  };

  const errorCount = Object.values(errors).filter(Boolean).length;

  return (
    <section className="add-place" aria-labelledby="add-place-heading">
      <div className="add-place__inner">
        <h2 id="add-place-heading" ref={headingRef} tabIndex={-1}>
          {t("add.title")}
          <span className="add-place__step">
            {t("add.step", { step, total: 3, name: t(`add.steps.${STEP_NAMES[step]}`) })}
          </span>
        </h2>

        {errorCount > 0 && (
          <p className="notice notice--error">{t("validation.summary", { count: errorCount })}</p>
        )}

        <form className="add-place__form" noValidate onSubmit={next}>
          {step === 1 && (
            <>
              <p>{t("add.location.intro")}</p>
              <LocationPicker config={config} initialCamera={initialCamera} value={point} onPick={setPoint} />

              <div className="add-place__coords">
                {(["latitude", "longitude"] as const).map((field) => (
                  <div className="field" key={field}>
                    <label htmlFor={ids[field]} className="field__label">
                      {t(`add.location.${field}`)}
                    </label>
                    <p id={`${ids[field]}-hint`} className="field__hint">
                      {t(`add.location.${field}Hint`)}
                    </p>
                    <input
                      id={ids[field]}
                      ref={(el) => {
                        fieldRefs.current[field] = el;
                      }}
                      className="input"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft[field]}
                      aria-invalid={errors[field] ? true : undefined}
                      aria-describedby={describedBy(field)}
                      onChange={(event) => update(field, event.target.value)}
                    />
                    {errorText(field)}
                  </div>
                ))}
              </div>

              <div className="add-place__geo">
                <p id="use-location-explain" className="field__hint">
                  {t("add.location.useMineExplain")}
                </p>
                <button
                  type="button"
                  className="sa-btn"
                  aria-describedby="use-location-explain"
                  disabled={geo.kind === "locating"}
                  onClick={useMyLocation}
                >
                  {t("add.location.useMine")}
                </button>
                <div aria-live="polite">
                  {geo.kind === "locating" && <p>{t("add.location.locating")}</p>}
                  {geo.kind === "found" && <p>{t("add.location.found", { meters: geo.meters })}</p>}
                  {geo.kind === "denied" && (
                    <div className="notice notice--error">
                      <p>{t("add.location.denied")}</p>
                      <p>{t("add.location.deniedHelp")}</p>
                    </div>
                  )}
                  {(geo.kind === "unavailable" || geo.kind === "timeout" || geo.kind === "unsupported") && (
                    <p className="notice notice--error">{t(`add.location.${geo.kind}`)}</p>
                  )}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="field">
                <label htmlFor={ids.name} className="field__label">
                  {t("add.details.name")}
                </label>
                <p id={`${ids.name}-hint`} className="field__hint">
                  {t("add.details.nameHint", { max: NAME_MAX })}
                </p>
                <input
                  id={ids.name}
                  ref={(el) => {
                    fieldRefs.current.name = el;
                  }}
                  className="input"
                  type="text"
                  autoComplete="off"
                  value={draft.name}
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={describedBy("name")}
                  onChange={(event) => update("name", event.target.value)}
                />
                {errorText("name")}
              </div>
              <div className="field">
                <label htmlFor={ids.description} className="field__label">
                  {t("add.details.description")}
                </label>
                <p id={`${ids.description}-hint`} className="field__hint">
                  {t("add.details.descriptionHint", { max: DESCRIPTION_MAX })}{" "}
                  {t("add.details.charCount", { count: draft.description.trim().length, max: DESCRIPTION_MAX })}
                </p>
                <textarea
                  id={ids.description}
                  ref={(el) => {
                    fieldRefs.current.description = el;
                  }}
                  className="textarea"
                  value={draft.description}
                  aria-invalid={errors.description ? true : undefined}
                  aria-describedby={describedBy("description")}
                  onChange={(event) => update("description", event.target.value)}
                />
                {errorText("description")}
              </div>
            </>
          )}

          {step === 3 && point && (
            <>
              <p>{t("add.confirm.intro")}</p>
              <dl className="add-place__summary">
                <div>
                  <dt>{t("add.details.name")}</dt>
                  <dd>{draft.name.trim()}</dd>
                </div>
                <div>
                  <dt>{t("add.details.description")}</dt>
                  <dd>{draft.description.trim() || t("place.noDescription")}</dd>
                </div>
                <div>
                  <dt>{t("place.coordinates")}</dt>
                  <dd>{formatCoordinates(point.lat, point.lon, t, language)}</dd>
                </div>
              </dl>
              {submit.kind === "error" && (
                <div className="notice notice--error" role="alert">
                  <p>
                    {submit.reason === "disabled"
                      ? t("add.disabled.title")
                      : t(`add.error.${submit.reason}`, { status: submit.status ?? 0 })}
                  </p>
                </div>
              )}
            </>
          )}

          <div className="add-place__actions">
            <button type="button" className="sa-btn sa-btn--quiet" onClick={onCancel}>
              {t("common.cancel")}
            </button>
            {step > 1 && (
              <button
                type="button"
                className="sa-btn"
                disabled={submit.kind === "submitting"}
                onClick={() => {
                  setErrors({});
                  setSubmit({ kind: "idle" });
                  setStep((s) => (s - 1) as Step);
                }}
              >
                {t("common.back")}
              </button>
            )}
            {step < 3 ? (
              <button type="submit" className="sa-btn sa-btn--primary">
                {t("common.next")}
              </button>
            ) : (
              <button
                type="button"
                className="sa-btn sa-btn--primary"
                disabled={submit.kind === "submitting" || (submit.kind === "error" && submit.reason === "disabled")}
                onClick={create}
              >
                {submit.kind === "submitting"
                  ? t("add.confirm.submitting")
                  : submit.kind === "error"
                    ? t("common.retry")
                    : t("add.confirm.submit")}
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
