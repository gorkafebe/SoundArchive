// The place panel. NOT a modal dialog: the map (or the list) next to it
// stays usable, as the design brief asks ("standard" sheet).
//
//   phone (narrow):  a bottom sheet with three heights (small, medium, full).
//                    Drag its handle, or press it (Enter/Space) to cycle;
//                    the arrow keys also change the height.
//   wide screens:    a side panel on the right; no handle.
//
// When a place opens, the focus moves to its name (so a keyboard or screen
// reader user lands in the panel); App returns the focus to the pin or list
// row when the panel closes.
import "./place-sheet.css";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useAnnounce } from "../../components/Announcer";
import { useI18n } from "../../i18n/i18n";
import { ApiError, getPlace, isAbort, type Place } from "../../lib/api";
import { useMediaQuery, WIDE_SCREEN } from "../../lib/media";
import { formatCoordinates } from "../map/geo";

export type SheetHeight = "peek" | "half" | "full";
const HEIGHTS: SheetHeight[] = ["peek", "half", "full"];
const LOADING = { kind: "loading" } as const;

type Load = { kind: "loading" } | { kind: "error"; notFound: boolean } | { kind: "ready"; place: Place };

interface PlaceSheetProps {
  placeId: string;
  onClose: () => void;
  /** Shown in the list view: switch to the map, centred on the place. */
  onShowOnMap?: (place: Place) => void;
  /** Called once the place is loaded (App uses it to centre a shared link). */
  onLoaded?: (place: Place) => void;
}

export function PlaceSheet({ placeId, onClose, onShowOnMap, onLoaded }: PlaceSheetProps) {
  const { t, language, formatDate } = useI18n();
  const announce = useAnnounce();
  const wide = useMediaQuery(WIDE_SCREEN);
  // The answer is stored with the request it belongs to; while the current
  // request has no answer yet, the panel shows "loading".
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  const [height, setHeight] = useState<SheetHeight>("half");
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${placeId}:${attempt}`;
  const load: Load = result?.key === requestKey ? result.load : LOADING;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    const controller = new AbortController();
    getPlace(placeId, controller.signal)
      .then((place) => {
        setResult({ key: requestKey, load: { kind: "ready", place } });
        onLoadedRef.current?.(place);
      })
      .catch((error) => {
        if (isAbort(error)) return;
        setResult({
          key: requestKey,
          load: { kind: "error", notFound: error instanceof ApiError && error.status === 404 },
        });
      });
    return () => controller.abort();
  }, [placeId, requestKey]);

  // Move the focus into the panel once there is something to read.
  useEffect(() => {
    if (load.kind === "ready") {
      headingRef.current?.focus();
      announce(t("place.opened", { name: load.place.name }));
    } else if (load.kind === "error") {
      messageRef.current?.focus();
    }
    // Only when the loaded content changes, not on every language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const cycle = (direction: 1 | -1) =>
    setHeight((h) => HEIGHTS[Math.min(HEIGHTS.length - 1, Math.max(0, HEIGHTS.indexOf(h) + direction))]);

  function onHandleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      cycle(1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      cycle(-1);
    }
  }

  // Dragging: follow the finger, then snap to the nearest of the three heights.
  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    const sheet = sheetRef.current;
    if (!sheet) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startY: event.clientY, startHeight: sheet.getBoundingClientRect().height };
  }
  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const sheet = sheetRef.current;
    if (!drag.current || !sheet) return;
    const next = drag.current.startHeight + (drag.current.startY - event.clientY);
    sheet.style.height = `${Math.max(80, next)}px`;
  }
  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const sheet = sheetRef.current;
    const start = drag.current;
    drag.current = null;
    if (!start || !sheet) return;
    const moved = Math.abs(start.startY - event.clientY);
    sheet.style.height = "";
    if (moved < 8) {
      // A tap, not a drag: the click handler cycles the height.
      return;
    }
    const finalHeight = start.startHeight + (start.startY - event.clientY);
    const fraction = finalHeight / window.innerHeight;
    setHeight(fraction < 0.38 ? "peek" : fraction < 0.62 ? "half" : "full");
    suppressClick.current = true;
  }
  const suppressClick = useRef(false);
  function onHandleClick() {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setHeight((h) => HEIGHTS[(HEIGHTS.indexOf(h) + 1) % HEIGHTS.length]);
  }

  return (
    <aside
      ref={sheetRef}
      className={`place-sheet ${wide ? "place-sheet--side" : `place-sheet--bottom place-sheet--${height}`}`}
      aria-label={t("place.panelLabel")}
      // Escape closes the panel from anywhere inside it, like the Close button.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {!wide && (
        <button
          type="button"
          className="place-sheet__handle"
          aria-label={t("sheet.handle", { height: t(`sheet.${height}`) })}
          onClick={onHandleClick}
          onKeyDown={onHandleKey}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="place-sheet__grip" aria-hidden="true" />
        </button>
      )}

      <div className="place-sheet__body">
        <div className="place-sheet__top">
          {load.kind === "ready" ? (
            <h2 ref={headingRef} tabIndex={-1} className="place-sheet__title">
              {load.place.name}
            </h2>
          ) : (
            <span />
          )}
          <button type="button" className="button button--quiet" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>

        {load.kind === "loading" && <p className="place-sheet__muted">{t("place.loading")}</p>}

        {load.kind === "error" && (
          <div ref={messageRef} tabIndex={-1} className="notice notice--error place-sheet__message">
            <p>{load.notFound ? t("place.notFound") : t("place.error")}</p>
            {!load.notFound && (
              <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
                {t("common.retry")}
              </button>
            )}
          </div>
        )}

        {load.kind === "ready" && (
          <>
            <p className={load.place.description ? "place-sheet__description" : "place-sheet__muted"}>
              {load.place.description ?? t("place.noDescription")}
            </p>
            <dl className="place-sheet__facts">
              <div>
                <dt>{t("place.coordinates")}</dt>
                <dd>{formatCoordinates(load.place.latitude, load.place.longitude, t, language)}</dd>
              </div>
            </dl>
            <p className="place-sheet__muted">{t("place.created", { date: formatDate(load.place.created_at) })}</p>
            {onShowOnMap && (
              <button type="button" className="button" onClick={() => onShowOnMap(load.place)}>
                {t("place.showOnMap")}
              </button>
            )}

            {/* Placeholder: recordings arrive in phase 4. Clearly marked as empty. */}
            <section className="place-sheet__recordings" aria-labelledby="recordings-heading">
              <h3 id="recordings-heading">{t("place.recordings")}</h3>
              <div className="place-sheet__placeholder" data-placeholder="recordings">
                <p className="place-sheet__placeholder-title">{t("place.noRecordingsYet")}</p>
                <p className="place-sheet__muted">{t("place.recordingsPlaceholder")}</p>
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
