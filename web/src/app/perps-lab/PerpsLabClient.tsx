"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Crosshair, Headphones, Shield, Volume2, VolumeX, Zap } from "lucide-react";
import {
  CHART, SAMPLE_ENTRIES, SAMPLE_TICKS, sampleDomain, samplePrice, sampleTime, sampleXY,
  type SampleEntry,
} from "./chart-model";

type Theme = "arcade" | "radar" | "race";
type Mode = "spot" | "perps";

const THEMES: readonly { id: Theme; number: string; name: string; brief: string; icon: string }[] = [
  { id: "arcade", number: "01", name: "Arcade Pulse", brief: "Neon, energy, expressive agent moments", icon: "✳" },
  { id: "radar", number: "02", name: "Tactical Radar", brief: "Mission control, precise and focused", icon: "◎" },
  { id: "race", number: "03", name: "Race Circuit", brief: "Velocity, timing and clean telemetry", icon: "↗" },
];

const CHART_DOMAIN = sampleDomain(SAMPLE_TICKS);
const LINE = SAMPLE_TICKS.map((tick, i) => {
  const { x, y } = sampleXY(tick.at, tick.price, CHART_DOMAIN);
  return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
}).join(" ");
const FIRST = sampleXY(SAMPLE_TICKS[0]!.at, SAMPLE_TICKS[0]!.price, CHART_DOMAIN);
const LAST = sampleXY(SAMPLE_TICKS[SAMPLE_TICKS.length - 1]!.at, SAMPLE_TICKS[SAMPLE_TICKS.length - 1]!.price, CHART_DOMAIN);
const BASELINE = CHART.height - CHART.bottom;
const AREA = `${LINE} L ${LAST.x.toFixed(2)} ${BASELINE} L ${FIRST.x.toFixed(2)} ${BASELINE} Z`;

