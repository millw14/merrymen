/**
 * THE CONVERSATION'S RULES, OUT OF THE SCREEN AND WHERE A TEST CAN RUN THEM.
 *
 * The chat is a thread of messages now (account.ts ChatMessage), kept by the
 * App-level controller (chat-controller.ts) and drawn by Agent.tsx. Everything
 * here is pure: what a receipt says, which of the agent's own fills join the
 * thread and how often, what the model is told was said, which chips to offer,
 * and how a failure is put in the agent's own voice.
 *
 * NOTHING HERE WRITES A SENTENCE ABOUT MONEY FROM A MODEL. A receipt and a
 * fill line are templated from ledger fields, and a field nobody read prints
 * nothing — never "$0.00", never a guessed coin.
 */
import { rejectRuleLabel } from "@merrymen/thesis";
import { usd } from "@/lib/format";
import type { OrderReceipt } from "@/lib/order-state";
import type { LlmFailureKind } from "../../../worker/src/llm-failure";
import type { ChatFailure, ChatMessage, ChatTurn } from "./account";
import type { Thesis } from "./live";

/** How many lines are kept. Two per exchange, so the same forty exchanges as before. */
export const MAX_MESSAGES = 80;

/** The shared wording for a coin nobody could name. Never a guess in its place. */
const UNLABELLED = "Token label unavailable";

const STATUS_WORD: Record<OrderReceipt["status"], string> = {
  filled: "Filled",
  refused: "Refused",
  failed: "Failed",
  expired: "Expired",
};

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * A RECEIPT'S TWO HALVES: the pill, and the line beside it.
 *
 * "[Buy] $5.00 CASHCAT · Filled". The size is printed only when the worker
 * read one; the coin is its symbol, else the address the ledger recorded,
 * else the product's words for not knowing. A refusal carries its rule in the
 * same words the public tape uses, so the two cannot describe one refusal two
 * ways — and an unrecognised rule is named rather than dropped.
 */
export function receiptParts(r: OrderReceipt): { side: "Buy" | "Sell" | null; line: string } {
  const coin = r.symbol ?? (r.token ? shortAddress(r.token) : UNLABELLED);
  const what = [r.usdgActual !== null ? usd(r.usdgActual) : null, coin].filter(Boolean).join(" ");
  const why = r.status === "refused" && r.rejectRule ? ` — ${rejectRuleLabel(r.rejectRule) ?? r.rejectRule}` : "";
  return {
    side: r.side === "buy" ? "Buy" : r.side === "sell" ? "Sell" : null,
    line: `${what} · ${STATUS_WORD[r.status]}${why}`,
  };
}

/** The whole receipt as one line — for the model's history and for assistive tech. */
export function receiptText(r: OrderReceipt): string {
  const p = receiptParts(r);
  return `${p.side ? `[${p.side}] ` : ""}${p.line}`;
}

/** The same template for one of the agent's own fills, read off the tape. */
export function fillParts(m: Thesis): { side: "buy" | "sell" | null; line: string } {
  const what = [m.sizeUsdg !== null && Number.isFinite(m.sizeUsdg) ? usd(m.sizeUsdg) : null, m.symbol ?? UNLABELLED]
    .filter(Boolean)
    .join(" ");
  return {
    side: m.action === "buy" || m.action === "sell" ? m.action : null,
    line: `${what} · Filled${m.paper ? " on paper" : ""}`,
  };
}

/**
 * The chain hash an owner's tape row carries (live.ts mineOf maps
 * t.tx_hash onto it), lower-cased, or null when it carries none. Read off the
 * row rather than off the type, so this reads the field before and after the
 * tape learns it.
 */
function txOf(m: Thesis): string | null {
  const tx = (m as { txHash?: unknown }).txHash;
  return typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx.toLowerCase() : null;
}

/** The ledger fields that make a row one row — the key before a row had a hash. */
function fieldKeyOf(m: Thesis): string | null {
  if (m.at == null || (m.action !== "buy" && m.action !== "sell")) return null;
  return `t:${m.at}:${m.action}:${(m.symbol ?? "").toUpperCase()}:${m.sizeUsdg ?? ""}:${m.paper ? "p" : "l"}`;
}

