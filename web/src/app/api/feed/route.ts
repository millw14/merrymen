/**
 * Agent history for the dashboard: events + equity series, read from the
 * shared SQLite file the worker writes (.data/merrymen.db).
 */

import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { homePaths } from "@merrymen/home";
import { isHostedMode, sameBookAsLatest } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";
import { getIdentityStore } from "@merrymen/identity-store";
import { tenantOf } from "@/lib/auth";
import { withReadDb, fmtEpoch } from "@/lib/ledger";
import { readDeskPositions } from "@/lib/desk-positions";
import { readOwnerTape, readRunEpoch } from "@/lib/desk-trades";
import { hostedAgentFor } from "@/lib/agent-for";
import { identityOf as identityFrom, type FeedIdentity, type IdentitySources } from "@/lib/feed-identity";
import { readMeasuredMark } from "@/lib/held-marks";
import type { FeedMeasured } from "@/lib/feed-pnl";

/**
 * Where identity is read from on this deploy — see lib/feed-identity.ts for
 * what is read and why. Hosted, a tenant's settings live in the sealed
 * per-tenant store and never in this container's file.
 */
const IDENTITY_SOURCES: IdentitySources = {
  hosted: isHostedMode,
  settingsOf: (tenant) => getSettingsStore().get(tenant),
  settingsFile: () => readFileSync(homePaths.settings(), "utf8"),
  slugOf: async (tenant) => (await getIdentityStore().get(tenant))?.slug ?? null,
};

/** Name (and where it came from) + slug + strategy + basket, for this tenant. */
const identityOf = (fromLedger: string | null, tenant: `0x${string}` | null) =>
  identityFrom(fromLedger, tenant, IDENTITY_SOURCES);

export const dynamic = "force-dynamic";

export interface FeedEvent {
  level: "ok" | "warn" | "err";
  message: string;
  created_at: string;
}
export interface EquityPoint {
  cash_usdg: number;
  vault_usdg: number;
  equity_usdg: number;
  at: string;
}
export interface PositionRow {
  symbol: string;
  raw_balance: string;
  ui_multiplier: string;
  price_usd: number;
  price_stale: number;
  /**
   * 'chainlink' or 'pool'. A pool price is a Uniswap TWAP that passed the depth
   * and divergence guards — trustworthy enough to act on, but a thinner claim
   * than an external feed, and the UI says so rather than blurring them.
   */
  price_source: string;
  value_usdg: number;
  /**
   * What this holding cost, in WHOLE USDG like every other `_usdg` field here.
   *
   * The column behind it is not: `cost_basis.cost_usdg` is a decimal string of
   * the worker's micro-USDG bigint, so it is converted at this boundary rather
   * than in each browser that reads it — see `basisUsdg`. Sent raw it reads as a
   * position that cost $8,332,500 and is now worth $8.32.
   *
   * NULL when the ledger has no basis for it — never 0, which would say the
   * position was free and make the whole mark look like profit. It is here
   * because the chat sends positions to the model, and an agent asked "what did
   * NVDA cost you" with no basis on the row can only say it does not know —
   * which is what one did, while the panel beside it listed the position.
   */
  cost_usdg?: number | null;
  /**
   * Whether a fill booked from the pre-trade quote, not its receipt, may still
   * be in `cost_usdg`. False only when the fills were replayed and said so; null
   * when they could not be (see lib/desk-positions.ts). The desk shows no % on
   * a cost it cannot vouch for.
   */
  cost_from_quote?: boolean | null;
  /**
   * THIS POSITION'S OWN STOP, in bps below cost, graded when it was opened.
   *
   * NULL for a holding that carries no grade — one opened before grading
   * existed, or one whose grade could not be made — and those fall back to the
   * owner's single setting, which is what the whole book used to do. It travels
   * because the agent is asked "what would make you sell" about a SPECIFIC
   * holding, and until now it could only answer about the book.
   */
  stop_floor_bps?: number | null;
  /** The sentence that level was graded for, written at entry. */
  stop_floor_why?: string | null;
}
export interface TradeRecord {
  kind: string;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  tx_hash: string | null;
  status: "landed" | "reverted" | "rejected" | "paper";
  reject_rule: string | null;
  sim_quote_out: string | null;
  sim_min_out: string | null;
  sim_fee_tier: number | null;
  sim_gas: string | null;
  created_at: string;
  /** What the ledger knows the trade WAS — see lib/desk-trades.ts. Absent on an older ledger. */
  fill_side?: string | null;
  symbol?: string | null;
  display_name?: string | null;
  action?: string | null;
  reason?: string | null;
  realized_pnl_usdg?: number | null;
}
export interface AgentFinancials {
  hwm_usdg: number;
  accrued_fee_usdg: number;
}
/** Live identity: the user-given name (soul, mirrored into the agents table by
 * the worker) + the strategy/basket actually configured in settings.json, and
 * where the name was read from. See lib/feed-identity.ts. */
