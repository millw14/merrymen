import { useState } from "react";
import { PERPS_STYLE_CATALOG, DEFAULT_PERPS_STYLE, getPerpsStyle, type PerpsStyleId } from "@merrymen/core";

const FAMILIES = [
  { id: "scalp", title: "SCALPERS", line: "Short windows. Sharp exits.", index: "01" },
  { id: "day", title: "DAY TRADERS", line: "Find the break. Work the session.", index: "02" },
  { id: "swing", title: "SWING TRADERS", line: "Read the bigger move.", index: "03" },
] as const;
const CALLSIGNS: Record<string, { name: string; code: string }> = {
  "scalp-breakout": { name: "Razor", code: "RZR" },
  "scalp-confirmed": { name: "Ambush", code: "AMB" },
  "scalp-selective": { name: "Deadeye", code: "DED" },
  "day-breakout": { name: "Ranger", code: "RNG" },
  "day-patient": { name: "Outrider", code: "OUT" },
  "day-selective": { name: "Watchman", code: "WCH" },
  "swing-trend": { name: "Pathfinder", code: "PTH" },
  "swing-patient": { name: "Ironwood", code: "IRN" },
  "swing-selective": { name: "Sentinel", code: "SNT" },
};
export const holdLabel = (hours: number) => hours < 1 ? `${hours * 60}m` : hours < 24 ? `${hours}h` : `${hours / 24}d`;

/** A schematic of the rule, deliberately never presented as price or performance history. */
function SignalDiagram({ family, channel }: { family: string; channel: number }) {
  const path = family === "scalp" ? "M4 41h12v-8h12v9h13v-15h13v10h12v-7h13v12h12V25h13v8h12V18h12v9h12V9h22" : family === "day" ? "M4 43 20 38 34 44 48 33 62 36 77 30 93 37 110 27 125 29 142 13 162 9" : "M4 44 20 46 37 39 53 40 71 32 88 35 105 25 122 28 140 14 162 9";
  return <svg className={`doctrine-diagram is-${family}`} viewBox="0 0 168 58" fill="none" aria-hidden="true"><path className="doctrine-channel" d={`M4 22H${channel > 12 ? 136 : 118}M4 47h132`} /><path className="doctrine-signal" d={path} /><path className="doctrine-cross" d="M162 3v12m-6-6h12" /><circle cx="162" cy="9" r="6" /></svg>;
}

export function PerpsDoctrines({ onConfigure }: { onConfigure: (style: PerpsStyleId) => void }) {
  const [family, setFamily] = useState<"all" | "scalp" | "day" | "swing">("all");
  const [selected, setSelected] = useState<PerpsStyleId>(DEFAULT_PERPS_STYLE);
  const profile = getPerpsStyle(selected);
  const selectedCallsign = CALLSIGNS[selected];
  return <section className="perps-doctrines" aria-labelledby="doctrine-heading" id="perps-doctrines">
    <div className="doctrine-header"><div><span className="perps-eyebrow">THE PLAYBOOK / {String(PERPS_STYLE_CATALOG.length).padStart(2, "0")} MODES</span><h2 id="doctrine-heading">CHOOSE YOUR PLAY.</h2><p>Different clocks. Different signals. Your limits stay in command.</p></div><div className="doctrine-filters" role="group" aria-label="Trading mode families">{(["all", "scalp", "day", "swing"] as const).map(key => <button key={key} type="button" aria-pressed={family === key} onClick={() => setFamily(key)}>{key === "all" ? "All modes" : key === "scalp" ? "Scalpers" : key === "day" ? "Day traders" : "Swing traders"}</button>)}</div></div>
    <div className="doctrine-families">{FAMILIES.filter(group => family === "all" || family === group.id).map(group => <div className={`doctrine-family family-${group.id}`} key={group.id}><div className="doctrine-family-heading"><span>{group.index}</span><h3>{group.title}</h3><p>{group.line}</p></div><div className="doctrine-cards">{PERPS_STYLE_CATALOG.filter(style => style.family === group.id).map((style, index) => {
      const callsign = CALLSIGNS[style.id];
      return <button key={style.id} type="button" className={`doctrine-card${selected === style.id ? " is-selected" : ""}`} aria-pressed={selected === style.id} aria-label={`Inspect ${callsign?.name ?? style.label}: ${style.label}`} onClick={() => setSelected(style.id)}><span className="doctrine-card-top"><b>{callsign?.code ?? style.id.slice(0, 3).toUpperCase()}</b><span>{group.index}.{String(index + 1).padStart(2, "0")}</span></span><SignalDiagram family={group.id} channel={style.entryChannel} /><span className="doctrine-name">{callsign?.name ?? style.label}</span><span className="doctrine-role">{style.label}</span><span className="doctrine-description">{style.description}</span><span className="doctrine-specs"><span><b>{style.timeframe}</b> signal</span><span><b>{holdLabel(style.maxHoldHours)}</b> time exit</span><i aria-hidden="true">{selected === style.id ? "[■]" : "[+]"}</i></span></button>;
    })}</div></div>)}</div>
    <div className="doctrine-selected" aria-live="polite"><div className="doctrine-selected-heading"><span className="doctrine-insignia" aria-hidden="true">{selectedCallsign?.code ?? "MM"}</span><div><span className="perps-eyebrow">INSPECTING / {profile.label}</span><h3>{selectedCallsign?.name ?? profile.label}</h3></div></div><p>Breakout over {profile.entryChannel} closed {profile.timeframe} bars, confirmed by EMA24. Requests a close after {holdLabel(profile.maxHoldHours)} on a fresh market read; fills can arrive later. Protective exits can happen sooner. BTC, ETH and SOL, within your allowed markets.</p><button type="button" onClick={() => onConfigure(selected)}>Review in settings <span aria-hidden="true">↗</span></button></div>
    <p className="doctrine-footnote">Rule diagrams, not returns. Selecting a card only inspects a mode. Save it in settings to apply. Existing size caps, stops and daily limits remain; the engine retains an 8h cooldown after a strategy exit and 24h after a risk exit.</p>
  </section>;
}
