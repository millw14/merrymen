/**
 * THE CONVERSATION, OWNED BY THE APP RATHER THAN BY A SCREEN.
 *
 * The chat lived inside Agent.tsx, which is mounted only while the chat is on
 * screen — the phone's Chat tab, or the desktop dock. So everything it was in
 * the middle of died with it: close the dock with Escape while an order was
 * being followed and its outcome never reached the owner; switch tab while the
 * agent was answering and the answer was dropped. Order state was local to the
 * screen, and outcomes had to be forced into fake question/answer pairs.
 *
 * This hook is mounted ONCE, in App.tsx, and the screen only draws it. It
 * owns:
 *
 *   - the thread (account.ts ChatMessage), kept per owner in chat-store.ts;
 *   - the send: the owner's line and a typing bubble appear AT ONCE, the draft
 *     clears and comes back if the reply fails, the reply streams in, and a
 *     failure is said in the agent's voice with a Retry chip;
 *   - the settings the model is told about, read ahead of time and cached, so
 *     a message is ONE round trip instead of a settings GET and then the chat;
 *   - every order placed from the chat, followed to its answer however the
 *     screens change — its deadline kept with the thread so a reload resumes
 *     the wait — and rendered from the worker's receipt (C3) when it has one;
 *   - the agent's own fills, merged in from the tape by trade;
 *   - an unread flag for anything that arrives while the chat is not on screen.
 *
 * THE PROPOSAL IS HELD HERE AND NEVER STORED. It is the one thing the agent
 * has asked permission to do; a card restored from storage would be an offer
 * to act made by nobody, on a page reopened days later. It lives as long as
 * this App does, is cleared by the next message, and runs only from a click.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { commandFor, type CommandArg } from "@/lib/chat-commands";
import { readReplyStream, type StreamedReply } from "@/lib/chat-stream";
import { receiptOf } from "@/lib/order-state";
import type { ChatFailure, ChatMessage } from "./account";
import { chatStateOf, type ChatSettings } from "./chat-payload";
import { clearThread as forgetThread, loadThread, saveThread, type KeptThread } from "./chat-store";
import {
  absorbFill,
  asksAmount,
  capThread,
  failureLine,
  historyBeforeRetry,
  historyFor,
  llmFailureOf,
  mergeFills,
  newestAt,
  retryHelps,
  type FailureFacts,
} from "./chat-thread";
import type { LiveMine, Thesis } from "./live";
import { fetchOrderPoll, followDeadline, followOrderUntil } from "./order-follow";

/** What the agent is told about itself when a message is sent — the screen's own view of it. */
export interface ChatContext {
  mine: LiveMine;
  liveBlocker: string | null | undefined;
  perTrade: number | null;
  perDay: number | null;
  stopped: boolean;
}

/** The one thing the agent has asked permission to do. */
export interface Proposal {
  id: string;
  args: Record<string, CommandArg>;
}

export interface ChatController {
  messages: ChatMessage[];
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  /** A reply is on its way — the typing bubble. */
  sending: boolean;
  /** What of that reply may be shown so far, or null before its first words. */
  streaming: string | null;
  proposal: Proposal | null;
  setProposal: (p: Proposal | null) => void;
  /**
   * The card is being carried out. HELD HERE, beside the proposal it guards,
   * so every screen that draws the card sees it — see `confirm`.
   */
  confirming: boolean;
  /**
   * Carry out the card ONCE: `run` is handed the proposal, and a second call
   * while one is in flight does nothing, from whichever screen it came. `run`
   * changes the conversation only through `on`, which is bound to the owner
   * who tapped — see `confirm` in useChatController.
   */
  confirm(run: (p: Proposal, on: ConfirmScope) => Promise<void>): Promise<void>;
  /** Something arrived while the chat was not on screen. */
  unread: boolean;
  /** /api/settings as last read, or null when it has not been. */
  settings: ChatSettings | null;
  /**
   * The most one chat order may spend, as the orders route enforces it
   * (/api/orders/ceiling) — or null when it has not been read, and then no
   * chip offers an amount.
   */
  ceiling: number | null;
  send(question: string, ctx: ChatContext): Promise<boolean>;
  /** Ask again the question a failed line carries. */
  retry(messageId: string, ctx: ChatContext): Promise<boolean>;
  /** Add a line the screen wrote — a confirmation, a placed order, a refusal. */
  say(line: Omit<ChatMessage, "id" | "at">): void;
  /** Follow an order placed from the chat to its answer, whatever happens to the screen. */
  followOrder(id: string, expiresInMs: number | null): void;
  /** Read the settings again, after something changed them. */
  refreshSettings(): void;
  /** Empty this owner's thread. */
  clearThread(): void;
}

