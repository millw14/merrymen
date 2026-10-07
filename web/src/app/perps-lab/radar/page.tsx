import type { Metadata } from "next";
import { RadarPreview } from "./RadarPreview";
import "../../../terminal/perps-mode.css";
import "../../../terminal/perps-chart.css";
import "../../../terminal/perps-doctrines.css";
import "../../../terminal/trading-mode-toggle.css";
import "./radar-preview.css";
export const metadata: Metadata = { title: "Tactical Radar · Merrymen", description: "Interactive Tactical Radar design preview. Fictional positions and prices.", robots: { index: false, follow: false } };
export default function RadarPreviewPage() { return <RadarPreview />; }
