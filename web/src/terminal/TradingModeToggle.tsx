import { Activity, Crosshair } from "lucide-react";

/** Changes the screen being viewed. Trading permission remains in Settings. */
export function TradingModeToggle({ mode, onChange, compact = false }: {
  mode: "spot" | "perps";
  onChange: (mode: "spot" | "perps") => void;
  compact?: boolean;
}) {
  return (
    <div className={`trading-mode-toggle${compact ? " is-compact" : ""}`} role="group" aria-label="Trading view">
      <span className="trading-mode-glide" aria-hidden="true" data-mode={mode} />
      <button type="button" className={mode === "spot" ? "is-active" : ""} aria-pressed={mode === "spot"} onClick={() => onChange("spot")}>
        <Activity size={15} aria-hidden="true" />Spot
      </button>
      <button type="button" className={mode === "perps" ? "is-active" : ""} aria-pressed={mode === "perps"} onClick={() => onChange("perps")}>
        <Crosshair size={15} aria-hidden="true" />Perps
      </button>
    </div>
  );
}
