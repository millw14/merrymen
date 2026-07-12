/** The merrymen mark — a feather that is also an arrow, loosed into a lime head.
 * Original brand mark, reused across the product and this site. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <g transform="rotate(45 50 50)">
        <rect x="35" y="0" width="30" height="36" rx="15" fill="#a5ce1f" />
        <path
          d="M50 20 C67 28 71 52 62 69 C58 77 54 85 50 96 C46 85 42 77 38 69 C29 52 33 28 50 20 Z"
          fill="#e9efe9"
          stroke="#0a0d0b"
          strokeWidth="4"
        />
        <path d="M50 92 L50 26" stroke="#0a0d0b" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M50 3 L59 19 L50 14 L41 19 Z" fill="#e9efe9" />
        <path d="M50 83 L61 72" stroke="#0a0d0b" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M50 74 L60 64" stroke="#0a0d0b" strokeWidth="3.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}