/**
 * WHICH TRADE THIS IS, so the thread can hold it exactly once.
 *
 * The chain hash when the tape carries one. Otherwise the fields that make a
 * ledger row one row — its time, side, coin, size and book — none of which
 * move between refreshes of the same tape. Null for anything that is not a
 * buy or a sell with a time: a hold is not a fill.
 */
export function tradeKeyOf(m: Thesis): string | null {
  const tx = txOf(m);
  return tx ? `tx:${tx}` : fieldKeyOf(m);
}

/**
 * THE OWNER'S TAPE AS THE THREAD MAY SEE IT — or null when it was not READ.
 *
 * Never an empty stand-in. The first tape the thread sees sets its watermark
 * (everything on it is history); an empty array handed over for a read that
 * failed would set that watermark to nothing, and the next read that worked
 * would pour every fill on the tape into the conversation as news. With no
 * agent there is no tape at all, whatever a read returned.
 */
export function chatTape(o: { agentExists: boolean | undefined; read: string | undefined; moves: Thesis[] | null | undefined }): Thesis[] | null {
  return o.agentExists === true && o.read === "ok" && Array.isArray(o.moves) ? o.moves : null;
}

/** The newest trade time on a tape — the watermark a first look starts from. */
export function newestAt(moves: Thesis[]): number {
  return moves.reduce((max, m) => (typeof m.at === "number" && m.at > max ? m.at : max), 0);
}

/**
 * A LANDED BUY OR SELL, FOR REAL MONEY.
 *
 * NOT A PAPER ONE. The tape books a paper trade as "landed" (live.ts
 * tradeOutcome), and the thread took that as a fill: "Filled on paper" on a
 * surface that reads as money, an unread dot for every practice trade, and a
 * paper agent trading every tick turned the conversation into a trade log.
 * The worker's receipt refuses to call a paper trade "filled" for the same
 * reason, and a paper fill is not announced anywhere else either.
 */
const isFill = (m: Thesis) =>
  m.outcome === "landed" && !m.paper && (m.action === "buy" || m.action === "sell") && typeof m.at === "number";

/**
 * How far a buy's fill may be from its answer, either side, when its size
 * agrees and the order's life is only known on this browser's clock — and
 * how far back a fill may be when the placing line was not kept at all.
 */
const SAME_TRADE_MS = 30 * 60_000;

/**
 * How far the order's life may be missed by, for a join by time: two servers'
 * clocks, and the trip the placement's answer took back.
 */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * WHEN THE ORDER A RECEIPT ANSWERS WAS ALIVE, on the LEDGER's clock where the
 * thread can tell — or null for an answer with no time at all.
 *
 * A LINE'S `at` IS THIS BROWSER'S CLOCK AND A FILL'S IS THE WORKER'S. Held one
 * against the other with two minutes of slack, a browser three minutes off
 * made one chat trade two "Filled" lines, and order-follow.ts has seen a
 * browser eleven minutes fast. So the placing line keeps the SERVER's own
 * placement time (POST's expiresAt less expiresInMs, one `now` on the
 * server), and the gap between that and the line's own `at` is this browser's
 * offset — measured to within the reply's trip back. The order's life is then
 * from the server's placement to the answer's moment moved by that offset:
 * both on the server's clock, whatever this browser's says.
 *
 * `anchored` is false when the placing line has no server time — a thread kept
 * from before it did, or an order found after its placing was lost. The life
 * is then this browser's own reading of it, or half an hour before the answer
 * when nobody kept the placing either.
 */
interface OrderLife {
  from: number;
  to: number;
  anchored: boolean;
}

function lifeOf(messages: ChatMessage[], line: ChatMessage): OrderLife | null {
  if (line.at === null) return null;
  const id = line.order?.id;
  const placing = id ? messages.find((m) => m !== line && m.order?.id === id && !m.order.receipt && m.at !== null) : undefined;
  const server = placing?.order?.serverPlacedAt;
  if (placing && typeof server === "number" && Number.isFinite(server)) {
    return { from: server, to: line.at + (server - placing.at!), anchored: true };
  }
  return { from: placing?.at ?? line.at - SAME_TRADE_MS, to: line.at, anchored: false };
}

/** How far a fill is from the answer that describes it, on the clock the life is read on. */
const gap = (life: OrderLife | null, fill: Thesis) => (life === null ? 0 : Math.abs(fill.at! * 1000 - life.to));

