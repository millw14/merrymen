/**
 * THE MARKET DESK — the `TgDeskPort` that index.ts hands the Telegram groups
 * handler (docs/tg-groups.md "Market analysis").
 *
 * look(): resolve the ask, read the index, measure, write the brief and the
 * code's own read, draw the chart. One minute of memo per ask, and concurrent
 * asks for the same thing share one job — three people asking about one coin
 * in a burst cost one set of reads and one render.
 *
 * think(): Brain's read, when the operator has said group asks may spend
 * Brain's key (rule 7). Otherwise absent, and the group's own model or the
 * code's floor answers.
 */
import type { TgDeskAsk, TgDeskOutcome, TgDeskPort, TgDeskThinkRequest, TgDeskThought } from "../telegram/tg-groups/types";
import { fetchGeckoPoolsResult, readTokenPoolsResult } from "../venues/geckoterminal";
import { askBrainDesk, type BrainDeskConfig } from "./brain-desk";
import { coinChartSvg, marketChartSvg, renderPng } from "./chart";
import { coinBrief, coinFloor, coinHeader, marketBrief, marketFloor, marketHeader, measureCoin, measureMarket, type DeskReads, type Sayable } from "./evidence";
import { utcClock } from "./format";
import { safeSubject } from "../telegram/tg-groups/desk";
import { readHourlyBars, searchPools } from "./gecko";

export const LIVE_READS: DeskReads = {
  search: (q) => searchPools(q),
  tokenPools: (a) => readTokenPoolsResult(a, { timeoutMs: 8000 }),
  hourly: (pool, token) => readHourlyBars(pool, token, 168),
  feed: (feed) => fetchGeckoPoolsResult(feed, { timeoutMs: 8000 }),
  now: () => Date.now(),
};

export interface DeskDeps {
  reads?: DeskReads;
  /** Brain's desk endpoint, when the operator allows group asks to use it. */
  brain?: BrainDeskConfig | null;
  render?: (svg: string | null) => Promise<Uint8Array | null>;
  /** Whether a ticker may be printed. Default: the group gate's own judgement (tg-groups/desk.ts safeSubject). */
  sayable?: Sayable;
}

/** A ticker the group gate would let the agent say, unchanged. */
export const GROUP_SAYABLE: Sayable = (ticker) => safeSubject(ticker) === ticker;

const MEMO_MS = 60_000;

const keyOf = (ask: TgDeskAsk): string =>
  ask.kind === "market" ? "market" : "address" in ask ? `a:${ask.address.toLowerCase()}` : `q:${ask.query.toLowerCase().replace(/^\$/, "")}`;

export async function lookOnce(ask: TgDeskAsk, reads: DeskReads, render: (svg: string | null) => Promise<Uint8Array | null>, sayable: Sayable = GROUP_SAYABLE): Promise<TgDeskOutcome> {
  try {
    if (ask.kind === "market") {
      const m = await measureMarket(reads, sayable);
      if (!m.ok) return { ok: false, why: m.why };
      return {
        ok: true,
        evidence: {
          kind: "market",
          subject: "market",
          header: marketHeader(m.market),
          brief: marketBrief(m.market),
          floor: marketFloor(m.market),
          source: `GeckoTerminal ${utcClock(m.market.observedAtMs)} UTC`,
          observedAtMs: m.market.observedAtMs,
          chart: await render(marketChartSvg(m.market)),
        },
      };
    }
    const c = await measureCoin(ask, reads, sayable);
    if (!c.ok) return { ok: false, why: c.why };
    return {
      ok: true,
      evidence: {
        kind: "coin",
        subject: c.coin.symbol,
        header: coinHeader(c.coin),
        brief: coinBrief(c.coin),
        floor: coinFloor(c.coin),
        source: `GeckoTerminal ${utcClock(c.coin.observedAtMs)} UTC`,
        observedAtMs: c.coin.observedAtMs,
        chart: await render(coinChartSvg(c.coin)),
      },
    };
  } catch {
    return { ok: false, why: "unavailable" };
  }
}

export function createDesk(d: DeskDeps = {}): TgDeskPort {
  const reads = d.reads ?? LIVE_READS;
  const render = d.render ?? renderPng;
  const sayable = d.sayable ?? GROUP_SAYABLE;
  const memo = new Map<string, { until: number; value: TgDeskOutcome }>();
  const pending = new Map<string, Promise<TgDeskOutcome>>();
  const port: TgDeskPort = {
    look(ask) {
      const k = keyOf(ask);
      const hit = memo.get(k);
      if (hit && hit.until > reads.now()) return Promise.resolve(hit.value);
      const inFlight = pending.get(k);
      if (inFlight) return inFlight;
      const job = lookOnce(ask, reads, render, sayable)
        .then((value) => {
          if (memo.size >= 64) memo.delete(memo.keys().next().value!);
          // A miss is remembered briefly: "not found" should not be re-searched
          // by every repeat of the same typo, nor pinned for a coin listed a
          // minute from now.
          memo.set(k, { until: reads.now() + (value.ok ? MEMO_MS : 15_000), value });
          return value;
        })
        .finally(() => pending.delete(k));
      pending.set(k, job);
      return job;
    },
  };
  const brain = d.brain;
  if (brain && brain.url && brain.token) {
    port.think = (req: TgDeskThinkRequest): Promise<TgDeskThought | null> => askBrainDesk(brain, req);
  }
  return port;
}
