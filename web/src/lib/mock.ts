/**
 * Mock data for the dashboard scaffold. Replaced by Supabase + on-chain reads
 * in Phase 1. Shapes here mirror the intended DB schema — change deliberately.
 */

export type AgentStatus = "active" | "paused";

export interface AgentView {
  id: string;
  name: string;
  sigil: string;
  strategy: string;
  status: AgentStatus;
  pnlUsd: number;
  pnlPct: number;
  series: number[]; // normalized 0..1 equity curve for the sparkline
  caps: { perTrade: string; daily: string; expiresIn: string };
  drawdownPct: number; // current drawdown, positive number
  maxDrawdownPct: number; // circuit-breaker threshold
  uptime: string;
}

export const AGENTS: AgentView[] = [
  {
    id: "will-scarlet",
    name: "Will Scarlet",
    sigil: "\u{1F3F9}",
    strategy: "weekend gap · TSLA NVDA SPY",
    status: "active",
    pnlUsd: 142.7,
    pnlPct: 4.8,
    series: [0.2, 0.25, 0.22, 0.31, 0.38, 0.35, 0.44, 0.52, 0.49, 0.61, 0.66, 0.74],
    caps: { perTrade: "50 USDG", daily: "500 USDG", expiresIn: "12d" },
    drawdownPct: 2.1,
    maxDrawdownPct: 10,
    uptime: "6d 4h",
  },
  {
    id: "friar-tuck",
    name: "Friar Tuck",
    sigil: "\u{1F37A}",
    strategy: "idle cash → Morpho Steakhouse USDG",
    status: "active",
    pnlUsd: 38.2,
    pnlPct: 1.2,
    series: [0.1, 0.15, 0.2, 0.24, 0.3, 0.35, 0.41, 0.47, 0.52, 0.58, 0.63, 0.7],
    caps: { perTrade: "250 USDG", daily: "1000 USDG", expiresIn: "28d" },
    drawdownPct: 0,
    maxDrawdownPct: 5,
    uptime: "13d 20h",
  },
  {
    id: "alan-a-dale",
    name: "Alan-a-Dale",
    sigil: "\u{1FA95}",
    strategy: "steady basket DCA · AAPL MSFT QQQ",
    status: "paused",
    pnlUsd: -12.4,
    pnlPct: -0.9,
    series: [0.6, 0.62, 0.58, 0.55, 0.57, 0.51, 0.48, 0.5, 0.46, 0.44, 0.45, 0.42],
    caps: { perTrade: "25 USDG", daily: "100 USDG", expiresIn: "3d" },
    drawdownPct: 6.8,
    maxDrawdownPct: 8,
    uptime: "paused 2h ago",
  },
];

export interface FeedLine {
  time: string;
  agent: string;
  kind: "ok" | "warn" | "err";
  text: string;
}

export const FEED: FeedLine[] = [
  { time: "03:41:12", agent: "Will Scarlet", kind: "ok", text: "simulated ✓ → swapped 25 USDG → 0.11 TSLA @ Rialto (impact 0.04%)" },
  { time: "03:40:58", agent: "Will Scarlet", kind: "ok", text: "policy check passed: 25 ≤ 50 USDG per-trade cap" },
  { time: "03:15:02", agent: "Friar Tuck", kind: "ok", text: "deposited 180 USDG → Steakhouse vault (APY 7.02%)" },
  { time: "02:58:44", agent: "Alan-a-Dale", kind: "warn", text: "drawdown 6.8% approaching 8% breaker — auto-paused by policy" },
  { time: "02:31:17", agent: "Will Scarlet", kind: "ok", text: "Chainlink TSLA/USD fresh (heartbeat 32s) · sequencer up" },
  { time: "01:44:09", agent: "Friar Tuck", kind: "ok", text: "tick complete — no action (idle cash below 50 USDG threshold)" },
  { time: "00:12:51", agent: "Alan-a-Dale", kind: "err", text: "simulation revert: minimum-out not met — trade skipped, no funds moved" },
];
