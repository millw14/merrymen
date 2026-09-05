/**
 * Agent history for the dashboard: events + equity series, read from the
 * shared SQLite file the worker writes (.data/merrymen.db).
 */

import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { homePaths } from "@merrymen/home";
import { SETTINGS_DEFAULTS, isHostedMode, type MerrymenSettings } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";
import { tenantOf } from "@/lib/auth";
import { withReadDb, fmtEpoch } from "@/lib/ledger";
import { hostedAgentFor } from "@/lib/agent-for";

// The basket the WORKER actually defaults to when none is configured.
// TRADEABLE_SYMBOLS (14) was the registry of what CAN be traded, not the
// default holding — so a tenant on defaults was shown 14 symbols while their
// agent traded three.
const DEFAULT_BASKET = [...SETTINGS_DEFAULTS.basketSymbols];

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
}
export interface AgentFinancials {
  hwm_usdg: number;
  accrued_fee_usdg: number;
}
/** Live identity: the user-given name (soul, mirrored into the agents table by
 * the worker) + the strategy/basket actually configured in settings.json. */
export interface AgentIdentity {
  name: string;
  strategy: string;
  basket: string[];
}
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

type Identity = { strategy: string; basket: string[]; agentName: string | null };

const IDENTITY_FALLBACK: Identity = { strategy: "steady-basket", basket: DEFAULT_BASKET, agentName: null };

/** The three identity fields out of a settings blob, whatever store it came from. */
function pickIdentity(s: MerrymenSettings): Identity {
  return {
    strategy: typeof s.strategy === "string" && s.strategy ? s.strategy : "steady-basket",
    basket: Array.isArray(s.basketSymbols) && s.basketSymbols.length ? s.basketSymbols : DEFAULT_BASKET,
    agentName: typeof s.agentName === "string" && s.agentName ? s.agentName : null,
  };
}

/**
 * The configured strategy, basket and name — from WHERE THIS TENANT'S SETTINGS
 * ACTUALLY LIVE.
 *
 * THE BUG THIS EXISTS TO FIX, because it made a working feature look broken.
 * Hosted, a tenant's settings are written to the per-tenant sealed store
 * (`getSettingsStore().put(tenant, …)` in api/settings), and NOTHING ever writes
 * the web container's own `~/.merrymen/settings.json`. This function used to
 * read that file unconditionally, so on the hosted deploy the read always threw
 * and every tenant got the fallback below: name null → the console fell back to
 * the ledger's "Robin", and strategy/basket were the defaults no matter what
 * they had configured. An owner could rename their agent, watch the save
 * succeed, reload, and be asked to name it again — four times over, in the
 * report that found this. The write was never the problem; nobody read it back.
 *
 * Self-hosted the file IS the store, which is why this passed local testing.
 * The `!tenant` early return is load-bearing: it must not fall through to the
 * file read, or a signed-out caller would be shown container-global config.
 */
async function readIdentitySettings(tenant: `0x${string}` | null): Promise<Identity> {
  if (isHostedMode()) {
    if (!tenant) return IDENTITY_FALLBACK;
    try {
      return pickIdentity((await getSettingsStore().get(tenant)) ?? {});
    } catch {
      return IDENTITY_FALLBACK;
    }
  }
  try {
    // BOM-strip: hand-edited or PowerShell-written files may carry a UTF-8 BOM.
    const raw = readFileSync(homePaths.settings(), "utf8").replace(/^﻿/, "");
    return pickIdentity(JSON.parse(raw) as MerrymenSettings);
  } catch {
    return IDENTITY_FALLBACK;
  }
}

/**
 * The agent's name: what the owner CONFIGURED, else what the ledger recorded.
 *
 * The two can disagree for a while, and the settings value has to win. The
 * worker reconciles a configured name into the soul at arm time, so between
 * saving one and the worker's next arm the ledger still holds the old name —
 * and preferring the ledger there makes a rename that genuinely succeeded
 * revert to "Robin" on the next page load, which reads exactly like a failed
 * save. Settings is where the owner's intent lives; the soul is the runtime
 * seat that catches up to it.
 */
