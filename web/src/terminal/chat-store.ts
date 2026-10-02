/**
 * THE CHAT TAB DID NOT REMEMBER A SINGLE WORD.
 *
 * `turns` was `useState<ChatTurn[]>([])` in App.tsx and nothing else. A refresh
 * lost the conversation, following a link to a token and coming back lost it,
 * and on mobile a backgrounded tab being reclaimed lost it — on the tab the
 * owner renamed CHAT, whose whole purpose is asking an agent about money it is
 * managing and reading the answer.
 *
 * KEYED ON THE SIGNED-IN ADDRESS, AND CLEARED ON SIGN-OUT. Both halves are the
 * point. A single key would hand one owner's conversation — their balances,
 * their limits, what their agent told them about their own positions — to the
 * next person to sign in on a shared machine. Keying it means the next owner
 * reads their own empty history; clearing it means the previous owner's is not
 * sitting in the browser for them to find.
 *
 * WHAT IS KEPT, NOW THAT THE CHAT IS A THREAD. The messages; the orders still
 * being followed, each with the moment to stop asking — so a reload or a
 * closed dock resumes the wait instead of losing the answer; and the watermark
 * below which the agent's own fills are history rather than news. NOT kept: a
 * trade card (only its key — the tape is re-read), a Retry chip (this
 * session's), and never a proposal — a confirmation card restored from storage
 * would be an offer to act made by nobody, on a page reopened days later.
 *
 * WHAT THIS IS NOT. Not a server-side transcript. Nothing here is uploaded,
 * nothing is shared between devices, and the agent's own memory is unaffected —
 * this is one browser remembering what it already displayed. `localStorage` is
 * the right size of promise for that, and the wrong one for anything that has
 * to survive a cleared cache.
 *
 * EVERY ACCESS IS GUARDED. `localStorage` throws outright in some contexts
 * (private windows, embedded views, browsers set to block site data) rather
 * than returning null, so a bare read is a crash on a screen that was working.
 */
import { receiptOf } from "@/lib/order-state";
import type { ChatFailure, ChatMessage, ChatTurn } from "./account";
import { MAX_MESSAGES, turnsToMessages } from "./chat-thread";

/** Storage may be absent (SSR) or throw on access; both are handled. */
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "merrymen.chat.";

/** An order still being followed, and when to stop asking — on this browser's clock. */
export interface KeptOrder {
  id: string;
  until: number;
}

export interface KeptThread {
  messages: ChatMessage[];
  orders: KeptOrder[];
  /** Epoch seconds, the tape's clock; null until the tape has been read once. */
  since: number | null;
}

const EMPTY = (): KeptThread => ({ messages: [], orders: [], since: null });

/**
 * Where this reader's conversation lives, or null if it must not be kept.
 *
 * Hosted and signed out is deliberately null: a visitor with no wallet has no
 * agent to have talked to, and writing an anonymous bucket would create the
 * shared key this whole module exists to avoid.
 */
export function chatKeyFor(session: { hosted: boolean; address: string | null } | null): string | null {
  if (!session) return null;
  if (!session.hosted) {
    // Self-hosted is one operator against one settings file on their own
    // machine. There is no address to key on and no second owner to leak to.
    return `${PREFIX}self`;
  }
  return session.address ? `${PREFIX}${session.address.toLowerCase()}` : null;
}

