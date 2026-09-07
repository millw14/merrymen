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
import type { ChatTurn } from "./account";

/** Storage may be absent (SSR) or throw on access; both are handled. */
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "merrymen.chat.";

/**
 * How many turns are kept.
 *
 * `localStorage` is a few megabytes for the WHOLE origin, shared with
 * everything else this app keeps there, and a chat turn carries a model answer
 * that can run to a few kilobytes. Forty is far more than anybody scrolls back
 * through and bounded enough that the quota is never the thing that breaks.
 * Oldest go first, which is also how `fitChatState` trims what the model sees.
 */
export const MAX_TURNS = 40;

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

/** Whatever was kept under this key, or nothing. Never throws. */
export function loadTurns(key: string | null, explicit?: Store): ChatTurn[] {
  const store = storeOf(explicit);
  if (!key || !store) return [];
  try {
    const raw = store.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // SHAPE-CHECKED, not trusted. This came out of a store any script on this
    // origin could have written, and it is rendered as the agent's own words.
    return parsed
      .filter(
        (t): t is ChatTurn =>
          !!t && typeof (t as ChatTurn).question === "string" && typeof (t as ChatTurn).answer === "string",
      )
      .slice(-MAX_TURNS);
  } catch {
    return [];
  }
}

/** Keep this conversation. A full or unavailable store is not an error. */
export function saveTurns(key: string | null, turns: ChatTurn[], explicit?: Store): void {
  const store = storeOf(explicit);
  if (!key || !store) return;
  try {
    if (!turns.length) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, JSON.stringify(turns.slice(-MAX_TURNS)));
  } catch {
    /* quota, private mode, blocked storage — the chat still works in memory */
  }
}

/** Forget it. Called on sign-out, with the key of the owner signing OUT. */
export function clearTurns(key: string | null, explicit?: Store): void {
  const store = storeOf(explicit);
  if (!key || !store) return;
  try {
    store.removeItem(key);
  } catch {
    /* nothing to do, and nothing worth telling the user about */
  }
}