function SampleChart({ activeEntry, onEntry }: { activeEntry: string; onEntry: (entry: SampleEntry) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const scrollContainer = useRef<HTMLDivElement | null>(null);
  const hoveredTick = hovered === null ? null : SAMPLE_TICKS[hovered];
  const hoveredXY = hoveredTick ? sampleXY(hoveredTick.at, hoveredTick.price, CHART_DOMAIN) : null;
  const priceTicks = Array.from({ length: 5 }, (_, index) => CHART_DOMAIN.maxPrice - index * ((CHART_DOMAIN.maxPrice - CHART_DOMAIN.minPrice) / 4));

  useEffect(() => {
    const container = scrollContainer.current;
    const entry = SAMPLE_ENTRIES.find((candidate) => candidate.id === activeEntry);
    if (!container || !entry || container.scrollWidth <= container.clientWidth) return;
    const chartX = sampleXY(entry.at, entry.price, CHART_DOMAIN).x;
    const target = (chartX / CHART.width) * container.scrollWidth - container.clientWidth / 2;
    container.scrollTo({
      left: Math.max(0, target),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, [activeEntry]);

  return (
    <div className="pl-chart-wrap">
      <div className="pl-chart-meta">
        <span className="pl-micro">SAMPLE MARKET TAPE <span className="pl-separator">/</span> BTC–PERP</span>
        <span className="pl-chart-legend"><i className="pl-chart-key" /> Sample price <i className="pl-entry-key" /> Agent entry</span>
      </div>
      <div className="pl-chart-scroll" ref={scrollContainer}>
      <svg
        className="pl-chart"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label="Fictional BTC perpetual price chart with two sample agent entries at their matching timestamps and prices"
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const chartX = ((event.clientX - bounds.left) / bounds.width) * CHART.width;
          const ratio = (chartX - CHART.left) / (CHART.width - CHART.left - CHART.right);
          setHovered(Math.max(0, Math.min(SAMPLE_TICKS.length - 1, Math.round(ratio * (SAMPLE_TICKS.length - 1)))));
        }}
        onMouseLeave={() => setHovered(null)}
      >
        <title>Fictional sample market chart</title>
        <desc>Sample prices from 09:00 to 12:00 UTC. Northstar enters at 09:35 and Vector at 11:00. Markers use the same price and time axes as the line.</desc>
        <defs>
          <linearGradient id="pl-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pl-primary)" stopOpacity=".24" />
            <stop offset="100%" stopColor="var(--pl-primary)" stopOpacity="0" />
          </linearGradient>
          <filter id="pl-chart-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7" /></filter>
        </defs>
        {priceTicks.map((price, index) => {
          const y = sampleXY(CHART_DOMAIN.minTime, price, CHART_DOMAIN).y;
          return (
            <g key={index}>
              <line className="pl-gridline" x1={CHART.left} x2={CHART.width - CHART.right} y1={y} y2={y} />
              <text className="pl-axis-text" x={CHART.width - CHART.right + 10} y={y + 4}>{samplePrice(Math.round(price))}</text>
            </g>
          );
        })}
        {[0, 6, 12, 18, 24, 30, 36].map((index) => {
          const tick = SAMPLE_TICKS[index]!;
          const x = sampleXY(tick.at, tick.price, CHART_DOMAIN).x;
          return (
            <g key={index}>
              <line className="pl-gridline pl-gridline-vertical" x1={x} x2={x} y1={CHART.top} y2={BASELINE} />
              <text className="pl-axis-text" textAnchor="middle" x={x} y={CHART.height - 13}>{sampleTime(tick.at)}</text>
            </g>
          );
        })}
        <path d={AREA} fill="url(#pl-chart-fill)" />
        <path className="pl-chart-glow" d={LINE} fill="none" filter="url(#pl-chart-glow)" />
        <path className="pl-chart-line" d={LINE} fill="none" />
        {hoveredXY && hoveredTick && (
          <g className="pl-crosshair" aria-hidden="true">
            <line x1={hoveredXY.x} x2={hoveredXY.x} y1={CHART.top} y2={BASELINE} />
            <line x1={CHART.left} x2={CHART.width - CHART.right} y1={hoveredXY.y} y2={hoveredXY.y} />
            <circle cx={hoveredXY.x} cy={hoveredXY.y} r="5" />
          </g>
        )}
        {SAMPLE_ENTRIES.map((entry) => {
          const { x, y } = sampleXY(entry.at, entry.price, CHART_DOMAIN);
          const active = activeEntry === entry.id;
          return (
            <g
              className={`pl-entry ${active ? "is-active" : ""} ${entry.side === "short" ? "is-short" : ""}`}
              key={entry.id}
              role="button"
              tabIndex={0}
              aria-label={`${entry.agent} sample ${entry.side} entry at ${sampleTime(entry.at)} UTC, ${samplePrice(entry.price)}`}
              onClick={() => onEntry(entry)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onEntry(entry); } }}
            >
              <line className="pl-entry-stem" x1={x} x2={x} y1={y} y2={BASELINE} />
              <circle className="pl-entry-pulse" cx={x} cy={y} r="19" />
              <circle className="pl-entry-ring" cx={x} cy={y} r="11" />
              <circle className="pl-entry-core" cx={x} cy={y} r="5" />
              <text className="pl-entry-label" x={x + 16} y={y - 13}>{entry.agent.toUpperCase()}</text>
              <text className="pl-entry-sub" x={x + 16} y={y + 2}>{entry.side.toUpperCase()} · {sampleTime(entry.at)}</text>
            </g>
          );
        })}
      </svg>
      </div>
      <div className="pl-chart-foot">
        <span className="pl-chart-hover-text">{hoveredTick ? `${sampleTime(hoveredTick.at)} UTC · ${samplePrice(hoveredTick.price)}` : "Move over the chart to inspect sample prices"}</span>
        <span className="pl-chart-touch-text">Tap an agent to inspect its entry</span>
        <span>07 OCT 2026 <span className="pl-separator">·</span> UTC <span className="pl-separator">·</span> 5 MIN</span>
      </div>
      <span className="pl-mobile-chart-hint">Swipe the chart for the full sample session. Select an agent to jump to its marker.</span>
    </div>
  );
}

function ThemeEmblem({ theme }: { theme: Theme }) {
  if (theme === "radar") return <div className="pl-emblem pl-emblem-radar" aria-hidden="true"><i /><i /><i /><b>+</b></div>;
  if (theme === "race") return <div className="pl-emblem pl-emblem-race" aria-hidden="true"><span>01</span><i /><i /><i /></div>;
  return <div className="pl-emblem pl-emblem-arcade" aria-hidden="true"><span>✦</span><i /><i /></div>;
}

