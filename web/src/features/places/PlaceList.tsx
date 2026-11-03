// The list view: the same places as the map, as a searchable, paged list.
// It is a full alternative to the map (maps are hard to use without a
// pointer or without sight): every place can be found and opened here with
// the keyboard alone.
import "./place-list.css";

import { useEffect, useId, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from "react";

import { useAnnounce } from "../../components/Announcer";
import { useI18n } from "../../i18n/i18n";
import { isAbort, listPlaces, type PlaceList as PlacePage } from "../../lib/api";
import { formatCoordinates } from "../map/geo";

export const PAGE_SIZE = 20;
const LOADING = { kind: "loading" } as const;

export interface PlaceListHandle {
  focusPlace: (id: string) => void;
}

interface PlaceListProps {
  query: string;
  page: number;
  onQueryChange: (query: string, page: number) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  reloadKey: number;
  ref?: Ref<PlaceListHandle>;
}

type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: PlacePage };

export function PlaceList({ query, page, onQueryChange, selectedId, onSelect, reloadKey, ref }: PlaceListProps) {
  const { t, language } = useI18n();
  const announce = useAnnounce();
  const [draft, setDraft] = useState(query);
  const [attempt, setAttempt] = useState(0);
  // Answer stored with its request; a request without an answer = loading.
  const requestKey = `${query}|${page}|${reloadKey}|${attempt}`;
  const [result, setResult] = useState<{ key: string; load: Load } | null>(null);
  const load: Load = result?.key === requestKey ? result.load : LOADING;
  const searchId = useId();
  const hintId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const controller = new AbortController();
    listPlaces({ q: query || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }, controller.signal)
      .then((data) => {
        setResult({ key: requestKey, load: { kind: "ready", data } });
        announce(t("list.results", { count: data.total }));
      })
      .catch((error) => {
        if (isAbort(error)) return;
        setResult({ key: requestKey, load: { kind: "error" } });
        announce(t("list.error"));
      });
    return () => controller.abort();
    // t and announce are stable enough; reloading on a language change is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, page, requestKey]);

  useImperativeHandle(ref, () => ({
    focusPlace: (id) => (items.current.get(id) ?? headingRef.current)?.focus(),
  }));

  function submit(event: FormEvent) {
    event.preventDefault();
    onQueryChange(draft.trim(), 1);
  }

  function goTo(nextPage: number) {
    onQueryChange(query, nextPage);
    // After a page change, start reading at the top of the results.
    headingRef.current?.focus();
  }

  const pages = load.kind === "ready" ? Math.max(1, Math.ceil(load.data.total / PAGE_SIZE)) : 1;

  return (
    <section className="place-list" aria-labelledby="place-list-heading">
      <h2 id="place-list-heading" ref={headingRef} tabIndex={-1} className="place-list__heading">
        {t("list.label")}
      </h2>

      <form role="search" className="place-list__search" onSubmit={submit}>
        <div className="field">
          <label htmlFor={searchId} className="field__label">
            {t("list.search")}
          </label>
          <p id={hintId} className="field__hint">
            {t("list.searchHint")}
          </p>
          <div className="place-list__search-row">
            <input
              id={searchId}
              className="input"
              type="search"
              value={draft}
              maxLength={200}
              aria-describedby={hintId}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="button">
              {t("list.searchButton")}
            </button>
          </div>
        </div>
      </form>

      {load.kind === "loading" && <p className="place-list__muted">{t("list.loading")}</p>}
      {load.kind === "error" && (
        <div className="notice notice--error place-list__message">
          <p>{t("list.error")}</p>
          <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {load.kind === "ready" && (
        <>
          <p className="place-list__count">
            {load.data.total === 0
              ? query
                ? t("list.noResults", { q: query })
                : t("list.empty")
              : t("list.results", { count: load.data.total })}
          </p>
          {load.data.items.length > 0 && (
            <ul className="place-list__items">
              {load.data.items.map((place) => (
                <li key={place.id}>
                  <button
                    type="button"
                    className="place-list__item"
                    aria-pressed={place.id === selectedId}
                    ref={(element) => {
                      if (element) items.current.set(place.id, element);
                      else items.current.delete(place.id);
                    }}
                    onClick={() => onSelect(place.id)}
                  >
                    {/* The spaces keep the parts apart in the button's spoken name. */}
                    <span className="place-list__name">{place.name}</span>{" "}
                    {place.description && (
                      <>
                        <span className="place-list__description">{place.description}</span>{" "}
                      </>
                    )}
                    <span className="place-list__coords">
                      {formatCoordinates(place.latitude, place.longitude, t, language)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav className="place-list__pages" aria-label={t("list.pagination")}>
              <button type="button" className="button" disabled={page <= 1} onClick={() => goTo(page - 1)}>
                {t("list.previous")}
              </button>
              <p aria-current="page">{t("list.page", { page, pages })}</p>
              <button type="button" className="button" disabled={page >= pages} onClick={() => goTo(page + 1)}>
                {t("list.next")}
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
