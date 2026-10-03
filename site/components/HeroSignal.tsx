"use client";

import { useEffect, useState } from "react";
import { Logo } from "./Logo";

type SignalMode = "refresh" | "change" | null;

export function HeroSignal() {
  const [mode, setMode] = useState<SignalMode>(null);

  useEffect(() => {
    let frame = 0;
    let clearTimer = 0;
    const onBandUpdate = (event: Event) => {
      const changed = event instanceof CustomEvent && event.detail?.changed === true;
      setMode(null);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clearTimer);
      frame = window.requestAnimationFrame(() => {
        setMode(changed ? "change" : "refresh");
        clearTimer = window.setTimeout(() => setMode(null), changed ? 1_500 : 900);
      });
    };
    window.addEventListener("merrymen:band-update", onBandUpdate);
    return () => {
      window.removeEventListener("merrymen:band-update", onBandUpdate);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clearTimer);
    };
  }, []);

  return (
    <div className={`hero-signal${mode ? ` hero-signal-${mode}` : ""}`} aria-hidden>
      <span className="hero-signal-base"><Logo size={188} /></span>
      <span className="hero-signal-overlay"><Logo size={188} /></span>
    </div>
  );
}
