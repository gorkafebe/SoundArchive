// Entry point: loads the styles (tokens first: every other file uses its
// variables) and mounts the app with its providers.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AnnouncerProvider } from "./components/Announcer";
import { I18nProvider } from "./i18n/i18n";
import { ThemeProvider } from "./lib/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <AnnouncerProvider>
          <App />
        </AnnouncerProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