/**
 * What a confirmed card may do to the conversation, BOUND TO THE OWNER WHO
 * TAPPED IT: once that owner has gone from this browser, each is a no-op.
 */
export interface ConfirmScope {
  say(line: Omit<ChatMessage, "id" | "at">): void;
  followOrder(id: string, expiresInMs: number | null): void;
  /**
   * Clear or replace THIS confirm's card — and only while it is still the
   * card up. The composer stays open while a card is carried out, and a
   * question sent meanwhile puts up its own card; whatever this confirm would
   * do to the card then does nothing, so a newer card is never cleared or
   * swapped under the owner's thumb between reading it and tapping.
   */
  setProposal(p: Proposal | null): void;
  refreshSettings(): void;
  /**
   * May a request that ACTS still go out for this confirm? Only while the
   * owner who tapped has been the owner on this browser the whole time: false
   * from the moment it changes, and still false if they come back — the
   * owner changed while the confirm was in flight. A request carries the
   * session the browser holds when it LEAVES, not the one it held at the tap,
   * so this is asked after every wait and before anything is sent that acts.
   */
  alive(): boolean;
  /**
   * The wallet this confirm acts for — sent with each request that acts, so
   * the route can refuse a session that is not this owner's (another tab can
   * sign in without this one's key changing). Null self-hosted: one operator,
   * no sign-in, nobody to name.
   */
  owner: string | null;
}

/**
 * The wallet a chat key belongs to — chat-store.ts chatKeyFor keys a hosted
 * owner's thread by their address — or null for the self-hosted key and
 * anything else that names no wallet.
 */
export function ownerOfChatKey(key: string | null): string | null {
  const m = key === null ? null : /^merrymen\.chat\.(0x[0-9a-f]{40})$/i.exec(key);
  return m ? m[1]!.toLowerCase() : null;
}

/** Test seams: time, and the pause between order polls. */
export interface ChatDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** How long a whole reply may take, streamed or not, before it is given up on. */
export const CHAT_TIMEOUT_MS = 60_000;

/** Settings older than this are re-read in the background after a reply. */
const SETTINGS_FRESH_MS = 30_000;

export type Asked =
  | { ok: true; reply: string; command?: Proposal }
  | { ok: false; failure: ChatFailure; facts?: FailureFacts };

/**
 * ONE MESSAGE TO /api/chat AND WHAT BECAME OF IT.
 *
 * Asks for a stream and accepts either answer, reading the CONTENT TYPE before
 * the body: the old screen called `json()` on whatever came back, so an HTML
 * error page from a proxy surfaced as a JSON parse error in the chat. A stream
 * that ends without its `done` was cut off, and is a failure — never the half
 * that arrived. `onText` is told what may be shown so far (chat-stream.ts has
 * already held back anything from a `<<` on).
 *
 * AN ERROR STATUS IS NOBODY'S ANSWER. A 502 from a gateway, or a 500 or 429
 * the route sent as JSON, used to be said as "I answered, but it arrived
 * garbled" — false: nothing answered. It is "server", with its status.
 * "unreadable" is kept for a 2xx body that could not be read.
 */
