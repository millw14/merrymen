/**
 * Telegram groups — the coin flow. The contract is docs/tg-groups.md, "The
 * coin flow" (steps 1–9), plus the "$PEPE?" line after it.
 *
 * ROBINHOOD CHAIN COINS ONLY. People post coins from every chain. A CA in a
 * link that names another chain (Etherscan, BscScan, dexscreener.com/ethereum,
 * gmgn.ai/bsc…), a Solana mint, and an address the look does not show is a
 * Robinhood Chain coin (`wallet`, `not-token`, `unknown`: an Ethereum token
 * has no code here, so it reads as a wallet) get silence: no line, no
 * reaction, no owner ask, no DM, no nomination, and no memo anything could
 * later be said from. Coins off and a stale post are silent the same way:
 * without a look nothing shows the coin is one of Robinhood Chain's.
 *
 * WHAT THIS DECIDES AND WHAT IT DOES NOT. A posted CA is claimed, remembered
 * and, when every switch allows it, handed across as a nomination: the
 * address plus `{chatId, messageId, senderId, atMs}` and nothing else. Whether
 * anything is bought is decided on the trading side (the Brain, the trencher
 * entry path, checkPolicy, the vault); this module only hears the outcome and
 * says it the way a person would. It never imports a trading module: trading
 * is reached through `TgCoinsPort` alone, and the words come from the injected
 * `speak` (voice.ts), so nothing here writes a line itself.
 *
 * AT-MOST-ONCE COMES FIRST. Every CA is claimed in the durable store before
 * anything else happens to it (`store.claim` is on disk before it returns
 * true). A redelivered update — a redeploy mid-batch, a replayed poll — finds
 * the claim and does nothing, so no coin is ever looked at, nominated or
 * answered twice for one post. A claim that could not be written reads as
 * "already claimed": the coin is dropped, which is the direction AGENTS.md
 * allows ("financial operations must not become replayable after a crash").
 *
 * SILENCE IS THE FALLBACK. Every failure (the port, the store, Telegram, the
 * writer) is one log line naming the stage and the error class, never the
 * text, the address, the title or a name. Nothing is ever said in a room that
 * is not `approved`, and the room's status is re-read before each line,
 * because a look can take seconds and the owner may press Leave meanwhile.
 *
 * RATE LIMITS RESERVE, THEN RELEASE. A once-per-hour line stamps its room
 * field BEFORE awaiting the send and puts the old stamp back if the send
 * failed. Two posts handled concurrently therefore cannot both pass the check
 * while the first is still typing, and a line that never went out does not
 * use up the hour.
 *
 * NEVER ON THE CHAT'S QUEUE FOR LONG. A look reads the chain and
 * GeckoTerminal, and on a bad day those reads are declined, rate-limited or
 * simply never answer. The handler's per-chat queue runs one line at a time,
 * so a look awaited there held every later line of that chat — the owner's
 * "@bot didnt you see?" included — until it went stale and was dropped. So
 * `begin` decides at once whether the flow owns a line (nothing it decides
 * needs a read), and the rest of a CA's work — its claim, its look, its lines,
 * its nomination — runs on this chat's COIN LANE: serial per chat, so two
 * posts of one coin are still looked at in order and the second is answered
 * from memory, but apart from the chatter queue. And a look is bounded
 * (COIN_FLOW.lookMs): past it the answer is `unknown`, whatever the port does.
 *
 * AND THE LANE SERVES WHOEVER ASKED FIRST. One shill's backlog of CAs must
 * not make the owner's "@bot what about <CA>" wait past the handler's send
 * window: a post that addresses the agent, or is the owner's, is worked
 * before anyone else's that is still waiting (in order among equals); a post
 * whose reply window has run out is claimed and not looked at, so a backlog
 * drains instead of spending the look allowance on lines that would be
 * dropped; and past COIN_FLOW.laneMax waiting, nobody's-asked posts are
 * claimed and let go.
 *
 * NAMING: never write the web room's name (group + chat, joined or separated)
 * in code here. See types.ts.
 */

import type { TgGroupsStore } from "./store";
import type {
  CoinKind,
  CoinLook,
  CoinOutcome,
  CoinVerdict,
  NominateRefusal,
  NominateResult,
  Nomination,
  TgCoinMemo,
  TgCoinsPort,
  TgLine,
  TgRoom,
  TrencherReadiness,
} from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The coin flow's clocks and counts. Every one of them is from the contract unless it says otherwise. */
export const COIN_FLOW = {
  /** "At most the first 2 CAs in a message are considered": counted once CAs in other chains' links are set aside. */
  maxCas: 2,
  /** CAs read off one message at most, other chains' included (detect.ts MAX_HITS). */
  maxPosted: 16,
  /** A post older than this (Telegram `date`) is claimed and nothing more: never looked at, nominated or remembered. */
  staleMs: 10 * MIN,
  /** A coin seen in this chat this recently is answered from memory, no new look. */
  seenMs: 24 * HOUR,
  /** The owner ask in the group, per chat. */
  readyAskMs: 12 * HOUR,
  /** The lighter line for later CAs while not ready, per chat, counted from the ask too. */
  readyNudgeMs: HOUR,
  /** The owner's DM with the private reason, per chat. */
  readyDmMs: 12 * HOUR,
  /** "one at a time lol", per chat. */
  capLineMs: HOUR,
  /** "drop the ca", per chat. */
  dropCaMs: HOUR,
  /**
   * Not in the contract: an answer from memory ("already looked at that
   * one…") at most once per coin per chat this often. A CA reposted eight
   * times in three minutes is not eight things to say; later reposts get one
   * 👀 inside the window, then nothing.
   */
  seenLineMs: HOUR,
  /** An `expired` outcome is said only when a human spoke in the chat this recently. */
  expiredLiveMs: 30 * MIN,
  /**
   * Not in the contract: how old a `candidate` memo may be and still mean
   * "under review". The nomination TTL is 15 min (trencher-nominate.ts), and a
   * restart forgets pending nominations without an outcome, so a memo still
   * saying `candidate` after this is one whose outcome is never coming.
   */
  candidateMaxMs: 20 * MIN,
  /** How often the port is re-read, so a trading restart's new port gets subscribed. */
  portCheckMs: 60_000,
  /**
   * The longest one look is waited for. The look bounds each of its own reads
   * (tg-coin-look.ts COIN_LOOK.readMs / poolsMs); this bounds the port as a
   * whole, so a look that never answers is `unknown` after this and holds
   * neither its post nor the chat's coin lane behind it.
   */
  lookMs: 10_000,
  /**
   * Not in the contract: what a coin line needs once its look is back — the
   * typing it shows (at most 9 s, pacing.ts) and the gap between two sends to
   * a chat (3 s). A post whose reply window (CoinPostInfo.replyByMs) leaves
   * less than this is past answering, and a look is cut to end this long
   * before the window does.
   */
  lineMs: 12_000,
  /** Not in the contract: the shortest look worth starting inside a post's reply window. */
  lookMinMs: 2_000,
  /**
   * Not in the contract: posts that may wait on one chat's coin lane. Past
   * it, a post that neither addresses it nor is the owner's is claimed and
   * nothing more, so a raid of CAs cannot bury the post somebody asked about.
   */
  laneMax: 12,
  /**
   * "can't pull that one up rn": an ADDRESSED post whose CA could not be
   * looked at gets it, at most once per chat this often. Unaddressed, the
   * same failed look is silence.
   */
  unknownLineMs: 10 * MIN,
} as const;

/**
 * The voice intents the coin flow asks for — structurally the coin members of
 * voice.ts's `TgIntent`, declared here so this module does not import the
 * writer (the handler injects `speak`). Keep the two in step.
 */
