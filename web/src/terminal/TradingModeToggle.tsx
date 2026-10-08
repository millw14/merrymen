function ModeSymbol({ perps = false }: { perps?: boolean }) {
  return <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{perps ? <><path d="M10 0v5m0 10v5M0 10h5m10 0h5" /><circle cx="10" cy="10" r="6" /><path d="m7 13 6-6m-4 0h4v4" /></> : <><path d="m2 14 5-5 4 3 7-8M13 4h5v5M2 18h16" /><path d="M4 4h2M4 2v4" /></>}</svg>;
}

/** Changes the screen being viewed. Trading permission remains in Settings. */
export function TradingModeToggle({ mode, onChange, compact = false, pending = false }: {
  mode: "spot" | "perps";
  onChange: (mode: "spot" | "perps") => void;
  compact?: boolean;
  pending?: boolean;
}) {
  return (
    <div className={`trading-mode-toggle${compact ? " is-compact" : ""}`} role="group" aria-label="Trading view">
      <span className="trading-mode-glide" aria-hidden="true" data-mode={mode} />
      <button type="button" className={mode === "spot" ? "is-active" : ""} aria-pressed={mode === "spot"} onClick={() => onChange("spot")}>
        <ModeSymbol />Spot
      </button>
      <button type="button" className={mode === "perps" ? "is-active" : ""} aria-pressed={mode === "perps"} aria-busy={pending} disabled={pending} onClick={() => onChange("perps")}>
        <ModeSymbol perps />Perps
      </button>
    </div>
  );
}
