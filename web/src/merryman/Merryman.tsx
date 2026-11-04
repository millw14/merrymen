"use client";
/**
 * <Merryman/>: THE 3D CHARACTER, MOUNTED.
 *
 * Renders the flat SVG first — on the server, in tests, and for the instant
 * before three.js arrives — then swaps in a live stage loaded through a
 * dynamic import, so no page pays for WebGL until it shows a merryman. On a
 * device without WebGL, or when the context is lost, the flat one stays.
 *
 * Props are declarative: `base` is the mood loop (it crossfades when it
 * changes), `cue` plays a one-shot each time its `key` changes, so a parent can
 * fire "an arrow, because a buy just landed" without holding a ref.
 */
import { useEffect, useRef, useState } from "react";
import { MerrymanFlat } from "./MerrymanFlat";
import { outfitKey, type Outfit } from "./outfit";
import { useOutfit } from "./wardrobe-store";
import type { Framing, Stage } from "./stage";
// merryman.css is imported once by the shell (terminal/App.tsx): node tests
// render screens that mount this component, and they cannot import CSS.

export type Cue = { key: string | number; clip: string };

/**
 * CAN THIS BROWSER DRAW HIM? Asked once per page: the answer cannot change
 * while the page is open, and every probe is a real context created and thrown
 * away — one per leaderboard row, before this was cached. A context lost later
 * is the stage's own onLost and portraitOf's concern.
 */
let webgl: boolean | undefined;
function webglAvailable(): boolean {
  return (webgl ??= probeWebgl());
}
function probeWebgl(): boolean {
  // jsdom (the node tests) has a canvas with no context; asking it prints a
  // "not implemented" error into the test output for nothing.
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return false;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function Merryman({
  outfit,
  base = "idle",
  cue,
  framing = "full",
  interactive = true,
  ground = true,
  className = "",
  label,
  bubble,
  bubbleTone = "calm",
  onTap,
}: {
  outfit: Outfit;
  base?: string;
  cue?: Cue | null;
  framing?: Framing;
  interactive?: boolean;
  ground?: boolean;
  className?: string;
  /** Accessible name, e.g. "Robin, your merryman, napping". */
  label?: string;
  /** A speech bubble over his head. */
  bubble?: string | null;
  bubbleTone?: "good" | "calm" | "warn" | "bad";
  onTap?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [live, setLive] = useState<"loading" | "ready" | "flat">("loading");
  const latest = useRef({ outfit, base, framing, onTap });
  latest.current = { outfit, base, framing, onTap };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (!webglAvailable()) { setLive("flat"); return; }
    let cancelled = false;
    const reduced = prefersReducedMotion();
    import("./stage")
      .then(({ createStage }) => {
        if (cancelled || !host.current) return;
        stage.current = createStage(host.current, {
          outfit: latest.current.outfit,
          base: latest.current.base,
          framing: latest.current.framing,
          interactive,
          ground,
          lively: !reduced,
          seed: Math.random() * 10,
          onTap: () => latest.current.onTap?.(),
          // The flat figure stays for good: dispose the stage so it can never
          // draw a second merryman under it after the context comes back.
          onLost: () => { stage.current?.dispose(); stage.current = null; setLive("flat"); },
        });
        setLive("ready");
      })
      .catch(() => { if (!cancelled) setLive("flat"); });
    // The setting can change while the page is open (an OS accessibility
    // toggle); follow it rather than reading it once.
    let media: MediaQueryList | null = null;
    const onMotion = () => stage.current?.setLively(!media?.matches);
    try {
      media = window.matchMedia("(prefers-reduced-motion: reduce)");
      media.addEventListener("change", onMotion);
    } catch {
      media = null;
    }
    return () => {
      cancelled = true;
      media?.removeEventListener("change", onMotion);
      stage.current?.dispose();
      stage.current = null;
    };
    // Built once per mount: outfit, mood and cues flow in through the effects below.
  }, [interactive, ground]);

  const key = outfitKey(outfit);
  useEffect(() => { stage.current?.setOutfit(outfit); }, [key, live]);
  useEffect(() => { stage.current?.setBase(base); }, [base, live]);
  useEffect(() => { stage.current?.setFraming(framing); }, [framing, live]);
  useEffect(() => { if (cue && live === "ready") stage.current?.play(cue.clip); }, [cue?.key, live]);

  // The picture and what he says are siblings: children of role="img" are
  // presentational, so a bubble inside it never reached a screen reader. The
  // live region stays mounted and only its text changes, which is what makes
  // a polite announcement fire; the visible bubble animates separately.
  return (
    <div className={`mm-merryman ${className}`} data-state={live} data-framing={framing}>
      <div className="mm-merryman-figure" role="img" aria-label={label ?? "Your merryman"}>
        <div className="mm-merryman-glow" aria-hidden />
        <div className="mm-merryman-stage" ref={host} aria-hidden />
        {live !== "ready" && (
          <div className={`mm-merryman-flat${live === "loading" ? " is-loading" : ""}`} aria-hidden>
            <MerrymanFlat outfit={outfit} size={framing === "portrait" ? 140 : 150} bust={framing === "portrait"} />
          </div>
        )}
      </div>
      {bubble ? (
        <div className={`mm-bubble tone-${bubbleTone}`} key={bubble} aria-hidden>
          {bubble}
        </div>
      ) : null}
      <span className="mm-sr-only" role="status" aria-live="polite">{bubble ?? ""}</span>
    </div>
  );
}

/**
 * A still of this exact outfit, rendered once through the shared offscreen
 * renderer when the browser is idle — null until then, or for ever without
 * WebGL, and the caller draws the flat SVG meanwhile.
 */
function usePortrait(outfit: Outfit, size: number): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const key = outfitKey(outfit);
  useEffect(() => {
    let cancelled = false;
    if (!webglAvailable()) return;
    const run = () =>
      import("./stage").then(({ portraitOf }) => {
        if (!cancelled) setSrc(portraitOf(outfit, Math.min(256, Math.round(size * 2))));
      }).catch(() => {});
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(run); else setTimeout(run, 30);
    return () => { cancelled = true; };
  }, [key, size]);
  return src;
}

/** A still portrait for lists, in its own rounded well. */
export function MerrymanPortrait({ outfit, size = 40, className = "", title }: { outfit: Outfit; size?: number; className?: string; title?: string }) {
  const src = usePortrait(outfit, size);
  return (
    <span className={`mm-portrait ${className}`} style={{ width: size, height: size }} title={title}>
      {src ? <img src={src} alt="" width={size} height={size} draggable={false} /> : <MerrymanFlat outfit={outfit} size={size} bust />}
    </span>
  );
}

/**
 * THE BOTTOM LAYER OF AN AGENT'S FACE, as a merryman instead of initials.
 * terminal/ui.tsx Face paints an uploaded picture over it when there is one,
 * exactly as it paints one over the gradient. The look is the owner's own
 * choice for their agent in this browser, or the one seeded on the slug.
 */
export function FaceFigure({ seed, slug }: { seed: string; slug: string | null }) {
  const { outfit } = useOutfit(slug, seed);
  const src = usePortrait(outfit, 48);
  return src ? <img className="face-figure" src={src} alt="" draggable={false} /> : <MerrymanFlat outfit={outfit} size={48} bust className="face-figure" />;
}