function storeOf(explicit?: Store): Store | null {
  if (explicit) return explicit;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const ROLES = new Set(["owner", "agent", "event"]);
const FAILURES = new Set<ChatFailure>(["signed-out", "no-llm", "llm-error", "unreadable", "network", "timeout", "cut-off", "server"]);
/** The shape of an id the orders route issues: a hash, and so a safe URL segment. */
const ORDER_ID = /^[0-9a-f]{16,64}$/i;

/**
 * One kept line, SHAPE-CHECKED rather than trusted. It came out of a store any
 * script on this origin could have written, and it is rendered as the agent's
 * own words — and a receipt as a fact about somebody's money, so a receipt is
 * put through the same field-by-field check the route applies.
 */
function messageOf(x: unknown): ChatMessage | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id || m.id.length > 200) return null;
  if (typeof m.role !== "string" || !ROLES.has(m.role)) return null;
  if (typeof m.text !== "string") return null;
  const out: ChatMessage = {
    id: m.id,
    role: m.role as ChatMessage["role"],
    at: typeof m.at === "number" && Number.isFinite(m.at) ? m.at : null,
    text: m.text.slice(0, 8_000),
  };
  if (m.side === "buy" || m.side === "sell") out.side = m.side;
  const order = m.order as { id?: unknown; receipt?: unknown; serverPlacedAt?: unknown } | null | undefined;
  if (order && typeof order === "object" && typeof order.id === "string" && ORDER_ID.test(order.id)) {
    out.order = { id: order.id, receipt: receiptOf(order.receipt) };
    // The server's own time for the placement, so a reloaded thread still
    // reads the order's life on the ledger's clock (chat-thread.ts lifeOf).
    const at = order.serverPlacedAt;
    if (typeof at === "number" && Number.isFinite(at) && at > 0) out.order.serverPlacedAt = at;
  }
  if (typeof m.tradeKey === "string" && m.tradeKey.length <= 200) out.tradeKey = m.tradeKey;
  // Chat-attached images persist ONLY as our own card URLs: same-origin,
  // exact route shape, numeric trade id. Anything else (model text can never
  // produce these — the client builds them — but storage is read back through
  // this same gate) is dropped rather than rendered.
  const image = m.image as { src?: unknown; alt?: unknown } | null | undefined;
  if (
    image &&
    typeof image === "object" &&
    typeof image.src === "string" &&
    /^\/api\/pnl\?trade=\d+$/.test(image.src) &&
    typeof image.alt === "string" &&
    image.alt.length <= 200
  ) {
    out.image = { src: image.src, alt: image.alt };
  }
  if (typeof m.failed === "string" && FAILURES.has(m.failed as ChatFailure)) out.failed = m.failed as ChatFailure;
  return out;
}

function orderOf(x: unknown): KeptOrder | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  return typeof o.id === "string" && ORDER_ID.test(o.id) && typeof o.until === "number" && Number.isFinite(o.until)
    ? { id: o.id, until: o.until }
    : null;
}

/** A conversation kept as the old question/answer list, shape-checked the same way. */
function legacyOf(list: unknown[]): ChatMessage[] {
  return turnsToMessages(
    list.filter(
      (t): t is ChatTurn => !!t && typeof (t as ChatTurn).question === "string" && typeof (t as ChatTurn).answer === "string",
    ),
  );
}

/** Whatever was kept under this key, or an empty thread. Never throws. */
export function loadThread(key: string | null, explicit?: Store): KeptThread {
  const store = storeOf(explicit);
  if (!key || !store) return EMPTY();
  try {
    const raw = store.getItem(key);
    if (!raw) return EMPTY();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return { ...EMPTY(), messages: legacyOf(parsed) };
    if (!parsed || typeof parsed !== "object") return EMPTY();
    const p = parsed as { messages?: unknown; orders?: unknown; since?: unknown };
    if (!Array.isArray(p.messages)) return EMPTY();
    return {
      messages: p.messages.map(messageOf).filter((m): m is ChatMessage => m !== null).slice(-MAX_MESSAGES),
      orders: Array.isArray(p.orders) ? p.orders.map(orderOf).filter((o): o is KeptOrder => o !== null) : [],
      since: typeof p.since === "number" && Number.isFinite(p.since) ? p.since : null,
    };
  } catch {
    return EMPTY();
  }
}

/** Keep this conversation. A full or unavailable store is not an error. */
export function saveThread(key: string | null, thread: KeptThread, explicit?: Store): void {
  const store = storeOf(explicit);
  if (!key || !store) return;
  try {
    if (!thread.messages.length && !thread.orders.length && thread.since === null) {
      store.removeItem(key);
      return;
    }
    // The card and the Retry chip stay behind — see the header.
    const messages = thread.messages.slice(-MAX_MESSAGES).map(({ trade: _trade, retry: _retry, ...kept }) => kept);
    store.setItem(key, JSON.stringify({ v: 2, messages, orders: thread.orders, since: thread.since }));
  } catch {
    /* quota, private mode, blocked storage — the chat still works in memory */
  }
}

/** Forget it. Called on sign-out, with the key of the owner signing OUT. */
export function clearThread(key: string | null, explicit?: Store): void {
  const store = storeOf(explicit);
  if (!key || !store) return;
  try {
    store.removeItem(key);
  } catch {
    /* nothing to do, and nothing worth telling the user about */
  }
}
