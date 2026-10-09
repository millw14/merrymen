/**
 * A COIN'S THESES, QUOTED IN A ROOM (docs/tg-groups.md rule 3 as amended by
 * Milla on 2026-10-09; docs/fomo.md "Telegram groups").
 *
 * Only on an explicit ask ("list the last 10", "show me these theses, don't
 * summarise", "what did they say exactly"): the port (tg-fomo-port.ts
 * thesesQuotes) hands over the newest up to ten of one coin's theses,
 * cleaned, cut and pre-checked; this file says them. The default answer to
 * "what are people saying" is still the code digest.
 *
 * EVERY QUOTE IS GATED AGAIN, as the `quote` kind (gate.ts: every common
 * clause plus the third-party ones), with the coin's collapse permit for the
 * bare "rug" of a stranger's fear and no Merrymen brag. A refused quote is
 * DROPPED, never repaired, and counted: the room hears how many were left
 * out, and that these are their words, not facts. The header and the closing
 * line are code's own, gated as `research`.
 *
 * Pure: no I/O, no clock, no model.
 */
import { admitTgLine } from "./gate";
import type { TgThesesQuotes } from "./types";

/** The most quotes a room hears, the most lines the answer runs to, and its length (Telegram allows 4,096). */
export const QUOTES_MAX = 10;
export const QUOTES_MAX_LINES = 13;
export const QUOTES_MAX_CHARS = 2_400;

/** The closing words, always said: a quote is a claim, never a fact. */
export const QUOTES_TAIL = "Their words, not facts";

/** "• kaleo, 2h ago: “…”": one quote as the room hears it (tg-fomo-port.ts quoteLine says the same). */
export function quoteLineOf(q: { who: string; age: string; text: string }): string {
  return `• ${q.who}${q.age ? `, ${q.age}` : ""}: “${q.text}”`;
}

/**
 * What the room hears for a quote ask, or null when not even the header is
 * sayable (the caller then says the digest). `quoted` counts the quotes said;
 * with none, `text` is the honest line that none could be, and the caller
 * says the digest after it. `ageLine` is the copy's age (fomo/render.ts), last.
 */
export function quotesSayable(m: TgThesesQuotes, ageLine: string | null, agentName: string): { text: string; quoted: number; leftOut: number } | null {
  if (!m || !Array.isArray(m.quotes)) return null;
  const research = (l: string): string | null => {
    const v = admitTgLine(l, { agentName, kind: "research", recentOwn: [] });
    return v.ok ? v.text : null;
  };
  const n = Math.max(0, Math.min(QUOTES_MAX, Math.floor(m.n)));
  const coin = m.coin || "this coin";
  const where = m.where ? ` on ${m.where}` : "";
  if (n === 0) return null;
  const head = research(
    m.asked > QUOTES_MAX
      ? `The newest ${QUOTES_MAX} theses on ${coin}${where} (${QUOTES_MAX} is the most I quote in a group), in their words (not facts):`
      : `The newest ${n} theses on ${coin}${where}, in their words (not facts):`,
  );
  if (!head) return null;
  const age = ageLine ? research(ageLine) : null;
  // Each quote judged again, as a stranger's words, by the room's gate.
  let leftOut = Math.max(0, n - Math.min(m.quotes.length, QUOTES_MAX));
  const admitted: string[] = [];
  for (const q of m.quotes.slice(0, QUOTES_MAX)) {
    const v = admitTgLine(quoteLineOf(q), { agentName, kind: "quote", recentOwn: [], rug: { coins: [coin], brag: false } });
    if (v.ok && !v.text.includes("\n")) admitted.push(v.text);
    else leftOut += 1;
  }
  const tailOf = (out: number, total: boolean): string =>
    `${QUOTES_TAIL}${out > 0 ? `; ${out} of these ${n} left out` : ""}${total && typeof m.total === "number" && m.total > n ? `; Fomo lists ${m.total.toLocaleString("en-US")}` : ""}.`;
  // Room for the frame first (the longest tail it could need), then quotes in order while they fit.
  const frame = [head, tailOf(n, true), ...(age ? [age] : [])];
  let lines = QUOTES_MAX_LINES - frame.length;
  let chars = QUOTES_MAX_CHARS - frame.reduce((t, l) => t + l.length + 1, 0);
  const kept: string[] = [];
  for (const l of admitted) {
    if (lines <= 0 || l.length + 1 > chars) {
      leftOut += 1;
      continue;
    }
    kept.push(l);
    lines -= 1;
    chars -= l.length + 1;
  }
  if (kept.length === 0) {
    const none = research(`None of the newest ${n} theses on ${coin}${where} can be quoted here (${n} left out).`);
    return none ? { text: none, quoted: 0, leftOut: n } : null;
  }
  // "Their words, not facts" is always said: without the total when that would not pass.
  const tail = research(tailOf(leftOut, true)) ?? research(tailOf(leftOut, false)) ?? `${QUOTES_TAIL}.`;
  return { text: [head, ...kept, tail, ...(age ? [age] : [])].join("\n"), quoted: kept.length, leftOut };
}
