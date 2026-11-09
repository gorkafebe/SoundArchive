// The app shell: skip link, top bar (name + preferences), the navigation bar
// (map/list switch and "Add place"), and the main area with the map or the
// list, plus the place panel beside them.
//
// State that matters for sharing lives in the address (lib/urlState.ts):
// view, map centre and zoom, selected place, list search and page.
import { useCallback, useEffect, useRef, useState } from "react";

import { useAnnounce } from "./components/Announcer";
import { AddPlaceFlow } from "./features/add-place/AddPlaceFlow";
import { Icon } from "./components/Icon";
import { TopBar } from "./components/TopBar";
import { MapView, type Camera, type MapViewHandle } from "./features/map/MapView";
import { PlaceList, type PlaceListHandle } from "./features/places/PlaceList";
import { PlaceSheet } from "./features/places/PlaceSheet";
import { useI18n } from "./i18n/i18n";
import { getConfig, isAbort, saveLanguage, type Place, type PublicConfig } from "./lib/api";
import { matchPath, useRouter } from "./lib/router";
import { readStored, STORAGE_KEYS } from "./lib/storage";
import { parseUrlState, toSearch, type UrlState, type View } from "./lib/urlState";
import { useAuth } from "./features/auth/AuthContext";
import { SignInPage } from "./features/auth/SignInPage";
import { AccountPage } from "./features/auth/AccountPage";
import { AdminPage } from "./features/admin/AdminPage";
import { ComparePage } from "./features/compare/ComparePage";
import { AmbientPage } from "./features/player/AmbientPage";
import { MiniPlayer } from "./features/player/components";
import { usePlayer } from "./features/player/PlayerContext";
import { RecordingPage } from "./features/player/RecordingPage";
import { RecordFlow } from "./features/record/RecordFlow";
import { UploadFlow } from "./features/record/UploadFlow";

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

export function Workspace() {
  const { t } = useI18n();
  const { user, signOut } = useAuth();
  const { navigate } = useRouter();
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
      window.history.replaceState(null, "", `/${search}`);
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

  const searchPlaces = useCallback((q: string) => {
    setUrl((current) => ({ ...current, view: "list", q, page: 1 }));
  }, []);

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

  // "Yes, it is this one": no new place, just open the one that exists.
  const onOpenExisting = useCallback((place: { id: string; latitude: number; longitude: number }) => {
    setAdding(false);
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
    <div className={`app-frame${url.place ? " app--with-panel" : ""}`}>
      <TopBar
        view={url.view}
        onView={setView}
        onSearch={url.view === "map" ? searchPlaces : undefined}
        viewsCurrent={!adding}
        menuLabel={user?.username}
        menuExtra={
          <>
            <p className="menu__name">{user?.username}</p>
            <a
              className="sa-btn"
              href="/account"
              onClick={(event) => {
                event.preventDefault();
                navigate("/account");
              }}
            >
              {t("account.menu")}
            </a>
            {user?.role === "admin" && (
              <a
                className="sa-btn"
                href="/admin"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/admin");
                }}
              >
                {t("admin.menu")}
              </a>
            )}
            <button type="button" className="sa-btn" onClick={() => void signOut()}>
              {t("auth.signOut")}
            </button>
          </>
        }
      />

      <main id="main-content" className="app-main" tabIndex={-1}>
        <h1 className="visually-hidden">{t("app.title")}</h1>
        {config.status === "loading" && <p className="app-main__message">{t("common.loading")}</p>}
        {config.status === "error" && (
          <div className="app-main__message notice notice--error" role="alert">
            <p>{t("config.error")}</p>
            <button type="button" className="sa-btn" onClick={() => setAttempt((n) => n + 1)}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {config.status === "ready" && adding && (
          <AddPlaceFlow
            config={config.config}
            initialCamera={camera}
            onCancel={cancelAdding}
            onCreated={onCreated}
            onOpenExisting={onOpenExisting}
          />
        )}
        {config.status === "ready" && (
          // Hidden, not removed, while adding: the map keeps its position.
          <div hidden={adding} className={`workspace${url.place ? " workspace--with-panel" : ""}`}>
            <div className="workspace__content">
              <button
                ref={addButtonRef}
                type="button"
                className="sa-btn sa-btn--primary map-add"
                onClick={() => setAdding(true)}
              >
                <Icon name="plus" size={20} />
                {t("nav.add")}
              </button>
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

const UUID = /^[0-9a-f-]{36}$/i;

function Screen({ path, search }: { path: string; search: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const place = new URLSearchParams(search).get("place");
  let params: Record<string, string> | null;
  if ((params = matchPath("/recordings/:id/ambient", path)) && UUID.test(params.id)) return <AmbientPage key={params.id} recordingId={params.id} />;
  if ((params = matchPath("/recordings/:id", path)) && UUID.test(params.id)) return <RecordingPage key={params.id} recordingId={params.id} />;
  if ((params = matchPath("/places/:id/compare", path)) && UUID.test(params.id)) return <ComparePage key={params.id} placeId={params.id} />;
  if (path === "/record" && place && UUID.test(place)) return <RecordFlow key={place} placeId={place} />;
  if (path === "/upload" && place && UUID.test(place)) return <UploadFlow key={place} placeId={place} />;
  if (path === "/admin" && user?.role === "admin") return <AdminPage />;
  if (path === "/account") return <AccountPage />;
  return (
    <div className="app-main__message">
      <h1 className="page__title">{t("notFound.title")}</h1>
      <p>{t("notFound.body")}</p>
      <a className="sa-btn" href="/">
        {t("notFound.home")}
      </a>
    </div>
  );
}

function OfflineBanner() {
  const { t } = useI18n();
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (online) return null;
  return (
    <p className="offline-banner" role="status">
      <Icon name="offline" size={20} />
      {t("offline.banner")}
    </p>
  );
}

export function App() {
  const { t, language, setLanguage } = useI18n();
  const { state, user, retry } = useAuth();
  const { path, search } = useRouter();
  const player = usePlayer();

  // The account remembers the language for devices that have no choice yet;
  // later changes are saved back.
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (!user) {
      synced.current = null;
      return;
    }
    if (synced.current !== user.id) {
      synced.current = user.id;
      // Only on a device with no choice of its own: an explicit choice here wins.
      if (readStored(STORAGE_KEYS.language) === null && (user.language === "es" || user.language === "en")) {
        setLanguage(user.language);
      }
      return;
    }
    if (user.language !== language) void saveLanguage(language).catch(() => {});
  }, [user, language, setLanguage]);

  if (state.status === "loading") {
    return (
      <div className="app-main__message" role="status">
        {t("common.loading")}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <main className="app-main__message notice notice--error" role="alert">
        <p>{t("config.error")}</p>
        <button type="button" className="sa-btn" onClick={retry}>
          {t("common.retry")}
        </button>
      </main>
    );
  }
  if (state.status === "signedOut") return <SignInPage />;

  const isWorkspace = path === "/";
  return (
    <div className={`app${player.current ? " app--mini" : ""}`}>
      <a className="skip-link" href="#main-content">
        {t("skip.toMain")}
      </a>
      {isWorkspace ? (
        <Workspace />
      ) : (
        <main id="main-content" className="app-main" tabIndex={-1}>
          <Screen path={path} search={search} />
        </main>
      )}
      <OfflineBanner />
      <MiniPlayer />
    </div>
  );
}
