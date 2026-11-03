// Light theme by default; dark on request. "system" follows the operating
// system's setting, but only if the user picks it (owner's decision: the
// app does not follow the OS on its own). The choice is remembered.
//
// The theme is applied as <html data-theme="light|dark">; tokens.css has one
// block of colours for each. public/theme-init.js applies the saved choice
// before the app loads, so a dark-theme user never sees a white flash.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { readStored, STORAGE_KEYS, writeStored } from "./storage";

export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";
export const THEME_CHOICES: ThemeChoice[] = ["light", "dark", "system"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function initialThemeChoice(stored: string | null = readStored(STORAGE_KEYS.theme)): ThemeChoice {
  return stored === "dark" || stored === "system" || stored === "light" ? stored : "light";
}

function systemTheme(): Theme {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

interface ThemeValue {
  choice: ThemeChoice;
  theme: Theme; // what is actually shown
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => initialThemeChoice());
  const [system, setSystem] = useState<Theme>(() => systemTheme());

  useEffect(() => {
    if (choice !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const update = () => setSystem(query.matches ? "dark" : "light");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [choice]);

  const theme: Theme = choice === "system" ? system : choice;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    writeStored(STORAGE_KEYS.theme, next);
  }, []);

  const value = useMemo(() => ({ choice, theme, setChoice }), [choice, theme, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
