// The small building blocks of the design system: Badge, Segmented, Field,
// PrePrompt, EmptyState, Skeleton, ProgressBar, and the Toast provider.
// Classes come from styles/components.css, only with tokens.
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useI18n } from "../i18n/i18n";
import { Icon, type IconName } from "./Icon";

export function Badge({
  tone,
  icon,
  children,
}: {
  tone?: "success" | "warning" | "danger";
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className={`sa-badge${tone ? ` sa-badge--${tone}` : ""}`}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </span>
  );
}

/** A choice among a few options (radio buttons drawn as one bar). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
}) {
  const name = useId();
  const hintId = useId();
  return (
    <fieldset className="sa-seg-field" aria-describedby={hint ? hintId : undefined}>
      <legend className="field__label">{label}</legend>
      <div className="sa-seg">
        {options.map((option) => (
          <label key={option.value} className={option.value === value ? "sa-seg__on" : undefined}>
            <input
              type="radio"
              className="visually-hidden"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
    </fieldset>
  );
}

/** Label, hint and error wired to one control through the render function. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true as const } : {}) })}
      {hint && (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field__error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The explanation shown BEFORE the browser asks for a permission. */
export function PrePrompt({
  icon,
  title,
  children,
  actions,
  as: Heading = "h2",
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Inside a page that already has its own h2. */
  as?: "h2" | "h3";
}) {
  return (
    <div className="sa-pre">
      <span className="sa-pre__icon">
        <Icon name={icon} size={32} />
      </span>
      <Heading className="sa-pre__title">{title}</Heading>
      <p>{children}</p>
      <div className="actions">{actions}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="sa-empty">
      <span className="sa-empty__icon">
        <Icon name={icon} size={32} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ label }: { label: string }) {
  return (
    <div className="sa-skeleton" role="status">
      <span className="sa-skeleton__line sa-skeleton__line--short" />
      <span className="sa-skeleton__line" />
      <span className="sa-skeleton__block" />
      <span className="caption">{label}</span>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div
      className="sa-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

// --- Toast -------------------------------------------------------------------

interface ToastItem {
  id: number;
  message: string;
}

const ToastContext = createContext<(message: string) => void>(() => {});

const TOAST_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number) => {
      timers.current.set(id, window.setTimeout(() => dismiss(id), TOAST_MS));
    },
    [dismiss],
  );

  const show = useCallback(
    (message: string) => {
      const id = nextId.current++;
      setToasts((items) => [...items, { id, message }]);
      schedule(id);
    },
    [schedule],
  );

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sa-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          // Pauses while the pointer or the focus is on it (WCAG 2.2.1).
          <div
            key={toast.id}
            className="sa-toast"
            onMouseEnter={() => window.clearTimeout(timers.current.get(toast.id))}
            onMouseLeave={() => schedule(toast.id)}
            onFocus={() => window.clearTimeout(timers.current.get(toast.id))}
            onBlur={() => schedule(toast.id)}
          >
            <Icon name="check" size={20} />
            <span>{toast.message}</span>
            <button type="button" className="sa-toast__close" aria-label={t("common.close")} onClick={() => dismiss(toast.id)}>
              <Icon name="close" size={20} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string) => void {
  return useContext(ToastContext);
}
