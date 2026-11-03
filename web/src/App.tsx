// The app shell: skip link, header (name + preferences), the navigation bar
// (map/list switch and "Add place"), and the main area with the map or the
// list, plus the place panel beside them.
//
// State that matters for sharing lives in the address (lib/urlState.ts):
// view, map centre and zoom, selected place, list search and page.
import { useCallback, useEffect, useRef, useState } from "react";

import { useAnnounce } from "./components/Announcer";
import { AddPlaceFlow } from "./features/add-place/AddPlaceFlow";
import { Preferences } from "./components/Preferences";
import { MapView, type Camera, type MapViewHandle } from "./features/map/MapView";
import { PlaceList, type PlaceListHandle } from "./features/places/PlaceList";
import { PlaceSheet } from "./features/places/PlaceSheet";
import { useI18n } from "./i18n/i18n";
import { getConfig, isAbort, type Place, type PublicConfig } from "./lib/api";
import { parseUrlState, toSearch, type UrlState, type View } from "./lib/urlState";

type ConfigState = { status: "loading" } | { status: "error" } | { status: "ready"; config: PublicConfig };

// Zoom used to show one place: above the clustering limit (clusters.ts,
// maxZoom 16), so the place always appears as its own pin.
const PLACE_ZOOM = 17;

// First view when the link has no position: Spain, where the first places
// are expected (so the first screen is not an empty map).
export const DEFAULT_CAMERA: Camera = { lon: -3.7, lat: 40.2, zoom: 5 };

function initialCameraFrom(url: UrlState): Camera {
  return url.lat !== undefined && url.lon !== undefined
    ? { lon: url.lon, lat: url.lat, zoom: url.zoom ?? 13 }
    : DEFAULT_CAMERA;
}

