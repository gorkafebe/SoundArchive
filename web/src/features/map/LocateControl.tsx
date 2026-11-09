// The "where am I?" button, in the bottom right corner of the main map.
//
// It is added as a MapLibre control so that it stacks above the attribution by
// itself, however many lines that text takes. Everything inside is React.
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../components/Icon";
import { PrePrompt } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { useUserLocation } from "./useUserLocation";
import { VERY_APPROXIMATE_ABOVE_M, type UserMarker } from "./UserMarker";

/** Worse than this the position is only a rough idea, and it says so. */
const APPROXIMATE_ABOVE_M = 1000;

interface LocateControlProps {
  map: maplibregl.Map;
  marker: UserMarker;
  /** Where messages go: with the map's other status lines. */
  statusSlot: HTMLElement | null;
  /** False while the map is hidden behind the list or the add-place flow. */
  active: boolean;
  /** How long to refine the position; tests shorten it. */
  locateMs?: number;
}

export function LocateControl({ map, marker, statusSlot, active, locateMs }: LocateControlProps) {
  const { t } = useI18n();
  // Its own live region: the shared one is overwritten moments later by
  // the map announcing the places of the area it has just moved to.
  const [spoken, setSpoken] = useState("");
  const location = useUserLocation({ active, locateMs });
  const { status, error, reading } = location;
  const centered = useSyncExternalStore(marker.subscribe, marker.getCentered);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);

  const holder = useMemo(() => {
    const element = document.createElement("div");
    element.className = "maplibregl-ctrl locate-control";
    return element;
  }, []);

  useEffect(() => {
    const control: maplibregl.IControl = { onAdd: () => holder, onRemove: () => holder.remove() };
    map.addControl(control, "bottom-right");
    return () => {
      map.removeControl(control);
    };
  }, [map, holder]);

  // Draw the position; going on, bring it into view.
  const meLabel = reading ? t("map.locate.me", { meters: reading.meters }) : "";
  const wasOn = useRef(false);
  useEffect(() => {
    marker.update(reading, meLabel);
    const isOn = reading !== null;
    if (isOn && !wasOn.current) marker.center();
    wasOn.current = isOn;
  }, [reading, meLabel, marker]);

  useEffect(() => () => marker.update(null, ""), [marker]);

  let label = t("map.locate.show");
  if (status === "searching") label = t("map.locate.searching");
  else if (status === "on") label = t(centered ? "map.locate.stop" : "map.locate.center");

  // Say what changed. The first run is the page opening: nothing to say.
  const previous = useRef({ label, status });
  useEffect(() => {
    const before = previous.current;
    previous.current = { label, status };
    if (before.label === label) return;
    if (status === "on" && before.status !== "on" && reading) {
      setSpoken(`${t("map.locate.found", { meters: reading.meters })} ${label}`);
    } else {
      setSpoken(label);
    }
  }, [label, status, reading, t]);

  const previousError = useRef(error);
  useEffect(() => {
    if (error && error !== previousError.current) setSpoken(t(`map.locate.error.${error}`));
    previousError.current = error;
  }, [error, t]);

  useEffect(() => {
    if (status === "prompt") promptRef.current?.querySelector<HTMLElement>(".sa-btn--primary")?.focus();
  }, [status]);

  function press() {
    if (status === "off") void location.activate();
    else if (status === "prompt") location.dismiss();
    else if (status === "on") {
      if (centered) location.stop();
      else marker.center();
    }
    // Searching ends by itself within seconds: a press changes nothing.
  }

  function closePrompt() {
    location.dismiss();
    buttonRef.current?.focus();
  }

  function onPromptKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePrompt();
    }
  }

  const stateClass = status === "on" ? " locate-control__button--on" : status === "searching" ? " locate-control__button--busy" : "";
  const veryApproximate = reading !== null && reading.meters > VERY_APPROXIMATE_ABOVE_M;
  const approximate = reading !== null && reading.meters > APPROXIMATE_ABOVE_M && !veryApproximate;

  return (
    <>
      <div className="visually-hidden locate-live" role="status" aria-live="polite" aria-atomic="true">
        {spoken}
      </div>
      {createPortal(
        <button
          ref={buttonRef}
          type="button"
          className={`sa-btn locate-control__button${stateClass}`}
          aria-label={label}
          aria-busy={status === "searching"}
          title={label}
          onClick={press}
        >
          <Icon name="locate" size={24} />
        </button>,
        holder,
      )}

      {status === "prompt" && (
        <div ref={promptRef} className="locate-prompt" role="dialog" aria-label={t("map.locate.promptTitle")} onKeyDown={onPromptKey}>
          <PrePrompt
            as="h3"
            icon="locate"
            title={t("map.locate.promptTitle")}
            actions={
              <>
                <button
                  type="button"
                  className="sa-btn sa-btn--primary"
                  onClick={() => {
                    location.accept();
                    buttonRef.current?.focus();
                  }}
                >
                  {t("map.locate.accept")}
                </button>
                <button type="button" className="sa-btn sa-btn--quiet" onClick={closePrompt}>
                  {t("map.locate.decline")}
                </button>
              </>
            }
          >
            {t("map.locate.promptBody")}
          </PrePrompt>
        </div>
      )}

      {statusSlot &&
        createPortal(
          <>
            {approximate && reading && (
              <p className="map-status">{t("map.locate.approximate", { meters: reading.meters })}</p>
            )}
            {veryApproximate && reading && (
              <p className="map-status">{t("map.locate.veryApproximate", { km: Math.round(reading.meters / 1000) })}</p>
            )}
            {error && (
              <div className="map-status map-status--error locate-notice">
                <p>{t(`map.locate.error.${error}`)}</p>
                {error === "denied" && <p>{t("map.locate.error.deniedHelp")}</p>}
                {location.detail && (
                  <details className="locate-notice__details">
                    <summary>{t("map.locate.details")}</summary>
                    <p>{t("map.locate.detail", { code: location.detail.code, message: location.detail.message })}</p>
                  </details>
                )}
                <a className="locate-notice__link" href="/diagnostico-ubicacion">
                  {t("map.locate.diagnosis")}
                </a>
                <div className="locate-notice__actions">
                  <button type="button" className="sa-btn" onClick={() => void location.activate()}>
                    {t("common.retry")}
                  </button>
                  <button type="button" className="sa-btn" onClick={location.clearError}>
                    {t("common.close")}
                  </button>
                </div>
              </div>
            )}
          </>,
          statusSlot,
        )}
    </>
  );
}
