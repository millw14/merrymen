"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontal, X } from "lucide-react";

/**
 * THE CHAT, BESIDE THE APP INSTEAD OF INSTEAD OF IT.
 *
 * Reported: "for pc can you make the chat more easy? like maybe aligning it to
 * the right like a small popup that can be moved around", and separately "i
 * dont find it intuitive to get to the page where im talking to the agent. i
 * have to click around a bunch".
 *
 * Both come from the same decision. On desktop, "Chat with X" called
 * `onTab("agent")`, which REPLACES the centre of the app — so talking to your
 * agent meant giving up the chart, the token you were reading and the
 * leaderboard, and getting back to any of them meant navigating away from the
 * conversation. On a phone that is right, because a phone shows one thing. On a
 * 1400px screen it throws away most of the screen to show one column.
 *
 * WHAT THIS IS NOT: a second chat. It renders the SAME agent screen, with the
 * same props and the same state, in a floating container — so there is one
 * conversation, one draft and one set of turns however it is opened. A second
 * implementation would be a second place for the model's words to diverge from
 * what the agent actually did, which is the thing this codebase is most careful
 * about.
 *
 * DRAGGED BY ITS HEADER, and the position is remembered. Free-floating rather
 * than snapped to a corner because the thing it must not cover is whatever the
 * owner is reading, and only they know what that is.
 *
 * IT STAYS ON SCREEN. A panel dragged to the edge of a wide monitor and then
 * reopened on a laptop would be a panel nobody can reach and nobody can close,
 * so the stored position is clamped to the current window on every open and on
 * every resize — the same reason `adoptShared` clamps a cooldown it did not
 * write.
 */

const POS_KEY = "merrymen.chatdock.pos.v1";

interface Pos {
  x: number;
  y: number;
}

const WIDTH = 396;
/** Keep at least this much of the panel reachable, so it can always be grabbed. */
const EDGE = 72;

function clampToWindow(p: Pos, h: number): Pos {
  if (typeof window === "undefined") return p;
  const maxX = Math.max(0, window.innerWidth - WIDTH);
  const maxY = Math.max(0, window.innerHeight - Math.min(h, EDGE * 2));
  return {
    x: Math.min(Math.max(p.x, 0), maxX),
    y: Math.min(Math.max(p.y, 0), maxY),
  };
}

/** Bottom-right, a comfortable margin in from both edges. */
function defaultPos(): Pos {
  if (typeof window === "undefined") return { x: 0, y: 0 };
  return { x: Math.max(0, window.innerWidth - WIDTH - 28), y: 76 };
}

export function ChatDock({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<Pos | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // Position is read once, on mount, and clamped — see the header. A stored
  // position from a wider monitor must not put the panel where it cannot be
  // reached, and localStorage throws outright in some privacy modes.
  useEffect(() => {
    let start = defaultPos();
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<Pos>;
        if (typeof p.x === "number" && typeof p.y === "number") start = { x: p.x, y: p.y };
      }
    } catch {
      /* no memory of where it was; it opens where it always opens */
    }
    setPos(clampToWindow(start, panel.current?.offsetHeight ?? 480));
  }, []);

  // And again whenever the window changes size, for the same reason.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampToWindow(p, panel.current?.offsetHeight ?? 480) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const node = panel.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.preventDefault();
    setPos(clampToWindow({ x: e.clientX - d.dx, y: e.clientY - d.dy }, panel.current?.offsetHeight ?? 480));
  }, []);

  const onPointerUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => {
      if (p) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(p));
        } catch {
          /* it simply opens in the default place next time */
        }
      }
      return p;
    });
  }, []);

  // Escape closes it, because a floating panel over your work should always
  // have the same way out as every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={panel}
      className="chat-dock"
      role="dialog"
      aria-label={`Chat with ${title}`}
      // Hidden until the position is known, so it never appears in the
      // top-left corner for a frame before jumping to where it belongs.
      style={pos ? { left: pos.x, top: pos.y } : { visibility: "hidden" }}
    >
      <div
        className="chat-dock-grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GripHorizontal size={15} aria-hidden="true" />
        <strong>{title}</strong>
        <button type="button" onClick={onClose} aria-label="Close chat">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="chat-dock-body">{children}</div>
    </div>
  );
}
