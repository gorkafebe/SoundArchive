// Talks to the API. Same origin as the page (Caddy serves both), so plain
// relative URLs work on localhost, a LAN address, Tailscale or a domain.
// Every function takes an AbortSignal, so a newer request can cancel an
// older one (e.g. when the map moves again before the answer arrives).

export interface PublicConfig {
  writes_enabled: boolean;
  map_style_url: string;
  map_style_url_dark: string;
  external_places_enabled: boolean;
  satellite_enabled: boolean;
  satellite_global_fallback: boolean;
  topo_es_enabled: boolean;
  location_warn_accuracy_m: number;
}

export interface Place {
  id: string;
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  location_accuracy_m?: number | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  author_name?: string | null;
  recording_count?: number;
  latest_recorded_at?: string | null;
}

export interface PlaceList {
  items: Place[];
  total: number;
  limit: number;
  offset: number;
}

export interface PlaceFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: { name: string };
}

export interface PlaceFeatureCollection {
  type: "FeatureCollection";
  features: PlaceFeature[];
  truncated: boolean;
}

export interface NewPlace {
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  location_accuracy_m?: number | null;
  confirm_distinct?: boolean;
  external_source?: string;
  external_id?: string;
}

export interface NearbyPlace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance_m: number;
  recording_count: number;
  name_similarity?: number | null;
}

export interface ExternalSuggestion {
  external_source: string;
  external_id: string;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  distance_m: number;
  matches_place_id?: string | null;
}

export interface PlaceSuggestions {
  existing: NearbyPlace[];
  external: ExternalSuggestion[];
  external_available: boolean;
  attribution: string | null;
  radius_m: number;
}

export interface Me {
  id: string;
  username: string;
  role: "user" | "admin";
  language: string | null;
  csrf_token: string;
}

export type RecordingStatus = "uploading" | "processing" | "ready" | "failed" | "removed";
export type License = "all-rights-reserved" | "cc-by" | "cc-by-nc" | "cc-by-sa" | "cc-by-nc-sa" | "cc0";
export const LICENSES: License[] = ["all-rights-reserved", "cc-by", "cc-by-nc", "cc-by-sa", "cc-by-nc-sa", "cc0"];

export interface Recording {
  id: string;
  place_id: string;
  place_name: string | null;
  title: string;
  heard: string | null;
  recorded_at: string;
  recorded_tz: string | null;
  status: RecordingStatus;
  failure_code: string | null;
  visibility: "public" | "private";
  show_author: boolean;
  author_name: string | null;
  is_owner: boolean;
  license: License;
  capture_method: "browser" | "upload";
  capture_settings: Record<string, unknown> | null;
  device_note: string | null;
  size_bytes: number | null;
  sha256: string | null;
  duration_seconds: number | null;
  container: string | null;
  codec: string | null;
  sample_rate: number | null;
  channels: number | null;
  bit_depth: number | null;
  loudness_lufs: number | null;
  true_peak_dbfs: number | null;
  location_accuracy_m: number | null;
  created_at: string;
  removed_reason?: string | null;
  report_count?: number | null;
}

export interface NewRecording {
  place_id: string;
  title: string;
  heard: string | null;
  recorded_at: string;
  recorded_tz: string | null;
  visibility: "public" | "private";
  show_author: boolean;
  license: License;
  capture_method: "browser" | "upload";
  capture_settings: Record<string, unknown> | null;
  device_note: string | null;
  size: number;
  filename: string | null;
}

export interface UploadState {
  received: number;
  total: number;
  status: RecordingStatus;
}

export interface Photo {
  id: string;
  place_id: string;
  caption: string | null;
  alt_text: string | null;
  width: number;
  height: number;
  is_owner: boolean;
  created_at: string;
}

export interface Invitation {
  id: string;
  code_hint: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_name: string | null;
  revoked_at: string | null;
  code?: string;
}

export interface AdminUser {
  id: string;
  username: string;
  role: string;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
}

export interface ContentRow extends Recording {
  reports: { id: string; reason: string; created_at: string }[];
}

export interface AdminPlace {
  id: string;
  name: string;
  author_name: string | null;
  removed_at: string | null;
  removed_reason: string | null;
}

export interface ContentPage {
  recordings: ContentRow[];
  places: AdminPlace[];
}

