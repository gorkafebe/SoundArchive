// A small translation layer: no library needed for two languages.
//
// - Every text lives in es.json / en.json. Components call t("key").
// - {name} placeholders are filled from the second argument.
// - Plurals: if a "count" is given and "key_one" / "key_other" exist, the
//   right one is picked with Intl.PluralRules (the browser's own rules).
// - The <html lang> attribute follows the language, so screen readers
//   pronounce the text correctly and the browser hyphenates properly.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";
import en from "./en.json";
import es from "./es.json";

export type Language = "es" | "en";
export const LANGUAGES: Language[] = ["es", "en"];

type Dictionary = { [key: string]: string | Dictionary };
const dictionaries: Record<Language, Dictionary> = { es, en };

export type Vars = Record<string, string | number>;

function lookup(dict: Dictionary, key: string): string | undefined {
  let node: string | Dictionary | undefined = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function translate(language: Language, key: string, vars: Vars = {}): string {
  const dict = dictionaries[language];
  let text: string | undefined;
  if (typeof vars.count === "number") {
    const rule = new Intl.PluralRules(language).select(vars.count);
    text = lookup(dict, `${key}_${rule}`) ?? lookup(dict, `${key}_other`);
  }
  text ??= lookup(dict, key);
  if (text === undefined) {
    // scripts/check-i18n.mjs should make this impossible; show the key so
    // the mistake is visible instead of an empty space.
    return key;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? formatVar(language, vars[name]) : match,
  );
}

function formatVar(language: Language, value: string | number): string {
  return typeof value === "number" ? new Intl.NumberFormat(language).format(value) : value;
}

/**
 * First visit: English if the browser's first preferred language is English,
 * otherwise Spanish (owner's decision). Later visits: the saved choice.
 */
export function initialLanguage(
  stored: string | null = readStored(STORAGE_KEYS.language),
  preferred: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language],
): Language {
  if (stored === "es" || stored === "en") return stored;
  return preferred[0]?.toLowerCase().startsWith("en") ? "en" : "es";
}

interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string, vars?: Vars) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDate: (iso: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children, language: forced }: { children: ReactNode; language?: Language }) {
  const [language, setLanguageState] = useState<Language>(() => forced ?? initialLanguage());

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    writeStored(STORAGE_KEYS.language, next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, "app.title");
  }, [language]);

  const value = useMemo<I18nValue>(
    () => ({
      language,
      setLanguage,
      t: (key, vars) => translate(language, key, vars),
      formatNumber: (n, options) => new Intl.NumberFormat(language, options).format(n),
      formatDate: (iso) => new Intl.DateTimeFormat(language, { dateStyle: "long" }).format(new Date(iso)),
    }),
    [language, setLanguage],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}
