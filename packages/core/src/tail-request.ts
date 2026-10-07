/**
 * "TAIL UNIPCS FOR THE NEXT 3 HOURS": WHO, AND FOR HOW LONG, READ BY CODE.
 *
 * A tail is the owner asking to be told what one Fomo trader does for a few
 * hours (docs/fomo.md "Tailing a trader"). This reads that request from her
 * words, with no model: the trader's handle as she wrote it, and the hours.
 * Nothing else in the line counts: "and if you like it, take it" grants
 * nothing, because whether anything is ever bought is the follow path's own
 * decision, offered separately on the confirm card (telegram/service.ts).
 *
 * NEVER A TAIL. "copy", "copytrade", "mirror" and "follow" a trader stay what
 * they were (orders the DM's own gates refuse or route), and "watch PONS on
 * fomo" stays a coin watch. Only tail, track, monitor and keep tabs / an eye
 * on, beside a trader, start one; stop, end, cancel or quit tailing, and
 * untail, end one. A coin ("track $PONS", "track PONS") or a thing of hers
 * ("track my order", "stop monitoring the price") is never a trader.
 *
 * WHAT THIS IS FOR. The owner's DM (service.ts handle(): her words become the
 * /tail or /untail they mean), and the group handler for an addressed line
 * (tg-groups/handler.ts: the owner's line goes to her DM as a confirm card,
 * anyone else's gets the owner-only line). Parsing starts nothing: a tail is
 * created only when she presses a button on the card in her own DM.
 */

/** The longest tail the store accepts (worker fomo/store.ts FOMO_LIMITS.tailMaxMs), and the default. */
export const TAIL_MAX_HOURS = 12;
export const TAIL_DEFAULT_HOURS = 3;

/**
 * A tail asked for in words. `clamped`: more than TAIL_MAX_HOURS was asked
 * for, and `hours` is the most there is. A stop's `handle` null means every
 * tail ("untail all", or a stop that names nobody).
 */
export type TailRequest =
  | { kind: "start"; handle: string; hours: number; clamped: boolean }
  | { kind: "stop"; handle: string | null };

const HANDLE = /^[A-Za-z0-9_]{2,30}$/;
/** Words that sit where a trader's name would and are never one. */
const NOT_A_HANDLE: ReadonlySet<string> = new Set([
  "it", "him", "her", "them", "this", "that", "these", "those", "the", "a", "an", "me", "my", "our", "your", "his", "their",
  "trades", "trade", "trader", "traders", "buys", "sells", "moves", "activity", "risk", "end", "fomo", "on", "for", "top", "best",
  "everyone", "someone", "anyone", "whales", "whale", "guy", "dude", "bro", "please", "pls", "all", "tails", "tail", "tailing",
  "next", "few", "couple", "hours", "hour", "today", "and", "of", "to", "with", "you", "u", "can", "could", "would",
  "price", "chart", "coin", "token", "market", "order", "orders", "position", "positions", "wallet", "pnl", "portfolio",
]);
/** These keep their old meaning; a line using them is never a tail. */
const NEVER_A_TAIL = /\b(?:copy|copying|copytrade|copy-trade|copytrading|mirror|mirroring|follow|following|follows)\b/iu;
const START_CUE = /\b(?:tail|tailing|track|tracking|monitor|monitoring|keep (?:an eye|tabs) on|keep tabs|watch (?:what|how) )\b/iu;
const STOP_CUE = /\b(?:stop|quit|end|cancel|drop)\s+(?:the\s+)?(?:tail(?:ing)?|track(?:ing)?|monitor(?:ing)?)\b|\buntail\b/iu;
/** "track my order", "stop monitoring the price": a thing of hers, not a person. */
const HER_THING =
  /\b(?:track(?:ing)?|monitor(?:ing)?|keep (?:an eye|tabs) on)\s+(?:my|the|our|this|that)\s+(?:order|orders|position|positions|price|chart|wallet|pnl|portfolio|bags?|coin|token)\b/iu;

function cleanHandle(raw: string | undefined, selfNames: readonly string[]): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.replace(/^@/, "").replace(/'s$/iu, "").replace(/[.,!?:;]+$/u, "");
  if (!HANDLE.test(h) || /^\d+$/.test(h)) return null;
  const low = h.toLowerCase();
  if (NOT_A_HANDLE.has(low)) return null;
  if (selfNames.some((s) => typeof s === "string" && s.replace(/^@/, "").toLowerCase() === low)) return null;
  return h;
}