function SpotPreview({ theme }: { theme: Theme }) {
  return (
    <section className="pl-spot-surface" aria-label="Sample spot view">
      <div className="pl-spot-copy">
        <span className="pl-kicker">SPOT VIEW <span className="pl-separator">/</span> CONCEPT ONLY</span>
        <h2>Your market,<br /><em>your pace.</em></h2>
        <p>A calmer overview for tokens and agents. Flip the view switch to see how this concept transforms into perps.</p>
        <div className="pl-spot-pills"><span>Token discovery</span><span>Agent stories</span><span>Unleveraged positions</span></div>
      </div>
      <div className="pl-spot-art" aria-hidden="true">
        <div className="pl-spot-orbit one" /><div className="pl-spot-orbit two" />
        <div className="pl-spot-card card-one"><span>◇</span><b>Discover</b><small>new ideas</small></div>
        <div className="pl-spot-card card-two"><span>✳</span><b>Follow</b><small>agent thinking</small></div>
        <div className="pl-spot-card card-three"><span>↗</span><b>Hold</b><small>at your pace</small></div>
        <ThemeEmblem theme={theme} />
      </div>
      <div className="pl-spot-caption">DISPLAY PREVIEW ONLY <span>•</span> NO ACCOUNT OR TRADING CHANGES</div>
    </section>
  );
}

function PerpsPreview({ theme, activeEntry, onEntry }: {
  theme: Theme; activeEntry: string; onEntry: (entry: SampleEntry) => void;
}) {
  const entry = SAMPLE_ENTRIES.find((candidate) => candidate.id === activeEntry) ?? SAMPLE_ENTRIES[0]!;
  return (
    <section className="pl-perps-surface" aria-label="Sample perps view">
      <div className="pl-arena-head">
        <div>
          <span className="pl-kicker">PERPS VIEW <span className="pl-separator">/</span> CONCEPT ONLY</span>
          <h2>{theme === "arcade" ? "The arena." : theme === "radar" ? "The command deck." : "Find your line."}</h2>
          <p>{theme === "arcade" ? "Every agent's move has a moment." : theme === "radar" ? "See the move. Read the reason. Keep your bearings." : "Every entry leaves a trace on the tape."}</p>
        </div>
        <ThemeEmblem theme={theme} />
      </div>
      <div className="pl-arena-body">
        <div className="pl-chart-panel">
          <div className="pl-panel-head">
            <div><span className="pl-micro">SAMPLE / BTC–PERP</span><strong>{samplePrice(SAMPLE_TICKS[SAMPLE_TICKS.length - 1]!.price)}</strong><small>Final point in this fictional session</small></div>
            <span className="pl-panel-flag"><Crosshair size={14} strokeWidth={1.8} /> 2 sample entries</span>
          </div>
          <SampleChart activeEntry={activeEntry} onEntry={onEntry} />
        </div>
        <aside className="pl-side-panel" aria-label="Sample agent entries">
          <div className="pl-side-heading"><span className="pl-micro">ON THE TAPE</span><span>02 / 02</span></div>
          <h3>Agent entries</h3>
          <p>Select a marker to see exactly where the sample agent entered.</p>
          <div className="pl-agent-list">
            {SAMPLE_ENTRIES.map((candidate, index) => (
              <button className={`pl-agent-card ${activeEntry === candidate.id ? "is-active" : ""}`} key={candidate.id} type="button" onClick={() => onEntry(candidate)} aria-pressed={activeEntry === candidate.id}>
                <span className="pl-agent-top"><span className="pl-agent-avatar">{candidate.agent[0]}</span><span><strong>{candidate.agent}</strong><small>AGENT {String(index + 1).padStart(2, "0")}</small></span><ArrowUpRight size={16} /></span>
                <span className="pl-agent-bottom"><span className={`pl-side-tag is-${candidate.side}`}>{candidate.side.toUpperCase()}</span><b>{samplePrice(candidate.price)}</b><small>{sampleTime(candidate.at)} UTC</small></span>
              </button>
            ))}
          </div>
          <div className="pl-entry-detail" aria-live="polite">
            <div><span className="pl-micro">SELECTED SAMPLE MOMENT</span><span className="pl-entry-time">{sampleTime(entry.at)} UTC</span></div>
            <strong>{entry.agent} entered {entry.side}</strong>
            <p>{entry.note}</p>
            <small>Price marker: {samplePrice(entry.price)} at the matching chart timestamp.</small>
          </div>
        </aside>
      </div>
      <div className="pl-bottom-strip">
        <span><Shield size={15} /> Sample data only</span>
        <span>Read the time. Read the price. Read the reason.</span>
        <span>No orders or account state in this preview <ArrowUpRight size={14} /></span>
      </div>
    </section>
  );
}