/**
 * IS THIS FILL THE TRADE THAT CHAT ORDER'S RECEIPT DESCRIBES?
 *
 * THE CHAIN HASH DECIDES when both sides carry one, and nothing else does.
 *
 * Otherwise side and coin must agree, and so must a BUY's size: what was
 * spent is one figure on both sides, so two buys of one coin at different
 * sizes are two trades. A SELL'S SIZE IS NOT: the tape carries the order's
 * size (amount_usdg), the receipt the cash the fill returned — or nothing,
 * when its cost was booked from the quote — and a stock sell clamps to the
 * position while a curve sell exits it whole. Two measurements of different
 * things; demanding they agree to the cent made every chat sell two "Filled"
 * lines. So a sell is matched on side, coin and TIME, and the time is the
 * order's own life (lifeOf): after it was placed and before it was answered,
 * give or take CLOCK_SKEW_MS. The agent's own earlier or later sell of the
 * same coin is therefore never taken for it.
 *
 * A BUY WHOSE SIZE AGREES, with its order's life known only on this browser's
 * clock, keeps the half hour either side of its answer it always had: its
 * size is what tells it apart, and a browser minutes off must not split it.
 */
function sameTrade(message: ChatMessage, fill: Thesis, life: OrderLife | null): boolean {
  const r = message.order?.receipt;
  if (!r || r.status !== "filled" || message.tradeKey) return false;
  if (r.side !== fill.action) return false;
  if (!r.symbol || !fill.symbol || r.symbol.toUpperCase() !== fill.symbol.toUpperCase()) return false;
  const tx = txOf(fill);
  if (r.txHash && tx) return r.txHash.toLowerCase() === tx;
  const sized = r.side === "buy" && r.usdgActual !== null && fill.sizeUsdg !== null;
  if (sized && Math.abs(r.usdgActual! - fill.sizeUsdg!) >= 0.005) return false;
  if (life === null) return true;
  const at = fill.at! * 1000;
  if (sized && !life.anchored) return Math.abs(at - life.to) <= SAME_TRADE_MS;
  return at >= life.from - CLOCK_SKEW_MS && at <= life.to + CLOCK_SKEW_MS;
}

/** A receipt that said "filled" and has not been joined to its fill yet. */
const awaitsFill = (m: ChatMessage) => m.order?.receipt?.status === "filled" && !m.tradeKey;

/**
 * THE AGENT'S OWN FILLS, JOINED INTO THE THREAD BY TRADE.
 *
 * The agent trades when nobody is talking to it, and until now none of that
 * reached the conversation: an owner asked "did you buy anything?" of a chat
 * that had never shown them a fill. Every landed buy or sell NEWER than
 * `since` (epoch seconds, the tape's clock) becomes one `event` line — once,
 * because the next refresh brings the same tape and the key is already there.
 * Nothing older is dumped in: `since` starts at the newest trade the thread
 * first saw.
 *
 * A chat order's fill is not a second line. Its receipt already said "Filled";
 * the tape's row is joined to it instead, which gives the receipt its card —
 * each receipt to the matching fill nearest its answer (sameTrade).
 *
 * A line keyed before the tape carried its trade's hash keeps its place: the
 * row's old key is read as its new one, so the hash arriving does not bring
 * the trade back as news.
 *
 * `trade` is never stored — only the key — so a reloaded thread gets its cards
 * back here from whatever the tape still holds, however old.
 *
 * Returns the SAME array when nothing changed, so a caller can tell. It does
 * NOT trim: a line trimmed here would be forgotten without moving the
 * watermark past it, and the next refresh would bring it back — capThread
 * does the trimming, for every change to the thread.
 */
