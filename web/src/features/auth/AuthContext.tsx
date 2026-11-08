// Who is signed in. The session cookie is HttpOnly (JavaScript cannot see it),
// so the app asks the server: /api/auth/me answers with the user and the CSRF
// token, or 401 when there is no session.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import * as api from "../../lib/api";
import type { Me } from "../../lib/api";

type AuthState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "signedOut"; expired: boolean }
  | { status: "signedIn"; user: Me };

interface AuthValue {
  state: AuthState;
  /** The signed-in user; only for screens that are inside the gate. */
  user: Me | null;
  accept: (user: Me) => void;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getMe(controller.signal)
      .then((user) => {
        api.setCsrfToken(user.csrf_token);
        setState({ status: "signedIn", user });
      })
      .catch((error) => {
        if (api.isAbort(error)) return;
        setState(
          error instanceof api.ApiError && error.status === 401
            ? { status: "signedOut", expired: false }
            : { status: "error" },
        );
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    api.setSignedOutHandler(() => {
      api.setCsrfToken("");
      setState((current) => (current.status === "signedIn" ? { status: "signedOut", expired: true } : current));
    });
  }, []);

  const accept = useCallback((user: Me) => {
    api.setCsrfToken(user.csrf_token);
    setState({ status: "signedIn", user });
  }, []);

  const end = useCallback(async (call: () => Promise<void>) => {
    await call();
    api.setCsrfToken("");
    setState({ status: "signedOut", expired: false });
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      state,
      user: state.status === "signedIn" ? state.user : null,
      accept,
      signOut: () => end(api.logout),
      signOutEverywhere: () => end(api.logoutEverywhere),
      retry: () => {
        setState({ status: "loading" });
        setAttempt((n) => n + 1);
      },
    }),
    [state, accept, end],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
