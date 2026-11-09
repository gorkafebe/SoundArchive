// "Is it one of these?": places already here, and named sites from OpenStreetMap.
// Both only ask: the person decides, and can always say no.
import { useEffect, useId, useRef } from "react";

import { Badge } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import type { ExternalSuggestion, NearbyPlace } from "../../lib/api";

/** A heading that takes the focus when the block appears, so it is read out. */
function BlockHeading({ id, children }: { id: string; children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h3 id={id} ref={ref} tabIndex={-1} className="known__title">
      {children}
    </h3>
  );
}

export function SamePlaceChoice({
  candidates,
  onSame,
  onDistinct,
  distinctLabel,
}: {
  candidates: NearbyPlace[];
  onSame: (candidate: NearbyPlace) => void;
  onDistinct: () => void;
  distinctLabel?: string;
}) {
  const { t } = useI18n();
  const headingId = useId();
  return (
    <section className="known known--strong" aria-labelledby={headingId}>
      <BlockHeading id={headingId}>{t("add.known.existingTitle")}</BlockHeading>
      <p>{t("add.known.existingIntro")}</p>
      <ul className="known__list">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="known__item">
            <span className="known__icon">
              <Icon name="pin" size={24} />
            </span>
            <div className="known__body">
              <p className="known__name">{candidate.name}</p>
              <p className="caption">
                {t("add.known.distance", { meters: Math.round(candidate.distance_m) })} ·{" "}
                {t("add.known.recordings", { count: candidate.recording_count })}
              </p>
            </div>
            <button
              type="button"
              className="sa-btn"
              aria-label={t("add.known.sameNamed", { name: candidate.name })}
              onClick={() => onSame(candidate)}
            >
              {t("add.known.same")}
            </button>
          </li>
        ))}
      </ul>
      <div className="add-place__actions">
        <button type="button" className="sa-btn sa-btn--primary" onClick={onDistinct}>
          {distinctLabel ?? t("add.known.distinct")}
        </button>
      </div>
    </section>
  );
}

/** OpenStreetMap's tag values, in words people use. Unknown ones stay as they are. */
function useCategoryLabel() {
  const { t } = useI18n();
  return (category: string) => {
    const key = `add.osm.category.${category}`;
    const label = t(key);
    return label === key ? category.replaceAll("_", " ") : label;
  };
}

export function ExternalChoice({
  sites,
  onPick,
  onNone,
}: {
  sites: ExternalSuggestion[];
  onPick: (site: ExternalSuggestion) => void;
  onNone: () => void;
}) {
  const { t } = useI18n();
  const categoryLabel = useCategoryLabel();
  const headingId = useId();
  return (
    <section className="known" aria-labelledby={headingId}>
      <BlockHeading id={headingId}>{t("add.known.externalTitle")}</BlockHeading>
      <p>{t("add.known.externalIntro")}</p>
      <ul className="known__list">
        {sites.map((site) => (
          <li key={site.external_id} className="known__item">
            <div className="known__body">
              <p className="known__name">{site.name}</p>
              <p className="caption">
                {categoryLabel(site.category)} · {t("add.known.distance", { meters: Math.round(site.distance_m) })}
              </p>
              {site.matches_place_id && <Badge tone="warning">{t("add.known.similar")}</Badge>}
            </div>
            <button
              type="button"
              className="sa-btn"
              aria-label={t("add.known.pickNamed", { name: site.name })}
              onClick={() => onPick(site)}
            >
              {t("add.known.pick")}
            </button>
          </li>
        ))}
      </ul>
      <p className="caption">
        <a href={t("map.osmAttributionLink")} target="_blank" rel="noreferrer">
          {t("add.known.attribution")}
        </a>
      </p>
      <div className="add-place__actions">
        <button type="button" className="sa-btn sa-btn--primary" onClick={onNone}>
          {t("add.known.none")}
        </button>
      </div>
    </section>
  );
}