export function mergeFills(messages: ChatMessage[], moves: Thesis[], since: number): ChatMessage[] {
  let out = messages;
  const replace = (i: number, next: ChatMessage) => {
    if (out === messages) out = [...messages];
    out[i] = next;
  };
  const byKey = new Map<string, Thesis>();
  /** A row's key from before its tape carried the hash → its key now. */
  const renamed = new Map<string, string>();
  for (const m of moves) {
    const key = isFill(m) ? tradeKeyOf(m) : null;
    if (!key) continue;
    byKey.set(key, m);
    const older = fieldKeyOf(m);
    if (older && older !== key) renamed.set(older, key);
  }
  const current = (key: string | undefined) => (key ? (renamed.get(key) ?? key) : undefined);
  // Cards back onto lines the thread already has.
  out.forEach((line, i) => {
    const key = current(line.tradeKey);
    const t = key ? byKey.get(key) : undefined;
    // Only where the card is MISSING: every refresh brings new objects for the
    // same rows, and rebuilding the thread for each would redraw it for nothing.
    if (t && !line.trade) replace(i, { ...line, trade: t });
  });
  const known = new Set(out.map((l) => current(l.tradeKey)).filter(Boolean));
  const fresh = [...byKey.entries()].filter(([key, m]) => !known.has(key) && m.at! > since).sort((a, b) => a[1].at! - b[1].at!);
  // Each receipt still waiting takes the matching fill NEAREST its answer —
  // and a fill one receipt took is no other's. Two sells of one coin can both
  // hold the first fill in their lives; claimed twice, the second fill found
  // both receipts taken and became a line of its own: one sell, shown twice.
  const joined = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const line = out[i]!;
    if (!awaitsFill(line)) continue;
    const life = lifeOf(out, line);
    let best: [string, Thesis] | null = null;
    for (const entry of fresh) {
      if (joined.has(entry[0]) || !sameTrade(line, entry[1], life)) continue;
      if (!best || gap(life, entry[1]) < gap(life, best[1])) best = entry;
    }
    if (best) {
      replace(i, { ...line, tradeKey: best[0], trade: best[1] });
      joined.add(best[0]);
    }
  }
  for (const [key, fill] of fresh) {
    if (joined.has(key)) continue;
    const p = fillParts(fill);
    if (out === messages) out = [...messages];
    out.push({ id: `fill-${key}`, role: "event", at: fill.at! * 1000, text: p.line, side: p.side, tradeKey: key, trade: fill });
  }
  return out;
}

/**
 * When the trade a line is about happened, on the tape's clock (epoch seconds)
 * — or null for a line that is about no trade.
 *
 * The card's own time when it is loaded; else the one a `t:` key was built
 * from; else, for a chain-hash key, the line's own time: an event is stamped
 * with its fill's, and a receipt with the moment the answer came back, which
 * is after its fill.
 */
function tradeAtOf(m: ChatMessage): number | null {
  if (!m.tradeKey) return null;
  if (typeof m.trade?.at === "number" && Number.isFinite(m.trade.at)) return m.trade.at;
  const keyed = /^t:(\d+(?:\.\d+)?):/.exec(m.tradeKey);
  if (keyed) return Number(keyed[1]);
  return m.at !== null ? Math.floor(m.at / 1000) : null;
}

/**
 * THE NEWEST MAX_MESSAGES LINES — AND A WATERMARK THAT REMEMBERS WHAT WENT.
 *
 * A busy agent's oldest lines are its fills, and the tape (the newest thirty
 * operations) can still hold those trades after the thread has trimmed them.
 * Trimmed and forgotten, the next refresh found them missing and newer than
 * the watermark, and mergeFills put them back at the BOTTOM of the thread as
 * if they had just happened — one per refresh, each pushing the conversation
 * out as it went. So the watermark moves past every trade a trim removes.
 *
 * What that gives up: a fill that reaches the tape late with a time OLDER than
 * a line already trimmed is not shown. It is past the top of the thread
 * either way, and never showing it beats showing it as news.
 *
 * A watermark the tape never set stays unset, so first sight of the tape is
 * still first sight. Returns the same object when there is nothing to trim.
 */
export function capThread<T extends { messages: ChatMessage[]; since: number | null }>(t: T): T {
  const over = t.messages.length - MAX_MESSAGES;
  if (over <= 0) return t;
  let since = t.since;
  if (since !== null) {
    for (const m of t.messages.slice(0, over)) {
      const at = tradeAtOf(m);
      if (at !== null && at > since) since = at;
    }
  }
  return { ...t, messages: t.messages.slice(over), since };
}

/**
 * THE OTHER ORDER OF ARRIVAL: the tape showed the fill before the order's
 * poll heard back. The receipt line `id` then takes the fill's key and card,
 * and the fill's own event line goes — one trade, one line, whichever came
 * first. Every fact must agree, exactly as when the fill arrives second, and
 * of several that do it takes the one nearest the answer.
 */
