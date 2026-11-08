// Your account: change the password, sign out on every device.
import { useState, type FormEvent } from "react";

import { Icon } from "../../components/Icon";
import { Field, useToast } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { ApiError, changePassword } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { useAuth } from "./AuthContext";

export function AccountPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { navigate } = useRouter();
  const { user, signOutEverywhere } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      toast(t("account.passwordChanged"));
    } catch (failure) {
      setError(t(failure instanceof ApiError && failure.code ? `auth.error.${failure.code}` : "auth.error.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page__inner">
        <div className="page__bar">
          <button type="button" className="sa-btn sa-btn--quiet" onClick={() => navigate("/")}>
            <span className="icon-back">
              <Icon name="chevron" size={20} />
            </span>
            {t("common.back")}
          </button>
        </div>
        <h1 className="page__title">{t("account.title")}</h1>
        <p>{user?.username}</p>
        <form className="card" onSubmit={submit} noValidate>
          <h2 className="card__heading">{t("account.changePassword")}</h2>
          <Field label={t("account.currentPassword")}>
            {(props) => <input {...props} className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </Field>
          <Field label={t("account.newPassword")} hint={t("auth.passwordHint")} error={error}>
            {(props) => <input {...props} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
          </Field>
          <div className="actions">
            <button type="submit" className="sa-btn sa-btn--primary" disabled={busy || !current || !next}>
              {t("account.save")}
            </button>
          </div>
        </form>
        <section className="card" aria-labelledby="sessions-heading">
          <h2 id="sessions-heading" className="card__heading">
            {t("account.sessions")}
          </h2>
          <p className="caption">{t("account.sessionsBody")}</p>
          <div className="actions">
            <button type="button" className="sa-btn" onClick={() => void signOutEverywhere()}>
              {t("account.signOutEverywhere")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
