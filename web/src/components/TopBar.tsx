// The bar over the map: search, Map/List switch, language and account menu.
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { useI18n } from "../i18n/i18n";
import { Icon } from "./Icon";
import { Preferences } from "./Preferences";

interface TopBarProps {
  view: "map" | "list";
  onView: (view: "map" | "list") => void;
  /** Hidden in the list view, which has its own search form. */
  onSearch?: (query: string) => void;
  /** While another screen is open, neither view is the current one. */
  viewsCurrent: boolean;
  /** Extra entries of the account menu (who you are, sign out...). */
  menuExtra?: ReactNode;
  menuLabel?: string;
}

export function TopBar({ view, onView, onSearch, viewsCurrent, menuExtra, menuLabel }: TopBarProps) {
  const { t, language, setLanguage } = useI18n();
  const [draft, setDraft] = useState("");
  const searchId = useId();
  const other = language === "es" ? "en" : "es";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.trim()) onSearch?.(draft.trim());
  }

  return (
    <header className="top-bar">
      {onSearch ? (
        <form role="search" className="top-bar__search" onSubmit={submit}>
          <label htmlFor={searchId} className="visually-hidden">
            {t("top.search")}
          </label>
          <Icon name="search" size={20} />
          <input
            id={searchId}
            className="input"
            type="search"
            placeholder={t("top.search")}
            maxLength={200}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
      ) : (
        <div className="top-bar__spacer" />
      )}

      <nav aria-label={t("nav.label")}>
        <div className="sa-switch" role="group" aria-label={t("nav.views")}>
          {(["map", "list"] as const).map((option) => (
            <button key={option} type="button" aria-pressed={viewsCurrent && view === option} onClick={() => onView(option)}>
              {t(`nav.${option}`)}
            </button>
          ))}
        </div>
      </nav>

      <div className="top-bar__spacer" />

      <button type="button" className="sa-btn top-bar__lang" onClick={() => setLanguage(other)}>
        <Icon name="globe" size={20} />
        <span className="visually-hidden">{t("settings.language.switchToLabel")} </span>
        <span lang={other}>{t("settings.language.switchTo")}</span>
      </button>

      <AccountMenu extra={menuExtra} label={menuLabel} />
    </header>
  );
}

function AccountMenu({ extra, label }: { extra?: ReactNode; label?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Closes with Escape or a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="sa-btn sa-btn--icon"
        aria-expanded={open}
        aria-label={label ?? t("top.menu")}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="user" size={22} />
      </button>
      {open && (
        <div className="menu__panel">
          {extra}
          <Preferences />
        </div>
      )}
    </div>
  );
}
