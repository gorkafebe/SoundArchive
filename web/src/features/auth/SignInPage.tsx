// Sign in, and create an account with an invitation (screen 14). No open
// sign-up: an account needs a code from an administrator.
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Field } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { ApiError, login, register } from "../../lib/api";
import { useAuth } from "./AuthContext";

function errorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return "auth.error.network";
  if (error.status === 0) return "auth.error.network";
  if (error.status === 429) return "auth.error.tooMany";
  if (error.code) return `auth.error.${error.code}`;
  return "auth.error.server";
}

export function SignInPage() {
  const { t, language } = useI18n();
  const { accept, state } = useAuth();
  const expired = state.status === "signedOut" && state.expired;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const initialCode = new URLSearchParams(window.location.search).get("code") ?? "";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const [code, setCode] = useState(initialCode);
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [registerError, setRegisterError] = useState<{ field: "code" | "name" | "password" | "form"; key: string } | null>(null);
  const [registerBusy, setRegisterBusy] = useState(false);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError(null);
    try {
      accept(await login(username.trim(), password));
    } catch (error) {
      setLoginError(errorKey(error));
      setLoginBusy(false);
    }
  }

  async function submitRegister(event: FormEvent) {
    event.preventDefault();
    setRegisterBusy(true);
    setRegisterError(null);
    try {
      accept(await register(code.trim(), newName.trim(), newPassword, language));
    } catch (error) {
      const key = errorKey(error);
      const failure = error instanceof ApiError ? (error.code ?? "") : "";
      const field = failure.includes("invitation")
        ? "code"
        : failure.startsWith("username")
          ? "name"
          : failure.startsWith("password")
            ? "password"
            : "form";
      setRegisterError({ field, key });
      setRegisterBusy(false);
    }
  }

  return (
    <main id="main-content" className="page signin" tabIndex={-1}>
      <div className="signin__grid">
        <section aria-labelledby="signin-heading" className="signin__column">
          <h1 id="signin-heading" ref={headingRef} tabIndex={-1} className="signin__title">
            {t("auth.signIn")}
          </h1>
          <p className="caption">{t("auth.intro")}</p>
          {expired && (
            <p className="notice" role="status">
              {t("auth.expired")}
            </p>
          )}
          <form className="signin__form" onSubmit={submitLogin} noValidate>
            <Field label={t("auth.username")}>
              {(props) => (
                <input {...props} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
              )}
            </Field>
            <Field label={t("auth.password")}>
              {(props) => (
                <input {...props} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              )}
            </Field>
            {loginError && (
              <p className="field__error" role="alert">
                {t(loginError)}
              </p>
            )}
            <div className="actions">
              <button type="submit" className="sa-btn sa-btn--primary" disabled={loginBusy || !username || !password}>
                {t("auth.signIn")}
              </button>
            </div>
          </form>
        </section>

        <section aria-labelledby="register-heading" className="card signin__column">
          <h2 id="register-heading" className="signin__subtitle">
            {t("auth.registerTitle")}
          </h2>
          <form className="signin__form" onSubmit={submitRegister} noValidate>
            <Field label={t("auth.code")} error={registerError?.field === "code" ? t(registerError.key) : null}>
              {(props) => (
                <input {...props} className="input" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
              )}
            </Field>
            <Field label={t("auth.username")} hint={t("auth.usernameHint")} error={registerError?.field === "name" ? t(registerError.key) : null}>
              {(props) => (
                <input {...props} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={newName} onChange={(e) => setNewName(e.target.value)} />
              )}
            </Field>
            <Field label={t("auth.password")} hint={t("auth.passwordHint")} error={registerError?.field === "password" ? t(registerError.key) : null}>
              {(props) => (
                <input {...props} className="input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              )}
            </Field>
            {registerError?.field === "form" && (
              <p className="field__error" role="alert">
                {t(registerError.key)}
              </p>
            )}
            <div className="actions">
              <button type="submit" className="sa-btn" disabled={registerBusy || !code || !newName || !newPassword}>
                {t("auth.createAccount")}
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
