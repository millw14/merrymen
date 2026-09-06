/**
 * A tiny "i" that reveals a plain-English explanation on hover or focus.
 * Pure CSS — no JS, keyboard-accessible via tabIndex. The hiding is done
 * entirely by the stylesheet the SCREEN loads (terminal.css, under
 * .terminal-host), so a screen without those rules does not lose the tooltip,
 * it PRINTS it. info.test.ts pins that every use is covered.
 * Use it to demystify a jargon word inline: <Info>Plain sentence.</Info>
 *
 * AN "i", NOT A "?". A question mark asks the reader something; an information
 * mark offers them something. On a screen full of numbers somebody has just
 * bet money on, the difference is not decorative.
 */
export function Info({ children }: { children: React.ReactNode }) {
  return (
    <span className="info" tabIndex={0} role="note" aria-label="What does this mean?">
      i<span className="info-pop">{children}</span>
    </span>
  );
}