export async function askAgent(
  payload: { message: string; state: string; history: { role: "user" | "assistant"; content: string }[] },
  onText: (visible: string) => void,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<Asked> {
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
        body: JSON.stringify(payload),
        signal: stop.signal,
      });
    } catch {
      return { ok: false, failure: timedOut ? "timeout" : "network" };
    }
    if (res.status === 401) return { ok: false, failure: "signed-out" };
    if (!res.ok) return { ok: false, failure: "server", facts: { status: res.status } };
    const type = res.headers.get("content-type") ?? "";
    let out: StreamedReply;
    if (res.body && /text\/event-stream/i.test(type)) {
      try {
        out = await readReplyStream(res.body, onText);
      } catch {
        return { ok: false, failure: timedOut ? "timeout" : "cut-off" };
      }
    } else if (/application\/json/i.test(type)) {
      try {
        out = (await res.json()) as StreamedReply;
      } catch {
        return { ok: false, failure: timedOut ? "timeout" : "unreadable" };
      }
      if (!out || typeof out !== "object") return { ok: false, failure: "unreadable" };
    } else {
      return { ok: false, failure: "unreadable" };
    }
    if (typeof out.reply === "string" && out.reply.trim()) {
      const command = out.command && commandFor(out.command.id) ? out.command : undefined;
      return { ok: true, reply: out.reply, ...(command ? { command } : {}) };
    }
    if (out.why === "no-llm") return { ok: false, failure: "no-llm" };
    if (out.why === "cut-off") return { ok: false, failure: timedOut ? "timeout" : "cut-off" };
    if (out.why === "llm-error") return { ok: false, failure: "llm-error", facts: { llm: llmFailureOf(out.kind, out.provider) } };
    return { ok: false, failure: "unreadable" };
  } finally {
    clearTimeout(timer);
  }
}

type Thread = KeptThread & { key: string | null };

let seq = 0;
const lineId = (prefix: string, now: number) => `${prefix}-${now.toString(36)}-${(seq++).toString(36)}`;
const hidden = () => typeof document !== "undefined" && document.hidden;