export function absorbFill(messages: ChatMessage[], id: string): ChatMessage[] {
  const at = messages.findIndex((m) => m.id === id);
  const receiptLine = messages[at];
  if (!receiptLine) return messages;
  const life = lifeOf(messages, receiptLine);
  let fillAt = -1;
  messages.forEach((m, i) => {
    if (m.role !== "event" || m.order || !m.tradeKey || !m.trade || !sameTrade(receiptLine, m.trade, life)) return;
    if (fillAt < 0 || gap(life, m.trade) < gap(life, messages[fillAt]!.trade!)) fillAt = i;
  });
  if (fillAt < 0) return messages;
  const fill = messages[fillAt]!;
  return messages
    .map((m, i) => (i === at ? { ...m, tradeKey: fill.tradeKey, trade: fill.trade } : m))
    .filter((_, i) => i !== fillAt);
}

/**
 * What the model hears as said BEFORE a question put again.
 *
 * A retry sends the failed question as the new message, and the question is
 * already a line in the thread: left in, the model read it asked twice in a
 * row. So the failed answer AND the owner's line it answered are left out —
 * the nearest line before the failure that says exactly this. Whatever else
 * arrived meanwhile (a fill, say) stays, because it was said.
 */
export function historyBeforeRetry(messages: ChatMessage[], failedId: string, question: string) {
  const failedAt = messages.findIndex((m) => m.id === failedId);
  let askedAt = -1;
  for (let i = (failedAt < 0 ? messages.length : failedAt) - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "owner" && m.text.trim() === question) {
      askedAt = i;
      break;
    }
  }
  return historyFor(messages.filter((_, i) => i !== failedAt && i !== askedAt));
}

/**
 * WHAT THE MODEL IS TOLD WAS SAID — the last eight lines.
 *
 * The owner's lines as theirs, the agent's as its own, and an event as the
 * templated receipt it is. A failure said in the agent's voice is OURS, not
 * the model's — telling the model it said "I couldn't reach you" would put
 * words in its mouth about a network it never saw — so it is left out.
 */
export function historyFor(messages: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  return messages
    .filter((m) => m.text && !m.failed)
    .map((m) => ({
      role: m.role === "owner" ? ("user" as const) : ("assistant" as const),
      content:
        m.role === "event" && m.side
          ? `[${m.side === "buy" ? "Buy" : "Sell"}] ${m.text}`
          : m.order?.receipt
            ? `${receiptText(m.order.receipt)} — ${m.text}`
            : m.text,
    }))
    .slice(-8);
}

/**
 * A conversation kept in the old question/answer shape, as messages.
 *
 * "" was the question of an order's outcome and "✓ confirmed" of a confirmed
 * card — neither was typed. The first becomes the agent's line alone; the
 * second keeps its tick, as the owner's. No time is invented for any of them.
 */
export function turnsToMessages(turns: ChatTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  turns.forEach((t, i) => {
    if (t.question.trim()) {
      out.push({ id: `kept-${i}-q`, role: "owner", at: null, text: t.question === "✓ confirmed" ? "✓ Confirmed" : t.question });
    }
    if (t.answer.trim()) out.push({ id: `kept-${i}-a`, role: "agent", at: null, text: t.answer });
  });
  return out.slice(-MAX_MESSAGES);
}

// ── chips ─────────────────────────────────────────────────────────────────

export interface ChatChip {
  label: string;
  /** What is sent when it is tapped — an ordinary message; nothing is placed by a chip. */
  message: string;
}

/**
 * THE MOST A CHIP MAY SUGGEST: the smaller of the per-trade cap sealed into
 * the key and the owner's ceiling on a chat order.
 *
 * Null when either was not read — an amount chip offers a size, and a size
 * nobody checked against the wall is one the wall may refuse. A ceiling of 0
 * is "no chat ceiling" (the orders route reads it that way), so the sealed cap
 * alone clamps.
 *
 * ROUNDED DOWN TO THE CENT. A chip is printed and sent to the cent, and the
 * orders route refuses `usdgAmount > ceiling` — while /api/settings takes any
 * float, so a ceiling of 9.999 printed as "$10.00 (max)": an order the route
 * refused. The cent is taken with a hair of slack, because 8.2 × 100 comes
 * out a hair below 820 and 8.20 must not become 8.19, and then checked, so the
 * result never exceeds the limit. Less than a cent is no amount to offer.
 */
