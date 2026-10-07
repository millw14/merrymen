/**
 * Telegram groups — the shared types. The contract is docs/tg-groups.md.
 *
 * NAMING: never write the room's name (group + chat, joined or separated)
 * in code here. worker/src/groupchat/boundary.test.ts fails any worker file
 * outside groupchat/ that does. Use tgGroup / TgGroup / tg_group / tg-groups.
 *
 * Nothing in this directory imports a trading module. The coin flow reaches
 * trading only through `TgCoinsPort`, which index.ts implements, and the only
 * thing it hands across is a validated address plus where it came from.
 */

/** Where a group stands with this agent. See "Which groups it talks in". */
import type { ChatMathInput } from "../../../../packages/core/src/index";

export type TgRoomStatus = "approved" | "pending" | "left" | "blocked";

/** How much it joins in unprompted. Settings key `telegramGroupsChattiness`. */
export type Chattiness = "quiet" | "normal" | "chatty";

/** One remembered line of a chat. Its own lines carry `own: true`. */
export interface TgLine {
  messageId: number;
  fromId: number;
  /** Display name as Telegram gave it (first name, else @username), sanitised, ≤ 40 chars. */
  name: string;
  /** Message text or caption, trimmed to 400 chars. */
  text: string;
  atMs: number;
  /** message_id this line replied to, when it was a reply in the same chat. */
  replyTo?: number;
  /** True for the agent's own lines. */
  own?: boolean;
  /** Public research identity on our own answer, never a trade nomination. */
  deskAsk?: TgDeskAsk;
  /** The Telegram forum topic this line belongs to. */
  threadId?: number;
}

/** What it knows about one person, from one chat only. */
export interface TgPerson {
  id: number;
  name: string;
  /** ≤ 160 chars, written by the memory pass. Never sensitive categories. */
  note: string;
  lastSeenMs: number;
  /** Roast exchanges with this person in the current window. */
  roasts?: { count: number; sinceMs: number };
  /** Addressed answers in the current flood window. */
  answers?: { count: number; sinceMs: number };
  /** UTC day key (YYYY-MM-DD) of the last gm/gn it answered for this person. */
  greetedDay?: string;
}

/** What it decided about a coin posted in this chat. */
export type CoinVerdict =
  | "bought"
  | "passed"
  | "skipped"
  | "expired"
  | "not-ready"
  | "coins-off"
  | CoinKind;

export interface TgCoinMemo {
  /** Lowercased 0x + 40 hex. */
  address: string;
  /** Display name when known (coinDisplayName output), never address-shaped. */
  name?: string;
  byId: number;
  byName: string;
  /** message_id of the post that carried it. */
  messageId: number;
  atMs: number;
  verdict: CoinVerdict;
  /** Brain decision id for a nominated coin, once reviewed. */
  decisionId?: string;
  /** Paper when the buy was on paper. */
  paper?: boolean;
  /** Public, figure-free Brain clauses retained for an addressed follow-up. */
  notes?: string[];
  /** True once an exit line was said for it. */
  exitSaid?: boolean;
}

/** One chat's durable state. */
export interface TgRoom {
  chatId: number;
  title: string;
  status: TgRoomStatus;
  /** "group" | "supergroup". */
  kind: string;
  isForum?: boolean;
  addedById?: number;
  addedAtMs?: number;
  statusAtMs: number;
  /** A DM asking the owner Stay/Leave went out at this time (pending rooms). */
  askedOwnerAtMs?: number;
  /**
   * The owner unblocked this room (undid a Leave) at this time, and has not
   * decided on it since. Until they do, a legacy /link on the allowlist does
   * not approve it: someone else adding it back asks the owner, because their
   * Leave came after the link. Cleared when the room is approved or blocked.
   */
  unblockedAtMs?: number;
  /** Privacy-mode DM already sent for this room. */
  privacyHintSent?: boolean;
  /** The hello went out. */
  helloSaid?: boolean;
  /** Owner's first name as last seen in this chat. */
  ownerName?: string;
  shushedUntilMs?: number;
  lastOwnAtMs?: number;
  lastAmbientAtMs?: number;
  /** Ambient lines today: {day (UTC YYYY-MM-DD), n}. Reactions count 0.5. */
  ambient?: { day: string; n: number };
  /** Last trencher ask in the group / owner DM about readiness. */
  lastReadyAskAtMs?: number;
  lastReadyNudgeAtMs?: number;
  lastReadyDmAtMs?: number;
  /** "one at a time lol" / "drop the ca" once per hour. */
  lastCapLineAtMs?: number;
  lastDropCaAtMs?: number;
  /** "can't pull that one up rn": an addressed CA whose look failed, once per 10 minutes. */
  lastCoinUnknownAtMs?: number;
  /** Welcomes today. */
  welcomes?: { day: string; n: number };
  /** Model calls this hour for this chat: {hour (UTC YYYY-MM-DDTHH), n}. */
  llmHour?: { hour: string; n: number };
  lines: TgLine[];
  /** Human lines added since the last memory pass. */
  sinceSummary: number;
  lastSummaryAtMs?: number;
  summary: string;
  people: TgPerson[];
  coins: TgCoinMemo[];
  /** At-most-once claims: `${messageId}:${address}` → atMs. Pruned after 2 days. */
  claims: Record<string, number>;
}

