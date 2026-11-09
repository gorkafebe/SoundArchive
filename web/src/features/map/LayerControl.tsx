// "Layers": one control, used on the main map and on the map for adding a
// place. A button opens a group of radio buttons: arrow keys move and choose,
// Esc closes, and the focus goes back to the button.
import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { useAnnounce } from "../../components/Announcer";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import type { LayerId } from "./layers";
import type { MapLayers } from "./MapLayers";

export function LayerControl({ layers }: { layers: MapLayers }) {
  const { t } = useI18n();
  const announce = useAnnounce();
  const state = useSyncExternalStore(layers.subscribe, layers.getState);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const groupId = useId();

  // Only the plain map on offer: nothing to choose.
  if (state.options.length < 2) return null;

  const name = (id: LayerId) => t(`map.layers.${id}`);

  function choose(id: LayerId) {
    layers.choose(id);
    announce(t("map.layers.changed", { name: name(id) }));
  }

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = state.options.findIndex((option) => option.id === state.selected);
    const next = state.options[(index + step + state.options.length) % state.options.length];
    choose(next.id);
    groupRef.current?.querySelector<HTMLElement>(`[data-layer="${next.id}"]`)?.focus();
  }

  return (
    <div
      className="layer-control"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="sa-btn layer-control__button"
        aria-expanded={open}
        aria-controls={open ? groupId : undefined}
        onClick={() => {
          setOpen((value) => !value);
          // Keep the focus inside, on the current choice, when it opens.
          window.setTimeout(() => groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(), 0);
        }}
      >
        <Icon name="layers" size={20} />
        {t("map.layers.button")}
      </button>

      {open && (
        <div
          ref={groupRef}
          id={groupId}
          role="radiogroup"
          aria-label={t("map.layers.group")}
          className="layer-control__group"
          onKeyDown={onKeyDown}
        >
          {state.options.map((option) => {
            const checked = option.id === state.selected;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                data-layer={option.id}
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className="layer-control__option"
                onClick={() => {
                  choose(option.id);
                  close();
                }}
              >
                <span className="layer-control__mark" aria-hidden="true">
                  {checked && <Icon name="check" size={16} />}
                </span>
                {name(option.id)}
              </button>
            );
          })}
        </div>
      )}

      {state.unavailable && <p className="map-status layer-control__notice">{t(`map.layers.unavailable.${state.selected}`)}</p>}
      {state.failed && (
        <div className="map-status map-status--error layer-control__notice" role="status">
          <p>{t("map.layers.failed")}</p>
          <button
            type="button"
            className="sa-btn"
            onClick={() => {
              choose("map");
              buttonRef.current?.focus();
            }}
          >
            {t("map.layers.backToMap")}
          </button>
        </div>
      )}
    </div>
  );
}
