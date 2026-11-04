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
import type { Framing, Stage } from "./stage";
import "./merryman.css";

export type Cue = { key: string | number; clip: string };

function webglAvailable(): boolean {
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
          onLost: () => setLive("flat"),
        });
        setLive("ready");
      })
      .catch(() => { if (!cancelled) setLive("flat"); });
    return () => {
      cancelled = true;
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

  return (
    <div className={`mm-merryman ${className}`} data-state={live} data-framing={framing} role="img" aria-label={label ?? "Your merryman"}>
      <div className="mm-merryman-glow" aria-hidden />
      <div className="mm-merryman-stage" ref={host} aria-hidden />
      {live !== "ready" && (
        <div className={`mm-merryman-flat${live === "loading" ? " is-loading" : ""}`} aria-hidden>
          <MerrymanFlat outfit={outfit} size={framing === "portrait" ? 140 : 150} bust={framing === "portrait"} />
        </div>
      )}
      {bubble ? (
        <div className={`mm-bubble tone-${bubbleTone}`} key={bubble} aria-live="polite">
          {bubble}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A still portrait for lists: rendered once per outfit through the shared
 * offscreen renderer, flat SVG until (or unless) that works.
 */
export function MerrymanPortrait({ outfit, size = 40, className = "", title }: { outfit: Outfit; size?: number; className?: string; title?: string }) {
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
  return (
    <span className={`mm-portrait ${className}`} style={{ width: size, height: size }} title={title}>
      {src ? <img src={src} alt="" width={size} height={size} draggable={false} /> : <MerrymanFlat outfit={outfit} size={size} bust />}
    </span>
  );
}
