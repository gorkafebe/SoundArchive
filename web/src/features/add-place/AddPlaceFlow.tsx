// Adding a place: a full-screen flow (not a sheet: the design brief keeps
// sheets for quick looks and gives multi-step work its own screen).
//
//   1. Where. "Use my current location" comes first and is the recommended
//      way; choosing on the map second; typing coordinates is folded away.
//   2. Is it somewhere we know? Places already here (the same place?), then
//      named sites from OpenStreetMap. Skipped silently when there is nothing.
//   3. Name and description.
//   4. Confirm, then create. If the server answers 409 (the situation changed
//      or someone else was quicker), the same question appears here and
//      nothing typed is lost.
//
// Forms: real <label>s; hints and errors are linked to their field with
// aria-describedby; when a step has errors the focus goes to the first one.
import "./add-place.css";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { useAnnounce } from "../../components/Announcer";
import { Badge, PrePrompt } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import {
  ApiError,
  createPlace,
  getSuggestions,
  isAbort,
  type ExternalSuggestion,
  type NearbyPlace,
  type Place,
  type PlaceSuggestions,
  type PublicConfig,
} from "../../lib/api";
import { readStored, STORAGE_KEYS, writeStored } from "../../lib/storage";
import type { Camera } from "../map/MapView";
import { formatCoordinates } from "../map/geo";
import { ExternalChoice, SamePlaceChoice } from "./KnownPlaces";
import { LocationPicker } from "./LocationPicker";
import { useBestLocation, type Reading } from "./useBestLocation";
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

type Step = "location" | "known" | "details" | "confirm";

type Submit =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; reason: "network" | "server" | "validation" | "disabled"; status?: number };

/** A refusal from the server: these places are in the way. */
interface Conflict {
  code: "possible_duplicate" | "external_exists";
  candidates: NearbyPlace[];
}

type Known =
  | { kind: "idle" }
  | { kind: "loading"; key: string }
  | { kind: "done"; key: string; data: PlaceSuggestions };

const SUGGEST_DELAY_MS = 350;