/** status 0 = no answer at all (offline, server down, request blocked). */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  retryAfter?: number;
  received?: number;
  /** On a 409 about places: which ones are in the way. */
  conflict?: { code: string; candidates: NearbyPlace[] };
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// The CSRF token of this session, from /api/auth/me. Every request that
// changes something carries it; another site cannot read it.
let csrfToken = "";

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

/** Called when the server says the session is over. */
let onSignedOut: () => void = () => {};

export function setSignedOutHandler(handler: () => void): void {
  onSignedOut = handler;
}

export function authHeaders(): Record<string, string> {
  return csrfToken ? { "X-CSRF-Token": csrfToken } : {};
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(method === "GET" ? {} : authHeaders()),
    ...(init.headers as Record<string, string> | undefined),
  };
  try {
    return await fetch(url, { ...init, headers });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, "Network error");
  }
}

export async function parseFailure(response: Response): Promise<ApiError> {
  let code: string | undefined;
  let retryAfter: number | undefined;
  let received: number | undefined;
  let conflict: ApiError["conflict"];
  try {
    const body = await response.json();
    code = typeof body?.detail?.code === "string" ? body.detail.code : undefined;
    retryAfter = typeof body?.detail?.retry_after === "number" ? body.detail.retry_after : undefined;
    received = typeof body?.detail?.received === "number" ? body.detail.received : undefined;
    if (code && Array.isArray(body?.detail?.candidates)) conflict = { code, candidates: body.detail.candidates };
  } catch {
    // Not JSON (a proxy error page, for instance); the status is enough.
  }
  const error = new ApiError(response.status, `HTTP ${response.status}`, code);
  error.retryAfter = retryAfter;
  error.received = received;
  error.conflict = conflict;
  return error;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) {
    const error = await parseFailure(response);
    if (response.status === 401 && error.code === "not_signed_in") onSignedOut();
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function postJson<T>(url: string, body: unknown, signal?: AbortSignal, method = "POST"): Promise<T> {
  return request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export function getConfig(signal?: AbortSignal): Promise<PublicConfig> {
  return request("/api/config", { signal });
}

export function getPlacesInArea(
  bbox: [number, number, number, number],
  signal?: AbortSignal,
  limit = 1000,
): Promise<PlaceFeatureCollection> {
  const params = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(6)).join(","), limit: String(limit) });
  return request(`/api/places?${params}`, { signal });
}

export function listPlaces(
  options: { q?: string; limit: number; offset: number },
  signal?: AbortSignal,
): Promise<PlaceList> {
  const params = new URLSearchParams({ limit: String(options.limit), offset: String(options.offset) });
  if (options.q) params.set("q", options.q);
  return request(`/api/places/list?${params}`, { signal });
}

export function getPlace(id: string, signal?: AbortSignal): Promise<Place> {
  return request(`/api/places/${encodeURIComponent(id)}`, { signal });
}

export function createPlace(place: NewPlace, signal?: AbortSignal): Promise<Place> {
  return postJson("/api/places", place, signal);
}

export function getSuggestions(
  options: { lat: number; lon: number; accuracy: number | null; external: boolean },
  signal?: AbortSignal,
): Promise<PlaceSuggestions> {
  const params = new URLSearchParams({
    lat: options.lat.toFixed(7),
    lon: options.lon.toFixed(7),
    external: String(options.external),
  });
  if (options.accuracy !== null) params.set("accuracy", String(options.accuracy));
  return request(`/api/places/suggest?${params}`, { signal });
}

// --- Accounts -----------------------------------------------------------------

export function getMe(signal?: AbortSignal): Promise<Me> {
  return request("/api/auth/me", { signal });
}

export function login(username: string, password: string): Promise<Me> {
  return postJson("/api/auth/login", { username, password });
}

export function register(code: string, username: string, password: string, language: string): Promise<Me> {
  return postJson("/api/auth/register", { code, username, password, language });
}

export function logout(): Promise<void> {
  return request("/api/auth/logout", { method: "POST" });
}

export function logoutEverywhere(): Promise<void> {
  return request("/api/auth/logout-all", { method: "POST" });
}

export function changePassword(current_password: string, new_password: string): Promise<void> {
  return postJson("/api/auth/password", { current_password, new_password });
}

export function saveLanguage(language: string): Promise<Me> {
  return postJson("/api/auth/me", { language }, undefined, "PATCH");
}

