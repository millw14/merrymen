import { ChartArea, RotateCcw, ArrowDown } from "lucide-react";
import { DitherChart } from "../DitherChart";
import { useEffect, useMemo, useState } from "react";
import {
  loadBars,
  type Bar,
  type ChartKind,
  type Seat,
  type WindowId,
} from "../bars";
import {
  coinPrice,
  quoteTitle,
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
import { useWatchlist } from "../watchlist";

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
  const [loading, setLoading] = useState(true);
  const watchlist = useWatchlist();
  const starred = watchlist.ids.includes(token.id);
  const [copied, setCopied] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [chartRevision, setChartRevision] = useState(0);
  const [sortBy, setSortBy] = useState<"position" | "return">("position");
  const [sortDescending, setSortDescending] = useState(true);
  const [seats,setSeats]=useState<Seat[]>([]);
  const [holderError,setHolderError]=useState("");
  useEffect(()=>{
    let alive=true;setSeats([]);setHolderError("");
    fetch(`/api/tokens/${encodeURIComponent(token.id)}`).then(r=>{if(!r.ok)throw new Error("Could not load public holdings.");return r.json();}).then((data:{ledger:import("@/lib/read-token").TokenRead;market:{symbolClash:boolean}})=>{
      if(!alive)return;
      if(!data.ledger.fillsRead){setHolderError("Public holdings are unavailable right now.");return;}
      setSeats(data.ledger.holders.filter(h=>h.slug).map(h=>({slug:h.slug!,name:h.name,handle:h.handle,owner:null,strategy:"",strategyId:"custom",position:h.valueUsdg,pnlBps:h.pnlBps,avgEntry:h.entryPriceUsd ?? 0,thesis:data.market.symbolClash ? "" : theses.find(t=>t.slug===h.slug && t.symbol?.toUpperCase()===token.symbol.toUpperCase())?.reason ?? "",time:h.enteredAt ?? 0,price:h.entryPriceUsd ?? 0})));
    }).catch(e=>{if(alive)setHolderError(e.message);});
    return()=>{alive=false;};
  },[token.id,token.symbol,theses]);
  const orderedSeats = useMemo(
    () =>
      [...seats].sort(
        (a, b) =>
          (sortDescending ? -1 : 1) *
          ((sortBy === "position" ? a.position : (a.pnlBps ?? -Infinity)) -
            (sortBy === "position" ? b.position : (b.pnlBps ?? -Infinity))),
      ),
    [seats, sortBy, sortDescending],
  );
  const sortHolders = (next: "position" | "return") => {
    if (sortBy === next) setSortDescending((value) => !value);
    else {
      setSortBy(next);
      setSortDescending(true);
    }
  };
  const chartPoints = useMemo(
    () =>
      bars.map((bar) => ({
        value: bar.close,
        label: new Date(bar.time * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      })),
    [bars],
  );
  const first = bars[0];
  const last = bars[bars.length - 1];
  const winPct =
    first && last && first.open > 0
      ? ((last.close - first.open) / first.open) * 100
      : null;
  const winDol = first && last ? last.close - first.open : null;
  const down = (winPct ?? 0) < 0;

  useEffect(() => {
    let alive = true;
    setBars([]);
    setLoading(true);
    void loadBars(token, span).then((next) => {
      if (alive) {
        setBars(next);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [token.id, token.symbol, token.kind, token.uiMultiplier, span]);

  const copyId = () => {
    void navigator.clipboard.writeText(token.id).then(() => {
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1200);
    }).catch(() => setActionMessage("Could not copy the address. Select it to copy manually."));
  };

  const share = () => {
    const url = location.href;
    if (navigator.share) {
      void navigator.share({ title: token.symbol, text: token.name, url }).catch((error) => { if(error.name !== "AbortError") setActionMessage("Could not share this token. Copy the page address instead."); });
      return;
    }
    void navigator.clipboard.writeText(url).then(()=>setActionMessage("Link copied.")).catch(()=>setActionMessage("Could not copy the link. Copy the page address instead."));
  };

  return (
    <div className="token">
      <header className="token-top">
        <button
          type="button"
          className="back"
          onClick={onBack}
          aria-label="Back"
        >
          ←
        </button>
        <div className="token-who">
          <Coin symbol={token.symbol} logo={token.logo} />
          <div>
            <h1>
              {token.symbol}
              {token.kind !== "memecoin" && <i className="verified" aria-label="Registered tokenized asset" />}
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
          <button
            type="button"
            className={starred ? "on" : ""}
            aria-label="Watch"
            aria-pressed={starred}
            onClick={() => {try {watchlist.toggle(token.id);} catch {setActionMessage("Could not save your watchlist on this device.");}}}
          >
            <StarIcon on={starred} />
          </button>
          <button type="button" aria-label="Share" onClick={share}>
            <ShareIcon />
          </button>
        </div>
      </header>
      {actionMessage && <p role="status">{actionMessage}</p>}

      <div className="token-hero">
        <div>
          <div className="price" title={quoteTitle(token)}>
            {coinPrice(token.priceUsd)}
          </div>
          {winPct != null && (
            <strong className={down ? "down" : "up"}>
              {down ? "▼" : "▲"} {winDol != null ? money(Math.abs(winDol)) : ""}{" "}
              {pctPts(winPct)} {span}
            </strong>
          )}
        </div>
        {token.fdvUsd != null && (
          <div className="token-mc">
            <b>{compactUsd(token.fdvUsd)}</b>
            <span>Fully diluted value</span>
          </div>
        )}
      </div>

      <div className="token-market-strip">
        <div>
          <span>
            {token.priceUsd == null
              ? "Chart close"
              : token.priceSource === "robinhood"
                ? "Quote midpoint"
                : "Token price"}
          </span>
          <strong title={quoteTitle(token)}>
            {coinPrice(token.priceUsd ?? last?.close ?? null)}
          </strong>
        </div>
        <div>
          <span>{span} change</span>
          <strong className={down ? "down" : "up"}>{pctPts(winPct)}</strong>
        </div>
        <div>
          <span>{span} high</span>
          <strong>
            {coinPrice(
              bars.length ? Math.max(...bars.map((b) => b.high)) : null,
            )}
          </strong>
        </div>
        <div>
          <span>{span} low</span>
          <strong>
            {coinPrice(
              bars.length ? Math.min(...bars.map((b) => b.low)) : null,
            )}
          </strong>
        </div>
        <div>
          <span>Agents holding</span>
          <strong>{holderError ? "—" : seats.length}</strong>
        </div>
      </div>
        <div className="token-plot">
          {bars.length === 0 ? <p className="meta" role="status">{loading ? "Loading the chart…" : "Price history unavailable. Try another timeframe."}</p> : kind === "line" ? (
            <DitherChart
              key={`${token.id}-${span}-${chartRevision}`}
              riders={seats.filter(seat=>seat.time >= bars[0]!.time && seat.time <= bars[bars.length-1]!.time && seat.price>0).map((seat) => ({
                name: seat.name,
                slug: seat.slug,
                index: bars.reduce(
                  (best, bar, index) =>
                    Math.abs(bar.time - seat.time) <
                    Math.abs(bars[best]!.time - seat.time)
                      ? index
                      : best,
                  0,
                ),
              }))}
              onRider={onProfile}
              points={chartPoints}
              label={`${token.symbol} price history`}
              format={coinPrice}
              height={250}
            />
          ) : (
            <TvChart
              key={chartRevision}
              bars={bars}
              seats={seats.filter(s=>s.time>0 && s.price>0)}
              kind={kind}
              down={down}
              onAgent={onProfile}
            />
          )}
          <div className="tv-tools">
            <div className="tv-windows">
              {WINDOWS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={span === id ? "on" : ""}
                  onClick={() => setSpan(id)}
                >
                  {id}
                </button>
              ))}
            </div>
            <div className="tv-kinds">
              <button
                type="button"
                className="chart-reset"
                aria-label="Reset chart view"
                title="Reset chart view"
                onClick={() => setChartRevision((value) => value + 1)}
              >
                <RotateCcw size={15} />
              </button>
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
                aria-label="Dither area"
                onClick={() => setKind("line")}
              >
                <ChartArea size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

      <section className="held-sec">
        {holderError && <p role="status">{holderError}</p>}
        <h3>Holders{seats.length ? ` (${seats.length})` : ""}</h3>
        {seats.length > 0 && (
          <div className="holder-table-wrap">
            <table className="holder-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th
                    aria-sort={
                      sortBy === "position"
                        ? sortDescending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    <button onClick={() => sortHolders("position")}>
                      Position{" "}
                      {sortBy === "position" && (
                        <ArrowDown
                          size={12}
                          style={{
                            transform: sortDescending
                              ? undefined
                              : "rotate(180deg)",
                          }}
                        />
                      )}
                    </button>
                  </th>
                  <th
                    aria-sort={
                      sortBy === "return"
                        ? sortDescending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    <button onClick={() => sortHolders("return")}>
                      Return{" "}
                      {sortBy === "return" && (
                        <ArrowDown
                          size={12}
                          style={{
                            transform: sortDescending
                              ? undefined
                              : "rotate(180deg)",
                          }}
                        />
                      )}
                    </button>
                  </th>
                  <th>Avg. entry</th>
                  <th>Thesis</th>
                </tr>
              </thead>
              <tbody>
                {orderedSeats.map((seat) => (
                  <tr key={seat.slug}>
                    <td>
                      <button
                        className="holder-agent"
                        onClick={() => onProfile(seat.slug)}
                      >
                        <Face name={seat.name} slug={seat.slug} />
                        <span>
                          <strong>{seat.name}</strong>
                          <small>{seat.strategy}</small>
                        </span>
                      </button>
                    </td>
                    <td>{money(seat.position)}</td>
                    <td className={(seat.pnlBps ?? 0) < 0 ? "down" : "up"}>
                      {pctBps(seat.pnlBps)}
                    </td>
                    <td>{coinPrice(seat.avgEntry || null)}</td>
                    <td className="holder-thesis">
                      <p>{seat.thesis || "—"}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {seats.length === 0 ? (
          !holderError && <p className="meta">No public agent holdings reported yet.</p>
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

function Held({
  seat,
  onProfile,
}: {
  seat: Seat;
  onProfile: (slug: string) => void;
}) {
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
          {seat.avgEntry > 0 ? (
            <span>Avg. {coinPrice(seat.avgEntry || null)}</span>
          ) : (
            <span />
          )}
          <em
            className={
              seat.pnlBps == null ? "" : seat.pnlBps >= 0 ? "up" : "down"
            }
          >
            {pctBps(seat.pnlBps)}
          </em>
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
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={on ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M12 3.6 14.6 9l5.9.5-4.5 3.9 1.4 5.7L12 16.4 6.6 19.1l1.4-5.7L3.5 9.5 9.4 9Z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
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
