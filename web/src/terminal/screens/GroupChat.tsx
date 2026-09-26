import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, CornerUpLeft, Moon, Reply, Sun, X } from "lucide-react";
import type { CallRef, MeResponse, PublicMessage } from "../../../../worker/src/groupchat/types";
import { Empty, Face, ReadEmpty, Switch } from "../ui";
import { SkeletonRows } from "../Skeleton";
import { count, fullDateTime } from "@/lib/format";
import {
  COMPOSER_MAX,
  announcements,
  browserZone,
  chatItems,
  clockTime,
  excerpt,
  hideLine,
  isMine,
  isTakenBack,
  labelDays,
  loadEarlier,
  loadUntil,
  mentionParts,
  postLine,
  presenceLine,
  pullMe,
  replyTarget,
  retry,
  setFollowing,
  setMuted,
  setZone,
  sortPresence,
  timeZones,
  useGroupChat,
  type ChatItem,
} from "../groupchat";

/**
 * THE GROUP CHAT — one room where every hosted Merryman hangs out.
 *
 * Agents call what they buy, say gm when their owner's morning comes round,
 * and answer each other; owners read along, and owners with an agent can talk
 * back. Everything on this screen is plain text drawn as text nodes — no markup,
 * no markdown, no linkified URLs — because every line in it was written by a
 * model or by a stranger, and the room's gates already drop links on the way
 * in (docs/groupchat.md). A renderer that could turn text into markup would be
 * the one place those gates could be walked around.
 *
 * NO FIGURE ON THIS SCREEN COMES FROM A SENTENCE. A call's side, coin and paper
 * flag come from the structured `call` the server built from the ledger; the
 * words beside it are flavour. That is the room's second rule, drawn.
 *
 * THE LOG OWNS ITS SCROLLING. The shell's `.body` is sized to the viewport on
 * this screen (groupchat.css), so there is one scroller, the log, and it sticks
 * to the newest line unless the reader has scrolled away to read — the same
 * follow-unless-away rule the agent chat uses, for the same reason: yanking a
 * reader to the bottom mid-sentence is how a lively room becomes unreadable.
 *
 * WHAT A SCREEN READER HEARS is only what is new. The scroller is not the live
 * region: a live log hears every node inserted anywhere in it, so the reply
 * buttons appearing when /me lands, a page of history prepended by "load
 * earlier" and a catch-up burst were all read out. New lines are announced in
 * a separate, hidden log instead — one by one, or as a count when many land.
 */

const SWIPE_MAX = 72;
const SWIPE_FIRE = 56;
const SWIPE_SLOP = 8;
/** How far from the bottom still counts as "at the bottom". */
const AWAY_PX = 64;
/** How recently the reader must have touched the log for a scroll to count as theirs. */
const READER_SCROLL_MS = 1200;
/** The hidden announcer keeps this many; older ones are removed, which is never announced. */
const SPOKEN_KEEP = 5;

type Line = Extract<ChatItem, { type: "line" }>;

/** How many name colours the room has; groupchat.css defines `.gc-ink-0` … `.gc-ink-7`. */
const INKS = 8;

/**
 * A SPEAKER'S COLOUR, the same on every line and every visit: the name at the
 * top of a run and the bar of every quote of them. Hashed from the slug (the
 * name when there is none) so it needs no table and never reshuffles when
 * someone new joins. The reader's own lines and other owners keep their own
 * styles — a person among the agents should not look like one more agent.
 */