/** The whole durable file, `<MERRYMEN_HOME>/tg-groups.json`. */
export interface TgGroupsState {
  version: 1;
  /** Keyed by String(chatId). */
  rooms: Record<string, TgRoom>;
  /** Model allowance per agent per UTC day, and the pause after provider trouble. */
  llm: { day: string; used: number; pausedUntilMs?: number };
  /** Nomination and group-entry counters (trencher-nominate.ts reads/writes through the store). */
  nominations: { day: string; n: number; entries: number };
}

// ─── The coin flow's view of trading (implemented in index.ts) ─────────────

/** First failing row of the readiness table in docs/tg-groups.md. */
export type TrencherReadinessKind =
  | "off"
  | "stocks-only"
  | "slow"
  | "no-brain"
  | "no-vault"
  | "live-off"
  | "ready-paper"
  | "ready-live";

export interface TrencherReadiness {
  kind: TrencherReadinessKind;
  /** Plain-words reason for the OWNER's DM only. Never sent to a group. */
  ownerReason: string;
}

/** What a quick look at a posted address found. */
export type CoinKind =
  | "own"
  | "cash"
  | "energy"
  | "stock"
  | "wallet"
  | "not-token"
  | "curve"
  | "v4-only"
  | "no-pool"
  | "too-new"
  | "too-thin"
  | "too-quiet"
  | "held"
  | "candidate"
  | "unknown";

export interface CoinLook {
  kind: CoinKind;
  /** Casual display name (coinDisplayName) or a stock ticker; never address-shaped. */
  name?: string;
  /**
   * The coin the look is about, lowercased 0x + 40 hex, when that is NOT the
   * address it was asked about: a chart link carries the POOL, and the look
   * resolved it to the token that pool trades (canonical-factory provenance,
   * tg-coin-look.ts). Absent means the posted address is the coin.
   */
  address?: string;
  /**
   * Which read answered, for the log line every coin post gets (never the
   * address): `free` (its own money, cash, energy, a stock, a holding: no
   * read), `cache` (a definite answer from the last 30 minutes), `chain` (the
   * presence probe or the multicall), `geckoterminal`, `dexscreener`. Absent
   * when nothing answered (`unknown`).
   */
  source?: CoinLookSource;
  /** Public index snapshot only. A quick look is not a Brain decision or a safety check. */
  research?: CoinResearch;
}

export interface CoinResearch {
  /** When the index answered. Caches retain this timestamp. */
  observedAtMs: number;
  source: "geckoterminal" | "dexscreener";
  priceUsd?: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  volume24hUsd?: number;
  priceChange24hPct?: number;
  buys24h?: number;
  sells24h?: number;
  ageMinutes?: number;
}

/** A projection of confirmed fills, with owner money and raw private reasoning omitted. */
export interface TgPublicTradeFact {
  side: "buy" | "sell";
  symbol: string;
  paper: boolean;
  /** Internal exact join to this chat's reviewed outcome. Never rendered. */
  decisionId?: string;
  /** Only a reviewed, group-safe rationale or a fixed provenance category. */
  why?: string;
}

export interface TgPublicTradesToday {
  /** UTC date YYYY-MM-DD. */
  day: string;
  /** False when a bounded read may omit earlier fills. */
  complete: boolean;
  trades: TgPublicTradeFact[];
}

