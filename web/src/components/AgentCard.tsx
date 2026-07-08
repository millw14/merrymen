import type { AgentView } from "@/lib/mock";

function Sparkline({ series, up }: { series: number[]; up: boolean }) {
  const w = 96;
  const h = 28;
  const step = w / (series.length - 1);
  const points = series
    .map((v, i) => `${(i * step).toFixed(1)},${(h - v * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline className={up ? "up" : "down"} points={points} />
    </svg>
  );
}

export function AgentCard({ agent }: { agent: AgentView }) {
  const up = agent.pnlUsd >= 0;
  const ddRatio = agent.drawdownPct / agent.maxDrawdownPct;
  const ddClass = ddRatio >= 0.8 ? "hot" : ddRatio >= 0.5 ? "warn" : "";

  return (
    <div className={`agent-card ${agent.status}`}>
      <div className="agent-head">
        <div className="agent-sigil">{agent.sigil}</div>
        <div>
          <div className="agent-name">{agent.name}</div>
          <div className="agent-strategy">{agent.strategy}</div>
        </div>
        <div className="agent-status">
          <span className="status-dot" />
          {agent.status}
        </div>
      </div>

      <div className="agent-pnl">
        <div>
          <div className={`pnl-value mono ${up ? "up" : "down"}`}>
            {up ? "+" : "−"}${Math.abs(agent.pnlUsd).toFixed(2)}
          </div>
          <div className="pnl-label">
            {up ? "+" : "−"}
            {Math.abs(agent.pnlPct).toFixed(1)}% · {agent.uptime}
          </div>
        </div>
        <Sparkline series={agent.series} up={up} />
      </div>

      <div className="caps">
        <span className="cap">
          max <b>{agent.caps.perTrade}</b>/trade
        </span>
        <span className="cap">
          <b>{agent.caps.daily}</b>/day
        </span>
        <span className="cap">
          key expires <b>{agent.caps.expiresIn}</b>
        </span>
      </div>

      <div className="drawdown">
        <div className="drawdown-label">
          <span>drawdown {agent.drawdownPct.toFixed(1)}%</span>
          <span>breaker @ {agent.maxDrawdownPct}%</span>
        </div>
        <div className="drawdown-track">
          <div
            className={`drawdown-fill ${ddClass}`}
            style={{ width: `${Math.min(100, ddRatio * 100)}%` }}
          />
        </div>
      </div>

      <div className="agent-actions">
        <button className="btn-ghost">details</button>
        <button className="btn-ghost">{agent.status === "active" ? "pause" : "resume"}</button>
        <button className="btn-kill">kill</button>
      </div>
    </div>
  );
}