export type AgentIdentity = FeedIdentity;
export interface FeedResponse {
  source: "sqlite" | "none";
  events: FeedEvent[];
  equity: EquityPoint[];
  positions: PositionRow[];
  trades: TradeRecord[];
  financials: AgentFinancials | null;
  agent: AgentIdentity | null;
  /**
   * Capital the owner put in, less what they took out. Subtract it from equity
   * to get P&L. Without it the dashboard's headline counts a deposit as a gain,
   * which is exactly what it did until 2026-08-26.
   *
   * NULL when nothing is on record, which is NOT zero: a ledger written before
   * flow tracking knows nothing about what was put in, and equity minus zero is
   * the bankroll presented as profit. Show no P&L rather than a wrong one.
   */
  netContributionsUsdg: number | null;
  /**
   * WHAT A RETURN IS MEASURED AT (lib/feed-pnl.ts): the newest mark of the
   * `equity` book NOT taken while flow inference was held, and the net
   * contributions booked at or before it. `equity` keeps held marks — they are
   * the book's value — but one can carry a top-up or withdrawal the flows
   * table has not booked yet, and a return over it calls the owner's own cash
   * profit or loss for as long as the hold lasts. Null when that book has no
   * measured mark yet.
   */
  measured: FeedMeasured | null;
  /**
   * Gas paid in USDG, and how many landed trades' gas could NOT be priced.
   * P&L is equity − contributions − gas; the count is what says whether that is
   * the full gas cost or only the priceable part.
   */
  gasUsdg: number;
  gasUnpricedTrades: number;
  /** Fills that actually landed. Zero means there is no return to measure. */
  landed: number;
  /** The worker's verdict on the denominator: true, false, or null for never assessed. */
  contributionsKnown: boolean | null;
}

/**
 * The empty feed — no ledger, no session, or an unreadable db. Never a leak.
 *
 * Takes the tenant because identity resolves per-tenant now: a signed-in owner
 * whose ledger has no rows yet should still see the name and strategy THEY
 * configured, not the house defaults.
 */
async function emptyFeed(tenant: `0x${string}` | null = null): Promise<FeedResponse> {
  return {
    source: "none",
    events: [],
    equity: [],
    positions: [],
    trades: [],
    financials: null,
    // Identity still resolves live from settings. No ledger name was read, so
    // an unconfigured name here is a fallback and says so.
    agent: await identityOf(null, tenant),
    netContributionsUsdg: null,
    measured: null,
    gasUsdg: 0,
    gasUnpricedTrades: 0,
    landed: 0,
    contributionsKnown: null,
  };
}

