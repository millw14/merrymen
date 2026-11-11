/**
 * THE merrymen MARK: the pill mark from the terminal redesign (2026-09-05).
 * This is the only place it is drawn in the web app.
 *
 * The terminal re-exports it from `@/terminal/ui`, where it lived first, so
 * its tab bar, top bar and desktop rail render this same component. The
 * favicon, the PWA icons and `logo.svg` are drawn from `site/public/favicon.svg`
 * by `scripts/pwa-icons.mjs`, and `Logo.test.ts` pins that file's pills to the
 * ones below. Change one and the test makes you change the other.
 *
 * Kept free of hooks and client imports, so a server component can render it
 * too. The fill is `currentColor`: it takes whatever colour its container sets.
 * `size` is the height. The mark is 940:630, so it is about 1.5 times as wide.
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  const w = Math.round(size * (940 / 630));
  return (
    <svg
      className="logo-mark"
      width={w}
      height={size}
      viewBox="0 0 940 630"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="280" y="1" width="324" height="47" rx="23.5" />
      <rect x="403" y="72" width="258" height="49" rx="24.5" />
      <rect x="138" y="137" width="51" height="54" rx="25.5" />
      <rect x="473" y="137" width="227" height="54" rx="27" />
      <rect x="742" y="137" width="50" height="54" rx="25" />
      <rect x="64" y="212" width="199" height="48" rx="24" />
      <rect x="516" y="212" width="204" height="48" rx="24" />
      <rect x="766" y="212" width="109" height="48" rx="24" />
      <rect x="0" y="288" width="126" height="48" rx="24" />
      <rect x="161" y="288" width="582" height="48" rx="24" />
      <rect x="812" y="288" width="128" height="48" rx="24" />
      <rect x="64" y="366" width="199" height="47" rx="23.5" />
      <rect x="518" y="366" width="202" height="47" rx="23.5" />
      <rect x="766" y="366" width="109" height="47" rx="23.5" />
      <rect x="138" y="436" width="51" height="48" rx="24" />
      <rect x="473" y="436" width="227" height="48" rx="24" />
      <rect x="742" y="436" width="51" height="48" rx="24" />
      <rect x="403" y="510" width="259" height="48" rx="24" />
      <rect x="280" y="582" width="324" height="47" rx="23.5" />
    </svg>
  );
}