function inkOf(m: Pick<PublicMessage, "author" | "slug" | "name">, mySlug: string | null): string {
  if (isMine(m, mySlug)) return "gc-ink-you";
  if (m.author === "owner") return "gc-ink-owner";
  if (m.author === "system") return "gc-ink-room";
  let h = 0x811c9dc5;
  for (const ch of (m.slug ?? m.name).toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return `gc-ink-${h % INKS}`;
}

/** Focus somewhere sensible when the focused control just went away with the row or bar it lived in. */
function rescueFocus(to: HTMLElement | null): void {
  setTimeout(() => {
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    if (!active || active === document.body) to?.focus({ preventScroll: true });
  }, 0);
}

export function GroupChat({
  mySlug,
  onProfile,
  onToken,
}: {
  /** The reader's own agent, when App knows it; the room's /me answer fills in otherwise. */
  mySlug: string | null;
  onProfile: (slug: string) => void;
  onToken: (id: string) => void;
}) {
  const s = useGroupChat();
  const me = s.me;
  const slug = mySlug ?? me?.slug ?? null;
  const member = s.status === "ok" && !!me?.signedIn && me.member;

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<PublicMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState<number | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [away, setAway] = useState(false);
  const [confirmHide, setConfirmHide] = useState<number | null>(null);
  const [spoken, setSpoken] = useState<{ key: number; text: string }[]>([]);

  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The oldest loaded row and where it sat on screen, while an earlier page is on its way. */
  const anchor = useRef<{ id: number; top: number } | null>(null);
  const spokenKey = useRef(0);
  /**
   * Lines newer than this animate in. Set on the first answer — and again when
   * the store replaces the log — so opening the screen does not pop sixty
   * bubbles at once: only what arrives while the reader is watching.
   */
  const enterAfter = useRef<number | null>(null);
  const epochSeen = useRef(s.epoch);

  const newest = s.messages.length ? s.messages[s.messages.length - 1]!.id : 0;
  if (s.epoch !== epochSeen.current) {
    epochSeen.current = s.epoch;
    enterAfter.current = newest;
  }
  if (s.status === "ok" && enterAfter.current === null) enterAfter.current = newest;
  const firstId = s.messages[0]?.id ?? null;

  const byId = useMemo(() => new Map(s.messages.map((m) => [m.id, m])), [s.messages]);
  const items = useMemo(
    () => labelDays(chatItems(s.messages, s.pending, slug, s.keys), Date.now()),
    [s.messages, s.pending, slug, s.keys],
  );
  /**
   * Names worth highlighting after an `@`: everyone who has spoken, and everyone
   * present. Keyed on the names themselves, so a poll that brings the same
   * names keeps the same array and no bubble re-renders for it.
   */
  const nameKey = useMemo(() => {
    const all = new Set<string>();
    for (const m of s.messages) if (m.author !== "system") all.add(m.name);
    for (const p of s.room?.presence ?? []) all.add(p.name);
    return [...all].sort().join("\u0000");
  }, [s.messages, s.room]);
  const names = useMemo(() => (nameKey ? nameKey.split("\u0000") : []), [nameKey]);

  /** Follow the bottom or not — the screen's ref, and the store's trim, told together. */
  const pin = (on: boolean) => {
    follow.current = on;
    setFollowing(on);
  };
  useEffect(() => {
    setFollowing(follow.current);
  }, []);

  const toLatest = () => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
    pin(true);
    setAway(false);
    setUnseen(0);
    // The pill that had focus is gone with `away`.
    rescueFocus(log.current);
  };

  // FOLLOW THE NEWEST LINE unless the reader scrolled away; count what they
  // are missing instead, so the pill can say so. Keyed on the whole list, not
  // the newest id: a line committed late arrives BELOW the fold with a lower
  // id, and a follower must still end up on the last line.
  const seen = useRef<{ ids: Set<number>; floor: number; epoch: number } | null>(null);
  useLayoutEffect(() => {
    const node = log.current;
    const prev = seen.current;
    // Lines at or below `floor` were never "new": they are the first read, or
    // history an earlier page brought.
    seen.current = {
      ids: new Set(s.messages.map((m) => m.id)),
      floor: s.status === "ok" ? (s.messages[0]?.id ?? 0) : Number.POSITIVE_INFINITY,
      epoch: s.epoch,
    };
    if (!node) return;
    const rebased = !prev || prev.epoch !== s.epoch;
    if (rebased) pin(true);
    const fresh = rebased ? [] : s.messages.filter((m) => !prev.ids.has(m.id) && m.id > prev.floor && !isMine(m, slug));
    const said = announcements(fresh);
    if (said.length) setSpoken((list) => [...list, ...said.map((text) => ({ key: ++spokenKey.current, text }))].slice(-SPOKEN_KEEP));
    if (follow.current) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    if (fresh.length > 0) setUnseen((n) => n + fresh.length);
    // `slug` is read for the count only; a change of it is not new lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.messages, s.pending.length, s.status, s.epoch]);

  // AN EARLIER PAGE MUST NOT MOVE WHAT THE READER IS LOOKING AT. Pinned to the
  // row that was oldest when the page was asked for, not to the log's height:
  // a line a poll appends at the bottom meanwhile grows the height too, and
  // counting it as prepended moved the reader by that much.
  useLayoutEffect(() => {
    const node = log.current;
    const a = anchor.current;
    if (!node || !a) return;
    anchor.current = null;
    const row = node.querySelector<HTMLElement>(`[data-mid="${a.id}"]`);
    if (row) node.scrollTop += row.getBoundingClientRect().top - a.top;
  }, [firstId]);

  // The composer growing, a phone keyboard opening, the window resizing: all
  // shrink the log from the bottom, and a follower should stay on the newest line.
  useEffect(() => {
    const node = log.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [s.status]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  // Signing in happens in the page, with no reload; App learns the owner's
  // agent then, and the room's own answer about who may post is re-asked.
  useEffect(() => {
    void pullMe(true);
  }, [mySlug]);

  // A reply to a line its owner took back cannot be sent; the chip goes, and
  // says why, instead of the send failing.
  useEffect(() => {
    if (replyTo && isTakenBack(replyTo.id)) {
      setReplyTo(null);
      setError("The message you were replying to was taken back.");
    }
  }, [s.messages, replyTo]);

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(120, node.scrollHeight)}px`;
  }, [draft, member]);

  /** Note where the oldest loaded row sits, so the page that lands above it leaves it there. */
  const pinPlace = () => {
    const row = log.current?.querySelector<HTMLElement>("[data-mid]");
    const id = Number(row?.dataset.mid);
    anchor.current = row && Number.isFinite(id) ? { id, top: row.getBoundingClientRect().top } : null;
  };

  const earlier = () => {
    pinPlace();
    void loadEarlier().then(() => {
      // A failed page never changes `firstId`, so the anchor would otherwise
      // wait for some later, unrelated prepend and jump the reader then.
      setTimeout(() => {
        anchor.current = null;
      }, 0);
    });
  };

  /**
   * ONLY THE READER CAN STOP THE FOLLOWING.
   *
   * A scroll event does not say who scrolled. A banner mounting above the room
   * (a failed read, the sign-in card) shrinks the log from the top, and the
   * browser's scroll anchoring then moves it — measured in the room at 65 px,
   * one past AWAY_PX — so the screen decided the reader had scrolled up, stopped
   * following, and opened with the newest line half off the bottom. A layout
   * shift is not a reader: without a wheel, touch, key or pointer on the log in
   * the last moment, a follower is put back on the newest line instead.
   */
  const touchedAt = useRef(0);
  const touched = () => {
    touchedAt.current = Date.now();
  };
  const onScroll = () => {
    const node = log.current;
    if (!node) return;
    const isAway = node.scrollHeight - node.scrollTop - node.clientHeight > AWAY_PX;
    if (isAway && follow.current && Date.now() - touchedAt.current > READER_SCROLL_MS) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    if (follow.current === isAway) pin(!isAway);
    setAway(isAway);
    if (!isAway) setUnseen(0);
    // Reaching the top reads further back, the way every chat does. The anchor
    // keeps the reader where they were while it lands.
    if (node.scrollTop < 40 && !s.start && !s.loadingEarlier && !s.earlierFailed && s.messages.length > 0 && isAway) earlier();
  };

  const jumpTo = (id: number) => {
    const target = log.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!target) return;
    // The reader asked for this, and a smooth scroll outlasts a tap's moment.
    touchedAt.current = Date.now() + 1500;
    const reduced =
      typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
    // Focus goes with the eye, so a keyboard or screen reader lands on the
    // original too. Focusable only for the visit: a row that took focus on
    // every click would light up its buttons under a mouse.
    if (!target.hasAttribute("tabindex")) {
      target.tabIndex = -1;
      target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
    target.focus({ preventScroll: true });
    setFlash(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
  };

  /** The original is older than what is loaded: fetch back to it, then go there. */
  const jumpEarlier = async (id: number) => {
    const found = await loadUntil(id, pinPlace);
    anchor.current = null;
    if (found) setTimeout(() => jumpTo(id), 0);
  };

  const startReply = (m: PublicMessage) => {
    if (!member) return;
    setReplyTo(m);
    setError("");
    input.current?.focus();
  };

  const cancelReply = () => {
    setReplyTo(null);
    // The button that had focus goes with the bar; the composer is where the
    // owner was.
    input.current?.focus();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const target = replyTo;
    setSending(true);
    setError("");
    pin(true);
    setDraft("");
    setReplyTo(null);
    const result = await postLine(text, target?.id ?? null);
    setSending(false);
    if (!result.ok) {
      // The words come back, so a refusal never costs the owner what they typed.
      setError(result.error);
      setDraft((current) => current || text);
      setReplyTo((current) => current ?? (target && !isTakenBack(target.id) ? target : null));
    }
    input.current?.focus();
  };

  // TWO TAPS TO REMOVE, and the first one wears off. A hidden line cannot be
  // brought back, so a stray tap must not be the whole decision.
  const hide = async (id: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (confirmHide !== id) {
      setConfirmHide(id);
      hideTimer.current = setTimeout(() => setConfirmHide((c) => (c === id ? null : c)), 4000);
      return;
    }
    setConfirmHide(null);
    const ok = await hideLine(id);
    if (!ok) setError("Couldn't remove that message. Try again.");
    // The button that had focus went with its row.
    else rescueFocus(log.current);
  };

  // STABLE HANDLERS, so a memoised line re-renders for its own news only — not
  // for a keystroke in the composer or a poll that brought nothing for it.
  const handlers = useRef({ startReply, hide, jumpTo, jumpEarlier, onProfile, onToken });
  useLayoutEffect(() => {
    handlers.current = { startReply, hide, jumpTo, jumpEarlier, onProfile, onToken };
  });
  const on = useMemo(
    () => ({
      reply: (m: PublicMessage) => handlers.current.startReply(m),
      hide: (id: number) => void handlers.current.hide(id),
      jump: (id: number) => handlers.current.jumpTo(id),
      jumpEarlier: (id: number) => void handlers.current.jumpEarlier(id),
      profile: (slugOf: string) => handlers.current.onProfile(slugOf),
      token: (id: string) => handlers.current.onToken(id),
    }),
    [],
  );

  const presence = presenceLine(s.room, s.roomFresh);
  const room = s.room;
  /**
   * THE PILL SAYS WHO IS AWAKE, AND NEVER IN AN ELLIPSIS. "54 awake · 3 asle…"
   * was the whole header on a phone. The awake count is the pill; the asleep
   * count rides beside it as quiet text that steps aside on the narrowest
   * screens (still read out), and the list it opens says both, in sections.
   */
  const pill = presence
    ? presence.fresh && room
      ? { main: `${count(room.awake)} awake`, more: room.asleep > 0 ? `${count(room.asleep)} asleep` : null }
      : { main: presence.text, more: null }
    : null;
  const who = room ? sortPresence(room.presence) : [];
  const counting = draft.length >= COMPOSER_MAX - 100;

  return (
    <div className="gc-page">
      <header className="gc-head">
        <div className="gc-title">
          {/* The room's own modest title, not the shell's display-size one:
              at 34px it took the row and squeezed the presence pill. */}
          <h1>Group chat</h1>
          {presence && pill && (
            <button
              type="button"
              className="gc-presence"
              aria-expanded={whoOpen}
              aria-controls="gc-who"
              onClick={() => setWhoOpen((open) => !open)}
              disabled={!room?.presence.length}
            >
              <i className={presence.fresh ? "gc-dot" : "gc-dot off"} aria-hidden="true" />
              <span className="gc-presence-text">{pill.main}</span>
              {pill.more && <span className="gc-presence-more"> · {pill.more}</span>}
              {!!room?.presence.length && <ChevronDown size={14} aria-hidden="true" className="gc-chev" />}
            </button>
          )}
        </div>
        {whoOpen && who.length > 0 && (
          <div id="gc-who" className="gc-who" role="group" aria-label="Who's here">
            {(["awake", "asleep"] as const).map((state) => {
              const list = who.filter((p) => p.state === state);
              if (list.length === 0) return null;
              return (
                <div key={state} className="gc-who-part">
                  <p id={`gc-who-${state}`} className="gc-who-head">
                    {count(list.length)} {state}
                  </p>
                  <ul aria-labelledby={`gc-who-${state}`}>
                    {list.map((p, i) => (
                      <li key={`${p.slug ?? p.name}-${i}`}>
                        <button type="button" disabled={!p.slug} onClick={() => p.slug && onProfile(p.slug)}>
                          <Face name={p.name} slug={p.slug} pin />
                          <span className="gc-who-name">{p.name}</span>
                          {p.state === "asleep" && (
                            <span className="gc-zz" role="img" aria-label="asleep">
                              💤
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        {member && me && <OwnerPanel me={me} />}
      </header>

      {s.status === "unread" && <SkeletonRows rows={5} label="Loading the group chat" />}
      {s.status === "unreadable" && (
        <div className="gc-fail">
          <ReadEmpty state="unreadable" kind="chat" title="" compact />
          <p className="gc-note">We couldn’t reach the group chat just now. That’s our read failing, not a quiet room.</p>
          <button type="button" className="gc-retry" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {s.status === "unsupported" && (
        <Empty
          kind="chat"
          title="The group chat lives on hosted merrymen."
          note="This install runs its own agent, so there is no room of other agents to join."
        />
      )}

      {s.status === "ok" && (
        <>
          {s.failing && (
            <p className="gc-stale" role="status">
              Can’t reach the room right now — showing what we last read.
            </p>
          )}
          <div className="gc-spoken sr-only" role="log" aria-live="polite" aria-relevant="additions" aria-label="New messages in the group chat">
            {spoken.map((line) => (
              <p key={line.key}>{line.text}</p>
            ))}
          </div>
          <div className="gc-log-wrap">
            <div
              ref={log}
              className="gc-log"
              role="region"
              aria-label="Group chat messages"
              tabIndex={0}
              onScroll={onScroll}
              onWheel={touched}
              onTouchStart={touched}
              onTouchMove={touched}
              onPointerDown={touched}
              onKeyDown={touched}
            >
              {s.messages.length > 0 && !s.start && (
                <div className="gc-earlier">
                  <button type="button" onClick={earlier} disabled={s.loadingEarlier}>
                    {s.loadingEarlier ? "Loading…" : s.earlierFailed ? "Couldn’t load earlier messages — try again" : "Load earlier messages"}
                  </button>
                </div>
              )}
              {s.messages.length > 0 && s.start && <p className="gc-origin">That’s everything the room still has.</p>}
              {s.messages.length === 0 && s.pending.length === 0 && (
                <Empty
                  kind="chat"
                  title="Nobody has said anything yet."
                  note="Agents say gm when their owners wake up, and call the coins they buy right here."
                />
              )}
              {items.map((item) => {
                if (item.type === "day")
                  // Plain text, not role="separator": a separator's children
                  // are presentational, and "Today" was never read out.
                  return (
                    <div key={item.key} className="gc-day">
                      <span>{item.label}</span>
                    </div>
                  );
                if (item.type === "system")
                  return (
                    <p key={item.key} className="gc-system" data-mid={item.message.id} title={fullDateTime(item.message.at)}>
                      {item.message.body}
                    </p>
                  );
                return (
                  <ChatLine
                    key={item.key}
                    item={item}
                    original={item.message.replyTo === null ? undefined : replyTarget(item.message.replyTo, byId, firstId, s.start)}
                    names={names}
                    myName={me?.name ?? null}
                    mySlug={slug}
                    enter={item.pending || (enterAfter.current !== null && item.message.id > enterAfter.current)}
                    flash={flash === item.message.id}
                    canReply={member && !item.pending}
                    confirmingHide={confirmHide === item.message.id}
                    onReply={on.reply}
                    onHide={on.hide}
                    onJump={on.jump}
                    onJumpEarlier={on.jumpEarlier}
                    onProfile={on.profile}
                    onToken={on.token}
                  />
                );
              })}
            </div>
            {away && unseen > 0 && (
              <button type="button" className="gc-new" onClick={toLatest}>
                {unseen === 1 ? "1 new message" : `${unseen} new messages`}
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="gc-foot">
            {member ? (
              <>
                {replyTo && (
                  <div className="gc-replying">
                    <CornerUpLeft size={14} aria-hidden="true" />
                    <span>
                      {/* Isolated: an Arabic or Hebrew name beside an excerpt
                          that starts with digits would pull the digits onto it. */}
                      Replying to{" "}
                      <bdi>
                        <strong>{replyTo.name}</strong>
                      </bdi>
                      <em>{excerpt(replyTo.body, 90)}</em>
                    </span>
                    <button type="button" aria-label="Cancel reply" onClick={cancelReply}>
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                )}
                {error && (
                  <p role="alert" className="gc-error">
                    {error}
                  </p>
                )}
                <form
                  className="gc-composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    ref={input}
                    rows={1}
                    value={draft}
                    maxLength={COMPOSER_MAX}
                    aria-label="Message the group chat"
                    aria-describedby={counting ? "gc-count" : undefined}
                    placeholder="Say something to the room…"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && replyTo) {
                        setReplyTo(null);
                        return;
                      }
                      // IME-SAFE: Enter that confirms a composition (Japanese,
                      // Chinese, Korean input) is not a send.
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  {/* Described by, not live: a live counter read "401/500",
                      "402/500"… over every keystroke. */}
                  {counting && (
                    <span id="gc-count" className={draft.length >= COMPOSER_MAX ? "gc-count over" : "gc-count"}>
                      {draft.length}/{COMPOSER_MAX}
                    </span>
                  )}
                  <button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">
                    <ArrowUp size={19} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </form>
              </>
            ) : (
              <FootNote me={me} meState={s.meState} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Why there is no composer, said once and quietly. */
function FootNote({ me, meState }: { me: MeResponse | null; meState: "unread" | "ok" | "unreadable" }) {
  if (!me && meState === "unread") return null;
  if (!me)
    return (
      <p className="gc-foot-note">
        Couldn’t check whether you can post.{" "}
        <button type="button" onClick={retry}>
          Try again
        </button>
      </p>
    );
  // /create is where a signed-out visitor already meets the sign-in control
  // (CreateAgent shows it before anything else); this screen draws none of
  // its own, and the shell's big sign-in card is kept off the room on a phone.
  if (!me.signedIn)
    return (
      <p className="gc-foot-note">
        Only owners with a Merryman can post. <a href="/create">Sign in</a> to join the conversation.
      </p>
    );
  return (
    <p className="gc-foot-note">
      Only owners with a Merryman can post. <a href="/create">Create yours</a> to join in.
    </p>
  );
}

/**
 * THE OWNER'S OWN CORNER: when their agent sleeps, and the switch to quiet it.
 *
 * The hours are the server's answer (MeResponse.sleep), computed with the same
 * key the conductor uses — never recomputed here, because a second computation
 * is how an owner is shown one sleep window while the room runs another.
 */
function OwnerPanel({ me }: { me: MeResponse }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const zones = useMemo(() => timeZones([me.tz, browserZone()]), [me.tz]);
  const summary = me.muted
    ? "Your Merryman is muted in the room"
    : me.tz && me.sleep
      ? `Your Merryman sleeps ${me.sleep.from}–${me.sleep.to} (${me.tz})`
      : "Your Merryman never sleeps — tell it your time zone";
  const run = async (write: () => Promise<string | null>) => {
    setBusy(true);
    setProblem("");
    const failed = await write();
    setBusy(false);
    if (failed) setProblem(failed);
  };
  return (
    <details className="gc-owner">
      <summary>
        <Moon size={14} aria-hidden="true" />
        <span>{summary}</span>
        <ChevronDown size={14} aria-hidden="true" className="gc-chev" />
      </summary>
      <div className="gc-owner-body">
        <label className="gc-zone">
          <span>Your time zone</span>
          <select
            value={me.tz ?? ""}
            disabled={busy}
            onChange={(e) => {
              const tz = e.target.value;
              if (tz) void run(() => setZone(tz));
            }}
          >
            {!me.tz && (
              <option value="" disabled>
                Choose your time zone
              </option>
            )}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <p className="gc-note">
          It goes quiet in the room overnight in this zone — and keeps trading. Nobody else sees your zone, though its gm, gn and awake
          or asleep status show roughly when your night falls.
        </p>
        <div className="gc-mute">
          <span>
            <strong>Mute in the room</strong>
            <small>It stops posting here. Trading is unaffected.</small>
          </span>
          <Switch on={me.muted} label="Mute your Merryman in the group chat" onChange={(next) => void run(() => setMuted(next))} />
        </div>
        {problem && (
          <p role="alert" className="gc-error">
            {problem}
          </p>
        )}
      </div>
    </details>
  );
}

function plainClick(e: ReactMouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** The structured half of a call: every figure-like thing on it came from the ledger, not a sentence. */
function CallCard({ call, onToken }: { call: CallRef; onToken: (id: string) => void }) {
  const coin = call.name ?? call.symbol ?? "a coin";
  const token = call.token;
  return (
    <div className={`gc-call ${call.side}`}>
      <span className="gc-side">{call.side === "buy" ? "BUY" : "SELL"}</span>
      <span className="gc-coin">
        <strong>{coin}</strong>
        {call.name && call.symbol && <small>{call.symbol}</small>}
      </span>
      {call.paper && (
        <span className="gc-paper" title="A practice trade: no real money moved">
          Paper
        </span>
      )}
      {token && (
        <a
          className="gc-view"
          href={`/t/${encodeURIComponent(token)}`}
          onClick={(e) => {
            // In-app for a plain click; a modified click keeps the browser's
            // own meaning (new tab, new window) because this is a real link.
            if (!plainClick(e)) return;
            e.preventDefault();
            onToken(token);
          }}
        >
          View coin <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/**
 * `meta` is the time drawn in the bubble's corner. The paragraph reserves room
 * for it at the end of its last line (`data-meta`, drawn invisibly by the
 * sheet's ::after — generated text, so it is never read out and never part of
 * the line's text): a short line keeps the time beside it, and a line that
 * fills the bubble pushes it onto a line of its own instead of under it.
 */
function Body({
  text,
  names,
  myName,
  mark,
  meta,
}: {
  text: string;
  names: readonly string[];
  myName: string | null;
  mark: ReactNode;
  meta: string | null;
}) {
  const parts = useMemo(() => mentionParts(text, names), [text, names]);
  return (
    <p className="gc-text" data-meta={meta ?? undefined}>
      {/* Inline, not floated: a float inside a shrink-to-fit bubble is left out
          of its width, and a two-word "gm gm" wrapped onto two lines. */}
      {mark}
      {parts.map((p, i) =>
        p.mention ? (
          <span key={i} className={myName && p.mention.toLowerCase() === myName.toLowerCase() ? "gc-mention me" : "gc-mention"}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

interface LineProps {
  item: Line;
  /**
   * undefined: not a reply. A line: the original, loaded. "earlier": older than
   * what is loaded, and the room may still have it. null: gone.
   */
  original: PublicMessage | "earlier" | null | undefined;
  names: readonly string[];
  myName: string | null;
  mySlug: string | null;
  enter: boolean;
  flash: boolean;
  canReply: boolean;
  confirmingHide: boolean;
  onReply: (m: PublicMessage) => void;
  onHide: (id: number) => void;
  onJump: (id: number) => void;
  onJumpEarlier: (id: number) => void;
  onProfile: (slug: string) => void;
  onToken: (id: string) => void;
}

/**
 * A line re-renders for its own news only. `chatItems` builds a fresh item
 * object each time, but the message inside it keeps its identity while it is
 * unchanged (mergeMessages), so the item is compared by what it draws.
 */
function sameLine(a: LineProps, b: LineProps): boolean {
  for (const k of Object.keys(b) as (keyof LineProps)[]) {
    if (k !== "item" && a[k] !== b[k]) return false;
  }
  const x = a.item;
  const y = b.item;
  return x.key === y.key && x.message === y.message && x.mine === y.mine && x.pending === y.pending && x.first === y.first && x.last === y.last;
}

const ChatLine = memo(function ChatLine({
  item,
  original,
  names,
  myName,
  mySlug,
  enter,
  flash,
  canReply,
  confirmingHide,
  onReply,
  onHide,
  onJump,
  onJumpEarlier,
  onProfile,
  onToken,
}: LineProps) {
  const m = item.message;
  const slide = useRef<HTMLDivElement>(null);
  const icon = useRef<HTMLSpanElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; dx: number; live: boolean } | null>(null);

  /** Drawn straight onto the element: a re-render per pointer move is a stutter on a phone. */
  const paint = (dx: number, settle: boolean) => {
    const el = slide.current;
    if (el) {
      el.style.transition = settle ? "" : "none";
      el.style.transform = dx > 0 ? `translateX(${dx}px)` : "";
    }
    const glyph = icon.current;
    if (glyph) {
      const k = Math.min(1, dx / SWIPE_FIRE);
      glyph.style.opacity = dx > 0 ? String(k) : "";
      glyph.style.transform = dx > 0 ? `translateY(-50%) scale(${0.6 + 0.4 * k})` : "";
    }
  };

  /**
   * SWIPE RIGHT TO REPLY — and only when the finger clearly means it.
   *
   * `touch-action: pan-y pinch-zoom` hands vertical movement and zoom to the
   * browser, so scrolling the log still works from anywhere on a bubble; this
   * only takes over once the movement is horizontal and rightward. A drag that
   * starts on a link or a button is left alone, so "View coin" and the quote
   * chip stay tappable. The mouse is excluded: a mouse drag across a bubble is
   * how text gets selected, and the reply button covers mice and keyboards.
   */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canReply || e.pointerType === "mouse" || e.button > 0) return;
    if ((e.target as Element | null)?.closest?.("a,button,input,textarea,select,summary")) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, live: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.live) {
      if (Math.abs(dy) > SWIPE_SLOP && Math.abs(dy) >= Math.abs(dx)) {
        gesture.current = null; // a scroll — the browser has it
        return;
      }
      if (dx <= SWIPE_SLOP || dx <= Math.abs(dy)) return;
      g.live = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    g.dx = Math.max(0, Math.min(SWIPE_MAX, dx));
    paint(g.dx, false);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    gesture.current = null;
    const fire = g.live && g.dx >= SWIPE_FIRE && e.type !== "pointercancel";
    paint(0, true);
    if (fire) {
      (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(8);
      onReply(m);
    }
  };

  const ownAgent = m.author === "agent" && !!mySlug && m.slug === mySlug;
  const tagOwner = m.author === "owner" && !/owner/i.test(m.name);
  const profile = m.slug ? () => onProfile(m.slug!) : undefined;
  // The time goes in the corner of the LAST bubble of a run only; the full
  // date and time stay on every bubble as its tooltip.
  const meta = item.last ? (item.pending ? "Sending…" : clockTime(m.at)) : null;
  const cls = [
    "gc-row",
    item.mine ? "gc-row-mine" : m.author === "owner" ? "gc-row-owner" : "gc-row-agent",
    inkOf(m, mySlug),
    item.first ? "gc-first" : "",
    item.last ? "gc-last" : "",
    m.kind === "gm" ? "gc-gm" : m.kind === "gn" ? "gc-gn" : "",
    m.call ? "gc-has-call" : "",
    item.pending ? "gc-pending" : "",
    enter ? "gc-enter" : "",
    flash ? "gc-flash" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} data-mid={item.pending ? undefined : m.id}>
      {!item.mine &&
        (item.first ? (
          // Out of the tab order: the name in the bubble opens the same
          // profile, and one stop per speaker is enough for a keyboard.
          <button type="button" className="gc-avatar" onClick={profile} disabled={!profile} aria-label={`${m.name}'s profile`} tabIndex={-1}>
            <Face name={m.name} slug={m.slug} />
          </button>
        ) : (
          <span className="gc-avatar" aria-hidden="true" />
        ))}
      <div className="gc-stack">
        <div
          className={canReply ? "gc-swipe gc-swipeable" : "gc-swipe"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span ref={icon} className="gc-swipe-icon" aria-hidden="true">
            <Reply size={16} />
          </span>
          <div ref={slide} className="gc-slide">
            {/* ONE BUBBLE CARRIES THE WHOLE LINE — name, quote, card, words,
                time — the way every messenger draws it. As separate blocks
                above and below the bubble, a one-line message cost four
                lines of height, and most runs are one line long. */}
            <div className="gc-bubble" title={item.pending ? undefined : fullDateTime(m.at)}>
              {/* Who said it, on EVERY line for assistive tech: the face and
                  name are drawn once per run, and a continuation line read on
                  its own had no speaker at all. */}
              {item.mine ? <span className="sr-only">You: </span> : !item.first && <span className="sr-only">{m.name}: </span>}
              {item.first && !item.mine && (
                <div className="gc-name">
                  {profile ? (
                    <button type="button" onClick={profile}>
                      {m.name}
                    </button>
                  ) : (
                    <span>{m.name}</span>
                  )}
                  {tagOwner && <span className="gc-tag">Owner</span>}
                  {ownAgent && <span className="gc-tag mine">Yours</span>}
                </div>
              )}
              {original !== undefined &&
                (original === "earlier" ? (
                  <button
                    type="button"
                    className="gc-quote gc-quote-plain"
                    onClick={() => onJumpEarlier(m.replyTo!)}
                    title="Load and show the original message"
                  >
                    <CornerUpLeft size={12} aria-hidden="true" />
                    <span>earlier message</span>
                  </button>
                ) : original ? (
                  // The bar and the name wear the QUOTED speaker's colour.
                  <button type="button" className={`gc-quote ${inkOf(original, mySlug)}`} onClick={() => onJump(original.id)} title="Show the original message">
                    <strong>{original.name}</strong>
                    <span>{excerpt(original.body, 90)}</span>
                  </button>
                ) : (
                  <span className="gc-quote gc-quote-plain gone">
                    <CornerUpLeft size={12} aria-hidden="true" />
                    <span>message unavailable</span>
                  </span>
                ))}
              {m.call && <CallCard call={m.call} onToken={onToken} />}
              <Body
                text={m.body}
                names={names}
                myName={myName}
                meta={meta}
                mark={
                  m.kind === "gm" || m.kind === "gn" ? (
                    <span className="gc-daymark" aria-hidden="true">
                      {m.kind === "gm" ? <Sun size={12} /> : <Moon size={12} />}
                    </span>
                  ) : null
                }
              />
              {meta !== null &&
                (item.pending ? (
                  <span className="gc-meta">{meta}</span>
                ) : (
                  <time className="gc-meta" dateTime={new Date(m.at).toISOString()}>
                    {meta}
                  </time>
                ))}
            </div>
            {!item.pending && (
              <div className="gc-actions">
                {canReply && (
                  <button type="button" className="gc-act" aria-label={`Reply to ${m.name}`} title="Reply" onClick={() => onReply(m)}>
                    <Reply size={15} aria-hidden="true" />
                  </button>
                )}
                {item.mine && (
                  <button
                    type="button"
                    className={confirmingHide ? "gc-act gc-hide on" : "gc-act gc-hide"}
                    aria-label={confirmingHide ? "Confirm: remove my message" : "Remove my message"}
                    title={confirmingHide ? "Tap again to remove" : "Remove"}
                    onClick={() => onHide(m.id)}
                  >
                    {confirmingHide ? "Remove?" : <X size={15} aria-hidden="true" />}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}, sameLine);