/** Read-only owner-ledger projection, implemented outside the group boundary. */
export interface TgGroupFactsPort {
  tradesToday(): Promise<TgPublicTradesToday | null>;
}

/** Only these structured facts can bypass the generative voice's no-money rule. */
export type TgPublicFact =
  | { kind: "coin"; look: CoinLook; nowMs: number; reviewed?: { verdict: "bought" | "passed" | "skipped"; paper?: boolean; notes?: string[] } }
  | { kind: "trades"; data: TgPublicTradesToday; why: boolean; symbol?: string; side?: "buy" | "sell" }
  | { kind: "calculation"; input: ChatMathInput }
  | { kind: "site"; topic: "overview" | "pnl" | "trades" | "attempts" | "wallet" | "groups" | "limits" | "onboarding" | "funding" | "withdrawals" | "modes" | "v4" | "readiness" | "drawdown" | "privacy" }
  | { kind: "unavailable"; topic: "coin" | "trades" | "calculation" };

/** See CoinLook.source. */
export type CoinLookSource = "free" | "cache" | "chain" | "geckoterminal" | "dexscreener";

/** A nomination request. Nothing else crosses into trading. */
export interface Nomination {
  /** Lowercased 0x + 40 hex, validated by the caller AND by the port. */
  address: string;
  chatId: number;
  messageId: number;
  senderId: number;
  atMs: number;
}

export type NominateRefusal =
  | "busy"
  | "chat-rate"
  | "sender-rate"
  | "daily"
  | "recent"
  | "not-ready"
  | "invalid";

export type NominateResult = { ok: true } | { ok: false; reason: NominateRefusal };

/**
 * What happened to a nominated coin. `notes` are Brain clauses with no digits,
 * no `$`/`%`, no addresses, ≤ 400 chars total — ideas for the writer, never
 * wording to reuse. Empty when there is nothing safe to say.
 */
export type CoinOutcome =
  | { kind: "bought"; address: string; chatId: number; messageId: number; paper: boolean; decisionId: string; notes: string[] }
  | { kind: "passed"; address: string; chatId: number; messageId: number; decisionId: string; notes: string[] }
  | { kind: "skipped"; address: string; chatId: number; messageId: number; decisionId?: string }
  | { kind: "expired"; address: string; chatId: number; messageId: number }
  | { kind: "exited"; address: string; chatId: number; messageId: number; notes: string[] };

/**
 * The port index.ts implements and passes to startTelegram as
 * `TelegramServiceDeps.tgCoins`. Every method is safe to call at any time and
 * never throws; failures come back as `unknown` / refusals.
 */
export interface TgCoinsPort {
  readiness(): TrencherReadiness;
  /** Cheap classification, cached per address. Never nominates. */
  look(address: string): Promise<CoinLook>;
  nominate(n: Nomination): NominateResult;
  /** Subscribe to outcomes; returns an unsubscribe. */
  onOutcome(cb: (o: CoinOutcome) => void): () => void;
  /** Display names of memecoins currently held (no sizes). */
  heldNames(): string[];
  /** "paper" | "live" — for "on paper" in buy lines and the persona. */
  mode(): "paper" | "live";
}

// ─── The market desk (docs/tg-groups.md "Market analysis") ──────────────────

/**
 * What an addressed line asked the desk for. A name is a search key and an
 * address a lookup key — never a nomination: nothing a desk ask carries
 * crosses into trading (rule 1). The asker's words are not part of the ask.
 */
export type TgDeskAsk =
  | { kind: "market" }
  | { kind: "comparison"; queries: [string, string] }
  | { kind: "coin"; query: string }
  | { kind: "coin"; address: string };

export type TgDeskStance = "constructive" | "neutral" | "cautious" | "avoid";

export type TgDeskIntent = "scalp" | "entry" | "invalidation" | "targets" | "breakout" | "risk-reward" | "timeframe" | "trend" | "indicators" | "volume" | "liquidity" | "safety" | "sizing" | "prediction" | "comparison" | "news" | "execution" | "overview";

/** One reasoned read: from the Brain, the group's model, or written by code from the measurements. */
export interface TgDeskThought {
  read: string;
  stance: TgDeskStance;
  watch: string;
  invalidation: string;
  confidence?: number;
}

/** Contract-specific published background. Project claims, never verified endorsements or trading authority. */
export interface TgDeskLore {
  description: string;
  name?: string;
  source: string;
  /** Public provenance link, rendered by code and never passed to the model. */
  url?: string;
  observedAtMs: number;
}

