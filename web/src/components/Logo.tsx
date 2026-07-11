/**
 * The merrymen mark — a feather that is also an arrow, loosed up-and-right.
 * Vector recreation of the brand logo (black quill, white shaft, lime head).
 *
 * The feather inherits `currentColor` so it stays visible on the dark theme;
 * the lime head is the brand accent. Drop-in replacement for the old ➳ glyph.
 */

export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-0.15em" }}
    >
      <g transform="rotate(45 50 50)">
        {/* lime head the arrow pierces into */}
        <rect x="35" y="0" width="30" height="36" rx="15" fill="#a5ce1f" />
        {/* the feather, outlined in the page background so it separates from the lime */}
        <path
          d="M50 20 C67 28 71 52 62 69 C58 77 54 85 50 96 C46 85 42 77 38 69 C29 52 33 28 50 20 Z"
          fill="currentColor"
          stroke="var(--bg, #ffffff)"
          strokeWidth="4"
        />
        {/* the shaft cutting through the feather */}
        <path d="M50 92 L50 26" stroke="var(--bg, #ffffff)" strokeWidth="4.5" strokeLinecap="round" />
        {/* arrowhead breaking out into the lime */}
        <path d="M50 3 L59 19 L50 14 L41 19 Z" fill="currentColor" />
        {/* fletching cuts */}
        <path d="M50 83 L61 72" stroke="var(--bg, #ffffff)" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M50 74 L60 64" stroke="var(--bg, #ffffff)" strokeWidth="3.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}
