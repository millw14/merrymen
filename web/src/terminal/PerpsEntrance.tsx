import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FrozenModeScene } from "./mode-transition-snapshot";
import { playNanites, type NaniteHandle } from "./nanite-suit";
export { freezeModeScene } from "./mode-transition-snapshot";

/** The nominal nanite-suit timelines; this host's timer, not the engine, ends the overlay. */
export const MODE_SUIT_DURATION = { dramatic: 2600, quick: 950 } as const;

type Point = { x: number; y: number };

/**
 * Where the armour pours from: the press that asked for the switch; else the
 * destination button in the frozen copy of the toggle; else the top centre.
 */
export function suitOrigin(origin: Point | null | undefined, frozen: HTMLElement | null): Point {
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) return { x: origin.x, y: origin.y };
  for (const button of frozen?.querySelectorAll<HTMLElement>('.trading-mode-toggle button:not([aria-pressed="true"])') ?? []) {
    const rect = button.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return { x: window.innerWidth / 2, y: 0 };
}

/** Nanite armour covers the frozen outgoing screen, then flips away to reveal the live destination. */
export function PerpsEntrance({ onDone, scene = null, direction = "perps", dramatic = true, ready = true, origin = null, background = null }: {
  onDone: () => void;
  scene?: FrozenModeScene | null;
  direction?: "perps" | "spot";
  dramatic?: boolean;
  ready?: boolean;
  origin?: Point | null;
  background?: HTMLElement | null;
}) {
  const skip = useRef<HTMLButtonElement>(null);
  const sceneHost = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const suit = useRef<NaniteHandle | null>(null);
  const finished = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const [covered, setCovered] = useState(false);
  const dismiss = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    suit.current?.cancel();
    suit.current = null;
    release.current?.();
    onDone();
  }, [onDone]);
  const duration = dramatic ? MODE_SUIT_DURATION.dramatic : MODE_SUIT_DURATION.quick;

  useLayoutEffect(() => {
    const host = sceneHost.current;
    if (!host || !scene) return;
    host.appendChild(scene.element);
    scene.restoreScroll();
    return () => { if (scene.element.parentNode === host) host.removeChild(scene.element); };
  }, [scene]);

  useLayoutEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    // CSS hides the overlay in this case; never focus or trap an invisible UI.
    if (motion?.matches) { dismiss(); return; }
    const previous = document.activeElement as HTMLElement | null;
    const previousInert = background?.getAttribute("inert") ?? null;
    const previousHidden = background?.getAttribute("aria-hidden") ?? null;
    background?.setAttribute("inert", "");
    background?.setAttribute("aria-hidden", "true");
    const restoreFocus = () => {
      const selector = direction === "perps" ? ".perps-desk h1" : ".app h1";
      const outsideOverlay = (node: HTMLElement) => !node.closest(".perps-entrance, [inert]");
      const heading = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(outsideOverlay);
      const toggle = Array.from(document.querySelectorAll<HTMLButtonElement>('.trading-mode-toggle button[aria-pressed="true"]')).find(outsideOverlay);
      const target = heading ?? toggle ?? (previous?.isConnected && outsideOverlay(previous) ? previous : null);
      if (target) {
        const temporary = target.tagName === "H1" && !target.hasAttribute("tabindex");
        const restoreTabIndex = () => {
          if (target.getAttribute("tabindex") === "-1") target.removeAttribute("tabindex");
        };
        if (temporary) {
          target.setAttribute("tabindex", "-1");
          // Removing tabindex immediately can blur a heading in real browsers.
          // Keep it programmatically focusable until the reader moves on.
          target.addEventListener("blur", restoreTabIndex, { once: true });
        }
        target.focus({ preventScroll: true });
        if (temporary && document.activeElement !== target) {
          target.removeEventListener("blur", restoreTabIndex);
          restoreTabIndex();
        }
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); }
      if (event.key === "Tab") { event.preventDefault(); skip.current?.focus({ preventScroll: true }); }
      // Background shell shortcuts (such as / for search) also listen on window.
      if (event.key !== "Enter" && event.key !== " ") event.stopImmediatePropagation();
    };
    const motionChanged = () => { if (motion?.matches) dismiss(); };
    let released = false;
    release.current = () => {
      if (released) return;
      released = true;
      window.removeEventListener("keydown", keydown, true);
      motion?.removeEventListener?.("change", motionChanged);
      for (const [name, value] of [["inert", previousInert], ["aria-hidden", previousHidden]]) {
        if (value === null) background?.removeAttribute(name!);
        else background?.setAttribute(name!, value!);
      }
      restoreFocus();
    };
    window.addEventListener("keydown", keydown, true);
    motion?.addEventListener?.("change", motionChanged);
    skip.current?.focus({ preventScroll: true });
    return () => { release.current?.(); release.current = null; };
  }, [direction, dismiss, background]);

  // The single authority for completion: the engine is never given onDone.
  useEffect(() => {
    if (!ready || finished.current) return;
    const timer = globalThis.setTimeout(dismiss, duration);
    return () => globalThis.clearTimeout(timer);
  }, [ready, duration, dismiss]);

  const originX = origin?.x;
  const originY = origin?.y;
  useEffect(() => {
    const node = canvas.current;
    if (!ready || finished.current || !node) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const from = suitOrigin(originX === undefined || originY === undefined ? null : { x: originX, y: originY }, scene?.element ?? null);
    let handle: NaniteHandle;
    try { handle = playNanites({
      canvas: node, origin: from, direction, dramatic, duration,
      seed: Math.floor(Math.random() * 0x7fffffff),
      // Fully opaque armour: the frozen copy can go, so the reveal uncovers the live app.
      onCovered: () => setCovered(true),
      onError: dismiss,
    }); } catch { dismiss(); return; }
    suit.current = handle;
    return () => {
      handle.cancel();
      if (suit.current === handle) suit.current = null;
    };
  }, [ready, direction, dramatic, duration, originX, originY, scene, dismiss]);

  return <div
    className={`perps-entrance is-${direction}${dramatic ? " is-dramatic" : " is-quick"}${ready ? " is-ready" : ""}${scene ? " has-scene" : ""}${covered ? " is-covered" : ""}`}
    role="dialog" aria-modal="true" aria-label={direction === "perps" ? "Switching to paper Perps" : "Returning to Spot"}
  >
    <div className="perps-suit-scene" aria-hidden="true"><div className="perps-suit-scene-content" ref={sceneHost} /></div>
    <canvas ref={canvas} className="perps-suit-canvas" aria-hidden="true" />
    <button ref={skip} type="button" className="perps-entrance-skip" onClick={dismiss}>Skip intro <span aria-hidden="true">↗</span></button>
  </div>;
}