export async function GET(req: Request) {
  // HOSTED: the tenant is the SIWE-authenticated wallet, resolved up front. No
  // session → nothing to show. The feed must scope to THIS tenant's agent, never
  // the global "armed or newest" heuristic below (which on a shared ledger is
  // whichever tenant is armed across the whole fleet).
  let tenant: `0x${string}` | null = null;
  // THE TENANT IS NOT THE AGENT, and the grant store is the only index that
  // maps one to the other. Resolved here rather than in SQL, because the query
  // this replaced — `WHERE LOWER(owner_address) = <tenant>` — could never match:
  // hosted, `owner_address` is the owner key the BROWSER generated, so it is
  // never the tenant. It failed closed, and an empty tape is indistinguishable
  // from a quiet agent.
  let hostedAgentId: `0x${string}` | null = null;
  if (isHostedMode()) {
    tenant = tenantOf(req);
    // No session: nothing to scope to, so no per-tenant identity either.
    if (!tenant) return NextResponse.json(await emptyFeed(null));
    hostedAgentId = await hostedAgentFor(req);
  }

  // Reads go through the ledger driver: read-only sqlite (self-hosted) or the
  // shared Postgres a worker child wrote (hosted). A missing/locked db → null →
  // an empty feed, never a 500. The SQL below is dialect-neutral: no
  // datetime('unixepoch') (timestamps are raw epoch, formatted by fmtEpoch) and
  // no rowid (the tie-break is smart_account, which both backends have).
  return withReadDb(async (db) => {
    if (!db) return NextResponse.json(await emptyFeed(tenant));
    let events: FeedEvent[] = [];
    let equity: EquityPoint[] = [];
    /** "paper" | "live" | null — the book the newest equity mark belongs to. */
    let bookMode: string | null = null;
    let positions: PositionRow[] = [];
    let trades: TradeRecord[] = [];
    let financials: AgentFinancials | null = null;
    // The ledger's name, or null until it is read — see resolveAgentName.
    let name: string | null = null;
    let netContributionsUsdg: number | null = null;
    let measured: FeedMeasured | null = null;
    let gasUsdg = 0;
    let gasUnpricedTrades = 0;
    // WHOSE numbers these are. Re-granting mints a new smart account and leaves
    // the old one's rows in the same tables, and every query below used to read
    // the lot — so two agents' equity curves interleaved and the dashboard's
    // P&L spanned both. Armed wins, else the newest.
    //
    // HOSTED scopes to the tenant's OWN account, never the global heuristic: on a
    // shared ledger "armed or newest across the fleet" is some other customer's
    // book. Resolved above, through the grant store.
    let agentId: string | null = null;
    if (tenant) {
      agentId = hostedAgentId;
    } else {
      try {
        const row = (await db
          .prepare(
            // The tie-break: `status` DEFAULTs to 'armed' so it discriminates
            // less than it looks, and created_at is whole seconds. smart_account
            // is the final deterministic key (there is no cross-dialect rowid).
            `SELECT smart_account FROM agents
              ORDER BY (status = 'armed') DESC, created_at DESC, smart_account DESC LIMIT 1`,
          )
          .get()) as { smart_account: string } | undefined;
        agentId = row?.smart_account ?? null;
      } catch {
        /* no agents table yet */
      }
    }
    // Every query is scoped to that agent. A ledger with no agent row at all
    // (an un-armed first run) has nothing to report anyway.
    const scope = agentId ?? "";
    // …and to the current RUN of that agent. Everything written before the
    // accounting was fixed stays epoch 1: no flow records, fills booked off a
    // slippage floor rather than a receipt, and an equity curve that can hold a
    // phantom crater from a failed balance read. The first arm after the fix
    // opens epoch 2. Charting the two together draws a cliff that never
    // happened — a 200 USDG live book after a 1,000 USDG paper one reads as an
    // 80% collapse — and every derived figure inherits it. Epoch 1 is kept for
    // forensics and never mixed into a number anyone is shown.
    //
    // A CLAUSE, not a constant: this app can be running against a database an
    // older worker wrote, where `epoch` does not exist. Referencing a missing
    // column throws at query time, and the surrounding catch would blank the
    // whole panel — strictly worse than showing a pre-epoch ledger unfiltered,
    // since every row in one is epoch 1 by definition.
    const epoch = await readRunEpoch(db, scope);
    const epochWhere = epoch === null ? "" : " AND epoch = ?";
    const epochArg: number[] = epoch === null ? [] : [epoch];
    // `events` and `positions` are deliberately NOT epoch-filtered below:
    // neither table has the column, so agent scoping is all they support.
    try {
      const rows = (await db
        .prepare(
          `SELECT level, message, created_at
           FROM events WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 40`,
        )
        .all(scope)) as { level: FeedEvent["level"]; message: string; created_at: number }[];
      events = rows.map((r) => ({ level: r.level, message: r.message, created_at: fmtEpoch(r.created_at) }));
    } catch {
      /* table not created yet */
    }
    try {
      /**
       * ENOUGH ROWS TO REACH BACK A DAY, WHATEVER THE CADENCE.
       *
       * This was 288, which is twenty-four hours only if a row lands every
       * five minutes. Production ticks every 240s (MERRYMEN_TICK_SECONDS), so
       * 288 rows spans 19.2 hours — and `chg24` needs a point at or before
       * twenty-four hours ago (terminal/live.ts, equityDayAgo). It never
       * found one. "Daily change unavailable" on a working, funded account was
       * not the agent being new: the window the browser was handed could not
       * reach that far, and the honest label made a window bug look like an
       * honest silence, which is the most expensive kind of correct.
       *
       * 900 rows is 60 hours at the production cadence and 75 at the default
       * one, so the daily figure survives a slower tick, a gap in the series,
       * and the fail-closed paths that skip an equity row entirely.
       */
      const rows = (await db
        .prepare(
          `SELECT cash_usdg, vault_usdg, equity_usdg, at, mode
           FROM (SELECT * FROM equity WHERE agent_id = ?${epochWhere} ORDER BY at DESC, id DESC LIMIT 900)
           ORDER BY at ASC, id ASC`,
        )
        .all(scope, ...epochArg)) as {
        cash_usdg: number;
        vault_usdg: number;
        equity_usdg: number;
        at: number;
        mode: string | null;
      }[];
      // ONE SERIES, ONE BOOK. The paper book opens at 1,000 USDG and the funded
      // one holds what the owner sent, and both write here — so an agent that
      // practised and then went live had a curve that stepped between two
      // different books, and `chg24` read the step as a day's performance. An
      // owner was shown "−$950.17 today" for a book down 2.7 cents.
      // WHICH BOOK THE WORKER ACTUALLY RAN, from the mark it wrote — not from
      // what settings say it should be doing. The two disagree for a tick after
      // an owner flips the switch, and the cost basis below is keyed on it.
      bookMode = rows.length ? (rows[rows.length - 1]!.mode ?? null) : null;
      equity = sameBookAsLatest(rows).map((r) => ({
        cash_usdg: r.cash_usdg,
        vault_usdg: r.vault_usdg,
        equity_usdg: r.equity_usdg,
        at: fmtEpoch(r.at),
      }));
    } catch {
      /* table not created yet */
    }
    try {
      // What each holding is worth, what it cost, the stop it was graded and
      // whether that cost can be vouched for — see lib/desk-positions.ts.
      positions = await readDeskPositions(db, scope, bookMode === "paper" ? "paper" : "live");
    } catch {
      /* table not created yet */
    }
    // One row per operation, with the side, the coin and the decision's
    // reason, inside a window as well as a limit — and beside it the count of
    // what landed. See lib/desk-trades.ts.
    const tape = await readOwnerTape(db, scope, epoch, Math.floor(Date.now() / 1000));
    trades = (tape.trades ?? []).map((r) => ({
      ...r,
      status: r.status as TradeRecord["status"],
      created_at: fmtEpoch(r.created_at),
    }));
    try {
      const row = (await db
        .prepare(
          // SCOPED, and with the SAME tie-break the agent resolution above
          // uses. This read was neither: it took the newest row by created_at
          // alone, so on a re-grant the name and high-water mark shown could
          // belong to a different agent than every other number on the page —
          // and the HWM is what the drawdown breaker and the fee accrual are
          // measured against.
          `SELECT name, hwm_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?`,
        )
        .get(scope)) as ({ name: string } & AgentFinancials) | undefined;
      if (row) {
        financials = { hwm_usdg: row.hwm_usdg, accrued_fee_usdg: row.accrued_fee_usdg };
        if (typeof row.name === "string" && row.name) name = row.name;
      }
    } catch {
      /* columns not migrated yet */
    }
    try {
      const row = (await db
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
             FROM flows WHERE agent_id = ?${epochWhere}`,
        )
        .get(scope, ...epochArg)) as { n: number; net: number } | undefined;
      netContributionsUsdg = !row || row.n === 0 ? null : row.net;
    } catch {
      /* flows arrives with a worker migration — null, never zero */
    }
    try {
      // The return's pair: the newest measured mark and what was booked by it.
      // Read on its own, not off the tail of `equity`: a dropped op holds for
      // 26 hours, and 900 rows is not always that far back.
      const m = await readMeasuredMark(db, scope, epoch);
      if (m) {
        const row = (await db
          .prepare(
            `SELECT COUNT(*) AS n,
                    COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
               FROM flows WHERE agent_id = ?${epochWhere} AND at <= ?`,
          )
          .get(scope, ...epochArg, m.at)) as { n: number; net: number } | undefined;
        measured = { equityUsdg: m.equity, at: fmtEpoch(m.at), netContributionsUsdg: !row || row.n === 0 ? null : row.net };
      }
    } catch {
      /* no equity or flows table yet: nothing measured, and the page says so */
    }
    try {
      const row = (await db
        .prepare(
          `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                  SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
             FROM trades WHERE agent_id = ?${epochWhere} AND status = 'landed'`,
        )
        .get(scope, ...epochArg)) as { usdg: number; unpriced: number | null } | undefined;
      gasUsdg = row?.usdg ?? 0;
      gasUnpricedTrades = row?.unpriced ?? 0;
    } catch {
      /* gas_usdg arrives with a worker migration */
    }
    // WHAT THE BOOK MAY CLAIM, carried to the one page the owner reads.
    //
    // The /you dashboard computed its own P&L inline with no landed-trade guard
    // and no quality term — a fifth independent copy of the formula. It needs
    // both of these to route through the shared gate instead.
    // An older ledger that cannot count it reads 0, which the gate treats as
    // nothing to measure.
    const landed = tape.landed ?? 0;
    let contributionsKnown: boolean | null = null;
    try {
      const row = (await db
        .prepare("SELECT contributions_known FROM agents WHERE smart_account = ?")
        .get(scope)) as { contributions_known: number | null } | undefined;
      contributionsKnown =
        row?.contributions_known === null || row?.contributions_known === undefined
          ? null
          : Number(row.contributions_known) === 1;
    } catch {
      /* the column arrives with a worker migration; unknown until it does */
    }
    return NextResponse.json({
      source: "sqlite",
      events,
      equity,
      positions,
      trades,
      financials,
      agent: await identityOf(name, tenant),
      netContributionsUsdg,
      measured,
      gasUsdg,
      gasUnpricedTrades,
      landed,
      contributionsKnown,
    } satisfies FeedResponse);
  });
}
