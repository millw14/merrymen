/**
 * Hand-drawn line-icon set — consistent 24px grid, 1.5 stroke, round joins.
 * Original marks; used everywhere instead of emoji for a crafted, editorial feel.
 */

type IconName =
  | "globe" | "key" | "shield" | "beaker" | "chart" | "ledger"
  | "cpu" | "calendar" | "transfer" | "bell" | "eye" | "mic"
  | "power" | "terminal" | "desktop" | "chat" | "feather" | "wallet"
  | "lock" | "bolt" | "arrow" | "check" | "spark" | "sound";

const P: Record<IconName, React.ReactNode> = {
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18M4.4 7h15.2M4.4 17h15.2" />
    </>
  ),
  key: (
    <>
      <circle cx="7" cy="16.5" r="3.4" />
      <path d="M9.4 14.1 19 4.5M16 7.5l2.4 2.4M13.4 10.1l2 2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 5-3.4 8-7 10-3.6-2-7-5-7-10V6z" />
      <path d="M9 12l2 2 4-4.6" />
    </>
  ),
  beaker: (
    <>
      <path d="M9 3h6M10 3v6.2L5.6 17a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L14 9.2V3" />
      <path d="M7.6 14h8.8" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20h16M4 20V5" />
      <path d="M7 15l3.6-4 3 2.6L20 7" />
      <path d="M20 7h-3M20 7v3" />
    </>
  ),
  ledger: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </>
  ),
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <rect x="10" y="10" width="4" height="4" rx="0.5" />
      <path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 9.5h16M8 3v4M16 3v4" />
      <circle cx="9" cy="13.5" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="13.5" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  transfer: (
    <>
      <path d="M8 4v16M8 4 5.5 7M8 4l2.5 3" />
      <path d="M16 20V4M16 20l-2.5-3M16 20l2.5-3" />
    </>
  ),
  bell: (
    <>
      <path d="M6.2 16.5h11.6c-1.5-1-2-2.6-2-5.2a3.8 3.8 0 0 0-7.6 0c0 2.6-.5 4.2-2 5.2z" />
      <path d="M10 19a2 2 0 0 0 4 0M12 4.4V3.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12C5 7 9 5 12 5s7 2 9.5 7c-2.5 5-6.5 7-9.5 7s-7-2-9.5-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6" />
    </>
  ),
  power: (
    <>
      <path d="M12 3.5v8" />
      <path d="M7.5 6.8a7 7 0 1 0 9 0" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3.2 3L7 15M13.5 15H17" />
    </>
  ),
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  chat: (
    <>
      <path d="M4 5h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
      <circle cx="9" cy="10" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  feather: (
    <>
      <path d="M20 5c-6 0-11 3-13 9-.7 2-.5 3.6-.5 4.5" />
      <path d="M6.5 18.5 18 7" />
      <path d="M9 16c1.5-3 4-5.6 8-6.6M7.6 13.6c1-2 2.6-3.6 4.6-4.6" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10.5h18M16 14.5h2" />
      <path d="M17 6V4a1 1 0 0 0-1.3-.95L5 6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15" r="1.3" />
    </>
  ),
  bolt: <path d="M13 3 5 13h6l-1 8 8-11h-6z" />,
  arrow: <path d="M7 17 17 7M9 7h8v8" />,
  check: <path d="M5 12l4 4L19 6" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />,
  sound: (
    <>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" />
    </>
  ),
};

export function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {P[name]}
    </svg>
  );
}

export type { IconName };