/**
 * The desk's evidence for one ask: public index data only, measured by code.
 * Never a balance, size, P&L, address or anything from the owner's ledger
 * (rules 2 and 3) — the desk is never handed any of it.
 */
export interface TgDeskEvidence {
  kind: "market" | "coin";
  /** The coin's symbol as the index lists it, or "market". Gated before it is printed. */
  subject: string;
  /** Caption lines built by code from public metrics. */
  header: string[];
  /** The measured brief a model reasons over. Every figure a read may cite is in here. */
  brief: string;
  /** Measured prices only: indicator scores/counts cannot become entry or stop levels. */
  priceBrief?: string;
  /** Kept separate from measured figures so promotional numbers cannot license a financial claim. */
  lore?: TgDeskLore;
  /** The read written by code from the same measurements: the floor when no model answers well. */
  floor: TgDeskThought;
  /** Question-specific reads computed from these same public measurements. */
  scenarios?: Partial<Record<TgDeskIntent, TgDeskThought>>;
  /** Indicator-specific reads; missing values are stated as missing evidence. */
  indicators?: Partial<Record<"rsi" | "ema20" | "ema50" | "vwap" | "atr", TgDeskThought>>;
  /** Stable, public subject for a reply after source-line pruning or restart. */
  reference?: TgDeskAsk;
  /** "GeckoTerminal 14:05 UTC". */
  source: string;
  observedAtMs: number;
  /** The chart as PNG bytes, or null when it could not be drawn. */
  chart: Uint8Array | null;
}

export type TgDeskOutcome =
  | { ok: true; evidence: TgDeskEvidence }
  | { ok: false; why: "not-found" | "ambiguous" | "unavailable"; candidates?: string[] };

/** What the Brain is asked to think over. The question is the asker's words: untrusted. */
export interface TgDeskThinkRequest {
  kind: "market" | "coin";
  subject: string;
  question: string;
  brief: string;
  voice: string;
  /** Untrusted project background only; no source URL, contract identity or owner's data. */
  lore?: Pick<TgDeskLore, "description" | "name" | "source">;
}

// ─── Social-trading research (docs/fomo.md "Telegram groups") ───────────────

/**
 * WHAT AN ADDRESSED GROUP LINE MAY ASK THE SOCIAL-TRADING RESEARCH, as
 * tg-groups sees it. Implemented OUTSIDE this directory (worker/src/tg-fomo-port.ts)
 * over the research broker; nothing here imports that side.
 *
 * The question is the asker's words: untrusted data, and never a tenant, a
 * group id, an audience or a tool name. The port derives every one of those
 * from trusted context: the chat id Telegram delivered the line in, and a
 * fixed group audience. What comes back is coin-level public research only:
 * the port never returns a trader's handle or wallet, an address, a link, a
 * cashtag or anything about the owner's own book (rules 2 and 3), and the
 * handler still gates every line it sends.
 *
 *   null              not a research question, or research is unavailable
 *                     here: the line goes on to the desk and the persona
 *   deflect: true     a question about a trader or the owner's own research
 *                     state, which a group never hears; `text` says so
 */
/**
 * A research question a model chose for an addressed group line (route.ts),
 * already checked by code. The port turns it into one of a fixed set of
 * questions the deterministic planner answers; the only free text in it is a
 * ticker code found in the line itself.
 */
export type TgFomoRequest =
  | { kind: "leaderboard"; window?: "24h" | "7d" | "30d" | "all" }
  | { kind: "board"; board: "trending" | "graduated" | "most-held" }
  | { kind: "coin"; symbol: string; aspect: "theses" | "buyers" | "sellers" | "activity" | "research" }
  | { kind: "crowd"; side: "buy" | "sell"; window?: "24h" | "7d" | "30d" }
  | { kind: "small-coins" }
  | { kind: "about" }
  | { kind: "status" }
  /** One trader: never answered in a room (the owner's goes to her DM, handler.ts). */
  | { kind: "trader" };

/**
 * WHAT THE OWNER CAN DO WITH AN ANSWER she asked for in a group: the
 * commands, for her DM, and the line the room hears once her DM has them.
 * Written by code from the answer's own rows, never by a model.
 */