export function amountCeiling(perTrade: number | null, ceiling: number | null): number | null {
  if (perTrade === null || ceiling === null || !Number.isFinite(perTrade) || perTrade <= 0) return null;
  const limit = ceiling > 0 ? Math.min(perTrade, ceiling) : perTrade;
  let cents = Math.floor(limit * 100 + 1e-6);
  if (cents / 100 > limit) cents -= 1;
  return cents > 0 ? cents / 100 : null;
}

const ASKS_AMOUNT = /\bhow much\b|\bwhat size\b|\bhow big\b|\bwhich amount\b|\bhow many dollars\b/i;
const STEPS = [5, 10, 25, 50, 100, 250];

/**
 * Does this line of the agent's ask the owner for an amount — the one answer
 * that draws amount chips? The controller reads the ceiling again for exactly
 * these (chat-controller.ts readCeiling), so the chips are drawn against the
 * ceiling as it stands when the question is asked.
 */
export const asksAmount = (line: string | null): boolean => !!line && ASKS_AMOUNT.test(line);

/**
 * TWO TO FOUR THINGS WORTH ASKING NEXT, from what this agent is doing.
 *
 * They used to show only on an empty chat and were the same three for
 * everybody. Now: when the agent has just asked "how much?", sizes — each
 * inside the clamp above, the clamp itself marked (max) — and otherwise the
 * questions this agent's state raises: why it cannot trade when something is
 * stopping it or it has not traded, why the coin it last traded, what it holds.
 * A chip only ever SENDS A MESSAGE; any trade still goes through the model's
 * proposal and the owner's click on the card.
 */
export function chatChips(c: {
  liveBlocker: string | null | undefined;
  stopped: boolean;
  latestSymbol: string | null;
  holding: string[];
  lastAgent: string | null;
  perTrade: number | null;
  ceiling: number | null;
}): ChatChip[] {
  const chips: ChatChip[] = [];
  const clamp = amountCeiling(c.perTrade, c.ceiling);
  if (asksAmount(c.lastAgent) && clamp !== null) {
    for (const v of STEPS.filter((s) => s < clamp).slice(0, 2)) chips.push({ label: usd(v), message: usd(v) });
    chips.push({ label: `${usd(clamp)} (max)`, message: usd(clamp) });
  }
  const context: ChatChip[] = [];
  if (c.liveBlocker || c.stopped || !c.latestSymbol) {
    context.push({ label: "Why can't you trade?", message: "Why can't you trade right now?" });
  }
  if (c.latestSymbol) context.push({ label: `Why ${c.latestSymbol}?`, message: `Why did you trade ${c.latestSymbol}?` });
  context.push(
    c.holding.length
      ? { label: "What do you hold?", message: "What do you hold, and how is it doing?" }
      : { label: "My strategy", message: "Explain your trading strategy." },
  );
  context.push({ label: "Trading limits", message: "Explain my trading limits." });
  for (const chip of context) {
    if (chips.length >= 4 || (chips.length >= 2 && chips.some((x) => x.label.startsWith("$")))) break;
    chips.push(chip);
  }
  return chips.slice(0, 4);
}

// ── failures ──────────────────────────────────────────────────────────────

/**
 * WHAT THE CHAT ROUTE SAID ABOUT A MODEL CALL THAT FAILED — classified on the
 * server, which had the error and its status (lib/agent-chat.ts), by the same
 * classifier the Telegram surface uses (worker/src/llm-failure.ts). The kind
 * and a provider's name; never the provider's own words.
 */
export interface LlmFailureSaid {
  kind: LlmFailureKind;
  /** "Groq", "Anthropic" — null when the route named nobody. */
  provider: string | null;
}

/** What else is known about a failure, for the sentence that says it. */
export interface FailureFacts {
  /** The HTTP status a "server" failure came back with. */
  status?: number | null;
  /** The route's classification of an "llm-error". */
  llm?: LlmFailureSaid | null;
}

const LLM_KINDS: ReadonlySet<LlmFailureKind> = new Set<LlmFailureKind>([
  "key-rejected",
  "rate-limited",
  "provider-down",
  "unreachable",
  "model-missing",
  "other",
]);

/**
 * The route's classification, as read off the wire. A kind this browser does
 * not know is "other" — said as a reason it does not recognise, which is true —
 * and a provider name that is not a short plain name is not repeated.
 */
export function llmFailureOf(kind: unknown, provider: unknown): LlmFailureSaid {
  return {
    kind: typeof kind === "string" && LLM_KINDS.has(kind as LlmFailureKind) ? (kind as LlmFailureKind) : "other",
    provider: typeof provider === "string" && /^[A-Za-z0-9][\w .-]{0,39}$/.test(provider) ? provider : null,
  };
}

