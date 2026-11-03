// Checks for the add-place form. Same limits as the API (backend/app/
// schemas.py and the table's CHECK constraints): the browser catches mistakes
// at once, and the server still checks everything again.

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 2000;

export interface Draft {
  latitude: string;
  longitude: string;
  name: string;
  description: string;
}

export type Field = keyof Draft;

/** An error: a translation key plus its values. */
export interface FieldError {
  key: string;
  vars?: Record<string, number>;
}

export type Errors = Partial<Record<Field, FieldError>>;

/**
 * Reads a coordinate typed by a person: "43,2630" (Spanish decimal comma),
 * "43.2630", "−2.93" (the typographic minus sign) and spaces all work.
 * Returns null if it is not a single plain number.
 */
export function parseCoordinate(text: string): number | null {
  const cleaned = text.trim().replace(/\s+/g, "").replace(/−/g, "-").replace(",", ".");
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** How a coordinate is written back into a field, in the reader's language. */
export function formatCoordinateInput(value: number, language: string): string {
  const text = value.toFixed(6);
  return language === "es" ? text.replace(".", ",") : text;
}

function checkCoordinate(text: string, min: number, max: number, which: "latitude" | "longitude"): FieldError | undefined {
  if (text.trim() === "") return { key: `validation.${which}Required` };
  const value = parseCoordinate(text);
  if (value === null) return { key: `validation.${which}Number` };
  if (value < min || value > max) return { key: `validation.${which}Range` };
  return undefined;
}

export function validateLocation(draft: Draft): Errors {
  const errors: Errors = {};
  const lat = checkCoordinate(draft.latitude, -90, 90, "latitude");
  const lon = checkCoordinate(draft.longitude, -180, 180, "longitude");
  if (lat) errors.latitude = lat;
  if (lon) errors.longitude = lon;
  return errors;
}

export function validateDetails(draft: Draft): Errors {
  const errors: Errors = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = { key: "validation.nameRequired" };
  else if (name.length > NAME_MAX) {
    errors.name = { key: "validation.nameTooLong", vars: { count: name.length, max: NAME_MAX } };
  }
  const description = draft.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    errors.description = {
      key: "validation.descriptionTooLong",
      vars: { count: description.length, max: DESCRIPTION_MAX },
    };
  }
  return errors;
}
