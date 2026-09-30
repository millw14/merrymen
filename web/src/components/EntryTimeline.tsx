import { AgentAvatar } from "@/components/AgentAvatar";
import { fullDateTime } from "@/lib/format";

/**
 * WHO GOT IN, AND WHEN.
 *
 * The reference product plots trader avatars on a price line. This plots them
 * on a TIME line, and the difference is not a compromise — it is what the data
 * actually supports and, for a product whose subject is the agents, arguably
 * the better chart.
 *
 * AN EARLIER VERSION OF THIS COMMENT WAS WRONG, and it is worth recording how.
 * It said candles were IMPOSSIBLE for the 32-byte curve poolIds that cover most
 * of what is interesting on this chain, reasoning from GeckoPool.poolAddress
 * being null for them. That field is about CALLABILITY — somewhere to send an
 * eth_call — and the index indexes those pools perfectly well: asked directly,
 * /networks/robinhood/pools/<32-byte poolId>/ohlcv/hour returns 200 with real
 * candles.
 *
 * So the true statement is narrower. No OHLC exists in this repo yet, poolId is
 * not carried as far as the page, and nothing memoises a per-token candle
 * request on an index that refuses roughly two in five of them. This plot is
 * what the data supports TODAY, and it stays on the page beneath any chart that
 * later arrives — because it answers a question a candle chart cannot.
 *
 * The axis is labelled with what it plots. Nothing here implies a price.
 */
export interface Entry {
  name: string;
  /** The public id, so the pin wears the same face as everywhere else. */
  slug?: string | null;
  /** Unix seconds. */
  at: number;
  /** Position value, used only to order overlaps — never drawn as a y value. */
  size: number;
  /** A simulated fill. Drawn dashed, because a pretend entry is not an entry. */
  paper?: boolean;
}

export function EntryTimeline({
  entries,
  fillsRead = true,
}: {
  entries: Entry[];
  /**
   * Whether the fills query ANSWERED. Default true so existing callers are
   * unchanged; the token page passes the real thing.
   */
  fillsRead?: boolean;
}) {
  // CHECKED FIRST, and that order is the whole point. The sentence below is a
  // positive claim about ledger RETENTION, and it used to be printed whenever
  // the list was empty — including when the query had thrown on a ledger
  // predating the fill columns, where nothing at all is known about why.
  if (!fillsRead) {
    return (
      <p className="mm-note">
        The ledger did not answer for this token&rsquo;s fills, so there are no entry times below.
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="mm-note">
        No entry times on record for the agents holding this. That is missing data, not an empty
        book — the position is real, the trade that opened it is older than what the ledger keeps.
      </p>
    );
  }

  const times = entries.map((e) => e.at);
  const min = Math.min(...times);
  const max = Math.max(...times);
  // A single entry, or several in the same second, would divide by zero and
  // stack on the left edge. Centre them instead.
  const span = max - min || 1;
  const single = max === min;

  const sorted = [...entries].sort((a, b) => a.at - b.at);

  return (
    <div className="mm-timeline">
      <div className="track">
        <div className="line" />
        {sorted.map((e, i) => {
          const x = single ? 50 : ((e.at - min) / span) * 100;
          return (
            <span
              key={`${e.name}:${e.at}:${i}`}
              className={`pin${e.paper ? " unsettled" : ""}`}
              style={{ left: `${x}%`, zIndex: sorted.length - i }}
              title={`${e.name} — ${fullDateTime(e.at * 1000)}${
                e.paper ? " (paper)" : ""
              }`}
            >
              <AgentAvatar name={e.name} slug={e.slug ?? null} size={26} />
            </span>
          );
        })}
      </div>
      <div className="axis mono">
        <span>{single ? "all at once" : rel(min)}</span>
        <span className="mid">entry time — not price</span>
        <span>{single ? "" : rel(max)}</span>
      </div>
    </div>
  );
}

function rel(at: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