export type CoinIntent =
  | { kind: "coin-ack" }
  | { kind: "coin-look"; look: CoinKind }
  | { kind: "coin-seen"; verdict: CoinVerdict }
  | { kind: "coin-bought"; paper: boolean; notes: string[] }
  | { kind: "coin-passed"; notes: string[] }
  | { kind: "coin-skipped" }
  | { kind: "coin-exited"; notes: string[] }
  | { kind: "coin-cap" }
  | { kind: "coin-unknown" }
  | { kind: "drop-ca" }
  | { kind: "ready-ask" }
  | { kind: "ready-nudge" }
  | { kind: "faded-again" };

/** Where a line goes and who it is about. Every field is optional; absent means "not this". */
export interface CoinSpeakOpts {
  /** Send as a Telegram reply to this message. */
  replyTo?: number;
  /** Tag this person in the line. */
  mention?: { id: number; name: string };
  /** The line that prompted it, for the writer's context. */
  trigger?: TgLine;
  /** The coin's casual display name, never address-shaped. */
  coinName?: string;
}

export interface CoinFlowDeps {
  store: TgGroupsStore;
  /** The trading side's port, or null while there is none (not wired yet, trading restarting). */
  port: () => TgCoinsPort | null;
  /** `cfg.telegramGroupCoinsEnabled`. */
  coinsEnabled: () => boolean;
  /** `TelegramState.ownerId`, or null when the bot was never linked. */
  ownerId: () => number | null;
  /** Say one line in a group. True when it went out. Gating, pacing and escaping are the writer's job. */
  speak: (chatId: number, intent: CoinIntent, o: CoinSpeakOpts) => Promise<boolean>;
  /** Set one emoji reaction on a message. True when it was set. */
  react: (chatId: number, messageId: number, emoji: string) => Promise<boolean>;
  /** DM the owner, plain text (the sender escapes), with an optional URL button. True when it went out. */
  dmOwner: (text: string, button?: { text: string; url: string }) => Promise<boolean>;
  /** The dashboard's base URL, e.g. `dashboardBase()`. */
  dashboardUrl: () => string;
  now: () => number;
  /** One line, never carrying message text, addresses, titles or names. */
  log: (s: string) => void;
  /**
   * Resolves once `ms` have passed: what bounds a look (COIN_FLOW.lookMs).
   * Real time when absent. Injectable so a test can end a look that never
   * answers without waiting for it, on a clock of its own.
   */
  timer?: (ms: number) => Promise<void>;
}

/**
 * WHY A POST ENDED WITH NOTHING SAID OR SET ON IT: a stable code for the
 * handler's one diagnostic line ("[tg-groups] addressed line got nothing
 * (coin-unknown)"). Never the text, an address or a name.
 *
 * - `coin-not-here`: not a Robinhood Chain coin — another chain's link or
 *   mint, a wallet, not a token. Silence by rule.
 * - `coin-unknown`: the look could not be made (reads failed or timed out, an
 *   allowance spent), and "can't pull that one up rn" was not said (the post
 *   did not address it, or the line was used in the last 10 minutes).
 * - `coin-off`, `coin-stale`, `coin-no-port`: no look was made. `coin-stale`
 *   is also a post that waited on the coin lane past its reply window.
 * - `coin-busy`: the chat's coin lane was full (COIN_FLOW.laneMax); a post
 *   that neither addresses it nor is the owner's was claimed and let go.
 * - `coin-replay`: already claimed (a redelivered update, or a claim that
 *   could not be written).
 * - `coin-rate`: the once-per-window line it would have said was used.
 * - `coin-refused`: a nomination refusal that is silent by rule.
 * - `forgotten`, `room-not-approved`: asked to forget, or the room left.
 * - `send-failed`: a line was due and did not go out (the handler knows why).
 */
export type CoinQuiet =
  | "coin-not-here"
  | "coin-unknown"
  | "coin-off"
  | "coin-stale"
  | "coin-busy"
  | "coin-no-port"
  | "coin-replay"
  | "coin-rate"
  | "coin-refused"
  | "forgotten"
  | "room-not-approved"
  | "send-failed";

/** What a post's work came to. `acted`: a line or a reaction for it went out. */
export interface CoinPostEnd {
  acted: boolean;
  /** Why nothing went out, when nothing did. */
  quiet?: CoinQuiet;
}

/**
 * `onPost` in its two halves. `owned` is known at once: "handled" means the
 * flow owns the line and nothing else answers it (see onPost). `done` is the
 * rest of the post's work on the chat's coin lane — claims, looks, lines,
 * nominations — and never rejects.
 */
export interface CoinPostStart {
  owned: "handled" | "none";
  done: Promise<CoinPostEnd>;
}

