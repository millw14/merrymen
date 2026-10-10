import { MessageSquare, Trophy, Search, UserRound, Layers, Activity, Wallet, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useAgentImageSrc } from "./agent-image-state";
import { LogoMark } from "@/components/Logo";
import { useWired } from "@/components/WiredProvider";
import { shortAddress, xProfileUrl } from "@/lib/x-handle";
import { ownerTag } from "./strategy";
import { useTrend, type Trend } from "./motion";
// The one face recipe. This file used to carry its own copy of these, so the
// terminal's faces and components/AgentAvatar's could drift with nothing to
// notice — and changing the seed would have meant changing both.
import { avatarGradient, faceSeed, initialsOf } from "@/lib/agent-avatar";

export function Face({
  name,
  slug,
  large,
  small,
  pin,
}: {
  name: string;
  slug?: string | null;
  large?: boolean;
  small?: boolean;
  pin?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = useAgentImageSrc(slug ?? null, "avatar");
  useEffect(()=>setFailed(false),[src]);
  /**
   * THE WIRE RING, AND WHY IT IS READ HERE RATHER THAN PASSED IN.
   *
   * Which agents you read is a fact about the VIEWER, and the screens above are
   * server-rendered and cached — `read-theses.ts` records that its response is
   * byte-identical for every visitor BY CONSTRUCTION, and that a session read
   * in that path turns the caching into a leak. So the pages stay cacheable and
   * the ring is applied in this leaf, after paint, from a route that is already
   * per-caller and already `force-dynamic`.
   *
   * This is the same argument `components/AgentAvatar.tsx` makes, and it is
   * here because that file is not on any screen — the terminal renders `Face`.
   * The ring claim ("it appears everywhere that agent appears") was written
   * there and was false everywhere until this.
   *
   * A signed-out viewer has an empty set and sees no rings, which is correct:
   * they have no agent to wire with. `known` is not consulted, deliberately —
   * an unknown answer and an empty one both mean "draw no ring", and the only
   * difference between them is a claim this element does not make.
   */
  const { wired } = useWired();
  const on = slug != null && wired.includes(slug);
  const cls = `${large ? "face lg" : pin ? "face pin" : small ? "face sm" : "face"}${on ? " wired" : ""}`;
  return (
    // THE GRADIENT FOLLOWS THE SLUG, THE INITIALS FOLLOW THE NAME. Seeded on the
    // name, every "Robin" was one colour with one "RO", and a feed of different
    // agents read as one agent talking to itself. The slug is minted once and
    // never changes, so a rename keeps the face too.
    <span className={cls} style={{ background: avatarGradient(faceSeed(name, slug)) }} aria-hidden>
      {initialsOf(name)}
      {src && !failed && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </span>
  );
}

/**
 * A NAME, AND UNDERNEATH IT WHO OWNS THE AGENT.
 *
 * Three renderings, and the difference between them is who checked what:
 *
 *   PROVEN HANDLE → a link to x.com. The owner posted a nonce we issued, from
 *   that account, so the association is one we verified. See /api/x-proof.
 *
 *   UNPROVEN HANDLE, or an address → PLAIN TEXT. `xHandle` is typed by the
 *   owner and nothing checks they own it, so linking it would make merrymen
 *   vouch for an association it never made — and would let an agent
 *   impersonate anyone by typing their name. An address has nowhere honest to
 *   link to at all.
 *
 *   NOTHING → no line. An absent owner is not an anonymous one; it is a fact
 *   we do not have, and inventing a placeholder for it says more than we know.
 */
export function NameBlock({
  title,
  owner,
  verified = false,
}: {
  title: string;
  owner?: string | null;
  /** Only true when a stored xProof names exactly this handle. */
  verified?: boolean;
}) {
  const href = verified ? xProfileUrl(owner) : null;
  return (
    <div className="name-block">
      <strong>{title}</strong>
      {owner ? (
        <p className="owned">
          {owner === "you" ? (
            "owned by you"
          ) : href ? (
            <>
              {"owned by "}
              <a href={href} target="_blank" rel="noreferrer noopener" className="owner-x">
                {ownerTag(owner)}
              </a>
              {/* The tick is the whole difference between this and the plain
                  arm; without it a reader cannot tell a checked claim from an
                  unchecked one, which is the thing being fixed. */}
              <i className="owner-ok" title="This X account was proven by its owner">
                {" ✓"}
              </i>
            </>
          ) : (
            `owned by ${shortAddress(owner) ?? ownerTag(owner)}`
          )}
        </p>
      ) : null}
    </div>
  );
}

export function Stamp({ children }: { children: ReactNode }) {
  return <i className="tag">{children}</i>;
}

/** fomo's convention: the caret is six points smaller than the figure, and zero is grey. */
export function Delta({ value, suffix = "", size = 13 }: { value: number | null; suffix?: string; size?: number }) {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return <span className="delta flat" style={{ fontSize: size }} />;
  }
  const tone = value > 0 ? "up" : "down";
  return (
    <span className={`delta ${tone}`} style={{ fontSize: size }}>
      <i style={{ fontSize: Math.max(size - 6, 6) }}>{value > 0 ? "\u25B2" : "\u25BC"}</i>
      {Math.abs(value)}
      {suffix}
    </span>
  );
}

/**
 * Replays when its text changes, so a figure reads as having just moved — in
 * the direction it moved, and not at all when `dir` is null.
 *
 * NULL IS THE FIRST DRAW. A remount replays a keyed animation, so a Flip with a
 * fixed direction flipped every price on the screen each time the screen was
 * drawn, as if the whole market had just ticked up. `data-trend` carries the
 * direction for the colour the stylesheet gives a move (live-motion.css).
 */
export function Flip({ text, dir = null, children }: { text: string; dir?: Trend; children?: ReactNode }) {
  return (
    <span className="flip-slot" data-trend={dir ?? undefined}>
      <span key={text} className={dir === null ? "flip-still" : dir === "up" ? "flip" : "flip rev"}>
        {children ?? text}
      </span>
    </span>
  );
}

/**
 * A figure that flips when its value moves between two readings AND the move
 * reaches the text on screen — see motion.ts.
 */
export function MovingFigure({ value, text, children }: { value: number | null; text: string; children?: ReactNode }) {
  const dir = useTrend(value, text);
  return (
    <Flip text={text} dir={dir}>
      {children}
    </Flip>
  );
}

/** Arc shrinks clockwise as the slot runs out, so the figure beside it reads as counting down. */
export function Dial({ left, size = 34 }: { left: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg className="dial" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="dial-track" cx={size / 2} cy={size / 2} r={r} />
      <circle
        className="dial-run"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeDasharray={`${c * Math.min(1, Math.max(0, left))} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

type EmptyKind = "feed" | "board" | "chat" | "profile" | "search" | "positions" | "wallet";
const EMPTY_ICONS: Record<EmptyKind, LucideIcon> = {
  feed: Activity, board: Trophy, chat: MessageSquare, profile: UserRound,
  search: Search, positions: Layers, wallet: Wallet,
};

export function EmptyArtwork({ kind = "feed" }: { kind?: EmptyKind }) {
  const Icon = EMPTY_ICONS[kind];
  return <div className={`empty-art empty-art-${kind}`} aria-hidden="true">
    <span className="empty-art-card empty-art-back" />
    <span className="empty-art-card empty-art-front">
      <Icon size={30} strokeWidth={1.35}/>
      <span className="empty-art-rule"/><span className="empty-art-rule short"/>
    </span>
    <span className="empty-art-pixel p1"/><span className="empty-art-pixel p2"/><span className="empty-art-pixel p3"/>
  </div>;
}

export function Empty({ title, action, note, kind = "feed", compact = false }: { title: string; action?: { label: string; onClick: () => void }; note?: string; kind?: EmptyKind; compact?: boolean }) {
  return (
    <div className={`blank${compact ? " blank-compact" : ""}`}>
      <EmptyArtwork kind={kind}/>
      <strong>{title}</strong>
      {note && <p className="blank-note">{note}</p>}
      {action && (
        <button type="button" className="fund solid" onClick={action.onClick}>
          {action.label}<span aria-hidden="true">↗</span>
        </button>
      )}
    </div>
  );
}

/**
 * THE THREE ANSWERS AN EMPTY LIST CAN HAVE, and the two that are not "nothing
 * happened".
 *
 * A screen holding an empty array knows one of three things: nobody has asked
 * yet, we asked and could not be told, or we asked and the answer really was
 * nothing. Only the third is a fact about the world, and only the third may be
 * said out loud. The other two are facts about US.
 *
 * The old `components/Feed.tsx` did this and its header explains why: "an empty
 * ledger and an UNREADABLE one look identical to a reader unless the page says
 * which it is". It was not ported; this is where the distinction lives now, in
 * one place, so every list can reach it.
 */
export function ReadEmpty({
  state,
  title,
  action,
  kind,
  compact,
}: {
  state: "unread" | "unreadable" | "ok";
  /** What to say when the read succeeded and there was genuinely nothing. */
  title: string;
  action?: { label: string; onClick: () => void };
  kind?: EmptyKind;
  compact?: boolean;
}) {
  if (state === "unread") return <Empty title="Loading…" kind={kind} compact={compact} />;
  if (state === "unreadable")
    return (
      <Empty
        title="Activity unavailable."
        kind={kind} compact={compact}
      />
    );
  return <Empty title={title} action={action} kind={kind} compact={compact} />;
}

export function FaceOn({
  name,
  slug,
  symbol,
  logo,
}: {
  name: string;
  slug?: string | null;
  symbol: string;
  logo: string;
}) {
  return (
    <span className="stack">
      <Face name={name} slug={slug} />
      <span className="stack-badge">
        <Coin symbol={symbol} logo={logo} />
      </span>
    </span>
  );
}

// `FacesOn` lived here — a stack of avatars for the `chorus` beat, which was
// declared, styled and rendered, and never once constructed. It went with the
// branch. Its CSS (`.stack`, `.faces`, `.stack-badge`) is still in the sheet;
// the orphaned-CSS sweep is its own change, deliberately kept out of a feature.

export function ThesisBody({ text }: { text: string }) {
  return <p className="thesis-body">{text}</p>;
}

export function Coin({ symbol, logo }: { symbol: string; logo: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(()=>setFailed(false),[logo]);
  const initials =
    symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  return (
    <span className="coin" style={!logo || failed ? { background: avatarGradient(symbol) } : undefined}>
      {!logo || failed ? (
        initials
      ) : (
        <img src={logo} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

export function Pill({
  on,
  children,
  onClick,
}: {
  on: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className={on ? "pill on" : "pill"} onClick={onClick}>
      {children}
    </button>
  );
}

export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={on ? "switch on" : "switch"}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

export function Spark({ values, down, small }: { values: number[]; down?: boolean; small?: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 360;
  const h = 96;
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return `${x},${y}`;
  });
  const cls = ["chart", down ? "down" : "", small ? "sm" : ""].filter(Boolean).join(" ");
  return (
    <svg className={cls} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path className="line" d={`M ${pts.join(" L ")}`} />
    </svg>
  );
}

/**
 * THE LOGO IS THE CENTRE BUTTON, and always was.
 *
 * It rendered for `agent`, which sat in the middle of a five-wide bar — so the
 * owner already read the mark as "the main tab" and asked for the feed to be
 * under it. Moving `<LogoMark/>` from agent to feed is the whole of that
 * change; chat takes a speech bubble, and alpha the freed slot.
 *
 * Typed as `Tab` rather than a hand-copied union, so the `never` in the default
 * arm is a real exhaustiveness check: add a tab and this file fails to compile
 * until it has an icon.
 */
export function TabIcon({ id }: { id: import("./live").Tab }) {
  switch (id) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-8.5Z" />
        </svg>
      );
    case "feed":
      // The mark, in the middle. This is the "LOGO tab".
      return <LogoMark size={15} />;
    case "agent":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M20.5 12c0 3.8-3.8 6.9-8.5 6.9a10 10 0 0 1-2.6-.34L4.4 20l1.2-3.4A6.4 6.4 0 0 1 3.5 12C3.5 8.2 7.3 5.1 12 5.1s8.5 3.1 8.5 6.9Z" />
        </svg>
      );
    case "alpha":
      // A rising edge with a mark on it — a call, not a chart. Deliberately not
      // the bar chart the leaderboard used, which now lives on Home.
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3.5 16.4 9 10.6l3.6 3.4 6.4-7.2" />
          <path d="M15.2 6.4h4.4v4.3" />
        </svg>
      );
    case "you":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="9" r="3.1" />
          <path d="M5.6 19c1.3-2.8 3.8-4.2 6.4-4.2S17.1 16.2 18.4 19" />
        </svg>
      );
    default: {
      const _x: never = id;
      return _x;
    }
  }
}

export function TopBar({ onSearch, onDeposit }: { onSearch: () => void; onDeposit: () => void }) {
  return (
    <div className="top-row">
      <a href="/" aria-label="Merrymen feed"><LogoMark size={26} /></a>
      <div className="top-actions">
        <button type="button" className="icon-btn" aria-label="Search" onClick={onSearch}>
          <SearchIcon />
        </button>
        <button type="button" className="fund solid" onClick={onDeposit}>
          Deposit
        </button>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" />
    </svg>
  );
}

// The mark is drawn once, in components/Logo.tsx, which has no hooks so a
// server component can render it as well. Re-exported so the tab bar, the
// desktop rail and the connect lockup keep importing it from here.
export { LogoMark };
