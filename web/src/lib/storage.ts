// localStorage can throw: in private browsing on some browsers, when storage
// is full, or when the user blocks site data. A preference that cannot be
// saved must never break the app, so every access is wrapped.

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not saved; the choice still applies until the page is closed.
  }
}

export const STORAGE_KEYS = {
  language: "sa.language",
  theme: "sa.theme",
  suggestOsm: "sa.suggestOsm",
  mapLayer: "sa.mapLayer",
} as const;
