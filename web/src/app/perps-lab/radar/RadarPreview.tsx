"use client";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { getPerpsStyle, type PerpsStyleId } from "@merrymen/core";
import { LogoMark } from "../../../terminal/LogoMark";
import { PerpsScreenPreview } from "../../../terminal/PerpsScreen";
import { TradingModeToggle } from "../../../terminal/TradingModeToggle";
import { PerpsEntrance } from "../../../terminal/PerpsEntrance";
import { RADAR_SAMPLE_CHART, RADAR_SAMPLE_POSITIONS } from "./sample-data";

export function RadarPreview({ previewEntrance = false }: { previewEntrance?: boolean }) {
  // Explicit design-preview link; the actual app always uses the durable owner claim.
  const [entrance, setEntrance] = useState(previewEntrance);
  const finishEntrance = useCallback(() => setEntrance(false), []);
  const router = useRouter();
  const returnToSpot = () => router.push("/");
  const [notice, setNotice] = useState<string | null>(null);
  function configure(style?: PerpsStyleId) {
    setNotice(style ? `${getPerpsStyle(style).label} selected for inspection. In your account, this opens a settings draft for you to review and save. This preview cannot change trading.` : "This is a design preview. Configure your own agent from the Perps screen in your account.");
  }
  return <div className="terminal-host radar-preview-page">
    <header className="radar-preview-top"><a href="/" className="radar-preview-brand"><LogoMark size={27} /><span>merrymen</span></a><span className="radar-preview-build">TACTICAL RADAR / DESIGN BUILD</span><TradingModeToggle mode="perps" onChange={(mode) => { if (mode === "spot") returnToSpot(); }} /></header>
    {notice ? <div className="radar-preview-alert" role="status"><p>{notice}</p><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss preview notice">×</button></div> : null}
    <div className="radar-preview-stage">
      <PerpsScreenPreview perps={RADAR_SAMPLE_POSITIONS} data={RADAR_SAMPLE_CHART} hasAgent ownerKey="fictional-design-owner" onSpot={returnToSpot} onSettings={configure} />
    </div>
    {entrance && <PerpsEntrance onDone={finishEntrance} />}
  </div>;
}