export interface TgFomoMoves {
  /** Paced per room and kind (handler.ts). */
  kind: "traders" | "coins" | "coin";
  /** Said in the room after the answer, only when the DM went through. */
  room: string;
  /** HTML for her DM. */
  dm: string;
}

/** What the owner asked about one trader: who they are, what they hold, what they traded. */
export type TgTraderAbout = "profile" | "holdings" | "trades";

export interface TgFomoAnswer {
  text: string;
  deflect: boolean;
  /** Only when the owner asked (`owner` on the ask): her next moves. */
  moves?: TgFomoMoves;
  /**
   * Only when the owner asked about one trader by name and the room was
   * deflected: the handle as the planner read it, for her DM (handler.ts).
   */
  trader?: { handle: string; about: TgTraderAbout };
  /** A deflection made before anything was looked up: it spends none of the room's research answers. */
  free?: boolean;
}

export interface TgFomoPort {
  /**
   * `timeoutMs`: what is left of the reply deadline; the port stops spending
   * when it runs out. `selfNames`: the bot's own names and @username
   * (selfNamesOf), so the line's "@thisbot" addresses the bot instead of
   * naming a trader the room would be deflected for.
   */
  ask(q: {
    text: string;
    /** A model's checked choice (route.ts): asked as its fixed question instead of the line's words. */
    request?: TgFomoRequest;
    /** The asker is the owner (trusted sender id, never through a chat): her moves come back too. */
    owner?: boolean;
    chatId: number;
    threadId?: number;
    timeoutMs?: number;
    selfNames?: readonly string[];
  }): Promise<TgFomoAnswer | null>;
  /** The owner's chat-wide forget: drop this chat's research subject memory. Never throws. */
  forget?(chatId: number): Promise<void>;
}

/** How a handoff to the owner's DM went. "gone": her line stopped being wanted first, and nothing was sent. */
export type TgOwnerOutcome = "sent" | "dm-first" | "busy" | "unavailable" | "gone";

/**
 * THE OWNER'S OWN ASKS, ANSWERED IN HER DM (service.ts builds it). A group
 * never hears one: a trader is private research (rule 3), so the room gets
 * "sent it to your DMs" once her DM has it. Only the owner's own line, by the
 * trusted sender id, reaches here, and service.ts checks that id again.
 */
export interface TgOwnerPort {
  /**
   * Read-only research on one Fomo trader, asked as a fixed question code
   * writes and answered in her DM. Never changes anything. Never throws.
   */
  research(q: {
    handle: string;
    fromId: number;
    about?: TgTraderAbout;
    /**
     * Whether her line is still wanted (a newer line of the burst, or a
     * forget, says no): checked before the lookup and again right before the
     * DM is sent, so a superseded or forgotten ask sends and writes nothing.
     */
    stillWanted?: () => boolean;
  }): Promise<TgOwnerOutcome>;
  /**
   * HER TAIL, ASKED FOR IN THE ROOM (docs/fomo.md "Tailing a trader"): the
   * same confirm card her DM gives /tail, sent to her DM, where nothing is
   * created until she presses a button on it; a stop runs as /untail would
   * there. `tail` is what code read from her line (handler.ts:
   * parseTailRequest), never the line itself; null: the line asked for a tail
   * but named no trader code could read, and her DM gets the /tail usage.
   * The room hears only where it went. Never throws.
   */
  proposeTail?(q: { tail: TgTailAsk | null; fromId: number }): Promise<TgOwnerOutcome>;
}

/** A tail read from her group line: a start with the trader and hours, or a stop (null: all of them). */
export type TgTailAsk =
  | { kind: "start"; handle: string; hours: number; clamped: boolean; take: boolean }
  | { kind: "stop"; handle: string | null };

/**
 * THE DESK, as tg-groups sees it. index.ts builds it from worker/src/desk/;
 * this directory never imports that side (it fetches, draws and calls Brain).
 */
export interface TgDeskPort {
  /** Evidence and chart for one ask. Never throws. */
  look(ask: TgDeskAsk, options?: { timeoutMs?: number }): Promise<TgDeskOutcome>;
  /**
   * The Brain's read, when the operator lets group asks spend Brain's key
   * (rule 7). Absent or null: the group's own model, else the code's floor.
   */
  think?(req: TgDeskThinkRequest, options?: { timeoutMs?: number }): Promise<TgDeskThought | null>;
}
