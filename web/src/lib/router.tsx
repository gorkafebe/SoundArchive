// A minimal router on the browser's History API. Enough for a handful of
// screens, with no extra dependency. Caddy already answers every unknown
// address with index.html, so a reload or a shared link works.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface RouterValue {
  path: string;
  search: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState({ path: window.location.pathname, search: window.location.search });

  useEffect(() => {
    const update = () => setLocation({ path: window.location.pathname, search: window.location.search });
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"](null, "", to);
    setLocation({ path: window.location.pathname, search: window.location.search });
  }, []);

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter must be used inside <RouterProvider>");
  return value;
}

/** Match "/recordings/:id" against a path; returns the parameters or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