/** What the handler read off one message, for `onPost`. */
export interface CoinPostInfo {
  senderId: number;
  senderName: string;
  /** Telegram `date` (seconds). */
  dateSec?: number;
  /**
   * The CAs in the line, lowercased 0x + 40 hex, unique, in order: the
   * addresses of extractCaHits (extractCas's first two will do).
   */
  cas: string[];
  /**
   * The CAs of `cas` that sit in a link naming another chain (extractCaHits
   * chain "other"). They are never claimed, looked at or answered, and do not
   * count toward the first two. Absent means none.
   */
  otherChain?: string[];
  /**
   * Another chain's coin with no 0x + 40-hex address is in the line
   * (hasForeignMint || hasOtherChainLink): a Solana or Tron mint, a TON
   * address, a Sui or Aptos coin type, or another chain's chart, explorer or
   * launchpad link whose id is not an EVM address (DexScreener's lowercase
   * Solana pair links, TON and Sui pairs, a v4 pool id).
   */
  foreignMint: boolean;
  /** extractCashtags output. */
  cashtags: string[];
  /** The line addresses the bot (mention, reply, name). */
  addressed: boolean;
  /**
   * The last moment a line answering this post can still go out (epoch ms):
   * the handler's send window, STALE_MS after the line arrived. A post still
   * waiting on the coin lane when less than COIN_FLOW.lineMs of it is left is
   * claimed and nothing more — its lines would be dropped as stale, and a
   * look for them would spend the look allowance for nothing — and a look
   * made inside it is cut to leave that long. Absent: no window but the
   * post's own staleness (COIN_FLOW.staleMs).
   */
  replyByMs?: number;
  /**
   * True once the sender has run /forgetme since this line arrived. A look
   * takes seconds; a person forgotten meanwhile must not have their name and
   * id written back onto a memo, be tagged, be answered, or have their id
   * handed across in a nomination. Absent means never.
   */
  forgotten?: () => boolean;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

const READY: ReadonlySet<string> = new Set(["ready-paper", "ready-live"]);

const KINDS: ReadonlySet<string> = new Set<CoinKind>([
  "own",
  "cash",
  "energy",
  "stock",
  "wallet",
  "not-token",
  "curve",
  "v4-only",
  "no-pool",
  "too-new",
  "too-thin",
  "too-quiet",
  "held",
  "candidate",
  "unknown",
]);

/**
 * VERDICTS NEVER ANSWERED FROM MEMORY: a repost of such a coin gets a fresh
 * look, as if nothing were remembered.
 *
 * `not-ready` is a candidate the owner was asked about: answering it from
 * memory would be a second readiness line that skipped the readiness rate
 * limits, and once it is ready the coin should be nominated. `coins-off` was
 * never looked at. `unknown` is a look that failed: a repost is the moment
 * to try again. `wallet` and `not-token` are not Robinhood Chain coins — an
 * Ethereum or BNB token reads as a wallet here — and are never said anything
 * about. The flow no longer writes the last three or `coins-off`; a memo from
 * an older build may still carry them for its 14 days.
 */
const NOT_ANSWERED: ReadonlySet<CoinVerdict> = new Set<CoinVerdict>(["coins-off", "not-ready", "unknown", "wallet", "not-token"]);

/**
 * LOOKS THAT DO NOT SHOW A ROBINHOOD CHAIN COIN: nothing deployed at the
 * address here (a wallet, or another chain's token), something that is not a
 * token, or a look that could not be made. Silence, and no memo.
 */
const NOT_A_COIN_HERE: ReadonlySet<CoinKind> = new Set<CoinKind>(["wallet", "not-token", "unknown"]);

/** Verdicts that were a fade, for "still not sold on that one tbh". */
const FADED: ReadonlySet<CoinVerdict> = new Set<CoinVerdict>(["passed", "too-quiet", "too-thin", "curve", "v4-only"]);

/** Refusals that are a cap: "one at a time lol", once an hour. The rest are silent. */
const CAP_REFUSALS: ReadonlySet<NominateRefusal> = new Set<NominateRefusal>(["busy", "chat-rate", "sender-rate", "daily"]);

/** Room stamps the coin flow rate-limits on. */
type StampField = "lastReadyAskAtMs" | "lastReadyNudgeAtMs" | "lastReadyDmAtMs" | "lastCapLineAtMs" | "lastDropCaAtMs" | "lastCoinUnknownAtMs";

/** What `bounded` answers when the wait ran out first. */
const TIMED_OUT: unique symbol = Symbol("timed out");

/** The DM reason when the port's readiness could not be read: plain words and a Settings act, like OWNER_REASON's. */
const NO_PORT_REASON = "I can't look at coins from your groups right now: check Trencher mode in Settings.";

const SETTINGS_BUTTON = "⚙️ Open Settings";

/**
 * Per message: one reaction (Telegram keeps one per message anyway) and one
 * readiness line; and what came of it, for the handler's diagnostic line.
 */
interface PostCtx {
  reacted: boolean;
  askedOwner: boolean;
  /** A line or a reaction for this post went out. */
  acted: boolean;
  /** A CA's look came back `unknown`: the reads failed, not "another chain's". */
  unknown: boolean;
  /** Why nothing went out, the latest reason. */
  quiet?: CoinQuiet;
}

/** One post's work waiting on its chat's coin lane. */
interface LaneJob {
  /** Who is served first (CoinFlow.rankOf): higher first, then in arrival order. */
  rank: number;
  run: () => Promise<CoinPostEnd>;
  done: (end: CoinPostEnd) => void;
}

/** A chat's coin lane: the post being worked, and the posts waiting. */
interface Lane {
  busy: Promise<void> | null;
  waiting: LaneJob[];
}

/** True once the sender asked to be forgotten. A predicate that throws reads as forgotten. */
function goneOf(m: CoinPostInfo): boolean {
  try {
    return typeof m.forgotten === "function" && m.forgotten() === true;
  } catch {
    return true;
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** A stamp at least `ms` old (or none). A stamp in the future is not elapsed: a clock that went back is quieter, never louder. */
const elapsed = (at: number | undefined, t: number, ms: number): boolean => at === undefined || t - at >= ms;

const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * A display name from the port, only if it reads as a name: a letter in it,
 * no control characters, and nothing address- or mint-shaped (a name the
 * writer might repeat must never put an address back into the chat).
 */
function cleanName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = clip(v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(), 40);
  if (!s || !/\p{L}/u.test(s)) return undefined;
  if (/0x[0-9a-f]{8,}/i.test(v) || /[1-9A-HJ-NP-Za-km-z]{26,}/.test(v)) return undefined;
  return s;
}

/**
 * Brain notes, once more. The port promises `safeNotes` output (no digits,
 * `$`, `%` or addresses, ≤ 400 chars); this re-applies the cheapest part of
 * that promise so a port bug cannot put a figure in front of the writer. A
 * note that fails is dropped whole, never repaired.
 */
function cleanNotes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  let used = 0;
  for (const n of v) {
    if (typeof n !== "string") continue;
    const s = n.replace(/\s+/g, " ").trim();
    if (!s || /[\p{N}\p{Sc}%@]|0x[0-9a-f]/iu.test(s)) continue;
    const cost = s.length + (out.length ? 1 : 0);
    if (used + cost > 400) break;
    out.push(s);
    used += cost;
  }
  return out;
}

/** Well-formed CAs, lowercased, unique, in order, at most `max`. */
function cleanCas(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const a of v) {
    if (typeof a !== "string") continue;
    const ca = a.toLowerCase();
    if (!ADDRESS.test(ca) || out.includes(ca)) continue;
    out.push(ca);
    if (out.length >= max) break;
  }
  return out;
}

