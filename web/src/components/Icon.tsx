// The product's line icons: 24 px grid, 1.75 px stroke, round caps, drawn
// inline with currentColor. No icon font and nothing loaded from elsewhere.
// Decorative by default (aria-hidden): the button or text beside it names it.
import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />,
  pause: (
    <>
      <rect x="7" y="5.5" width="3.5" height="13" rx="1" fill="currentColor" />
      <rect x="13.5" y="5.5" width="3.5" height="13" rx="1" fill="currentColor" />
    </>
  ),
  record: <circle cx="12" cy="12" r="5" fill="currentColor" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />,
  pin: (
    <>
      <path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  map: <path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />,
  camera: (
    <>
      <path d="M4 8h3.5L9 5.5h6L16.5 8H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  loop: <path d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1" />,
  timer: (
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 9.5v4l2.5 1.5M9.5 3h5" />
    </>
  ),
  compare: <path d="M7 20V5M3.5 8.5 7 5l3.5 3.5M17 4v15M13.5 15.5 17 19l3.5-3.5" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.3 3.5 5.2 3.5 8.5s-1 6.2-3.5 8.5c-2.5-2.3-3.5-5.2-3.5-8.5s1-6.2 3.5-8.5z" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />,
  flag: <path d="M6 21V4h11l-2 4 2 4H6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  layers: <path d="m12 4 9 5-9 5-9-5zM3 14l9 5 9-5" />,
  alert: <path d="M12 4 2.5 20h19zM12 10v4.5M12 17.5h.01" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m15 5-7 7 7 7" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20.5c1-4 4-6 7.5-6s6.500 2 7.500 6" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3" />
    </>
  ),
  offline: <path d="M3 3l18 18M8.500 16a5 5 0 0 1 7 0M5 12.500a10 10 0 0 1 4-2.500M19 12.500a10 10 0 0 0-5-2.800M2 8.500a15 15 0 0 1 4.500-2.800M22 8.500A15 15 0 0 0 11 4.500M12 20h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
