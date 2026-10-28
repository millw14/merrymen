import { withoutFiguresLine } from "./figures";
import type { XPostKind } from "./store";

/** Only timeline posts may teach the writer its voice. Replies carry somebody else's context. */
export const TIMELINE_KINDS: readonly XPostKind[] = ["buy", "sell", "recap", "casual"];
export interface TimelinePost { body: string; kind: XPostKind }

/** Strip code's disclosures, sale result and figures before admitting words to a prompt. */
export function timelineWords(body: string): string | null {
  const words = withoutFiguresLine(String(body).split(/\r?\n/)[0] ?? "").trim();
  if (!words || /\p{N}|https?:|www\.|@|«|»/iu.test(words)) return null;
  return words;
}

export function timelineMemory(posts: readonly TimelinePost[], accept: (body: string) => boolean = () => true): string[] {
  return posts.filter((p) => TIMELINE_KINDS.includes(p.kind)).map((p) => timelineWords(p.body))
    .filter((p): p is string => p !== null && accept(p)).slice(0, 10);
}

const FILLER = new Set(["i", "im", "ive", "a", "an", "the", "and", "my", "that", "thats", "some", "of", "to", "on", "in", "its"]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A shape check, not a source of facts. Mask names before comparing the first two content words. */
export function openerKey(body: string, coins: readonly string[] = []): string | null {
  let text = (timelineWords(body) ?? "").toLowerCase().replace(/[’']/g, "");
  for (const coin of [...coins].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`\\b${escape(coin.toLowerCase().replace(/[’']/g, ""))}\\b`, "g"), " coin ");
  }
  text = text.replace(/\$[a-z]+\b/g, " coin ").trim();
  // Historical rows need no private token metadata: the noun beside a verified sale verb is its label.
  text = text.replace(/\bsold\s+(?:some\s+)?(?!on\b|and\b|with\b|for\b|back\b)([a-z]+)\b/g, "sold coin")
    .replace(/(^|[,:;.!?]\s*)(?:[a-z]+\s+){1,6}sold\b/g, "$1sold coin");
  text = text.replace(/\b(bought|grabbed|picked up)\s+(?:some\s+)?(?!on\b|and\b|with\b|for\b|back\b)([a-z]+)\b/g, "$1 coin");
  const words = (text.match(/[a-z]+/g) ?? []).filter((w) => !FILLER.has(w));
  return words.length >= 2 ? words.slice(0, 2).join(" ") : null;
}
