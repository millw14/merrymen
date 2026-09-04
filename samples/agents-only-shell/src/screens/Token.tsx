import { useEffect, useState } from "react";
import { loadBars, seatsOf, type Bar, type ChartKind, type Seat, type WindowId } from "../bars";
import {
  coinPrice,
  compactUsd,
  money,
  pctBps,
  pctPts,
  type LiveAgent,
  type LiveToken,
  type Thesis,
} from "../live";
import { TvChart } from "../tv";
import { Coin, Face } from "../ui";

const WINDOWS: WindowId[] = ["1H", "4H", "1D", "7D", "1M", "ALL"];

export function Token({
  token,
  theses,
  agents,
  onBack,
  onProfile,
}: {
  token: LiveToken;
  theses: Thesis[];
  agents: LiveAgent[];
  onBack: () => void;
  onProfile: (slug: string) => void;
}) {
  const [span, setSpan] = useState<WindowId>("1D");
  const [kind, setKind] = useState<ChartKind>("candle");
  const [bars, setBars] = useState<Bar[]>([]);
  const [starred, setStarred] = useState(false);
  const [copied, setCopied] = useState(false);
  const seats = seatsOf(theses, agents, token, bars);
  const first = bars[0];
  const last = bars[bars.length - 1];
  const winPct =
    first && last && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : token.change24hPct;
  const winDol = first && last ? last.close - first.open : null;
  const down = (winPct ?? 0) < 0;

  useEffect(() => {
    let alive = true;
    void loadBars(token, span).then((next) => {
      if (alive) setBars(next);
    });
    return () => {
      alive = false;
    };
  }, [token, span]);

  const copyId = () => {
    void navigator.clipboard.writeText(token.id).then(() => {
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1200);
    });
  };

  const share = () => {
    const url = location.href;
    if (navigator.share) {
      void navigator.share({ title: token.symbol, text: token.name, url });
      return;
    }
    void navigator.clipboard.writeText(url);
  };

  return (
    <div className="token">
      <header className="token-top">
        <button type="button" className="back" onClick={onBack} aria-label="Back">
          ←
        </button>
        <div className="token-who">
          <Coin symbol={token.symbol} logo={token.logo} />
          <div>
            <h1>
              {token.symbol}
              <i className="verified" aria-label="Verified" />
            </h1>
            <p className="token-sub">
              <span>{token.name}</span>
              <button type="button" onClick={copyId}>
                {copied ? "Copied" : shortId(token.id)}
              </button>
            </p>
          </div>
        </div>
        <div className="token-acts">
          <button type="button" className={starred ? "on" : ""} aria-label="Watch" onClick={() => setStarred((v) => !v)}>
            <StarIcon on={starred} />
          </button>
          <button type="button" aria-label="Share" onClick={share}>
            <ShareIcon />
          </button>
        </div>
      </header>

      <div className="token-hero">
        <div>
          <div className="price">{coinPrice(token.priceUsd)}</div>
          {winPct != null && (
            <strong className={down ? "down" : "up"}>
              {down ? "▼" : "▲"} {winDol != null ? money(Math.abs(winDol)) : ""} {pctPts(winPct)} {span}
            </strong>
          )}
        </div>
        {token.fdvUsd != null && (
          <div className="token-mc">
            <b>{compactUsd(token.fdvUsd)}</b>
            <span>Market cap</span>
          </div>
        )}
      </div>

      {bars.length > 0 ? (
        <div className="token-plot">
          <TvChart bars={bars} seats={seats} kind={kind} down={down} onAgent={onProfile} />
          <div className="tv-tools">
            <div className="tv-windows">
              {WINDOWS.map((id) => (
                <button key={id} type="button" className={span === id ? "on" : ""} onClick={() => setSpan(id)}>
                  {id}
                </button>
              ))}
            </div>
            <div className="tv-kinds">
              <button
                type="button"
                className={kind === "candle" ? "on" : ""}
                aria-label="Candles"
                onClick={() => setKind("candle")}
              >
                <CandleIcon />
              </button>
              <button
                type="button"
                className={kind === "line" ? "on" : ""}
                aria-label="Line"
                onClick={() => setKind("line")}
              >
                <LineIcon />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="meta">Loading the chart…</p>
      )}

      <section className="held-sec">
        <h3>Holders{seats.length ? ` (${seats.length})` : ""}</h3>
        {seats.length === 0 ? (
          <p className="meta">No agents in this name yet.</p>
        ) : (
          <div className="helds">
            {seats.map((s) => (
              <Held key={s.slug} seat={s} onProfile={onProfile} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Held({ seat, onProfile }: { seat: Seat; onProfile: (slug: string) => void }) {
  return (
    <button type="button" className="held" onClick={() => onProfile(seat.slug)}>
      <Face name={seat.name} slug={seat.slug} />
      <div className="held-who">
        <div className="held-top">
          <div className="held-id">
            <strong>{seat.name}</strong>
            {seat.strategy ? <i className="tag">{seat.strategy}</i> : null}
          </div>
          {seat.position > 0 ? <b>{money(seat.position)}</b> : null}
        </div>
        <div className="held-sub">
          {seat.avgEntry > 0 ? <span>Avg. {coinPrice(seat.avgEntry)}</span> : <span />}
          <em className={seat.pnlBps == null ? "" : seat.pnlBps >= 0 ? "up" : "down"}>{pctBps(seat.pnlBps)}</em>
        </div>
        {seat.thesis ? <p>{seat.thesis}</p> : null}
      </div>
    </button>
  );
}

function shortId(id: string): string {
  if (id.length < 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function StarIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3.6 14.6 9l5.9.5-4.5 3.9 1.4 5.7L12 16.4 6.6 19.1l1.4-5.7L3.5 9.5 9.4 9Z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="18" cy="5" r="2.2" />
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="19" r="2.2" />
      <path d="M8 11.1 16 6.2M8 12.9 16 17.8" />
    </svg>
  );
}

function CandleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M7 4h2v3H7zM7 17h2v3H7zM6 8h4v8H6zM15 3h2v5h-2zM15 16h2v5h-2zM14 9h4v6h-4z" />
    </svg>
  );
}

function LineIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 16 9 10l4 3 7-9" />
    </svg>
  );
}
