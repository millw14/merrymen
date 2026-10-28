/** Bounded code-written public replies. This module has no send, model, memory or account port. */
import { deskQuestionIndicator, deskQuestionIntent } from "../desk/questions";
import type { TgDeskAsk, TgDeskEvidence, TgDeskThought } from "./tg-groups/types";
import type { RecoveryPublicLook } from "./recovery-public-transport";

export const RECOVERY_PUBLIC_NOTICE = "An agent upgrade is underway. Automated trading is temporarily paused.";
export const RECOVERY_PUBLIC_GREETING = `${RECOVERY_PUBLIC_NOTICE} I'm still here for coin and chart questions.`;
export const RECOVERY_PUBLIC_UNAVAILABLE = `I can't verify fresh public data for that right now. ${RECOVERY_PUBLIC_NOTICE}`;
export const RECOVERY_PUBLIC_HELP = `${RECOVERY_PUBLIC_GREETING} Send a ticker or contract for a chart read or its published story, or ask about the market.`;
export const RECOVERY_PUBLIC_HELD = `${RECOVERY_PUBLIC_NOTICE} I can't place orders, change trading limits or confirm account positions.`;
export const RECOVERY_PUBLIC_CONTEXT = `${RECOVERY_PUBLIC_NOTICE} Tell me which coin or question you mean.`;
export const RECOVERY_PUBLIC_BUSY = `I'm handling several public requests. Please ask again shortly. ${RECOVERY_PUBLIC_NOTICE}`;
export const RECOVERY_PUBLIC_BUTTON_HELD = `${RECOVERY_PUBLIC_NOTICE} That button cannot authorize an action.`;
const MAX_TEXT = 800;
const MAX_REPLY = 1000;
const MAX_FRESH_MS = 60_000;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ticker = (text: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(text);
const QUESTION_WORDS = new Set("chart charts lore story description project theme read show me please public fresh current currently overview of for on about what whats is are does do it this the a an can you tell explain look at how why has changed trend structure price hourly candle candles history volume participation buyers sellers flow liquidity depth momentum rsi rsi14 ema ema20 ema50 vwap atr atr14 indicator indicators news safety safe rug scam audit risk invalidation support resistance target targets prediction forecast bottom timeframe freshness old recent stale now from quote index published token coin and thoughts opinion take check out entry quick analysis i think good".split(" "));
const CONVERSATION_WORDS = new Set("help hi hello gm gn hey status thanks thankyou yes no okay ok sure cool sorry welcome bye goodbye".split(" "));
const CONVERSATION = Object.freeze({
  greeting: RECOVERY_PUBLIC_GREETING,
  morning: `Morning. ${RECOVERY_PUBLIC_GREETING}`,
  farewell: "Catch you later.",
  thanks: "You're welcome.",
  ack: "Got you.",
  clarify: RECOVERY_PUBLIC_GREETING,
  repair: RECOVERY_PUBLIC_CONTEXT,
  status: RECOVERY_PUBLIC_GREETING,
});
type ConversationIntent = keyof typeof CONVERSATION;
/** Exact phrases only; explicit asset syntax is parsed before this stateless small-talk lane. */
function conversationIntent(text: string): ConversationIntent | "help" | null {
  const phrase = text.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").replace(/[!?.,]+$/, "").trim();
  if (/^(?:h+i+|h+e+y+|h+e+l+o+)(?: there)?$/.test(phrase)) return "greeting";
  if (["how are you", "how's it going", "are you there", "you there"].includes(phrase)) return "greeting";
  if (/^g+m+$/.test(phrase) || phrase === "good morning") return "morning";
  if (/^g+n+$/.test(phrase) || ["good night", "bye", "goodbye"].includes(phrase)) return "farewell";
  if (/^thanks+$/.test(phrase) || ["thank you", "thankyou", "ty", "thx"].includes(phrase)) return "thanks";
  if (["ok", "okay", "yes", "no", "sure", "cool", "sorry", "welcome"].includes(phrase)) return "ack";
  if (/^(?:e+h+|h+u+h+)$/.test(phrase)) return "clarify";
  if (["why", "what", "what do you mean", "what does that mean", "what was that", "explain"].includes(phrase)) return "repair";
  if (["status", "are you back", "are you working", "are you online"].includes(phrase)) return "status";
  return ["help", "/help"].includes(phrase) ? "help" : null;
}
const surroundingQuestion = (text: string, asset: string): boolean => text.replace(asset, " ").toLowerCase().replace(/[\/?.,!:'’()-]/g, " ").trim().split(/\s+/).filter(Boolean).every((word) => QUESTION_WORDS.has(word) || /^\d{1,3}[mhd]$/.test(word));

export interface RecoveryPublicRequest {
  /** Already addressed and stripped of the bot mention by the authenticated caller. */
  text: string;
  /** Absolute deadline assigned on receipt, including the caller's send allowance. */
  deadlineMs: number;
  sendReserveMs?: number;
  signal?: AbortSignal;
}
export interface RecoveryPublicEvidence {
  readonly kind: "coin" | "market";
  readonly subject: string;
  readonly observedAtMs: number;
  readonly source: "GeckoTerminal";
  readonly reference: Readonly<TgDeskAsk>;
}
export interface RecoveryPublicReply {
  readonly kind: "public" | "unavailable" | "help" | "held" | "conversation";
  /** Plain text: the caller must not enable Telegram markup parsing. */
  readonly text: string;
  readonly photo?: Uint8Array;
  readonly evidence?: RecoveryPublicEvidence;
}
export interface RecoveryPublicReplyDeps { look: RecoveryPublicLook; now?: () => number; }
type Parsed = { ask: TgDeskAsk; lore: boolean } | "help" | "held" | ConversationIntent;

/** No arbitrary URLs, fuzzy asset guessing, financial commands or implicit follow-up memory. */
export function parseRecoveryPublicAsk(raw: string): Parsed {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_TEXT || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(raw)) return "help";
  const text = raw.trim();
  if (/^\/(?!chart\b|lore\b|market\b|help\b)[a-z][a-z0-9_-]*(?:@\w+)?\b/i.test(text) || /\b(?:buy|sell|swap|trade|execute|withdraw|transfer|reset|self[- ]?test|sign|leverage|allocation|risk limit|your (?:position|balance|holdings))\b/i.test(text)) return "held";
  if (/https?:\/\/|www\.|[<>]/i.test(text)) return "help";
  const lore = /\b(?:lore|story|description|project|theme)\b/i.test(text);
  const market = /\bmarket\b/i.exec(text);
  if (market && surroundingQuestion(text, market[0])) return { ask: { kind: "market" }, lore: false };
  const addresses = text.match(/\b0x[A-Za-z0-9]+\b/gi) ?? [];
  if (addresses.length === 1 && ADDRESS.test(addresses[0]!) && surroundingQuestion(text, addresses[0]!)) return { ask: { kind: "coin", address: addresses[0]!.toLowerCase() }, lore };
  if (addresses.length) return "help";
  const cashtags = [...text.matchAll(/\$([A-Za-z0-9][A-Za-z0-9._-]{0,15})(?![A-Za-z0-9._-])/g)];
  if (cashtags.length === 1 && surroundingQuestion(text, cashtags[0]![0])) return { ask: { kind: "coin", query: cashtags[0]![1]! }, lore };
  if (cashtags.length || text.includes("$")) return "help";
  const named = /^(?:\/(?:chart|lore)\s+|(?:chart|lore|story|description)(?: (?:of|for))?\s+|(?:thoughts on|what about|check out|check|opinion on|take on)\s+)([A-Za-z0-9][A-Za-z0-9._-]{0,15})(?=[\s,?!.]|$)/i.exec(text);
  if (named && surroundingQuestion(text, named[1]!)) return { ask: { kind: "coin", query: named[1]! }, lore };
  const suffix = /^([A-Za-z0-9][A-Za-z0-9._-]{0,15})\s+(?:chart|lore|story|description|entry)[?.!]*$/i.exec(text);
  if (suffix) return { ask: { kind: "coin", query: suffix[1]! }, lore };
  const conversation = conversationIntent(text);
  if (conversation) return conversation;
  return ticker(text) && !QUESTION_WORDS.has(text.toLowerCase()) && !CONVERSATION_WORDS.has(text.toLowerCase()) ? { ask: { kind: "coin", query: text }, lore: false } : "help";
}

/** Approved rooms answer explicit public asks and bare contracts; ordinary ticker chatter stays quiet. */
export function isRecoveryPublicRequest(text: string): boolean {
  const parsed = parseRecoveryPublicAsk(text);
  if (typeof parsed === "string") return false;
  if (parsed.ask.kind === "market" || (parsed.ask.kind === "coin" && "address" in parsed.ask)) return true;
  return /\b(?:chart|lore|story|description|thoughts|opinion|take|check|analysis|entry|news)\b|\bwhat\s+about\b/i.test(text);
}

const fixed = (kind: "unavailable" | "help" | "held" | ConversationIntent): RecoveryPublicReply => {
  if (kind === "unavailable" || kind === "help" || kind === "held") return Object.freeze({ kind, text: kind === "help" ? RECOVERY_PUBLIC_HELP : kind === "held" ? RECOVERY_PUBLIC_HELD : RECOVERY_PUBLIC_UNAVAILABLE });
  return Object.freeze({ kind: "conversation", text: CONVERSATION[kind] });
};
const plain = (raw: unknown, max: number): string | null => typeof raw === "string" && raw.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(raw) ? raw.replace(/\s+/g, " ").trim() : null;
const fresh = (at: number, now: number): boolean => Number.isSafeInteger(at) && at > 0 && at <= now && now - at <= MAX_FRESH_MS;
const reference = (e: TgDeskEvidence, ask: TgDeskAsk): Readonly<TgDeskAsk> | null => {
  if (ask.kind === "market") return e.kind === "market" && e.reference?.kind === "market" ? Object.freeze({ kind: "market" }) : null;
  const ref = e.reference;
  if (ask.kind !== "coin" || e.kind !== "coin" || ref?.kind !== "coin" || !("address" in ref) || !ADDRESS.test(ref.address) || ("address" in ask && ref.address.toLowerCase() !== ask.address.toLowerCase())) return null;
  return Object.freeze({ kind: "coin", address: ref.address.toLowerCase() });
};
const safePhoto = (value: unknown): Uint8Array | undefined => {
  if (!(value instanceof Uint8Array) || value.byteLength < 33 || value.byteLength > 1024 * 1024) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, at) => value[at] === byte) || String.fromCharCode(...value.subarray(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (!view.getUint32(16) || !view.getUint32(20) || view.getUint32(16) > 2048 || view.getUint32(20) > 2048) return undefined;
  return Uint8Array.from(value);
};

function publicReply(e: TgDeskEvidence, parsed: Exclude<Parsed, string>, question: string, now: number): RecoveryPublicReply {
  const ref = reference(e, parsed.ask);
  if (!ref || !fresh(e.observedAtMs, now) || !/^GeckoTerminal \d{2}:\d{2} UTC$/.test(e.source)) return fixed("unavailable");
  const subject = e.kind === "market" ? "Robinhood Chain market" : ticker(e.subject) ? e.subject : "this coin";
  const rename = (raw: unknown, max: number) => { const text = plain(raw, max); return text === null ? null : e.subject ? text.split(e.subject).join(subject) : text; };
  const intent = deskQuestionIntent(question), indicator = deskQuestionIndicator(question);
  const thought: TgDeskThought = (intent === "indicators" && indicator ? e.indicators?.[indicator] : undefined) ?? e.scenarios?.[intent] ?? e.floor;
  const read = rename(thought?.read, 1600), watch = rename(thought?.watch, 600), invalidation = rename(thought?.invalidation, 600);
  if (!read || watch === null || invalidation === null) return fixed("unavailable");
  const lore = e.lore;
  const description = lore && plain(lore.description, 500);
  const boundUrl = ref.kind === "coin" && "address" in ref ? `https://www.geckoterminal.com/robinhood/tokens/${ref.address}` : "";
  const admittedLore = lore && description && lore.source === "GeckoTerminal token info" && lore.url === boundUrl && fresh(lore.observedAtMs, now) ? description : null;
  let body = read;
  if (parsed.lore) body = admittedLore ? `Published project claim (GeckoTerminal token info): “${admittedLore}”` : "I don't have a fresh contract-bound project description. I won't guess its story from the ticker.";
  else {
    if (watch && body.length + watch.length < 660) body += ` Watch: ${watch}.`;
    if (admittedLore) {
      const first = admittedLore.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? admittedLore;
      const excerpt = first.length > 150 ? `${first.slice(0, 149).trimEnd()}…` : first;
      body = `Published project claim (GeckoTerminal token info): “${excerpt}”\n${body}`;
    }
  }
  const source = `GeckoTerminal · ${new Date(e.observedAtMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const tail = `${source}\n${RECOVERY_PUBLIC_NOTICE}`;
  const room = MAX_REPLY - subject.length - tail.length - 3;
  if (body.length > room) body = `${body.slice(0, room - 1).trimEnd()}…`;
  const evidence: RecoveryPublicEvidence = Object.freeze({ kind: e.kind, subject, observedAtMs: e.observedAtMs, source: "GeckoTerminal", reference: ref });
  const photo = parsed.lore ? undefined : safePhoto(e.chart);
  return Object.freeze({ kind: "public", text: `${subject}\n${body}\n${tail}`, evidence, ...(photo ? { photo } : {}) });
}

/** The only effect is the injected public read. Expiry aborts work and discards every late result. */
export function createRecoveryPublicReply(deps: RecoveryPublicReplyDeps): (request: RecoveryPublicRequest) => Promise<RecoveryPublicReply> {
  const now = deps.now ?? Date.now;
  return async (request) => {
    const started = now();
    const reserve = request.sendReserveMs ?? 5000;
    if (!Number.isFinite(request.deadlineMs) || !Number.isFinite(reserve) || reserve < 1 || reserve > 10_000 || request.signal?.aborted) return fixed("unavailable");
    const deadline = Math.min(request.deadlineMs, started + 30_000) - reserve;
    const ms = Math.floor(Math.min(10_000, deadline - started));
    if (ms < 1) return fixed("unavailable");
    const parsed = parseRecoveryPublicAsk(request.text);
    if (typeof parsed === "string") return fixed(parsed);
    const controller = new AbortController();
    let stop!: () => void;
    const stopped = new Promise<null>((resolve) => { stop = () => { controller.abort(); resolve(null); }; });
    request.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, ms);
    try {
      if (request.signal?.aborted) { stop(); return fixed("unavailable"); }
      const work = Promise.resolve().then(() => controller.signal.aborted || now() >= deadline ? null : deps.look(parsed.ask, { timeoutMs: ms, signal: controller.signal })).catch(() => null);
      const result = await Promise.race([work, stopped]);
      return result?.ok && !controller.signal.aborted && now() < deadline ? publicReply(result.evidence, parsed, request.text, now()) : fixed("unavailable");
    } catch { return fixed("unavailable"); }
    finally { clearTimeout(timer); request.signal?.removeEventListener("abort", stop); controller.abort(); }
  };
}
