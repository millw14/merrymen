"use client";
import { useState } from "react";
import { getPerpsStyle, type PerpsStyleId } from "@merrymen/core";
import { LogoMark } from "../../../terminal/LogoMark";
import { PerpsScreenPreview } from "../../../terminal/PerpsScreen";
import { TradingModeToggle } from "../../../terminal/TradingModeToggle";
import { RADAR_SAMPLE_CHART, RADAR_SAMPLE_POSITIONS } from "./sample-data";

export function RadarPreview() {
  const [mode, setMode] = useState<"spot" | "perps">("perps");
  const [notice, setNotice] = useState<string | null>(null);
  function configure(style?: PerpsStyleId) {
    setNotice(style ? `${getPerpsStyle(style).label} selected for inspection. In your account, this opens a settings draft for you to review and save. This preview cannot change trading.` : "This is a design preview. Configure your own agent from the Perps screen in your account.");
  }
  return <div className="terminal-host radar-preview-page">
    <header className="radar-preview-top"><a href="/perps-lab" className="radar-preview-brand"><LogoMark size={27} /><span>merrymen</span></a><span className="radar-preview-build">TACTICAL RADAR / DESIGN BUILD</span><TradingModeToggle mode={mode} onChange={setMode} /></header>
    {notice ? <div className="radar-preview-alert" role="status"><p>{notice}</p><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss preview notice">×</button></div> : null}
    <div key={mode} className={`radar-preview-stage mode-${mode}`}>
      {mode === "perps" ? <PerpsScreenPreview perps={RADAR_SAMPLE_POSITIONS} data={RADAR_SAMPLE_CHART} hasAgent ownerKey="fictional-design-owner" onSpot={() => setMode("spot")} onSettings={configure} /> : <section className="radar-spot-preview"><span className="perps-eyebrow">SPOT / DESIGN PREVIEW</span><LogoMark size={84} /><h1>THE FOREST<br />BEFORE THE STORM.</h1><p>The same Merrymen. A different pace.<br />Flip the switch to enter Tactical Radar.</p><TradingModeToggle mode="spot" onChange={setMode} /></section>}
    </div>
  </div>;
}