interface AddPlaceFlowProps {
  config: PublicConfig;
  initialCamera: Camera;
  onCancel: () => void;
  onCreated: (place: Place) => void;
  /** The person said it is a place that already exists: open it. */
  onOpenExisting?: (place: { id: string; latitude: number; longitude: number }) => void;
  /** How long to refine the position; tests shorten it. */
  locateMs?: number;
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

function AddPlaceForm({ config, initialCamera, onCancel, onCreated, onOpenExisting, locateMs }: AddPlaceFlowProps) {
  const { t, language } = useI18n();
  const announce = useAnnounce();
  const [step, setStep] = useState<Step>("location");
  const [draft, setDraft] = useState<Draft>({ latitude: "", longitude: "", name: "", description: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [submit, setSubmit] = useState<Submit>({ kind: "idle" });
  const [showMap, setShowMap] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  /** Metres of doubt of the current point; null if it did not come from the GPS. */
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [osmOn, setOsmOn] = useState(() => readStored(STORAGE_KEYS.suggestOsm) !== "off");
  const [known, setKnown] = useState<Known>({ kind: "idle" });
  const [distinct, setDistinct] = useState(false);
  const [site, setSite] = useState<ExternalSuggestion | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fieldRefs = useRef<Partial<Record<Field, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const ids = {
    latitude: useId(),
    longitude: useId(),
    name: useId(),
    description: useId(),
    osm: useId(),
  };

  const { geo, locate, cancel: cancelLocating } = useBestLocation(onReading, locateMs);

  const lat = parseCoordinate(draft.latitude);
  const lon = parseCoordinate(draft.longitude);
  const point =
    lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;

  // --- What is known around the point ---------------------------------------
  const askOutside = config.external_places_enabled && osmOn;
  const settling = geo.kind === "locating";
  const knownKey = point && !settling ? `${point.lat},${point.lon},${accuracy ?? ""},${askOutside}` : "";

  useEffect(() => {
    if (!knownKey || lat === null || lon === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setKnown({ kind: "loading", key: knownKey });
      getSuggestions({ lat, lon, accuracy, external: askOutside }, controller.signal)
        .then((data) => {
          setKnown({ kind: "done", key: knownKey, data });
        })
        .catch((error) => {
          if (isAbort(error)) return;
          // Suggestions are a help, never a requirement: carry on without them.
          setKnown({
            kind: "done",
            key: knownKey,
            data: { existing: [], external: [], external_available: false, attribution: null, radius_m: 0 },
          });
        });
    }, SUGGEST_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // knownKey already stands for lat, lon, accuracy and askOutside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownKey]);

  const knownData = known.kind === "done" && known.key === knownKey ? known.data : null;
  const knownPending = Boolean(knownKey) && !knownData;
  const existing = distinct ? [] : (knownData?.existing ?? []);
  const external = knownData?.external ?? [];
  const hasKnown = (knownData?.existing.length ?? 0) > 0 || external.length > 0;

  // Nothing to ask about after all: straight on, without a flash of a step.
  const current: Step = step === "known" && knownData && existing.length === 0 && external.length === 0 ? "details" : step;

  const order: Step[] = hasKnown ? ["location", "known", "details", "confirm"] : ["location", "details", "confirm"];
  const number = Math.max(order.indexOf(current), order.indexOf(current === "known" ? "location" : current)) + 1;

  // A new step (and the first one): start reading at its heading.
  useEffect(() => headingRef.current?.focus(), [current]);

  const announcedKey = useRef("");
  useEffect(() => {
    if (!knownData || announcedKey.current === knownKey) return;
    announcedKey.current = knownKey;
    if (knownData.existing.length > 0) announce(t("add.known.existingFound", { count: knownData.existing.length }));
    else if (knownData.external.length > 0) announce(t("add.known.externalFound", { count: knownData.external.length }));
  }, [knownData, knownKey, announce, t]);

  // --- Changing the point ---------------------------------------------------
  function forgetDecisions() {
    setDistinct(false);
    setSite(null);
    setConflict(null);
  }

  function writePoint(newLat: number, newLon: number) {
    setDraft((d) => ({
      ...d,
      latitude: formatCoordinateInput(newLat, language),
      longitude: formatCoordinateInput(newLon, language),
    }));
    setErrors((e) => ({ ...e, latitude: undefined, longitude: undefined }));
    forgetDecisions();
  }

  function onReading(reading: Reading) {
    writePoint(reading.lat, reading.lon);
    setAccuracy(reading.meters);
    setShowMap(true);
  }

  /** The person placed the point by hand: it is exact as far as we can tell. */
  function pickByHand(newLat: number, newLon: number) {
    cancelLocating();
    setAccuracy(null);
    writePoint(newLat, newLon);
  }

  function update(field: Field, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
    // Clear a field's error as soon as it is being fixed.
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
    if (field === "latitude" || field === "longitude") {
      cancelLocating();
      setAccuracy(null);
      forgetDecisions();
    }
  }

  function chooseOsm(on: boolean) {
    setOsmOn(on);
    writeStored(STORAGE_KEYS.suggestOsm, on ? "on" : "off");
  }

  const previousGeo = useRef(geo.kind);
  useEffect(() => {
    if (geo.kind === previousGeo.current) return;
    previousGeo.current = geo.kind;
    if (geo.kind === "found") announce(t("add.location.found", { meters: geo.reading.meters }));
  }, [geo, announce, t]);

  const blocked = geo.kind === "denied" || geo.kind === "unavailable" || geo.kind === "timeout" || geo.kind === "unsupported";
  const mapVisible = showMap || blocked;
  const shownReading = geo.kind === "found" ? geo.reading : geo.kind === "locating" ? geo.best : undefined;
  const lowAccuracy = shownReading !== undefined && accuracy !== null && accuracy > config.location_warn_accuracy_m;

  // --- Moving between steps ---------------------------------------------------
  /** Show errors and put the focus on the first wrong field. */
  function check(found: Errors, order: Field[]): boolean {
    setErrors(found);
    const first = order.find((field) => found[field]);
    if (!first) return true;
    if (first === "latitude" || first === "longitude") setAdvanced(true);
    window.setTimeout(() => fieldRefs.current[first]?.focus(), 0);
    const count = order.filter((field) => found[field]).length;
    announce(t("validation.summary", { count }));
    return false;
  }

  function next(event: FormEvent) {
    event.preventDefault();
    if (current === "location") {
      if (check(validateLocation(draft), ["latitude", "longitude"])) {
        cancelLocating();
        setStep(knownPending || hasKnown ? "known" : "details");
      }
    } else if (current === "details" && check(validateDetails(draft), ["name", "description"])) {
      setStep("confirm");
    }
  }

  function back() {
    setErrors({});
    setSubmit({ kind: "idle" });
    setConflict(null);
    if (current === "confirm") setStep("details");
    else if (current === "details") {
      setDistinct(false);
      setSite(null);
      setStep(hasKnown ? "known" : "location");
    } else setStep("location");
  }

  function pickSite(chosen: ExternalSuggestion) {
    setSite(chosen);
    setDraft((d) => ({ ...d, name: chosen.name }));
    setStep("details");
  }

  function saidDistinct() {
    setDistinct(true);
    if (external.length === 0) setStep("details");
  }

  function openExisting(candidate: NearbyPlace) {
    onOpenExisting?.({ id: candidate.id, latitude: candidate.latitude, longitude: candidate.longitude });
  }

  // --- Creating ------------------------------------------------------------
  async function create(options: { confirmDistinct?: boolean; dropReference?: boolean } = {}) {
    if (lat === null || lon === null) return;
    setSubmit({ kind: "submitting" });
    setConflict(null);
    const reference = options.dropReference ? null : site;
    const confirmDistinct = options.confirmDistinct ?? distinct;
    if (options.dropReference) setSite(null);
    if (confirmDistinct) setDistinct(true);
    try {
      const place = await createPlace({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        latitude: lat,
        longitude: lon,
        ...(accuracy !== null ? { location_accuracy_m: accuracy } : {}),
        ...(confirmDistinct ? { confirm_distinct: true } : {}),
        ...(reference ? { external_source: reference.external_source, external_id: reference.external_id } : {}),
      });
      announce(t("add.success", { name: place.name }));
      onCreated(place);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.conflict) {
        setSubmit({ kind: "idle" });
        setConflict(error.conflict as Conflict);
        return;
      }
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
  const locating = geo.kind === "locating";

  return (
    <section className="add-place" aria-labelledby="add-place-heading">
      <div className="add-place__inner">
        <h2 id="add-place-heading" ref={headingRef} tabIndex={-1}>
          {t("add.title")}
          <span className="add-place__step">
            {t("add.step", { step: number, total: order.length, name: t(`add.steps.${current}`) })}
          </span>
        </h2>

        {errorCount > 0 && (
          <p className="notice notice--error">{t("validation.summary", { count: errorCount })}</p>
        )}

        <form className="add-place__form" noValidate onSubmit={next}>
          {current === "location" && (
            <>
              <PrePrompt
                as="h3"
                icon="pin"
                title={t("add.location.recommendTitle")}
                actions={
                  <>
                    <button type="button" className="sa-btn sa-btn--primary add-place__locate" disabled={locating} onClick={locate}>
                      <Icon name="pin" size={20} />
                      {t("add.location.useMine")}{" "}
                      <span className="add-place__recommended">{t("add.location.recommended")}</span>
                    </button>
                    <button
                      type="button"
                      className="sa-btn"
                      aria-expanded={mapVisible}
                      onClick={() => {
                        cancelLocating();
                        setShowMap(true);
                      }}
                    >
                      <Icon name="map" size={20} />
                      {t("add.location.pickOnMap")}
                    </button>
                  </>
                }
              >
                {t("add.location.useMineExplain")}
              </PrePrompt>

              <div aria-live="polite" className="add-place__geo-status">
                {locating && (
                  <p>
                    {geo.best
                      ? t("add.location.refining", { meters: geo.best.meters })
                      : t("add.location.locating")}
                  </p>
                )}
                {geo.kind === "found" && !lowAccuracy && (
                  <p>
                    <Badge tone="success" icon="check">
                      {t("add.location.accuracy", { meters: geo.reading.meters })}
                    </Badge>
                  </p>
                )}
                {lowAccuracy && (
                  <p className="notice">
                    <Badge tone="warning" icon="alert">
                      {t("add.location.accuracy", { meters: accuracy })}
                    </Badge>
                    <span>{t("add.location.lowAccuracy")}</span>
                  </p>
                )}
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

              {mapVisible && (
                <div className="add-place__map">
                  <LocationPicker
                    config={config}
                    initialCamera={initialCamera}
                    value={point}
                    accuracyM={accuracy}
                    onPick={pickByHand}
                  />
                  <p className="caption">{t("add.location.dragHint")}</p>
                </div>
              )}

              {point && (
                <p className="add-place__chosen">
                  {t("add.location.chosen", { coordinates: formatCoordinates(point.lat, point.lon, t, language) })}
                </p>
              )}

              {config.external_places_enabled && (
                <div className="add-place__osm">
                  <label htmlFor={ids.osm} className="add-place__check">
                    <input
                      id={ids.osm}
                      type="checkbox"
                      checked={osmOn}
                      aria-describedby={`${ids.osm}-hint`}
                      onChange={(event) => chooseOsm(event.target.checked)}
                    />
                    {t("add.location.osmToggle")}
                  </label>
                  <p id={`${ids.osm}-hint`} className="caption">
                    {t("add.location.osmToggleHint")}
                  </p>
                </div>
              )}

              <details
                className="add-place__advanced"
                open={advanced}
                onToggle={(event) => setAdvanced(event.currentTarget.open)}
              >
                <summary>{t("add.location.advanced")}</summary>
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
              </details>
            </>
          )}

          {current === "known" && (
            <>
              {knownPending && (
                <div aria-live="polite" className="add-place__geo-status">
                  <p>{t("add.known.checking")}</p>
                  <button type="button" className="sa-btn" onClick={() => setStep("details")}>
                    {t("add.known.skipWait")}
                  </button>
                </div>
              )}
              {existing.length > 0 && (
                <SamePlaceChoice candidates={existing} onSame={openExisting} onDistinct={saidDistinct} />
              )}
              {knownData && existing.length === 0 && external.length > 0 && (
                <ExternalChoice sites={external} onPick={pickSite} onNone={() => setStep("details")} />
              )}
            </>
          )}

          {current === "details" && (
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

          {current === "confirm" && point && (
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
                {site && (
                  <div>
                    <dt>{t("add.known.chosenExternal")}</dt>
                    <dd>{site.name}</dd>
                  </div>
                )}
              </dl>
              {conflict && (
                <SamePlaceChoice
                  candidates={conflict.candidates}
                  onSame={openExisting}
                  distinctLabel={conflict.code === "external_exists" ? t("add.known.createWithoutReference") : undefined}
                  onDistinct={() =>
                    create(conflict.code === "external_exists" ? { dropReference: true } : { confirmDistinct: true })
                  }
                />
              )}
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
            {current !== "location" && (
              <button type="button" className="sa-btn" disabled={submit.kind === "submitting"} onClick={back}>
                {t("common.back")}
              </button>
            )}
            {(current === "location" || current === "details") && (
              <button type="submit" className="sa-btn sa-btn--primary">
                {t("common.next")}
              </button>
            )}
            {current === "confirm" && !conflict && (
              <button
                type="button"
                className="sa-btn sa-btn--primary"
                disabled={submit.kind === "submitting" || (submit.kind === "error" && submit.reason === "disabled")}
                onClick={() => create()}
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