export function App() {
  const { t } = useI18n();
  const announce = useAnnounce();
  const [loaded, setLoaded] = useState<{ attempt: number; config: ConfigState } | null>(null);
  const [url, setUrl] = useState<UrlState>(() => parseUrlState(window.location.search));
  const [attempt, setAttempt] = useState(0);
  const config: ConfigState = loaded?.attempt === attempt ? loaded.config : { status: "loading" };
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const mapRef = useRef<MapViewHandle>(null);
  const listRef = useRef<PlaceListHandle>(null);
  // A shared link with a place but no position: centre on the place once loaded.
  const centreOnLoad = useRef(url.place !== undefined && url.lat === undefined);

  const [initialCamera] = useState<Camera>(() => initialCameraFrom(url));
  // Where the map is now: the add-place map starts there.
  const [camera, setCamera] = useState<Camera>(initialCamera);

  // /api/config is read once at start-up: map style and whether writes are on.
  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then((value) => setLoaded({ attempt, config: { status: "ready", config: value } }))
      .catch((error) => {
        if (!isAbort(error)) setLoaded({ attempt, config: { status: "error" } });
      });
    return () => controller.abort();
  }, [attempt]);

  // Keep the address bar in step with the state (replaceState: no history spam).
  useEffect(() => {
    const search = toSearch(url);
    if (search !== window.location.search) {
      window.history.replaceState(null, "", `${window.location.pathname}${search}`);
    }
  }, [url]);

  const setView = useCallback(
    (view: View) => {
      setAdding(false);
      setUrl((current) => ({ ...current, view }));
      announce(t(view === "map" ? "view.mapShown" : "view.listShown"));
    },
    [announce, t],
  );

  const select = useCallback((id: string) => setUrl((current) => ({ ...current, place: id })), []);

  const closePlace = useCallback(() => {
    const id = url.place;
    setUrl((current) => ({ ...current, place: undefined }));
    announce(t("place.closed"));
    // Back to where the user came from: the pin, or the row in the list.
    if (id) {
      window.setTimeout(() => {
        if (url.view === "map") mapRef.current?.focusPlace(id);
        else listRef.current?.focusPlace(id);
      }, 0);
    }
  }, [url.place, url.view, announce, t]);

  const onCameraChange = useCallback((next: Camera) => {
    setCamera(next);
    setUrl((current) => ({ ...current, lon: next.lon, lat: next.lat, zoom: next.zoom }));
  }, []);

  const cancelAdding = useCallback(() => {
    setAdding(false);
    window.setTimeout(() => addButtonRef.current?.focus(), 0);
  }, []);

  // A new place: back to the map, reload pins and list, open its panel.
  const onCreated = useCallback((place: Place) => {
    setAdding(false);
    setReloadKey((n) => n + 1);
    setUrl((current) => ({ ...current, view: "map", place: place.id }));
    window.setTimeout(() => mapRef.current?.centerOn(place.longitude, place.latitude, PLACE_ZOOM), 50);
  }, []);

  const showOnMap = useCallback(
    (place: Place) => {
      setView("map");
      // Wait until the map is visible again (it was hidden), then move it.
      window.setTimeout(() => mapRef.current?.centerOn(place.longitude, place.latitude, PLACE_ZOOM), 50);
    },
    [setView],
  );

  const onPlaceLoaded = useCallback((place: Place) => {
    if (centreOnLoad.current) {
      centreOnLoad.current = false;
      mapRef.current?.centerOn(place.longitude, place.latitude, PLACE_ZOOM);
    }
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        {t("skip.toMain")}
      </a>

      <header className="app-header">
        <p className="app-header__name">{t("app.title")}</p>
        <Preferences />
      </header>

      <nav className="app-nav" aria-label={t("nav.label")}>
        <div className="app-nav__views" role="group" aria-label={t("nav.views")}>
          {(["map", "list"] as const).map((view) => (
            <button
              key={view}
              type="button"
              className="button"
              aria-pressed={url.view === view}
              onClick={() => setView(view)}
            >
              {t(`nav.${view}`)}
            </button>
          ))}
        </div>
        <button
          ref={addButtonRef}
          type="button"
          className="button button--primary"
          onClick={() => setAdding(true)}
        >
          {t("nav.add")}
        </button>
      </nav>

      <main id="main-content" className="app-main" tabIndex={-1}>
        <h1 className="visually-hidden">{t("app.title")}</h1>
        {config.status === "loading" && <p className="app-main__message">{t("common.loading")}</p>}
        {config.status === "error" && (
          <div className="app-main__message notice notice--error" role="alert">
            <p>{t("config.error")}</p>
            <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {config.status === "ready" && adding && (
          <AddPlaceFlow config={config.config} initialCamera={camera} onCancel={cancelAdding} onCreated={onCreated} />
        )}
        {config.status === "ready" && (
          // Hidden, not removed, while adding: the map keeps its position.
          <div hidden={adding} className={`workspace${url.place ? " workspace--with-panel" : ""}`}>
            <div className="workspace__content">
              {/* The map stays mounted while the list is shown (hidden, not
                  removed), so switching back keeps its position. */}
              <div className="workspace__view" hidden={url.view !== "map"}>
                <MapView
                  ref={mapRef}
                  config={config.config}
                  initialCamera={initialCamera}
                  selectedId={url.place ?? null}
                  onSelect={select}
                  onCameraChange={onCameraChange}
                  reloadKey={reloadKey}
                />
              </div>
              {url.view === "list" && (
                <div className="workspace__view">
                  <PlaceList
                    ref={listRef}
                    query={url.q ?? ""}
                    page={url.page ?? 1}
                    onQueryChange={(q, page) => setUrl((current) => ({ ...current, q: q || undefined, page }))}
                    selectedId={url.place ?? null}
                    onSelect={select}
                    reloadKey={reloadKey}
                  />
                </div>
              )}
            </div>
            {url.place && (
              <PlaceSheet
                key={url.place}
                placeId={url.place}
                onClose={closePlace}
                onShowOnMap={url.view === "list" ? showOnMap : undefined}
                onLoaded={onPlaceLoaded}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
