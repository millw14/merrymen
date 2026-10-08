import { useEffect, useRef } from "react";
import { LogoMark } from "./LogoMark";

/** A single claimed arrival, separate from ordinary screen mounts and live-fill effects. */
export function PerpsEntrance({ onDone }: { onDone: () => void }) {
  const skip = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    // Direct preview mounts bypass the entrance-claim hook. Never focus or
    // trap keys inside an intro that reduced-motion CSS keeps invisible.
    if (motion?.matches) { onDone(); return; }
    const previous = document.activeElement as HTMLElement | null;
    const restoreFocus = () => {
      const heading = document.querySelector<HTMLElement>(".perps-screen h1");
      if (heading) heading.focus({ preventScroll: true });
      else if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    skip.current?.focus({ preventScroll: true });
    const timer = globalThis.setTimeout(onDone, 2400);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onDone(); }
      if (event.key === "Tab") { event.preventDefault(); skip.current?.focus(); }
    };
    let dismissedForMotion = false;
    const motionChanged = () => {
      if (!motion?.matches || dismissedForMotion) return;
      dismissedForMotion = true;
      globalThis.clearTimeout(timer);
      window.removeEventListener("keydown", keydown, true);
      restoreFocus();
      onDone();
    };
    window.addEventListener("keydown", keydown, true);
    motion?.addEventListener?.("change", motionChanged);
    return () => {
      globalThis.clearTimeout(timer);
      window.removeEventListener("keydown", keydown, true);
      motion?.removeEventListener?.("change", motionChanged);
      restoreFocus();
    };
  }, [onDone]);
  return <div className="perps-entrance" role="dialog" aria-modal="true" aria-label="Entering Tactical Radar">
    <div className="perps-entrance-shutter is-upper" aria-hidden="true" />
    <div className="perps-entrance-shutter is-lower" aria-hidden="true" />
    <div className="perps-entrance-grid" aria-hidden="true" />
    <div className="perps-entrance-orbit" aria-hidden="true"><i /><i /><i /><b /></div>
    <div className="perps-entrance-core" aria-hidden="true"><LogoMark size={88} /><span>MERRYMEN / PERPETUALS DIVISION</span><strong>TACTICAL<br />RADAR<span>_</span></strong><small>NEW TERRITORY. SAME MERRYMAN.</small></div>
    <div className="perps-entrance-progress" aria-hidden="true"><i /><span>ENTERING PERPS</span></div>
    <button ref={skip} type="button" className="perps-entrance-skip" onClick={onDone}>Skip intro <span aria-hidden="true">↗</span></button>
  </div>;
}
