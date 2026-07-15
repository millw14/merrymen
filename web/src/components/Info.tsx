/**
 * A tiny "?" that reveals a plain-English explanation on hover or focus.
 * Pure CSS (see .info in globals.css) — no JS, keyboard-accessible via tabIndex.
 * Use it to demystify a jargon word inline: <Info>Plain sentence.</Info>
 */
export function Info({ children }: { children: React.ReactNode }) {
  return (
    <span className="info" tabIndex={0} role="note" aria-label="What is this?">
      ?<span className="info-pop">{children}</span>
    </span>
  );
}