// --- Recordings -----------------------------------------------------------------

export function listRecordings(placeId: string, signal?: AbortSignal): Promise<{ items: Recording[] }> {
  return request(`/api/places/${encodeURIComponent(placeId)}/recordings`, { signal });
}

export function getRecording(id: string, signal?: AbortSignal): Promise<Recording> {
  return request(`/api/recordings/${encodeURIComponent(id)}`, { signal });
}

export function createRecording(body: NewRecording): Promise<Recording> {
  return postJson("/api/recordings", body);
}

export function updateRecording(id: string, body: Partial<NewRecording>): Promise<Recording> {
  return postJson(`/api/recordings/${encodeURIComponent(id)}`, body, undefined, "PATCH");
}

export function removeRecording(id: string): Promise<Recording> {
  return postJson(`/api/recordings/${encodeURIComponent(id)}/remove`, {});
}

export function reportRecording(id: string, reason: string): Promise<unknown> {
  return postJson(`/api/recordings/${encodeURIComponent(id)}/report`, { reason });
}

export function getUploadState(id: string, signal?: AbortSignal): Promise<UploadState> {
  return request(`/api/recordings/${encodeURIComponent(id)}/upload`, { signal });
}

export async function getPeaks(id: string, signal?: AbortSignal): Promise<number[]> {
  const body = await request<{ peaks: number[] }>(`/api/recordings/${encodeURIComponent(id)}/peaks`, { signal });
  return body.peaks;
}

export const audioUrl = (id: string) => `/api/recordings/${encodeURIComponent(id)}/audio`;
export const originalUrl = (id: string) => `/api/recordings/${encodeURIComponent(id)}/original`;

// --- Photos ---------------------------------------------------------------------

export function listPhotos(placeId: string, signal?: AbortSignal): Promise<Photo[]> {
  return request(`/api/places/${encodeURIComponent(placeId)}/photos`, { signal });
}

export function uploadPhoto(placeId: string, file: Blob, caption: string, alt: string): Promise<Photo> {
  const params = new URLSearchParams();
  if (caption) params.set("caption", caption);
  if (alt) params.set("alt", alt);
  return request(`/api/places/${encodeURIComponent(placeId)}/photos?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
}

export function removePhoto(id: string): Promise<void> {
  return request(`/api/photos/${encodeURIComponent(id)}/remove`, { method: "POST" });
}

export const photoUrl = (id: string, size: "thumb" | "medium" | "large") =>
  `/api/photos/${encodeURIComponent(id)}/${size}`;

// --- Administration --------------------------------------------------------------

export const getContent = (): Promise<ContentPage> => request("/api/admin/content");
export const removeContent = (id: string, reason: string): Promise<Recording> =>
  postJson(`/api/admin/recordings/${encodeURIComponent(id)}/remove`, { reason });
export const restoreContent = (id: string): Promise<Recording> =>
  request(`/api/admin/recordings/${encodeURIComponent(id)}/restore`, { method: "POST" });
export const resolveReports = (id: string): Promise<void> =>
  request(`/api/admin/recordings/${encodeURIComponent(id)}/resolve-reports`, { method: "POST" });
export const removeAdminPlace = (id: string, reason: string): Promise<AdminPlace> =>
  postJson(`/api/admin/places/${encodeURIComponent(id)}/remove`, { reason });
export const restoreAdminPlace = (id: string): Promise<AdminPlace> =>
  request(`/api/admin/places/${encodeURIComponent(id)}/restore`, { method: "POST" });
export const getInvitations = (): Promise<Invitation[]> => request("/api/admin/invitations");
export const createInvitation = (days: number): Promise<Invitation> => postJson("/api/admin/invitations", { days });
export const revokeInvitation = (id: string): Promise<void> =>
  request(`/api/admin/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
export const getUsers = (): Promise<AdminUser[]> => request("/api/admin/users");
export const deactivateUser = (id: string): Promise<AdminUser> =>
  request(`/api/admin/users/${encodeURIComponent(id)}/deactivate`, { method: "POST" });
export const reactivateUser = (id: string): Promise<AdminUser> =>
  request(`/api/admin/users/${encodeURIComponent(id)}/reactivate`, { method: "POST" });
export const getAudit = (): Promise<AuditEntry[]> => request("/api/admin/audit");
