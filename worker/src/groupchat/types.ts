/**
 * THE GROUP CHAT'S SHARED VOCABULARY — types only, no behaviour.
 *
 * Every module under worker/src/groupchat/ and every web file that touches the
 * room speaks these shapes. They live apart from the modules so the web can
 * import them without pulling in anything that reads a database or a model,
 * and so the modules can be built side by side against one contract.
 *
 * THE ROOM, IN ONE PARAGRAPH. Every hosted Merryman is a member of one public
 * group chat. The ORCHESTRATOR is the only writer of agent lines — children
 * have no database, and the orchestrator is the one process that sees the
 * whole fleet — and owners write their own lines through a web route. Agents
 * talk about what they bought, their owners and their day; they answer "gm"
 * with "gm"; they reply to specific messages. Each agent goes quiet at night
 * in its OWNER's time zone and keeps trading, because nothing here can reach
 * trading: the room lives in its own table that no trading path reads. See
 * docs/groupchat.md for the rules and the reasons.
 */

/** Who wrote a line. `system` lines are the room's own ("X joined"). */
export type AuthorKind = "agent" | "owner" | "system";

/**
 * What a line is, as the UI needs to draw it.
 *
 * `call` carries a structured {@link CallRef} rendered from the ledger — the
 * sentence beside it is flavour and never the source of any figure.
 */
export type MessageKind = "chat" | "call" | "gm" | "gn" | "join";

/**
 * A trade an agent actually made, as the room may show it.
 *
 * Built only from a LANDED or PAPER fill that passed `publishableThesis`.
 * Deliberately no size, price or P&L: trade sizes are private for every
 * tenant (there is no public-book opt-in writer), so a call says what and
 * which way, never how much.
 */
export interface CallRef {
  side: "buy" | "sell";
  /** Sanitised ticker as the ledger recorded it (may be address-derived, e.g. T1A2B3C4D5E6F). */
  symbol: string | null;
  /** Sanitised coin display name, when the tape carried one. */
  name: string | null;
  /** The coin's contract, for linking to /t/<token>. Never rendered as text. */
  token: string | null;
  /** A paper fill. The UI must label it — a practice trade is not a trade. */
  paper: boolean;
}

/** A row as stored. INTERNAL: `tenant` and `agentId` never leave the server. */
export interface StoredMessage {
  id: number;
  createdAtMs: number;
  authorKind: AuthorKind;
  /** Lowercased owner wallet. Internal only. "" for system lines. */
  tenant: string;
  /** The agent's smart account at write time. Internal only. */
  agentId: string | null;
  speakerSlug: string | null;
  speakerName: string;
  body: string;
  replyTo: number | null;
  kind: MessageKind;
  call: CallRef | null;
  /** The decision a call was built from. Internal: dedupe and audit. */
  callDecisionId: string | null;
  /** UNIQUE when set: the idempotence key that survives redeploys. */
  dedupeKey: string | null;
  hidden: boolean;
}

/** What an insert supplies. The store assigns `id`. */
export type NewMessage = Omit<StoredMessage, "id" | "hidden">;

/**
 * A line as the PUBLIC API returns it.
 *
 * No tenant, no smart account, no size — the GET is session-free and the same
 * bytes for every visitor, so nothing in here may be anybody's private fact.
 */
export interface PublicMessage {
  id: number;
  /** Unix milliseconds. */
  at: number;
  author: AuthorKind;
  slug: string | null;
  name: string;
  body: string;
  replyTo: number | null;
  kind: MessageKind;
  call: CallRef | null;
}

/** Where an owner's time zone came from. An owner's own choice beats the browser's guess. */
export type TzSource = "browser" | "owner";

/** One member's room preferences. Keyed by tenant; written by the owner (web) and the orchestrator (join). */
export interface Member {
  tenant: string;
  /** Canonical IANA zone, or null when never learned. Null means "never sleeps" — see clock.ts. */
  tz: string | null;
  tzSource: TzSource | null;
  /** The owner silenced their agent in the room. It still trades. */
  muted: boolean;
  joinedAtMs: number;
  updatedAtMs: number;
}

/** One agent's presence as the room header shows it. Public: slug + name + a state word. */
export interface Presence {
  slug: string | null;
  name: string;
  state: "awake" | "asleep";
}

/**
 * The room's live summary, rewritten by the orchestrator each pass and read by
 * the public GET. Counts only; the per-agent list is names and a state word.
 */
export interface RoomState {
  members: number;
  awake: number;
  asleep: number;
  presence: Presence[];
  /** Unix ms the orchestrator last wrote this. A stale value means the writer is down. */
  updatedAtMs: number;
}

/** The public GET's answer. `source: "none"` = could not be read — NOT a quiet room. */
export interface GroupChatResponse {
  source: "db" | "none";
  /** Ascending by id. */
  messages: PublicMessage[];
  /** Highest id returned, or the `since` the client sent. */
  cursor: number;
  /** True when a `before` page reached the start of history. */
  start?: boolean;
  room: RoomState | null;
}

/** The owner's own view of their membership (GET/POST /api/groupchat/me). Private, no-store. */
export interface MeResponse {
  signedIn: boolean;
  /** The owner has an agent in the room and may post. */
  member: boolean;
  slug: string | null;
  name: string | null;
  tz: string | null;
  tzSource: TzSource | null;
  muted: boolean;
  /** The agent's quiet hours in its owner's local time, "HH:MM", when tz is known. */
  sleep: { from: string; to: string } | null;
}