export function PerpsLabClient() {
  const [theme, setTheme] = useState<Theme>("arcade");
  const [mode, setMode] = useState<Mode>("perps");
  const [sound, setSound] = useState(false);
  const [activeEntry, setActiveEntry] = useState(SAMPLE_ENTRIES[0]!.id);
  const audioContext = useRef<AudioContext | null>(null);

  useEffect(() => () => {
    const context = audioContext.current;
    audioContext.current = null;
    if (context) void context.close().catch(() => {});
  }, []);
  const cue = useCallback((kind: "switch" | "entry", force = false) => {
    if (!sound && !force) return;
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      if (context.state === "suspended") void context.resume();
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const now = context.currentTime;
      oscillator.type = kind === "switch" ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(kind === "switch" ? 260 : 710, now);
      oscillator.frequency.exponentialRampToValueAtTime(kind === "switch" ? 540 : 490, now + (kind === "switch" ? .22 : .13));
      envelope.gain.setValueAtTime(.0001, now);
      envelope.gain.exponentialRampToValueAtTime(.085, now + .015);
      envelope.gain.exponentialRampToValueAtTime(.0001, now + .26);
      oscillator.connect(envelope).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + .27);
    } catch { /* Audio is optional; UI still works if a browser blocks Web Audio. */ }
  }, [sound]);

  const chooseEntry = useCallback((entry: SampleEntry) => { setActiveEntry(entry.id); cue("entry"); }, [cue]);
  const setDisplayMode = (next: Mode) => { if (next !== mode) { setMode(next); cue("switch"); } };
  const setConcept = (next: Theme) => { if (next !== theme) { setTheme(next); cue("switch"); } };

  return (
    <main className={`perps-lab theme-${theme}`}>
      <div className="pl-glow" aria-hidden="true" />
      <div className="pl-shell">
        <header className="pl-topbar">
          <div className="pl-brand"><span className="pl-brand-mark">✳</span><span>merrymen</span><i /><small>DESIGN LAB / PERPS MODE</small></div>
          <div className="pl-top-actions"><span className="pl-top-demo">INTERACTIVE CONCEPT · FICTIONAL DATA</span><button className="pl-sound" type="button" aria-pressed={sound} onClick={() => { const next = !sound; setSound(next); if (next) cue("switch", true); }} title={sound ? "Turn preview sound off" : "Turn preview sound on"}>{sound ? <Volume2 size={17} /> : <VolumeX size={17} />}<span>Sound {sound ? "on" : "off"}</span></button></div>
        </header>

        <section className="pl-intro">
          <div><span className="pl-overline">THREE DIRECTIONS <span>/</span> ONE IDEA</span><h1>Make the switch <em>feel</em> like a new world.</h1><p>Explore three looks for a future perps view. Switch Spot ↔ Perps, tap the chart entries, and choose the visual language you like.</p></div>
          <span className="pl-intro-index">01 <i /> 03</span>
        </section>

        <nav className="pl-chooser" aria-label="Perps visual concepts">
          {THEMES.map((choice) => (
            <button className={`pl-choice pl-choice-${choice.id} ${theme === choice.id ? "is-active" : ""}`} key={choice.id} type="button" aria-pressed={theme === choice.id} onClick={() => setConcept(choice.id)}>
              <span className="pl-choice-top"><span>CONCEPT {choice.number}</span><span className="pl-choice-arrow">↗</span></span>
              <span className="pl-choice-icon" aria-hidden="true">{choice.icon}</span>
              <span className="pl-choice-bottom"><strong>{choice.name}</strong><small>{choice.brief}</small></span>
              <span className="pl-choice-track" aria-hidden="true" />
            </button>
          ))}
        </nav>

        <section className="pl-preview" aria-label="Interactive concept preview">
          <div className="pl-preview-bar">
            <div className="pl-preview-title"><span className="pl-preview-dot" /><span>INTERACTIVE DESIGN PREVIEW</span><b>·</b><strong>{THEMES.find((choice) => choice.id === theme)!.name}</strong></div>
            <div className="pl-mode-row"><span>DISPLAY MODE</span><div className="pl-mode-toggle" role="group" aria-label="Preview display mode"><button type="button" aria-pressed={mode === "spot"} onClick={() => setDisplayMode("spot")}>Spot</button><button type="button" aria-pressed={mode === "perps"} onClick={() => setDisplayMode("perps")}><Zap size={14} fill="currentColor" /> Perps</button></div></div>
          </div>
          <div className={`pl-stage mode-${mode}`} key={`${theme}-${mode}`}>
            <div className="pl-stage-sweep" aria-hidden="true" />
            {mode === "perps" ? <PerpsPreview theme={theme} activeEntry={activeEntry} onEntry={chooseEntry} /> : <SpotPreview theme={theme} />}
          </div>
        </section>

        <footer className="pl-footer"><span><Headphones size={15} /> Optional synthesized sound is off by default.</span><span><Crosshair size={15} /> Markers follow the sample time and price axes.</span><span>Preview only · no trading actions</span></footer>
      </div>
    </main>
  );
}