/** "$PEPE?", "$pepe 🚀", "$WIF $BONK": nothing but tickers, punctuation and emoji. */
function onlyCashtags(text: unknown): boolean {
  if (typeof text !== "string" || !text.includes("$")) return false;
  const rest = text.normalize("NFKC").replace(/\$[a-z][a-z0-9]{1,9}/gi, " ");
  return !/[\p{L}\p{N}]/u.test(rest);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A well-formed outcome, lowercased, or null. The port is trusted, but not to be shaped right. */
function cleanOutcome(o: unknown): CoinOutcome | null {
  if (typeof o !== "object" || o === null) return null;
  const x = o as Record<string, unknown>;
  const address = typeof x.address === "string" ? x.address.toLowerCase() : "";
  if (!ADDRESS.test(address) || !isInt(x.chatId) || !isInt(x.messageId)) return null;
  const where = { address, chatId: x.chatId, messageId: x.messageId };
  const decisionId = typeof x.decisionId === "string" && x.decisionId.trim() ? x.decisionId : undefined;
  switch (x.kind) {
    case "bought":
      return { kind: "bought", ...where, paper: x.paper === true, decisionId: decisionId ?? "", notes: cleanNotes(x.notes) };
    case "passed":
      return { kind: "passed", ...where, decisionId: decisionId ?? "", notes: cleanNotes(x.notes) };
    case "skipped":
      return decisionId ? { kind: "skipped", ...where, decisionId } : { kind: "skipped", ...where };
    case "expired":
      return { kind: "expired", ...where };
    case "exited":
      return { kind: "exited", ...where, notes: cleanNotes(x.notes) };
    default:
      return null;
  }
}

/**
 * THE COIN FLOW for one agent's Telegram groups.
 *
 * `onPost` is called by the group handler for every line in an approved room
 * (after it is remembered), `onOutcome` by the port subscription `start()`
 * sets up, and `fadedCoinIn` by the handler when it wonders whether a line is
 * hyping a coin it already faded.
 */
export class CoinFlow {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The port currently subscribed to; `undefined` means "not checked yet, or the subscribe failed". */
  private port: TgCoinsPort | null | undefined = undefined;
  private unsub: (() => void) | null = null;
  /**
   * Answers from memory per `${chatId}:${address}` (COIN_FLOW.seenLineMs), and
   * whether a repost inside the window already got its 👀. In memory: TgRoom
   * has no field for it, and a restart costs one extra line at most.
   */
  private readonly seenSaidAt = new Map<string, { at: number; eyed: boolean }>();
  /**
   * Each chat's coin lane: one post worked at a time, the rest waiting in the
   * order they are served (onLane). A chat with nothing on its lane has no
   * entry.
   */
  private readonly lanes = new Map<number, Lane>();
  /**
   * Acks still going out, per `${chatId}:${address}`. An outcome for that coin
   * waits for its ack, so "ok grabbed a little" never lands before "hmm
   * lemme look".
   */
  private readonly acks = new Map<string, Promise<unknown>>();
  /** stop() was called: work still on a lane does nothing more. */
  private halted = false;
  /** Outcomes heard through the port and still being said, so drain() can wait for them. */
  private readonly hearing = new Set<Promise<void>>();

  constructor(private readonly d: CoinFlowDeps) {}

  /** Subscribe to outcomes, and keep re-checking the port every minute (unref'd). Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchPort();
    this.timer = setInterval(() => this.watchPort(), COIN_FLOW.portCheckMs);
    this.timer.unref?.();
  }

  /** Unsubscribe and stop the timer. Outcomes that arrive after this are not heard. */
  stop(): void {
    this.running = false;
    this.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.dropSubscription();
    this.port = undefined;
  }

  /**
   * One line of an approved room. "handled" means the coin flow owns the
   * message and the handler should not also answer it: it carried a CA
   * (whatever happened to it: another chain's, a replay, silence), a Solana
   * mint (always silence), or a ticker the flow answered with "drop the ca".
   * Owning another chain's coin is how it stays unanswered: the chatter path
   * would otherwise talk about it. A ticker the flow said nothing to is
   * ordinary chatter ("none"), so an addressed "@bot $PEPE?" can still get a
   * normal answer once "drop the ca" has been used up for the hour.
   */
  async onPost(chatId: number, line: TgLine, m: CoinPostInfo): Promise<"handled" | "none"> {
    const post = await this.begin(chatId, line, m);
    await post.done;
    return post.owned;
  }

  /**
   * `onPost` WITHOUT WAITING FOR THE READS: what the handler calls from the
   * chat's serial queue. Whether the flow owns the line is decided here and at
   * once — nothing that decides it needs a read — and the rest of the post's
   * work goes on this chat's coin lane (`done`), so a look that hangs never
   * holds the chat's next line. At-most-once is unchanged: each CA is still
   * claimed on disk before anything else happens to it, on the lane, in order.
   * A "$PEPE?" with no CA is answered here ("drop the ca" reads nothing).
   * Never throws, and `done` never rejects.
   */
  async begin(chatId: number, line: TgLine, m: CoinPostInfo): Promise<CoinPostStart> {
    const none: CoinPostStart = { owned: "none", done: Promise.resolve({ acted: false }) };
    let owned = false;
    try {
      this.watchPort();
      if (!this.approvedRoom(chatId) || !line || typeof line !== "object" || !m || typeof m !== "object") return none;
      const posted = cleanCas(m.cas, COIN_FLOW.maxPosted);
      if (posted.length === 0) {
        const r = await this.noCa(chatId, line, m);
        return { owned: r.owned, done: Promise.resolve(r.end) };
      }
      owned = true;
      // A CA in another chain's link is set aside before the first two are
      // counted: "live on eth, bsc and robinhood" with three links still gets
      // its Robinhood coin looked at. Set aside means untouched: no claim, no
      // look, no memo — there is nothing a replay of it could repeat.
      const elsewhere = new Set(cleanCas(m.otherChain, COIN_FLOW.maxPosted));
      const cas = posted.filter((a) => !elsewhere.has(a)).slice(0, COIN_FLOW.maxCas);
      if (cas.length === 0) return { owned: "handled", done: Promise.resolve({ acted: false, quiet: "coin-not-here" }) };
      const rank = this.rankOf(m);
      // A FULL LANE sheds the posts nobody asked about: claimed, so a replay
      // repeats nothing, and nothing more — never looked at, so never shown
      // to be a Robinhood Chain coin, nominated or remembered, like a stale one.
      if (rank === 0 && (this.lanes.get(chatId)?.waiting.length ?? 0) >= COIN_FLOW.laneMax) {
        for (const address of cas) this.d.store.claim(chatId, line.messageId, address);
        return { owned: "handled", done: Promise.resolve({ acted: false, quiet: "coin-busy" }) };
      }
      return { owned: "handled", done: this.onLane(chatId, rank, () => this.work(chatId, line, m, cas)) };
    } catch (e) {
      this.fail("post", e);
      return owned ? { owned: "handled", done: Promise.resolve({ acted: false, quiet: "send-failed" }) } : none;
    }
  }

  /** Resolves once every post's work on a lane, and every outcome being said, has settled. For tests and shutdown. */
  async drain(): Promise<void> {
    for (let i = 0; i < 1_000 && !this.idle(); i++) {
      await Promise.allSettled([...[...this.lanes.values()].map((l) => l.busy ?? Promise.resolve()), ...this.hearing]);
    }
  }

  /** Nothing on any lane, and no outcome being said. */
  idle(): boolean {
    return this.lanes.size === 0 && this.hearing.size === 0;
  }

  /** One post's CAs, in order, on its chat's lane. */
  private async work(chatId: number, line: TgLine, m: CoinPostInfo, cas: readonly string[]): Promise<CoinPostEnd> {
    const ctx: PostCtx = { reacted: false, askedOwner: false, acted: false, unknown: false };
    for (const address of cas) {
      if (this.halted) break;
      // The first CA's look may have taken seconds, and this post may have
      // waited behind another one's: a room left meanwhile gets nothing
      // more, not even a claim, and neither does someone forgotten meanwhile.
      if (!this.approvedRoom(chatId)) {
        ctx.quiet = "room-not-approved";
        break;
      }
      if (goneOf(m)) {
        ctx.quiet = "forgotten";
        break;
      }
      // Each CA on its own: a failure with the first must not cost the second its claim.
      try {
        if (!this.d.store.claim(chatId, line.messageId, address)) {
          ctx.quiet = "coin-replay";
          continue;
        }
        await this.oneCa(chatId, line, m, address, ctx);
      } catch (e) {
        this.fail("post", e);
      }
    }
    if (!this.halted && !ctx.acted && ctx.unknown && m.addressed === true) await this.cannotLook(chatId, line, m, ctx);
    return ctx.acted ? { acted: true } : { acted: false, ...(ctx.quiet ? { quiet: ctx.quiet } : {}) };
  }

  /**
   * Put `job` on this chat's coin lane. One post at a time per chat, so a
   * coin's second post finds the first one's memo; parallel across chats and
   * apart from the handler's chatter queue. Of the posts waiting, the highest
   * `rank` goes next and equals go in arrival order: an owner asking about a
   * CA is not served after a shill's backlog. Never rejects.
   */
  private onLane(chatId: number, rank: number, job: () => Promise<CoinPostEnd>): Promise<CoinPostEnd> {
    return new Promise<CoinPostEnd>((done) => {
      let lane = this.lanes.get(chatId);
      if (!lane) this.lanes.set(chatId, (lane = { busy: null, waiting: [] }));
      lane.waiting.push({ rank, run: job, done });
      this.nextOnLane(chatId);
    });
  }

  /** Start the next post on this chat's lane when none is being worked; drop the lane once it is empty. */
  private nextOnLane(chatId: number): void {
    const lane = this.lanes.get(chatId);
    if (!lane || lane.busy) return;
    let at = -1;
    for (let i = 0; i < lane.waiting.length; i++) if (at < 0 || lane.waiting[i]!.rank > lane.waiting[at]!.rank) at = i;
    const job = at >= 0 ? lane.waiting.splice(at, 1)[0] : undefined;
    if (!job) {
      this.lanes.delete(chatId);
      return;
    }
    lane.busy = (async () => {
      let end: CoinPostEnd;
      try {
        end = await job.run();
      } catch (e) {
        this.fail("post", e);
        end = { acted: false, quiet: "send-failed" };
      }
      job.done(end);
    })().finally(() => {
      lane.busy = null;
      this.nextOnLane(chatId);
    });
  }

  /**
   * Who is served first on the lane: a post that addresses the agent (2), the
   * owner's (1), both (3), anyone else's (0). Read off the post, never its text.
   */
  private rankOf(m: CoinPostInfo): number {
    const owner = this.ownerIdNow();
    return (m.addressed === true ? 2 : 0) + (owner !== null && m.senderId === owner ? 1 : 0);
  }

  /**
   * How long this post's reply window has left (CoinPostInfo.replyByMs), or
   * Infinity when it has none.
   */
  private windowLeft(m: CoinPostInfo): number {
    return isNum(m.replyByMs) ? m.replyByMs - this.d.now() : Infinity;
  }

  /**
   * "CAN'T PULL THAT ONE UP RN". Someone asked it about a CA and the look
   * could not be made: the reads failed or timed out, not "another chain's
   * coin" (that is `wallet` and stays silent). Leaving the person who asked on
   * read is what made the agent look broken, so it says so, casually, from a
   * template: no verdict, no reason, nothing about which chain. At most once
   * per chat per COIN_FLOW.unknownLineMs; nothing is remembered, so a repost
   * gets a fresh look.
   */
  private async cannotLook(chatId: number, line: TgLine, m: CoinPostInfo, ctx: PostCtx): Promise<void> {
    ctx.quiet = "coin-unknown";
    if (goneOf(m) || !this.approvedRoom(chatId) || !this.coinsOn()) return;
    const tag = isInt(m.senderId) && typeof m.senderName === "string" && m.senderName ? { id: m.senderId, name: m.senderName } : undefined;
    await this.once(
      chatId,
      "lastCoinUnknownAtMs",
      (r, t) => elapsed(r.lastCoinUnknownAtMs, t, COIN_FLOW.unknownLineMs),
      () => this.say(chatId, { kind: "coin-unknown" }, { replyTo: line.messageId, trigger: line, ...(tag ? { mention: tag } : {}) }, ctx),
    );
  }

  /**
   * What the trading side reported for a nominated coin. Routed by the memo
   * (chat + address, else the decision id), so it goes to the chat the coin
   * was posted in, tags whoever posted it and replies to their post — not to
   * whoever happened to speak last.
   */
  async onOutcome(o: CoinOutcome): Promise<void> {
    try {
      const out = cleanOutcome(o);
      if (!out) return;
      const found = this.memoFor(out);
      if (!found) return;
      const { chatId, memo } = found;
      const room = this.approvedRoom(chatId);
      if (!room) return;
      // A different chat means a migrated one: message ids do not carry over
      // to the supergroup, so it is said without the reply.
      const replyTo = chatId === out.chatId ? memo.messageId : undefined;
      const trigger = room.lines.find((l) => l.messageId === memo.messageId && !l.own);
      const opts: CoinSpeakOpts = {
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(memo.byName ? { mention: { id: memo.byId, name: memo.byName } } : {}),
        ...(trigger ? { trigger } : {}),
        ...(memo.name ? { coinName: memo.name } : {}),
      };
      // The owner switched coin lines off after this one was nominated: the
      // verdict is still remembered, the chat hears nothing.
      const quiet = !this.coinsOn();
      const address = memo.address;

      if (out.kind === "exited") {
        // At most one exit line per coin, ever, and only for one the chat heard bought.
        if (memo.verdict !== "bought" || memo.exitSaid) return;
        this.d.store.updateCoin(chatId, address, { exitSaid: true });
        if (!quiet) await this.say(chatId, { kind: "coin-exited", notes: out.notes }, opts);
        return;
      }

      // Every nomination gets one outcome; a second one (or one for a memo
      // that was never a nomination) is ignored. The verdict moves BEFORE the
      // line is awaited, so a duplicate arriving meanwhile finds it moved.
      if (memo.verdict !== "candidate") return;
      // Its ack may still be going out (a fast Brain): the verdict moves now,
      // the line waits for the ack (ackOf).
      const ack = this.ackOf(chatId, out.chatId, memo.address);
      switch (out.kind) {
        case "bought":
          this.d.store.updateCoin(chatId, address, {
            verdict: "bought",
            ...(out.decisionId ? { decisionId: out.decisionId } : {}),
            paper: out.paper ? true : undefined,
          });
          if (ack) await ack;
          if (!quiet) await this.say(chatId, { kind: "coin-bought", paper: out.paper, notes: out.notes }, opts);
          return;
        case "passed":
          this.d.store.updateCoin(chatId, address, {
            verdict: "passed",
            ...(out.decisionId ? { decisionId: out.decisionId } : {}),
          });
          if (ack) await ack;
          if (!quiet) await this.say(chatId, { kind: "coin-passed", notes: out.notes }, opts);
          return;
        case "skipped":
          this.d.store.updateCoin(chatId, address, {
            verdict: "skipped",
            ...(out.decisionId ? { decisionId: out.decisionId } : {}),
          });
          if (ack) await ack;
          if (!quiet) await this.say(chatId, { kind: "coin-skipped" }, opts);
          return;
        case "expired": {
          this.d.store.updateCoin(chatId, address, { verdict: "expired" });
          if (ack) await ack;
          // "or silence if the chat moved on": nobody has spoken for half an
          // hour, so a line about a coin from then would be talking to itself.
          const t = this.d.now();
          const live = room.lines.some((l) => !l.own && t - l.atMs <= COIN_FLOW.expiredLiveMs);
          if (!quiet && live) await this.say(chatId, { kind: "coin-skipped" }, opts);
          return;
        }
      }
    } catch (e) {
      this.fail("outcome", e);
    }
  }

  /**
   * A coin it faded in this chat whose name is said as a whole word in
   * `text` (the newest such memo), or null. The handler decides whether to
   * say "faded-again"; this only finds the memo. A copy, so the caller cannot
   * change the stored one by accident.
   */
  fadedCoinIn(chatId: number, text: string): TgCoinMemo | null {
    try {
      const room = this.approvedRoom(chatId);
      if (!room || typeof text !== "string" || !text) return null;
      const hay = text.normalize("NFKC");
      let best: TgCoinMemo | null = null;
      for (const memo of room.coins) {
        if (!FADED.has(memo.verdict) || !memo.name) continue;
        const name = memo.name.normalize("NFKC").trim();
        // A two-letter name ("ok", "gm") would match half the chat.
        if ([...name].length < 3 || !/\p{L}/u.test(name)) continue;
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, "iu");
        if (re.test(hay) && (!best || memo.atMs > best.atMs)) best = memo;
      }
      return best ? { ...best } : null;
    } catch (e) {
      this.fail("faded", e);
      return null;
    }
  }

  // ─── A line with no CA ────────────────────────────────────────────────────

  private async noCa(chatId: number, line: TgLine, m: CoinPostInfo): Promise<{ owned: "handled" | "none"; end: CoinPostEnd }> {
    const none = { owned: "none" as const, end: { acted: false } };
    // ANOTHER CHAIN'S COIN with no EVM address (a Solana mint, a TON
    // address, a DexScreener Solana pair link…). Owned, so the chatter path
    // does not talk about it either, and nothing is said: coins on or off,
    // fresh or stale. Not "drop the ca" for a ticker beside it: they did drop one.
    if (m.foreignMint === true) return { owned: "handled", end: { acted: false, quiet: "coin-not-here" } };
    // Coins off is "no look, no ask": asking for a CA is asking to look.
    if (!this.coinsOn()) return none;
    // An old line from a redelivered batch gets no coin line either.
    if (this.isStale(line, m)) return none;
    const tags = Array.isArray(m.cashtags) ? m.cashtags.filter((t) => typeof t === "string" && t.length > 0) : [];
    if (tags.length === 0) return none;
    if (m.addressed !== true && !onlyCashtags(line.text)) return none;
    const said = await this.once(
      chatId,
      "lastDropCaAtMs",
      (r, t) => elapsed(r.lastDropCaAtMs, t, COIN_FLOW.dropCaMs),
      () => this.say(chatId, { kind: "drop-ca" }, { replyTo: line.messageId, trigger: line }),
    );
    return said ? { owned: "handled", end: { acted: true } } : none;
  }

  // ─── One claimed CA ───────────────────────────────────────────────────────

  private async oneCa(chatId: number, line: TgLine, m: CoinPostInfo, address: string, ctx: PostCtx): Promise<void> {
    const d = this.d;
    const postedAt = this.postedAt(line, m);
    // Asked at every step, not once: a look takes seconds, and /forgetme
    // can land while it is out. A predicate that throws reads as forgotten.
    const gone = (): boolean => goneOf(m);
    const hush = (why: CoinQuiet): void => {
      ctx.quiet = why;
    };
    // Forgotten meanwhile: the coin and its verdict are kept, who posted it
    // is not, exactly as /forgetme leaves every memo it finds.
    const memo = (verdict: CoinVerdict, name?: string, coin = address): TgCoinMemo => ({
      address: coin,
      ...(name ? { name } : {}),
      byId: gone() ? 0 : m.senderId,
      byName: !gone() && typeof m.senderName === "string" ? m.senderName : "",
      messageId: line.messageId,
      atMs: postedAt,
      verdict,
    });
    const tagSender = (): CoinSpeakOpts["mention"] =>
      !gone() && isInt(m.senderId) && typeof m.senderName === "string" && m.senderName ? { id: m.senderId, name: m.senderName } : undefined;
    // Nothing is said, or reacted, to a post whose sender asked to be forgotten.
    const say = (intent: CoinIntent, o: CoinSpeakOpts): Promise<boolean> => {
      if (gone()) {
        hush("forgotten");
        return Promise.resolve(false);
      }
      return this.say(chatId, intent, o, ctx);
    };
    const eyes = (): Promise<void> => (gone() ? Promise.resolve() : this.eyes(chatId, line.messageId, ctx));

    // 1. Stale: claimed, and nothing more. Never looked at, so never shown to
    // be a Robinhood Chain coin: not nominated, not answered, not remembered.
    // An existing memo is kept — it may be waiting for an outcome, and this
    // post changes nothing. The same for a post that waited on the lane until
    // its reply window ran out: every line for it would be dropped as stale,
    // and a look for them would spend the look allowance for nothing.
    if (this.isStale(line, m) || this.windowLeft(m) < COIN_FLOW.lineMs) return hush("coin-stale");

    // 2. Coins off: silence, not even a 👀 — without a look nothing shows
    // this is a Robinhood Chain coin at all — and no answer from memory
    // either, which is a coin opinion too.
    if (!this.coinsOn()) return hush("coin-off");

    // 3. Seen here within 24 h as a Robinhood Chain coin: answered from
    // memory, replying to the new post. The memo stays the original one: it
    // names who posted it first and is the one an outcome still on its way
    // will look for.
    const prior = d.store.coin(chatId, address, COIN_FLOW.seenMs);
    if (prior && !NOT_ANSWERED.has(prior.verdict)) {
      await this.fromMemory(chatId, address, line, prior, say, eyes, ctx);
      return;
    }

    // 4. The quick look, READY OR NOT: it is what says whether the address is
    // a Robinhood Chain coin, and the port's look does not depend on trencher
    // mode. No port, no look, and nothing to say. Bounded: a look that never
    // answers is `unknown` after COIN_FLOW.lookMs.
    const port = this.portNow();
    if (!port) return hush("coin-no-port");
    // Inside the reply window, leaving a line the time it needs; a window
    // with no room for a look worth making is past answering.
    const lookMs = Math.min(COIN_FLOW.lookMs, this.windowLeft(m) - COIN_FLOW.lineMs);
    if (lookMs < COIN_FLOW.lookMinMs) return hush("coin-stale");
    const look = await this.lookAt(port, address, lookMs);
    // The look took a while: the room may have been left, or coins switched off.
    if (!this.approvedRoom(chatId)) return hush("room-not-approved");
    if (!this.coinsOn()) return hush("coin-off");
    // Not a Robinhood Chain coin (a wallet, another chain's token: no code
    // here), not a token, or not provably anything: silence, and no memo, so
    // nothing is ever said from it and a repost gets a fresh look. A look
    // that could not be made is noted: an addressed post whose looks all
    // failed gets "can't pull that one up rn" (cannotLook), never a verdict.
    if (look.kind === "unknown") {
      ctx.unknown = true;
      return hush("coin-unknown");
    }
    if (NOT_A_COIN_HERE.has(look.kind)) return hush("coin-not-here");
    const coinName = look.name ? { coinName: look.name } : {};

    // A CHART LINK CARRIES THE POOL. When the look proved the posted address
    // is the pool of a coin, that coin is the one remembered, answered from
    // memory and nominated from here on. The pool's claim above still stops a
    // replay of this post; the coin is claimed for this post too, so the coin
    // posted beside its own chart link is one coin, not two.
    const coin = look.address ?? address;
    if (coin !== address) {
      if (!d.store.claim(chatId, line.messageId, coin)) return hush("coin-replay");
      const seen = d.store.coin(chatId, coin, COIN_FLOW.seenMs);
      if (seen && !NOT_ANSWERED.has(seen.verdict)) {
        await this.fromMemory(chatId, coin, line, seen, say, eyes, ctx);
        return;
      }
    }

    // 5. A Robinhood Chain coin. Readiness decides only what a candidate
    // gets: the owner ask while not ready, a nomination once ready. Every
    // other kind is its grounded line either way (asking the owner to switch
    // trencher mode on would not get a thin or a curve coin bought).
    if (look.kind === "held") {
      d.store.rememberCoin(chatId, memo("held", look.name, coin));
      const tag = tagSender();
      await say({ kind: "coin-seen", verdict: "held" }, { replyTo: line.messageId, trigger: line, ...(tag ? { mention: tag } : {}), ...coinName });
      return;
    }
    if (look.kind !== "candidate") {
      d.store.rememberCoin(chatId, memo(look.kind, look.name, coin));
      const tag = tagSender();
      await say({ kind: "coin-look", look: look.kind }, { replyTo: line.messageId, trigger: line, ...(tag ? { mention: tag } : {}), ...coinName });
      return;
    }

    // Not ready: a coin trencher mode could trade, so the owner ask (group)
    // and the reason (DM). Remembered as not-ready, so a repost once it is
    // ready is looked at and nominated rather than answered from memory.
    // Read now, after the look: the owner may have switched it on meanwhile.
    const readiness = this.readinessOf(port);
    if (!readiness || !READY.has(readiness.kind)) {
      d.store.rememberCoin(chatId, memo("not-ready", look.name, coin));
      if (gone()) return hush("forgotten");
      await this.askOwner(chatId, line, readiness, ctx);
      return;
    }

    // Forgotten while the look was out: their id is not handed across in a
    // nomination either. No memo, like a capped coin: nothing was reviewed,
    // and a later post of it gets its turn.
    if (gone()) return hush("forgotten");

    // 6. Nominate: the address and where it came from, nothing else.
    const res = this.nominateVia(port, {
      address: coin,
      chatId,
      messageId: line.messageId,
      senderId: m.senderId,
      atMs: postedAt,
    });
    if (res.ok) {
      // 7. Ack, thinking out loud; the verdict comes with the outcome, which
      // waits for this ack to settle (ackFirst) so the two never swap places.
      d.store.rememberCoin(chatId, memo("candidate", look.name, coin));
      const tag = tagSender();
      const k = `${chatId}:${coin}`;
      const ack = say({ kind: "coin-ack" }, { replyTo: line.messageId, trigger: line, ...(tag ? { mention: tag } : {}), ...coinName });
      this.acks.set(k, ack);
      try {
        await ack;
      } finally {
        if (this.acks.get(k) === ack) this.acks.delete(k);
      }
      return;
    }
    if (CAP_REFUSALS.has(res.reason)) {
      // No memo: a capped coin was not looked at by the Brain, and a repost
      // once the queue has room should get its turn rather than an answer
      // from memory.
      const said = await this.once(
        chatId,
        "lastCapLineAtMs",
        (r, t) => elapsed(r.lastCapLineAtMs, t, COIN_FLOW.capLineMs),
        () => say({ kind: "coin-cap" }, { replyTo: line.messageId, trigger: line }),
      );
      if (!said) hush("coin-rate");
      return;
    }
    if (res.reason === "recent") {
      // Recent in the book. Answered from memory only when the memory is this
      // chat's: a coin another group nominated is never mentioned here.
      const mine = d.store.coin(chatId, coin);
      if (mine && !NOT_ANSWERED.has(mine.verdict)) await this.fromMemory(chatId, coin, line, mine, say, eyes, ctx);
      else hush("coin-refused");
      return;
    }
    // invalid / not-ready (readiness changed during the look): silence.
    hush("coin-refused");
  }

  /**
   * AN ANSWER FROM MEMORY, at most once per coin per chat per
   * COIN_FLOW.seenLineMs. A repost inside the window gets one 👀 (the first
   * such repost) and then nothing: a shill reposting a CA every twenty
   * seconds is not a conversation. Reserved before the send and given back
   * when it did not go out, like every rate-limited line here.
   */
  private async fromMemory(
    chatId: number,
    address: string,
    line: TgLine,
    memo: TgCoinMemo,
    say: (intent: CoinIntent, o: CoinSpeakOpts) => Promise<boolean>,
    eyes: () => Promise<void>,
    ctx: PostCtx,
  ): Promise<void> {
    const k = `${chatId}:${address}`;
    const t = this.d.now();
    const prev = this.seenSaidAt.get(k);
    if (prev && !elapsed(prev.at, t, COIN_FLOW.seenLineMs)) {
      if (!prev.eyed) {
        prev.eyed = true;
        await eyes();
      }
      if (!ctx.acted) ctx.quiet = "coin-rate";
      return;
    }
    const mine = { at: t, eyed: false };
    this.seenSaidAt.set(k, mine);
    const ok = await say(
      { kind: "coin-seen", verdict: this.seenVerdict(memo) },
      { replyTo: line.messageId, trigger: line, ...(memo.name ? { coinName: memo.name } : {}) },
    );
    if (!ok && this.seenSaidAt.get(k) === mine) {
      if (prev) this.seenSaidAt.set(k, prev);
      else this.seenSaidAt.delete(k);
    }
    // Bounded like the store's 30 chats of 60 coins: old stamps decide nothing.
    if (this.seenSaidAt.size > 512) {
      for (const [key, v] of this.seenSaidAt) if (elapsed(v.at, t, COIN_FLOW.seenLineMs)) this.seenSaidAt.delete(key);
    }
  }

  /**
   * THE OWNER ASK. In the group, tagging the owner, a fixed line with no
   * reason, at most once per chat per 12 h; later CAs get a light line at most
   * once an hour (counted from the ask as well, so the two never land minutes
   * apart), else a 👀. In the owner's DM, the private reason and a Settings
   * button, once per chat per 12 h. One readiness line per message: the
   * second CA of a post that already asked says nothing more.
   */
  private async askOwner(chatId: number, line: TgLine, readiness: TrencherReadiness | null, ctx: PostCtx): Promise<void> {
    if (ctx.askedOwner) return;
    ctx.askedOwner = true;
    const ownerId = this.ownerIdNow();
    // Never linked: nobody to tag and nobody to DM.
    if (ownerId === null) {
      await this.eyes(chatId, line.messageId, ctx);
      return;
    }
    const room = this.d.store.room(chatId);
    if (!room) return;
    const ownerName = room.ownerName || "boss";

    let said = await this.once(
      chatId,
      "lastReadyAskAtMs",
      (r, t) => elapsed(r.lastReadyAskAtMs, t, COIN_FLOW.readyAskMs),
      () =>
        this.say(
          chatId,
          { kind: "ready-ask" },
          { replyTo: line.messageId, mention: { id: ownerId, name: ownerName }, trigger: line },
          ctx,
        ),
    );
    if (!said) {
      said = await this.once(
        chatId,
        "lastReadyNudgeAtMs",
        (r, t) =>
          elapsed(r.lastReadyNudgeAtMs, t, COIN_FLOW.readyNudgeMs) && elapsed(r.lastReadyAskAtMs, t, COIN_FLOW.readyNudgeMs),
        () => this.say(chatId, { kind: "ready-nudge" }, { replyTo: line.messageId, trigger: line }, ctx),
      );
    }
    if (!said) await this.eyes(chatId, line.messageId, ctx);
    if (!ctx.acted) ctx.quiet = "coin-rate";

    // The DM is about this room: a room left while the line was typing is not asked about.
    if (!this.approvedRoom(chatId)) return;
    await this.once(
      chatId,
      "lastReadyDmAtMs",
      (r, t) => elapsed(r.lastReadyDmAtMs, t, COIN_FLOW.readyDmMs),
      () => this.dmReady(room.title, readiness),
    );
  }

  /** The owner's DM: which group, the first failing readiness row in plain words, and the Settings button. */
  private async dmReady(title: string, readiness: TrencherReadiness | null): Promise<boolean> {
    const where = title ? `«${title}»` : "one of your groups";
    const reason =
      readiness && typeof readiness.ownerReason === "string" && readiness.ownerReason.trim()
        ? clip(readiness.ownerReason.trim(), 400)
        : NO_PORT_REASON;
    const text = `Someone posted a coin in ${where}. ${reason}`;
    let base = "";
    try {
      const raw = this.d.dashboardUrl();
      base = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
    } catch (e) {
      this.fail("dashboard url", e);
    }
    // A button Telegram would refuse (no scheme) would sink the whole DM; the
    // text alone still names the fix.
    const button = /^https?:\/\/\S+$/i.test(base) ? { text: SETTINGS_BUTTON, url: `${base}/settings#trencher-mode` } : undefined;
    try {
      return (await (button ? this.d.dmOwner(text, button) : this.d.dmOwner(text))) === true;
    } catch (e) {
      this.fail("owner dm", e);
      return false;
    }
  }

  // ─── Outcome routing ──────────────────────────────────────────────────────

  /**
   * The memo an outcome is about: this chat's memo for the address, else the
   * one carrying its decision id (a room that moved chat id). Either way it
   * must be the same post — a memo for the same address from another post is
   * a different nomination, and speaking for it would tag the wrong person.
   */
  private memoFor(out: CoinOutcome): { chatId: number; memo: TgCoinMemo } | undefined {
    const byChat = this.d.store.coin(out.chatId, out.address);
    if (byChat && byChat.messageId === out.messageId) return { chatId: out.chatId, memo: byChat };
    const decisionId = "decisionId" in out ? out.decisionId : undefined;
    if (!decisionId) return undefined;
    const byDecision = this.d.store.findCoinByDecision(decisionId);
    if (byDecision && byDecision.memo.address === out.address && byDecision.memo.messageId === out.messageId) return byDecision;
    return undefined;
  }

  /** A `candidate` memo past the nomination TTL is one whose outcome is not coming: it reads as `expired`. */
  private seenVerdict(memo: TgCoinMemo): CoinVerdict {
    if (memo.verdict === "candidate" && this.d.now() - memo.atMs > COIN_FLOW.candidateMaxMs) return "expired";
    return memo.verdict;
  }

  // ─── The port ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to the port `port()` returns now, when it is not the one already
   * subscribed. A trading restart hands out a new port; the old one's
   * subscription is dropped, and an outcome still arriving from it is ignored
   * (its book is gone, and silence is the safe side of a stale report).
   */
  private watchPort(): void {
    if (!this.running) return;
    const p = this.portNow();
    if (p === this.port) return;
    this.dropSubscription();
    this.port = p;
    if (!p) return;
    try {
      const unsub = p.onOutcome((o) => {
        if (!this.running || this.port !== p) return;
        const heard = this.onOutcome(o);
        this.hearing.add(heard);
        void heard.finally(() => this.hearing.delete(heard));
      });
      this.unsub = typeof unsub === "function" ? unsub : null;
    } catch (e) {
      // Retried on the next post or the next minute.
      this.port = undefined;
      this.fail("subscribe", e);
    }
  }

  private dropSubscription(): void {
    const u = this.unsub;
    this.unsub = null;
    if (!u) return;
    try {
      u();
    } catch (e) {
      this.fail("unsubscribe", e);
    }
  }

  private portNow(): TgCoinsPort | null {
    try {
      const p = this.d.port();
      return p && typeof p === "object" ? p : null;
    } catch (e) {
      this.fail("port", e);
      return null;
    }
  }

  private readinessOf(port: TgCoinsPort): TrencherReadiness | null {
    try {
      const r = port.readiness();
      return r && typeof r.kind === "string" ? r : null;
    } catch (e) {
      this.fail("readiness", e);
      return null;
    }
  }

  /** The port's look, bounded by `ms` (COIN_FLOW.lookMs, or less inside a reply window): `unknown` past it. */
  private async lookAt(port: TgCoinsPort, address: string, ms: number): Promise<CoinLook> {
    try {
      const l = await this.bounded(Promise.resolve(port.look(address)), ms);
      if (l === TIMED_OUT) {
        // The stage only: which read hung is the look's business, and the
        // address is never logged.
        this.note("[tg-groups] coin flow: look timed out");
        return { kind: "unknown" };
      }
      if (!l || typeof l !== "object" || !KINDS.has(l.kind)) return { kind: "unknown" };
      const name = cleanName(l.name);
      // The coin a posted pool trades: well-formed like any CA, or not passed on.
      const coin = typeof l.address === "string" ? l.address.toLowerCase() : "";
      return {
        kind: l.kind,
        ...(name ? { name } : {}),
        ...(ADDRESS.test(coin) && coin !== address ? { address: coin } : {}),
      };
    } catch (e) {
      this.fail("look", e);
      return { kind: "unknown" };
    }
  }

  private nominateVia(port: TgCoinsPort, n: Nomination): NominateResult {
    try {
      const r = port.nominate(n);
      if (r && r.ok === true) return { ok: true };
      if (r && r.ok === false && typeof r.reason === "string") return { ok: false, reason: r.reason };
    } catch (e) {
      this.fail("nominate", e);
    }
    return { ok: false, reason: "invalid" };
  }

  // ─── Small pieces ─────────────────────────────────────────────────────────

  private approvedRoom(chatId: number): TgRoom | undefined {
    const room = this.d.store.room(chatId);
    return room && room.status === "approved" ? room : undefined;
  }

  /** Off when the switch cannot be read: the quiet side. */
  private coinsOn(): boolean {
    try {
      return this.d.coinsEnabled() === true;
    } catch (e) {
      this.fail("coins switch", e);
      return false;
    }
  }

  private ownerIdNow(): number | null {
    try {
      const id = this.d.ownerId();
      return isInt(id) ? id : null;
    } catch (e) {
      this.fail("owner id", e);
      return null;
    }
  }

  /** When the post was made: Telegram's `date`, else the line's own stamp, else now. */
  private postedAt(line: TgLine, m: CoinPostInfo): number {
    if (isNum(m.dateSec)) return m.dateSec * 1000;
    if (isNum(line.atMs)) return line.atMs;
    return this.d.now();
  }

  private isStale(line: TgLine, m: CoinPostInfo): boolean {
    return this.d.now() - this.postedAt(line, m) > COIN_FLOW.staleMs;
  }

  /**
   * One line in an approved room. False (never a throw) when it did not go
   * out. With the post's ctx, what came of it is noted there.
   */
  private async say(chatId: number, intent: CoinIntent, o: CoinSpeakOpts, ctx?: PostCtx): Promise<boolean> {
    let ok = false;
    if (!this.approvedRoom(chatId)) {
      if (ctx) ctx.quiet = "room-not-approved";
      return false;
    }
    try {
      ok = (await this.d.speak(chatId, intent, o)) === true;
    } catch (e) {
      this.fail("speak", e);
    }
    if (ctx) {
      if (ok) ctx.acted = true;
      else ctx.quiet = "send-failed";
    }
    return ok;
  }

  /** 👀 on the post, once per message, in an approved room. */
  private async eyes(chatId: number, messageId: number, ctx: PostCtx): Promise<void> {
    if (ctx.reacted) return;
    ctx.reacted = true;
    if (!this.approvedRoom(chatId)) return;
    try {
      if ((await this.d.react(chatId, messageId, "👀")) === true) ctx.acted = true;
    } catch (e) {
      this.fail("react", e);
    }
  }

  /**
   * An outcome never goes out ahead of its own ack ("ok grabbed a little"
   * before "hmm lemme look" reads backwards): the ack still going out for
   * this coin, to wait for, or null when there is none — no wait at all then,
   * so an outcome's line starts exactly when it did before. The ack is
   * bounded like any line (typing, the flood pacer, staleness), so neither is
   * this wait.
   */
  private ackOf(chatId: number, postedIn: number, address: string): Promise<unknown> | null {
    const pending = [...new Set([chatId, postedIn])]
      .map((id) => this.acks.get(`${id}:${address}`))
      .filter((a): a is Promise<unknown> => a !== undefined);
    return pending.length === 0 ? null : Promise.allSettled(pending);
  }

  /**
   * `p`, or TIMED_OUT once `ms` have passed, whichever comes first. Real time
   * unless the deps hand a timer; a real timer never keeps the process up and
   * is cleared as soon as `p` settles.
   */
  private bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    const timer = this.d.timer;
    if (typeof timer === "function") {
      let over: Promise<typeof TIMED_OUT>;
      try {
        over = Promise.resolve(timer(ms)).then(
          () => TIMED_OUT,
          () => TIMED_OUT,
        );
      } catch {
        over = Promise.resolve(TIMED_OUT);
      }
      return Promise.race([p, over]);
    }
    return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
      const t = setTimeout(() => resolve(TIMED_OUT), ms);
      t.unref?.();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  /**
   * Reserve a rate-limited room stamp, act, and give the stamp back when the
   * act did not happen (see the header: reserve, then release).
   */
  private async once(
    chatId: number,
    field: StampField,
    due: (r: TgRoom, t: number) => boolean,
    act: () => Promise<boolean>,
  ): Promise<boolean> {
    const room = this.d.store.room(chatId);
    if (!room) return false;
    const t = this.d.now();
    if (!due(room, t)) return false;
    const prev = room[field];
    this.d.store.update(chatId, (r) => {
      r[field] = t;
    });
    let ok = false;
    try {
      ok = (await act()) === true;
    } catch (e) {
      this.fail("send", e);
    }
    if (!ok) {
      this.d.store.update(chatId, (r) => {
        if (r[field] !== t) return;
        if (prev === undefined) delete r[field];
        else r[field] = prev;
      });
    }
    return ok;
  }

  /** A content-free log line; a log that throws has nothing more to say. */
  private note(s: string): void {
    try {
      this.d.log(s);
    } catch {
      /* nothing more to say */
    }
  }

  /** The stage and the error class only: an error message can quote the text or the address. */
  private fail(stage: string, e: unknown): void {
    try {
      this.d.log(`[tg-groups] coin flow: ${stage} failed (${errName(e)})`);
    } catch {
      /* a log that throws has nothing more to say */
    }
  }
}