export function useChatController(o: {
  /** Whose conversation — chat-store.ts chatKeyFor. */
  chatKey: string | null;
  /** Is the chat on screen right now? Anything arriving while it is not is unread. */
  open: boolean;
  /** The owner's tape as last read, or null when it was not read — never an empty stand-in. */
  moves: Thesis[] | null;
  /** An order answered: whatever it changed should be read again. */
  onOutcome?: () => void;
  deps?: ChatDeps;
}): ChatController {
  const depsRef = useRef(o.deps);
  depsRef.current = o.deps;
  const clock = useCallback(() => (depsRef.current?.now ?? Date.now)(), []);
  const keyRef = useRef(o.chatKey);
  /**
   * Moves on every change of owner on this browser, there and back included,
   * so a confirm can tell "the same owner throughout" from "the same owner
   * again" (ConfirmScope.alive). Moved where the key is, in the render that
   * brings the new owner, so nothing can run between the two.
   */
  const ownerTurn = useRef(0);
  if (keyRef.current !== o.chatKey) ownerTurn.current += 1;
  keyRef.current = o.chatKey;
  const openRef = useRef(o.open);
  openRef.current = o.open;
  const onOutcomeRef = useRef(o.onOutcome);
  onOutcomeRef.current = o.onOutcome;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [thread, setThread] = useState<Thread>({ key: null, messages: [], orders: [], since: null });
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const proposalRef = useRef(proposal);
  proposalRef.current = proposal;
  const [confirming, setConfirming] = useState(false);
  /** The hold of the confirm in flight — its own, so only it can let go of it. */
  const confirmingRef = useRef<object | null>(null);
  const [unread, setUnread] = useState(false);
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [ceiling, setCeiling] = useState<number | null>(null);

  /**
   * Change THIS owner's thread — never whoever is signed in by the time an
   * answer lands. EVERY change goes through here, and so through capThread:
   * the one place lines are trimmed, so none can be trimmed without the
   * watermark moving past the trades they were about.
   */
  const update = useCallback((key: string | null, fn: (t: KeptThread) => KeptThread) => {
    setThread((t) => (t.key === key ? { ...capThread(fn(t)), key } : t));
  }, []);
  const arrived = useCallback(() => {
    if (!openRef.current || hidden()) setUnread(true);
  }, []);

  // ── whose thread, loaded on arrival and forgotten on departure ──────────
  //
  // Runs when the key changes, which is exactly the two moments that matter:
  // a page load once the session is known, and a sign-out or a switch to a
  // different wallet. The previous owner's thread is DELETED rather than
  // merely hidden — leaving it for the next person on a shared machine is
  // what keying it was meant to prevent.
  const lastKey = useRef<string | null>(null);
  const settingsCache = useRef<{ key: string | null; value: ChatSettings; at: number } | null>(null);
  /** The newest read of the ceiling — only it may set what the chips offer (readCeiling). */
  const ceilingRead = useRef(0);
  useEffect(() => {
    const previous = lastKey.current;
    if (previous && previous !== o.chatKey) forgetThread(previous);
    lastKey.current = o.chatKey;
    setThread({ key: o.chatKey, ...loadThread(o.chatKey) });
    setProposal(null);
    // A confirm still in flight is the previous owner's: it does not hold this
    // owner's card (see `confirm`).
    confirmingRef.current = null;
    setConfirming(false);
    setStreaming(null);
    setUnread(false);
    settingsCache.current = null;
    setSettings(null);
    setCeiling(null);
  }, [o.chatKey]);

  // Written back on every change rather than on unmount: a tab the phone
  // reclaims in the background never gets an unmount. Only once the state in
  // hand IS this key's — in the render between a key change and its load, the
  // thread still belongs to the owner who just left.
  useEffect(() => {
    if (thread.key !== o.chatKey) return;
    saveThread(thread.key, { messages: thread.messages, orders: thread.orders, since: thread.since });
  }, [thread, o.chatKey]);

  // ── the settings the model is told about ────────────────────────────────
  //
  // THIS WAS A SERIAL GET BEFORE EVERY MESSAGE, with its own five seconds of
  // timeout, before the chat request could even start. It is read when the
  // chat opens (which also catches a change made on the Settings screen), after
  // a settings command, and in the background after a reply once it is stale —
  // so sending is one round trip. A read that fails leaves the last good one;
  // one never read is null, and chatStateOf then tells the model it could not
  // read them rather than handing it the defaults as the owner's choice.
  const settingsFlight = useRef<Promise<ChatSettings | null> | null>(null);
  const readSettings = useCallback((): Promise<ChatSettings | null> => {
    if (settingsFlight.current) return settingsFlight.current;
    const key = keyRef.current;
    const flight = (async () => {
      let value: ChatSettings | null = null;
      try {
        const r = await fetch("/api/settings", { signal: AbortSignal.timeout(5_000) });
        if (r.ok && /application\/json/i.test(r.headers.get("content-type") ?? "")) value = (await r.json()) as ChatSettings;
      } catch {
        /* unread — said as unread, below */
      }
      if (keyRef.current !== key) return null;
      if (value) {
        settingsCache.current = { key, value, at: clock() };
        if (mounted.current) setSettings(value);
        return value;
      }
      return settingsCache.current?.key === key ? settingsCache.current.value : null;
    })();
    settingsFlight.current = flight;
    void flight.finally(() => {
      if (settingsFlight.current === flight) settingsFlight.current = null;
    });
    return flight;
  }, [clock]);
  // ── the ceiling the amount chips clamp to ──────────────────────────────
  //
  // THE ORDERS ROUTE'S OWN, read from the route that shares its resolution.
  // The chips used to take the owner's value over SETTINGS_DEFAULTS from
  // /api/settings, while the route falls back to the house's file and env —
  // so a house ceiling below 25 offered a "(max)" chip it refused. Read with
  // the settings; a read that fails leaves the last good one, and one never
  // read is null, which offers no amount at all.
  //
  // AND AGAIN EVERY TIME THE AGENT ASKS HOW MUCH. On desktop the dock stays
  // open while the owner uses the Settings screen, so "when the chat opens"
  // never comes round again; and a re-read only once the last one was thirty
  // seconds old still missed the natural flow — see an unwanted "(max)", lower
  // the ceiling, come straight back and ask again — offering a "(max)" POST
  // now refused. Amount chips are drawn only under a reply that asks for an
  // amount (chat-thread.ts asksAmount), so that reply is when it is read: the
  // chips stand against the ceiling as it is when the question is asked,
  // whatever changed it and wherever.
  //
  // WITHDRAWN WHILE IT IS READ. The old figure is not offered while the new
  // read is out, nor after one that failed: no amount is offered against a
  // limit that is being, or could not be, read again. And only the NEWEST read
  // may set it — an older one landing late would put back what it read.
  const readCeiling = useCallback(async () => {
    const key = keyRef.current;
    const read = ++ceilingRead.current;
    if (mounted.current) setCeiling(null);
    let value: number | null = null;
    try {
      const r = await fetch("/api/orders/ceiling", { signal: AbortSignal.timeout(5_000) });
      if (r.ok && /application\/json/i.test(r.headers.get("content-type") ?? "")) {
        const v = ((await r.json()) as { ceilingUsdg?: unknown }).ceilingUsdg;
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) value = v;
      }
    } catch {
      /* unread — no amount is offered against a limit nobody read */
    }
    if (value !== null && keyRef.current === key && mounted.current && ceilingRead.current === read) setCeiling(value);
  }, []);
  useEffect(() => {
    if (!o.open || !o.chatKey) return;
    void readSettings();
    void readCeiling();
  }, [o.open, o.chatKey, readSettings, readCeiling]);

  // ── sending ─────────────────────────────────────────────────────────────
  const send = useCallback(
    async (question: string, ctx: ChatContext, retryOf?: string): Promise<boolean> => {
      const q = question.trim();
      if (!q || sendingRef.current) return false;
      const key = keyRef.current;
      const kept = threadRef.current.messages;
      // SENDING THE FAILED QUESTION AGAIN IS A RETRY, whether by the chip or by
      // pressing Enter on the draft that came back — not a second copy of it.
      const last = kept[kept.length - 1];
      const again = retryOf ?? (last?.retry === q ? last.id : undefined);
      sendingRef.current = true;
      setSending(true);
      setStreaming(null);
      setProposal(null);
      // The history is what was said BEFORE this — the model hears the new line
      // as "THEY JUST SAID", not twice. On a retry the question is already a
      // line in the thread, so it and its failed answer are left out.
      const history = again ? historyBeforeRetry(kept, again, q) : historyFor(kept);
      if (again) {
        update(key, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== again) }));
      } else {
        update(key, (t) => ({ ...t, messages: [...t.messages, { id: lineId("owner", clock()), role: "owner" as const, at: clock(), text: q }] }));
      }
      // THE DRAFT CLEARS AT ONCE — unless the owner has already started typing
      // something else, which is theirs.
      setDraft((d) => (d.trim() === q ? "" : d));
      try {
        const cached = settingsCache.current;
        const settingsNow = cached && cached.key === key ? cached.value : await readSettings();
        const state = chatStateOf({
          mine: ctx.mine,
          settings: settingsNow,
          liveBlocker: ctx.liveBlocker,
          perTrade: ctx.perTrade,
          perDay: ctx.perDay,
          stopped: ctx.stopped,
        });
        const out = await askAgent({ message: q, state: JSON.stringify(state), history }, (visible) => {
          if (keyRef.current === key && mounted.current) setStreaming(visible);
        });
        if (keyRef.current !== key || !mounted.current) return false;
        if (out.ok) {
          update(key, (t) => ({ ...t, messages: [...t.messages, { id: lineId("agent", clock()), role: "agent" as const, at: clock(), text: out.reply }] }));
          // How much? Then the chips it draws are drawn against the ceiling as
          // it stands now — withdrawn in this same render, offered once read.
          if (asksAmount(out.reply)) void readCeiling();
          // VALIDATED AGAIN HERE. The route checks the id against the registry,
          // and so does this — nothing is held that the card could not describe.
          setProposal(out.command && commandFor(out.command.id) ? out.command : null);
        } else {
          update(key, (t) => ({
            ...t,
            messages: [
              ...t.messages,
              {
                id: lineId("agent", clock()),
                role: "agent" as const,
                at: clock(),
                text: failureLine(out.failure, out.facts),
                failed: out.failure,
                // A Retry only where asking again can work: never beside "that
                // key has to be replaced first".
                ...(retryHelps(out.failure, out.facts) ? { retry: q } : {}),
              },
            ],
          }));
          // And the words come back, so nothing they typed is lost to a network.
          setDraft((d) => (d.trim() ? d : q));
        }
        arrived();
        const c = settingsCache.current;
        if (!c || clock() - c.at > SETTINGS_FRESH_MS) void readSettings();
        return out.ok;
      } finally {
        sendingRef.current = false;
        if (mounted.current) {
          setSending(false);
          setStreaming(null);
        }
      }
    },
    [arrived, clock, readSettings, readCeiling, update],
  );

  const retry = useCallback(
    (messageId: string, ctx: ChatContext) => {
      const m = threadRef.current.messages.find((x) => x.id === messageId);
      return m?.retry ? send(m.retry, ctx, messageId) : Promise.resolve(false);
    },
    [send],
  );

  const say = useCallback(
    (line: Omit<ChatMessage, "id" | "at">) => {
      const key = keyRef.current;
      update(key, (t) => ({ ...t, messages: [...t.messages, { ...line, id: lineId(line.role, clock()), at: clock() }] }));
    },
    [clock, update],
  );

  // ── orders, followed at App level ──────────────────────────────────────
  const followOrder = useCallback(
    (id: string, expiresInMs: number | null) => {
      const key = keyRef.current;
      const until = followDeadline(expiresInMs, clock());
      update(key, (t) => (t.orders.some((x) => x.id === id) ? t : { ...t, orders: [...t.orders, { id, until }] }));
    },
    [clock, update],
  );

  // Every kept order is followed exactly once per owner, including the ones a
  // reload brought back — each against the deadline it was placed with.
  const following = useRef(new Set<string>());
  useEffect(() => {
    const key = thread.key;
    if (key !== o.chatKey) return;
    for (const order of thread.orders) {
      const tag = `${key}|${order.id}`;
      if (following.current.has(tag)) continue;
      following.current.add(tag);
      const sleep = depsRef.current?.sleep;
      void followOrderUntil(order.id, order.until, {
        poll: fetchOrderPoll,
        now: clock,
        ...(sleep ? { sleep } : {}),
        // Not "is the screen open" any more: "is this still this owner's chat".
        alive: () => mounted.current && keyRef.current === key,
        say: (line, poll) => {
          // THE WORKER'S WORDS, and its receipt when it wrote one — both read
          // off the ledger in the child. Nothing here infers an outcome.
          const receipt = receiptOf(poll?.receipt);
          const id = lineId("order", clock());
          update(key, (t) => ({
            ...t,
            orders: t.orders.filter((x) => x.id !== order.id),
            messages: absorbFill(
              [...t.messages, { id, role: "agent" as const, at: clock(), text: line, order: { id: order.id, receipt } }],
              id,
            ),
          }));
          arrived();
          // An answer changed the book and the grant's spend: read them again
          // now rather than on the next minute's pass.
          if (poll) onOutcomeRef.current?.();
        },
      }).finally(() => following.current.delete(tag));
    }
  }, [thread.key, thread.orders, o.chatKey, clock, update, arrived]);

  // ── the agent's own fills ───────────────────────────────────────────────
  useEffect(() => {
    const moves = o.moves;
    const key = thread.key;
    if (!moves || key === null || key !== o.chatKey) return;
    // First sight of this owner's tape: what is on it is history, not news.
    const since = thread.since ?? newestAt(moves);
    const merged = mergeFills(thread.messages, moves, since);
    if (merged === thread.messages && since === thread.since) return;
    const added = merged.some((m) => m.role === "event" && !thread.messages.some((x) => x.id === m.id));
    // The watermark the thread holds by the time this lands wins over the one
    // read above: a trim in between may have moved it on (capThread).
    update(key, (t) => {
      const s = t.since ?? since;
      return { ...t, messages: mergeFills(t.messages, moves, s), since: s };
    });
    if (added) arrived();
  }, [o.moves, thread, o.chatKey, update, arrived]);

  // ── unread ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!o.open) return;
    const clear = () => {
      if (!hidden()) setUnread(false);
    };
    clear();
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, [o.open]);

  const clearThread = useCallback(() => {
    update(keyRef.current, () => ({ messages: [], orders: [], since: null }));
    setProposal(null);
    setStreaming(null);
    setUnread(false);
  }, [update]);

  const refreshSettings = useCallback(() => {
    settingsCache.current = null;
    void readSettings();
    void readCeiling();
  }, [readSettings, readCeiling]);

  // ── the card, carried out once ──────────────────────────────────────────
  //
  // THE GUARD LIVES WITH THE PROPOSAL, NOT WITH A SCREEN. It was the Agent
  // screen's own `running` state while the proposal became the App's: a phone
  // tab switch, or the dock closed with Escape and reopened, while the POST was
  // in flight brought the same card back READY, and one more tap placed the
  // same order again — and desktop can draw two Agent screens at once, each
  // with its own guard over the one proposal. The minute-bucket id and the
  // one-at-a-time slot catch most repeats, but not a tap after the minute
  // rolled once the first order had already been answered. A ref, so two taps
  // in the same instant — before either screen has redrawn — are still one.
  //
  // AND IT IS THE TAPPING OWNER'S, like everything else here. A confirm still
  // in flight when the owner changed on this browser held the next owner's
  // card at "Doing it…", and when it answered it wrote the previous owner's
  // "✓ Confirmed" and "Placed it" into the next owner's kept thread, had that
  // thread follow the previous owner's order, and cleared the next owner's own
  // proposal. So `run` is handed a scope bound to the owner who tapped: every
  // change it makes does nothing once that owner has gone. The guard is let go
  // when the owner changes, and a confirm that ends later lets go only its OWN
  // hold — never the next owner's order in flight.
  //
  // AND SO IS WHAT IT PLACES. Binding the words was not binding the order: a
  // snipe's order goes out only after its lookup answers, carrying whatever
  // session the browser holds by then, so an owner signing in meanwhile got an
  // order they never confirmed, with no line and no follow. `alive` says
  // whether anything that acts may still go out (the same owner, throughout),
  // and `owner` goes with it so the route can refuse a session another tab
  // changed unseen (lib/order-owner.ts).
  //
  // AND ONLY ITS OWN CARD. The same owner can ask something else while a
  // confirm runs — a snipe's lookup can take SNIPE_LOOKUP_MS — and that
  // question's reply puts up its own card. The confirm's `setProposal` then
  // cleared whatever card was up, not its own: the newer card vanished before
  // it could be read, or could be swapped for another with "Yes, do it" in the
  // same place. So it acts only while the card up is the very proposal this
  // confirm was handed — checked and written in one step, against the state
  // React holds rather than the last render's, so a reply landing in the same
  // batch is seen.
  const confirm = useCallback(
    async (run: (p: Proposal, on: ConfirmScope) => Promise<void>) => {
      const p = proposalRef.current;
      if (!p || confirmingRef.current) return;
      const key = keyRef.current;
      const turn = ownerTurn.current;
      const hold = {};
      confirmingRef.current = hold;
      setConfirming(true);
      const theirs = () => keyRef.current === key;
      const on: ConfirmScope = {
        owner: ownerOfChatKey(key),
        alive: () => ownerTurn.current === turn,
        say: (line) => {
          if (theirs()) say(line);
        },
        followOrder: (id, expiresInMs) => {
          if (theirs()) followOrder(id, expiresInMs);
        },
        setProposal: (next) => {
          if (theirs()) setProposal((now) => (now === p ? next : now));
        },
        refreshSettings: () => {
          if (theirs()) refreshSettings();
        },
      };
      try {
        await run(p, on);
      } finally {
        if (confirmingRef.current === hold) {
          confirmingRef.current = null;
          if (mounted.current) setConfirming(false);
        }
      }
    },
    [say, followOrder, refreshSettings],
  );

  return {
    messages: thread.key === o.chatKey ? thread.messages : [],
    draft,
    setDraft,
    sending,
    streaming,
    proposal,
    setProposal,
    confirming,
    confirm,
    unread,
    settings,
    ceiling,
    send: (question, ctx) => send(question, ctx),
    retry,
    say,
    followOrder,
    refreshSettings,
    clearThread,
  };
}