function resolveAgentName(configured: string | null, fromLedger: string): string {
  return configured || fromLedger;
}

/** Name + strategy + basket, with the configured name preferred. */
async function identityOf(fromLedger: string, tenant: `0x${string}` | null): Promise<AgentIdentity> {
  const { agentName, ...rest } = await readIdentitySettings(tenant);
  return { name: resolveAgentName(agentName, fromLedger), ...rest };
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
    // Identity still resolves live from settings + default name.
    agent: await identityOf("Robin", tenant),
    netContributionsUsdg: null,
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
    let positions: PositionRow[] = [];
    let trades: TradeRecord[] = [];
    let financials: AgentFinancials | null = null;
    let name = "Robin";
    let netContributionsUsdg: number | null = null;
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
    let epochWhere = "";
    let epochArg: number[] = [];
    try {
      const erow = (await db
        .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
        .get(scope)) as { epoch: number } | undefined;
      epochWhere = " AND epoch = ?";
      epochArg = [erow?.epoch ?? 1];
    } catch {
      /* epoch arrives with a worker migration — leave every row visible */
    }
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
      const rows = (await db
        .prepare(
          `SELECT cash_usdg, vault_usdg, equity_usdg, at
           FROM (SELECT * FROM equity WHERE agent_id = ?${epochWhere} ORDER BY at DESC, id DESC LIMIT 288)
           ORDER BY at ASC, id ASC`,
        )
        .all(scope, ...epochArg)) as { cash_usdg: number; vault_usdg: number; equity_usdg: number; at: number }[];
      equity = rows.map((r) => ({
        cash_usdg: r.cash_usdg,
        vault_usdg: r.vault_usdg,
        equity_usdg: r.equity_usdg,
        at: fmtEpoch(r.at),
      }));
    } catch {
      /* table not created yet */
    }
    try {
      positions = (await db
        .prepare(
          `SELECT symbol, raw_balance, ui_multiplier, price_usd, price_stale,
                  price_source, value_usdg
           FROM positions WHERE agent_id = ? ORDER BY value_usdg DESC`,
        )
        .all(scope)) as unknown as PositionRow[];
    } catch {
      // price_source arrives with a worker migration. The dashboard can be
      // running against a database the upgraded worker hasn't opened yet, and
      // losing the whole positions panel over a label would be a worse bug than
      // the missing label — so fall back to the shape that always existed.
      try {
        const legacy = (await db
          .prepare(
            `SELECT symbol, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg
             FROM positions WHERE agent_id = ? ORDER BY value_usdg DESC`,
          )
          .all(scope)) as unknown as Omit<PositionRow, "price_source">[];
        positions = legacy.map((p) => ({ ...p, price_source: "chainlink" }));
      } catch {
        /* table not created yet */
      }
    }
    try {
      const rows = (await db
        .prepare(
          `SELECT kind, sell_token, buy_token, amount_usdg, tx_hash, status, reject_rule,
                  sim_quote_out, sim_min_out, sim_fee_tier, sim_gas, created_at
           FROM trades WHERE agent_id = ?${epochWhere} ORDER BY created_at DESC, id DESC LIMIT 30`,
        )
        .all(scope, ...epochArg)) as (Omit<TradeRecord, "created_at"> & { created_at: number })[];
      trades = rows.map((r) => ({ ...r, created_at: fmtEpoch(r.created_at) }));
    } catch {
      /* table not created yet */
    }
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
    let landed = 0;
    let contributionsKnown: boolean | null = null;
    try {
      const row = (await db
        .prepare(
          `SELECT SUM(CASE WHEN status = 'landed' THEN 1 ELSE 0 END) AS landed
             FROM trades WHERE agent_id = ?${epochWhere}`,
        )
        .get(scope, ...epochArg)) as { landed: number | null } | undefined;
      landed = Number(row?.landed ?? 0);
    } catch {
      /* older ledger */
    }
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
      gasUsdg,
      gasUnpricedTrades,
      landed,
      contributionsKnown,
    } satisfies FeedResponse);
  });
}
