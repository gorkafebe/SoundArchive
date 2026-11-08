// Entry point: loads the styles (tokens first: every other file uses its
// variables) and mounts the app with its providers.
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/600.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AnnouncerProvider } from "./components/Announcer";
import { I18nProvider } from "./i18n/i18n";
import { ToastProvider } from "./components/ui";
import { RouterProvider } from "./lib/router";
import { ThemeProvider } from "./lib/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <AnnouncerProvider>
          <ToastProvider>
            <RouterProvider>
              <App />
            </RouterProvider>
          </ToastProvider>
        </AnnouncerProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
