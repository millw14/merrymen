import { useState } from "react";
import { Coin, Empty } from "./ui";
import { elapsed, useNow } from "./clock";
import { dayLabel, fullDateTime } from "@/lib/format";
import type { LiveToken } from "./live";
import { OP_WORDS, pnlChip, sizeText, swapItems, triedLine, type SwapRow, type SwapTab } from "./swaps";

const TABS: { id: SwapTab; label: string; empty: string }[] = [
  { id: "all", label: "All", empty: "" },
  { id: "buys", label: "Buys", empty: "No buys in this list." },
  { id: "sells", label: "Sells", empty: "No sells in this list." },
];

/**
 * ONE SWAPS TABLE for the public profile and the owner's desk.
 *
 * Every rule it applies — which dollars may show, where a P&L chip goes, how
 * refusals fold into one line — is in swaps.ts, where a test runs it. This
 * only draws: a Buy or Sell pill (a muted "Tried" for refusals), the coin and
 * its name, the figures the viewer may see, and a relative age with the full
 * date on hover.
 */
export function SwapsTable({
  rows,
  tokens,
  showMoney,
  emptyTitle,
  tapeFull = false,
  limit = 8,
  onToken,
}: {
  rows: SwapRow[];
  tokens: LiveToken[];
  /** The owner's own view, or a book its owner published. Never otherwise. */
  showMoney: boolean;
  emptyTitle: string;
  /** The rows came from a read that hit its limit; see swapItems. */
  tapeFull?: boolean;
  limit?: number;
  onToken?: (id: string) => void;
}) {
  const [tab, setTab] = useState<SwapTab>("all");
  const [expanded, setExpanded] = useState(false);
  // Ages print seconds under a minute ("55s"), so the clock steps at the pace
  // the feed's rows do (wire.tsx), not once in thirty seconds of a stale "55s".
  const nowMs = useNow(5_000);
  const items = swapItems(rows, tab, { tapeFull });
  const shown = expanded ? items : items.slice(0, limit);
  const empty = TABS.find((t) => t.id === tab)!.empty || emptyTitle;
  return (
    <div className="swaps">
      <div className="swaps-tabs" role="group" aria-label="Which trades">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => { setTab(t.id); setExpanded(false); }}>
            {t.label}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <Empty compact title={empty} />
      ) : (
        <ul className="swaps-list">
          {shown.map((item) =>
            item.kind === "tried" ? (
              <li key={item.key} className="swap-row is-tried">
                <span className="swap-pill tried">Tried</span>
                <span className="swap-tried">{triedLine(item, nowMs, (ms) => dayLabel(ms))}</span>
                <Age at={item.newestAt} nowMs={nowMs} />
              </li>
            ) : (
              <SwapLine key={item.row.id} row={item.row} tokens={tokens} showMoney={showMoney} nowMs={nowMs} onToken={onToken} />
            ),
          )}
        </ul>
      )}
      {items.length > limit && (
        <button type="button" className="public-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

function SwapLine({
  row,
  tokens,
  showMoney,
  nowMs,
  onToken,
}: {
  row: SwapRow;
  tokens: LiveToken[];
  showMoney: boolean;
  nowMs: number;
  onToken?: (id: string) => void;
}) {
  const size = sizeText(row, showMoney);
  if (row.op !== "trade") {
    // A MOVE OF CASH, NOT A SWAP: a vault deposit or withdrawal, or USDG sent
    // out. It has no coin and no side, and read "Swap · Token label
    // unavailable" when it was drawn as one. It says what it did instead.
    const words = OP_WORDS[row.op];
    return (
      <li className="swap-row is-move">
        <span className="swap-pill move">{words.pill}</span>
        <span className="swap-token">
          <span className="swap-coin">
            <strong>{words.line}</strong>
            {row.why && <small className="swap-why" title={row.why}>{row.why}</small>}
          </span>
        </span>
        <span className="swap-figures">{size && <strong>{size}</strong>}</span>
        <span className="swap-meta">
          {row.status === "pending" && <em>Pending</em>}
          {row.paper && <em>Paper</em>}
          <Age at={row.at} nowMs={nowMs} />
        </span>
      </li>
    );
  }
  const token = row.symbol ? tokens.find((t) => t.symbol.toUpperCase() === row.symbol!.toUpperCase()) : undefined;
  const name = row.displayName ?? token?.name ?? null;
  const chip = pnlChip(row, showMoney);
  const coin = (
    <>
      <Coin symbol={row.symbol ?? "?"} logo={token?.logo ?? ""} />
      <span className="swap-coin">
        <strong>{row.symbol ?? "Token label unavailable"}</strong>
        {name && name.toUpperCase() !== row.symbol?.toUpperCase() && <small>{name}</small>}
        {row.why && <small className="swap-why" title={row.why}>{row.why}</small>}
      </span>
    </>
  );
  return (
    <li className="swap-row">
      <span className={`swap-pill ${row.side ?? "swap"}`}>{row.side === "buy" ? "Buy" : row.side === "sell" ? "Sell" : "Swap"}</span>
      {token && onToken ? (
        <button type="button" className="swap-token" onClick={() => onToken(token.id)}>{coin}</button>
      ) : (
        <span className="swap-token">{coin}</span>
      )}
      <span className="swap-figures">
        {size && <strong>{size}</strong>}
        {chip && <span className={`swap-pnl ${chip.tone}`}>{chip.text}</span>}
      </span>
      <span className="swap-meta">
        {row.status === "pending" && <em>Pending</em>}
        {row.paper && <em>Paper</em>}
        <Age at={row.at} nowMs={nowMs} />
      </span>
    </li>
  );
}

/** "12s", "4m", "3h", "2d" — the full moment on hover. Nothing when unread. */
function Age({ at, nowMs }: { at: number | null; nowMs: number }) {
  if (at === null || !Number.isFinite(at)) return null;
  const ms = at * 1000;
  return (
    <time className="swap-age" dateTime={new Date(ms).toISOString()} title={fullDateTime(ms)}>
      {elapsed(ms, nowMs).text}
    </time>
  );
}
