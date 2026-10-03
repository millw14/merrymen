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
import { coinBrief, coinFloor, coinHeader, marketBrief, marketFloor, marketHeader, measureCoin, measureMarket, type CoinMeasure, type MarketMeasure, type DeskReads, type Sayable } from "./evidence";
import { utcClock } from "./format";
import { safeSubject } from "../telegram/tg-groups/desk";
import { readHourlyBars, searchPools } from "./gecko";
import { DeskBudget, lookupTimeout, type DeskReadOptions } from "./deadline";

export const LIVE_READS: DeskReads = {
  search: (q, options) => searchPools(q, Math.min(8000, options?.timeoutMs ?? 8000), options?.signal),
  tokenPools: (a, options) => readTokenPoolsResult(a, { timeoutMs: Math.min(8000, options?.timeoutMs ?? 8000) }),
  hourly: (pool, token, options) => readHourlyBars(pool, token, 168, Math.min(8000, options?.timeoutMs ?? 8000), options?.signal),
  feed: (feed, options) => fetchGeckoPoolsResult(feed, { timeoutMs: Math.min(8000, options?.timeoutMs ?? 8000) }),
  now: () => Date.now(),
};

export interface DeskDeps {
  reads?: DeskReads;
  /** Brain's desk endpoint, when the operator allows group asks to use it. */
  brain?: BrainDeskConfig | null;
  render?: (svg: string | null, options?: DeskReadOptions) => Promise<Uint8Array | null>;
  /** Whether a ticker may be printed. Default: the group gate's own judgement (tg-groups/desk.ts safeSubject). */
  sayable?: Sayable;
}

/** A ticker the group gate would let the agent say, unchanged. */
export const GROUP_SAYABLE: Sayable = (ticker) => safeSubject(ticker) === ticker;

const MEMO_MS = 60_000;

const keyOf = (ask: TgDeskAsk): string =>
  ask.kind === "market" ? "market" : "address" in ask ? `a:${ask.address.toLowerCase()}` : `q:${ask.query.toLowerCase().replace(/^\$/, "")}`;

const unavailable = (): TgDeskOutcome => ({ ok: false, why: "unavailable" });

function coinOutcome(c: CoinMeasure, chart: Uint8Array | null = null): TgDeskOutcome {
  return { ok: true, evidence: {
    kind: "coin", subject: c.symbol, header: coinHeader(c), brief: coinBrief(c), floor: coinFloor(c),
    source: `GeckoTerminal ${utcClock(c.observedAtMs)} UTC`, observedAtMs: c.observedAtMs, chart,
  } };
}

function marketOutcome(m: MarketMeasure, chart: Uint8Array | null = null): TgDeskOutcome {
  return { ok: true, evidence: {
    kind: "market", subject: "market", header: marketHeader(m), brief: marketBrief(m), floor: marketFloor(m),
    source: `GeckoTerminal ${utcClock(m.observedAtMs)} UTC`, observedAtMs: m.observedAtMs, chart,
  } };
}

export async function lookOnce(ask: TgDeskAsk, reads: DeskReads, render: NonNullable<DeskDeps["render"]>, sayable: Sayable = GROUP_SAYABLE, options?: { timeoutMs?: number }, onPartial?: (value: TgDeskOutcome) => void): Promise<TgDeskOutcome> {
  const budget = new DeskBudget(options?.timeoutMs);
  const draw = async (svg: () => string | null): Promise<Uint8Array | null> => {
    if (budget.remaining() < 1) return null;
    try {
      const source = svg();
      return source ? await budget.run((remaining) => render(source, remaining), null, 1500) : null;
    } catch { return null; }
  };
  try {
    if (ask.kind === "market") {
      const m = await measureMarket(reads, sayable, budget, (partial) => onPartial?.(marketOutcome(partial)));
      if (!m.ok) return { ok: false, why: m.why };
      return marketOutcome(m.market, await draw(() => marketChartSvg(m.market)));
    }
    const c = await measureCoin(ask, reads, sayable, budget, (partial) => onPartial?.(coinOutcome(partial)));
    if (!c.ok) return { ok: false, why: c.why };
    return coinOutcome(c.coin, await draw(() => coinChartSvg(c.coin)));
  } catch {
    return unavailable();
  }
}

export function createDesk(d: DeskDeps = {}): TgDeskPort {
  const reads = d.reads ?? LIVE_READS;
  const render = d.render ?? renderPng;
  const sayable = d.sayable ?? GROUP_SAYABLE;
  const memo = new Map<string, { until: number; value: TgDeskOutcome }>();
  const pending = new Map<string, { job: Promise<TgDeskOutcome>; partial?: TgDeskOutcome }>();
  const port: TgDeskPort = {
    look(ask, options) {
      const k = keyOf(ask);
      const hit = memo.get(k);
      if (hit && hit.until > reads.now()) return Promise.resolve(hit.value);
      const inFlight = pending.get(k);
      if (inFlight) {
        // Sharing work never means sharing another caller's longer deadline.
        // The pool floor is an immutable snapshot, not a late-send callback.
        const timeout = unavailable();
        return new DeskBudget(options?.timeoutMs).run(() => inFlight.job, timeout)
          .then((value) => value === timeout ? inFlight.partial ?? timeout : value);
      }
      if (lookupTimeout(options?.timeoutMs) < 1) return Promise.resolve(unavailable());
      const entry: { job: Promise<TgDeskOutcome>; partial?: TgDeskOutcome } = { job: Promise.resolve(unavailable()) };
      const job = lookOnce(ask, reads, render, sayable, options, (value) => { entry.partial = value; })
        .then((value) => {
          if (memo.size >= 64) memo.delete(memo.keys().next().value!);
          // A miss is remembered briefly: "not found" should not be re-searched
          // by every repeat of the same typo, nor pinned for a coin listed a
          // minute from now.
          memo.set(k, { until: value.ok ? Math.min(reads.now() + MEMO_MS, value.evidence.observedAtMs + MEMO_MS) : reads.now() + 15_000, value });
          return value;
        })
        .finally(() => { if (pending.get(k) === entry) pending.delete(k); });
      entry.job = job;
      pending.set(k, entry);
      return job;
    },
  };
  const brain = d.brain;
  if (brain && brain.url && brain.token) {
    port.think = (req: TgDeskThinkRequest, options): Promise<TgDeskThought | null> => {
      const timeoutMs = Math.floor(Math.min(brain.timeoutMs ?? 18_000, options?.timeoutMs ?? 18_000));
      return timeoutMs > 0 && Number.isFinite(timeoutMs) ? askBrainDesk({ ...brain, timeoutMs }, req) : Promise.resolve(null);
    };
  }
  return port;
}
