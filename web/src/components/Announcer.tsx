// One polite live region for the whole app. Screen readers read whatever
// text appears in it, without moving the focus and without interrupting
// what they are already saying (aria-live="polite", via role="status").
// Components call announce("...") after something changes on screen that a
// blind user would otherwise miss: places loaded, a panel opened, a view
// switched.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

const AnnounceContext = createContext<(message: string) => void>(() => {});

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<number | undefined>(undefined);

  const announce = useCallback((next: string) => {
    // Clear first, then set: repeating the same sentence must be read again.
    setMessage("");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(next), 60);
  }, []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext);
}