/** The trader named in the line: an @handle, "trader X", "tail X", or "X's trades". */
function handleIn(text: string, selfNames: readonly string[]): string | null {
  const tries: RegExp[] = [
    /(?:^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{2,30})(?![\p{L}\p{N}_])/u,
    /\btrader\s+(?:named\s+|called\s+)?@?([A-Za-z0-9_]{2,30})\b/iu,
    /\b(?:tail|tailing|track|tracking|monitor|monitoring|untail)\s+(?:on\s+)?@?([A-Za-z0-9_]{2,30})(?:'s)?\b/iu,
    /\bkeep\s+(?:an\s+eye|tabs)\s+on\s+@?([A-Za-z0-9_]{2,30})(?:'s)?\b/iu,
    /\b@?([A-Za-z0-9_]{2,30})'s\s+(?:trades|buys|sells|moves|activity|wallet|plays)\b/iu,
  ];
  for (const re of tries) {
    const h = cleanHandle(re.exec(text)?.[1], selfNames);
    if (h) return h;
  }
  return null;
}

const SMALL: Record<string, number> = { an: 1, a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** The hours asked for, and whether more than the most was asked. Nothing said: the default. */
export function tailHoursIn(text: string): { hours: number; clamped: boolean } {
  const t = String(text ?? "").toLowerCase();
  let n: number | null = null;
  const h = /\b(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\b/u.exec(t);
  const m = /\b(\d{1,4})\s*(?:m|min|mins|minute|minutes)\b/u.exec(t);
  const w = /\b(an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:more\s+)?(?:hour|hours|hr|hrs)\b/u.exec(t);
  if (h) n = Number(h[1]);
  else if (m) n = Math.max(1, Math.ceil(Number(m[1]) / 60));
  else if (w) n = SMALL[w[1]!] ?? null;
  else if (/\bcouple (?:of )?(?:hours|hrs)\b/u.test(t)) n = 2;
  else if (/\b(?:a )?few (?:hours|hrs)\b/u.test(t)) n = 3;
  else if (/\b(?:rest of (?:the|my) day|all day|today|tonight)\b/u.test(t)) n = TAIL_MAX_HOURS;
  if (n === null || !Number.isFinite(n) || n < 1) return { hours: TAIL_DEFAULT_HOURS, clamped: false };
  return n > TAIL_MAX_HOURS ? { hours: TAIL_MAX_HOURS, clamped: true } : { hours: Math.floor(n), clamped: false };
}

/**
 * A tail asked for in words, or null. Null for anything that is not clearly
 * one (no cue, no trader, a copy/mirror/follow ask, a coin watch, a thing of
 * hers). `selfNames`: the agent's own names and @username, never a trader.
 */
export function parseTailRequest(text: unknown, selfNames: readonly string[] = []): TailRequest | null {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC").replace(/[‘’]/g, "'").trim();
  if (!t || t.length > 400) return null;
  if (NEVER_A_TAIL.test(t)) return null;
  if (HER_THING.test(t)) return null;
  if (STOP_CUE.test(t)) {
    const all = /\b(?:all|every|everyone|everything)\b/iu.test(t);
    return { kind: "stop", handle: all ? null : handleIn(t, selfNames) };
  }
  if (!START_CUE.test(t)) return null;
  // "track PONS", "monitor $PONS": a coin, not a trader.
  if (/\$[A-Za-z]/u.test(t) || /\b(?:track|monitor|watch)\s+[A-Z0-9]{2,10}\b(?!')/u.test(t)) return null;
  const handle = handleIn(t, selfNames);
  if (!handle) return null;
  const { hours, clamped } = tailHoursIn(t);
  return { kind: "start", handle, hours, clamped };
}

/**
 * Her tail line also asks me to take the trade ("if you like it, take it").
 * That grants nothing: the confirm card only says a tail never skips my
 * normal review (telegram/fomo-tail.ts).
 */
export function tailAsksToTake(text: unknown): boolean {
  return typeof text === "string" && /\b(?:take|buy|ape|enter|grab)\s+(?:it|them|that|in|the trade|the position|a position)\b|\bget in\b/iu.test(text);
}

/**
 * "/tail NAME [hours]": the command's argument. Null: show the usage. A bare
 * number is hours ("/tail unipcs 2"); anything after the name must say a
 * time ("2h", "90 minutes", "a few hours").
 */
export function parseTailArgs(arg: unknown, selfNames: readonly string[] = []): { handle: string; hours: number; clamped: boolean } | null {
  if (typeof arg !== "string") return null;
  const parts = arg.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  const handle = cleanHandle(parts[0], selfNames);
  if (!handle) return null;
  const rest = parts.slice(1).join(" ");
  if (!rest) return { handle, hours: TAIL_DEFAULT_HOURS, clamped: false };
  const bare = /^(\d{1,3})$/u.exec(rest);
  const asked = bare ? tailHoursIn(`${bare[1]}h`) : tailHoursIn(rest);
  if (!bare && !/\d|hour|hr|min|day|few|couple/iu.test(rest)) return null;
  return { handle, ...asked };
}
