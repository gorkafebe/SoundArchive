// Everything a screen expects around it, for component tests.
import type { ReactNode } from "react";

import { AnnouncerProvider } from "../components/Announcer";
import { ToastProvider } from "../components/ui";
import { AuthProvider } from "../features/auth/AuthContext";
import { PlayerProvider } from "../features/player/PlayerContext";
import { I18nProvider, type Language } from "../i18n/i18n";
import { RouterProvider } from "../lib/router";
import { ThemeProvider } from "../lib/theme";

export function Providers({ children, language = "es" }: { children: ReactNode; language?: Language }) {
  return (
    <I18nProvider language={language}>
      <ThemeProvider>
        <AnnouncerProvider>
          <ToastProvider>
            <RouterProvider>
              <AuthProvider>
                <PlayerProvider>{children}</PlayerProvider>
              </AuthProvider>
            </RouterProvider>
          </ToastProvider>
        </AnnouncerProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
