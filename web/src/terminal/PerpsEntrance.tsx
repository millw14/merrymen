import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { LogoMark } from "./LogoMark";
import type { FrozenModeScene } from "./mode-transition-snapshot";

export const MODE_RIFT_DURATION = { dramatic: 2200, quick: 850 } as const;

// These vertices also define the source clip in perps-entrance.css. Keeping
// the electric edge on the clip makes this a reveal of the real destination.
const FRACTURE = "M1000 0 870 120 910 130 690 310 750 320 540 490 590 500 370 670 430 680 210 860 260 870 0 1000";

/** A frozen outgoing screen peels away to reveal the live destination. */
export function PerpsEntrance({ onDone, scene = null, direction = "perps", dramatic = true, ready = true }: {
  onDone: () => void;
  scene?: FrozenModeScene | null;
  direction?: "perps" | "spot";
  dramatic?: boolean;
  ready?: boolean;
}) {
  const skip = useRef<HTMLButtonElement>(null);
  const sceneHost = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const dismiss = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    release.current?.();
    onDone();
  }, [onDone]);
  const duration = dramatic ? MODE_RIFT_DURATION.dramatic : MODE_RIFT_DURATION.quick;

  useLayoutEffect(() => {
    const host = sceneHost.current;
    if (!host || !scene) return;
    host.appendChild(scene.element);
    scene.restoreScroll();
    return () => { if (scene.element.parentNode === host) host.removeChild(scene.element); };
  }, [scene]);

  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    // CSS hides the overlay in this case; never focus or trap an invisible UI.
    if (motion?.matches) { dismiss(); return; }
    const previous = document.activeElement as HTMLElement | null;
    const restoreFocus = () => {
      const selector = direction === "perps" ? ".perps-screen h1" : ".app h1";
      const outsideOverlay = (node: HTMLElement) => !node.closest(".perps-entrance");
      const heading = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(outsideOverlay);
      const toggle = Array.from(document.querySelectorAll<HTMLButtonElement>('.trading-mode-toggle button[aria-pressed="true"]')).find(outsideOverlay);
      const target = heading ?? toggle ?? (previous?.isConnected ? previous : null);
      if (target) {
        if (target.tagName === "H1" && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); }
      if (event.key === "Tab") { event.preventDefault(); skip.current?.focus({ preventScroll: true }); }
    };
    const motionChanged = () => { if (motion?.matches) dismiss(); };
    let released = false;
    release.current = () => {
      if (released) return;
      released = true;
      window.removeEventListener("keydown", keydown, true);
      motion?.removeEventListener?.("change", motionChanged);
      restoreFocus();
    };
    window.addEventListener("keydown", keydown, true);
    motion?.addEventListener?.("change", motionChanged);
    skip.current?.focus({ preventScroll: true });
    return () => { release.current?.(); release.current = null; };
  }, [direction, dismiss]);

  useEffect(() => {
    if (!ready || finished.current) return;
    const timer = globalThis.setTimeout(dismiss, duration);
    return () => globalThis.clearTimeout(timer);
  }, [ready, duration, dismiss]);

  return <div
    className={`perps-entrance is-${direction}${dramatic ? " is-dramatic" : " is-quick"}${ready ? " is-ready" : ""}${scene ? " has-scene" : ""}`}
    style={{ "--rift-duration": `${duration}ms` } as CSSProperties}
    role="dialog" aria-modal="true" aria-label={direction === "perps" ? "Entering Tactical Radar" : "Returning to Spot"}
  >
    <div className="perps-rift-stage" aria-hidden="true">
      <div className="perps-rift-scene"><div className="perps-rift-scene-content" ref={sceneHost} /></div>
      <div className="perps-rift-edge">
        <svg className="perps-rift-electric" viewBox="0 0 1000 1000" preserveAspectRatio="none" fill="none">
          <path className="perps-rift-halo" d={FRACTURE} />
          <path className="perps-rift-aura" d={FRACTURE} />
          <path className="perps-rift-wire" d={FRACTURE} />
          <path className="perps-rift-core" d={FRACTURE} />
          <g className="perps-rift-circuits">
            <path d="M889 99h132l48-33h87M850 181h104l35 28h149M754 274h68l41-33h86M600 444h98l30 26h89M497 579h96l47-31h101M365 707h97l32 26h133M236 845h114l49-36h105M107 947h141l25 23h94" />
            <path d="m876 118 48-30h59m-275 230 44-28h77M540 504l58-35h30M399 690l57-36h29M213 878l47-31h66" />
            <path d="m1005 90 13-9 13 9-13 9zm-152 168 13-9 13 9-13 9zM721 490l13-9 13 9-13 9zM547 755l13-9 13 9-13 9zM341 890l13-9 13 9-13 9z" />
          </g>
          <g className="perps-rift-debris">
            <path d="M935 129h31v9h-31zM870 241h18v5h-18zM758 376h43v5h-43zM711 510h16v10h-16zM555 629h34v6h-34zM461 745h21v9h-21zM355 891h42v4h-42z" />
            <path d="M1059 174h46M903 365h30M849 448h51M720 644h39M568 797h54M413 977h27" />
          </g>
          <g className="perps-rift-nodes"><circle cx="884" cy="144" r="4" /><circle cx="721" cy="321" r="4" /><circle cx="565" cy="496" r="4" /><circle cx="399" cy="677" r="4" /><circle cx="232" cy="865" r="4" /></g>
        </svg>
      </div>
    </div>
    <div className="perps-rift-seal" aria-hidden="true">
      <div className="perps-rift-insignia"><span /><LogoMark size={58} /><span /></div>
      <div className="perps-rift-wordmark">MERRYMEN<span>{direction === "perps" ? "02 / PERPETUALS" : "01 / SPOT"}</span></div>
      <strong>{direction === "perps" ? <>TACTICAL<span>RADAR</span></> : <>BACK TO<span>THE CAMP</span></>}</strong>
      <div className="perps-rift-meter"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
      <small>{direction === "perps" ? "SAME CREW. NEW TERRITORY." : "SAME CREW. HOME GROUND."}</small>
    </div>
    <div className="perps-rift-caption" aria-hidden="true"><span>{direction === "perps" ? "SPOT" : "PERPS"}</span><i /><b>{direction === "perps" ? "PERPS" : "SPOT"}</b></div>
    <button ref={skip} type="button" className="perps-entrance-skip" onClick={dismiss}>Skip intro <span aria-hidden="true">↗</span></button>
  </div>;
}
