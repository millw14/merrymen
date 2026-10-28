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
 * untail, end one. A coin ("track $PONS", "track PONS", "stop tracking
 * $PONS", an address) or a thing of hers ("track my order", "stop monitoring
 * the price") is never a trader, for a stop as for a start.
 *
 * A STOP IS AS NARROW AS A START. Stopping every tail at once is never a
 * guess: it is "untail all", "stop tailing everyone", or a stop that says a
 * tail word and nothing else ("stop tailing", "untail", "ok stop tailing for
 * now"). A stop with a tail word that points at someone it does not name
 * ("stop tailing him", "the second one") is "stop-which": she is shown her
 * tails and asked which, and nothing stops. "stop tracking" or "stop
 * monitoring" with no tail word and nobody named ("stop tracking it", "stop
 * monitoring the cpu", "ok stop tracking for now") is not about tails at all
 * and goes on as before (a coin unwatch, a question). A negated stop ("don't
 * stop tailing unipcs") or a question about one ("when will you stop tailing
 * unipcs?") stops nothing; "can you stop tailing unipcs?" is a stop.
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
 * tail ("untail all", "stop tailing everyone", or a bare "stop tailing").
 * "stop-which": a stop that points at someone it does not name ("stop tailing
 * him"); nothing is stopped, and she is asked which (her /tails list).
 */
export type TailRequest =
  | { kind: "start"; handle: string; hours: number; clamped: boolean }
  | { kind: "stop"; handle: string | null }
  | { kind: "stop-which" };

const HANDLE = /^[A-Za-z0-9_]{2,30}$/;
/** Words that sit where a trader's name would and are never one. */
const NOT_A_HANDLE: ReadonlySet<string> = new Set([
  "it", "him", "her", "them", "this", "that", "these", "those", "the", "a", "an", "me", "my", "our", "your", "his", "their",
  "trades", "trade", "trader", "traders", "buys", "sells", "moves", "activity", "risk", "end", "fomo", "on", "for", "top", "best",
  "everyone", "everybody", "everything", "anything", "something", "nothing", "someone", "anyone", "whales", "whale", "guy", "dude", "bro", "please", "pls", "all", "tails", "tail", "tailing",
  "next", "few", "couple", "hours", "hour", "today", "and", "of", "to", "with", "you", "u", "can", "could", "would",
  "price", "chart", "coin", "token", "market", "order", "orders", "position", "positions", "wallet", "pnl", "portfolio",
  // "tail what unipcs buys", "monitor how unipcs trades", "track every move
  // unipcs makes": the word after the cue is not the trader, and a line this
  // reader cannot place goes on as before rather than tailing "what".
  "what", "whatever", "how", "who", "whom", "whose", "when", "where", "why", "which", "every", "each", "any",
]);
/** These keep their old meaning; a line using them is never a tail. */
const NEVER_A_TAIL = /\b(?:copy|copying|copytrade|copy-trade|copytrading|mirror|mirroring|follow|following|follows)\b/iu;
const START_CUE = /\b(?:tail|tailing|track|tracking|monitor|monitoring|keep (?:an eye|tabs) on|keep tabs|watch (?:what|how) )\b/iu;
const STOP_CUE = /\b(?:stop|quit|end|cancel|drop)\s+(?:the\s+|all\s+(?:the\s+|my\s+)?|my\s+)?(?:tails?|tailing|track(?:ing)?|monitor(?:ing)?)\b|\buntail\b/iu;
/** A word about tails themselves. A stop without one ("stop tracking …") is about tails only when it names a trader or everyone. */
const TAIL_WORD = /\b(?:untail|tail|tails|tailing)\b/iu;
/**
 * "don't stop tailing unipcs", "never stop tracking him", "keep tailing, no
 * need to end it": not a stop. Inside one clause (a comma ends it), so "not
 * now, stop tailing unipcs" still is one.
 */
const NEGATED_STOP = /\b(?:don'?t|do\s+not|never|not|no\s+need\s+to|keep)\b[^.!?\n,;]{0,20}\b(?:stop|quit|end|cancel|drop|untail)\b/iu;
/** "when will you stop tailing unipcs?": a question about a tail, not a stop. "can you stop tailing unipcs?" is a stop. */
const STOP_QUESTION = /\b(?:when|why|how\s+long|what\s+time|until\s+when|are\s+you\s+going\s+to|will\s+you\s+ever)\b[^.!?\n]{0,30}\b(?:stop|quit|end|cancel|drop|untail)\b/iu;
/**
 * A coin in the line: "$PONS", a contract address, or a ticker in capitals
 * right after track / monitor / watch / keep an eye on. A coin is never a
 * trader, for a stop as for a start.
 */
function coinIn(t: string): boolean {
  return (
    /\$[A-Za-z]/u.test(t) ||
    /\b0x[0-9a-fA-F]{6,}/u.test(t) ||
    /\b(?:track|tracking|monitor|monitoring|watch|keep (?:an eye|tabs) on)\s+[A-Z0-9]{2,10}\b(?!')/u.test(t)
  );
}
/** Right after a stop cue: everyone ("all", "them all", "everyone", "all my tails"). */
const ALL_AFTER = /^[\s,]*(?:them\s+all|all(?:\s+of\s+them)?|every(?:one|body)|every\s+(?:trader|tail)|all\s+(?:the\s+|my\s+)?(?:traders|tails))\b/iu;
/** Everyone, as people: what a stop with no tail word must say to mean every tail ("stop tracking everyone"). */
const ALL_PEOPLE_AFTER = /^[\s,]*(?:every(?:one|body)|every\s+trader|all\s+(?:the\s+|my\s+)?traders)\b/iu;
/** Right after a "stop tracking" with no tail word: a person she does not name ("him", "that guy"). */
const PERSON_AFTER = /^[\s,]*(?:him|her|(?:that|this|the)\s+(?:guy|dude|trader|account|person))\b/iu;
/** Words that say nothing about WHICH tail: a stop made only of these (and the bot's own names) means every tail. */
const FILLER: ReadonlySet<string> = new Set([
  "ok", "okay", "k", "kk", "hey", "yo", "so", "and", "just", "now", "right", "then", "already", "please", "pls", "plz",
  "thanks", "thank", "thx", "ty", "can", "could", "would", "will", "you", "u", "for", "the", "day", "today", "tonight",
  "on", "fomo", "anymore", "any", "more", "lol", "alright", "actually", "enough", "that's", "thats", "it's", "mate",
  "bro", "guys", "a", "while", "bit", "go", "ahead", "time", "is", "up", "done", "too", "as", "well",
]);
/** Nothing but filler and the bot's own names: "ok stop tailing for now", "hey shogun, can you untail?". */
function bare(words: string, selfNames: readonly string[]): boolean {
  const self = new Set(selfNames.filter((s) => typeof s === "string").map((s) => s.replace(/^@/, "").toLowerCase()));
  return (words.toLowerCase().match(/[a-z0-9_@']+/gu) ?? []).every((w) => {
    const x = w.replace(/^@/, "").replace(/^'+|'+$/gu, "");
    return x === "" || FILLER.has(x) || self.has(x);
  });
}
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

/**
 * The hours asked for, and whether more than the most was asked. Nothing
 * said: the default. A part hour rounds UP ("1.5 hours" is 2, "0.5h" is 1):
 * a tail never ends before the time she asked for. Days and weeks are more
 * than a tail can run, so they are the most there is, and `clamped` says so
 * (the card tells her), never a silent default.
 */
export function tailHoursIn(text: string): { hours: number; clamped: boolean } {
  const t = String(text ?? "").toLowerCase();
  let n: number | null = null;
  // Never the "5" of "1.5h", nor a digit inside a word: no digit, letter or dot just before.
  const d = /(?<![\w.])\d{1,3}(?:\.\d+)?\s*(?:d|day|days|w|wk|wks|week|weeks)\b|\b(?:a|one)\s+(?:whole\s+|full\s+)?(?:day|week)\b/u.exec(t);
  const h = /(?<![\w.])(\d{1,3}(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/u.exec(t);
  const m = /(?<![\w.])(\d{1,4}(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/u.exec(t);
  const w = /\b(an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:more\s+)?(?:hour|hours|hr|hrs)(\s+and\s+a\s+half)?\b/u.exec(t);
  if (d) n = TAIL_MAX_HOURS + 1;
  else if (h) n = Math.ceil(Number(h[1]));
  else if (m) n = Math.max(1, Math.ceil(Number(m[1]) / 60));
  else if (w) n = (SMALL[w[1]!] ?? Number.NaN) + (w[2] ? 1 : 0);
  else if (/\bcouple (?:of )?(?:hours|hrs)\b/u.test(t)) n = 2;
  else if (/\b(?:a )?few (?:hours|hrs)\b/u.test(t)) n = 3;
  else if (/\b(?:rest of (?:the|my) day|all day|today|tonight)\b/u.test(t)) n = TAIL_MAX_HOURS;
  if (n === null || !Number.isFinite(n) || n < 1) return { hours: TAIL_DEFAULT_HOURS, clamped: false };
  return n > TAIL_MAX_HOURS ? { hours: TAIL_MAX_HOURS, clamped: true } : { hours: Math.floor(n), clamped: false };
}

/**
 * A STOP, read as narrowly as a start (the module's "A STOP IS AS NARROW AS
 * A START"). In this order:
 *
 *   negated or a question   null ("don't stop tailing unipcs", "when will
 *                           you stop tailing unipcs?")
 *   a coin                  null: "stop tracking $PONS" is the coin unwatch
 *                           it always was, never a tail stop
 *   a trader named          that trader
 *   everyone                every tail; without a tail word only people
 *                           count ("stop tracking everyone", not "… all")
 *   no tail word            null ("stop tracking it", "ok stop tracking for
 *                           now", "stop monitoring the cpu": not about tails),
 *                           or "stop-which" when it points at a person ("stop
 *                           tracking him")
 *   a tail word, bare       every tail ("stop tailing", "untail", "ok stop
 *                           tailing for now")
 *   a tail word, and more   "stop-which" ("stop tailing him", "stop tailing
 *                           the second one", "untail that guy"): nothing
 *                           stops, and she is asked which
 */
function stopIn(t: string, cue: RegExpExecArray, selfNames: readonly string[]): TailRequest | null {
  if (NEGATED_STOP.test(t) || STOP_QUESTION.test(t)) return null;
  if (coinIn(t)) return null;
  const tailWord = TAIL_WORD.test(t);
  const before = t.slice(0, cue.index);
  const after = t.slice(cue.index + cue[0].length);
  const handle = handleIn(t, selfNames);
  if (handle) return { kind: "stop", handle };
  const cueAll = /\ball\b/iu.test(cue[0]);
  if (tailWord ? cueAll || ALL_AFTER.test(after) : ALL_PEOPLE_AFTER.test(after)) return { kind: "stop", handle: null };
  if (!tailWord) return PERSON_AFTER.test(after) ? { kind: "stop-which" } : null;
  return bare(before, selfNames) && bare(after, selfNames) ? { kind: "stop", handle: null } : { kind: "stop-which" };
}

/** Whether a line says a tail word ("tail", "tailing", "untail"): a stop that does is about tails whatever else it says. */
export function saysTail(text: unknown): boolean {
  return typeof text === "string" && TAIL_WORD.test(text);
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
  const stop = STOP_CUE.exec(t);
  if (stop) return stopIn(t, stop, selfNames);
  if (!START_CUE.test(t)) return null;
  // "track PONS", "monitor $PONS", "keep an eye on PONS": a coin, not a trader.
  if (coinIn(t)) return null;
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
  if (!bare && !/\d|hour|hr|min|day|week|few|couple/iu.test(rest)) return null;
  return { handle, ...asked };
}