/** The model failures that pass on their own, so asking again is worth offering. */
const PASSING: ReadonlySet<LlmFailureKind> = new Set<LlmFailureKind>(["rate-limited", "provider-down", "unreachable"]);

/**
 * IS ASKING AGAIN WORTH A RETRY CHIP?
 *
 * Yes for everything that passes — a network, a timeout, a stream cut short,
 * a server that did not answer. NOT for a model failure that will fail the
 * same way every time until somebody changes something: a rejected key, a
 * model that does not exist, or a refusal nobody recognised. A chip there is
 * a button that cannot work, beside a sentence telling the owner it might.
 */
export function retryHelps(kind: ChatFailure, facts: FailureFacts = {}): boolean {
  if (kind !== "llm-error") return true;
  return !!facts.llm && PASSING.has(facts.llm.kind);
}

/** A model failure in the agent's words, by its kind — never the provider's. */
function llmLine({ kind, provider }: LlmFailureSaid): string {
  const whose = provider ?? "its provider";
  const aside = provider ? `, ${provider},` : "";
  switch (kind) {
    case "key-rejected":
      return `My brain couldn't answer: ${whose} refused the API key it's set up with. Asking again won't help until that key is replaced.`;
    case "model-missing":
      return `My brain couldn't answer: ${whose} says the model it's set to use isn't available. Asking again won't help until the model is changed.`;
    case "rate-limited":
      return `My brain is being rate-limited by ${whose} right now. Give it a moment and try again.`;
    case "provider-down":
      return `My brain's provider${aside} is having trouble on its side. Try again in a few minutes.`;
    case "unreachable":
      return `I couldn't reach my brain's provider${aside} just now. Try again in a minute.`;
    case "other":
    default:
      return "My brain couldn't answer that time, for a reason I don't recognise. If asking again gets the same, its setup needs a look.";
  }
}

/**
 * A REPLY THAT DID NOT ARRIVE, SAID AS THE AGENT WOULD SAY IT.
 *
 * The screen used to print the raw DOMException ("signal timed out") or "Your
 * agent could not reply" — a system error inside a conversation. Each of these
 * says what happened in plain words and what to do, and none claims more than
 * is known: a timeout is not "the provider is down", a network drop is not
 * "your message was lost", and a gateway's error page is not an answer that
 * "arrived garbled" — nobody answered it.
 *
 * NEVER THE PROVIDER'S OWN WORDS. They used to ride along — "(it said: groq
 * 401 — invalid_api_key: …)", Anthropic's JSON included — inside the agent's
 * sentence, persisted, and followed by "give it a moment" whatever they said.
 * A model failure is said by its kind (llmLine), and "try again" only where
 * trying again can work (retryHelps).
 */
export function failureLine(kind: ChatFailure, facts: FailureFacts = {}): string {
  switch (kind) {
    case "signed-out":
      return "I can't hear you — your sign-in has lapsed. Sign in again and ask me once more.";
    case "no-llm":
      return "I've no brain connected yet, so I can't answer in my own words. Connect an AI provider in Settings, then ask me again.";
    case "llm-error":
      return llmLine(facts.llm ?? { kind: "other", provider: null });
    case "timeout":
      return "I took too long to answer and gave up waiting. Try again.";
    case "cut-off":
      return "My answer was cut off before I finished, so I haven't kept half of it. Try again.";
    case "network":
      return "I couldn't reach you just now — the connection dropped before my answer arrived. Try again.";
    case "server":
      return `I couldn't get an answer through just now${facts.status ? ` (the server said ${facts.status})` : ""}. Try again.`;
    case "unreadable":
    default:
      return "I got an answer back that I can't read, so I haven't shown it. Try again.";
  }
}

/**
 * Put the cursor back in the composer after a send — ONLY with a fine pointer.
 *
 * It refocused on every send, and on a phone focusing a textarea opens the
 * keyboard: the answer the owner was waiting for arrived underneath it. A
 * browser that cannot say what pointer it has is not assumed to have a mouse.
 */
export function refocusAfterSend(win: { matchMedia?: (q: string) => { matches: boolean } }): boolean {
  try {
    return typeof win.matchMedia === "function" && win.matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
}
