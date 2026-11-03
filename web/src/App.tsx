// The app shell: skip link, header (name + preferences), the navigation bar
// (map/list switch and "Add place"), and the main area.
import { useCallback, useEffect, useState } from "react";

import { Preferences } from "./components/Preferences";
import { useI18n } from "./i18n/i18n";
import { getConfig, isAbort, type PublicConfig } from "./lib/api";
import { parseUrlState, toSearch, type UrlState, type View } from "./lib/urlState";

type ConfigState = { status: "loading" } | { status: "error" } | { status: "ready"; config: PublicConfig };

export function App() {
  const { t } = useI18n();
  const [config, setConfig] = useState<ConfigState>({ status: "loading" });
  const [url, setUrl] = useState<UrlState>(() => parseUrlState(window.location.search));
  const [attempt, setAttempt] = useState(0);

  // /api/config is read once at start-up: map style and whether writes are on.
  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then((value) => setConfig({ status: "ready", config: value }))
      .catch((error) => {
        if (!isAbort(error)) setConfig({ status: "error" });
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

  const setView = useCallback((view: View) => setUrl((current) => ({ ...current, view })), []);

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
        <button type="button" className="button button--primary">
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
        {config.status === "ready" && <p className="app-main__message">{t("app.tagline")}</p>}
      </main>
    </div>
  );
}
