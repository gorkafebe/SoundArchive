// Language and theme switches, always visible in the header.
import { useId } from "react";

import { useI18n } from "../i18n/i18n";
import { THEME_CHOICES, useTheme, type ThemeChoice } from "../lib/theme";

export function Preferences() {
  const { t, language, setLanguage } = useI18n();
  const { choice, setChoice } = useTheme();
  const themeId = useId();
  const other = language === "es" ? "en" : "es";

  return (
    <div className="preferences" role="group" aria-label={t("settings.label")}>
      {/* The button shows the OTHER language's name, written in that
          language (lang attribute), which is how people look for it. */}
      <button
        type="button"
        className="button button--quiet"
        onClick={() => setLanguage(other)}
        aria-label={t("settings.language.switchToLabel")}
      >
        <span lang={other}>{t("settings.language.switchTo")}</span>
      </button>

      <div className="preferences__theme">
        <label htmlFor={themeId} className="preferences__label">
          {t("settings.theme.label")}
        </label>
        <select
          id={themeId}
          className="select"
          value={choice}
          onChange={(event) => setChoice(event.target.value as ThemeChoice)}
        >
          {THEME_CHOICES.map((option) => (
            <option key={option} value={option}>
              {t(`settings.theme.${option}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
