"use client";

import { useEffect, useState } from "react";
import type {
  PlaygroundResponse,
  PlaygroundRunOutput,
  StrategyName,
} from "@merrymen/playground-api";

interface SeriesPoint {
  tSec: number;
  equityUsdg: number;
}

interface CurveSeries {
  key: string;
  label: string;
  color: string;
  points: SeriesPoint[];
  rejectedEvents?: { tSec: number; rule: string }[];
}

function EquityCurve({ series }: { series: CurveSeries[] }) {
  const valid = series.filter((s) => s.points.length >= 2);
  if (valid.length === 0) return null;

  const w = 640;
  const h = 220;
  const allValues = valid.flatMap((s) => s.points.map((p) => p.equityUsdg));
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const span = max - min || 1;

  const lines = valid.map((s) => {
    const step = w / (s.points.length - 1);
    const coords = s.points.map((p, i) => [i * step, h - ((p.equityUsdg - min) / span) * h] as const);
    const pointsAttr = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const dPath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    let length = 0;
    for (let i = 1; i < coords.length; i++) {
      const [x1, y1] = coords[i - 1]!;
      const [x2, y2] = coords[i]!;
      length += Math.hypot(x2 - x1, y2 - y1);
    }
    return { ...s, pointsAttr, dPath, length };
  });

  return (
    <div className="playground-curve-wrap">
      <svg
        className="playground-curve"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="Backtest equity curve"
      >
        {lines.map((l) => (
          <g key={l.key}>
          <polyline
            className="playground-curve-line"
            points={l.pointsAttr}
            fill="none"
            strokeWidth={2}
            stroke={l.color}
            style={{
              strokeDasharray: l.length,
              strokeDashoffset: l.length,
              animation: "draw-curve 1.4s ease-out forwards",
            }}
          />
          <circle className="playground-curve-runner" r={4} fill={l.color}>
            <animateMotion dur="1.4s" fill="freeze" calcMode="linear" path={l.dPath} />
          </circle>
          {(() => {
            const t0 = l.points[0]!.tSec;
            const t1 = l.points[l.points.length - 1]!.tSec;
            const span = t1 - t0 || 1;
            const BIN_COUNT = 60;
            const bins: { rules: Map<string, number> }[] = Array.from({ length: BIN_COUNT }, () => ({
              rules: new Map<string, number>(),
            }));

            for (const ev of l.rejectedEvents ?? []) {
              const frac = Math.min(0.999, Math.max(0, (ev.tSec - t0) / span));
              const idx = Math.floor(frac * BIN_COUNT);
              const bin = bins[idx]!;
              bin.rules.set(ev.rule, (bin.rules.get(ev.rule) ?? 0) + 1);
            }

            const maxCount = Math.max(1, ...bins.map((b) => [...b.rules.values()].reduce((a, c) => a + c, 0)));
            const binW = w / BIN_COUNT;

            return bins.map((bin, i) => {
              const total = [...bin.rules.values()].reduce((a, c) => a + c, 0);
              if (total === 0) return null;
              const opacity = 0.15 + (total / maxCount) * 0.65;
              const dayStart = Math.floor((i / BIN_COUNT) * (span / 86_400));
              const dayEnd = Math.floor(((i + 1) / BIN_COUNT) * (span / 86_400));
              const summary = [...bin.rules.entries()].map(([r, c]) => `${r} ×${c}`).join(", ");
              return (
                <rect
                  key={i}
                  x={i * binW}
                  y={h - 6}
                  width={binW}
                  height={6}
                  fill="var(--red)"
                  opacity={opacity}
                >
                  <title>{`day ${dayStart}–${dayEnd} · ${summary}`}</title>
                </rect>
              );
            });
          })()}
          </g>
        ))}
      </svg>
      {lines.length > 1 && (
        <div className="playground-legend mono">
          {lines.map((l) => (
            <span key={l.key} className="playground-legend-item">
              <span className="playground-legend-dot" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface Preset {
  id: string;
  label: string;
  strategy: StrategyName;
  symbols: string[];
  days: number;
  startingCash: number;
  hint: string;
}

const PRESETS: Preset[] = [
  { id: "quick", label: "quick check", strategy: "steady-basket", symbols: ["AAPL", "QQQ"], days: 30, startingCash: 500, hint: "fast, small basket, 30d" },
  { id: "diversified", label: "diversified, 1yr", strategy: "steady-basket", symbols: ["AAPL", "MSFT", "QQQ", "NVDA"], days: 365, startingCash: 2000, hint: "full basket over a year" },
  { id: "single-stress", label: "single-asset stress", strategy: "steady-basket", symbols: ["TSLA"], days: 90, startingCash: 300, hint: "tight cash, one volatile name" },
  { id: "gap-demo", label: "weekend gap demo", strategy: "weekend-gap", symbols: ["TSLA", "NVDA"], days: 90, startingCash: 1000, hint: "entries timed around market-closed weekends" },
];

const SYMBOL_OPTIONS = ["AAPL", "MSFT", "QQQ", "NVDA", "TSLA"];
const DAY_PRESETS = [30, 90, 365];

function randomSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]!;
}

function ResultStats({ result, label }: { result: PlaygroundRunOutput; label?: string }) {
  return (
    <div className="playground-result-block">
      {label && <div className="playground-result-label mono">{label}</div>}
      <div className="wall-caps mono">
        <span className="cap">
          final equity <b>${result.finalEquityUsdg.toFixed(2)}</b>
        </span>
        <span className="cap">
          P&amp;L{" "}
          <b style={{ color: result.pnlUsdg >= 0 ? "var(--green)" : "var(--red)" }}>
            {result.pnlUsdg >= 0 ? "+" : ""}
            {result.pnlUsdg.toFixed(2)}
          </b>
        </span>
        <span className="cap">
          max drawdown <b>{(result.maxDrawdownBps / 100).toFixed(1)}%</b>
        </span>
        <span className="cap">
          trades executed <b>{result.executed}</b>
        </span>
      </div>
      {result.rejected.length > 0 && (
        <p className="recover-sub">
          policy rejections — the honest part:{" "}
          {result.rejected.map((r) => `${r.rule} ×${r.count}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

export default function PlaygroundPage() {
  const [strategy, setStrategy] = useState<StrategyName>("steady-basket");
  const [symbols, setSymbols] = useState<string[]>(["AAPL", "QQQ"]);
  const [days, setDays] = useState(90);
  const [startingCash, setStartingCash] = useState(1000);
  const [seed, setSeed] = useState(0);
  const [compareOn, setCompareOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlaygroundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);

  useEffect(() => setSeed(randomSeed()), []);

  function toggleSymbol(s: string) {
    setSymbols((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  function applyPreset(p: Preset) {
    setStrategy(p.strategy);
    setSymbols(p.symbols);
    setDays(p.days);
    setStartingCash(p.startingCash);
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const compareStrategy = compareOn ? (strategy === "steady-basket" ? "weekend-gap" : "steady-basket") : null;
      const r = await fetch("/api/playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy, compareStrategy, symbols, days, startingCashUsdg: startingCash, seed }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? "run failed");
      else {
        setResult(j as PlaygroundResponse);
        setRunId((n) => n + 1);
      }
    } catch {
      setError("couldn't reach the playground service");
    }
    setBusy(false);
  }

  const series: CurveSeries[] = result
  ? [
      { key: "primary", label: result.primary.strategy, color: "var(--green)", points: result.primary.equitySeries, rejectedEvents: result.primary.rejectedEvents },
      ...(result.compare
        ? [{ key: "compare", label: result.compare.strategy, color: "var(--gold)", points: result.compare.equitySeries, rejectedEvents: result.compare.rejectedEvents }]
        : []),
    ]
  : [];

  return (
    <main className="shell">
      <section className="agents">
        <div className="section-title">strategy playground · synthetic prices, real policy wall</div>

        <div className="panel">
          <p className="wall-sub">
            Runs your actual strategy code through the actual policy layer (
            <code>worker/src/policy.ts</code>) over a generated price series — not a toy
            simulation. Nothing here signs or spends; it's read-only.
          </p>

          <div className="playground-presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="circle-btn"
                title={p.hint}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="playground-form mono">
            <label>
              strategy
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
                <option value="steady-basket">steady-basket</option>
                <option value="weekend-gap">weekend-gap</option>
              </select>
            </label>

            <div className="playground-symbols">
              {SYMBOL_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={symbols.includes(s) ? "circle-btn go" : "circle-btn"}
                  onClick={() => toggleSymbol(s)}
                >
                  {s}
                </button>
              ))}
            </div>

            <label>
              period
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {DAY_PRESETS.map((d) => (
                  <option key={d} value={d}>
                    {d}d
                  </option>
                ))}
              </select>
            </label>

            <label>
              starting cash (USDG)
              <input
                type="number"
                value={startingCash}
                onChange={(e) => setStartingCash(Number(e.target.value))}
              />
            </label>

            <label>
              scenario seed
              <span className="playground-seed-row">
                <input
                  type="number"
                  min={0}
                  max={0xffff_ffff}
                  step={1}
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                />
                <button type="button" className="circle-btn" onClick={() => setSeed(randomSeed())}>
                  randomize
                </button>
              </span>
            </label>

            <label className="playground-compare-toggle">
              <input type="checkbox" checked={compareOn} onChange={(e) => setCompareOn(e.target.checked)} />
              compare against {strategy === "steady-basket" ? "weekend-gap" : "steady-basket"}
            </label>

            <button className="circle-btn go" onClick={() => void run()} disabled={busy || symbols.length === 0}>
              {busy ? "riding the synthetic tape…" : "run backtest"}
            </button>
          </div>

          {error && <p className="recover-err mono">{error}</p>}

          {result && (
            <div className="playground-result">
              <p className="recover-sub mono">
                signed wall · {result.limits.perTradeUsdg} USDG/trade · {result.limits.dailyUsdg} USDG/day ·{" "}
                {result.limits.maxDrawdownPct}% drawdown · {result.limits.maxOpsPerDay} ops/day · seed {result.seed}
              </p>
              <EquityCurve key={runId} series={series} />
              <ResultStats result={result.primary} label={result.compare ? result.primary.strategy : undefined} />
              {result.compare && <ResultStats result={result.compare} label={result.compare.strategy} />}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
