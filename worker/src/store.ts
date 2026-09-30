/**
 * Trade/event/equity persistence — SQLite (node:sqlite, built into Node 22+).
 * One durable file at .data/merrymen.db shared by worker (writer) and web
 * (reader via /api/feed). No external service, no keys. Migration path to
 * Postgres is a schema port when the platform goes multi-user.
 */

import { RISK_PERIOD_SCHEMA, mergeRiskPeriod, markRiskPeriod, adjustRiskCapital, type RiskPeriod } from "./risk-period";
import {
  ENERGY_DAYS_ALTERS,
  ENERGY_DAYS_SCHEMA,
  claimEnergyDay,
  claimEnergyNoticeDay,
  lastEnergyReadDay,
  noteEnergyReadDay,
  readEnergyDay,
  refundEnergyDay,
  type EnergyField,
} from "./energy-days";
import type { EnergyCounters, LastGood } from "./energy";
import { energyDayUnrestored } from "./energy-seed";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { StoredGrant } from "../../packages/core/src/index";
import {
  CASH,
  ENERGY_RESERVE_TOKENS,
  PERP_COI_MAX,
  PERP_LEG,
  officialCoinCurve,
  officialCoinsFor,
  perpCoi,
  perpMarketById,
  robinhoodChain,
} from "../../packages/core/src/index";
import type { PerpSide } from "../../packages/core/src/index";
// The perp ledger's vocabulary and which way each status may move — shared
// with ledger-mirror.ts and paper-checkpoint.ts so the three cannot disagree.
import {
  PERP_ATTRIBUTIONS,
  PERP_LEG_RANK,
  PERP_LEG_ROLES,
  PERP_LEG_STATUSES,
  PERP_OPS_ORDER_STATUSES,
  PERP_OPS_WITHDRAW_STATES,
  PERP_ORDER_RANK,
  PERP_ORDER_TERMINAL,
  PERP_TRADE_TYPES,
  PERP_TRANSFER_DIRECTIONS,
  PERP_TRANSFER_INITIATORS,
  PERP_TRANSFER_RANK,
  PERP_TRANSFER_STATES,
  PERP_UNRESOLVED_ORDER_STATUSES,
  intText,
  isPerpLegRole,
  isPerpLegStatus,
  isPerpMode,
  isPerpOrderEffect,
  isPerpOrderStatus,
  perpTransferMovesMoney,
  perpTransferStateFits,
  textInt,
  type PerpAttribution,
  type PerpLegRole,
  type PerpLegStatus,
  type PerpMode,
  type PerpOrderEffect,
  type PerpOrderStatus,
  type PerpTradeType,
  type PerpTransferDirection,
  type PerpTransferInitiator,
  type PerpTransferState,
} from "./perp-ledger-rules";
import { ensureHome, homePaths, merrymenHome } from "./home";
import { wrapSqlite, makePgDb, type Db } from "./db";
import { paperBrainCapital } from "./paper-brain-capital";
export const getPaperBrainCapital = (agentId: string, epoch: number) => paperBrainCapital(getDb(), agentId, epoch);
import { readDecisionLifecycle, type DecisionLifecycle } from "./decision-lifecycle";
export type { DecisionLifecycle } from "./decision-lifecycle";
// The one definition of a flow's identity. Imported rather than restated so
// the reader and the writer cannot disagree about what makes a flow unique.
import { flowKey } from "./deposit-log";
// The paper/live boundary. A rule rather than a convention, enforced at the one
// function every flow writer passes through — see addFlow.
import { admitCapitalFlow, tradingModeOf, type TradingMode } from "./paper-boundary";
// Which coin ids need a name beside them — the publication module's rule, so
// the writer and the feed reader look up names for the same set.
import { DERIVED_ID } from "./thesis-policy";
// The coin's name a fill is stored with — see fillSymbolOfRow.
import { fillSymbolFor, nonCashLeg } from "./token-label";

let driver: Db | null = null;
/** The sqlite handle behind `driver`. Kept ONLY so closeStoreForTest() can release
 *  the file; a running worker never closes its ledger. */
let ledgerFile: DatabaseSync | null = null;

/**
 * The schema, written once in the sqlite dialect — the single source of truth for
 * BOTH backends. Self-hosted runs it verbatim on node:sqlite; the hosted Postgres
 * path runs it through db.ts's translateSchema(). Keeping ONE string, rather than a
 * hand-maintained parallel Postgres DDL, is what stops the two dialects drifting.
 */

export const restoreRiskPeriod = (r: RiskPeriod) => mergeRiskPeriod(getDb(), r);
export const getRiskPeriodPeak = (account: string, equity: number | null = null) => markRiskPeriod(getDb(), account, equity);

const SQLITE_SCHEMA = `
    ${RISK_PERIOD_SCHEMA};
    ${ENERGY_DAYS_SCHEMA};
    /* agent_id (= smart_account here) threads EVERY per-agent table: trades,
       decisions, positions, cost_basis, equity, fee_accruals. On the EVM rail
       it is the ERC-4337 smart-account address; on the broker rail it is the
       namespaced "rh:<account_number>" from venues/robinhood-id.ts — the
       prefix exists so the two id spaces can never collide, and a broker row
       can never key into an on-chain agent's basis, HWM, or fee ledger. */
    CREATE TABLE IF NOT EXISTS agents (
      smart_account TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Robin',
      owner_address TEXT NOT NULL,
      session_key_address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      caps TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'armed',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'ok',
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS events_agent_time ON events (agent_id, created_at DESC);
    -- WHAT AN AGENT SAID ABOUT A TRADE, IN ITS OWN WORDS.
    --
    -- WHY THIS IS NOT A COLUMN ON decisions. It ought to be one and it cannot
    -- be. A decision row is written when the intent is built; the post only
    -- once the fill has LANDED, several steps later, because an agent
    -- narrating a trade the wall then turned back is worse than one that says
    -- nothing. So the post arrives after its decision row -- and
    -- ledger-mirror.ts copies decisions with ON CONFLICT (id) DO NOTHING,
    -- alone among its tables and deliberately, so a decision reaches shared
    -- storage exactly as first written. Anything filled in afterwards is
    -- dropped on the floor, silently: the row is already there. A social_text
    -- column would have passed every test against a child sqlite and published
    -- NOTHING in production -- the same shape of bug as the one this table
    -- exists to fix. An append-only row is inserted ONCE and needs no update
    -- semantics anywhere.
    --
    -- decision_id IS UNIQUE, and that is the idempotence: a retry after a
    -- crash, or two arms racing one fill, produce a single post. An agent that
    -- said the same thing twice about one trade would read as a bot, which is
    -- precisely what this feature exists to stop it sounding like.
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      decision_id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS posts_agent_time ON posts (agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      sell_token TEXT,
      buy_token TEXT,
      amount_usdg REAL NOT NULL,
      user_op_hash TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL,
      reject_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS trades_agent_time ON trades (agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS equity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      eth_wei TEXT NOT NULL,
      cash_usdg REAL NOT NULL,
      vault_usdg REAL NOT NULL,
      equity_usdg REAL NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS equity_agent_time ON equity (agent_id, at DESC);
    CREATE TABLE IF NOT EXISTS fee_accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      profit_usdg REAL NOT NULL,
      fee_usdg REAL NOT NULL,
      hwm_before_usdg REAL NOT NULL,
      hwm_after_usdg REAL NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS fee_accruals_agent_time ON fee_accruals (agent_id, at DESC);
    -- Money crossing the account's boundary: the owner funding it, or taking
    -- money back out. NOT trades, and NOT vault moves (those are equity-neutral
    -- shuffles inside the wall).
    --
    -- Without this table equity is a bare balance reading with no flow term, so
    -- a deposit is arithmetically indistinguishable from a gain: /pnl reported
    -- +999.48 on a book that was down 0.52, and the performance fee charged the
    -- owner on their own principal. Every performance figure is now measured
    -- against (equity - netContributions) instead of against equity.
    --
    -- 'source' records HOW we know, in the same spirit as trades.basis_source
    -- and positions.price_source. The three are not equally good evidence:
    --   'chain-log'       a Transfer log naming this account. Exact, has a tx.
    --   'transfer-intent' our own outbound transfer. Exact, has a tx.
    --   'energy-buy'      USDG the agent spent buying its energy reserve INTO
    --                     its own account: capital leaving the trading BOOK
    --                     while staying in the account (the reserve is never a
    --                     position and never in equity, like ETH gas). Read off
    --                     the settled receipt's USDG log, so exact, with a tx
    --                     and log index — booked only by bookCapitalFlow, with
    --                     both peaks in the same transaction.
    --   'epoch-carry'     the closing equity of the epoch just closed, bridged
    --                     forward as the new one's opening balance. No tx, but
    --                     not guesswork either: it is a deterministic function of
    --                     a figure already in the journal, and it is CHECKABLE
    --                     against the prior epoch's final equity mark.
    --   'inferred'        a cash change no fill explains. Honest guesswork; only
    --                     ever recorded when NO trade ran in the interval, so it
    --                     cannot be confused with a fill, and it carries no tx.
    -- An audit that needs a chain-verifiable figure keeps the first two. One that
    -- needs a SUPPORTABLE figure keeps the first three; see accounting-scope.ts.
    CREATE TABLE IF NOT EXISTS flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      direction TEXT NOT NULL,       -- 'in' | 'out'
      amount_usdg REAL NOT NULL,     -- always positive; direction carries the sign
      tx_hash TEXT,                  -- null for 'inferred' and 'epoch-carry'
      block_number INTEGER,
      source TEXT NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS flows_agent_time ON flows (agent_id, at DESC);
    -- The audit record: an append-only, hash-chained mirror of every fact that
    -- moves money, written in the SAME transaction as the row it mirrors so the
    -- two cannot diverge.
    --
    -- Why it exists. The tables above are a plain sqlite file on the operator's
    -- own disk. Anyone can rewrite them with the sqlite3 CLI in ten seconds, and
    -- the equity curve is not derivable from anything else — it is a series of
    -- point-in-time balance readings written by the same process being audited.
    -- "Verifiable, not claimed" was in the README while the ledger could prove
    -- nothing to anyone.
    --
    -- What the chain buys: each entry carries the hash of the one before it, so
    -- an edited or deleted record breaks every hash after it. 'seq' is
    -- monotonic, so a DELETED record is visible as a gap — silence is as
    -- detectable as tampering. It is NOT signed: a signature proves the machine
    -- holding the key wrote it, which the chain plus the on-chain cross-check
    -- already establish, without introducing a key to manage.
    CREATE TABLE IF NOT EXISTS journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      kind TEXT NOT NULL,           -- 'fill' | 'flow' | 'mark' | 'fee'
      payload_json TEXT NOT NULL,   -- canonical JSON (sorted keys) of the fact
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,           -- sha256(prev_hash + payload_json)
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS journal_agent_epoch ON journal (agent_id, epoch, seq);
    CREATE TABLE IF NOT EXISTS positions (
      agent_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      token TEXT NOT NULL,
      raw_balance TEXT NOT NULL,
      ui_multiplier TEXT NOT NULL,
      price_usd REAL NOT NULL,
      price_stale INTEGER NOT NULL DEFAULT 0,
      value_usdg REAL NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS paper_book (
      agent_id TEXT PRIMARY KEY,
      cash_usdg REAL NOT NULL,
      vault_usdg REAL NOT NULL DEFAULT 0,
      hwm_usdg REAL NOT NULL DEFAULT 0,
      shares TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Every proposal the agent made — SURVIVING (linked to a trade via
    -- trades.decision_id) and DROPPED (dropped_rule set, no trade). This is the
    -- attribution substrate: it turns "why did you trade" from a ±15-min event
    -- guess into a real join, and is the prerequisite for learning from outcomes.
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,        -- 'strategist' | 'strategy:<name>' | 'chat' | 'selftest'
      strategy TEXT,
      provider TEXT,
      model TEXT,
      symbol TEXT,
      action TEXT,                 -- 'buy' | 'sell' | 'hold' | 'transfer' | ...
      size_usdg REAL,
      reason TEXT,                 -- the model's own words (never fed back into policy)
      dropped_rule TEXT,           -- non-null when the proposal was dropped before execution
      signals_json TEXT,           -- the inputs the decision was made on (for later review)
      evidence_json TEXT,          -- the banded fact layer behind a published post (safe to show)
      provenance TEXT,             -- WHAT KIND OF THING decided; see provenance.ts
      display_name TEXT,           -- the coin's own name, display only; see ClassEvidence.displayName
      mark_usd REAL,               -- the price the author saw when it decided; see DecisionRow.mark_usd
      mcap_usd REAL,               -- a memecoin's market cap at decision time; see DecisionRow.mcap_usd
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS decisions_agent_time ON decisions (agent_id, at DESC);
    -- A GLOBAL feed reads across every agent, so the composite above cannot serve
    -- it: its leading column is agent_id, so filtering on time alone has to scan.
    -- The public thesis page is the first reader that is not scoped to one agent.
    CREATE INDEX IF NOT EXISTS decisions_time ON decisions (at DESC);
    -- Conversation turns, so the merryman doesn't lose the thread on restart.
    -- Lives in sqlite rather than a json file because the db is already open and
    -- single-writer; a file would need its own read-modify-write and would race
    -- the notifier. Content is already truncated and HTML-stripped by the caller.
    CREATE TABLE IF NOT EXISTS chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      role TEXT NOT NULL,          -- 'user' | 'assistant'
      content TEXT NOT NULL,
      memory_ids TEXT,             -- JSON array: what was recalled for this turn
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS chat_turns_chat_time ON chat_turns (chat_id, id DESC);
    -- Weighted-average cost basis per held symbol (see basis.ts). Quantities are
    -- 18dp RAW units and cost is 6dp USDG, both as decimal strings because
    -- sqlite has no bigint — parsed straight back to BigInt on read.
    -- Basis lives per RAW unit, so ERC-8056 splits never disturb it.
    --
    -- PARTITIONED BY MODE: 'paper', 'live', 'brokerage'. Each is a different
    -- book of a different asset (simulated shares vs real tokens vs custodial
    -- shares); sharing a row would let a simulated fill price a real sell, a
    -- custodial fill price an on-chain position, or delete another book's cost.
    -- Mirrors how paper_book is already separate from on-chain balances. The
    -- brokerage book's raw unit is decided when its writer lands (step 5/6 of
    -- the adapter plan) — the column is unit-agnostic decimal strings either way.
    CREATE TABLE IF NOT EXISTS cost_basis (
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      symbol TEXT NOT NULL,
      qty_raw TEXT NOT NULL,
      cost_usdg TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, mode, symbol)
    );
    -- Pairs discovery has already told the owner about. Persisted so a restart
    -- doesn't re-announce every launch of the last hour as if it were new —
    -- a feed that cries wolf on every reboot stops being read.
    CREATE TABLE IF NOT EXISTS discovered_pools (
      address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      first_seen INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- The liquidity a trench position was ENTERED at, per (agent, mode, symbol),
    -- so a trench exit can compare against its own baseline. Read at
    -- worker/src/index.ts and written by setTrenchEntry — but this CREATE was
    -- missing entirely, so getTrenchEntry always hit "no such table", returned
    -- null through its catch, and setTrenchEntry console-errored on every fill:
    -- the trench strategy had no entry baseline at all. entry_sec is DEFAULTed
    -- because the INSERT only supplies the liquidity.
    -- HOW FAR THIS PARTICULAR POSITION MAY FALL, graded once at entry.
    --
    -- One floor swept across a whole book is the wrong shape for this one: a
    -- 12% floor under a launchpad memecoin fires on the venue rather than on
    -- the trade (p99 curve movement is 1,546bps over four minutes), and a 35%
    -- floor under a well-evidenced equity is just 35% of the owner's money.
    --
    -- STAMPED ONCE AND NEVER MOVED. The INSERT is ON CONFLICT DO NOTHING, the
    -- same device trench_positions uses and for the same reason written down
    -- there: a top-up must not quietly reset the reference to a worse price,
    -- "which would turn averaging down into a way of never stopping out". The
    -- database enforces it rather than a caller remembering to.
    --
    -- The why column is the sentence the owner reads. Stored beside the number
    -- because a level with no reason is a number nobody can argue with, and
    -- this one was graded from evidence that will not exist by the time they
    -- come to ask about it.
    --
    -- Dropped with the cost basis: see setBasis. A floor is a distance from an
    -- entry price, so a position with no entry price has nothing to be a
    -- distance from.
    CREATE TABLE IF NOT EXISTS position_floors (
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      symbol TEXT NOT NULL,
      stop_bps INTEGER NOT NULL,
      rung TEXT NOT NULL,
      why TEXT NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, mode, symbol)
    );
    CREATE TABLE IF NOT EXISTS trench_positions (
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      symbol TEXT NOT NULL,
      entry_liquidity_usd REAL NOT NULL,
      entry_sec INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, mode, symbol)
    );
`;

/**
 * THE PERP LEDGER'S SCHEMA (docs/perps.md, "Ledger"), applied as part of
 * SQLITE_ALTERS — each statement on its own, in order, each index after its
 * table. Exported so a test can run every statement through translateSchema:
 * a DDL error on Postgres is swallowed by the same catch that makes a re-run
 * a no-op, so "it translated" is something to prove, not assume.
 */
export const PERP_LEDGER_DDL: readonly string[] = [
  // ── PERPETUALS (docs/perps.md, "Ledger") ──────────────────────────────────
  //
  // THE TRADES BOUNDARY. Nothing that happens on Lighter's L2 — an order, a
  // fill, funding, a fee, an L2 withdrawal request — is a `trades` row. The
  // tape, the audit's grossBuyNotional, verify's receipt check, ledgerWrites
  // and the scoreboard all read `trades` as "an on-chain operation of ours",
  // and a Lighter hash is not one (verify would report it FAILED). Only the
  // on-chain legs — `perp-deposit`, `perp-key`, `perp-claim` — are trades
  // rows, through the UserOp rail that is already their crash safety.
  //
  // THE RULES EVERY TABLE BELOW KEEPS:
  //   money is TEXT integer micro-USDG — never REAL (a float is the rounding
  //     rule 11 forbids) and never INTEGER in a sum (Postgres INTEGER is int4
  //     and overflows at 2,147 USDG); aggregated in application BigInt.
  //   venue base and price amounts are TEXT integers in the market's own
  //     decimals, exactly as signed or read.
  //   every row carries `mode`, and every row that is history carries `epoch`.
  //   agent_id is lowercased on write — the mirror has already met an account
  //     arriving EIP-55 from one incarnation and lowercase from the next.
  //   no CHECK constraints: the mirror copies these into a shared database
  //     whose rows must never be refused for a vocabulary a newer child speaks.
  //   the vocabulary and its order live in perp-ledger-rules.ts.
  //
  // In SQLITE_ALTERS rather than SQLITE_SCHEMA so each statement runs, and
  // is swallowed if already there, on its own: the schema batch is one
  // implicit Postgres transaction that two booting services race on
  // (execSchemaBatch). Each index follows its table.
  //
  // ONE ROW PER SIGNED VENUE TX (rule 9: persist before send). Written
  // `submitted` BEFORE sendTx with the exact signed bytes — `tx_info`, which
  // carries a Schnorr signature and is therefore the one column the mirror
  // never copies — its hash, type, account, key index, nonce and the ExpiredAt
  // parsed from those bytes (ms). A failed write sends nothing. For a grouped
  // open (tx 28) the money columns describe the ENTRY leg: the SL/TP children
  // are reduce-only with base 0 and sized by the venue to the executed entry.
  //
  // `worst_notional_micro` is the entry's base × its worst price, fixed at
  // signing: what the daily cap holds against the order until its fills are
  // known (`filled_quote_micro`, NULL until then — unknown, never zero).
  // Non-order txs (leverage, cancel, withdraw) carry '0'.
  //
  // `updated_at` is what the mirror's cursor reads: an order row is rewritten
  // in place exactly once, from submitted to its outcome, and a cursor on
  // `created_at` alone would copy the `submitted` and never the answer — the
  // bug the trades resolution pass exists to patch.
  `CREATE TABLE IF NOT EXISTS perp_orders (
     id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     epoch INTEGER NOT NULL,
     account_index INTEGER,
     api_key_index INTEGER,
     nonce INTEGER,
     tx_hash TEXT,
     tx_type INTEGER,
     tx_info TEXT,
     expired_at INTEGER,
     status TEXT NOT NULL,
     effect TEXT NOT NULL,
     reduce_only INTEGER NOT NULL,
     market_id INTEGER,
     worst_notional_micro TEXT NOT NULL,
     filled_base TEXT,
     filled_quote_micro TEXT,
     decision_id TEXT,
     reason TEXT,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     resolved_at INTEGER,
     updated_at INTEGER NOT NULL DEFAULT (unixepoch())
   )`,
  // ONE NONCE, ONE ROW. The venue executes a signed nonce at most once and a
  // later one kills every earlier pending tx on the key, so two rows naming
  // one nonce would be two claims about one tx — and the second write is
  // refused here, before anything is sent. Not scoped by mode: a nonce belongs
  // to (account, key), and paper rows carry no account (NULLs are distinct).
  "CREATE UNIQUE INDEX IF NOT EXISTS perp_orders_nonce ON perp_orders (agent_id, account_index, api_key_index, nonce)",
  "CREATE INDEX IF NOT EXISTS perp_orders_budget ON perp_orders (agent_id, mode, created_at)",
  "CREATE INDEX IF NOT EXISTS perp_orders_tx ON perp_orders (agent_id, tx_hash)",
  "CREATE INDEX IF NOT EXISTS perp_orders_open ON perp_orders (agent_id, mode, status)",
  "CREATE INDEX IF NOT EXISTS perp_orders_updated ON perp_orders (updated_at)",
  // EVERY CLIENT ORDER INDEX INSIDE A SIGNED TX (entry, stop, take, close),
  // each its own row because a grouped open carries up to three and one
  // column cannot hold them. The primary key is the uniqueness rule 9 relies
  // on: COI = nonce × 8 + leg never repeats across restarts or a wiped ledger,
  // and this is where a repeat would be caught. `venue_order_index` is TEXT
  // because the venue's order ids pass 2^53.
  `CREATE TABLE IF NOT EXISTS perp_order_legs (
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     order_id TEXT NOT NULL,
     role TEXT NOT NULL,
     client_order_index INTEGER NOT NULL,
     venue_order_index TEXT,
     status TEXT NOT NULL,
     venue_status TEXT,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
     PRIMARY KEY (agent_id, mode, client_order_index)
   )`,
  "CREATE INDEX IF NOT EXISTS perp_order_legs_order ON perp_order_legs (order_id)",
  "CREATE INDEX IF NOT EXISTS perp_order_legs_updated ON perp_order_legs (updated_at)",
  // A FILL, BY THE VENUE'S OWN IDENTITY (rule 10). The trade id alone is not
  // one: a self-trade — our close hitting our own resting take-profit — is ONE
  // trade id with our account on BOTH sides, so `side_role` (ask | bid, the
  // side of the trade that was ours) completes the key and books it twice, as
  // it happened. Append-only; a re-read of the same trade inserts nothing.
  //
  // `side` is the POSITION side the fill trades — long for an opening bid AND
  // for the ask that closes that long — never "sell" (rule 15). `realized_micro`
  // is NULL until derived; `position_before` (signed base) and
  // `entry_quote_before_micro` are kept so it can be re-derived by anyone.
  // `venue_ts_ms` is the venue's trade timestamp in MILLISECONDS.
  `CREATE TABLE IF NOT EXISTS perp_fills (
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     epoch INTEGER NOT NULL,
     venue_trade_id TEXT NOT NULL,
     side_role TEXT NOT NULL,
     market_id INTEGER NOT NULL,
     side TEXT NOT NULL,
     role TEXT,
     base TEXT NOT NULL,
     price TEXT NOT NULL,
     quote_micro TEXT NOT NULL,
     fee_micro TEXT NOT NULL,
     realized_micro TEXT,
     position_before TEXT,
     entry_quote_before_micro TEXT,
     trade_type TEXT NOT NULL,
     attribution TEXT NOT NULL,
     order_id TEXT,
     venue_order_index TEXT,
     client_order_index INTEGER,
     venue_tx_hash TEXT,
     venue_ts_ms INTEGER NOT NULL,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     PRIMARY KEY (agent_id, mode, venue_trade_id, side_role)
   )`,
  "CREATE INDEX IF NOT EXISTS perp_fills_time ON perp_fills (agent_id, mode, venue_ts_ms)",
  "CREATE INDEX IF NOT EXISTS perp_fills_created ON perp_fills (created_at)",
  // A FUNDING PAYMENT, keyed by the venue's funding id AND, separately, by the
  // hour: funding is hourly, so two rows for one (market, hour) is one payment
  // booked twice — whichever id the second carries (a paper replay and a
  // venue read, say). `payment_micro` is signed: + received, − paid.
  // `funding_hour` is unix SECONDS on the hour; `rate_ppm` is the venue's
  // percent-per-hour rate as parts per million, exact.
  `CREATE TABLE IF NOT EXISTS perp_funding (
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     epoch INTEGER NOT NULL,
     market_id INTEGER NOT NULL,
     funding_id TEXT NOT NULL,
     funding_hour INTEGER NOT NULL,
     payment_micro TEXT NOT NULL,
     rate_ppm INTEGER,
     position_base TEXT,
     position_side TEXT,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     PRIMARY KEY (agent_id, mode, market_id, funding_id)
   )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS perp_funding_hour ON perp_funding (agent_id, mode, market_id, funding_hour)",
  "CREATE INDEX IF NOT EXISTS perp_funding_created ON perp_funding (created_at)",
  // MARGIN MOVING BETWEEN THE ACCOUNT AND LIGHTER — never capital (rule 12).
  // Written before it is sent, like every other venue move, including the
  // ones a stand-down or the owner's recover makes. `state` only moves forward
  // (perp-ledger-rules.ts); money is in transit while a deposit is `landed` or
  // a withdrawal `executed`, and each step that moves it is journaled `margin`
  // in the same transaction as the step.
  //
  // IDENTITY, WHERE THERE IS ONE, IS UNIQUE: the chain log that proves it
  // (chain id, tx, log index — a tx hash is only unique within a chain, and
  // this schema serves 4663 and 46630), the L2 Withdraw's venue hash, or our
  // own UserOp. `paid_tx_hash`/`paid_log_index` record which payout covered a
  // withdrawal and are NOT unique: the relayer pays a pending balance out in
  // one log, so one payout can settle several requests. `order_id` is the
  // rule-9 row of the L2 Withdraw that requested it, when there is one — the
  // link that keeps one request from counting as two ops (perpOpsSince).
  `CREATE TABLE IF NOT EXISTS perp_transfers (
     id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     epoch INTEGER NOT NULL,
     direction TEXT NOT NULL,
     amount_micro TEXT NOT NULL,
     initiator TEXT NOT NULL,
     state TEXT NOT NULL,
     chain_id INTEGER,
     tx_hash TEXT,
     log_index INTEGER,
     user_op_hash TEXT,
     venue_tx_hash TEXT,
     paid_tx_hash TEXT,
     paid_log_index INTEGER,
     order_id TEXT,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     updated_at INTEGER NOT NULL DEFAULT (unixepoch())
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS perp_transfers_chain ON perp_transfers (chain_id, agent_id, tx_hash, log_index)
     WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS perp_transfers_venue ON perp_transfers (agent_id, mode, venue_tx_hash)
     WHERE venue_tx_hash IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS perp_transfers_userop ON perp_transfers (agent_id, mode, user_op_hash)
     WHERE user_op_hash IS NOT NULL`,
  "CREATE INDEX IF NOT EXISTS perp_transfers_open ON perp_transfers (agent_id, mode, state)",
  "CREATE INDEX IF NOT EXISTS perp_transfers_updated ON perp_transfers (updated_at)",
  // THE POSITIONS: the venue-authoritative CACHE on the live rail (re-read at
  // every arm, never seeded from shared storage — the contract's "Hosted"
  // paragraph) and THE BOOK itself on paper. Never an equity input: rule 12
  // takes C, M and U from one venue snapshot, and a cache mixed with a fresh
  // read counts a close twice.
  //
  // A flat market keeps its row (`side` NULL, `base` '0'), because leverage is
  // per-(account, market) venue state that outlives a position — the paper
  // book needs its `imf_bp` and margin mode exactly as the venue keeps them.
  // Prices are the market's integer price units; `funding_hour_applied` is the
  // last hour a paper position was charged (unix seconds).
  `CREATE TABLE IF NOT EXISTS perp_positions (
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     market_id INTEGER NOT NULL,
     side TEXT,
     base TEXT NOT NULL,
     entry_price TEXT,
     allocated_margin_micro TEXT NOT NULL,
     imf_bp INTEGER,
     margin_mode TEXT,
     realized_micro TEXT,
     funding_micro TEXT,
     stop_trigger TEXT,
     stop_price TEXT,
     take_trigger TEXT,
     take_price TEXT,
     funding_hour_applied INTEGER,
     opened_at INTEGER,
     updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
     source TEXT NOT NULL,
     PRIMARY KEY (agent_id, mode, market_id)
   )`,
  // ONE ROW PER (agent, mode): the venue account index; the public key we
  // registered and every key retired from it (a retired key is never
  // registered again); the nonce HIGH-WATER — TEXT, committed BEFORE signing
  // and only ever raised (bumpNonceHighWater), so no nonce is signed twice
  // across a restart; the paper book's cross collateral (NULL on live, where
  // the venue holds it); the durable incident flag of rule 16 (`incident_json`,
  // NULL when clear) and the entries halt; and when the venue was last read,
  // with the snapshot's `transaction_time` in MICROSECONDS.
  `CREATE TABLE IF NOT EXISTS perp_accounts (
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     account_index INTEGER,
     registered_pubkey TEXT,
     retired_pubkeys TEXT NOT NULL DEFAULT '[]',
     nonce_high_water TEXT,
     paper_collateral_micro TEXT,
     incident_json TEXT,
     entries_halted INTEGER NOT NULL DEFAULT 0,
     last_venue_read_at INTEGER,
     last_snapshot_time INTEGER,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
     PRIMARY KEY (agent_id, mode)
   )`,
  // AN OPEN POSITION CARRIED ACROSS AN EPOCH BOUNDARY, at mark. openNextEpoch
  // carries closing equity — unrealized P&L included — into the new epoch as
  // its opening balance, so a later close measured from the ORIGINAL entry
  // would count that P&L a second time. The carry is the new epoch's entry for
  // the position (`entry_quote_micro` = mark × size), and the key makes it one
  // carry per position per epoch however often it is retried.
  `CREATE TABLE IF NOT EXISTS perp_carries (
     agent_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     epoch INTEGER NOT NULL,
     market_id INTEGER NOT NULL,
     side TEXT NOT NULL,
     base TEXT NOT NULL,
     mark_price TEXT NOT NULL,
     entry_quote_micro TEXT NOT NULL,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     PRIMARY KEY (agent_id, mode, epoch, market_id)
   )`,
  "CREATE INDEX IF NOT EXISTS perp_carries_created ON perp_carries (created_at)",
  // ── THE VENUE IN EQUITY (rule 12) ─────────────────────────────────────────
  //
  // perpAccountUsdg = C + ΣM_iso + ΣU + T, each term recorded beside the total
  // so the identity closes, exactly as quarantinedCostUsdg did for the fourth
  // spot term. C, ΣM and ΣU come from ONE /account response — its
  // transaction_time (µs) is `perp_snapshot_time`. `perp_unrealized_gain_micro`
  // is Σ max(0, U_i) PER POSITION, what every peak subtracts (peakBasis).
  // `perp_in_transit_micro` is T_in + T_out. `cash_read_block` is the block
  // the cash was read at, which payouts are folded against.
  //
  // NULLABLE WITH NO DEFAULT, the house rule: every row before this one never
  // asked the question, and '0' would be a claim that it had and found none.
  // A reader treats NULL as "this mark carried no perp term".
  "ALTER TABLE equity ADD COLUMN perp_collateral_micro TEXT",
  "ALTER TABLE equity ADD COLUMN perp_isolated_margin_micro TEXT",
  "ALTER TABLE equity ADD COLUMN perp_unrealized_micro TEXT",
  "ALTER TABLE equity ADD COLUMN perp_unrealized_gain_micro TEXT",
  "ALTER TABLE equity ADD COLUMN perp_in_transit_micro TEXT",
  "ALTER TABLE equity ADD COLUMN perp_snapshot_time INTEGER",
  "ALTER TABLE equity ADD COLUMN cash_read_block INTEGER",
];

/**
 * Additive migrations, applied after the CREATE block on every open. Each is
 * idempotent: sqlite throws "duplicate column" on re-run and the loop swallows it;
 * the Postgres translation turns each into ADD COLUMN IF NOT EXISTS.
 */
const SQLITE_ALTERS: string[] = [
    "ALTER TABLE equity ADD COLUMN positions_usdg REAL NOT NULL DEFAULT 0",
    // Persistent high-water mark + running fee total — HWM must survive
    // restarts or the breaker and the fee ledger both forget the peak.
    "ALTER TABLE agents ADD COLUMN hwm_usdg REAL NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN accrued_fee_usdg REAL NOT NULL DEFAULT 0",
    // Simulation receipt: what the pre-trade quote promised, on the record.
    "ALTER TABLE trades ADD COLUMN sim_quote_out TEXT",
    "ALTER TABLE trades ADD COLUMN sim_min_out TEXT",
    "ALTER TABLE trades ADD COLUMN sim_fee_tier INTEGER",
    "ALTER TABLE trades ADD COLUMN sim_gas TEXT",
    // Attribution link: which decision produced this trade (see decisions table).
    "ALTER TABLE trades ADD COLUMN decision_id TEXT",
    // Fill economics — what actually moved, so P&L is computable per round-trip.
    "ALTER TABLE trades ADD COLUMN fill_side TEXT",
    "ALTER TABLE trades ADD COLUMN fill_symbol TEXT",
    "ALTER TABLE trades ADD COLUMN fill_qty_raw TEXT",
    "ALTER TABLE trades ADD COLUMN fill_price_usd REAL",
    "ALTER TABLE trades ADD COLUMN realized_pnl_usdg REAL",
    // How the fill figures were obtained: 'paper' (exact, simulated at the oracle
    // price) or 'quote' (live swap, taken from the pre-trade QuoterV2 simulation
    // rather than a parsed receipt). Never silently mix the two in analysis.
    "ALTER TABLE trades ADD COLUMN basis_source TEXT",
    // Where a holding's price came from: 'chainlink' (an external feed) or 'pool'
    // (a Uniswap TWAP, used for tokens with no feed). Not the same evidential
    // quality, so every surface that shows a value can say which it is instead of
    // presenting both as the same kind of number. Old rows default to chainlink,
    // which is what they were — nothing else could produce a price back then.
    "ALTER TABLE positions ADD COLUMN price_source TEXT NOT NULL DEFAULT 'chainlink'",
    // Discovery grew from "have I announced this" into "is it worth entering".
    "ALTER TABLE discovered_pools ADD COLUMN decimals INTEGER NOT NULL DEFAULT 18",
    "ALTER TABLE discovered_pools ADD COLUMN liquidity_usd REAL NOT NULL DEFAULT 0",
    "ALTER TABLE discovered_pools ADD COLUMN fdv_usd REAL NOT NULL DEFAULT 0",
    // The v4 PoolKey, captured from the Initialize event when discovery could
    // read it. NULLABLE WITH NO DEFAULTS, deliberately: a pool's identity is
    // the whole five-tuple, and a DEFAULT 0 fee would fabricate a pool that
    // does not exist — the unknown-as-zero bug wearing a schema. All five are
    // set together or not at all (recordCandidate enforces it).
    "ALTER TABLE discovered_pools ADD COLUMN pool_currency0 TEXT",
    "ALTER TABLE discovered_pools ADD COLUMN pool_currency1 TEXT",
    "ALTER TABLE discovered_pools ADD COLUMN pool_fee INTEGER",
    "ALTER TABLE discovered_pools ADD COLUMN pool_tick_spacing INTEGER",
    "ALTER TABLE discovered_pools ADD COLUMN pool_hooks TEXT",
    // Brokerage orders. A broker fill has an order id and no tx hash, and it
    // fills asynchronously — 'status' stays our coarse verdict enum, while
    // settlement_status carries the BROKER'S OWN state word verbatim
    // (submitted/partial/filled/cancelled/…, vocabulary unverified until read
    // off the wire — DESIGN.md §11 Q5). Both NULL on every EVM and paper row.
    "ALTER TABLE trades ADD COLUMN order_id TEXT",
    "ALTER TABLE trades ADD COLUMN settlement_status TEXT",
    // Gas actually paid on a landed UserOp, wei. The account self-pays with no
    // paymaster, so this is a real cost of every trade — and it was invisible:
    // sim_gas holds QuoterV2's estimate for the SWAP CALL only, unmultiplied by
    // any gas price, so realized P&L was gross of gas forever.
    "ALTER TABLE trades ADD COLUMN gas_wei TEXT",
    // What the SPONSOR paid, when somebody else paid. Kept separate from
    // gas_wei rather than sharing it, because gas_wei means 'what this owner
    // spent' and is subtracted from their P&L at five call sites. The
    // EntryPoint still reports actualGasCost for a sponsored op, so the number
    // survives sponsorship — only its owner changes.
    "ALTER TABLE trades ADD COLUMN sponsored_gas_wei TEXT",
    // EPOCH. Everything written before the accounting was fixed stays epoch 1
    // and is excluded from performance reporting — kept for forensics, never
    // presented as measured. The first tick after the fix opens epoch 2. This
    // is the "new epoch, keep history" decision enforced by the schema rather
    // than by convention, so no reconstructed figure can leak into a published
    // number by someone forgetting.
    "ALTER TABLE trades ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE equity ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    // WHICH BOOK THIS MARK IS OF — the paper one or the funded one.
    //
    // Both were being written here, under one agent_id, with nothing to tell
    // them apart. A paper book opens at `paperStartUsdg` (1,000 by default) and
    // a funded one holds whatever the owner actually sent, so an agent that
    // practised and then went live has a series that steps from 1,000 to its
    // real equity in one row — and every surface reading that series calls the
    // step a loss. One owner was shown "−$950.17 today" for a book that had
    // lost 2.7 cents. The two HWMs were already kept apart (the paper book
    // carries its own), so the breaker was never fooled; only the curve was.
    //
    // NULLABLE WITH NO DEFAULT, deliberately, exactly as the v4 PoolKey columns
    // above are. Every existing row is one of the two and we cannot tell which,
    // so `'live'` would be a claim made about 900 rows an owner can see. NULL
    // says what is true: this row predates the question. Readers keep whatever
    // behaviour they had for a NULL series and split on it once it is known,
    // which is what makes this migration cost nothing on the way in.
    "ALTER TABLE equity ADD COLUMN mode TEXT",
    // A MARK TAKEN WHILE FLOW INFERENCE WAS HELD (command-wake.ts tickRatchets
    // `held`): an op the resolver may still settle was in flight, so this row's
    // cash may carry that op's movement, or a deposit not yet booked. It is a
    // true valuation — the curve and freshness read it like any other — but it
    // is NOT a cash baseline, and the two readers that take one from the newest
    // row (lastKnownCashReading, bootstrap-source.ts) skip it. Those rows used
    // not to be written at all, which left a dropped op's 26-hour hold as a gap
    // in the curve and a day-old anchor. 1 held, 0 not; NULL predates the
    // question, and every reader treats NULL as not held — which is what every
    // such row was, because a held tick wrote nothing.
    "ALTER TABLE equity ADD COLUMN flows_held INTEGER",
    // WHEN THIS ROW'S CASH WAS READ, unix seconds — the tick's balance read,
    // which comes before its flow look's ledger read, where `at` is the INSERT
    // at the end of the tick. A restart's `since` must be the read: a chat trade
    // can join the intent chain mid-tick, so an op created between the read and
    // the INSERT is not in `cash_usdg`, yet `at` called it "already in the
    // reading" — its settlement was dropped and its movement booked a second
    // time as money "changed while the worker was stopped". NULL on every row
    // written before this; readers fall back to `at`, exactly as before.
    "ALTER TABLE equity ADD COLUMN cash_read_at INTEGER",
    "ALTER TABLE flows ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE fee_accruals ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    // The epoch this agent is currently writing into.
    "ALTER TABLE agents ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    // WHAT THE WORKER IS ACTUALLY DOING, on a channel the dashboard can read.
    //
    // The heartbeat is a JSON file in the worker's own MERRYMEN_HOME, and the
    // web service reads homePaths.heartbeat() — its OWN home. Self-hosted those
    // are the same directory and it works. Hosted they are different
    // directories in different containers, so the dashboard never saw a
    // heartbeat at all and every tenant read as IDLE regardless of what their
    // agent was doing.
    //
    // `agents` is already mirrored to the shared Postgres (ledger-mirror.ts),
    // so putting the mode here makes it visible without inventing a second
    // transport. The file stays: it is what the orchestrator's watchdog reads
    // to decide a child is wedged, and that is a different question asked by a
    // different process.
    "ALTER TABLE agents ADD COLUMN mode TEXT",
    "ALTER TABLE agents ADD COLUMN beat_at INTEGER",
    // A ONE-WAY CHANNEL FROM THE DASHBOARD TO THE WORKER.
    //
    // The two run in separate processes — separate containers, hosted — and
    // the worker has no HTTP server and no IPC. Everything the web side has
    // ever been able to tell it went through a store the orchestrator polls,
    // so this is that pattern rather than a new transport.
    //
    // Deliberately a QUEUE and not a flag. `claimed_at` makes a poller safe:
    // the drain claims a row before acting on it, so a crash between claim and
    // completion leaves the row claimed rather than replayed. For a command
    // that spends gas, at-most-once is the only acceptable semantics — the
    // same reasoning ledger-mirror.ts writes down for its own cursor.
    `CREATE TABLE IF NOT EXISTS agent_commands (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      -- MILLISECONDS, supplied by the caller. unixepoch() is seconds, and two
      -- commands queued in the same second then have no defined order —
      -- neither backend has a portable tiebreak (sqlite's rowid is not in
      -- Postgres). A queue whose order depends on the user being slow is not
      -- a queue.
      created_at INTEGER NOT NULL,
      -- MILLISECONDS TOO, both of them. They were written as unixepoch()
      -- (seconds) by the queue helpers below and as Date.now() (milliseconds)
      -- by the orchestrator's ferry, into these same two columns, and nothing
      -- caught it because every reader only ever tested them for NULL. The
      -- moment anything asks "how long did this order take to fill" the answer
      -- is wrong by a factor of 1000, in the direction that makes an order look
      -- instant.
      claimed_at INTEGER,
      done_at INTEGER,
      result TEXT
    )`,
    // The order itself: side, symbol, size — JSON, nullable.
    //
    // NULLABLE WITH NO DEFAULT, which is the house rule: a command written
    // before this column existed carries no arguments, and that is not the same
    // fact as carrying empty ones. `selftest` has none either and never will.
    //
    // The channel stays deliberately dumb — this column is transport, not
    // meaning. What an order is allowed to be is decided in the route before
    // the row is written and again in the child before an intent is built.
    "ALTER TABLE agent_commands ADD COLUMN args TEXT",
    // Measured execution quality: quoted-out vs received-out, in bps, positive
    // when the fill was worse than quoted. The slippage SETTING is one flat 1%
    // constant applied to a $5 trade and a $5,000 one alike; this is the
    // evidence needed to replace it with something size-aware.
    "ALTER TABLE trades ADD COLUMN fill_slippage_bps INTEGER",
    // The cash leg of a fill, so an audit can check it against the chain's USDG
    // movement directly rather than reconstructing it from price × quantity.
    "ALTER TABLE trades ADD COLUMN fill_cash_usdg REAL",
    // Gas priced in USDG at the moment it was burned, so P&L can be reported
    // NET of it. NULL means the ETH price was refused at the time — unpriced,
    // which is a different fact from free, and reported as such.
    "ALTER TABLE trades ADD COLUMN gas_usdg REAL",
    // Gas UNITS the EntryPoint charged. wei = units x price, and the two move
    // for different reasons: an op costs more because it did more work, or
    // because the block was busy. The canary saw 0.330-0.610 gwei across four
    // ops, so a setup-vs-steady split derived from wei alone would read a
    // doubling of the base fee as an expensive operation. Units are stable.
    "ALTER TABLE trades ADD COLUMN gas_units TEXT",
    // THE PER-TRADE FEE, ACCRUED AND NOT COLLECTED.
    //
    // Per TRADE rather than a running total on the agents row, because the
    // stated precondition for ever moving this money is that the ledger be
    // auditable first — fees.ts: "the ledger records what is owed; actual
    // collection ships with the funded-account flow so the ledger is auditable
    // before any money moves." A total cannot be audited; a row per trade can.
    //
    // NULL means NOT ASSESSED, which is not zero: a trade written before this
    // column existed, or one that never landed. Only a landed trade owes a fee.
    "ALTER TABLE trades ADD COLUMN trade_fee_usdg REAL",
    // THE NONCE THIS OPERATION WAS SIGNED WITH — the full ERC-4337 uint256
    // (key ‖ sequence), as a decimal string. Written once, on the pre-broadcast
    // 'submitted' row (executor.ts onSubmitted), and never rewritten by the
    // row's resolution.
    //
    // It is what lets a DROPPED userOp be written off. A nonce is spent exactly
    // once, and the next op the agent signs after a drop reads the chain's
    // unmoved nonce and is signed with the same one — so when that op executes,
    // the stranded one can never be included (inflight-reconcile.ts
    // findDroppedOps). Without it a dropped op held flow inference for the
    // resolver's whole 26-hour window. NULL on every row written before this,
    // and on rows that never had an operation: those are never judged dropped.
    "ALTER TABLE trades ADD COLUMN user_op_nonce TEXT",
    // Where a Pons launch actually trades. A pre-graduation token has NO pool
    // at all — it lives on its own bonding curve — so without this the token is
    // recorded and then unreachable: there is no tier-scan fallback the way
    // findV4Pool can guess an unhooked pool. NULLABLE with no default, like the
    // pool-key columns and for the same reason.
    "ALTER TABLE discovered_pools ADD COLUMN curve TEXT",
    // What that curve is priced in. NO DEFAULT, and readers must test `!= null`
    // rather than truthiness: `0x000…0` is the legitimate NATIVE ETH case and
    // covers 53.6% of launches, so an all-zero address here means "native", not
    // "unknown". Defaulting this would be the unknown-as-zero bug the pool_fee
    // comment above warns about, with the zero already meaning something else.
    "ALTER TABLE discovered_pools ADD COLUMN quote_token TEXT",
    // When the POOL discoverer announced this token — as distinct from merely
    // having a row, which the launchpad discoverer also creates.
    //
    // The two discoverers need INDEPENDENT dedupe. A Pons launch and that same
    // token's graduation into a Uniswap pool are two different events, and the
    // second is the one that matters most: it is when the token becomes
    // tradeable, and the only moment its v4 PoolKey can ever be captured (hook
    // addresses cannot be guessed, so a hooked pool is unroutable without it).
    // Sharing one seen-set keyed on "is there a row" meant a launchpad sighting
    // permanently suppressed the graduation sighting.
    "ALTER TABLE discovered_pools ADD COLUMN pool_announced_at INTEGER",
    // Backfill: every row that predates the launchpad path WAS announced by the
    // pool discoverer, because nothing else could have created it. Without this
    // the column reads NULL for all of them and the next pass re-announces the
    // entire history as new. Idempotent — rows the launchpad creates carry a
    // curve and are excluded, and rows already stamped are not matched.
    "UPDATE discovered_pools SET pool_announced_at = first_seen WHERE pool_announced_at IS NULL AND curve IS NULL",
    // The quote raised at which this curve graduates, raw quote units, as a
    // decimal string (TEXT because it does not fit an INTEGER for an 18dp
    // asset). Stored rather than re-read because CurveReserves cannot be
    // assembled without it -- the virtual seed is 40% of this number, so
    // without it no depth figure for the curve is real. It never changes for a
    // given curve, so one write beats an eth_call per token per tick.
    "ALTER TABLE discovered_pools ADD COLUMN graduation_threshold TEXT",
    // WHICH transfer, within a transaction. A deposit is identified by
    // (tx_hash, log_index) and NOT by the transaction alone: one transaction can
    // carry several USDG transfers, and keying on the hash would silently drop
    // all but the first. NULL for every flow that is not read from a chain log —
    // an inferred flow has no log to index.
    "ALTER TABLE flows ADD COLUMN log_index INTEGER",
    // WHO PAYS this agent's trading gas, as the WORKER resolved it.
    //
    // The dashboard cannot work this out for itself. Sponsorship is a worker
    // config (sponsorGasEnabled AND a bundler key), and hosted the web service is
    // a different container with a different environment — the deploy docs even
    // say the web service needs no bundler key, so a web-side answer would read
    // false on a correctly configured fleet and tell every sponsored owner to go
    // send ETH. Worse, the two could disagree in the other direction and promise
    // covered fees while the child refused every trade.
    //
    // This is the same fix, on the same row, as `mode` and `beat_at`: report the
    // child's own resolved answer rather than letting another process guess it.
    // NULLABLE on purpose — an agent that has never beaten has no answer, and
    // null is the honest value for that.
    "ALTER TABLE agents ADD COLUMN sponsor_gas INTEGER",
    // WHAT IS STOPPING THIS AGENT FROM TRADING FOR REAL, in the child's own
    // words — the same kind of fact as `sponsor_gas` above, and published for
    // the same reason: only the child resolves it, and the dashboard has no
    // other way to learn it.
    //
    // MEASURED, THEN NEEDED. Once the fleet stopped being killed mid-tick, a
    // blocker census read: no-gas 12, wrong-chain 9, dead-policy 6, no-cash 2.
    // The largest bucket is agents funded with USDG and no ETH — whose owners
    // were reading a funding screen that says "Send USDG to your agent's
    // account" and doing exactly that, twice. The sentence existed (an event
    // per change, from liveBlockerText) and the screen that could act on it
    // could not see it.
    //
    // NULLABLE, and null is TWO things: never beaten, or beaten and trading
    // for real. A reader must not render either as a blocker.
    "ALTER TABLE agents ADD COLUMN live_blocker TEXT",
    // ── THE AGENT'S ENERGY, AS THE WORKER REPORTS IT ─────────────────────
    //
    // A JSON EnergyStatus (core energy.ts), written by setAgentEnergy every
    // tick — its OWN statement, never folded into setAgentMode, whose argument
    // list exec-mode-publish.test.ts pins. A standing condition cannot be
    // carried by a log line that forty newer events push out of view, so the
    // desk reads this column, not the notice (circle-strategies.test.ts).
    //
    // NULLABLE, and null means "not said yet" — never "no energy". The mirror
    // keeps the last non-null value for the same reason it does for `mode`.
    "ALTER TABLE agents ADD COLUMN energy TEXT",
    // ── THE AGENT'S PERPS, AS THE WORKER REPORTS THEM (docs/perps.md) ─────
    //
    // A JSON PerpsReport (core perps.ts; parsePerpsReport is the one reader),
    // written by setAgentPerps from the perp lane (perps/lane.ts) — the
    // `energy` precedent above, for the same reason: a standing condition (a
    // leveraged position, an unread venue) cannot ride a log line forty newer
    // events push out of view, and the mobile banner keys on it. NULLABLE,
    // and null means "not said yet" — never "no positions": a reader shows
    // unknown, and the mirror keeps the last non-null value.
    "ALTER TABLE agents ADD COLUMN perps TEXT",
    // THE DAY'S HANDED-BACK ENTRY CLAIMS, a counter of their own that only
    // rises — so a refund survives the mirror's larger-wins copy up and the
    // seed's copy back down (energy-days.ts). Here for both the child's sqlite
    // and the shared Postgres the mirror migrates with this list.
    ...ENERGY_DAYS_ALTERS,
    // WHO OWNS this agent, for a public page to credit — the X handle its owner
    // typed, nothing more.
    //
    // DISPLAY METADATA, NEVER AN AUTHORIZATION KEY. Nothing may look up an agent,
    // tenant, grant or permission by this column. It is deliberately not unique
    // and deliberately not indexed: two agents may claim the same handle and both
    // render, because nobody has verified either and a unique constraint would
    // imply somebody had. A handle is also reassignable on X after an account is
    // deleted, so treating one as an identity is wrong even in principle.
    //
    // Lives beside `name` rather than in tenant settings because those are sealed
    // (settings-store.ts), and a public page must never decrypt a tenant to render
    // a name.
    "ALTER TABLE agents ADD COLUMN x_handle TEXT",
    // WHETHER THAT HANDLE WAS PROVEN, which is a different fact from having
    // one. Unverified it renders as plain text; only this flag lets a public
    // surface turn it into a link, because only then did anyone check. Written
    // from the tenant's stored xProof, never from what they typed.
    "ALTER TABLE agents ADD COLUMN x_verified INTEGER NOT NULL DEFAULT 0",
    // ── WHAT THE BOOK IS ALLOWED TO CLAIM, MADE DURABLE ──────────────────
    //
    // `PortfolioQuality` existed only inside the worker's tick closure. Nothing
    // wrote it anywhere, so no other tier could read it: the web computed five
    // independent, disagreeing answers to "may I publish a P&L", none of which
    // consulted whether the contributions underneath were evidence or guesswork.
    // The one durable trace was an English sentence in an `events` row.
    //
    // These columns are that signal, on the table the mirror already carries to
    // the shared database. NULL means never assessed, which is not the same as
    // false — an agent that has not armed since this shipped has made no claim,
    // and a reader must show unknown rather than assume either answer.
    "ALTER TABLE agents ADD COLUMN contributions_known INTEGER",
    // The one-phrase reason, so a surface can say WHY rather than just refusing.
    "ALTER TABLE agents ADD COLUMN contributions_why TEXT",
    // 'net' | 'gross' | 'unknown'. Gas leaves the account in ETH and never enters
    // equity, so a P&L that could not price it is GROSS — and on a small book
    // that is the difference between -0.13 and -6.65 USDG. A percentage printed
    // without this qualification is not a performance figure.
    "ALTER TABLE agents ADD COLUMN gas_accounting TEXT",
    // Unix seconds of the assessment. A quality flag with no timestamp cannot be
    // told from a stale one, and stale quality is exactly what a redeploy leaves.
    "ALTER TABLE agents ADD COLUMN quality_at INTEGER",
    // ── THE PEAK HAS TO BE ABLE TO COME DOWN, WITHOUT BEING WRITABLE DOWN ──
    //
    // `adjustAgentHwm` lowers the peak when capital LEAVES, and it must: leave
    // the peak up and the account is permanently "in drawdown" by the amount its
    // owner took home, which trips the breaker on every buy forever. That is not
    // a hypothetical — it is Shogun, refused at 5008bps against a 500bps cap
    // with 24.915968 USDG of equity and nothing lost.
    //
    // But the reduction could never reach the shared database. The mirror copies
    // `agents` with an UPWARD-ONLY ratchet, for its own good reason: a hosted
    // child rebuilt by a redeploy recreates its row at the schema default of
    // hwm 0, and an unconditional write would clobber durable history with that
    // zero. So the ratchet is right and the reduction is right, and they
    // contradict each other the moment a redeploy lands.
    //
    // THE FIX IS NOT TO RELAX THE RATCHET. It is to split the figure so that
    // BOTH halves only ever grow:
    //
    //   hwm_usdg            Σ every upward move — deposits and booked profit
    //   hwm_withdrawn_usdg  Σ every withdrawal that moved the peak down
    //   effective peak      hwm_usdg − hwm_withdrawn_usdg
    //
    // A rebuilt child reports 0 and 0, and neither ratchet moves, so durable
    // history survives exactly as before. A child that books a withdrawal
    // reports a LARGER withdrawn total, which the ratchet carries. The peak can
    // come down, and nothing can write it down: the only way to lower it is to
    // raise an append-only total that a flow row has to justify.
    //
    // Clamped at `hwm_usdg` so the effective peak can never go negative, which
    // is what `MAX(0, hwm + delta)` did before and what two tests pin.
    "ALTER TABLE agents ADD COLUMN hwm_withdrawn_usdg REAL NOT NULL DEFAULT 0",
    // ── CHAIN-DERIVED FLOWS CANNOT BE IMPORTED TWICE ─────────────────────
    //
    // A chain-log row's identity is the LOG that produced it, not the row: the
    // same Transfer re-read by a second scan is the same deposit, and inserting
    // it again doubles an owner's recorded capital. `flows` has no unique key at
    // all — which is how the mirror's cursor rewind was able to re-copy a whole
    // child ledger into it — so the repair and the scanner both need this before
    // either may write.
    //
    // The chain id is part of the identity because a tx hash is only unique
    // WITHIN a chain, and this codebase runs mainnet 4663 and testnet 46630
    // against the same schema.
    "ALTER TABLE flows ADD COLUMN chain_id INTEGER",
    // WHY A HOLD WAS A HOLD, persisted so the funnel can be read without logs.
    // graph.py applies a shut gate by overwriting action to "hold" AFTER parsing,
    // so a forced hold and a chosen one are identical in the decision row unless
    // this is carried. Null on every row written before the Brain reported it,
    // and null is rendered as unknown rather than as either kind.
    "ALTER TABLE decisions ADD COLUMN hold_kind TEXT",
    // THE FACT LAYER BEHIND A POST — the measurements a class decision was made
    // on, banded into words and kept beside the raw figures. Separate from
    // signals_json, which is the owner's whole balance sheet and MUST NEVER be
    // published; this column is written to be read by a stranger.
    "ALTER TABLE decisions ADD COLUMN evidence_json TEXT",
    // WHAT KIND OF THING DECIDED — brain, a deterministic strategy, the owner,
    // peer-triggered research, or a hard risk exit. Distinct from `source`,
    // which is the publication key: two rows can share a source and differ here
    // (an even-keel buy and an even-keel stop-floor sell). Recorded at the
    // moment of deciding because the alternative is a reader guessing, and
    // every reader would have to guess the same way forever. NULL on every row
    // written before this existed, and null renders as unknown rather than as
    // any particular kind.
    "ALTER TABLE decisions ADD COLUMN provenance TEXT",
    "ALTER TABLE decisions ADD COLUMN display_name TEXT",
    // WHAT THE CALL WAS MADE AT, so a view can later say "+x% since posted"
    // and a memecoin trade "at $3.1M MC". Written in the SAME insert as the
    // row — the mirror copies a decision once, exactly as first written, so a
    // column filled in later would never reach the feed. Nullable with no
    // default: unread is NULL, and a reader renders nothing for it. The web
    // reader deploys beside this and selects both as optional.
    "ALTER TABLE decisions ADD COLUMN mark_usd REAL",
    "ALTER TABLE decisions ADD COLUMN mcap_usd REAL",
    // ── NORMALISE BEFORE CONSTRAINING, in this order and not the other ──────
    //
    // Rows written before the identity existed carry a NULL chain and whatever
    // case the RPC happened to return the hash in. Both defeat the index — NULLs
    // are distinct in a unique index on either engine, and 0xAB… is not 0xab… —
    // so an old row and a new one naming the SAME log would sit side by side,
    // both sourced 'chain-log', and the owner's deposit would be counted twice.
    //
    // The chain comes from the agent's own grant rather than from config,
    // because that is the chain the transaction was actually on.
    "UPDATE flows SET tx_hash = LOWER(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash <> LOWER(tx_hash)",
    `UPDATE flows SET chain_id = (SELECT a.chain_id FROM agents a WHERE a.smart_account = flows.agent_id)
       WHERE chain_id IS NULL AND tx_hash IS NOT NULL`,
    // PARTIAL — AND NOT FOR THE REASON AN EARLIER DRAFT OF THIS COMMENT GAVE.
    //
    // It said a plain unique index here would "collapse every inferred row into
    // one and silently delete the legacy history". That is wrong twice over, and
    // the correct fact is stated eleven lines above: NULLs are DISTINCT in a
    // unique index on both SQLite and Postgres. So a non-partial index over
    // these columns creates cleanly over rows whose tx_hash is NULL, keeps every
    // one of them, and still admits another identical row. And a unique index
    // never deletes anything on creation in any case — it either builds or
    // fails to build.
    //
    // WHAT THE PREDICATE ACTUALLY BUYS is therefore smaller and worth stating
    // honestly: it keeps the index off rows that could never be constrained by
    // it, and it makes the intent legible — this constraint is about LOGS. For
    // the 363 rows in the hosted table it is behaviourally identical to no
    // predicate at all.
    //
    // WHICH LEAVES A HOLE THIS MIGRATION DOES NOT CLOSE, and pretending
    // otherwise is how the original comment came to be wrong. A row with no
    // transaction has no identity, so NO index can dedupe it. The mirror rewinds
    // its cursor to 0 when a child ledger is rebuilt beneath it (children have
    // no volume, so a redeploy does exactly that) and re-copies whatever the
    // reborn child holds. Quarantining an inferred row here does not stop an
    // equivalent row arriving that way later. What stops it is upstream: the
    // accounting anchor, so a reborn child does not re-book an opening balance,
    // and the paper boundary, so a simulated balance never books one at all.
    `CREATE UNIQUE INDEX IF NOT EXISTS flows_chain_identity
       ON flows (chain_id, agent_id, tx_hash, log_index)
       WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL`,
    // ── THE REVERSIBLE SIDE OF THE REPAIR ────────────────────────────────
    //
    // Legacy rows are MOVED here, never deleted. A wrong row is evidence of a
    // bug and the only remaining record of what the fleet believed while it was
    // live; there is no procedure that walks a DELETE back, and an owner may
    // already have seen the number it produced. Everything needed to put a row
    // back exactly as it was is carried, plus why it went and what replaced it.
    `CREATE TABLE IF NOT EXISTS flows_quarantine (
       original_id INTEGER NOT NULL,
       agent_id TEXT NOT NULL,
       epoch INTEGER,
       direction TEXT,
       amount_usdg REAL,
       tx_hash TEXT,
       block_number INTEGER,
       log_index INTEGER,
       source TEXT,
       at INTEGER,
       run_id TEXT NOT NULL,
       quarantined_at INTEGER NOT NULL,
       reason TEXT NOT NULL,
       replaced_by TEXT,
       PRIMARY KEY (run_id, original_id)
     )`,
    "CREATE INDEX IF NOT EXISTS flows_quarantine_agent ON flows_quarantine (agent_id)",
    // ── WHAT BRAIN ALREADY THOUGHT ABOUT, so a restart cannot forget ──────
    //
    // The accounting work spent weeks on one bug shape: a redeploy wipes the
    // child ledger, the child forgets, and it books the same thing again. An AI
    // budget has exactly that failure available to it — a child that forgot its
    // cooldowns would re-fire every trigger reason on every deploy.
    //
    // One row per agent. Baselines live here too, because a cooldown with no
    // baseline still lets the next tick read an old price move as a new one.
    `CREATE TABLE IF NOT EXISTS brain_trigger_state (
       agent_id TEXT PRIMARY KEY,
       state_json TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    // HERE AND NOT IN SQLITE_SCHEMA, because `decision_id` is itself added by an
    // ALTER above — the base schema runs first, so an index on it there fails with
    // 'no such column' and takes every trade insert down with it.
    //
    // decision_id is the join that turns what an agent thought into what actually
    // happened, and it had no index at all: every lookup of a decision's outcome
    // was a full scan of the tape. The public feed does one per row it publishes.
    "CREATE INDEX IF NOT EXISTS trades_decision ON trades (decision_id)",
  // The mirror's resolution pass updates by (agent_id, user_op_hash); without
  // this it scans the whole trades table once per resolved row. NOT unique on
  // purpose: a UNIQUE index would fail to create against any ledger that
  // already holds a duplicate hash, and applyLedgerSchema runs this list
  // against the SHARED database — so one bad row would take the entire mirror
  // down for every tenant rather than slowing one query.
  "CREATE INDEX IF NOT EXISTS trades_agent_userop ON trades (agent_id, user_op_hash)",
  // A FLEET-WIDE TIME FILTER CANNOT USE trades_agent_time, which leads on
  // agent_id — the wall band scans every tenant's last 24 hours, so without
  // this it seq-scans and sorts the whole table on every revalidation. Exactly
  // the reason decisions_time exists a few lines up.
  "CREATE INDEX IF NOT EXISTS trades_time ON trades (created_at DESC)",
  // ── CLASS CUSTODY ────────────────────────────────────────────────────────
  //
  // WHAT THIS AGENT'S CLASS VAULT HOLDS, because the contract cannot be asked.
  //
  // `PonsClassVault` has no enumerable interface, deliberately — "tokens the
  // owner never enumerated" is the whole framing. So the worker's own record IS
  // the enumeration, and the contract's `sweep(address)` taking a token argument
  // is the contract acknowledging that the record can be lost.
  //
  // This is a CANDIDATE LIST, never a balance. Every reader re-reads
  // `balanceOf(vault)` and treats the chain as the authority; a row here only
  // says "ask about this token". That distinction is what keeps a stale row from
  // becoming a phantom position.
  //
  // `curve` is stored alongside because a position must outlive its
  // `discovered_pools` row: that table is pruned to the 5,000 newest and the
  // launchpad adds ~10 an hour, so a curve ages out in about 21 days against a
  // 14-day grant. `knownCurves` is the only thing vouching for a class token, and
  // policy.ts refuses a class trade without it — so an evicted curve would mean
  // the agent could not sell its own position. The exit trap the vault exists to
  // remove, rebuilt at the mirror.
  `CREATE TABLE IF NOT EXISTS class_positions (
     agent_id TEXT NOT NULL,
     token TEXT NOT NULL,
     symbol TEXT,
     decimals INTEGER NOT NULL DEFAULT 18,
     curve TEXT,
     quote_token TEXT,
     first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
     PRIMARY KEY (agent_id, token)
   )`,
  "CREATE INDEX IF NOT EXISTS class_positions_agent ON class_positions (agent_id)",
  // ── WHAT THE CHAIN SAID, KEPT SO AN OPERATOR CAN SEE IT ────────────────
  //
  // The columns above describe a CANDIDATE: which token, on which curve. These
  // describe the POSITION — what it actually cost, how much actually arrived,
  // which transaction opened it, and whether it is still open.
  //
  // ALL OF IT IS DERIVED FROM THE VAULT'S OWN EVENTS, never from the proposal.
  // `classPerEntryUsdg` is a request; `ClassBuy.quoteIn` is a cost. They differ
  // by slippage on every single fill, and only one of them is a number the
  // scout budget may accrue or a P&L may be computed against.
  //
  // And it is a CACHE, not the truth. This table lives in the child's sqlite,
  // which a redeploy rebuilds; the truth is the chain, re-read on every arm.
  // What this buys is that the shared ledger — and therefore the dashboard and
  // the recovery path — can see a position without replaying the tape.
  "ALTER TABLE class_positions ADD COLUMN vault TEXT",
  "ALTER TABLE class_positions ADD COLUMN entry_tx TEXT",
  "ALTER TABLE class_positions ADD COLUMN exit_tx TEXT",
  // ACTUAL, both of them. Raw units: USDG at 6dp, the token at its own.
  "ALTER TABLE class_positions ADD COLUMN cost_usdg TEXT",
  "ALTER TABLE class_positions ADD COLUMN qty_raw TEXT",
  "ALTER TABLE class_positions ADD COLUMN proceeds_usdg TEXT",
  "ALTER TABLE class_positions ADD COLUMN opened_at_block TEXT",
  // 'open' | 'closed' | 'recovered'. `recovered` is the honest name for a
  // balance the chain shows in a vault whose entry we cannot find — it has an
  // UNKNOWN basis, which is not a zero basis. Booking it at zero would report
  // the whole exit as profit; treating it as flat would hide somebody's money.
  "ALTER TABLE class_positions ADD COLUMN state TEXT NOT NULL DEFAULT 'open'",
  // WHERE A POSITION SITS. 'account' for everything that existed before this
  // column, which is every row: the default is the truth for them, not a guess.
  "ALTER TABLE positions ADD COLUMN custody TEXT NOT NULL DEFAULT 'account'",
  // ── A SWEEP IS A WITHDRAWAL, NOT A SALE FOR ZERO ──────────────────────
  //
  // `state` had one value for "gone": `closed`. A position the owner swept out
  // through the Recover panel landed there beside genuine liquidations, with
  // `proceeds_usdg = '0'` next to a real cost — which reads as a position that
  // was sold and returned nothing, i.e. a total loss of everything it cost.
  //
  // Shogun's DOGGOS is the live case: cost 5.000000, proceeds 0, closed, and
  // the owner is holding 1,063,408 DOGGOS in their own wallet. Nothing computed
  // a realised -5 from it, but equity fell by the full 5.000000 the moment the
  // balance hit zero, with no flow row to say where it went — so the peak did
  // not follow it, and the drawdown breaker widened by exactly that much.
  //
  // The chain always said which it was: `foldClassEvents` has counted Swept
  // amounts since the class ledger shipped, and then dropped them on the floor.
  // This is where they land, so the difference survives the fold.
  "ALTER TABLE class_positions ADD COLUMN swept_raw TEXT",
  // THE PERP LEDGER — its own list so the migration test can translate every
  // statement of it for Postgres; see PERP_LEDGER_DDL.
  ...PERP_LEDGER_DDL,
];

/** Open node:sqlite, run the schema SYNCHRONOUSLY, and wrap it as the async Db.
 *  Sqlite allows synchronous DDL, which keeps self-hosted's lazy-on-first-use init
 *  byte-for-byte; only the per-query calls the store makes go through the async
 *  interface. */
function initSqlite(): Db {
  ensureHome();
  const DB_FILE = homePaths.db();
  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SQLITE_SCHEMA);
  for (const ddl of SQLITE_ALTERS) {
    try {
      db.exec(ddl);
    } catch {
      // column already exists
    }
  }
  // stderr, not stdout: `merrymen export` writes the audit journal to stdout,
  // and a diagnostic line landing in the middle of it corrupts the file. A log
  // is not data.
  console.error(`[store] sqlite at ${DB_FILE}`);
  ledgerFile = db;
  return wrapSqlite(db);
}

/**
 * Apply the ledger schema and every migration to a Db that is not ours.
 *
 * The mirror writes tenant rows into a SHARED Postgres that no `initStore()`
 * ever touches: children have DATABASE_URL stripped (orchestrator.ts's
 * CHILD_SECRET_STRIP) so they open sqlite, and the orchestrator only ever
 * created `mirror_state`. So every column the mirror copies had to already
 * exist there by some other means, and a migration that landed in the child
 * schema would silently break the mirror's INSERT — caught, logged once,
 * invisible.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS, and each ALTER swallowed the way
 * initSqlite and initPostgres already swallow it.
 */
export async function applyLedgerSchema(db: Db): Promise<void> {
  await execSchemaBatch(db);
  for (const ddl of SQLITE_ALTERS) {
    try {
      await db.exec(ddl);
    } catch {
      // column already exists — the same no-op the two init paths rely on
    }
  }
}

/**
 * THE SCHEMA BATCH, SAFE AGAINST A SECOND PROCESS RUNNING IT AT THE SAME TIME.
 *
 * Postgres's CREATE TABLE IF NOT EXISTS is not atomic against a concurrent
 * one: the loser fails on the catalog's unique index (23505), sees the table
 * appear mid-statement (42P07), or finds its row type already made (42710,
 * duplicate_object — seen on Postgres 17). And SQLITE_SCHEMA is one
 * multi-statement batch, which Postgres runs as ONE implicit transaction — so
 * the loser's whole batch rolled back and the caller threw before a single
 * ALTER ran. Measured on the deploy that adds a table (`energy_days`), with
 * three processes booting over the previous release's schema: two losers
 * every time. The mirror then skipped its pass, and startHistoryRepair — once
 * per process — never ran.
 *
 * Each of those means the other process created it, so the batch is run again
 * and finds everything there. Anything else is thrown, and a batch that keeps
 * losing gives up after three runs rather than spinning.
 */
async function execSchemaBatch(db: Db): Promise<void> {
  for (let run = 1; ; run++) {
    try {
      await db.exec(SQLITE_SCHEMA);
      return;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (run >= 3 || (code !== "23505" && code !== "42P07" && code !== "42710")) throw e;
    }
  }
}

/** Open the shared Postgres ledger (hosted, multi-tenant): connect, then run the
 *  same schema + migrations through the async driver, which translates each to the
 *  Postgres dialect. Selected by DATABASE_URL, mirroring the grant store. */
async function initPostgres(url: string): Promise<Db> {
  const d = await makePgDb(url);
  await execSchemaBatch(d);
  for (const ddl of SQLITE_ALTERS) {
    try {
      await d.exec(ddl);
    } catch {
      // ADD COLUMN IF NOT EXISTS makes a re-run a no-op; a genuine error still
      // surfaces on the first real query rather than being masked here.
    }
  }
  console.error("[store] postgres ledger");
  return d;
}

function getDb(): Db {
  if (driver) return driver;
  if (process.env.DATABASE_URL) {
    // Postgres init is async (connect + DDL) and cannot run inside this sync
    // accessor. The hosted worker and web bootstrap both call initStore() first;
    // failing loudly here beats silently opening a stray local sqlite file on a
    // machine that was meant to share the network ledger.
    throw new Error("[store] DATABASE_URL is set — call and await initStore() before the first store use");
  }
  driver = initSqlite();
  return driver;
}

/**
 * Test seam: CLOSE the ledger and drop the cached driver.
 *
 * This replaces a resetStoreForTest() that only forgot the driver. Forgetting is
 * enough to re-point MERRYMEN_HOME, and that is all it claimed, but it left the
 * sqlite file open — and on Windows an open file is one that cannot be deleted.
 * Every test that points MERRYMEN_HOME at a mkdtemp and imports this module was
 * holding <home>/merrymen.db for the life of the process, so its cleanup hook
 * could only swallow the failure and leak the whole tree into %TEMP% on each run.
 *
 * Sqlite only, because that is the backend a test opens: the Postgres path owns a
 * pool that db.ts's resetPoolsForTest() releases, and no test sets DATABASE_URL.
 * Idempotent — a second call after the handle is gone is a no-op, so a hook can
 * call it without knowing whether the store was ever touched.
 */
export function closeStoreForTest(): void {
  const open = ledgerFile;
  ledgerFile = null;
  driver = null;
  open?.close();
}

/** Create the DB + schema eagerly so a broken store fails at startup, not mid-trade.
 *  Async because the Postgres backend connects and runs DDL over the network; the
 *  self-hosted sqlite path stays synchronous under the await. */
export async function initStore(): Promise<void> {
  if (driver) return;
  const url = process.env.DATABASE_URL;
  driver = url ? await initPostgres(url) : initSqlite();
}

export interface TradeRow {
  agent_id: string;
  kind: string;
  target: string;
  sell_token?: string;
  buy_token?: string;
  amount_usdg: number;
  /**
   * OUR UserOperation hash — the only id that identifies this trade on a 4337
   * explorer. The bundled `tx_hash` may carry other people's operations too.
   *
   * This column, its type field and its INSERT placeholder all existed for
   * months while NO call site ever supplied a value: a landed trade could not
   * be traced back to the operation that produced it. Populated since 2026-08-26.
   */
  user_op_hash?: string;
  /**
   * The nonce the operation was signed with, a decimal string of the full
   * uint256 — set on the pre-broadcast row only (see the column's migration).
   */
  user_op_nonce?: string;
  tx_hash?: string;
  /**
   * Our coarse verdict, not the broker's. 'submitted' is the brokerage rail's
   * committed-but-not-yet-filled state: the money is already reserved against
   * the caps (a submitted order is spend the instant it leaves), and step 6's
   * reconciler resolves it to landed/reverted from the wire. The broker's own
   * state words live in settlement_status, verbatim — two vocabularies, never
   * mixed.
   *
   * 'dropped' is a 'submitted' op the chain can provably never execute: another
   * op of ours spent its nonce (inflight-reconcile.ts findDroppedOps). It moved
   * nothing and burned no gas, so — like 'reverted' and 'rejected' — it counts
   * toward no cap and enters no journal; unlike 'reverted' it never reached the
   * chain, and unlike 'rejected' it was sent.
   */
  status: "landed" | "reverted" | "rejected" | "paper" | "submitted" | "dropped";
  reject_rule?: string;
  /** Brokerage order id (no tx hash exists on that rail). NULL elsewhere. */
  order_id?: string;
  /** The broker's own order-state word, stored verbatim. NULL elsewhere. */
  settlement_status?: string;
  /*
   * No created_at. The column is `INTEGER NOT NULL DEFAULT (unixepoch())` and
   * addTrade deliberately omits it from the INSERT, so SQLite stamps the row.
   *
   * It used to be a required field here that fourteen call sites dutifully
   * filled with `new Date().toISOString()` — and every one of those strings was
   * dropped on the floor, because the column was never in the INSERT list. The
   * type promised control the code did not have.
   *
   * That mattered less than it looked (the stored value was always a correct
   * integer, and the trailing-24h budget windows have always worked), but it is
   * a live trap for anything that needs to record when something ACTUALLY
   * happened rather than when the row was written — a settlement reconciler for
   * an async brokerage fill, say. Such a thing needs its own column, e.g.
   * `filled_at`; it must not reach for this one and quietly get nothing.
   */
  /** Simulation receipt (Uniswap QuoterV2): quoted out, slippage-bounded min, tier, gas. */
  sim_quote_out?: string;
  sim_min_out?: string;
  sim_fee_tier?: number;
  sim_gas?: string;
  /** Attribution: the decisions.id that produced this trade (null for legacy rows). */
  decision_id?: string;
  /** Fill economics — set on filled trades so P&L is computable per round-trip. */
  fill_side?: "buy" | "sell";
  /** 18dp raw units filled, as a decimal string. */
  fill_qty_raw?: string;
  /** The coin's name, display only. Absent: addTrade works it out (fillSymbolOfRow). */
  fill_symbol?: string;
  /** 6dp USDG that actually moved on this fill — paid on a buy, received on a
   * sell. Stored rather than derived from price × qty so an on-chain check
   * compares an exact figure against an exact figure. */
  fill_cash_usdg?: number;
  fill_price_usd?: number;
  /** 6dp-derived USDG booked on this fill (sells only; buys are always 0). */
  realized_pnl_usdg?: number;
  /**
   * How the fill figures were obtained, in descending order of evidence:
   *   'receipt' — read off the settled transaction's Transfer logs. The fact.
   *   'paper'   — exact, but simulated at the oracle price. Not real money.
   *   'quote'   — the pre-trade QuoterV2 bound. An ESTIMATE, and the fallback
   *               when a receipt cannot be parsed. Never mix it with 'receipt'
   *               in analysis without saying so.
   */
  basis_source?: "receipt" | "paper" | "quote";
  /** Gas actually paid, wei, as a decimal string. Real cost; not in equity_usdg. */
  gas_wei?: string;
  /**
   * Gas UNITS charged, as a decimal string — the price-independent half of the
   * cost. Absent on rows written before it was captured, which is why every
   * reader treats it as optional rather than defaulting it to zero.
   */
  gas_units?: string;
  /** That gas in USDG at the price when it was burned. NULL = unpriced, NOT free. */
  gas_usdg?: number;
  /** Measured execution quality: how far the fill landed from the quote, in bps (+ is worse). */
  fill_slippage_bps?: number;
  /**
   * Per-trade platform fee ACCRUED on this trade, USDG. Nothing is moved.
   *
   * NULL means NOT ASSESSED — a row written before the column existed, or a
   * trade that never landed. Only a landed trade owes a fee, and zero is a
   * different answer from absent.
   */
  trade_fee_usdg?: number;
}

/** One row in the decisions table — the proposal, its reasoning, and its fate. */
export interface DecisionRow {
  id: string;
  agent_id: string;
  source: string;
  strategy?: string;
  provider?: string;
  model?: string;
  symbol?: string;
  action?: string;
  size_usdg?: number;
  reason?: string;
  /** Set when the proposal was dropped before execution (no trade will link to it). */
  dropped_rule?: string;
  signals_json?: string;
  /**
   * WHY A HOLD WAS A HOLD — "MODEL_HOLD" or "GATE_FORCED_HOLD".
   *
   * The Brain's gate applies a shut verdict by overwriting the action to "hold"
   * AFTER parsing, deliberately, because a model told it may not size will
   * still sometimes size one. So a forced hold and a considered one are
   * identical in this row unless the kind is carried — and "the agent decided
   * not to trade" and "the agent was not allowed to" have opposite remedies.
   *
   * Absent on anything a non-Brain strategy wrote, and on rows from before the
   * Brain reported it. Absent stays absent: a funnel that counts unknown holds
   * as model holds would report a healthy fleet while it was being gated.
   */
  hold_kind?: string;
  /**
   * THE FACT LAYER, and the one column here that is written to be PUBLISHED.
   *
   * signals_json sits two fields up and is the opposite: the owner's cash,
   * vault and every holding's value, which thesis-policy.ts keeps out of the
   * published shape by not selecting it at all. The names are similar and the
   * rules are opposite, so the distinction is stated here rather than left to
   * whoever adds the next reader.
   *
   * A ClassEvidence as JSON: qualitative bands a social writer may draw on, the
   * raw figures for a drill-down, and who decided the trade.
   */
  evidence_json?: string | null;
  /**
   * WHO DECIDED — one of provenance.ts's five kinds, or absent.
   *
   * Absent is honest for rows written before the column existed, and it must
   * stay absent rather than defaulting: "we do not know what decided this" and
   * "a deterministic strategy decided this" are different facts, and one of
   * them is a claim about autonomy.
   */
  provenance?: string | null;
  /**
   * THE NAME A READER RECOGNISES, when the tape gave one.
   *
   * An autonomous Trencher symbol is address-derived — `T` plus eleven hex — so
   * a feed rendered from `symbol` alone says "hold T7631DACC21B", which tells a
   * reader nothing. This rides alongside it: display only, nothing prices,
   * routes, matches or settles against it, and ABSENT rather than a placeholder
   * when no name was carried. Sanitised where it is resolved, because it is the
   * one field here a stranger wrote.
   */
  display_name?: string | null;
  /**
   * THE PRICE THE AUTHOR SAW, USD per unit, at the moment it decided.
   *
   * A view has no fill, so without this "was that call right?" has nothing to
   * be measured from — the feed could only print the token's own 24h change,
   * which readers took for the agent's result. Null when the mark was stale or
   * not a price: a figure computed against the absence of a market would be
   * one nobody read.
   */
  mark_usd?: number | null;
  /**
   * A MEMECOIN'S MARKET CAP at decision time, USD, from the tape the agent
   * already read — so a trade can say "$5.00 at $3.1M MC". Null for anything
   * the tape did not size, which is every stock.
   */
  mcap_usd?: number | null;
}

/** A fresh decision id. Kept here so every producer stamps the same shape. */
export function newDecisionId(): string {
  return randomUUID();
}

export async function addDecision(row: DecisionRow): Promise<void> {
  try {
    await getDb()
      .prepare(
        `INSERT INTO decisions (id, agent_id, source, strategy, provider, model, symbol, action, size_usdg, reason, dropped_rule, signals_json, hold_kind, evidence_json, provenance, display_name, mark_usd, mcap_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.agent_id,
        row.source,
        row.strategy ?? null,
        row.provider ?? null,
        row.model ?? null,
        row.symbol ?? null,
        row.action ?? null,
        row.size_usdg ?? null,
        row.reason ?? null,
        row.dropped_rule ?? null,
        row.signals_json ?? null,
        row.hold_kind ?? null,
        row.evidence_json ?? null,
        row.provenance ?? null,
        row.display_name ?? null,
        row.mark_usd ?? null,
        row.mcap_usd ?? null,
      );
  } catch (e) {
    console.error("[store] decision insert failed:", e);
  }
}

/**
 * THE NAME A DECISION ABOUT THIS COIN SHOULD CARRY: the tape's, or the one
 * this agent's own newest named row gave it.
 *
 * A held coin drops off the tape's qualified list, and discovery then labels it
 * with its own id — so every exit and review written after that went into the
 * ledger unnamed and published "sell TA151B4A9E1B 5.01 USDG". The name its buy
 * used is still here. `fromTape` wins when there is one; the lookup is only for
 * an address-derived id (DERIVED_ID), and only ever within this agent, so one
 * agent's label for an id can never become another's.
 *
 * THIS LEDGER DOES NOT SURVIVE A REDEPLOY, so it cannot be the last word. A
 * coin bought before the latest deploy has no named row here any more, and the
 * default Trencher holds for up to three days. `fromChain` is asked after a
 * miss — the coin's own contract, which is still there (decision-name.ts). It
 * is asked last because the buy's own name is what the feed already showed.
 *
 * Null on a miss or a read failure — absent, never a placeholder. The name was
 * sanitised by coin-name.ts when it was first written, and the publication gate
 * backstops it again.
 *
 * A TIE IS BROKEN ON THE NAME. `at` is whole seconds, so a buy and its review
 * routinely share one, and `ORDER BY at DESC` alone returns whichever row the
 * engine reaches first — SQLite and Postgres need not agree, and neither
 * promises the same row twice. The name an exit is written with must not
 * depend on that.
 */
export async function displayNameFor(
  agentId: string,
  symbol: string,
  fromTape: string | null,
  fromChain?: () => Promise<string | null>,
): Promise<string | null> {
  if (fromTape) return fromTape;
  if (!DERIVED_ID.test(symbol)) return null;
  let named: string | null = null;
  try {
    const r = (await getDb()
      .prepare(
        `SELECT display_name FROM decisions
          WHERE agent_id = ? AND symbol = ? AND display_name IS NOT NULL AND display_name <> ''
          ORDER BY at DESC, display_name LIMIT 1`,
      )
      .get(agentId, symbol)) as { display_name: string | null } | undefined;
    named = r?.display_name ?? null;
  } catch {
    named = null;
  }
  if (named || !fromChain) return named;
  try {
    return await fromChain();
  } catch {
    return null;
  }
}

export async function ensureAgent(grant: StoredGrant): Promise<string> {
  await getDb()
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(smart_account) DO UPDATE SET
         caps = excluded.caps, expires_at = excluded.expires_at, session_key_address = excluded.session_key_address`,
    )
    .run(
      grant.smartAccount,
      grant.owner,
      grant.sessionKeyAddress,
      grant.chainId,
      JSON.stringify(grant.caps),
      grant.grantedAt,
      grant.expiresAt,
    );
  return grant.smartAccount;
}

/**
 * Persisted HWM + accrued fees, loaded at arm time.
 *
 * `hwmUsdg` is the EFFECTIVE peak — gross minus what withdrawals have taken out
 * of it — because that is the figure every caller actually wants: the drawdown
 * breaker divides by it and the performance fee accrues above it. The two
 * components come back beside it for the surfaces that have to explain the
 * number rather than just use it.
 *
 * Before `hwm_withdrawn_usdg` existed every account had 0 withdrawn, so this
 * returns exactly what it returned before for all existing data.
 */
export async function getAgentFinancials(agentId: string): Promise<{
  hwmUsdg: number;
  /** Σ every upward move. Monotonic. */
  hwmGrossUsdg: number;
  /** Σ every withdrawal that moved the peak down. Monotonic, clamped at gross. */
  hwmWithdrawnUsdg: number;
  accruedFeeUsdg: number;
}> {
  const row = (await getDb()
    .prepare(
      "SELECT hwm_usdg, hwm_withdrawn_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?",
    )
    .get(agentId)) as
    | { hwm_usdg: number; hwm_withdrawn_usdg: number | null; accrued_fee_usdg: number }
    | undefined;
  const gross = row?.hwm_usdg ?? 0;
  // `?? 0` for the pre-migration row shape, not as a guess: the column is NOT
  // NULL DEFAULT 0, so a null here means a database the ALTER has not reached,
  // and zero withdrawn is the truth for every row written before it existed.
  const withdrawn = row?.hwm_withdrawn_usdg ?? 0;
  return {
    hwmUsdg: Math.max(0, gross - withdrawn),
    hwmGrossUsdg: gross,
    hwmWithdrawnUsdg: withdrawn,
    accruedFeeUsdg: row?.accrued_fee_usdg ?? 0,
  };
}

/** Ratchet the persisted HWM (monotonic — ignores values below the stored peak). */
/**
 * Adopt the durable accounting epoch on a child whose database was discarded.
 *
 * THE REGRESSION THIS CLOSES. `ensureAgent` inserts only the grant columns, so a
 * hosted child rebuilt by a redeploy takes the schema DEFAULT of epoch 1 — while
 * the shared `agents` row is on 2. The only bump path is gated by
 * `hasEpochOneHistory`, which counts rows written before the accounting fix and
 * is therefore false on an empty database, so nothing corrects it.
 *
 * The child then writes every trade, flow and equity row stamped epoch 1. The
 * web's readers are epoch-scoped and the anchor derivation now is too, so those
 * rows are invisible to BOTH: contributions and the evidenced total both read
 * zero, and the fee gate hardens permanently on an account that is fine.
 *
 * MONOTONIC, like the peak. `MAX` rather than assignment, because an epoch is a
 * one-way door — going backwards would readmit the quarantined rows the boundary
 * exists to exclude, which is the failure the mirror's own upsert had.
 */
export async function setAgentEpoch(agentId: string, epoch: number): Promise<boolean> {
  if (!Number.isInteger(epoch) || epoch < 1) return false;
  try {
    await getDb()
      .prepare("UPDATE agents SET epoch = MAX(epoch, ?) WHERE smart_account = ?")
      .run(epoch, agentId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ratchet the persisted peak to an EFFECTIVE figure.
 *
 * Callers hand this the peak they want measured against — `accrueAboveHwm`'s
 * `newHwmUsdg`, the anchor's restored mark — which is an effective figure, while
 * the column stores the gross. So the stored value is the effective one with
 * what withdrawals have already taken added back, and the ratchet then compares
 * gross to gross. Without the `+ hwm_withdrawn_usdg` the first fee accrual after
 * any withdrawal would quietly write the effective figure into the gross column
 * and subtract the withdrawals a second time.
 *
 * CASE, not MAX. `MAX(a, b)` is a scalar in sqlite and an aggregate in Postgres,
 * and `translateQuery` does not rewrite it — the same reason the mirror's upsert
 * gives for avoiding it.
 */
export async function setAgentHwm(agentId: string, hwmUsdg: number): Promise<boolean> {
  try {
    await getDb()
      .prepare(
        `UPDATE agents SET hwm_usdg =
           CASE WHEN ? + hwm_withdrawn_usdg > hwm_usdg THEN ? + hwm_withdrawn_usdg ELSE hwm_usdg END
         WHERE smart_account = ?`,
      )
      .run(hwmUsdg, hwmUsdg, agentId);
    return true;
  } catch (e) {
    // A swallowed HWM update lets the persisted peak lag the true one, so the
    // drawdown breaker measures against a low mark and under-reports the drop —
    // the unsafe direction. Return false so the caller can surface it.
    console.error("[store] hwm update failed:", e);
    return false;
  }
}

/**
 * Move the HWM by a signed amount, floored at zero — the ONE exception to its
 * monotonicity, and only ever for capital crossing the boundary.
 *
 * The HWM is monotonic with respect to PERFORMANCE: recovering to a previous
 * peak is not profit and must not be charged for. It cannot be monotonic with
 * respect to CAPITAL. A 1,000 USDG deposit lifts equity by 1,000 without
 * earning a penny, so the peak it is measured against has to lift too, or the
 * next tick books the owner's own money as profit and takes a fee on it. A
 * withdrawal is the mirror: leave the peak up and the account is permanently
 * "in drawdown" by the amount its owner took home, which trips the breaker.
 *
 * "Capital crossing the boundary" includes capital leaving the trading BOOK
 * without leaving the account: USDG spent on the energy reserve buys something
 * that is never a position and never in equity, so equity drops by the spend
 * with nothing earned or lost. The peak drops with it — through
 * `bookCapitalFlow`, which moves it in the same transaction as the flow row.
 */
/**
 * Restore BOTH halves of the peak from the accounting anchor. Ratchets, never assigns.
 *
 * Separate from `setAgentHwm` because the two speak different units and mixing
 * them is the bug this whole split is guarding against: `setAgentHwm` takes an
 * EFFECTIVE peak and adds the withdrawn total back before storing, while the
 * anchor carries the GROSS and the withdrawn total as they sit in the shared
 * row. Passing one to the other adds the withdrawals twice.
 *
 * Each half is a one-way door on its own, so a child whose local figures are
 * already higher keeps them — a restore can only ever fill in what a rebuilt
 * database has forgotten.
 */
export async function restoreAgentHwmParts(
  agentId: string,
  parts: { grossUsdg: number | null; withdrawnUsdg: number | null },
): Promise<void> {
  try {
    const db = getDb();
    // WITHDRAWN FIRST. `hwm_usdg` is the clamp for the withdrawn total, so
    // raising the gross first can only ever admit more of the withdrawal, never
    // less — the safe order. The reverse can clamp a legitimate total against a
    // gross that is about to grow.
    if (parts.grossUsdg !== null) {
      await db
        .prepare(
          `UPDATE agents SET hwm_usdg = CASE WHEN ? > hwm_usdg THEN ? ELSE hwm_usdg END
           WHERE smart_account = ?`,
        )
        .run(parts.grossUsdg, parts.grossUsdg, agentId);
    }
    // NULL MEANS THE ANCHOR NEVER READ ONE, which is not a claim that nothing
    // was withdrawn. Writing 0 here would be that claim, and on a shared row it
    // would be one this process has no evidence for.
    if (parts.withdrawnUsdg !== null) {
      await db
        .prepare(
          `UPDATE agents SET hwm_withdrawn_usdg =
             CASE WHEN ? > hwm_withdrawn_usdg THEN ? ELSE hwm_withdrawn_usdg END
           WHERE smart_account = ?`,
        )
        .run(parts.withdrawnUsdg, parts.withdrawnUsdg, agentId);
    }
  } catch (e) {
    console.error("[store] hwm restore failed:", e);
  }
}

export async function adjustAgentHwm(agentId: string, deltaUsdg: number): Promise<void> {
  try {
    await getDb().tx((db) => applyHwmDelta(db, agentId, deltaUsdg));
  } catch (e) {
    console.error("[store] hwm adjust failed:", e);
    throw e;
  }
}

/**
 * Both peaks' capital move, inside a transaction the CALLER owns.
 *
 * Extracted from `adjustAgentHwm` verbatim so the one non-monotonic move has one
 * body: `adjustAgentHwm` runs it in its own transaction (exactly as before, same
 * clamps, same throw), and `bookCapitalFlow` runs it in the SAME transaction as
 * the flow row, so the row and the peaks land together or not at all. Two
 * copies of these UPDATEs would be two answers to "how far did the peak move".
 */
async function applyHwmDelta(db: Db, agentId: string, deltaUsdg: number): Promise<void> {
  await adjustRiskCapital(db, agentId, deltaUsdg);
  if (deltaUsdg >= 0) {
    // A DEPOSIT RAISES THE GROSS, exactly as before.
    await db
      .prepare("UPDATE agents SET hwm_usdg = hwm_usdg + ? WHERE smart_account = ?")
      .run(deltaUsdg, agentId);
    return;
  }
  // A WITHDRAWAL RAISES THE WITHDRAWN TOTAL INSTEAD, which lowers the
  // effective peak by the same amount while leaving both stored figures
  // monotonic — so the mirror's upward-only ratchet carries the reduction
  // instead of discarding it. See the ALTER for hwm_withdrawn_usdg.
  //
  // Clamped at the gross so the effective peak floors at zero, which is what
  // `MAX(0, hwm + delta)` did and what flows.integration.test.ts pins.
  const amount = -deltaUsdg;
  await db
    .prepare(
      `UPDATE agents SET hwm_withdrawn_usdg =
         CASE WHEN hwm_withdrawn_usdg + ? > hwm_usdg THEN hwm_usdg ELSE hwm_withdrawn_usdg + ? END
       WHERE smart_account = ?`,
    )
    .run(amount, amount, agentId);
}

// ── the audit journal ─────────────────────────────────────────────────────

/** The chain's anchor. A verifier starts here and must arrive at the last hash. */
export const JOURNAL_GENESIS = "0".repeat(64);

/**
 * Deterministic JSON: keys sorted at every level, bigints as decimal strings.
 *
 * The hash is only reproducible if an independent verifier serialises the same
 * bytes we did. Object key order in JS is insertion order, which is a property
 * of whichever code path built the object — so `{a,b}` and `{b,a}` are the same
 * fact and would otherwise hash differently, and the chain would "fail" on a
 * ledger nobody touched.
 */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[k];
        if (inner !== undefined) out[k] = norm(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** One link: sha256(prev ‖ canonical payload). Pure, so a verifier can redo it. */
export function journalHash(prevHash: string, payloadJson: string): string {
  return createHash("sha256").update(prevHash).update(payloadJson).digest("hex");
}

/**
 * The facts the chain records. The four perp kinds (docs/perps.md, "Ledger")
 * are venue facts, never spot ones, so none of them is a `fill`:
 *   perp-fill   a Lighter trade on our account (insertPerpFill);
 *   funding     an hourly funding payment (insertPerpFunding);
 *   margin      margin moving between the account and the venue — a step of
 *               a perp_transfers row that moved money (upsertPerpTransfer);
 *   perp-carry  an open position carried across an epoch boundary at mark.
 * The contract's verifier refuses a kind it does not know rather than skipping
 * it (docs/perps.md, "Verify"), so each of these must be taught to audit.ts's
 * reconstruct before an agent that writes it is verified.
 */
export type JournalKind = "fill" | "flow" | "mark" | "fee" | "perp-fill" | "funding" | "margin" | "perp-carry";

export interface JournalEntry {
  seq: number;
  agent_id: string;
  epoch: number;
  kind: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
  at: number;
}

/**
 * Append one fact to the chain. Callers pass the DOMAIN row they just wrote (or
 * are about to), and this mirrors it.
 *
 * Not exported for casual use: it takes an open transaction from
 * `journaled()` so the mirror and the row it mirrors commit together. A journal
 * that can be half-written is not evidence of anything.
 */
async function appendJournalRow(db: Db, agentId: string, epoch: number, kind: JournalKind, payload: unknown): Promise<void> {
  const prev = (await db
    .prepare("SELECT hash FROM journal WHERE agent_id = ? AND epoch = ? ORDER BY seq DESC LIMIT 1")
    .get(agentId, epoch)) as { hash: string } | undefined;
  const prevHash = prev?.hash ?? JOURNAL_GENESIS;
  const payloadJson = canonicalJson(payload);
  await db
    .prepare(
      `INSERT INTO journal (agent_id, epoch, kind, payload_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(agentId, epoch, kind, payloadJson, prevHash, journalHash(prevHash, payloadJson));
}

/**
 * Run a domain write and its journal entry as ONE transaction.
 *
 * A process that dies between the two writes must leave neither,
 * not a ledger whose chain has a hole in it or a journal claiming a trade the
 * trades table never got.
 */
export async function journaled(
  agentId: string,
  epoch: number,
  kind: JournalKind,
  payload: unknown,
  write: (db: Db) => Promise<void>,
): Promise<void> {
  // One transaction, pinned to one connection (tx()), so the domain write and
  // its journal entry commit together or not at all. The SQLite driver also
  // keeps unrelated asynchronous operations outside this transaction.
  await getDb().tx(async (tx) => {
    await write(tx);
    await appendJournalRow(tx, agentId, epoch, kind, payload);
  });
}

/** Every entry for one epoch, oldest first — what `merrymen export` emits. */
export async function readJournal(agentId: string, epoch: number): Promise<JournalEntry[]> {
  try {
    return await getDb()
      .prepare(
        `SELECT seq, agent_id, epoch, kind, payload_json, prev_hash, hash, at
           FROM journal WHERE agent_id = ? AND epoch = ? ORDER BY seq ASC`,
      )
      .all(agentId, epoch) as unknown as JournalEntry[];
  } catch {
    return [];
  }
}

/** The epoch this agent writes into now — 1 if it has none yet. */
async function epochOf(agentId: string): Promise<number> {
  try {
    const row = await getDb()
      .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
      .get(agentId) as { epoch: number } | undefined;
    return row?.epoch ?? 1;
  } catch {
    return 1;
  }
}

/** The epoch this agent writes into now. */
export async function getAgentEpoch(agentId: string): Promise<number> {
  try {
    const row = await getDb()
      .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
      .get(agentId) as { epoch: number } | undefined;
    return row?.epoch ?? 1;
  } catch {
    return 1;
  }
}

/**
 * The moment the accounting work landed (ce28516). Rows written before it are
 * the ones that cannot be audited: no flow records, fills booked from a
 * slippage floor rather than a receipt, equity rows that can hold a phantom
 * crater from a failed balance read.
 *
 * A TIMESTAMP, not merely "epoch = 1", and that distinction is load-bearing. A
 * brand-new agent running today's code writes its own perfectly good rows into
 * epoch 1 on its first run — including its opening-balance flow. Bumping on the
 * bare presence of epoch-1 rows would orphan that agent's real deposit records
 * on its very next restart, which is the opposite of what the boundary is for.
 */
export const ACCOUNTING_FIXED_AT = 1_787_704_075;

/**
 * Does this agent's CURRENT epoch contain rows written before the accounting
 * was fixed? The evidence behind `PortfolioQuality.currentAccountingHistoryAuditable`.
 *
 * NULL MEANS COULD-NOT-ASK, and it is a distinct answer from `false`. A caller
 * deciding whether a return may be published must refuse on null; a caller
 * deciding whether to open a new epoch must do nothing on it. Same evidence,
 * opposite defaults — see the two wrappers below.
 */
export async function legacyRowsInEpoch(agentId: string, epoch: number): Promise<boolean | null> {
  try {
    const row = (await getDb()
      .prepare(
        `SELECT (SELECT COUNT(*) FROM trades WHERE agent_id = ? AND epoch = ? AND created_at < ?)
              + (SELECT COUNT(*) FROM equity WHERE agent_id = ? AND epoch = ? AND at < ?) AS n`,
      )
      .get(agentId, epoch, ACCOUNTING_FIXED_AT, agentId, epoch, ACCOUNTING_FIXED_AT)) as
      | { n: number }
      | undefined;
    if (row === undefined) return null;
    return Number(row.n ?? 0) > 0;
  } catch {
    // A ledger with no `trades` table yet is a read we could not make, not an
    // account we have cleared.
    return null;
  }
}

/**
 * CAN THIS EPOCH'S HISTORY BE AUDITED? The property, for the publication gate.
 *
 * Replaces `epoch >= 2`, which was a proxy for exactly this and gave the wrong
 * answer for every agent minted after the cutover — those write good rows into
 * epoch 1, never trip the boundary, and were therefore permanently unpublishable.
 *
 * FAILS CLOSED: null propagates, and `computePnl` refuses on it.
 */
export async function accountingHistoryAuditable(agentId: string, epoch: number): Promise<boolean | null> {
  const legacy = await legacyRowsInEpoch(agentId, epoch);
  return legacy === null ? null : !legacy;
}

/**
 * Does this agent have rows from BEFORE the audit work? Used once, at the first
 * arm, to decide whether an epoch boundary is needed. A brand-new agent has
 * nothing to quarantine and stays in epoch 1.
 *
 * FAILS OPEN, deliberately and differently from `accountingHistoryAuditable`:
 * a read failure here must not manufacture an epoch boundary, because opening
 * one writes an opening-balance flow and is not something to do on a guess.
 */
export async function hasEpochOneHistory(agentId: string): Promise<boolean> {
  return (await legacyRowsInEpoch(agentId, 1)) === true;
}

/**
 * Close the current epoch and open the next.
 *
 * CAPITAL MUST CROSS THE BOUNDARY OR P&L LIES. Equity is an absolute balance
 * reading; flows are epoch-scoped. Bump the epoch without carrying the capital
 * over and the two terms stop living in the same frame: the new epoch's
 * contributions start at nothing while equity still holds every dollar
 * deposited before the boundary. The COUNT(*) guard hides that only while there
 * are ZERO flows — the first top-up in the new epoch makes contributions equal
 * to just that top-up, and `equity − contributions` publishes the entire
 * bankroll as profit. Which is the exact bug this whole epoch mechanism was
 * built to end.
 *
 * So the boundary writes an opening balance: everything present is capital the
 * owner put in, and the new epoch measures only what happens after it. That is
 * what "reporting starts clean" has to mean — epoch 1's performance is
 * unmeasurable, which is precisely why it was quarantined.
 *
 * Booked 'epoch-carry', which is its own source rather than 'inferred'. It is
 * not a transfer anybody witnessed, so it is not a receipt — but it is also not
 * guesswork: it is the closing equity of the epoch just closed, a figure already
 * in the journal, and reconcileEpochCarry() checks it against that mark. Sharing
 * a source with real inference made every agent that crossed a boundary
 * permanently unable to evidence its contributions, with no recovery possible.
 */
export async function openNextEpoch(
  agentId: string,
  openingBalanceUsdg?: number,
  /**
   * EVERY PERP POSITION OPEN AT THE BOUNDARY, at mark (epoch-boundary-open-perps).
   *
   * The opening balance above is closing equity, and closing equity includes
   * each open position's unrealized P&L. A later close would book realized P&L
   * from the ORIGINAL entry and count that unrealized part a second time in
   * the new epoch, and verify would read the double as contributions the
   * record cannot support. So each position is carried in at mark, as the new
   * epoch's entry for it — one `perp-carry` entry per position, in THIS
   * transaction, so the boundary and its carries land together or not at all.
   *
   * Omitted or empty is byte-identical to before. The caller reads the marks;
   * a position it cannot mark must stop the boundary, never be left out.
   */
  perpCarries: readonly PerpCarryInput[] = [],
): Promise<number> {
  // Checked before the transaction opens: a malformed carry must refuse the
  // boundary without having bumped anything.
  const carries = perpCarries.map(validPerpCarry);
  return getDb().tx(async (db) => {
    // Increment under the transaction's row lock rather than reading and then
    // assigning: concurrent PostgreSQL callers must not open the same epoch.
    const account = await db
      .prepare(
        `UPDATE agents SET epoch = epoch + 1 WHERE smart_account = ?
         RETURNING epoch, chain_id, mode`,
      )
      .get(agentId) as FlowAccount | undefined;
    if (!account) throw new Error(`cannot open an epoch for unknown agent ${agentId}`);

    if (openingBalanceUsdg !== undefined && openingBalanceUsdg > 0) {
      const flow: FlowRow = {
        agentId,
        direction: "in",
        amountUsdg: openingBalanceUsdg,
        source: "epoch-carry",
      };
      // A paper reset advances its reporting epoch without converting simulated
      // equity into real capital. A live carry, including its journal entry,
      // must commit with the epoch or throw and roll the entire boundary back.
      if (admitCapitalFlow({ mode: tradingModeOf(account.mode), source: flow.source }).admit) {
        await insertFlowWithJournal(db, flow, account.epoch, account.chain_id);
      }
    }
    // Journaled under the same spelling as the opening balance above, into the
    // epoch just opened. The same market twice in one list is one carry: the
    // key admits the first and the second journals nothing.
    for (const carry of carries) await writePerpCarry(db, agentId, account.epoch, carry);
    return account.epoch;
  });
}

/** How the ledger came to know about a flow. See the flows DDL — these are not equal evidence. */
export type FlowSource = "chain-log" | "epoch-carry" | "transfer-intent" | "inferred" | "energy-buy";

export interface FlowRow {
  agentId: string;
  direction: "in" | "out";
  amountUsdg: number;
  source: FlowSource;
  txHash?: string;
  blockNumber?: number;
  /** Position within the block. Set for 'chain-log' and 'energy-buy' — see the migration. */
  logIndex?: number;
  /**
   * What the agent is actually doing, when the caller knows.
   *
   * PASS IT. The fallback below reads `agents.mode`, which is written by the
   * heartbeat and may not be there yet on an agent's first tick — and a paper
   * agent's first tick is exactly when the simulated opening balance would be
   * booked as a real contribution. The caller in index.ts knows synchronously
   * and unambiguously (`paperActive()`), so it says so.
   */
  mode?: TradingMode;
  /**
   * WHICH CHAIN the transaction is on — the first component of a flow's identity.
   *
   * A tx hash is unique only WITHIN a chain, and this codebase runs mainnet 4663
   * and testnet 46630 against one schema. Without it every row this function
   * wrote carried chain_id NULL, and NULLs are distinct in a unique index on
   * both SQLite and Postgres — so `flows_chain_identity` could never fire on a
   * row written here, and the repair (which DOES set it) would insert a second
   * chain-log row for the same log rather than conflicting with it.
   */
  chainId?: number;
}

interface FlowAccount {
  epoch: number;
  chain_id: number | null;
  mode: string | null;
}

/**
 * Insert into an existing transaction; a duplicate is successful but adds no journal fact.
 *
 * RETURNS WHETHER A ROW WAS ACTUALLY INSERTED — `changes === 1`, not "did not
 * throw". `addFlow` still answers the looser question for the deposit scanner;
 * `bookCapitalFlow` gates the peak move on this, so a duplicate can never move
 * the high-water mark a second time.
 */
async function insertFlowWithJournal(db: Db, flow: FlowRow, epoch: number, chainId: number | null): Promise<boolean> {
  const amount = Math.abs(flow.amountUsdg);
  const txHash = flow.txHash ? flow.txHash.toLowerCase() : null;
  const inserted = await db
    .prepare(
      `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      flow.agentId,
      flow.direction,
      amount,
      txHash,
      flow.blockNumber ?? null,
      flow.logIndex ?? null,
      flow.source,
      epoch,
      chainId,
    );
  // Both drivers report affected rows. An ignored INSERT must not append an
  // extra contribution to the audit book while leaving the flows table intact.
  // A single-row INSERT reports 0 or 1; `Number` because a driver may hand back
  // a bigint, and a bigint 0n is not `=== 0`.
  if (Number(inserted.changes) === 0) return false;
  await appendJournalRow(db, flow.agentId, epoch, "flow", {
    amountUsdg: amount,
    blockNumber: flow.blockNumber ?? null,
    direction: flow.direction,
    logIndex: flow.logIndex ?? null,
    source: flow.source,
    txHash,
  });
  return true;
}

/**
 * Record money crossing the account boundary, and mirror it into the journal.
 *
 * RETURNS WHETHER THE ROW LANDED, and the caller must act on it. This used to
 * return void with a try/catch that only logged, while `record()` in index.ts
 * went straight on to `adjustAgentHwm`. Any transient failure of the insert
 * therefore moved the high-water mark by the full amount with NO flow row to
 * explain it, advanced the scan cursor past the block, and left no way to
 * retry — the peak and the contribution silently split apart, which is the one
 * pairing the whole anchor design exists to keep together.
 *
 * REFUSES SIMULATED CAPITAL. See paper-boundary.ts: a paper agent's cash moves
 * for simulated reasons, and every rule that reads a cash change as an external
 * flow was written for an account where it could only have been the owner. The
 * check lives here as well as at the call site because this is the one function
 * every writer must pass through, so a future call site cannot reintroduce the
 * bug by forgetting.
 */
export async function addFlow(flow: FlowRow): Promise<boolean> {
  try {
    const admission = await getDb().tx(async (db) => {
      // A no-op UPDATE locks this agent through the flow write on PostgreSQL;
      // it cannot race an epoch rollover after reading the old epoch. SQLite
      // accepts the same SQL and serializes the transaction at its connection.
      const account = await db
        .prepare(
          `UPDATE agents SET epoch = epoch WHERE smart_account = ?
           RETURNING epoch, chain_id, mode`,
        )
        .get(flow.agentId) as FlowAccount | undefined;
      // Before the first heartbeat, an absent mode is unknown, not paper. The
      // caller can supply the known mode; absent agent/chain retain the existing
      // epoch-1/null-chain behavior instead of inventing a chain identity.
      const mode = flow.mode ?? tradingModeOf(account?.mode);
      const verdict = admitCapitalFlow({ mode, source: flow.source, txHash: flow.txHash });
      if (verdict.admit) {
        await insertFlowWithJournal(db, flow, account?.epoch ?? 1, flow.chainId ?? account?.chain_id ?? null);
      }
      return verdict;
    });
    if (!admission.admit) {
      console.error(`[flows] refused ${flow.source} ${flow.direction} ${flow.amountUsdg} — ${admission.why}`);
      // Outside the completed transaction: an ordinary store write must not
      // wait on the transaction that is awaiting it.
      await addEvent(flow.agentId, "warn", `capital flow not recorded — ${admission.why}`).catch(() => {});
      return false;
    }
    // Successful duplicate retries remain true for the deposit scanner.
    return true;
  } catch (e) {
    console.error("[store] flow insert failed:", e);
    return false;
  }
}

/** What `bookCapitalFlow` did. Every arm is a decision; a database error throws instead. */
export type CapitalBooking =
  /** The row was inserted and both peaks moved with it, in one transaction. */
  | { kind: "booked"; epoch: number }
  /** This exact (chain, agent, tx, logIndex) was already on the books. NOTHING moved. */
  | { kind: "already" }
  /** Not written, and nothing moved. `why` is the sentence for the caller's event. */
  | { kind: "refused"; why: string };

/**
 * Book one tx-evidenced capital flow AND move both peaks with it — atomically,
 * and at most once.
 *
 * WHY THIS EXISTS BESIDE `addFlow` + `adjustAgentHwm`. The transfer path calls
 * those two in sequence: two transactions, so a throw between them splits the
 * flow from the peak, and `addFlow`'s `true` also means "duplicate" (see
 * `hasChainFlow`), so a caller that moves the peak on it re-lowers the peak on
 * every retry — Shogun's 5.000000 taken off twice. Here the row, its journal
 * fact and both peaks (lifetime and the risk period) are ONE transaction, and
 * the peaks move only when the INSERT actually inserted. A retry, a second
 * booker, or an operator reconstruction that got there first all come back
 * `already` with nothing moved.
 *
 * IDENTITY IS REQUIRED. The flow must carry its tx hash, block and log index,
 * and a chain id (its own or the agent's): `flows_chain_identity` treats NULLs
 * as distinct on both SQLite and Postgres, so a row without all four could be
 * inserted twice and would defeat the whole "at most once" claim. Refused
 * rather than written loosely.
 *
 * Admission is the same paper boundary every writer passes (`admitCapitalFlow`).
 * The agent row is locked first with the no-op UPDATE `addFlow` uses, so the
 * booking cannot race an epoch rollover.
 *
 * Database errors THROW, and roll everything back — a caller that must retry
 * (the stranded-op resolver) needs to see them. No events are written inside
 * the transaction; the caller writes them after it returns.
 */
export async function bookCapitalFlow(
  flow: FlowRow & { txHash: string; blockNumber: number; logIndex: number },
): Promise<CapitalBooking> {
  const amount = flow.amountUsdg;
  if (!(typeof amount === "number" && Number.isFinite(amount) && amount > 0)) {
    return { kind: "refused", why: `the amount ${String(amount)} is not a positive number of USDG` };
  }
  if (typeof flow.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(flow.txHash)) {
    return { kind: "refused", why: "no transaction hash — a capital flow booked here must be a receipt" };
  }
  if (!Number.isSafeInteger(flow.logIndex) || flow.logIndex < 0 || !Number.isSafeInteger(flow.blockNumber) || flow.blockNumber < 0) {
    return { kind: "refused", why: "no log index or block number — without both it cannot be booked exactly once" };
  }
  return getDb().tx(async (db): Promise<CapitalBooking> => {
    const account = (await db
      .prepare(
        `UPDATE agents SET epoch = epoch WHERE smart_account = ?
         RETURNING epoch, chain_id, mode`,
      )
      .get(flow.agentId)) as FlowAccount | undefined;
    if (!account) return { kind: "refused", why: `no agent row for ${flow.agentId}` };
    const chainId = flow.chainId ?? account.chain_id ?? null;
    if (chainId === null) {
      return { kind: "refused", why: "no chain identity; cannot be booked exactly once" };
    }
    const verdict = admitCapitalFlow({
      mode: flow.mode ?? tradingModeOf(account.mode),
      source: flow.source,
      txHash: flow.txHash,
    });
    if (!verdict.admit) return { kind: "refused", why: verdict.why };
    const inserted = await insertFlowWithJournal(db, flow, account.epoch, chainId);
    // THE WHOLE POINT: a duplicate moves nothing.
    if (!inserted) return { kind: "already" };
    await applyHwmDelta(db, flow.agentId, flow.direction === "in" ? amount : -amount);
    return { kind: "booked", epoch: account.epoch };
  });
}

/**
 * Has this exact chain log already been booked as a flow?
 *
 * `addFlow` CANNOT ANSWER THIS. It inserts `ON CONFLICT DO NOTHING` and then
 * returns `true` whenever the statement did not throw — so a duplicate and a
 * fresh insert are indistinguishable to its caller. That is harmless for the
 * deposit scanner, which pre-filters on `knownFlowKeys` and whose `true` only
 * has to mean "nothing failed". It is NOT harmless for a caller that moves the
 * high-water mark on the strength of that return: it books the same withdrawal
 * again on every pass. Measured on Shogun — one 5.000000 sweep took 10.000000
 * off the peak across two arms, and `adjustAgentHwm`'s clamp would have walked
 * it to zero in a few more, switching the drawdown breaker off entirely, since
 * `policy.ts` only applies it while the peak is above zero.
 *
 * NULL WHEN THE QUESTION COULD NOT BE ASKED, and a caller must treat that as
 * "do not book". An unreadable ledger is not an empty one, and the cost of
 * waiting a tick is nothing next to the cost of double-counting capital.
 */
export async function hasChainFlow(
  agentId: string,
  txHash: string,
  logIndex: number,
): Promise<boolean | null> {
  try {
    const row = await getDb()
      .prepare("SELECT 1 AS n FROM flows WHERE agent_id = ? AND tx_hash = ? AND log_index = ? LIMIT 1")
      .get(agentId, txHash.toLowerCase(), logIndex);
    return row !== undefined && row !== null;
  } catch (e) {
    console.error("[store] flow lookup failed:", e);
    return null;
  }
}

/**
 * Is ANY flow on the books for this transaction — whatever its source or log
 * index? The executor books a transfer home with its tx hash and no log index
 * (flows_chain_identity cannot see it), so the stranded-op resolver asks this
 * before booking the same transfer from its receipt (energy-settle.ts
 * settleTransferLanding).
 *
 * NULL WHEN THE QUESTION COULD NOT BE ASKED: the caller must not book on it.
 */
export async function hasFlowForTx(agentId: string, txHash: string): Promise<boolean | null> {
  try {
    const row = await getDb()
      .prepare("SELECT 1 AS n FROM flows WHERE agent_id = ? AND tx_hash = ? LIMIT 1")
      .get(agentId, txHash.toLowerCase());
    return row !== undefined && row !== null;
  } catch (e) {
    console.error("[store] flow-for-tx lookup failed:", e);
    return null;
  }
}

/**
 * Capital the owner has put in, less what they have taken out. Subtract it from
 * equity and what remains is the only thing that deserves to be called P&L.
 *
 * NULL when nothing is on record — which is NOT the same as zero. A ledger
 * written before the flows table existed knows nothing about what was put in,
 * and treating that as "nothing was put in" republishes the original bug:
 * equity minus zero is the bankroll, presented as profit. Callers must show no
 * P&L at all rather than a confident wrong one.
 */
export async function getNetContributionsUsdg(agentId: string): Promise<number | null> {
  // EPOCH-SCOPED, and it was not.
  //
  // The boundary bridges two epochs by writing the closing equity of the old one
  // as an opening balance in the new one (`openNextEpoch`). Summing across the
  // boundary therefore counts the same capital twice — once as the original
  // deposit, once as the bridge derived from it — so contributions double and
  // P&L goes as negative as the deposit was large.
  //
  // It never fired because the only agents ever bumped were those with pre-fix
  // rows, and pre-fix rows predate the flows table: epoch 1 held no flows, so a
  // lifetime sum happened to equal the current epoch's. Fund an agent on today's
  // code and bump it for any future reason and the accident stops holding.
  //
  // The web's identical query already carried the predicate (scoreboard
  // route.ts). This is the reader that did not. See accounting-scope.ts.
  const epoch = await epochOf(agentId);
  const row = await getDb()
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
       FROM flows WHERE agent_id = ? AND epoch = ?`,
    )
    .get(agentId, epoch) as { n: number; net: number } | undefined;
  if (!row || row.n === 0) return null;
  return row.net;
}

/**
 * The same epoch-scoped sum, and the part of it booked at or after `sinceSec` —
 * the two halves net-contributions.ts durableNetContributionsUsdg6 needs.
 *
 * `netUsdg` is exactly getNetContributionsUsdg (null when no flow is on record
 * in this epoch). `sinceUsdg` is the signed sum of this epoch's flows whose
 * `at` is at or after `sinceSec` (0 when none): on a hosted child, the flows
 * this process booked after the orchestrator wrote its accounting anchor —
 * which the anchor's own figure cannot contain.
 */
export async function getNetContributionsSince(
  agentId: string,
  sinceSec: number,
): Promise<{ epoch: number; netUsdg: number | null; sinceUsdg: number }> {
  const epoch = await epochOf(agentId);
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net,
              COALESCE(SUM(CASE WHEN at >= ? THEN (CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) ELSE 0 END), 0) AS since
       FROM flows WHERE agent_id = ? AND epoch = ?`,
    )
    .get(Math.floor(sinceSec), agentId, epoch)) as { n: number; net: number; since: number } | undefined;
  const n = Number(row?.n ?? 0);
  return { epoch, netUsdg: n === 0 ? null : Number(row!.net), sinceUsdg: n === 0 ? 0 : Number(row!.since) };
}

/**
 * The evidence behind this epoch's contributions, so a caller can say whether
 * the total is a receipt, a bridge, or an opinion.
 *
 * Returns counts by source rather than a verdict: deciding what counts as
 * evidence is `accounting-scope.ts`'s job, and a store read that also judged
 * would put the policy in two places.
 */
export async function getFlowEvidence(
  agentId: string,
): Promise<{ source: string; n: number; netUsdg: number }[]> {
  const epoch = await epochOf(agentId);
  return (await getDb()
    .prepare(
      `SELECT source,
              COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS netUsdg
       FROM flows WHERE agent_id = ? AND epoch = ? GROUP BY source`,
    )
    .all(agentId, epoch)) as unknown as { source: string; n: number; netUsdg: number }[];
}

/**
 * Persist what this agent may claim about its own book.
 *
 * WRITTEN BY THE WORKER, READ BY EVERYONE ELSE. The web tier cannot see the
 * worker's process memory, and before this it had no way at all to learn that a
 * contribution total rested on inference — so every percentage it published was
 * computed as though the denominator were a receipt.
 *
 * Best-effort: a quality write that fails must never take a tick down. The cost
 * of failure is a stale flag, and `quality_at` is what lets a reader notice.
 */
export async function setAgentQuality(
  agentId: string,
  q: { contributionsKnown: boolean; why: string; gasAccounting: "net" | "gross" | "unknown" },
): Promise<boolean> {
  try {
    await getDb()
      .prepare(
        "UPDATE agents SET contributions_known = ?, contributions_why = ?, gas_accounting = ?, quality_at = ? " +
          "WHERE smart_account = ?",
      )
      .run(q.contributionsKnown ? 1 : 0, q.why.slice(0, 500), q.gasAccounting, Math.floor(Date.now() / 1000), agentId);
    return true;
  } catch {
    return false;
  }
}

/** The last equity figure recorded in a SPECIFIC epoch — what a carry must match. */
export async function closingEquityOfEpoch(agentId: string, epoch: number): Promise<number | null> {
  const row = (await getDb()
    .prepare(
      `SELECT equity_usdg FROM equity WHERE agent_id = ? AND epoch = ?
       ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .get(agentId, epoch)) as { equity_usdg: number } | undefined;
  return row?.equity_usdg ?? null;
}

/**
 * WHAT YOU DECIDED LAST TIME, and what became of it.
 *
 * The strategist has never been able to see this. It wrote a decision every
 * window and read one back never, so window N+1 had no idea what window N
 * thought — it could contradict itself all day and never notice. This is the
 * one read that gives a research session continuity.
 *
 * Joined to the trade the decision caused, because 'I proposed a buy' and 'the
 * wall turned it back' are different memories and only the second is useful.
 */
/**
 * What this agent decided lately.
 *
 * `excludeSources` EXISTS BECAUSE TWO REASONERS SHARE ONE TABLE AND ONE
 * agent_id. Brain writes its shadow decisions into `decisions` under exactly
 * the same `agent_id` the strategist uses, so an unfiltered read hands one
 * reasoner the other's thinking as its own — and the desk's `recall` tool
 * frames what it returns as "what you proposed, what the wall did with it".
 *
 * On the canary, where both are enabled, that produced:
 *
 *     - buy TSLA 5 USDG: no trade came of it — you said: <Brain's thesis>
 *
 * Three separate lies in one line. Nothing was proposed by the strategist;
 * "no trade came of it" says something tried and failed rather than that
 * nothing was ever wired to try; and the strategist could then publish a
 * `strategist`-sourced thesis about a buy it believed it had made — which
 * passes the publication gate with no shadow marking at all, because by then
 * the row genuinely is a strategist row. A laundering path, not a display bug.
 */
export async function recentDecisions(
  agentId: string,
  limit = 6,
  excludeSources: readonly string[] = [],
): Promise<
  {
    at: number;
    action: string | null;
    symbol: string | null;
    size_usdg: number | null;
    reason: string | null;
    dropped_rule: string | null;
    status: string | null;
    reject_rule: string | null;
  }[]
> {
  try {
    const holes = excludeSources.map(() => "?").join(", ");
    return (await getDb()
      .prepare(
        `SELECT d.at AS at, d.action AS action, d.symbol AS symbol, d.size_usdg AS size_usdg,
                d.reason AS reason, d.dropped_rule AS dropped_rule,
                t.status AS status, t.reject_rule AS reject_rule
           FROM decisions d
           LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
          WHERE d.agent_id = ?${excludeSources.length ? ` AND d.source NOT IN (${holes})` : ""}
          ORDER BY d.at DESC
          LIMIT ?`,
      )
      .all(agentId, ...excludeSources, limit)) as never;
  } catch {
    // A ledger without the decisions table yet is an agent with no memory,
    // which is the honest answer for its first window.
    return [];
  }
}

/**
 * The highest block a chain-read flow has been recorded from, or null when
 * none has. This IS the deposit scanner's watermark — it lives in the rows it
 * describes rather than in a table of its own, so it cannot disagree with them.
 */
export async function lastChainLogBlock(agentId: string): Promise<number | null> {
  const row = (await getDb()
    .prepare(
      `SELECT MAX(block_number) AS b FROM flows
        WHERE agent_id = ? AND source = 'chain-log' AND block_number IS NOT NULL`,
    )
    .get(agentId)) as { b: number | null } | undefined;
  return row?.b === null || row?.b === undefined ? null : Number(row.b);
}

/**
 * Flow keys already recorded from block `fromBlock` onward.
 *
 * The scan re-reads its last block every pass — a block can carry several
 * transfers and a crash between two of them would otherwise strand the rest —
 * so this set is what stops the re-read being booked twice.
 */
export async function knownFlowKeys(agentId: string, fromBlock: number): Promise<Set<string>> {
  const rows = (await getDb()
    .prepare(
      `SELECT tx_hash, log_index FROM flows
        WHERE agent_id = ? AND tx_hash IS NOT NULL AND log_index IS NOT NULL
          AND block_number >= ?`,
    )
    .all(agentId, fromBlock)) as { tx_hash: string; log_index: number }[];
  const out = new Set<string>();
  for (const r of rows) out.add(flowKey(r.tx_hash, Number(r.log_index)));
  return out;
}

/**
 * Transaction hashes the ledger already explains as trades.
 *
 * A swap moves USDG, and its Transfer log is a FILL rather than a deposit —
 * booking fills as capital would inflate contributions by the account's whole
 * turnover and drive reported P&L steadily negative. Vault moves are covered
 * too: they are trade rows carrying transaction hashes.
 *
 * `trades` has no block number to filter on, so this is bounded by recency
 * instead. The bound is enormous relative to a scan window — a window is
 * minutes of blocks and this is thousands of fills — so the only thing it
 * really prevents is an unbounded read on a long-lived agent.
 */
export async function recentTradeTxHashes(agentId: string, limit = 2000): Promise<Set<string>> {
  const rows = (await getDb()
    .prepare(
      `SELECT tx_hash FROM trades WHERE agent_id = ? AND tx_hash IS NOT NULL
        ORDER BY id DESC LIMIT ?`,
    )
    .all(agentId, limit)) as { tx_hash: string }[];
  return new Set(rows.map((r) => r.tx_hash.toLowerCase()));
}

/**
 * Total gas paid on landed operations, in wei.
 *
 * Reported SEPARATELY rather than folded into equity, deliberately. Gas leaves
 * the account in ETH and there is no ETH/USD feed configured — only a WETH pool
 * — so converting it would mean inventing a price for the one figure whose job
 * is to be beyond dispute. equity_usdg is cash + vault + positions and excludes
 * ETH entirely, which means realized P&L is GROSS OF GAS; this is the number
 * that says by how much.
 */
/**
 * Gas paid, in USDG, and how much of it could not be priced.
 *
 * The count is the honest half. "Net of gas" is only true if every trade's gas
 * was priceable; when some was not, the figure is net of SOME gas, and a
 * surface that says otherwise is overstating what it knows.
 */
export async function getGasPaidUsdg(
  agentId: string,
  epoch?: number,
): Promise<{ usdg: number; unpricedTrades: number; landedTrades: number; read: boolean }> {
  try {
    const where = epoch === undefined ? "" : " AND epoch = ?";
    const params = epoch === undefined ? [agentId] : [agentId, epoch];
    const row = await getDb()
      .prepare(
        `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                COUNT(*) AS landed,
                SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
           FROM trades WHERE agent_id = ? AND status = 'landed'${where}`,
      )
      .get(...params) as { usdg: number; landed: number | null; unpriced: number | null } | undefined;
    return {
      usdg: row?.usdg ?? 0,
      unpricedTrades: row?.unpriced ?? 0,
      landedTrades: row?.landed ?? 0,
      read: true,
    };
  } catch {
    // A PRE-MIGRATION LEDGER IS NOT A BOOK THAT PAID NO GAS.
    //
    // This used to return `{ usdg: 0, unpricedTrades: 0 }` — byte for byte what
    // a sponsored agent with a dozen landed trades returns — so every consumer
    // that asked "was gas subtracted" got the same answer from a measurement and
    // from a failure. `read: false` is the only thing that can separate them,
    // and it has to come from here: inferring it downstream from the numbers is
    // the bug in a new place. See packages/core/src/gas-basis.ts.
    return { usdg: 0, unpricedTrades: 0, landedTrades: 0, read: false };
  }
}

export async function getGasPaidWei(agentId: string): Promise<bigint> {
  try {
    const rows = await getDb()
      .prepare("SELECT gas_wei FROM trades WHERE agent_id = ? AND gas_wei IS NOT NULL")
      .all(agentId) as { gas_wei: string }[];
    return rows.reduce((sum, r) => {
      try {
        return sum + BigInt(r.gas_wei);
      } catch {
        return sum;
      }
    }, 0n);
  } catch {
    return 0n; // pre-migration ledger
  }
}

/**
 * Cash as of the most recent equity row for this agent's current epoch that was
 * not taken while flow inference was held (see lastKnownCashReading).
 *
 * The worker's in-memory `lastCashUsdg` resets to null on every restart, so
 * without this a top-up made while the worker was stopped is invisible to flow
 * reconciliation — and an invisible deposit is booked as profit and charged a
 * performance fee. This is the durable half of that memory.
 *
 * Returns null when there is no prior observation, which is genuinely different
 * from "cash was zero": a brand-new agent has nothing to compare against.
 */
export async function lastKnownCashUsdg(agentId: string): Promise<number | null> {
  const r = await lastKnownCashReading(agentId);
  return r === null ? null : r.cashUsdg;
}

/**
 * The same reading, AND WHEN ITS CASH WAS READ — the restart's cash baseline and
 * its `since` (flow-inference.ts): an op submitted at or after `at` is not in
 * `cashUsdg`, so its settlement shifts that baseline, and a landed row created
 * at or after it is a write in the downtime interval (landedOpsBetween).
 *
 * `at` IS THE READ, NOT THE WRITE (`cash_read_at`, falling back to the row's
 * INSERT time for rows that predate it). The row is inserted at the END of a
 * tick, after its flow look listed the ledger, and a chat trade can submit an
 * op in between: stamped by the insert, such an op read as already in this
 * cash, so after a restart its settlement was skipped, it was no write either,
 * and its movement was inferred a second time — contributions short by it and
 * a performance fee charged on the owner's own money. An op whose movement IS
 * in the cash landed before the read, so it was either in flight at the list
 * (that tick held, and its row is skipped below) or already recorded.
 *
 * NEVER A HELD READING. A tick whose flow look held writes its row flagged
 * `flows_held` (command-wake.ts tickRatchets `held`), and it is skipped here:
 * its cash may already carry a stranded op's movement, which the op's
 * settlement would then shift a second time. So this is always a reading taken
 * with no op in flight.
 */
export async function lastKnownCashReading(agentId: string): Promise<{ cashUsdg: number; at: number } | null> {
  try {
    const epoch = await epochOf(agentId);
    const row = await getDb()
      .prepare(
        // Ordered by the INSERT (`at`, id) as always — the alias is `read_at`
        // so ORDER BY cannot resolve to it on either engine.
        `SELECT cash_usdg, COALESCE(cash_read_at, at) AS read_at FROM equity
          WHERE agent_id = ? AND epoch = ? AND COALESCE(flows_held, 0) = 0
          ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(agentId, epoch) as { cash_usdg: number; read_at: number } | undefined;
    return row ? { cashUsdg: Number(row.cash_usdg), at: Number(row.read_at) } : null;
  } catch {
    return null;
  }
}

/**
 * THE BLOCK THAT SAME READING'S CASH WAS READ AT — the payout cursor's start
 * (docs/perps.md rule 12: payouts are folded against block-pinned reads). The
 * very row lastKnownCashReading returns, so the cash and its block are one
 * observation. A separate function rather than a third field on that one,
 * whose shape a dozen restart tests pin.
 *
 * NULL is "not known", for three different reasons a caller must treat alike:
 * no reading, a reading from before the column existed, or a failed read. A
 * payout fold with no block infers nothing (rule 11).
 */
export async function lastKnownCashReadBlock(agentId: string): Promise<number | null> {
  try {
    const epoch = await epochOf(agentId);
    const row = (await getDb()
      .prepare(
        `SELECT cash_read_block FROM equity
          WHERE agent_id = ? AND epoch = ? AND COALESCE(flows_held, 0) = 0
          ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(agentId, epoch)) as { cash_read_block: number | null } | undefined;
    return row && row.cash_read_block !== null && row.cash_read_block !== undefined ? Number(row.cash_read_block) : null;
  } catch {
    return null;
  }
}

/**
 * THE LEDGER WRITES AN EARLIER PROCESS MADE after a cash reading: the op hashes
 * (lowercased; null for a row without one) of this epoch's LANDED rows
 * created in [fromSec, beforeSec).
 *
 * The durable half of `ledgerWrites` for the first look after a restart. That
 * counter is process memory and starts at 0, so a fill the last process
 * recorded after its final equity row — or a stranded op its resolver settled
 * before it stopped — was invisible, and its cash leg was booked as money
 * "changed while the worker was stopped". The caller drops the hashes its own
 * resolver settled (those explain exactly their own movement) and treats any
 * other as a write in the interval. `fromSec` is when the reading's cash was
 * READ (lastKnownCashReading), so a fill recorded mid-tick — after the read,
 * before that tick's row was inserted — is inside the interval too.
 *
 * THROWS WHEN THE QUESTION COULD NOT BE ASKED, like listSubmittedOps: an
 * unreadable ledger is not an empty one, and the caller's pass must abort and
 * retry rather than infer on it.
 */
export async function landedOpsBetween(agentId: string, fromSec: number, beforeSec: number): Promise<(string | null)[]> {
  const epoch = await epochOf(agentId);
  const rows = (await getDb()
    .prepare(
      `SELECT user_op_hash FROM trades
        WHERE agent_id = ? AND epoch = ? AND status = 'landed' AND created_at >= ? AND created_at < ?`,
    )
    .all(agentId, epoch, fromSec, beforeSec)) as { user_op_hash: string | null }[];
  return rows.map((r) => (r.user_op_hash ? r.user_op_hash.toLowerCase() : null));
}

/**
 * The last composed equity reading in the agent's CURRENT epoch, or null.
 *
 * Used at an epoch boundary to say how much capital is present, so the opening
 * balance and the equity reading that follows it live in the same frame. null
 * means no observation exists — which is not zero, and at a boundary means the
 * new epoch simply opens with no contributions on record rather than with a
 * fabricated one.
 */
export async function lastKnownEquityUsdg(agentId: string): Promise<number | null> {
  try {
    const epoch = await epochOf(agentId);
    const row = await getDb()
      .prepare(
        "SELECT equity_usdg FROM equity WHERE agent_id = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(agentId, epoch) as { equity_usdg: number } | undefined;
    return row ? row.equity_usdg : null;
  } catch {
    return null;
  }
}

/** The flow record itself, newest first — for the audit export and /pnl's detail line. */
export async function listFlows(agentId: string, limit = 200): Promise<
  { direction: string; amount_usdg: number; source: string; tx_hash: string | null; at: number }[]
> {
  return await getDb()
    .prepare(
      `SELECT direction, amount_usdg, source, tx_hash, at FROM flows
       WHERE agent_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(agentId, limit) as {
    direction: string;
    amount_usdg: number;
    source: string;
    tx_hash: string | null;
    at: number;
  }[];
}

/** A command the dashboard has asked this agent to run. */
export interface AgentCommand {
  id: string;
  kind: string;
  createdAt: number;
}

/**
 * Enqueue one command. Called by the web process, drained by the worker.
 *
 * The id is the caller's, so a double-clicked button is one command rather
 * than two — the primary key does the deduping rather than a check-then-insert
 * that could interleave.
 */
export async function enqueueCommand(agentId: string, id: string, kind: string): Promise<boolean> {
  try {
    await getDb()
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
      .run(id, agentId, kind, Date.now());
    return true;
  } catch {
    return false; // duplicate id, or an unwritable ledger
  }
}

/**
 * Claim the oldest unclaimed command for this agent, or null.
 *
 * CLAIM THEN ACT, never act then mark. The UPDATE ... WHERE claimed_at IS NULL
 * is the whole concurrency story: two drains racing the same row, one wins,
 * and a crash after the claim leaves it claimed rather than replayed. A
 * command that spends gas must be at-most-once, and a poller gives no other
 * way to get there.
 */
export async function claimCommand(agentId: string): Promise<AgentCommand | null> {
  try {
    const row = (await getDb()
      .prepare(
        // ORDERED BY (time, id), never by time alone. Milliseconds fixed the
        // one-second collisions, and CI — on a faster machine than mine —
        // found the next layer: two commands really can land in the SAME
        // millisecond, and neither backend has a portable insertion-order
        // tiebreak (sqlite's rowid is not in Postgres). The id is a uuid, so
        // ties break arbitrarily but CONSISTENTLY, which is all a queue needs
        // — and it makes claim and latestCommand agree about which one is
        // which instead of each picking its own.
        `SELECT id, kind, created_at FROM agent_commands
          WHERE agent_id = ? AND claimed_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(agentId)) as { id: string; kind: string; created_at: number } | undefined;
    if (!row) return null;
    const claim = await getDb()
      .prepare("UPDATE agent_commands SET claimed_at = unixepoch() WHERE id = ? AND claimed_at IS NULL")
      .run(row.id);
    if (claim.changes === 0) return null; // somebody else took it
    return { id: row.id, kind: row.kind, createdAt: Number(row.created_at) };
  } catch {
    return null;
  }
}

/** Record what a claimed command did. Never re-runs it; this is only the tape. */
export async function finishCommand(id: string, result: string): Promise<void> {
  try {
    await getDb()
      .prepare("UPDATE agent_commands SET done_at = unixepoch(), result = ? WHERE id = ?")
      .run(result.slice(0, 500), id);
  } catch {
    /* the command ran; losing its receipt must not re-run it */
  }
}

/** The most recent command for this agent, for the dashboard to poll. */
export async function latestCommand(
  agentId: string,
): Promise<{ id: string; kind: string; createdAt: number; claimedAt: number | null; doneAt: number | null; result: string | null } | null> {
  try {
    const r = (await getDb()
      .prepare(
        // The mirror image of claimCommand's ordering — see there.
        `SELECT id, kind, created_at, claimed_at, done_at, result FROM agent_commands
          WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(agentId)) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      kind: String(r.kind),
      createdAt: Number(r.created_at),
      claimedAt: r.claimed_at === null || r.claimed_at === undefined ? null : Number(r.claimed_at),
      doneAt: r.done_at === null || r.done_at === undefined ? null : Number(r.done_at),
      result: r.result === null || r.result === undefined ? null : String(r.result),
    };
  } catch {
    return null;
  }
}
/**
 * Record what the worker is doing, for surfaces that cannot read its files.
 *
 * Best-effort by design: a heartbeat that fails to write must never take the
 * tick down with it. Called every tick, so it is a plain UPDATE on a primary
 * key — no journal, no epoch, nothing derived from it.
 */
export async function setAgentMode(
  agentId: string,
  mode: "paper" | "live" | "idle",
  atSec: number,
  /**
   * Whether a sponsor is paying this agent's TRADING gas, as this worker
   * resolved it. Travels with the heartbeat because it is the same kind of fact
   * — something only the child knows — and the dashboard has no other way to
   * learn it. Withdrawal is never sponsored, whatever this says.
   */
  sponsorGas: boolean,
  /**
   * What is stopping this agent trading for real, as the child resolved it, or
   * null when nothing is.
   *
   * PUBLISHED BECAUSE THE SCREEN THAT CAN FIX IT COULD NOT SEE IT. The child
   * already writes a sentence per change (`liveBlockerText`), but a funding
   * panel cannot read an event stream — so an owner whose agent was short of
   * ETH was reading "Send USDG to your agent's account" and doing exactly that.
   *
   * Null is TWO answers, and a reader must render neither as a blocker: never
   * beaten, or beaten and trading for real.
   */
  blocker: string | null = null,
): Promise<void> {
  try {
    await getDb()
      .prepare(
        "UPDATE agents SET mode = ?, beat_at = ?, sponsor_gas = ?, live_blocker = ? WHERE smart_account = ?",
      )
      .run(mode, atSec, sponsorGas ? 1 : 0, blocker, agentId);
  } catch {
    /* a missing heartbeat is a worse thing to crash over than to lose */
  }
}
/**
 * Publish the worker's energy report (core EnergyStatus, as JSON) on the agents
 * row. Best-effort like the heartbeat: a report that fails to write must never
 * take a tick down — the next tick writes a fresh one.
 */
export async function setAgentEnergy(agentId: string, json: string | null): Promise<void> {
  try {
    await getDb().prepare("UPDATE agents SET energy = ? WHERE smart_account = ?").run(json, agentId);
  } catch {
    /* the next tick reports again */
  }
}

/**
 * Publish the worker's perps report (core PerpsReport, as JSON) on the agents
 * row — setAgentEnergy's twin, best-effort for the same reason: a report that
 * fails to write must never take a tick or a protective pass down, and the
 * next one writes a fresh one.
 */
export async function setAgentPerps(agentId: string, json: string | null): Promise<void> {
  try {
    await getDb().prepare("UPDATE agents SET perps = ? WHERE smart_account = ?").run(json, agentId);
  } catch {
    /* the next pass reports again */
  }
}

// ── ENERGY: today's durable counters (energy-days.ts), on this child's ledger ──
//
// Every one of these fails in the SAFE direction for its own question: an
// unreadable day is `null` (the plan then fails closed on new work, never on
// an exit), a claim that errors is refused, a notice claim that errors is not
// sent, and a refund or a read-note that errors only under-spends.

/**
 * Today's counters; zeros when there is no row; null when the ledger could not
 * be read — OR when this is a day whose history the orchestrator could not put
 * back after a rebuild (energy-seed.ts). The table is empty then, but empty is
 * not "nothing used": the day's durable counts are somewhere this child cannot
 * see, and reading zeros would hand out the day's allowance again.
 */
export async function getEnergyDay(agentId: string, day: string): Promise<EnergyCounters | null> {
  if (energyDayUnrestored(merrymenHome(), day)) return null;
  try {
    return await readEnergyDay(getDb(), agentId, day);
  } catch {
    return null;
  }
}

/** Claim one review or entry against `cap`. False when the cap is reached — or the write failed. */
export async function claimEnergy(agentId: string, day: string, field: EnergyField, cap: number): Promise<boolean> {
  try {
    return await claimEnergyDay(getDb(), agentId, day, field, cap);
  } catch {
    return false;
  }
}

/**
 * Return one unused ENTRY claim. Never below zero. Entries only: a review that
 * ran was paid for, and so is never given back.
 */
export async function refundEnergy(agentId: string, day: string, _field: "entries"): Promise<void> {
  try {
    await refundEnergyDay(getDb(), agentId, day);
  } catch {
    /* a lost refund under-spends by one — the conservative direction */
  }
}

/** Claim today's owner notice. True exactly once per agent per UTC day; false on any failure. */
export async function claimEnergyNotice(agentId: string, day: string, atSec: number): Promise<boolean> {
  try {
    return await claimEnergyNoticeDay(getDb(), agentId, day, atSec);
  } catch {
    return false;
  }
}

/** Remember a balance reading that decided the level. */
export async function noteEnergyRead(agentId: string, day: string, full: boolean, atSec: number): Promise<void> {
  try {
    await noteEnergyReadDay(getDb(), agentId, day, full, atSec);
  } catch {
    /* the in-memory reading still stands for this process */
  }
}

/** The newest decided reading since `sinceSec`, or null. */
export async function lastEnergyRead(agentId: string, sinceSec: number): Promise<LastGood | null> {
  try {
    return await lastEnergyReadDay(getDb(), agentId, sinceSec);
  } catch {
    return null;
  }
}

/** Record one accrual event and roll it into the agent's running total. */
export async function addFeeAccrual(
  agentId: string,
  a: { profitUsdg: number; feeUsdg: number; hwmBeforeUsdg: number; hwmAfterUsdg: number },
): Promise<boolean> {
  try {
    const epoch = await epochOf(agentId);
    await journaled(agentId, epoch, "fee", { ...a, epoch }, async (db: Db) => {
      await db
        .prepare(
          `INSERT INTO fee_accruals (agent_id, profit_usdg, fee_usdg, hwm_before_usdg, hwm_after_usdg, epoch)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(agentId, a.profitUsdg, a.feeUsdg, a.hwmBeforeUsdg, a.hwmAfterUsdg, epoch);
      await db
        .prepare("UPDATE agents SET accrued_fee_usdg = accrued_fee_usdg + ? WHERE smart_account = ?")
        .run(a.feeUsdg, agentId);
    });
    return true;
  } catch (e) {
    console.error("[store] fee accrual failed:", e);
    return false;
  }
}

/**
 * `error` is the state that was missing, and its absence had a cost.
 *
 * An agent that cannot arm — an unrecognised policy in its grant, a corrupt
 * blob, a permission id that will not reproduce — was indistinguishable from
 * one that had simply never started. The condition lived in a stack trace on
 * stdout and nowhere a dashboard, a query or an operator could reach it.
 */
export async function setAgentStatus(
  agentId: string,
  status: "armed" | "active" | "killed" | "expired" | "error",
): Promise<void> {
  try {
    await getDb().prepare("UPDATE agents SET status = ? WHERE smart_account = ?").run(status, agentId);
  } catch (e) {
    console.error("[store] status update failed:", e);
  }
}

/**
 * Record what an agent said about one trade.
 *
 * Returns whether THIS call wrote the row. False covers both "a post already
 * existed for that decision" and "the write failed", and the caller treats them
 * the same way — neither is a reason to try again with a second model call, and
 * a duplicate post is the failure this is guarding against in the first place.
 */
export async function addPost(agentId: string, decisionId: string, body: string): Promise<boolean> {
  try {
    await getDb()
      .prepare(
        // The conflict target is `decision_id`, not `id`: one trade, one post,
        // however many times the arm that writes it runs.
        "INSERT INTO posts (agent_id, decision_id, body) VALUES (?, ?, ?) ON CONFLICT (decision_id) DO NOTHING",
      )
      .run(agentId, decisionId, body);
    return true;
  } catch (e) {
    console.error("[store] post insert failed:", e);
    return false;
  }
}

/**
 * The fact layer behind one decision, read back at fill time.
 *
 * READ BACK RATHER THAN CARRIED. The evidence is in hand when the intent is
 * built, several steps before the fill lands, and threading it through the
 * executor would mean the trading path carries a payload only the feed uses.
 * The decision id is already on the trade row, so the join exists; this also
 * makes the round trip through storage a thing the tests can exercise rather
 * than a thing we assume works.
 *
 * Null covers absent, unreadable and not-a-class-decision alike — all three mean
 * "no post", which is a normal outcome.
 */
/**
 * WHO OWNS THIS DECISION — the guard behind reusing a supplied id.
 *
 * Three answers, and collapsing any two of them is the bug this exists to
 * prevent:
 *
 *   a string  — the agent this decision belongs to.
 *   null      — no such decision. An id that names nothing.
 *   undefined — WE COULD NOT READ. A database that will not answer must never
 *               be taken as "nobody owns it", because the caller's next move on
 *               that answer is to attach a trade.
 *
 * `null` and `undefined` carry the same refusal today, and they are still kept
 * apart: the operator log says which, and a later reader that wants to retry a
 * read failure but not a missing row can tell them apart without a new query.
 */
export async function decisionAgent(decisionId: string): Promise<string | null | undefined> {
  try {
    const r = (await getDb()
      .prepare("SELECT agent_id FROM decisions WHERE id = ? LIMIT 1")
      .get(decisionId)) as { agent_id: string } | undefined;
    return r ? String(r.agent_id) : null;
  } catch {
    return undefined;
  }
}

/** Owner-side lifecycle reader. Public callers must apply the publication policy. */
export async function lifecycleOf(decisionId: string): Promise<DecisionLifecycle | null> {
  try {
    return await readDecisionLifecycle(getDb(), decisionId);
  } catch {
    return null;
  }
}
export async function decisionEvidence(decisionId: string): Promise<string | null> {
  try {
    const r = (await getDb()
      .prepare("SELECT evidence_json FROM decisions WHERE id = ? LIMIT 1")
      .get(decisionId)) as { evidence_json: string | null } | undefined;
    return r?.evidence_json ?? null;
  } catch {
    return null;
  }
}

/** Has this decision already been spoken about? Null on a read failure. */
export async function hasPost(decisionId: string): Promise<boolean | null> {
  try {
    const r = (await getDb()
      .prepare("SELECT 1 AS hit FROM posts WHERE decision_id = ? LIMIT 1")
      .get(decisionId)) as { hit: number } | undefined;
    return r !== undefined;
  } catch {
    // UNKNOWN IS NOT "NO". A read failure here must not authorise a second post
    // about a trade that already has one — the caller skips rather than writes.
    return null;
  }
}

/**
 * An agent's own recent posts, newest first.
 *
 * Read by the writer so it can avoid repeating itself. The feed already groups
 * byte-identical prose into one row, so what this guards is the NEAR-duplicate:
 * the same sentence with a different ticker in it, which is exactly what one
 * agent printing 27 template rows down the feed looks like.
 */
export async function recentPosts(agentId: string, limit: number): Promise<string[]> {
  try {
    const rows = (await getDb()
      .prepare("SELECT body FROM posts WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(agentId, limit)) as { body: string }[];
    return rows.map((r) => r.body);
  } catch {
    return [];
  }
}

export async function addEvent(
  agentId: string,
  level: "ok" | "warn" | "err",
  message: string,
): Promise<void> {
  try {
    await getDb()
      .prepare("INSERT INTO events (agent_id, level, message) VALUES (?, ?, ?)")
      .run(agentId, level, message);
  } catch (e) {
    console.error("[store] event insert failed:", e);
  }
}

/**
 * How many of an agent's newest events its owner's notice is chosen from — the
 * LIMIT web/src/app/api/feed/route.ts reads them with.
 */
export const OWNER_NOTICE_WINDOW = 40;

/**
 * THE NOTICE THE OWNER'S SURFACES SHOW FOR THIS AGENT, by their own rule.
 *
 * The desk reads the agent's newest OWNER_NOTICE_WINDOW events, newest first by
 * (created_at, id) — api/feed/route.ts — and shows the first warn or err with a
 * message (terminal/live.ts mineOf; android Core.kt does the same). The rail
 * reads the same feed. So this is what the owner is reading right now, asked of
 * the table the child writes — which the mirror copies to the desk's database
 * row for row. Events another process writes straight into the shared one (the
 * orchestrator's) are not here; this is the child's own view of its notice.
 *
 * Null when nothing shows. UNDEFINED WHEN THE READ FAILED — unread is not
 * "nothing shows", and a caller that acts on it writes a line it did not need.
 */
export async function ownerNotice(agentId: string): Promise<{ message: string; atMs: number } | null | undefined> {
  try {
    const rows = (await getDb()
      .prepare(
        `SELECT level, message, created_at FROM events
          WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ${OWNER_NOTICE_WINDOW}`,
      )
      .all(agentId)) as { level: string; message: string | null; created_at: number | string }[];
    const shown = rows.find((r) => (r.level === "warn" || r.level === "err" || r.level === "error") && !!r.message);
    return shown ? { message: shown.message!, atMs: Number(shown.created_at) * 1000 } : null;
  } catch {
    return undefined;
  }
}

/**
 * THE COIN'S NAME, STORED WITH THE FILL — display only.
 *
 * A trade row names its coin by address alone, so every reader had to find a
 * word for it later, and after a redeploy wiped the ledger the dashboard and
 * the chat had nothing to find it in. Written here — the one function every
 * trades row passes through — for the rows that are fills (or about to be):
 * the address's curated ticker, else the decision behind the trade, else what
 * discovery read off the coin, through fillSymbolFor's impersonation guard.
 *
 * NEVER COSTS THE ROW. addTrade returning false sends the caller down its
 * fail-closed path; an unreadable name must only ever cost the name.
 */
async function fillSymbolOfRow(row: TradeRow): Promise<string | null> {
  try {
    if (row.status !== "landed" && row.status !== "paper" && row.status !== "submitted") return null;
    const coin = nonCashLeg(row);
    if (!coin) return null;
    const trusted = fillSymbolFor(coin, []);
    if (trusted) return trusted;
    const names: (string | null)[] = [];
    if (row.decision_id) {
      const d = (await getDb()
        .prepare("SELECT symbol, display_name FROM decisions WHERE id = ? AND agent_id = ?")
        .get(row.decision_id, row.agent_id)) as { symbol: string | null; display_name: string | null } | undefined;
      names.push(d?.symbol ?? null, d?.display_name ?? null);
    }
    const p = (await getDb().prepare("SELECT symbol FROM discovered_pools WHERE address = ?").get(coin)) as { symbol: string | null } | undefined;
    names.push(p?.symbol ?? null);
    return fillSymbolFor(coin, names);
  } catch {
    return null;
  }
}

/**
 * Write a trade row. Returns TRUE if it was persisted, FALSE if the write was
 * caught and swallowed — the caller must not mistake a swallowed failure for a
 * recorded fill. On a network-backed ledger a write can fail routinely, and a
 * dropped money-moving row silently UNDER-counts getSpentTodayUsdg on the next
 * budget refresh, loosening the daily cap (the unsafe direction). The caller
 * (processIntent.recordTrade) fails CLOSED on a false: it books the spend into
 * the settled counters directly and raises a durable alarm instead of letting
 * the reservation release drop it.
 */
export async function addTrade(row: TradeRow): Promise<boolean> {
  try {
    const epoch = await epochOf(row.agent_id);
    // Before any write, and outside the journal's transaction: two reads at most.
    const fillSymbol = row.fill_symbol ?? (await fillSymbolOfRow(row));
    // Only money-moving rows enter the hash chain. A rejection changes no
    // balance, so its absence cannot distort a performance claim — and there
    // are thousands of them. They stay in `trades` (and in the export, as
    // context) without being part of the tamper-evident record.
    const moved = row.status === "landed" || row.status === "paper";
    const writeRow = async (db: Db) => {
      // RESOLVE THE PRE-BROADCAST ROW, if there is one.
      //
      // executor.execute writes a 'submitted' row the instant the op leaves,
      // before the receipt wait, so an unclean death cannot lose the hash. The
      // outcome then arrives HERE, and inserting would leave two rows for one
      // operation — the second of which counts against the daily cap twice.
      // So the placeholder is updated in place, and only ever from 'submitted'.
      //
      // Scoped to (agent_id, user_op_hash, status='submitted') on purpose: a
      // hash is unique to an operation, and the status clause means a settled
      // row can never be rewritten by a late duplicate. No match falls through
      // to the INSERT below, which is the ordinary path for every row that had
      // no in-flight phase — rejections, paper fills, submit failures.
      if (row.user_op_hash) {
        const res = await db
          .prepare(
            `UPDATE trades
                SET kind = ?, target = ?, sell_token = ?, buy_token = ?, amount_usdg = ?, tx_hash = ?,
                    status = ?, reject_rule = ?, sim_quote_out = ?, sim_min_out = ?, sim_fee_tier = ?,
                    sim_gas = ?, decision_id = ?, fill_side = ?, fill_qty_raw = ?, fill_price_usd = ?,
                    realized_pnl_usdg = ?, basis_source = ?, order_id = ?, settlement_status = ?,
                    gas_wei = ?, fill_slippage_bps = ?, fill_cash_usdg = ?, gas_usdg = ?, gas_units = ?,
                    fill_symbol = COALESCE(?, fill_symbol)
              WHERE agent_id = ? AND user_op_hash = ? AND status = 'submitted'`,
          )
          .run(
            row.kind,
            row.target,
            row.sell_token ?? null,
            row.buy_token ?? null,
            row.amount_usdg,
            row.tx_hash ?? null,
            row.status,
            row.reject_rule ?? null,
            row.sim_quote_out ?? null,
            row.sim_min_out ?? null,
            row.sim_fee_tier ?? null,
            row.sim_gas ?? null,
            row.decision_id ?? null,
            row.fill_side ?? null,
            row.fill_qty_raw ?? null,
            row.fill_price_usd ?? null,
            row.realized_pnl_usdg ?? null,
            row.basis_source ?? null,
            row.order_id ?? null,
            row.settlement_status ?? null,
            row.gas_wei ?? null,
            row.fill_slippage_bps ?? null,
            row.fill_cash_usdg ?? null,
            row.gas_usdg ?? null,
            row.gas_units ?? null,
            // COALESCE: a resolution that knows no name (a stranded op resolved
            // from its receipt) keeps the one the placeholder was written with.
            fillSymbol,
            row.agent_id,
            row.user_op_hash,
          );
        // The epoch is deliberately NOT rewritten: the row belongs to the epoch
        // it was submitted in, and moving it would make the export's boundary
        // disagree with the chain's ordering.
        if (res.changes > 0) return;
      }
      await db
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule,
                             sim_quote_out, sim_min_out, sim_fee_tier, sim_gas, decision_id,
                             fill_side, fill_qty_raw, fill_price_usd, realized_pnl_usdg, basis_source,
                             order_id, settlement_status, gas_wei, fill_slippage_bps, epoch, fill_cash_usdg, gas_usdg, gas_units,
                             trade_fee_usdg, fill_symbol, user_op_nonce)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.agent_id,
        row.kind,
        row.target,
        row.sell_token ?? null,
        row.buy_token ?? null,
        row.amount_usdg,
        row.user_op_hash ?? null,
        row.tx_hash ?? null,
        row.status,
        row.reject_rule ?? null,
        row.sim_quote_out ?? null,
        row.sim_min_out ?? null,
        row.sim_fee_tier ?? null,
        row.sim_gas ?? null,
        row.decision_id ?? null,
        row.fill_side ?? null,
        row.fill_qty_raw ?? null,
        row.fill_price_usd ?? null,
        row.realized_pnl_usdg ?? null,
        row.basis_source ?? null,
        row.order_id ?? null,
        row.settlement_status ?? null,
        row.gas_wei ?? null,
        row.fill_slippage_bps ?? null,
        epoch,
        row.fill_cash_usdg ?? null,
        row.gas_usdg ?? null,
        row.gas_units ?? null,
        // `?? null`, never `?? 0`: an unassessed fee and a zero fee are
        // different claims, and only one of them is about the trade.
        row.trade_fee_usdg ?? null,
        fillSymbol,
        row.user_op_nonce ?? null,
      );
    };
    if (!moved) {
      await writeRow(getDb());
      return true;
    }
    await journaled(
      row.agent_id,
      epoch,
      "fill",
      {
        amountUsdg: row.amount_usdg,
        basisSource: row.basis_source ?? null,
        buyToken: row.buy_token ?? null,
        decisionId: row.decision_id ?? null,
        // Both legs, explicitly. An auditor checks the QUANTITY against the
        // stock-token movement and the CASH against the USDG movement, and
        // deriving cash from price × qty would compare a rounded product
        // against an exact on-chain figure and report a mismatch that isn't one.
        fillCashUsdg: row.fill_cash_usdg ?? null,
        fillPriceUsd: row.fill_price_usd ?? null,
        fillQtyRaw: row.fill_qty_raw ?? null,
        fillSide: row.fill_side ?? null,
        gasUsdg: row.gas_usdg ?? null,
        gasWei: row.gas_wei ?? null,
        kind: row.kind,
        realizedPnlUsdg: row.realized_pnl_usdg ?? null,
        sellToken: row.sell_token ?? null,
        slippageBps: row.fill_slippage_bps ?? null,
        status: row.status,
        target: row.target,
        txHash: row.tx_hash ?? null,
        userOpHash: row.user_op_hash ?? null,
      },
      writeRow,
    );
    return true;
  } catch (e) {
    console.error("[store] trade insert failed:", e);
    return false;
  }
}

export async function addEquity(
  agentId: string,
  b: {
    ethWei: bigint;
    cashUsdg: number;
    vaultUsdg: number;
    positionsUsdg: number;
    /**
     * The composed total. REQUIRED, and not re-derived here.
     *
     * This function used to compute `cash + vault + positions` itself while the
     * caller judged fees and the drawdown breaker against a figure that also
     * included quarantined cost — so the curve every surface reads sat below the
     * number the performance fee ratcheted on, by exactly the quarantined
     * amount, forever. One definition, in equity.composeEquityUsdg, passed in.
     */
    equityUsdg: number;
    /**
     * The fourth term of that composition, recorded so the total can be CHECKED.
     *
     * `composeEquityUsdg` is cash + vault + positions + quarantinedCost, and the
     * journal carried only the first three beside the total. That is enough to
     * publish a number and not enough to verify one: an auditor summing what is
     * written finds a discrepancy exactly equal to the quarantined cost and
     * cannot tell it from a book that does not add up. Writing the term makes the
     * identity closed.
     *
     * Optional because every mark written before this existed lacks it, and the
     * verifier must treat those as UNCHECKABLE rather than as zero — assuming
     * zero is how the missing term became invisible in the first place.
     */
    quarantinedCostUsdg?: number;
    /**
     * The prices this valuation was made at, and how good each one is.
     *
     * Without them a historical equity figure cannot be re-derived by anyone,
     * including us: `positions` carries price/source/staleness but is UPSERTED
     * every tick, so each snapshot destroys the last. The equity row kept only
     * the resulting scalar, which is an assertion, not a derivation.
     */
    marks?: readonly { symbol: string; priceUsd: number; source: string; stale: boolean }[];
    /** Block the balances were read at — the anchor an auditor re-reads from. */
    blockNumber?: bigint;
    /**
     * WHICH BOOK THIS MARK IS OF. REQUIRED — see the column comment.
     *
     * Not defaulted, because the whole failure was two books sharing a series
     * with nothing saying which was which, and a default is how that happens
     * again. The caller already knows: it read one book or the other a few
     * lines earlier.
     */
    mode: "paper" | "live";
    /**
     * TAKEN WHILE FLOW INFERENCE WAS HELD (command-wake.ts tickRatchets
     * `held`). A true valuation, but not a cash baseline: see the `flows_held`
     * column. Written 1 or 0, and journalled only when true, so every other
     * mark's evidence reads exactly as it did.
     */
    flowsHeld?: boolean;
    /**
     * WHEN THE CASH WAS READ, unix seconds — the tick's balance read. What a
     * restart takes as this reading's `since` (lastKnownCashReading); the row's
     * own `at` is the insert, which a mid-tick op can precede.
     */
    cashReadAt?: number;
    /**
     * THE VENUE'S TERMS OF THE COMPOSITION (rule 12), written beside the total
     * for the same reason as quarantinedCostUsdg: so the identity closes.
     * perpAccountUsdg = collateral + isolatedMargin + unrealized + inTransit,
     * all integer micro-USDG, C/M/U from ONE /account response whose
     * transaction_time (µs) is `snapshotTime`. `unrealizedGainMicro` is
     * Σ max(0, U_i) per position — what every peak subtracts (peakBasis), and
     * what a checkpoint's HWM rebuild takes back off.
     *
     * Absent means this mark carried no perp term, and then nothing is
     * written: the columns stay NULL and the journal payload is byte-identical
     * to every mark before perps existed. A KNOWN zero (an agent with no perps
     * marker, rule 11) is passed as zeros and recorded as zeros.
     */
    perp?: {
      collateralMicro: bigint;
      isolatedMarginMicro: bigint;
      unrealizedMicro: bigint;
      unrealizedGainMicro: bigint;
      inTransitMicro: bigint;
      snapshotTime: number | null;
    };
    /**
     * The block the cash was read AT (inclusive): the Multicall getBlockNumber
     * read in the same aggregate as balanceOf. Payouts (WithdrawPending to this
     * account) are folded against it, so it is recorded with the reading.
     */
    cashReadBlock?: bigint | number;
  },
): Promise<void> {
  try {
    const epoch = await epochOf(agentId);
    // Canonical text, validated BEFORE the transaction: a malformed term is no
    // equity row at all (rule 11), never a row whose terms do not add up.
    const perp = b.perp
      ? {
          collateralMicro: intText(b.perp.collateralMicro, "perp collateral"),
          isolatedMarginMicro: intText(b.perp.isolatedMarginMicro, "perp isolated margin", { min: 0n }),
          unrealizedMicro: intText(b.perp.unrealizedMicro, "perp unrealized"),
          unrealizedGainMicro: intText(b.perp.unrealizedGainMicro, "perp unrealized gain", { min: 0n }),
          inTransitMicro: intText(b.perp.inTransitMicro, "perp in transit", { min: 0n }),
          snapshotTime: b.perp.snapshotTime === null ? null : Number(intText(b.perp.snapshotTime, "perp snapshot time", { min: 0n })),
        }
      : null;
    const cashReadBlock = b.cashReadBlock === undefined ? null : Number(intText(b.cashReadBlock, "cash read block", { min: 0n }));
    await journaled(
      agentId,
      epoch,
      "mark",
      {
        blockNumber: b.blockNumber?.toString() ?? null,
        cashUsdg: b.cashUsdg,
        equityUsdg: b.equityUsdg,
        ethWei: b.ethWei.toString(),
        // Only when held: undefined is dropped by canonicalJson's stringify.
        flowsHeld: b.flowsHeld === true ? true : undefined,
        marks: (b.marks ?? []).map((m) => ({
          priceUsd: m.priceUsd,
          source: m.source,
          stale: m.stale,
          symbol: m.symbol,
        })),
        // WHICH BOOK, in the evidence as well as in the row. An auditor
        // re-deriving a mark needs to know whether they are re-deriving a
        // simulation; a journal that cannot say is a journal of two books.
        mode: b.mode,
        positionsUsdg: b.positionsUsdg,
        // Written only when the caller knows it, so an auditor can tell "there
        // was none" from "nobody said". Undefined is dropped by JSON.stringify,
        // which is exactly the distinction we want on the wire.
        quarantinedCostUsdg: b.quarantinedCostUsdg,
        vaultUsdg: b.vaultUsdg,
        // Only when the caller passed them — undefined is dropped, so a mark
        // with no perp term hashes exactly as it did before perps existed.
        // Strings, because the terms are micro-USDG integers and a verifier
        // must not meet them as floats.
        cashReadBlock: cashReadBlock ?? undefined,
        perpCollateralMicro: perp?.collateralMicro,
        perpInTransitMicro: perp?.inTransitMicro,
        perpIsolatedMarginMicro: perp?.isolatedMarginMicro,
        perpSnapshotTime: perp ? perp.snapshotTime : undefined,
        perpUnrealizedGainMicro: perp?.unrealizedGainMicro,
        perpUnrealizedMicro: perp?.unrealizedMicro,
      },
      async (db: Db) => {
        await db
          .prepare(
            `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at,
                                 perp_collateral_micro, perp_isolated_margin_micro, perp_unrealized_micro,
                                 perp_unrealized_gain_micro, perp_in_transit_micro, perp_snapshot_time, cash_read_block)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            agentId,
            b.ethWei.toString(),
            b.cashUsdg,
            b.vaultUsdg,
            b.positionsUsdg,
            b.equityUsdg,
            epoch,
            b.mode,
            b.flowsHeld === true ? 1 : 0,
            b.cashReadAt ?? null,
            perp?.collateralMicro ?? null,
            perp?.isolatedMarginMicro ?? null,
            perp?.unrealizedMicro ?? null,
            perp?.unrealizedGainMicro ?? null,
            perp?.inTransitMicro ?? null,
            perp?.snapshotTime ?? null,
            cashReadBlock,
          );
      },
    );
  } catch (e) {
    console.error("[store] equity insert failed:", e);
  }
}

/** Latest holdings snapshot — replaces, then prunes symbols no longer held. */
export async function setPositions(
  agentId: string,
  positions: readonly {
    symbol: string;
    token: string;
    rawBalance: bigint;
    uiMultiplier: bigint;
    priceUsd: number;
    priceStale: boolean;
    /** 'chainlink', 'pool' or 'broker' — see the price_source migration. */
    priceSource: string;
    valueUsdg: number;
  }[],
): Promise<void> {
  try {
    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(agent_id, symbol) DO UPDATE SET
         raw_balance = excluded.raw_balance, ui_multiplier = excluded.ui_multiplier,
         price_usd = excluded.price_usd, price_stale = excluded.price_stale,
         price_source = excluded.price_source,
         value_usdg = excluded.value_usdg, updated_at = excluded.updated_at`,
    );
    for (const p of positions) {
      await upsert.run(
        agentId,
        p.symbol,
        p.token,
        p.rawBalance.toString(),
        p.uiMultiplier.toString(),
        p.priceUsd,
        p.priceStale ? 1 : 0,
        p.priceSource,
        p.valueUsdg,
      );
    }
    const held = positions.map((p) => p.symbol);
    const placeholders = held.map(() => "?").join(",");
    await db
      .prepare(
        held.length
          ? `DELETE FROM positions WHERE agent_id = ? AND symbol NOT IN (${placeholders})`
          : "DELETE FROM positions WHERE agent_id = ?",
      )
      .run(agentId, ...held);
  } catch (e) {
    console.error("[store] positions update failed:", e);
  }
}

/**
 * Which book a budget question is about. Paper money and real money are not the
 * same money, and they must not share a budget.
 *
 * They used to. Both counters below asked for status IN ('landed','paper',
 * 'submitted'), so a paper run spent the LIVE 48-op allowance and then refused
 * itself for the rest of the day. That is not hypothetical: it is what happened
 * on 2026-07-15 — 48 simulated fills exhausted the cap in 21 minutes, and the
 * remaining 11.7 hours of the run are 1,242 identical 'ops-cap' rejections.
 *
 * Paper still counts against the cap on its OWN rail, deliberately. The point of
 * paper mode is that it behaves like live; an unbudgeted paper run would prove
 * nothing about what live would do.
 */
export type BudgetRail = "live" | "paper";

/**
 * 'submitted' counts on the live rail: a brokerage order that has left the
 * building is an op whether or not it has filled yet, and excluding it would let
 * a restart forget in-flight orders and overshoot the ops cap. Step 6's
 * reconciler resolves each 'submitted' to landed/reverted; a reverted
 * resolution is the one case the seed then over-counts until the row flips,
 * which is the conservative direction — budgets may under-spend, never
 * over-spend.
 */
// An ALLOW-LIST on purpose: 'reverted', 'rejected' and 'dropped' (an op the
// chain can never execute — see TradeRow.status) moved nothing, and a status
// added later counts toward no cap until someone says it spends.
const RAIL_STATUSES: Record<BudgetRail, readonly string[]> = {
  live: ["landed", "submitted"],
  paper: ["paper"],
};

/** `IN (?, ?)` placeholders for a rail's status set. */
function railFilter(rail: BudgetRail): { sql: string; params: readonly string[] } {
  const params = RAIL_STATUSES[rail];
  return { sql: params.map(() => "?").join(", "), params };
}

/**
 * Executed-op count on one rail in the trailing 24h — seeds the ops-cap counter
 * across restarts, and (since the counter no longer only ever climbs) re-reads
 * it as ops age out of the window.
 *
 * PERP ORDERS COUNT HERE, AND ONLY HERE (docs/perps.md, "Budgets"). An L2 order
 * is never a `trades` row (the trades boundary), so a count of `trades` alone
 * forgot every perp order at the next refreshBudget and at every restart: the
 * in-flight reservation covers an op only until its row is written. The perp
 * part is added INSIDE this function rather than by the caller because
 * refreshBudget already calls this, and one sum in one place cannot be
 * counted twice or forgotten by a second call site. perpOpsSince is exported
 * for readers that want the perp part alone — never add it to this.
 *
 * The on-chain legs (`perp-deposit`, `perp-key`, `perp-claim`) are trades
 * rows and are already in the first count, unchanged.
 */
export async function getOpsToday(agentId: string, rail: BudgetRail = "live"): Promise<number> {
  const { sql, params } = railFilter(rail);
  const row = await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
       WHERE agent_id = ? AND status IN (${sql}) AND created_at > unixepoch() - 86400`,
    )
    .get(agentId, ...params) as { n: number } | undefined;
  const perpOps = await perpOpsSince(agentId, rail, Math.floor(Date.now() / 1000) - 86_400);
  return Number(row?.n ?? 0) + perpOps;
}

/** Rename the agent — the user-given merryman name (shown on the dashboard). */
/**
 * The owner's X handle on the agent's roster row, so a public page can credit
 * them without decrypting a tenant's sealed settings.
 *
 * Deliberately not unique and deliberately not indexed — see the column comment.
 * Two agents may claim the same handle and both render, because nobody has
 * verified either and a constraint would imply somebody had.
 */
export async function setAgentXHandle(
  agentId: string,
  handle: string | null,
  verified = false,
): Promise<void> {
  try {
    await getDb()
      .prepare(`UPDATE agents SET x_handle = ?, x_verified = ? WHERE smart_account = ?`)
      // A handle with no proof is stored UNVERIFIED even if it was verified a
      // moment ago under a different spelling: the proof names one handle, and
      // changing the handle is changing the claim.
      .run(handle, verified ? 1 : 0, agentId);
  } catch {
    /* a missing handle is cosmetic — never worth failing an arm over */
  }
}

export async function setAgentName(agentId: string, name: string): Promise<void> {
  try {
    await getDb().prepare(`UPDATE agents SET name = ? WHERE smart_account = ?`).run(name, agentId);
  } catch (e) {
    console.error("[store] agent rename failed:", e);
  }
}

/** Sum of landed chat transfers in the trailing 24h — the transfer sub-budget. */
export async function getTransferredTodayUsdg(agentId: string): Promise<number> {
  const row = await getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status = 'landed' AND kind = 'transfer'
         AND created_at > unixepoch() - 86400`,
    )
    .get(agentId) as { spent: number } | undefined;
  return row?.spent ?? 0;
}

/**
 * Sum of spend on one rail in the trailing 24h — seeds the daily-cap counter.
 * Same rail split as getOpsToday, and for the same reason: simulated spend must
 * not consume a real allowance.
 *
 * PERPS, BOTH HALVES (docs/perps.md, "Budgets"; rule 6):
 *
 *   the on-chain legs are trades rows. `perp-deposit` COUNTS, exactly as
 *   `vault-deposit` does: it is USDG leaving through the wall, the money rule
 *   4 says can be lost, and exempting it would relax the daily cap to make a
 *   perp trade fit — which is not this function's call to make. `perp-claim`
 *   is money coming HOME and is excluded beside `vault-withdraw`; `perp-key`
 *   (the changePubKey registration) moves no USDG and is excluded too. Both
 *   still count as ops (getOpsToday).
 *
 *   the day's opening notional is not in `trades` at all (the trades
 *   boundary), so it is added from perp_orders HERE — the same one place, for
 *   the same reason, as getOpsToday's perp count: refreshBudget already calls
 *   this, and a second call site is how a sum is counted twice or not at all.
 *   Summed as integer micro-USDG and converted once, at the boundary of this
 *   function's number. perpOpenNotionalSince is exported for readers that want
 *   the perp part alone — never add it to this.
 */
export async function getSpentTodayUsdg(
  agentId: string,
  rail: BudgetRail = "live",
  cashToken?: string,
): Promise<number> {
  const { sql, params } = railFilter(rail);
  // A SELL INTO CASH SPENDS NOTHING. policy.ts exempts it from the daily-cap
  // check under exactly that sentence, but this sum still added its proceeds,
  // so an agent that bought and then sold drew its budget down twice and its
  // next buys were refused `daily-cap` with half the allowance unspent. The
  // budget bounds what is SPENT; buys still count in full.
  const sells = cashToken
    ? ` AND NOT (kind IN ('swap', 'curve-trade') AND LOWER(COALESCE(buy_token, '')) = ?)`
    : "";
  const row = await getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status IN (${sql}) AND kind NOT IN ('vault-withdraw', 'perp-claim', 'perp-key')${sells}
         AND created_at > unixepoch() - 86400`,
    )
    .get(agentId, ...params, ...(cashToken ? [cashToken.toLowerCase()] : [])) as { spent: number } | undefined;
  const perpMicro = await perpOpenNotionalSince(agentId, rail, Math.floor(Date.now() / 1000) - 86_400);
  // Exact below 2^53 micro-USDG (nine billion USDG); the caller converts the
  // whole back to micro with usdg().
  return Number(row?.spent ?? 0) + Number(perpMicro) / 1e6;
}

/**
 * Every UserOperation hash this agent has a SETTLED row for — landed, reverted
 * or rejected. The in-flight reconciler uses it to tell an op the chain
 * executed but the ledger never recorded (a process death between submit and
 * the ledger write) from one that is already accounted for.
 *
 * Settled, NOT all statuses — and the difference is a bug this had for one day.
 * The doc here used to say "All statuses, not just the spending ones: a hash
 * recorded as reverted must not be re-reconciled as landed." That reasoning is
 * still exactly right for landed/reverted/rejected, and it was written before
 * 'submitted' rows existed. Once executor.ts began writing one BEFORE
 * broadcasting, this query started hiding in-flight ops from the very sweep
 * that exists to finish them: findOrphanOps skips any hash in this set, so a
 * row stranded by a crash became invisible forever — never journaled, never
 * booked to basis, absent from realized P&L, and still charging the live rail.
 *
 * A 'submitted' row is by definition NOT accounted for. It is a claim that an
 * op left, with no outcome attached. listSubmittedOps returns those.
 *
 * Hashes are lowercased so the set compares cleanly against the chain's.
 */
export async function listOpHashes(agentId: string): Promise<Set<string>> {
  // NOR A 'dropped' ROW. It says the chain can never execute the op (another
  // op of ours spent its nonce), and it counts toward no cap. That is proven
  // at a depth, not assumed — but if the chain ever DID show it executed, the
  // sweep must still see an op the ledger does not count and write it down,
  // rather than skip it as settled. Belt and braces for a case the proof rules
  // out; the price is nothing on every other pass.
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT user_op_hash FROM trades
       WHERE agent_id = ? AND user_op_hash IS NOT NULL AND status NOT IN ('submitted', 'dropped')`,
    )
    .all(agentId)) as { user_op_hash: string | null }[];
  const set = new Set<string>();
  for (const r of rows) if (r.user_op_hash) set.add(r.user_op_hash.toLowerCase());
  return set;
}

/**
 * LANDED FILLS WHOSE COST WAS NEVER BOOKED, newest first.
 *
 * A row written by the executor carries `fill_qty_raw`; one written by the
 * arm-time reconciler does not, because a reconciled op used to record its spend
 * and stop there. That left a real position with no entry price — and both
 * mechanical exits refuse a holding they cannot measure against one, so the
 * stop-loss and take-profit an owner had armed could not reach it, silently and
 * permanently.
 *
 * This is the input to the backfill: the transactions whose receipts still hold
 * the answer. Bounded hard, because each one costs a receipt fetch and a book
 * with a hundred of these is a book with a different problem.
 */
export async function landedFillsWithoutBasis(
  agentId: string,
  limit = 20,
): Promise<{ txHash: string; amountUsdg: number }[]> {
  try {
    const rows = (await getDb()
      .prepare(
        `SELECT tx_hash, amount_usdg FROM trades
          WHERE agent_id = ? AND status = 'landed' AND tx_hash IS NOT NULL
            AND fill_qty_raw IS NULL AND kind = 'swap'
          ORDER BY id DESC LIMIT ?`,
      )
      .all(agentId, limit)) as { tx_hash: string; amount_usdg: number }[];
    return rows.map((r) => ({ txHash: r.tx_hash.toLowerCase(), amountUsdg: Number(r.amount_usdg) }));
  } catch {
    // The fill columns arrive with a migration. An unreadable ledger must not
    // take a tick down; the backfill simply does not run.
    return [];
  }
}

/** One op that left and never came back — the input to the resolver. */
export interface SubmittedOp {
  userOpHash: string;
  kind: string;
  target: string;
  /**
   * The legs the pre-broadcast row was written with (tokenLegs), when it had
   * any. The resolver needs them to recognise an ENERGY purchase whose kind a
   * rewrite may have lost, and to carry them onto the settled row — a
   * resolution that dropped them would leave a landed energy buy the in-flight
   * guard and every leg-keyed reader could no longer see.
   */
  sellToken?: string;
  buyToken?: string;
  amountUsdg: number;
  /** unixepoch seconds, stamped at INSERT and never rewritten by a resolution. */
  createdAt: number;
  epoch: number;
  /**
   * The nonce it was signed with (`user_op_nonce`), when the row recorded one
   * and it parses. Absent on rows written before the column existed: those
   * are never judged dropped, only aged out of the resolver's window.
   */
  nonce?: bigint;
}

/** A stored nonce back to a bigint; null for anything that is not one. */
function parseNonce(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^[0-9]{1,80}$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Rows written before broadcast whose outcome never arrived.
 *
 * Two ways to get one: the process died between sendUserOperation and the
 * ledger write, or the receipt could not be read and index.ts deliberately
 * left the row alone (UserOpUnresolved). Both are 'we do not know', and both
 * keep charging the live rail — RAIL_STATUSES.live includes 'submitted' — so
 * leaving them unresolved is safe in the cap direction and useless in every
 * other: no journal entry, no cost basis, no P&L.
 *
 * The only input the resolver has. index.ts records the hash nowhere in
 * process memory once it gives up, so the ledger row IS the recovery record.
 */
export async function listSubmittedOps(agentId: string): Promise<SubmittedOp[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT user_op_hash, kind, target, sell_token, buy_token, amount_usdg, created_at, epoch, user_op_nonce FROM trades
       WHERE agent_id = ? AND status = 'submitted' AND user_op_hash IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all(agentId)) as {
    user_op_hash: string;
    kind: string;
    target: string;
    sell_token: string | null;
    buy_token: string | null;
    amount_usdg: number;
    created_at: number;
    epoch: number;
    user_op_nonce: string | null;
  }[];
  return rows.map((r) => {
    const nonce = parseNonce(r.user_op_nonce);
    return {
      userOpHash: r.user_op_hash.toLowerCase(),
      kind: r.kind,
      target: r.target,
      ...(r.sell_token ? { sellToken: r.sell_token } : {}),
      ...(r.buy_token ? { buyToken: r.buy_token } : {}),
      amountUsdg: Number(r.amount_usdg),
      createdAt: Number(r.created_at),
      epoch: Number(r.epoch),
      ...(nonce !== null ? { nonce } : {}),
    };
  });
}

/**
 * EVERY OTHER OP OF OURS SIGNED WITH THIS NONCE — the rivals whose on-chain
 * execution would prove a stranded op dropped (inflight-reconcile.ts
 * findDroppedOps). Any status, any epoch: which of them the chain executed is
 * the chain's to say, and it is asked by hash. Hashes lowercased, the stranded
 * op itself excluded.
 */
export async function opsSignedWithNonce(agentId: string, nonce: bigint, exceptHash: string): Promise<string[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT user_op_hash FROM trades
        WHERE agent_id = ? AND user_op_nonce = ? AND user_op_hash IS NOT NULL`,
    )
    .all(agentId, nonce.toString())) as { user_op_hash: string | null }[];
  const except = exceptHash.toLowerCase();
  const out = new Set<string>();
  for (const r of rows) {
    const h = r.user_op_hash?.toLowerCase();
    if (h && h !== except) out.add(h);
  }
  return [...out];
}

/**
 * IS AN ENERGY BUY STILL IN FLIGHT? — the ledger's half of "one at a time".
 *
 * The energy buy is sized from the chain every time, so the one way to buy
 * twice is to size a second buy on a reading taken before the first one
 * settled: an owner asking again while the first is between broadcast and
 * receipt, or a stranded 'submitted' op the resolver has not reached. This is
 * the question asked before any sizing: does the ledger hold a 'submitted'
 * energy purchase from the last `sinceSec` seconds?
 *
 * BY KIND OR BY LEGS. The pre-broadcast row is written with kind 'energy-buy'
 * and legs USDG → the reserve (index.ts tokenLegs), and a row whose kind was
 * ever rewritten must still be seen — so either matches. The reserve set is
 * every chain's (core ENERGY_RESERVE_TOKENS), because a false "in flight" costs
 * an owner a minute and a false "clear" costs a double buy.
 *
 * NULL WHEN THE LEDGER WOULD NOT ANSWER, and the caller refuses on it: an
 * unreadable ledger is not an empty one.
 *
 * The window exists because an op past its router deadline (ENERGY.deadlineSec)
 * can no longer buy anything, and a row the resolver cannot settle must not
 * block the owner forever; six hours is far past any deadline.
 */
export async function energyBuysInFlight(agentId: string, sinceSec: number): Promise<boolean | null> {
  const reserve = [...new Set(Object.values(ENERGY_RESERVE_TOKENS).flat().map((a) => a.toLowerCase()))];
  try {
    const row = await getDb()
      .prepare(
        `SELECT 1 AS n FROM trades
          WHERE agent_id = ? AND status = 'submitted' AND created_at > ?
            AND (kind = 'energy-buy'
                 OR (LOWER(COALESCE(sell_token, '')) = ?
                     AND LOWER(COALESCE(buy_token, '')) IN (${reserve.map(() => "?").join(", ")})))
          LIMIT 1`,
      )
      .get(agentId, Math.floor(sinceSec), (CASH.USDG as string).toLowerCase(), ...reserve);
    return row !== undefined && row !== null;
  } catch (e) {
    console.error("[store] energy in-flight read failed:", e);
    return null;
  }
}

/**
 * THE NEWEST ENERGY PURCHASE THAT LANDED, and the block it landed in when the
 * ledger knows it — what the buy's balance-read pin is seeded from at arm.
 *
 * The pin (index.ts lastEnergyLandedBlock) makes the next ask read both
 * $MERRYMEN halves and the cash no earlier than the last purchase's landing,
 * so a load-balanced node still behind it answers with an error rather than a
 * pre-purchase balance the planner would top up a second time. It was held in
 * memory only, so a restart after a landing forgot it — and the in-flight
 * guard does not cover a LANDED row.
 *
 * The block comes from the purchase's own 'energy-buy' flow row (booked from
 * the receipt's USDG log, before the landed row was written). A landed
 * purchase with no flow row — its booking was refused or skipped — answers
 * `blockNumber: null` with its tx hash, and the caller reads that one receipt.
 * By kind OR by legs, like energyBuysInFlight. Throws when the ledger will not
 * answer; the caller treats that as "no pin" (fail-soft: the pin is a
 * freshness floor, never a gate).
 */
export async function newestLandedEnergyBuy(agentId: string): Promise<{ txHash: string; blockNumber: number | null } | null> {
  const reserve = [...new Set(Object.values(ENERGY_RESERVE_TOKENS).flat().map((a) => a.toLowerCase()))];
  const row = (await getDb()
    .prepare(
      `SELECT t.tx_hash AS tx_hash,
              (SELECT MAX(f.block_number) FROM flows f
                WHERE f.agent_id = t.agent_id AND f.source = 'energy-buy'
                  AND LOWER(COALESCE(f.tx_hash, '')) = LOWER(t.tx_hash)) AS block_number
         FROM trades t
        WHERE t.agent_id = ? AND t.status = 'landed' AND t.tx_hash IS NOT NULL
          AND (t.kind = 'energy-buy'
               OR (LOWER(COALESCE(t.sell_token, '')) = ?
                   AND LOWER(COALESCE(t.buy_token, '')) IN (${reserve.map(() => "?").join(", ")})))
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT 1`,
    )
    .get(agentId, (CASH.USDG as string).toLowerCase(), ...reserve)) as { tx_hash: string; block_number: number | string | null } | undefined;
  if (!row) return null;
  const block = row.block_number === null || row.block_number === undefined ? null : Number(row.block_number);
  return { txHash: String(row.tx_hash).toLowerCase(), blockNumber: block !== null && Number.isSafeInteger(block) && block > 0 ? block : null };
}

// ── chat turns — the conversation survives a restart ──────────────────────

/** Kept per chat on disk. Only the newest few reach a prompt (see service.ts);
 * the rest exist for sticky-memory lookup and future recall. */
const CHAT_TURNS_KEPT = 40;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Memory ids surfaced for this turn, so a pronoun follow-up keeps the thread. */
  memoryIds?: string[];
}

/** Append one turn and prune the chat back to its retention window. */
export async function appendChatTurn(chatId: number, turn: ChatTurn): Promise<void> {
  try {
    const db = getDb();
    await db
      .prepare("INSERT INTO chat_turns (chat_id, role, content, memory_ids) VALUES (?, ?, ?, ?)")
      .run(
        chatId,
        turn.role,
        turn.content,
        turn.memoryIds && turn.memoryIds.length ? JSON.stringify(turn.memoryIds) : null,
      );
    await db
      .prepare(
        `DELETE FROM chat_turns WHERE chat_id = ? AND id NOT IN (
         SELECT id FROM chat_turns WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(chatId, chatId, CHAT_TURNS_KEPT);
  } catch (e) {
    console.error("[store] chat turn insert failed:", e);
  }
}

/** The most recent turns for a chat, oldest-first (prompt order). */
export async function recentChatTurns(chatId: number, limit = CHAT_TURNS_KEPT): Promise<ChatTurn[]> {
  try {
    const rows = await getDb()
      .prepare("SELECT role, content, memory_ids FROM chat_turns WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .all(chatId, limit) as { role: string; content: string; memory_ids: string | null }[];
    return rows
      .reverse()
      .map((r) => {
        let memoryIds: string[] | undefined;
        try {
          memoryIds = r.memory_ids ? (JSON.parse(r.memory_ids) as string[]) : undefined;
        } catch {
          memoryIds = undefined; // a corrupt blob must not cost us the turn
        }
        return { role: r.role === "assistant" ? "assistant" : "user", content: r.content, memoryIds } as ChatTurn;
      });
  } catch {
    return [];
  }
}

/** Unix seconds of the last turn in a chat, or null if there is none. Lets the
 * merryman know it's been three days rather than opening cold every time. */
export async function lastChatTurnAt(chatId: number): Promise<number | null> {
  try {
    const row = await getDb()
      .prepare("SELECT at FROM chat_turns WHERE chat_id = ? ORDER BY id DESC LIMIT 1")
      .get(chatId) as { at: number } | undefined;
    return row?.at ?? null;
  } catch {
    return null;
  }
}

/** Forget one chat's conversation — what /forget must actually do now that
 * turns persist to disk rather than dying with the process. */
export async function clearChatTurns(chatId: number): Promise<void> {
  try {
    await getDb().prepare("DELETE FROM chat_turns WHERE chat_id = ?").run(chatId);
  } catch (e) {
    console.error("[store] chat turn clear failed:", e);
  }
}

// ── cost basis — weighted-average, per symbol (see basis.ts) ──────────────

/**
 * Paper, live, and brokerage keep separate books — see the cost_basis DDL.
 * 'brokerage' exists so a custodial fill can never price an on-chain
 * position's sell (or vice versa); its writer lands with step 6.
 */
export type BasisMode = "paper" | "live" | "brokerage";

/** Load a symbol's basis for one mode. Missing row = a flat position, not an error. */
export async function getBasis(agentId: string, mode: BasisMode, symbol: string): Promise<{ qtyRaw: bigint; costUsdg: bigint }> {
  try {
    const row = await getDb()
      .prepare("SELECT qty_raw, cost_usdg FROM cost_basis WHERE agent_id = ? AND mode = ? AND symbol = ?")
      .get(agentId, mode, symbol) as { qty_raw: string; cost_usdg: string } | undefined;
    if (!row) return { qtyRaw: 0n, costUsdg: 0n };
    return { qtyRaw: BigInt(row.qty_raw), costUsdg: BigInt(row.cost_usdg) };
  } catch {
    return { qtyRaw: 0n, costUsdg: 0n };
  }
}

/** Persist a symbol's basis; a fully-closed position drops the row entirely. */
export async function setBasis(
  agentId: string,
  mode: BasisMode,
  symbol: string,
  b: { qtyRaw: bigint; costUsdg: bigint },
): Promise<void> {
  try {
    const db = getDb();
    if (b.qtyRaw <= 0n) {
      await db
        .prepare("DELETE FROM cost_basis WHERE agent_id = ? AND mode = ? AND symbol = ?")
        .run(agentId, mode, symbol);
      // AND THE FLOOR WITH IT, in the same breath and for the same reason.
      //
      // A floor is a distance from an entry price. A position with no entry
      // price has nothing to be a distance from — and a floor left behind is
      // worse than absent, because the NEXT entry in that symbol would inherit
      // a level graded from a market and an analysis that are both gone. The
      // two rows share one lifecycle, so they share one line of code rather
      // than two callers who each have to remember.
      try {
        await db
          .prepare("DELETE FROM position_floors WHERE agent_id = ? AND mode = ? AND symbol = ?")
          .run(agentId, mode, symbol);
      } catch {
        /* the table arrives with a migration */
      }
      return;
    }
    await db
      .prepare(
        `INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(agent_id, mode, symbol) DO UPDATE SET
         qty_raw = excluded.qty_raw, cost_usdg = excluded.cost_usdg, updated_at = excluded.updated_at`,
      )
      .run(agentId, mode, symbol, b.qtyRaw.toString(), b.costUsdg.toString());
  } catch (e) {
    console.error("[store] basis update failed:", e);
  }
}

/** Every symbol carrying basis in one mode — used to reconcile against reality. */
export async function basisSymbols(agentId: string, mode: BasisMode): Promise<string[]> {
  try {
    const rows = await getDb()
      .prepare("SELECT symbol FROM cost_basis WHERE agent_id = ? AND mode = ?")
      .all(agentId, mode) as { symbol: string }[];
    return rows.map((r) => r.symbol);
  } catch {
    return [];
  }
}

/**
 * Realized P&L over closed round trips, for ONE agent and ONE book. Paper and
 * live money must never be summed together, and rows whose basis was unknown
 * carry NULL so they're excluded rather than counted as cost-free profit.
 */
export async function getRealizedPnlUsdg(agentId: string, mode: BasisMode, sinceUnix?: number): Promise<number> {
  // Exhaustive on purpose: a mode with no status mapping would read ZERO P&L
  // everywhere, silently — the exact failure the design doc calls out.
  // 'brokerage' maps to 'landed' like 'live': a settled broker fill is as real
  // as a landed swap, and 'submitted' rows are excluded here because an
  // unfilled order has no realized anything. Cross-talk with 'live' is
  // impossible at the query level: broker agents live in the rh: id space, so
  // one agent_id never carries both kinds of landed row.
  const statusByMode: Record<BasisMode, string> = { paper: "paper", live: "landed", brokerage: "landed" };
  const status = statusByMode[mode];
  try {
    const row = (
      sinceUnix
        ? await getDb()
            .prepare(
              "SELECT COALESCE(SUM(realized_pnl_usdg), 0) AS pnl FROM trades WHERE agent_id = ? AND status = ? AND realized_pnl_usdg IS NOT NULL AND created_at > ?",
            )
            .get(agentId, status, sinceUnix)
        : await getDb()
            .prepare(
              "SELECT COALESCE(SUM(realized_pnl_usdg), 0) AS pnl FROM trades WHERE agent_id = ? AND status = ? AND realized_pnl_usdg IS NOT NULL",
            )
            .get(agentId, status)
    ) as { pnl: number } | undefined;
    return row?.pnl ?? 0;
  } catch {
    return 0;
  }
}

// ── paper book — the zero-funds ledger (see paper.ts) ─────────────────────

export interface PaperBookRow {
  cashUsdg: number;
  vaultUsdg: number;
  hwmUsdg: number;
  /** symbol → { token, shares } */
  shares: Record<string, { token: `0x${string}`; shares: number }>;
}

/** Load the paper book, seeding it with the starting cash on first touch. */
export async function getPaperBook(agentId: string, startUsdg: number): Promise<PaperBookRow> {
  await getDb()
    .prepare("INSERT OR IGNORE INTO paper_book (agent_id, cash_usdg) VALUES (?, ?)")
    .run(agentId, startUsdg);
  const row = await getDb()
    .prepare("SELECT cash_usdg, vault_usdg, hwm_usdg, shares FROM paper_book WHERE agent_id = ?")
    .get(agentId) as { cash_usdg: number; vault_usdg: number; hwm_usdg: number; shares: string };
  let shares: PaperBookRow["shares"] = {};
  try {
    shares = JSON.parse(row.shares) as PaperBookRow["shares"];
  } catch {
    // corrupt shares blob — start clean rather than crash the tick
  }
  return { cashUsdg: row.cash_usdg, vaultUsdg: row.vault_usdg, hwmUsdg: row.hwm_usdg, shares };
}

/**
 * START THE PRACTICE BOOK OVER — paper only, and it deletes nothing that could
 * ever have been real.
 *
 * "Should positions and trades also become empty when starting over in paper
 * mode? They still appear." They did, and the screen said so rather than doing
 * anything about it: discarding a grant clears a signed KEY, and the book is
 * worker-side state that the ledger mirror rewrites within a minute of any
 * attempt to clear it from above. So the honest stopgap was a warning, and this
 * is the thing the warning was standing in for.
 *
 * WHAT IS RESET, and why each is safe:
 *   paper_book      — the simulated cash, vault and share ledger. There is no
 *                     other copy; this IS the practice book.
 *   positions       — on the paper rail these rows are DERIVED from the book
 *                     above (index.ts builds them with paperPositionsOf), so
 *                     they are a cache, and the next tick rewrites them.
 *   cost_basis      — scoped `mode = 'paper'`. The live basis is a different
 *   position_floors   primary key and is never touched.
 *
 * WHAT IS NOT DELETED: the trade rows and the equity curve. Those are the
 * agent's history, and this repo keeps history and reporting apart with an
 * ACCOUNTING EPOCH rather than a DELETE — the same primitive that already
 * carries the pre-flow-tracking rows. The caller opens the next epoch, so the
 * old fills stay on disk for forensics and stop counting toward anything.
 * Deleting them would also be the one operation here that could destroy
 * something irreplaceable if the rail check above it were ever wrong.
 *
 * The rail check is the caller's job and it is not optional: run this against a
 * live agent and you have cleared the cost basis it computes real P&L from.
 *
 * PAPER PERPS GO WITH IT, in the same transaction:
 *   perp_positions  — scoped `mode = 'paper'`: on paper these rows ARE the
 *                     book (there is no venue behind them), so deleting them is
 *                     closing every simulated position. The live cache is a
 *                     different key and is never touched.
 *   perp_accounts   — the paper cross collateral goes to '0'. The nonce
 *                     high-water does NOT: it only ever rises, so no client
 *                     order index is reused after a reset either.
 *   open paper legs and orders — cancelled, so no simulated stop outlives the
 *                     position it protected. Fills and funding stay, behind the
 *                     epoch like the trade rows.
 * One transaction because a reset that cleared the cash but not the collateral
 * (or the reverse) is a book that no longer adds up, and it is the one the
 * next checkpoint would carry into shared storage.
 */
export async function resetPaperLedger(agentId: string, startUsdg: number): Promise<void> {
  const perpAccount = agentId.toLowerCase();
  await getDb().tx(async (db) => {
    await db
      .prepare(
        `UPDATE paper_book SET cash_usdg = ?, vault_usdg = 0, hwm_usdg = 0, shares = '{}',
           updated_at = unixepoch() WHERE agent_id = ?`,
      )
      .run(startUsdg, agentId);
    // INSERT OR IGNORE first would be redundant: getPaperBook seeds the row on
    // first touch, and an agent with no row has nothing to reset.
    await db.prepare("DELETE FROM positions WHERE agent_id = ?").run(agentId);
    await db.prepare("DELETE FROM cost_basis WHERE agent_id = ? AND mode = 'paper'").run(agentId);
    await db.prepare("DELETE FROM position_floors WHERE agent_id = ? AND mode = 'paper'").run(agentId);
    await db.prepare("DELETE FROM perp_positions WHERE agent_id = ? AND mode = 'paper'").run(perpAccount);
    await db
      .prepare(
        `UPDATE perp_accounts SET paper_collateral_micro = '0', updated_at = unixepoch()
          WHERE agent_id = ? AND mode = 'paper'`,
      )
      .run(perpAccount);
    await db
      .prepare(
        `UPDATE perp_order_legs SET status = 'cancelled', venue_status = 'paper-reset', updated_at = unixepoch()
          WHERE agent_id = ? AND mode = 'paper' AND status IN ('submitted', 'pending', 'open')`,
      )
      .run(perpAccount);
    await db
      .prepare(
        `UPDATE perp_orders SET status = 'cancelled', reason = COALESCE(reason, 'paper-reset'),
                resolved_at = unixepoch(), updated_at = unixepoch()
          WHERE agent_id = ? AND mode = 'paper' AND status IN ('submitted', 'executed')`,
      )
      .run(perpAccount);
  });
}

export async function setPaperBook(agentId: string, book: PaperBookRow): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE paper_book SET cash_usdg = ?, vault_usdg = ?, hwm_usdg = ?, shares = ?, updated_at = unixepoch()
       WHERE agent_id = ?`,
    )
    .run(book.cashUsdg, book.vaultUsdg, book.hwmUsdg, JSON.stringify(book.shares), agentId);
}

/** Addresses discovery has already reported. Bounded — old rows are pruned. */
/**
 * Tokens the POOL discoverer has already announced.
 *
 * Filtered on `pool_announced_at`, NOT on "a row exists". The launchpad
 * discoverer also writes rows, and a token that launched on Pons must still be
 * announced when it later graduates into a real pool — that is the moment it
 * becomes tradeable, and the only moment its v4 PoolKey can be captured.
 * Keying this on row existence made a launch permanently suppress the
 * graduation.
 */
export async function seenPools(): Promise<Set<string>> {
  try {
    const rows = await getDb()
      .prepare("SELECT address FROM discovered_pools WHERE pool_announced_at IS NOT NULL")
      .all() as { address: string }[];
    return new Set(rows.map((r) => r.address.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Tokens the LAUNCHPAD discoverer has already announced.
 *
 * The curve column is the marker because only that path ever writes it, so this
 * needs no flag of its own. Independent of `seenPools` by design — see above.
 */
export async function seenCurves(): Promise<Set<string>> {
  try {
    const rows = await getDb()
      .prepare("SELECT address FROM discovered_pools WHERE curve IS NOT NULL")
      .all() as { address: string }[];
    return new Set(rows.map((r) => r.address.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Record a POOL sighting so the pool discoverer never announces it twice. */
export async function markPoolSeen(address: string, symbol: string): Promise<void> {
  try {
    await getDb()
      .prepare(
        // Upsert rather than INSERT OR IGNORE: the launchpad may have created
        // this row already, and an IGNORE would leave pool_announced_at NULL —
        // re-announcing the same pool on every pass, forever.
        `INSERT INTO discovered_pools (address, symbol, pool_announced_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT(address) DO UPDATE SET pool_announced_at = COALESCE(pool_announced_at, unixepoch())`,
      )
      .run(address.toLowerCase(), symbol.slice(0, 16));
    await pruneDiscovered();
  } catch (e) {
    console.error("[store] discovered_pools insert failed:", e);
  }
}

/**
 * Keep the dedupe table bounded.
 *
 * Called from BOTH discoverers. It used to live inside markPoolSeen, which was
 * fine when that was the only writer; with a launchpad also inserting, a quiet
 * period for pool discovery would mean the prune never ran while rows kept
 * arriving.
 */
export async function pruneDiscovered(): Promise<void> {
  try {
    // Not parameterised on purpose: this goes through Db.exec, whose Postgres
    // path applies translateSchema and does NO placeholder translation, so a
    // `?` here would ship literally and throw on every pass.
    await getDb().exec(
      "DELETE FROM discovered_pools WHERE address NOT IN (SELECT address FROM discovered_pools ORDER BY first_seen DESC LIMIT 5000)",
    );
  } catch (e) {
    console.error("[store] discovered_pools prune failed:", e);
  }
}

// ── discovery candidates + trench positions ────────────────────────────────

export interface PoolCandidate {
  address: string;
  symbol: string;
  decimals: number;
  liquidityUsd: number;
  fdvUsd: number;
  firstSeen: number;
  /** The v4 PoolKey when discovery captured one — all five fields or absent. */
  key?: {
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    hooks: string;
  };
  /**
   * Where a bonding-curve token trades, when this came from the Pons launchpad.
   *
   * `quoteToken` is `0x000…0` for native ETH — a meaningful zero, not a missing
   * one — so absence is expressed by the whole object being undefined rather
   * than by any field inside it.
   */
  curve?: {
    curve: string;
    quoteToken: string;
    /** Raw quote units, decimal string. Required to interpret the reserves. */
    graduationThresholdRaw: string;
  };
}

/**
 * Remember a discovered pair WITH the numbers a decision needs.
 *
 * Discovery previously stored only an address, which was enough to avoid
 * announcing twice and useless for anything else — a strategy asking "is this
 * worth entering" would have had to re-derive every figure from scratch.
 * `first_seen` doubles as the age baseline: the pool's own creation time isn't
 * always available, and the moment we first saw it is at least a fact.
 */
export async function recordCandidate(c: PoolCandidate): Promise<void> {
  try {
    await getDb()
      .prepare(
        // The pool-key columns use COALESCE(excluded.x, x) so a KEYLESS
        // re-sighting of the same token — the gateway path, an older worker, a
        // Bitquery hiccup — can never blank a key that was already captured.
        // Keys are learned once from the Initialize event and then only ever
        // replaced by another full key.
        // The pool-key and curve columns use COALESCE(excluded.x, x) so a
        // re-sighting that lacks them — the gateway path, an older worker, a
        // Bitquery hiccup, or simply the OTHER discoverer — can never blank
        // what was already captured. Both are learned once and then only ever
        // replaced by another full reading.
        //
        // liquidity_usd and fdv_usd use CASE ... > 0 for a related but distinct
        // reason. There are now TWO discoverers writing this table, and the Pons
        // one legitimately has no USD figures for a curve quoted in an asset
        // this repo cannot price. Left unconditional, such a re-sighting would
        // overwrite a Uniswap pass's real figures with zeros — silently, since
        // the catch below only logs — and the trencher's $25,000 depth and
        // $50,000 FDV gates would then disqualify a candidate that had
        // previously qualified.
        //
        // The cost of this choice, stated plainly: a pool that genuinely drained
        // to zero keeps its last non-zero figure here. That is the safer of the
        // two errors because this column is a snapshot from announce time, not
        // a live reading — trencher re-derives depth every tick from
        // lastLiquidityUsd and only falls back to this value.
        `INSERT INTO discovered_pools (address, symbol, decimals, liquidity_usd, fdv_usd,
                                       pool_currency0, pool_currency1, pool_fee, pool_tick_spacing, pool_hooks,
                                       curve, quote_token, graduation_threshold)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           symbol = excluded.symbol, decimals = excluded.decimals,
           liquidity_usd = CASE WHEN excluded.liquidity_usd > 0 THEN excluded.liquidity_usd ELSE liquidity_usd END,
           fdv_usd = CASE WHEN excluded.fdv_usd > 0 THEN excluded.fdv_usd ELSE fdv_usd END,
           pool_currency0 = COALESCE(excluded.pool_currency0, pool_currency0),
           pool_currency1 = COALESCE(excluded.pool_currency1, pool_currency1),
           pool_fee = COALESCE(excluded.pool_fee, pool_fee),
           pool_tick_spacing = COALESCE(excluded.pool_tick_spacing, pool_tick_spacing),
           pool_hooks = COALESCE(excluded.pool_hooks, pool_hooks),
           curve = COALESCE(excluded.curve, curve),
           quote_token = COALESCE(excluded.quote_token, quote_token),
           graduation_threshold = COALESCE(excluded.graduation_threshold, graduation_threshold)`,
      )
      .run(
        c.address.toLowerCase(),
        c.symbol.slice(0, 16),
        c.decimals,
        c.liquidityUsd,
        c.fdvUsd,
        c.key ? c.key.currency0.toLowerCase() : null,
        c.key ? c.key.currency1.toLowerCase() : null,
        c.key ? c.key.fee : null,
        c.key ? c.key.tickSpacing : null,
        c.key ? c.key.hooks.toLowerCase() : null,
        c.curve ? c.curve.curve.toLowerCase() : null,
        c.curve ? c.curve.quoteToken.toLowerCase() : null,
        c.curve ? c.curve.graduationThresholdRaw : null,
      );
  } catch (e) {
    console.error("[store] candidate upsert failed:", e);
  }
}

/**
 * Discovered v4 PoolKeys for a currency pair — the only way a HOOKED pool can
 * ever be routed, since a hook address cannot be guessed by tier-scanning.
 *
 * Rows qualify only when ALL FIVE key columns are non-NULL: a partial key is a
 * different pool, not a vaguer one. Returns plain structural objects so the
 * venues layer never has to import the store's row shapes.
 */
export async function poolKeysFor(
  a: string,
  b: string,
): Promise<{ currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` }[]> {
  try {
    // v4 sorts currency0 < currency1 numerically; for equal-length lowercase
    // hex strings that is the same order as a string comparison.
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    const lo = al < bl ? al : bl;
    const hi = al < bl ? bl : al;
    const rows = await getDb()
      .prepare(
        `SELECT pool_currency0, pool_currency1, pool_fee, pool_tick_spacing, pool_hooks
         FROM discovered_pools
         WHERE pool_currency0 = ? AND pool_currency1 = ?
           AND pool_fee IS NOT NULL AND pool_tick_spacing IS NOT NULL AND pool_hooks IS NOT NULL`,
      )
      .all(lo, hi) as {
      pool_currency0: string;
      pool_currency1: string;
      pool_fee: number;
      pool_tick_spacing: number;
      pool_hooks: string;
    }[];
    return rows.map((r) => ({
      currency0: r.pool_currency0 as `0x${string}`,
      currency1: r.pool_currency1 as `0x${string}`,
      fee: Number(r.pool_fee),
      tickSpacing: Number(r.pool_tick_spacing),
      hooks: r.pool_hooks as `0x${string}`,
    }));
  } catch {
    return [];
  }
}

/**
 * Candidates seen within `maxAgeSec`, freshest first.
 *
 * `poolsOnly` excludes bonding-curve rows, and the caller that wants candidates
 * to TRADE must pass it. The launchpad adds roughly ten rows an hour against a
 * 25-row window ordered by recency, so within a few hours the window is nothing
 * but curve tokens — which have no pool, cannot be priced by the pool guards
 * and cannot be entered at all today. They would crowd out every genuine pool
 * discovery, and "nothing qualified" would be indistinguishable from "the one
 * that qualified fell off the end of the list".
 *
 * Filtered in SQL rather than after the fact, because the LIMIT is applied by
 * the database: dropping them in JavaScript would still leave the window full.
 */
/**
 * WHERE THE USDG CANDIDATES GO — a read-only census, for one question.
 *
 * Milla's class producer surfaced USDG-quoted candidates at ~0.5% while the
 * chain, the launch parser and the depth filter all independently put them near
 * 10-18%. Every layer reachable from outside the container tested clean, so the
 * remaining suspects are this table's contents and the window/LIMIT this query
 * applies to them — neither observable without being inside the worker.
 *
 * The census counts the same rows at THREE points, which is what separates the
 * four possible answers:
 *
 *   all rows, any age       0 USDG -> they are NEVER WRITTEN
 *   inside the age window   0 here, >0 above -> they AGED OUT
 *   after ORDER BY + LIMIT  0 here, >0 above -> DISPLACED by newer rows
 *   (producer sees them)    >0 here -> they arrive and fail a LATER guard
 *
 * Diagnostic only: nothing reads this to make a decision, and it changes no
 * behaviour. It exists to be deleted once the question is answered.
 */
export interface CandidateCensus {
  /** Rows carrying a curve, at each narrowing stage. */
  allWithCurve: number;
  inWindow: number;
  returned: number;
  /** USDG-quoted counts at the same three stages. */
  usdgAll: number;
  usdgInWindow: number;
  usdgReturned: number;
  /** Native-ETH and everything-else, for the returned slice only. */
  nativeReturned: number;
  otherReturned: number;
  /** Seconds since the OLDEST row the producer actually received — the cutoff. */
  cutoffAgeSec: number | null;
  /** Seconds since the newest USDG row in the table, at any age. Null if none. */
  newestUsdgAgeSec: number | null;
}

export async function classCandidateCensus(
  maxAgeSec: number,
  limit: number,
): Promise<CandidateCensus | null> {
  const USDG = (CASH.USDG as string).toLowerCase();
  try {
    const db = getDb();
    const one = async (sql: string, ...args: unknown[]): Promise<number> => {
      const r = (await db.prepare(sql).get(...args)) as { n?: number } | undefined;
      return Number(r?.n ?? 0);
    };
    // ONE DEFINITION OF "CARRIES A CURVE", used by every stage.
    //
    // `recentCandidates` requires all three columns together, because a curve
    // without a threshold cannot be read as money and is dropped on the way
    // out. The first draft of this census tested `curve IS NOT NULL` at the
    // earlier stages and `quote_token != null` at the last one, so a row
    // missing a threshold counted as a candidate at one stage and not the next
    // — the census would have reported a drop that was only its own definition
    // changing, and sent me hunting it in code that was behaving.
    const HAS_CURVE = `curve IS NOT NULL AND quote_token IS NOT NULL AND graduation_threshold IS NOT NULL`;
    const allWithCurve = await one(`SELECT COUNT(*) AS n FROM discovered_pools WHERE ${HAS_CURVE}`);
    const usdgAll = await one(
      `SELECT COUNT(*) AS n FROM discovered_pools WHERE ${HAS_CURVE} AND LOWER(quote_token) = ?`,
      USDG,
    );
    const inWindow = await one(
      `SELECT COUNT(*) AS n FROM discovered_pools WHERE ${HAS_CURVE} AND first_seen > unixepoch() - ?`,
      maxAgeSec,
    );
    const usdgInWindow = await one(
      `SELECT COUNT(*) AS n FROM discovered_pools
        WHERE ${HAS_CURVE} AND LOWER(quote_token) = ? AND first_seen > unixepoch() - ?`,
      USDG,
      maxAgeSec,
    );
    // The returned slice, reproduced EXACTLY as recentCandidates builds it —
    // same window, same ORDER BY, same LIMIT. A census that ordered differently
    // would answer a question nobody asked.
    const slice = (await db
      .prepare(
        `SELECT curve, quote_token, graduation_threshold, first_seen FROM discovered_pools
          WHERE first_seen > unixepoch() - ? ORDER BY first_seen DESC LIMIT ?`,
      )
      .all(maxAgeSec, limit)) as {
      curve: string | null;
      quote_token: string | null;
      graduation_threshold: string | null;
      first_seen: number | null;
    }[];
    // The SAME predicate as HAS_CURVE above, in JS because the LIMIT is applied
    // by the database: filtering in SQL here would refill the window from older
    // rows and measure a slice the producer never receives.
    const withCurve = slice.filter(
      (r) => r.curve != null && r.quote_token != null && r.graduation_threshold != null,
    );
    let usdgReturned = 0;
    let nativeReturned = 0;
    let otherReturned = 0;
    for (const r of withCurve) {
      const q = String(r.quote_token).toLowerCase();
      if (q === USDG) usdgReturned += 1;
      else if (/^0x0{40}$/.test(q)) nativeReturned += 1;
      else otherReturned += 1;
    }
    const now = Math.floor(Date.now() / 1000);
    const oldestReturned = withCurve.length
      ? Math.min(...withCurve.map((r) => Number(r.first_seen ?? now)))
      : null;
    const newestUsdg = (await db
      .prepare(
        `SELECT MAX(first_seen) AS n FROM discovered_pools WHERE ${HAS_CURVE} AND LOWER(quote_token) = ?`,
      )
      .get(USDG)) as { n?: number | null } | undefined;
    return {
      allWithCurve,
      inWindow,
      returned: withCurve.length,
      usdgAll,
      usdgInWindow,
      usdgReturned,
      nativeReturned,
      otherReturned,
      cutoffAgeSec: oldestReturned === null ? null : now - oldestReturned,
      newestUsdgAgeSec: newestUsdg?.n ? now - Number(newestUsdg.n) : null,
    };
  } catch {
    // A diagnostic must never be the thing that breaks a tick.
    return null;
  }
}

export async function recentCandidates(
  maxAgeSec: number,
  limit = 25,
  opts: { poolsOnly?: boolean } = {},
): Promise<PoolCandidate[]> {
  try {
    const rows = await getDb()
      .prepare(
        // The curve columns ARE selected, unlike the pool-key ones. Those have
        // their own accessor (poolKeysFor, which the router asks directly); a
        // curve has none, and a pre-graduation token cannot be reached at all
        // without it — so a caller holding a candidate needs it in hand.
        `SELECT address, symbol, decimals, liquidity_usd, fdv_usd, first_seen, curve, quote_token, graduation_threshold
         FROM discovered_pools WHERE first_seen > unixepoch() - ?
         ${opts.poolsOnly ? "AND curve IS NULL" : ""}
         ORDER BY first_seen DESC LIMIT ?`,
      )
      .all(maxAgeSec, limit) as {
      address: string; symbol: string; decimals: number;
      liquidity_usd: number; fdv_usd: number; first_seen: number;
      curve: string | null; quote_token: string | null; graduation_threshold: string | null;
    }[];
    return rows.map((r) => ({
      address: r.address,
      symbol: r.symbol,
      decimals: Number(r.decimals) || 18,
      liquidityUsd: Number(r.liquidity_usd) || 0,
      fdvUsd: Number(r.fdv_usd) || 0,
      firstSeen: Number(r.first_seen) || 0,
      // `!= null` rather than truthiness: quote_token is legitimately the
      // all-zero address for a native-ETH curve, which is 53.6% of launches
      // and would read as absent under a truthy test.
      ...(r.curve != null && r.quote_token != null && r.graduation_threshold != null
        ? { curve: { curve: r.curve, quoteToken: r.quote_token, graduationThresholdRaw: r.graduation_threshold } }
        : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * The entry baseline a trench exit is judged against.
 *
 * Only depth and time live here. Entry PRICE is derived from cost basis
 * instead — that ledger already tracks exactly what was paid per raw unit, and
 * a second copy could disagree with it after a partial fill.
 */
/**
 * Stamp this position's graded floor. FIRST WRITE WINS, for ever.
 *
 * `ON CONFLICT DO NOTHING`, exactly as `setTrenchEntry` below, and for the
 * reason written on that one: a top-up must not move the reference, "which
 * would turn averaging down into a way of never stopping out". Here it also
 * stops a re-grade at a moment of panic — the grade belongs to the entry, and
 * the entry happened once.
 */
export async function setPositionFloor(
  agentId: string,
  mode: BasisMode,
  symbol: string,
  f: { stopBps: number; rung: string; why: string },
): Promise<void> {
  try {
    await getDb()
      .prepare(
        `INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, mode, symbol) DO NOTHING`,
      )
      .run(agentId, mode, symbol, Math.round(f.stopBps), f.rung, f.why.slice(0, 400));
  } catch (e) {
    // A floor that failed to stamp leaves the owner's own number in force,
    // which is the safe direction: the position is still protected, just not
    // graded. Never take a fill down for it.
    console.error("[store] position floor insert failed:", e);
  }
}

/**
 * Every graded floor this book carries, by symbol.
 *
 * Returns an EMPTY MAP on failure, never null, because the caller's fallback is
 * the owner's own floor — a level that is always correct to apply and never
 * more dangerous than the graded one. A read failure must degrade to the
 * owner's setting, not to no floor at all.
 */
export async function positionFloors(
  agentId: string,
  mode: BasisMode,
): Promise<Map<string, { stopBps: number; rung: string; why: string }>> {
  const out = new Map<string, { stopBps: number; rung: string; why: string }>();
  try {
    const rows = (await getDb()
      .prepare("SELECT symbol, stop_bps, rung, why FROM position_floors WHERE agent_id = ? AND mode = ?")
      .all(agentId, mode)) as { symbol: string; stop_bps: number; rung: string; why: string }[];
    for (const r of rows) {
      out.set(r.symbol, { stopBps: Number(r.stop_bps), rung: String(r.rung), why: String(r.why) });
    }
  } catch {
    /* the table arrives with a migration; the owner's own floor still applies */
  }
  return out;
}

export async function setTrenchEntry(agentId: string, mode: BasisMode, symbol: string, liquidityUsd: number): Promise<void> {
  try {
    await getDb()
      .prepare(
        `INSERT INTO trench_positions (agent_id, mode, symbol, entry_liquidity_usd)
         VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, mode, symbol) DO NOTHING`,
      )
      .run(agentId, mode, symbol, liquidityUsd);
  } catch (e) {
    console.error("[store] trench entry insert failed:", e);
  }
}

/**
 * Fill in a baseline that was stamped as UNKNOWN, once depth becomes readable.
 *
 * THE ROW MUST ALWAYS EXIST, because its ABSENCE is what tells trenchOpen a
 * position belongs to another strategy — so a fill with no depth reading has to
 * write something, and 0 is the honest value (the drain guard reads
 * `entryLiquidityUsd > 0` and turns itself off, which is exactly right for a
 * baseline nobody knows).
 *
 * What was missing was the way back. `setTrenchEntry` is ON CONFLICT DO NOTHING,
 * so a 0 written at fill time stayed 0 for the position's whole life and the rug
 * defence stayed off with it. This upgrades a zero — and ONLY a zero — the first
 * time a real reading arrives.
 *
 * Never overwrites a real baseline. The drain check compares against depth AT
 * ENTRY, so moving that reference later would quietly re-anchor it to a level
 * the position was not opened at, and a drain that had already happened would
 * stop counting as one.
 */
export async function upgradeTrenchEntry(
  agentId: string,
  mode: BasisMode,
  symbol: string,
  liquidityUsd: number,
): Promise<boolean> {
  if (!(liquidityUsd > 0)) return false;
  try {
    const res = await getDb()
      .prepare(
        `UPDATE trench_positions SET entry_liquidity_usd = ?
         WHERE agent_id = ? AND mode = ? AND symbol = ? AND entry_liquidity_usd <= 0`,
      )
      .run(liquidityUsd, agentId, mode, symbol);
    return (res as { changes?: number }).changes === undefined || (res as { changes?: number }).changes! > 0;
  } catch (e) {
    console.error("[store] trench entry upgrade failed:", e);
    return false;
  }
}

export async function getTrenchEntry(
  agentId: string,
  mode: BasisMode,
  symbol: string,
): Promise<{ liquidityUsd: number; entrySec: number } | null> {
  try {
    const row = await getDb()
      .prepare("SELECT entry_liquidity_usd, entry_sec FROM trench_positions WHERE agent_id = ? AND mode = ? AND symbol = ?")
      .get(agentId, mode, symbol) as { entry_liquidity_usd: number; entry_sec: number } | undefined;
    return row ? { liquidityUsd: Number(row.entry_liquidity_usd), entrySec: Number(row.entry_sec) } : null;
  } catch {
    return null;
  }
}

/** Forget a closed position, so re-entering later starts a fresh baseline. */
export async function clearTrenchEntry(agentId: string, mode: BasisMode, symbol: string): Promise<void> {
  try {
    await getDb()
      .prepare("DELETE FROM trench_positions WHERE agent_id = ? AND mode = ? AND symbol = ?")
      .run(agentId, mode, symbol);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Every curve this agent has recorded from a launch scan — the provenance set.
 *
 * WHY THIS EXISTS. The curve is the one argument the wall cannot pin: a new
 * address per token, hundreds an hour, so wall.ts passes `null` for it and says
 * so outright. Off-chain is therefore the ONLY place a curve can be constrained
 * at all, and checkPolicy's `curve-provenance` rule is the constraint.
 *
 * What makes the set trustworthy is upstream, not here: `recordCandidate`'s only
 * non-test callers are in the worker tick, and the launch scan that feeds them
 * filters on PONS_V2_FACTORY (venues/pons.ts). So a row in this column is an
 * address that appeared as the curve of a token launched by the real factory.
 * That property was INCIDENTAL until the policy rule started depending on it —
 * which is exactly why it is written down here.
 *
 * THE QUERY is not age-windowed and not LIMIT-bounded, unlike `recentCandidates`.
 * THE TABLE UNDER IT IS BOTH, and this comment used to promise otherwise: it
 * said "a position opened last week must still be exitable today", which is the
 * right requirement and is not something this function can deliver on its own.
 * `pruneDiscovered` trims `discovered_pools` to the 5,000 newest rows by
 * `first_seen`, and the launchpad alone adds roughly ten an hour — about 21 days
 * to full turnover, against a 14-day default grant.
 *
 * So a curve CAN age out from under an open position, and for a class position
 * that is fatal rather than inconvenient: its output leg is un-enumerated by
 * design, so `curve-provenance` is the only rule vouching for it, and losing the
 * row means the mirror refuses the sell that would close it while the wall would
 * have allowed it — the exit trap the vault exists to remove, rebuilt off-chain.
 *
 * The requirement is met by the CALLER instead, which unions this with
 * `classPositionCurves` — an agent's own open positions, which nothing prunes.
 * Written down here because the promise was made here.
 *
 * Returns null on failure, never []. Empty means "no curves known", which would
 * refuse the whole venue; null means "could not ask", which leaves the rule
 * unable to run rather than silently converting a database hiccup into a
 * blanket refusal.
 */
/** One token this agent's class vault is believed to hold. See `class_positions`. */
export interface ClassPositionRow {
  token: string;
  symbol: string | null;
  decimals: number;
  curve: string | null;
  quoteToken: string | null;
  /**
   * When this position was first recorded, unix seconds.
   *
   * Selected because the EXIT needs a clock that does not depend on a price. A
   * class token has no oracle and may have no depth at all, so a stop-loss
   * cannot reach it — but "you have held this for N hours" is always answerable,
   * and a position that can always be closed is the difference between a
   * position and a trap.
   */
  firstSeen: number;
  /** The vault this was bought into, for recovery when no grant is available. */
  vault: string | null;
  /** The transaction that opened it, and the one that closed it. */
  entryTx: string | null;
  exitTx: string | null;
  /**
   * ACTUAL USDG spent and ACTUAL tokens received, raw, from `ClassBuy`.
   *
   * Null means UNKNOWN, which is the honest state for a position rediscovered
   * from a vault balance whose entry log is outside the scanned range. It is
   * not zero: a zero cost reports the whole exit as profit, and a zero quantity
   * hides somebody's money.
   */
  costRaw: bigint | null;
  qtyRaw: bigint | null;
  /** USDG returned by sells so far. */
  proceedsRaw: bigint | null;
  /** Block of the first buy — the clock the chain keeps, immune to a redeploy. */
  openedAtBlock: bigint | null;
  /** 'open' | 'closed' | 'recovered' — see the column comment in the migration. */
  state: string;
}

/**
 * The candidate list for this agent's class vault, or null.
 *
 * NULL ON FAILURE, NEVER []. The two mean opposite things to every caller: []
 * is "this vault holds nothing", which is an honest zero, and null is "the
 * question could not be asked", which must never close a cost basis or publish
 * an equity figure. Same discipline as `knownCurves` below, and it matters more
 * here because the consequence downstream is a deletion.
 */
export async function classPositions(agentId: string): Promise<ClassPositionRow[] | null> {
  try {
    const rows = (await getDb()
      .prepare(
        `SELECT token, symbol, decimals, curve, quote_token, first_seen, vault, entry_tx, exit_tx,
                cost_usdg, qty_raw, proceeds_usdg, opened_at_block, state
           FROM class_positions WHERE agent_id = ?`,
      )
      .all(agentId)) as {
      token: string;
      symbol: string | null;
      decimals: number;
      curve: string | null;
      quote_token: string | null;
      first_seen: number | null;
      vault: string | null;
      entry_tx: string | null;
      exit_tx: string | null;
      cost_usdg: string | null;
      qty_raw: string | null;
      proceeds_usdg: string | null;
      opened_at_block: string | null;
      state: string | null;
      swept_raw: string | null;
    }[];
    // NULL STAYS NULL through this map. Every one of these is money or the
    // clock money is measured against, and `?? 0n` on any of them would turn
    // "we do not know" into a confident wrong number.
    const big = (v: string | null): bigint | null => {
      if (v === null) return null;
      try {
        return BigInt(v);
      } catch {
        return null;
      }
    };
    return rows.map((r) => ({
      token: r.token.toLowerCase(),
      symbol: r.symbol,
      decimals: r.decimals,
      curve: r.curve ? r.curve.toLowerCase() : null,
      quoteToken: r.quote_token ? r.quote_token.toLowerCase() : null,
      vault: r.vault ? r.vault.toLowerCase() : null,
      entryTx: r.entry_tx,
      exitTx: r.exit_tx,
      costRaw: big(r.cost_usdg),
      qtyRaw: big(r.qty_raw),
      proceedsRaw: big(r.proceeds_usdg),
      openedAtBlock: big(r.opened_at_block),
      state: r.state ?? "open",
      sweptRaw: big(r.swept_raw),
      // A NULL clock reads as "right now", not as 1970. The column has a
      // default so this should not happen, but a zero would make every position
      // instantly older than any hold window and force an immediate exit — an
      // unreadable age must not be able to sell somebody's book.
      firstSeen: r.first_seen ?? Math.floor(Date.now() / 1000),
    }));
  } catch {
    return null;
  }
}

/**
 * The curves of this agent's OWN open class positions.
 *
 * Unioned into `knownCurves` at arm time so a position can never be evicted out
 * of its own exit — see the `class_positions` migration for why that is a real
 * hazard rather than a theoretical one. Null on failure, and the caller must
 * treat a null from EITHER source as "the rule cannot run" rather than merging a
 * partial list: for a class trade a short list is a refusal, so a partial one is
 * a silent refusal of exactly the positions that were dropped.
 */
export async function classPositionCurves(agentId: string): Promise<string[] | null> {
  const rows = await classPositions(agentId);
  if (rows === null) return null;
  return rows.map((r) => r.curve).filter((c): c is string => !!c);
}

/**
 * Write what the CHAIN says about one class position.
 *
 * IDEMPOTENT BY CONSTRUCTION, and that is the whole design rather than a nice
 * property. Every figure here is a fold over `(txHash, logIndex)`-identified
 * events, so writing the same reconciliation twice writes the same row. There
 * is no `+=` anywhere in this path: a restart, a re-arm and a replayed block
 * range all converge on the same numbers, which is the only way an accrual that
 * feeds a spending budget can survive a redeploy loop.
 *
 * Contrast `upsertClassPosition` below, which records a CANDIDATE — a token to
 * ask the chain about. This records the answer.
 */

/**
 * THE QUOTE ASSET IS NEVER A POSITION, AT THE WRITE.
 *
 * The reconciler no longer offers it one, and this is the backstop for the
 * producer nobody has written yet. A row for USDG is not a harmless extra
 * record: it occupies a slot under `classMaxPositions`, offers itself to the
 * exit producer with no curve to sell through, takes a hold clock it can
 * never age out of, and enters the class P&L inventory with a basis that
 * cannot exist. Shogun's entry route was shut by exactly one of these.
 *
 * Returns TRUE when the row must be refused. Address-keyed — a launch token
 * can call itself USDG, and must still be recorded.
 */
function isCashRow(token: string, quoteToken?: string | null): boolean {
  const t = token.toLowerCase();
  if (t === CASH.USDG.toLowerCase()) return true;
  return quoteToken != null && t === quoteToken.toLowerCase();
}
export async function writeClassLedger(
  agentId: string,
  row: {
    token: string;
    vault: string;
    curve: string | null;
    costRaw: bigint | null;
    qtyRaw: bigint | null;
    proceedsRaw: bigint | null;
    openedAtBlock: bigint | null;
    entryTx: string | null;
    exitTx: string | null;
    state: "open" | "closed" | "recovered" | "swept";
    /**
     * Tokens the owner swept out. Null when the tape could not say.
     *
     * Stored so "gone because it was sold" and "gone because the owner took it
     * home" stay distinguishable after the fact. The row is the only place that
     * difference survives, and every consequence of the position turns on it:
     * a sale has proceeds and a result, a withdrawal has neither.
     */
    sweptRaw: bigint | null;
  },
): Promise<void> {
  // Cash in the vault is custody. See isCashRow. This row carries no
  // `quoteToken` column, so only the address test applies here — which is the
  // one that catches the real case, since a cash row has no curve to read a
  // pair token from in the first place.
  if (isCashRow(row.token)) return;
  try {
    await getDb()
      .prepare(
        `INSERT INTO class_positions
           (agent_id, token, vault, curve, cost_usdg, qty_raw, proceeds_usdg, opened_at_block, entry_tx, exit_tx, state, swept_raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, token) DO UPDATE SET
           vault = COALESCE(excluded.vault, vault),
           curve = COALESCE(excluded.curve, curve),
           cost_usdg = COALESCE(excluded.cost_usdg, cost_usdg),
           qty_raw = COALESCE(excluded.qty_raw, qty_raw),
           proceeds_usdg = COALESCE(excluded.proceeds_usdg, proceeds_usdg),
           opened_at_block = COALESCE(excluded.opened_at_block, opened_at_block),
           entry_tx = COALESCE(excluded.entry_tx, entry_tx),
           exit_tx = COALESCE(excluded.exit_tx, exit_tx),
           state = excluded.state,
           swept_raw = COALESCE(excluded.swept_raw, swept_raw)`,
      )
      .run(
        agentId,
        row.token.toLowerCase(),
        row.vault.toLowerCase(),
        row.curve,
        // Stored as TEXT. A bigint through a REAL column loses precision at
        // 2^53, and a memecoin quantity at 18dp passes that in the first token.
        row.costRaw === null ? null : row.costRaw.toString(),
        row.qtyRaw === null ? null : row.qtyRaw.toString(),
        row.proceedsRaw === null ? null : row.proceedsRaw.toString(),
        row.openedAtBlock === null ? null : row.openedAtBlock.toString(),
        row.entryTx,
        row.exitTx,
        row.state,
        row.sweptRaw === null ? null : row.sweptRaw.toString(),
      );
  } catch (e) {
    console.error("[store] class ledger write failed:", e);
  }
}

/** Remember that the class vault now holds this token. Idempotent by (agent, token). */
export async function upsertClassPosition(
  agentId: string,
  // THE CANDIDATE FIELDS ONLY — which token, on which curve, priced in what.
  //
  // Not the whole row, and not the clock. The money columns are written by
  // `writeClassLedger` from the chain's own events, because they are the one
  // thing a caller must never be able to assert: a proposal knows the size it
  // ASKED for, and booking that as a cost is how a budget drifts from reality
  // by one slippage per fill. The clock is excluded for the matching reason —
  // a re-record on a top-up must not rejuvenate a position past its exit.
  row: Pick<ClassPositionRow, "token" | "symbol" | "decimals" | "curve" | "quoteToken">,
): Promise<void> {
  // Cash in the vault is custody. See isCashRow.
  if (isCashRow(row.token, row.quoteToken)) return;
  try {
    await getDb()
      .prepare(
        `INSERT INTO class_positions (agent_id, token, symbol, decimals, curve, quote_token)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, token) DO UPDATE SET
           symbol = COALESCE(excluded.symbol, symbol),
           decimals = excluded.decimals,
           curve = COALESCE(excluded.curve, curve),
           quote_token = COALESCE(excluded.quote_token, quote_token)`,
      )
      .run(
        agentId,
        row.token.toLowerCase(),
        row.symbol,
        row.decimals,
        row.curve,
        row.quoteToken,
      );
  } catch (e) {
    console.error("[store] class_positions insert failed:", e);
  }
}

export async function knownCurves(): Promise<string[] | null> {
  try {
    const rows = (await getDb()
      .prepare(`SELECT DISTINCT curve FROM discovered_pools WHERE curve IS NOT NULL`)
      .all()) as { curve: string | null }[];
    const discovered = rows.map((r) => r.curve).filter((c): c is string => !!c).map((c) => c.toLowerCase());
    // OFFICIAL CURVES JOIN THE PROVENANCE SET, for the same reason `curveFor`
    // consults the listing first: the launch scan may never have seen a listed
    // coin (it launched before this worker existed, or its row was pruned), and
    // the curve-provenance rule would then refuse the very trades the platform
    // published the coin to make — including the SELL that closes a position.
    //
    // Unioned ONLY on a successful read. A failed read returns null below, and
    // must keep returning null: `null` means "could not tell" and makes the
    // caller pass `undefined`, while a list containing only the official curves
    // would be a PARTIAL answer, which silently refuses exactly the positions it
    // dropped. A short provenance list is a refusal; a partial one is a silent
    // refusal, which is worse.
    const official = officialCoinsFor(robinhoodChain.id).map((c) => c.curve.toLowerCase());
    return [...new Set([...discovered, ...official])];
  } catch {
    return null;
  }
}


/**
 * Where a specific token trades on the launchpad — by address, not by recency.
 *
 * `recentCandidates` cannot serve this: it is age-windowed, LIMIT-bounded, and
 * its only production caller passes `poolsOnly`, whose SQL filters out exactly
 * these rows. Pricing asks a different question — "this token, right now" — and
 * needs its own query.
 *
 * All three fields or nothing. The threshold is what makes the reserves
 * interpretable (the virtual seed is 40% of it), so a row missing it can be
 * READ but not priced, and returning a partial answer would invite a caller to
 * fill the gap with a zero.
 */
export async function curveFor(
  address: string,
): Promise<{ curve: string; quoteToken: string; graduationThresholdRaw: bigint } | null> {
  // AN OFFICIAL LISTING CARRIES ITS OWN CURVE, and it is consulted before the
  // table rather than as a fallback behind it.
  //
  // `discovered_pools` cannot be the authority for a listing. It is wiped on
  // every redeploy in hosted mode (the child's sqlite is rebuilt beneath it),
  // and `pruneDiscovered` trims it to the 5,000 newest rows against a launchpad
  // measured at ~475 launches an hour — so a coin the PLATFORM published would
  // lose its own provenance within hours and become unpriceable and unsellable.
  // A position the platform put an owner into and then forgot how to value is
  // the no-exit trap in its purest form, so the pinned record wins.
  //
  // The two cannot meaningfully disagree — both decode the same launch log —
  // but where they could, the verified constant is the one to trust.
  const official = officialCoinCurve(robinhoodChain.id, address);
  if (official) {
    return {
      curve: official.curve,
      quoteToken: official.quoteToken,
      graduationThresholdRaw: official.graduationThresholdRaw,
    };
  }
  try {
    const row = (await getDb()
      .prepare(
        `SELECT curve, quote_token, graduation_threshold FROM discovered_pools
         WHERE address = ? AND curve IS NOT NULL AND graduation_threshold IS NOT NULL`,
      )
      .get(address.toLowerCase())) as
      | { curve: string; quote_token: string | null; graduation_threshold: string }
      | undefined;
    // `!= null` on quote_token, never truthiness: the all-zero address is the
    // legitimate native-ETH case and covers 53.6% of launches.
    if (!row || row.quote_token == null) return null;
    const threshold = BigInt(row.graduation_threshold);
    if (threshold <= 0n) return null;
    return { curve: row.curve, quoteToken: row.quote_token, graduationThresholdRaw: threshold };
  } catch {
    return null;
  }
}

/**
 * WHAT BRAIN ALREADY THOUGHT ABOUT — durable, so a restart cannot forget.
 *
 * The accounting work spent weeks on one bug shape: a redeploy wipes the child
 * ledger, the child forgets, and it books the same thing again. An AI budget has
 * exactly that failure available to it, and it is worse in one respect — a
 * forgotten contribution is a wrong number, a forgotten cooldown is a bill.
 *
 * Best-effort on both sides: a trigger-state read or write that fails must never
 * take a tick down. A failed READ degrades to a cold start, which the caller
 * seeds conservatively; a failed WRITE costs at most one extra run.
 */
export async function loadTriggerState(agentId: string): Promise<Record<string, unknown> | null> {
  try {
    const row = (await getDb()
      .prepare("SELECT state_json FROM brain_trigger_state WHERE agent_id = ?")
      .get(agentId)) as { state_json: string } | undefined;
    if (!row?.state_json) return null;
    return JSON.parse(row.state_json) as Record<string, unknown>;
  } catch {
    // A cold start is the safe reading of "I cannot tell": the caller seeds
    // cooldowns as though Brain just ran, so an unreadable row delays thinking
    // rather than repeating it.
    return null;
  }
}

export async function saveTriggerState(agentId: string, state: unknown): Promise<void> {
  try {
    await getDb()
      .prepare(
        `INSERT INTO brain_trigger_state (agent_id, state_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(agentId, JSON.stringify(state), Math.floor(Date.now() / 1000));
  } catch (e) {
    console.error("[brain] trigger state write failed:", e);
  }
}

/**
 * CAN THE LEDGER SAY HOW THE CURRENT POSITIONS WERE ACQUIRED?
 *
 * `PortfolioQuality.positionHistoryAvailable`, MEASURED — it was hardcoded
 * `false` in the snapshot builder, which is not a cautious default but a claim:
 * "there is no position history". Nobody had asked. And it cost the fleet
 * everything, because Brain's gate downgrades a book to `hold` at three quality
 * caveats and a never-traded agent had exactly three — this one, the audit that
 * has genuinely not run, and gas basis "unknown" because it has never paid any.
 * So every agent that had not yet traded was structurally forbidden from
 * trading: it could not trade because it had never traded.
 *
 * VACUOUSLY TRUE FOR AN EMPTY BOOK, and that is the point rather than a
 * loophole. "Nothing can be said about how this book got here" is a statement
 * about a book with holdings whose origin is missing. A book with no holdings
 * has no origin to be missing, and answering `false` there conflates "we found
 * a gap" with "there was nothing to find" — the distinction this codebase draws
 * everywhere else between empty and unavailable.
 *
 * A READ FAILURE IS `false`, not true: unable to check is not the same as
 * checked and fine, and the caveat is the safe direction.
 */
export async function positionsExplained(agentId: string, tokens: readonly string[]): Promise<boolean> {
  const want = [...new Set(tokens.map((t) => t.toLowerCase()))].filter(Boolean);
  if (want.length === 0) return true;
  try {
    const rows = (await getDb()
      .prepare(
        // Any epoch. A fill booked before an epoch bump still explains how the
        // token got here — epoch scopes what may be MEASURED over, not what is
        // remembered.
        `SELECT DISTINCT LOWER(buy_token) AS token FROM trades
          WHERE agent_id = ? AND status = 'landed' AND buy_token IS NOT NULL`,
      )
      .all(agentId)) as { token: string }[];
    const seen = new Set(rows.map((r) => r.token));
    return want.every((t) => seen.has(t));
  } catch {
    return false;
  }
}

/**
 * Correct a class position's hold clock to when the chain says it opened.
 *
 * SEPARATE FROM `upsertClassPosition` ON PURPOSE. That function excludes the
 * clock, and its comment says why: a re-record on a top-up must not rejuvenate a
 * position past its exit. This is the one legitimate exception — restoring a
 * clock that a container rebuild reset is the opposite of rejuvenating it — so
 * it gets its own narrow function rather than a flag on the general one.
 *
 * ONLY EVER EARLIER. Guarded in SQL rather than by the caller: a write that
 * could move a clock FORWARD is a write that could postpone an exit, and the
 * whole point of the hold timer is that it cannot be postponed.
 */
export async function setClassFirstSeen(
  agentId: string,
  token: string,
  firstSeen: number,
): Promise<void> {
  if (!Number.isFinite(firstSeen) || firstSeen <= 0) return;
  try {
    await getDb()
      .prepare(
        `UPDATE class_positions SET first_seen = ?
          WHERE agent_id = ? AND LOWER(token) = LOWER(?) AND first_seen > ?`,
      )
      .run(Math.floor(firstSeen), agentId, token, Math.floor(firstSeen));
  } catch (e) {
    console.error("[store] class first_seen update failed:", e);
  }
}

// ══ PERPETUALS: THE LEDGER (docs/perps.md, "Ledger", rules 9, 10 and 12) ══════
//
// Three kinds of writer live here, and they fail differently on purpose.
//
//   JOURNALED FACTS — insertPerpFill, insertPerpFunding, upsertPerpTransfer,
//   recordPerpCarry. The venue is authoritative for what happened and the
//   ledger records it ONCE (rule 10): each inserts its row and appends its
//   hash-chained journal entry in one transaction, and appends ONLY when the
//   insert actually inserted — insertFlowWithJournal's `changes === 1` gate,
//   not journaled()'s unconditional append, because an ingest re-reads the
//   same trades on every reconcile and a re-read must not journal a fill
//   twice. They THROW on a failed write: an ingest cursor must not move past
//   a fact that was not booked.
//
//   OPERATIONAL ROWS — the rule-9 order rows, their legs, the nonce
//   high-water, positions and the account row. Not money facts, so not
//   journaled; they are what makes a signed transaction impossible to replay
//   after a crash. insertPerpOrderSubmitted throws PerpNotRecorded on ANY
//   failure, and the caller sends nothing.
//
//   BUDGET READS — perpOpenNotionalSince and perpOpsSince, already inside
//   getSpentTodayUsdg and getOpsToday. They throw rather than answer zero.
//
// Every perp row's agent_id is the account LOWERCASED; the journal is keyed by
// the agents row's own spelling (perpBookingOf). Every input is validated
// before the first write, so a malformed fact refuses the whole transaction
// rather than landing half-checked.

export type {
  PerpAttribution,
  PerpLegRole,
  PerpLegStatus,
  PerpMode,
  PerpOrderEffect,
  PerpOrderStatus,
  PerpTradeType,
  PerpTransferDirection,
  PerpTransferInitiator,
  PerpTransferState,
} from "./perp-ledger-rules";

/** A perp row's agent id, as every perp table stores it. */
function perpAgent(agentId: string): string {
  if (typeof agentId !== "string" || agentId.trim() === "") throw new RangeError("perp ledger: an agent id is required");
  return agentId.toLowerCase();
}

function perpMode(mode: unknown): PerpMode {
  if (!isPerpMode(mode)) throw new RangeError(`perp ledger: mode ${String(mode)} is neither 'paper' nor 'live'`);
  return mode;
}

function safeInt(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new RangeError(`perp ledger: ${what} ${String(v)} is not an integer in [${min}, ${max}]`);
  }
  return v;
}

function optSafeInt(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return v === null || v === undefined ? null : safeInt(v, what, min, max);
}

function optInt(v: bigint | null | undefined, what: string, opts: { min?: bigint } = {}): string | null {
  return v === null || v === undefined ? null : intText(v, what, opts);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new RangeError(`perp ledger: ${what} ${String(v)} is not one of ${allowed.join(", ")}`);
  }
  return v as T;
}

/** A hash as stored: lowercase hex, `0x`-prefixed or not by kind. `hexLen` pins the length when the kind has one. */
function hashText(v: unknown, what: string, opts: { prefixed: boolean; hexLen?: number }): string {
  if (typeof v !== "string") throw new RangeError(`perp ledger: ${what} is not a string`);
  const s = v.toLowerCase();
  const body = opts.prefixed ? (s.startsWith("0x") ? s.slice(2) : null) : s.replace(/^0x/, "");
  if (body === null || !/^[0-9a-f]+$/.test(body) || (opts.hexLen !== undefined && body.length !== opts.hexLen)) {
    throw new RangeError(`perp ledger: ${what} ${JSON.stringify(v)} is not a ${opts.hexLen ?? ""}-hex hash`);
  }
  return opts.prefixed ? `0x${body}` : body;
}

/** An identifier the venue or the paper engine gave a fact: short, printable, never empty. */
function idText(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(v)) {
    throw new RangeError(`perp ledger: ${what} ${JSON.stringify(v)} is not a usable identifier`);
  }
  return v;
}

/** The market's key for the journal ("BTC-PERP"), or null for a market we never trade (still booked). */
function marketKeyOf(marketId: number): string | null {
  return perpMarketById(marketId)?.key ?? null;
}

/**
 * THE EPOCH TO BOOK INTO AND THE SPELLING TO JOURNAL UNDER, read inside the
 * writer's own transaction.
 *
 * The no-op UPDATE is addFlow's device: on Postgres it holds this agent's row
 * until commit, so a fact cannot be booked into an epoch openNextEpoch is
 * closing at the same instant; sqlite serialises the transaction anyway.
 *
 * THE JOURNAL IS KEYED BY THE AGENTS ROW'S SPELLING, not by the lowercased id
 * the perp tables use. Every other writer journals under grant.smartAccount —
 * EIP-55 as often as not — and a perp fact chained under the lowercase
 * spelling would start a second hash chain beside the agent's real one, which
 * a verifier reads as a hole in the first. With no agents row (a ledger that
 * has not armed) the fact is booked into epoch 1 under the id as given —
 * addFlow's fallback.
 */
async function perpBookingOf(db: Db, agentId: string): Promise<{ epoch: number; journalAs: string }> {
  const row = (await db
    .prepare(
      `UPDATE agents SET epoch = epoch WHERE LOWER(smart_account) = LOWER(?)
       RETURNING epoch, smart_account`,
    )
    .get(agentId)) as { epoch: number; smart_account: string } | undefined;
  return row ? { epoch: Number(row.epoch), journalAs: row.smart_account } : { epoch: 1, journalAs: agentId };
}

/**
 * One transaction: the booking read, the domain write, and — only when the
 * write says something happened — its journal entry. journaled()'s gated twin:
 * that function takes the epoch before its transaction and appends whatever
 * the write did, which is right for a mark and wrong for an idempotent ingest.
 */
async function perpJournaled<T>(
  agentId: string,
  kind: JournalKind,
  write: (db: Db, epoch: number) => Promise<{ result: T; payload: unknown | null }>,
): Promise<T> {
  return getDb().tx(async (db) => {
    const { epoch, journalAs } = await perpBookingOf(db, agentId);
    const { result, payload } = await write(db, epoch);
    if (payload !== null) await appendJournalRow(db, journalAs, epoch, kind, payload);
    return result;
  });
}

/**
 * Extra writes that must land with a fact or not at all — the paper book's
 * collateral and position moving with its own fill, say. Called inside the
 * fact's transaction, and ONLY when the fact was actually booked, so a re-read
 * of a fill can never move the paper book twice. Anything it throws rolls the
 * fact back with it.
 */
export type PerpWith = (db: Db) => Promise<void>;

// ── fills ────────────────────────────────────────────────────────────────────

export interface PerpFillInput {
  agentId: string;
  mode: PerpMode;
  /** `trade_id_str` on the venue; the paper engine's own id on paper. */
  venueTradeId: string;
  /** Which side of the trade was OURS — a self-trade is two fills, one each. */
  sideRole: "ask" | "bid";
  marketId: number;
  /** The POSITION side this fill trades (long for an opening bid AND its closing ask) — never "sell". */
  side: PerpSide;
  role?: "maker" | "taker" | null;
  /** Venue base units, > 0. */
  base: bigint;
  /** Venue price units, > 0. */
  price: bigint;
  /** The venue's usd_amount, micro-USDG. */
  quoteMicro: bigint;
  /** Signed: a maker rebate is negative. */
  feeMicro: bigint;
  /** Null until derived — unknown, never zero. */
  realizedMicro?: bigint | null;
  /** Signed base before this fill, so realized can be re-derived. */
  positionBefore?: bigint | null;
  entryQuoteBeforeMicro?: bigint | null;
  tradeType: PerpTradeType;
  attribution: PerpAttribution;
  /** Our perp_orders row, when the fill is ours by intent. */
  orderId?: string | null;
  venueOrderIndex?: string | null;
  clientOrderIndex?: number | null;
  /** The venue tx that produced the trade (80 hex, no 0x). */
  venueTxHash?: string | null;
  /** The venue's trade timestamp, MILLISECONDS. */
  venueTsMs: number;
}

/**
 * What an idempotent insert did. `duplicate` is the ordinary re-read — the
 * same fact, already booked, nothing written. `mismatch` is the same identity
 * with DIFFERENT venue facts: nothing is overwritten (the first booking
 * stands), and the caller must treat it as a book gap, because either the
 * venue changed its story or our parse did.
 */
export type PerpInsertOutcome = "inserted" | "duplicate" | "mismatch";

/**
 * BOOK A FILL, by the venue's identity, with its `perp-fill` journal entry —
 * once. See the section header for the contract; `opts.with` for the writes
 * that must move with it.
 */
export async function insertPerpFill(fill: PerpFillInput, opts: { with?: PerpWith } = {}): Promise<PerpInsertOutcome> {
  const agent = perpAgent(fill.agentId);
  const mode = perpMode(fill.mode);
  const venueTradeId = idText(fill.venueTradeId, "venue trade id");
  const sideRole = oneOf(fill.sideRole, ["ask", "bid"] as const, "side role");
  const marketId = safeInt(fill.marketId, "market id", 0, 65_535);
  const side = oneOf(fill.side, ["long", "short"] as const, "side");
  const role = fill.role === null || fill.role === undefined ? null : oneOf(fill.role, ["maker", "taker"] as const, "role");
  const base = intText(fill.base, "fill base", { min: 1n });
  const price = intText(fill.price, "fill price", { min: 1n });
  const quote = intText(fill.quoteMicro, "fill quote", { min: 0n });
  const fee = intText(fill.feeMicro, "fill fee");
  const realized = optInt(fill.realizedMicro, "realized");
  const positionBefore = optInt(fill.positionBefore, "position before");
  const entryQuoteBefore = optInt(fill.entryQuoteBeforeMicro, "entry quote before");
  const tradeType = oneOf(fill.tradeType, PERP_TRADE_TYPES, "trade type");
  const attribution = oneOf(fill.attribution, PERP_ATTRIBUTIONS, "attribution");
  const orderId = fill.orderId === null || fill.orderId === undefined ? null : idText(fill.orderId, "order id");
  const venueOrderIndex = fill.venueOrderIndex === null || fill.venueOrderIndex === undefined ? null : intText(fill.venueOrderIndex, "venue order index", { min: 0n });
  const coi = optSafeInt(fill.clientOrderIndex, "client order index", 0, Number(PERP_COI_MAX));
  const venueTxHash = fill.venueTxHash === null || fill.venueTxHash === undefined ? null : hashText(fill.venueTxHash, "venue tx hash", { prefixed: false });
  const venueTsMs = safeInt(fill.venueTsMs, "venue timestamp (ms)", 1);

  return perpJournaled(fill.agentId, "perp-fill", async (db, epoch) => {
    const res = await db
      .prepare(
        `INSERT INTO perp_fills (agent_id, mode, epoch, venue_trade_id, side_role, market_id, side, role, base, price,
                                 quote_micro, fee_micro, realized_micro, position_before, entry_quote_before_micro,
                                 trade_type, attribution, order_id, venue_order_index, client_order_index,
                                 venue_tx_hash, venue_ts_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(agent, mode, epoch, venueTradeId, sideRole, marketId, side, role, base, price, quote, fee, realized,
        positionBefore, entryQuoteBefore, tradeType, attribution, orderId, venueOrderIndex, coi, venueTxHash, venueTsMs);
    if (Number(res.changes) === 0) {
      const held = (await db
        .prepare(
          `SELECT market_id, side, base, price, quote_micro, fee_micro, trade_type FROM perp_fills
            WHERE agent_id = ? AND mode = ? AND venue_trade_id = ? AND side_role = ?`,
        )
        .get(agent, mode, venueTradeId, sideRole)) as Record<string, unknown> | undefined;
      // The venue facts only: realized and attribution are OUR derivations and
      // may legitimately differ on a re-read that knows more.
      const same =
        held !== undefined &&
        Number(held.market_id) === marketId &&
        held.side === side &&
        held.base === base &&
        held.price === price &&
        held.quote_micro === quote &&
        held.fee_micro === fee &&
        held.trade_type === tradeType;
      return { result: same ? "duplicate" : "mismatch", payload: null };
    }
    if (opts.with) await opts.with(db);
    return {
      result: "inserted",
      payload: {
        attribution,
        base,
        clientOrderIndex: coi,
        entryQuoteBeforeMicro: entryQuoteBefore,
        feeMicro: fee,
        market: marketKeyOf(marketId),
        marketId,
        mode,
        orderId,
        positionBefore,
        price,
        quoteMicro: quote,
        realizedMicro: realized,
        role,
        side,
        sideRole,
        tradeType,
        venueOrderIndex,
        venueTradeId,
        venueTsMs,
        venueTxHash,
      },
    };
  });
}

// ── funding ──────────────────────────────────────────────────────────────────

export interface PerpFundingInput {
  agentId: string;
  mode: PerpMode;
  marketId: number;
  /** The venue's funding_id; the paper engine's own id on paper. */
  fundingId: string;
  /** Unix SECONDS, on the hour. */
  fundingHour: number;
  /** Signed: + received, − paid. */
  paymentMicro: bigint;
  ratePpm?: number | null;
  positionBase?: bigint | null;
  positionSide?: PerpSide | null;
}

/** `hour-conflict`: that (market, hour) is already booked under ANOTHER funding id — one payment, never two. */
export type PerpFundingOutcome = PerpInsertOutcome | "hour-conflict";

/** BOOK A FUNDING PAYMENT with its `funding` journal entry — once per id, and once per market-hour. */
export async function insertPerpFunding(f: PerpFundingInput, opts: { with?: PerpWith } = {}): Promise<PerpFundingOutcome> {
  const agent = perpAgent(f.agentId);
  const mode = perpMode(f.mode);
  const marketId = safeInt(f.marketId, "market id", 0, 65_535);
  const fundingId = idText(f.fundingId, "funding id");
  const fundingHour = safeInt(f.fundingHour, "funding hour", 0);
  if (fundingHour % 3600 !== 0) throw new RangeError(`perp ledger: funding hour ${fundingHour} is not on the hour`);
  const payment = intText(f.paymentMicro, "funding payment");
  const ratePpm = optSafeInt(f.ratePpm, "funding rate (ppm)", -1_000_000, 1_000_000);
  const positionBase = optInt(f.positionBase, "funding position base", { min: 0n });
  const positionSide =
    f.positionSide === null || f.positionSide === undefined ? null : oneOf(f.positionSide, ["long", "short"] as const, "position side");

  return perpJournaled(f.agentId, "funding", async (db, epoch) => {
    const res = await db
      .prepare(
        `INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro,
                                   rate_ppm, position_base, position_side)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(agent, mode, epoch, marketId, fundingId, fundingHour, payment, ratePpm, positionBase, positionSide);
    if (Number(res.changes) === 0) {
      const held = (await db
        .prepare(`SELECT funding_hour, payment_micro FROM perp_funding WHERE agent_id = ? AND mode = ? AND market_id = ? AND funding_id = ?`)
        .get(agent, mode, marketId, fundingId)) as { funding_hour: number; payment_micro: string } | undefined;
      if (held === undefined) return { result: "hour-conflict", payload: null };
      const same = Number(held.funding_hour) === fundingHour && held.payment_micro === payment;
      return { result: same ? "duplicate" : "mismatch", payload: null };
    }
    if (opts.with) await opts.with(db);
    return {
      result: "inserted",
      payload: {
        fundingHour,
        fundingId,
        market: marketKeyOf(marketId),
        marketId,
        mode,
        paymentMicro: payment,
        positionBase,
        positionSide,
        ratePpm,
      },
    };
  });
}

// ── transfers ────────────────────────────────────────────────────────────────

export interface PerpTransferInput {
  agentId: string;
  mode: PerpMode;
  /** Omit to have one made; pass it to address a row you already hold. */
  id?: string;
  direction: PerpTransferDirection;
  /** > 0, micro-USDG. Immutable once written. */
  amountMicro: bigint;
  initiator: PerpTransferInitiator;
  state: PerpTransferState;
  /** The chain log that proves the row (a Deposit, or an unrequested payout's WithdrawPending). */
  chainId?: number | null;
  txHash?: string | null;
  logIndex?: number | null;
  /** Our own UserOp (a deposit's). */
  userOpHash?: string | null;
  /** Our L2 Withdraw's tx hash (80 hex, no 0x). */
  venueTxHash?: string | null;
  /** The payout that covered a withdrawal — not an identity (one payout can cover several). */
  paidTxHash?: string | null;
  paidLogIndex?: number | null;
}

export type PerpTransferOutcome =
  /** A new row; `journaled` when it was born already carrying money (landed, executed, paid…). */
  | { outcome: "inserted"; id: string; state: PerpTransferState; journaled: boolean }
  /** An existing row moved forward; `journaled` when the step moved money. */
  | { outcome: "advanced"; id: string; from: PerpTransferState; state: PerpTransferState; journaled: boolean }
  /** Already at or past that state: nothing moved (a missing identity column may have been filled). */
  | { outcome: "unchanged"; id: string; state: PerpTransferState }
  /** The input contradicts the row it names — another direction, amount or identity. Nothing written. */
  | { outcome: "refused"; id: string | null; why: string };

interface TransferRowDb {
  id: string;
  direction: string;
  amount_micro: string;
  initiator: string;
  state: string;
  chain_id: number | null;
  tx_hash: string | null;
  log_index: number | null;
  user_op_hash: string | null;
  venue_tx_hash: string | null;
  paid_tx_hash: string | null;
  paid_log_index: number | null;
}

/**
 * WRITE OR ADVANCE ONE MARGIN TRANSFER, and journal `margin` on every step
 * that moved money (perp-ledger-rules.ts perpTransferMovesMoney).
 *
 * THE ROW IS FOUND BY ANY IDENTITY IT HAS — its id, its chain log, our L2
 * Withdraw's hash, our UserOp — so the same deposit learned first from the
 * UserOp rail and later from the proxy's log is one row, not two, and a re-read
 * after a crash advances the row it already wrote. Two identities that name
 * two different rows is a contradiction and is refused.
 *
 * STATES ONLY MOVE FORWARD. A lower or equal rank is `unchanged` — the venue
 * history is allowed to lag and must never walk a paid withdrawal back into
 * transit (the margin-in-transit amendment: "the venue history only ever
 * moves a row forward"). Identity columns are filled when empty and never
 * overwritten. Paper transfers are instantaneous: write them straight into
 * their final state.
 */
export async function upsertPerpTransfer(
  t: PerpTransferInput,
  opts: { with?: PerpWith } = {},
): Promise<PerpTransferOutcome> {
  const agent = perpAgent(t.agentId);
  const mode = perpMode(t.mode);
  const direction = oneOf(t.direction, PERP_TRANSFER_DIRECTIONS, "transfer direction");
  const state = oneOf(t.state, PERP_TRANSFER_STATES, "transfer state");
  if (!perpTransferStateFits(direction, state)) throw new RangeError(`perp ledger: a ${direction} is never '${state}'`);
  const amount = intText(t.amountMicro, "transfer amount", { min: 1n });
  const initiator = oneOf(t.initiator, PERP_TRANSFER_INITIATORS, "initiator");
  const id = t.id === undefined ? null : idText(t.id, "transfer id");
  const chainId = optSafeInt(t.chainId, "chain id", 1);
  const txHash = t.txHash === null || t.txHash === undefined ? null : hashText(t.txHash, "tx hash", { prefixed: true, hexLen: 64 });
  const logIndex = optSafeInt(t.logIndex, "log index");
  // A tx hash is unique only within a chain: an identity without its chain is
  // no identity, and NULLs are distinct in the unique index, which would then
  // admit the same log twice.
  if (txHash !== null && chainId === null) throw new RangeError("perp ledger: a transfer's tx hash needs its chain id");
  const userOpHash = t.userOpHash === null || t.userOpHash === undefined ? null : hashText(t.userOpHash, "user op hash", { prefixed: true, hexLen: 64 });
  const venueTxHash = t.venueTxHash === null || t.venueTxHash === undefined ? null : hashText(t.venueTxHash, "venue tx hash", { prefixed: false });
  const paidTxHash = t.paidTxHash === null || t.paidTxHash === undefined ? null : hashText(t.paidTxHash, "paid tx hash", { prefixed: true, hexLen: 64 });
  const paidLogIndex = optSafeInt(t.paidLogIndex, "paid log index");

  const payloadOf = (rowId: string, from: PerpTransferState | null, to: PerpTransferState, row: Partial<TransferRowDb>) => ({
    amountMicro: amount,
    chainId: row.chain_id ?? chainId,
    direction,
    from,
    initiator: row.initiator ?? initiator,
    logIndex: row.log_index ?? logIndex,
    mode,
    paidLogIndex: row.paid_log_index ?? paidLogIndex,
    paidTxHash: row.paid_tx_hash ?? paidTxHash,
    to,
    transferId: rowId,
    txHash: row.tx_hash ?? txHash,
    userOpHash: row.user_op_hash ?? userOpHash,
    venueTxHash: row.venue_tx_hash ?? venueTxHash,
  });

  try {
    return await perpJournaled<PerpTransferOutcome>(t.agentId, "margin", async (db, epoch) => {
      const cols = `id, direction, amount_micro, initiator, state, chain_id, tx_hash, log_index, user_op_hash,
                    venue_tx_hash, paid_tx_hash, paid_log_index`;
      const found = new Map<string, TransferRowDb>();
      const look = async (sql: string, ...args: unknown[]) => {
        const r = (await db.prepare(`SELECT ${cols} FROM perp_transfers WHERE agent_id = ? AND mode = ? AND ${sql}`).get(agent, mode, ...args)) as
          | TransferRowDb
          | undefined;
        if (r) found.set(r.id, r);
      };
      if (id !== null) {
        const any = (await db.prepare(`SELECT agent_id, mode FROM perp_transfers WHERE id = ?`).get(id)) as
          | { agent_id: string; mode: string }
          | undefined;
        if (any && (any.agent_id !== agent || any.mode !== mode)) {
          return { result: { outcome: "refused", id, why: "that id belongs to another agent or rail" }, payload: null };
        }
        await look("id = ?", id);
      }
      if (chainId !== null && txHash !== null && logIndex !== null) await look("chain_id = ? AND tx_hash = ? AND log_index = ?", chainId, txHash, logIndex);
      if (venueTxHash !== null) await look("venue_tx_hash = ?", venueTxHash);
      if (userOpHash !== null) await look("user_op_hash = ?", userOpHash);
      if (found.size > 1) {
        return { result: { outcome: "refused", id, why: `its identities name ${found.size} different rows` }, payload: null };
      }
      const held = [...found.values()][0];

      if (held === undefined) {
        const rowId = id ?? randomUUID();
        await db
          .prepare(
            `INSERT INTO perp_transfers (id, agent_id, mode, epoch, direction, amount_micro, initiator, state, chain_id,
                                         tx_hash, log_index, user_op_hash, venue_tx_hash, paid_tx_hash, paid_log_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(rowId, agent, mode, epoch, direction, amount, initiator, state, chainId, txHash, logIndex, userOpHash,
            venueTxHash, paidTxHash, paidLogIndex);
        const moved = perpTransferMovesMoney(null, state);
        if (opts.with) await opts.with(db);
        return {
          result: { outcome: "inserted", id: rowId, state, journaled: moved },
          payload: moved ? payloadOf(rowId, null, state, {}) : null,
        };
      }

      // The row it names must be the row described: a different direction or
      // amount is not a later state of this transfer, it is another transfer.
      if (held.direction !== direction) return { result: { outcome: "refused", id: held.id, why: `it is a ${held.direction}` }, payload: null };
      if (held.amount_micro !== amount) {
        return { result: { outcome: "refused", id: held.id, why: `its amount is ${held.amount_micro}, not ${amount}` }, payload: null };
      }
      // An identity, once written, is the row's for good: filled when empty,
      // never replaced. A different value is a different transfer.
      let learns = false;
      for (const [name, a, b] of [
        ["chain id", held.chain_id, chainId],
        ["tx hash", held.tx_hash, txHash],
        ["log index", held.log_index, logIndex],
        ["user op", held.user_op_hash, userOpHash],
        ["venue tx", held.venue_tx_hash, venueTxHash],
        ["paid tx", held.paid_tx_hash, paidTxHash],
        ["paid log index", held.paid_log_index, paidLogIndex],
      ] as const) {
        if (b === null) continue;
        if (a === null || a === undefined) {
          learns = true;
          continue;
        }
        if (String(a) !== String(b)) {
          return { result: { outcome: "refused", id: held.id, why: `its ${name} is ${String(a)}, not ${String(b)}` }, payload: null };
        }
      }
      const from = held.state as PerpTransferState;
      const forward = PERP_TRANSFER_RANK[state] > (PERP_TRANSFER_RANK[from] ?? Number.POSITIVE_INFINITY);
      // A re-read that adds nothing writes nothing — not even updated_at, which
      // the mirror's cursor reads.
      if (!forward && !learns) return { result: { outcome: "unchanged", id: held.id, state: from }, payload: null };
      const res = await db
        .prepare(
          `UPDATE perp_transfers
              SET state = ?, chain_id = COALESCE(chain_id, ?), tx_hash = COALESCE(tx_hash, ?),
                  log_index = COALESCE(log_index, ?), user_op_hash = COALESCE(user_op_hash, ?),
                  venue_tx_hash = COALESCE(venue_tx_hash, ?), paid_tx_hash = COALESCE(paid_tx_hash, ?),
                  paid_log_index = COALESCE(paid_log_index, ?), updated_at = unixepoch()
            WHERE id = ? AND state = ?`,
        )
        .run(forward ? state : from, chainId, txHash, logIndex, userOpHash, venueTxHash, paidTxHash, paidLogIndex, held.id, from);
      if (!forward || Number(res.changes) === 0) {
        return { result: { outcome: "unchanged", id: held.id, state: from }, payload: null };
      }
      const moved = perpTransferMovesMoney(from, state);
      if (opts.with) await opts.with(db);
      return {
        result: { outcome: "advanced", id: held.id, from, state, journaled: moved },
        payload: moved ? payloadOf(held.id, from, state, held) : null,
      };
    });
  } catch (e) {
    // The one write failure that is an ANSWER rather than a fault: an identity
    // this row was about to take is already another row's. Everything else is
    // a failed write, and throws.
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint|duplicate key value/i.test(msg) || (e as { code?: unknown }).code === "23505") {
      return { outcome: "refused", id, why: "an identity it names is already another transfer's" };
    }
    throw e;
  }
}

/**
 * Every transfer still moving, oldest first: not yet `credited`, `paid`,
 * `failed` or `refunded`. What holds the ratchets (rule 12c: while money is in
 * transit no peak moves) and what a restart must find.
 */
export async function listOpenPerpTransfers(agentId: string, mode: PerpMode): Promise<PerpTransferRow[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM perp_transfers WHERE agent_id = ? AND mode = ? AND state IN ('submitted', 'landed', 'executed')
        ORDER BY created_at ASC, id ASC`,
    )
    .all(perpAgent(agentId), perpMode(mode))) as Record<string, unknown>[];
  return rows.map(transferRowOf);
}

export interface PerpTransferRow {
  id: string;
  agentId: string;
  mode: PerpMode;
  epoch: number;
  direction: PerpTransferDirection;
  amountMicro: bigint;
  initiator: PerpTransferInitiator;
  state: PerpTransferState;
  chainId: number | null;
  txHash: string | null;
  logIndex: number | null;
  userOpHash: string | null;
  venueTxHash: string | null;
  paidTxHash: string | null;
  paidLogIndex: number | null;
  /** The rule-9 row of the L2 Withdraw that requested it, when there is one. */
  orderId: string | null;
  createdAt: number;
  updatedAt: number;
}

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function transferRowOf(r: Record<string, unknown>): PerpTransferRow {
  const amount = textInt(r.amount_micro);
  if (amount === null) throw new Error(`perp_transfers ${String(r.id)}: amount ${String(r.amount_micro)} is unreadable`);
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    mode: r.mode as PerpMode,
    epoch: Number(r.epoch),
    direction: r.direction as PerpTransferDirection,
    amountMicro: amount,
    initiator: r.initiator as PerpTransferInitiator,
    state: r.state as PerpTransferState,
    chainId: nullableNum(r.chain_id),
    txHash: (r.tx_hash as string | null) ?? null,
    logIndex: nullableNum(r.log_index),
    userOpHash: (r.user_op_hash as string | null) ?? null,
    venueTxHash: (r.venue_tx_hash as string | null) ?? null,
    paidTxHash: (r.paid_tx_hash as string | null) ?? null,
    paidLogIndex: nullableNum(r.paid_log_index),
    orderId: (r.order_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// ── carries across an epoch boundary ─────────────────────────────────────────

export interface PerpCarryInput {
  mode: PerpMode;
  marketId: number;
  side: PerpSide;
  /** |position|, venue base units, > 0. */
  base: bigint;
  /** The mark the position is carried at, venue price units. */
  markPrice: bigint;
  /** mark × size, micro-USDG: the position's entry quote in the new epoch. */
  entryQuoteMicro: bigint;
}

interface ValidCarry {
  mode: PerpMode;
  marketId: number;
  side: PerpSide;
  base: string;
  markPrice: string;
  entryQuoteMicro: string;
}

function validPerpCarry(c: PerpCarryInput): ValidCarry {
  return {
    mode: perpMode(c.mode),
    marketId: safeInt(c.marketId, "market id", 0, 65_535),
    side: oneOf(c.side, ["long", "short"] as const, "carry side"),
    base: intText(c.base, "carry base", { min: 1n }),
    markPrice: intText(c.markPrice, "carry mark", { min: 1n }),
    entryQuoteMicro: intText(c.entryQuoteMicro, "carry entry quote", { min: 0n }),
  };
}

/** Insert one carry into an open transaction and journal it — only if it was not already there. */
async function writePerpCarry(db: Db, journalAs: string, epoch: number, c: ValidCarry): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO perp_carries (agent_id, mode, epoch, market_id, side, base, mark_price, entry_quote_micro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(perpAgent(journalAs), c.mode, epoch, c.marketId, c.side, c.base, c.markPrice, c.entryQuoteMicro);
  if (Number(res.changes) === 0) return false;
  await appendJournalRow(db, journalAs, epoch, "perp-carry", {
    base: c.base,
    entryQuoteMicro: c.entryQuoteMicro,
    market: marketKeyOf(c.marketId),
    marketId: c.marketId,
    markPrice: c.markPrice,
    mode: c.mode,
    side: c.side,
  });
  return true;
}

/**
 * Carry one open position into the agent's CURRENT epoch at mark — for a
 * boundary that was opened without its carries. openNextEpoch's `perpCarries`
 * is the atomic path and the one to use. True when this booked it; false when
 * the epoch already held a carry for that market.
 */
export async function recordPerpCarry(agentId: string, carry: PerpCarryInput): Promise<boolean> {
  const c = validPerpCarry(carry);
  perpAgent(agentId);
  return getDb().tx(async (db) => {
    const { epoch, journalAs } = await perpBookingOf(db, agentId);
    return writePerpCarry(db, journalAs, epoch, c);
  });
}

// ── rule 9: persist before send ──────────────────────────────────────────────

/**
 * REFUSING TO SEND UNTRACKED — executor.ts NotRecorded's venue twin, named
 * apart so both can be imported beside each other.
 *
 * The `submitted` row carrying the exact signed bytes could not be written,
 * so this transaction would leave with nothing able to resolve it after a
 * crash, and nothing to stop a second nonce being signed for the same intent
 * while the first could still execute. Nothing was sent; the caller must not
 * send. `reason` is a fixed phrase, never the signed bytes.
 */
export class PerpNotRecorded extends Error {
  constructor(
    readonly reason: string,
    readonly txHash: string | null,
    options?: { cause?: unknown },
  ) {
    super(
      `refusing to send ${txHash ?? "a perp order"}: its rule-9 row could not be written (${reason}), ` +
        `so nothing could reconcile it. Nothing was sent.`,
      options,
    );
    this.name = "PerpNotRecorded";
  }
}

/** The signer's output, as much of it as the row keeps. perps/signer.ts SignedLighterTx fits it as is. */
export interface PerpSignedTx {
  txType: number;
  /** The exact string the signer returned, signature included. The only bytes ever re-sent. */
  txInfo: string;
  /** 80 lowercase hex, no 0x — known before sending. */
  txHash: string;
  accountIndex: number;
  apiKeyIndex: number;
  nonce: number;
  /** ms, parsed from txInfo by the signer — never computed here. */
  expiredAt: number;
  clientOrderIndexes: readonly { role: PerpLegRole; clientOrderIndex: number }[];
}

export interface PerpOrderSubmission {
  agentId: string;
  mode: PerpMode;
  effect: PerpOrderEffect;
  /** The flag actually signed. */
  reduceOnly: boolean;
  marketId: number | null;
  /** Entry base × worst price, micro-USDG; '0' for a tx that is not an order. */
  worstNotionalMicro: bigint;
  decisionId?: string | null;
  reason?: string | null;
  /** REQUIRED on live: the signed tx. Absent on paper, which signs nothing. */
  signed?: PerpSignedTx | null;
  /** Paper only — live legs come from `signed.clientOrderIndexes`, never a second list. */
  legs?: readonly { role: PerpLegRole; clientOrderIndex: number }[];
  /** An L2 Withdraw's money, written as its perp_transfers row in the same transaction (rule 12a). */
  withdraw?: { transferId?: string; amountMicro: bigint; initiator: PerpTransferInitiator } | null;
  /** Omit to have one made. */
  id?: string;
}

/**
 * WRITE THE RULE-9 ROW, THEN — AND ONLY THEN — MAY THE CALLER SEND. Returns the
 * row id. Throws PerpNotRecorded on ANY failure, validation included: a
 * malformed row is still no row, and a transaction with no row must not leave.
 *
 * What it proves before writing, each a way the replay guarantee could break:
 *   the nonce was RESERVED — the live high-water is at or past it, so it was
 *     committed before signing (bumpNonceHighWater) and a restart cannot hand
 *     it out again;
 *   every client order index is nonce × 8 + leg for its role (rule 9), so none
 *     repeats across restarts or a wiped ledger;
 *   the order is one rule 8 admits: an open is never reduce-only, a reduce or
 *     close always is, and nothing but an open carries notional that is not
 *     reduce-only.
 * The nonce and the client order indexes are UNIQUE in the schema as well, so
 * a second row for either is refused by the database even if every check
 * here were wrong.
 *
 * The row, its legs and (for a withdrawal) its perp_transfers row commit
 * together — a withdrawal whose request row exists without its transfer row
 * is money the in-transit sum would never see.
 */
export async function insertPerpOrderSubmitted(s: PerpOrderSubmission): Promise<string> {
  const txHashHint = typeof s.signed?.txHash === "string" ? s.signed.txHash.toLowerCase().replace(/^0x/, "") : null;
  try {
    const agent = perpAgent(s.agentId);
    const mode = perpMode(s.mode);
    if (!isPerpOrderEffect(s.effect)) throw new RangeError(`effect ${String(s.effect)}`);
    const effect = s.effect;
    if (typeof s.reduceOnly !== "boolean") throw new RangeError("reduceOnly must be a boolean");
    const notional = intText(s.worstNotionalMicro, "worst notional", { min: 0n });
    const marketId = s.marketId === null ? null : safeInt(s.marketId, "market id", 0, 65_535);
    // Rule 8's discriminated union, enforced where it is written down.
    if (effect === "open" && s.reduceOnly) throw new RangeError("an open is never reduce-only");
    if ((effect === "reduce" || effect === "close") && !s.reduceOnly) throw new RangeError(`a ${effect} is always reduce-only`);
    if (effect !== "open" && !s.reduceOnly && notional !== "0") throw new RangeError(`only an open may carry notional that is not reduce-only`);
    if ((effect === "open" || effect === "reduce" || effect === "close") && marketId === null) throw new RangeError(`a ${effect} names its market`);
    if (effect === "withdraw" && !s.withdraw) throw new RangeError("a withdrawal is written with its transfer");
    if (effect !== "withdraw" && s.withdraw) throw new RangeError("only a withdrawal carries a transfer");
    const withdrawAmount = s.withdraw ? intText(s.withdraw.amountMicro, "withdraw amount", { min: 1n }) : null;
    const withdrawInitiator = s.withdraw ? oneOf(s.withdraw.initiator, PERP_TRANSFER_INITIATORS, "initiator") : null;
    const withdrawId = s.withdraw?.transferId === undefined ? null : idText(s.withdraw.transferId, "transfer id");
    const decisionId = s.decisionId ?? null;
    const reason = s.reason ?? null;

    let signed: {
      txType: number; txInfo: string; txHash: string; accountIndex: number; apiKeyIndex: number; nonce: number; expiredAt: number;
    } | null = null;
    let legs: { role: PerpLegRole; clientOrderIndex: number }[];
    if (mode === "live") {
      const sg = s.signed;
      if (!sg) throw new RangeError("a live order is written with the signed tx it will send");
      if (s.legs !== undefined) throw new RangeError("live legs come from the signed tx alone");
      if (typeof sg.txInfo !== "string" || sg.txInfo.length === 0) throw new RangeError("tx_info is empty");
      signed = {
        txType: safeInt(sg.txType, "tx type", 0, 255),
        txInfo: sg.txInfo,
        txHash: hashText(sg.txHash, "tx hash", { prefixed: false, hexLen: 80 }),
        accountIndex: safeInt(sg.accountIndex, "account index", 0),
        apiKeyIndex: safeInt(sg.apiKeyIndex, "api key index", 0, 254),
        nonce: safeInt(sg.nonce, "nonce", 1),
        expiredAt: safeInt(sg.expiredAt, "expired at (ms)", 1),
      };
      legs = sg.clientOrderIndexes.map((l) => ({ role: l.role, clientOrderIndex: l.clientOrderIndex }));
    } else {
      if (s.signed) throw new RangeError("a paper order signs nothing");
      legs = (s.legs ?? []).map((l) => ({ role: l.role, clientOrderIndex: l.clientOrderIndex }));
    }
    const seen = new Set<number>();
    for (const l of legs) {
      if (!isPerpLegRole(l.role)) throw new RangeError(`leg role ${String(l.role)}`);
      safeInt(l.clientOrderIndex, "client order index", 1, Number(PERP_COI_MAX));
      if (seen.has(l.clientOrderIndex)) throw new RangeError(`client order index ${l.clientOrderIndex} appears twice`);
      seen.add(l.clientOrderIndex);
      // Rule 9's derivation, checked on the live rail where the venue will
      // hold us to it. perpCoi throws on a nonce whose indexes would pass 2^48.
      if (signed && BigInt(l.clientOrderIndex) !== perpCoi(BigInt(signed.nonce), PERP_LEG[l.role])) {
        throw new RangeError(`client order index ${l.clientOrderIndex} is not nonce × 8 + ${PERP_LEG[l.role]} for its ${l.role} leg`);
      }
    }
    const id = s.id === undefined ? randomUUID() : idText(s.id, "order id");

    await getDb().tx(async (db) => {
      const { epoch } = await perpBookingOf(db, s.agentId);
      if (signed) {
        const hw = (await db
          .prepare(`SELECT nonce_high_water FROM perp_accounts WHERE agent_id = ? AND mode = 'live'`)
          .get(agent)) as { nonce_high_water: string | null } | undefined;
        const high = textInt(hw?.nonce_high_water);
        if (high === null || high < BigInt(signed.nonce)) {
          throw new PerpNotRecorded("its nonce was never reserved against the high-water", signed.txHash);
        }
      }
      await db
        .prepare(
          `INSERT INTO perp_orders (id, agent_id, mode, epoch, account_index, api_key_index, nonce, tx_hash, tx_type, tx_info,
                                    expired_at, status, effect, reduce_only, market_id, worst_notional_micro, decision_id, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, agent, mode, epoch, signed?.accountIndex ?? null, signed?.apiKeyIndex ?? null, signed?.nonce ?? null,
          signed?.txHash ?? null, signed?.txType ?? null, signed?.txInfo ?? null, signed?.expiredAt ?? null,
          effect, s.reduceOnly ? 1 : 0, marketId, notional, decisionId, reason);
      for (const l of legs) {
        await db
          .prepare(
            `INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status)
             VALUES (?, ?, ?, ?, ?, 'submitted')`,
          )
          .run(agent, mode, id, l.role, l.clientOrderIndex);
      }
      if (withdrawAmount !== null && withdrawInitiator !== null) {
        // `submitted`: nothing has moved, so nothing is journaled (rule 12a).
        await db
          .prepare(
            `INSERT INTO perp_transfers (id, agent_id, mode, epoch, direction, amount_micro, initiator, state, venue_tx_hash, order_id)
             VALUES (?, ?, ?, ?, 'withdraw', ?, ?, 'submitted', ?, ?)`,
          )
          .run(withdrawId ?? randomUUID(), agent, mode, epoch, withdrawAmount, withdrawInitiator, signed?.txHash ?? null, id);
      }
    });
    return id;
  } catch (e) {
    if (e instanceof PerpNotRecorded) throw e;
    const why = e instanceof RangeError ? e.message.replace(/^perp ledger: /, "") : "the ledger refused the write";
    throw new PerpNotRecorded(why, txHashHint, { cause: e });
  }
}

export interface PerpOrderResolution {
  agentId: string;
  mode: PerpMode;
  /** The row, by id or by its tx hash — one of the two. */
  id?: string;
  txHash?: string;
  status: Exclude<PerpOrderStatus, "submitted">;
  filledBase?: bigint | null;
  filledQuoteMicro?: bigint | null;
  reason?: string | null;
}

/**
 * RESOLVE A RULE-9 ROW — forward only, and a final answer exactly once.
 *
 * The guard is in the UPDATE itself: the row must currently hold a status of
 * LOWER rank than the new one (perp-ledger-rules.ts). So `submitted` may become
 * `executed` or anything final, `executed` may become final, and a final row is
 * never rewritten — by a late duplicate resolver, by a reconcile racing a
 * restart, by anything. True when this call moved the row.
 *
 * `rejected` and `expired` never executed, so their fills are '0' unless said
 * otherwise. Every other outcome keeps its amounts NULL until told them, and a
 * NULL amount counts the worst notional against the daily cap (the budget
 * reads fail toward under-spending).
 */
export async function resolvePerpOrder(r: PerpOrderResolution): Promise<boolean> {
  const agent = perpAgent(r.agentId);
  const mode = perpMode(r.mode);
  // Checked at run time as well as by the type: a status read off the wire
  // arrives as a string, and `submitted` is not a resolution.
  const asked: unknown = r.status;
  if (!isPerpOrderStatus(asked) || asked === "submitted") throw new RangeError(`perp ledger: cannot resolve to ${String(asked)}`);
  const target = asked;
  if ((r.id === undefined) === (r.txHash === undefined)) throw new RangeError("perp ledger: resolve by id or by tx hash, exactly one");
  const unexecuted = target === "rejected" || target === "expired";
  const filledBase = r.filledBase === undefined || r.filledBase === null ? (unexecuted ? "0" : null) : intText(r.filledBase, "filled base", { min: 0n });
  const filledQuote =
    r.filledQuoteMicro === undefined || r.filledQuoteMicro === null ? (unexecuted ? "0" : null) : intText(r.filledQuoteMicro, "filled quote", { min: 0n });
  const below = (Object.keys(PERP_ORDER_RANK) as PerpOrderStatus[]).filter((s) => PERP_ORDER_RANK[s] < PERP_ORDER_RANK[target]);
  const terminal = PERP_ORDER_TERMINAL.has(target);
  const key = r.id !== undefined ? { sql: "id = ?", arg: idText(r.id, "order id") } : { sql: "tx_hash = ?", arg: hashText(r.txHash, "tx hash", { prefixed: false }) };
  const res = await getDb()
    .prepare(
      `UPDATE perp_orders
          SET status = ?, filled_base = COALESCE(?, filled_base), filled_quote_micro = COALESCE(?, filled_quote_micro),
              reason = COALESCE(?, reason), resolved_at = ${terminal ? "unixepoch()" : "resolved_at"}, updated_at = unixepoch()
        WHERE agent_id = ? AND mode = ? AND ${key.sql} AND status IN (${below.map(() => "?").join(", ")})`,
    )
    .run(target, filledBase, filledQuote, r.reason ?? null, agent, mode, key.arg, ...below);
  return Number(res.changes) > 0;
}

/**
 * Add legs to an order already written — a leg the venue revealed later, say.
 * Idempotent: a client order index this agent and rail already hold is not
 * written again. Returns how many were new. Throws if the order is not ours.
 */
export async function insertPerpOrderLegs(
  agentId: string,
  mode: PerpMode,
  orderId: string,
  legs: readonly { role: PerpLegRole; clientOrderIndex: number; status?: PerpLegStatus; venueOrderIndex?: string | null }[],
): Promise<number> {
  const agent = perpAgent(agentId);
  const m = perpMode(mode);
  const oid = idText(orderId, "order id");
  const rows = legs.map((l) => ({
    role: oneOf(l.role, PERP_LEG_ROLES, "leg role"),
    coi: safeInt(l.clientOrderIndex, "client order index", 1, Number(PERP_COI_MAX)),
    status: l.status === undefined ? "submitted" : oneOf(l.status, PERP_LEG_STATUSES, "leg status"),
    venueOrderIndex: l.venueOrderIndex === null || l.venueOrderIndex === undefined ? null : intText(l.venueOrderIndex, "venue order index", { min: 0n }),
  }));
  return getDb().tx(async (db) => {
    const owner = await db.prepare(`SELECT 1 AS ok FROM perp_orders WHERE id = ? AND agent_id = ? AND mode = ?`).get(oid, agent, m);
    if (!owner) throw new RangeError(`perp ledger: order ${oid} is not this agent's on the ${m} rail`);
    let n = 0;
    for (const l of rows) {
      const res = await db
        .prepare(
          `INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, venue_order_index, status)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(agent, m, oid, l.role, l.coi, l.venueOrderIndex, l.status);
      n += Number(res.changes);
    }
    return n;
  });
}

/**
 * Move one leg forward, by its client order index. Forward only (a resting
 * stop the venue reports `open` can never walk back to `submitted`), and a
 * final leg is never rewritten. At the same non-final status it may still
 * learn its venue order index or the venue's own status word. The venue order
 * index, once known, is never overwritten. True when anything changed.
 */
export async function updatePerpLegStatus(u: {
  agentId: string;
  mode: PerpMode;
  clientOrderIndex: number;
  status: PerpLegStatus;
  venueOrderIndex?: string | null;
  venueStatus?: string | null;
}): Promise<boolean> {
  const agent = perpAgent(u.agentId);
  const mode = perpMode(u.mode);
  const coi = safeInt(u.clientOrderIndex, "client order index", 1, Number(PERP_COI_MAX));
  if (!isPerpLegStatus(u.status)) throw new RangeError(`perp ledger: leg status ${String(u.status)}`);
  const status = u.status;
  const venueOrderIndex = u.venueOrderIndex === null || u.venueOrderIndex === undefined ? null : intText(u.venueOrderIndex, "venue order index", { min: 0n });
  const venueStatus = u.venueStatus === null || u.venueStatus === undefined ? null : idText(u.venueStatus, "venue status");
  return getDb().tx(async (db) => {
    const held = (await db
      .prepare(`SELECT status, venue_order_index, venue_status FROM perp_order_legs WHERE agent_id = ? AND mode = ? AND client_order_index = ?`)
      .get(agent, mode, coi)) as { status: string; venue_order_index: string | null; venue_status: string | null } | undefined;
    if (!held || !isPerpLegStatus(held.status)) return false;
    const from = held.status;
    const forward = PERP_LEG_RANK[status] > PERP_LEG_RANK[from];
    // At the same, non-final status a leg may still learn what it did not
    // know. A final leg learns nothing more, and a lower status is ignored.
    const sameOpen = status === from && PERP_LEG_RANK[from] < 3;
    const learnsIndex = held.venue_order_index === null && venueOrderIndex !== null;
    const learnsStatus = venueStatus !== null && venueStatus !== held.venue_status;
    if (!forward && !(sameOpen && (learnsIndex || learnsStatus))) return false;
    // Guarded on the status just read, so a concurrent writer that moved the
    // leg first wins and this one changes nothing.
    const res = await db
      .prepare(
        `UPDATE perp_order_legs
            SET status = ?, venue_order_index = COALESCE(venue_order_index, ?), venue_status = COALESCE(?, venue_status),
                updated_at = unixepoch()
          WHERE agent_id = ? AND mode = ? AND client_order_index = ? AND status = ?`,
      )
      .run(forward ? status : from, venueOrderIndex, venueStatus, agent, mode, coi, from);
    return Number(res.changes) > 0;
  });
}

// ── the nonce high-water ─────────────────────────────────────────────────────

/** The largest nonce that keeps every client order index (nonce × 8 + 3) under the venue's 2^48. */
const PERP_NONCE_MAX = (PERP_COI_MAX - 3n) / 8n;

/**
 * RESERVE THE NEXT NONCE, and commit it BEFORE anything is signed (rule 9).
 *
 * Commits and returns max(floor, high-water + 1): the caller passes
 * max(now_ms, the venue's nextNonce) as `floor`, and signs with exactly the
 * value returned — never with the floor. Strictly increasing across every
 * caller, concurrent ones included: the no-op UPDATE takes the row lock on
 * Postgres, sqlite serialises the transaction, so two reservations can never
 * read the same high-water. A nonce is handed out once for the life of the
 * ledger; a crash after this and before the send leaves a gap, which SkipNonce
 * allows, never a repeat.
 *
 * Per (agent, mode): the account and our key index are fixed per agent, and a
 * high-water that only rises is valid for any account the agent moves to.
 */
export async function bumpNonceHighWater(agentId: string, mode: PerpMode, floor: bigint | number): Promise<bigint> {
  const agent = perpAgent(agentId);
  const m = perpMode(mode);
  const f = BigInt(intText(floor, "nonce floor", { min: 1n }));
  return getDb().tx(async (db) => {
    await db.prepare(`INSERT INTO perp_accounts (agent_id, mode) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(agent, m);
    const row = (await db
      .prepare(
        `UPDATE perp_accounts SET nonce_high_water = nonce_high_water WHERE agent_id = ? AND mode = ?
         RETURNING nonce_high_water`,
      )
      .get(agent, m)) as { nonce_high_water: string | null } | undefined;
    if (!row) throw new Error("perp ledger: the account row vanished inside its own transaction");
    const high = row.nonce_high_water === null ? null : textInt(row.nonce_high_water);
    // An unreadable high-water is not a zero one: refuse rather than restart
    // the sequence under nonces that may already be spent.
    if (row.nonce_high_water !== null && high === null) throw new Error(`perp ledger: nonce high-water ${row.nonce_high_water} is unreadable`);
    const next = high === null || f > high ? f : high + 1n;
    if (next > PERP_NONCE_MAX) throw new RangeError(`perp ledger: nonce ${next} would put a client order index past 2^48`);
    await db
      .prepare(`UPDATE perp_accounts SET nonce_high_water = ?, updated_at = unixepoch() WHERE agent_id = ? AND mode = ?`)
      .run(next.toString(), agent, m);
    return next;
  });
}

/** The committed high-water, or null when none was ever reserved. Throws on a read failure or an unreadable value. */
export async function getNonceHighWater(agentId: string, mode: PerpMode): Promise<bigint | null> {
  const row = (await getDb()
    .prepare(`SELECT nonce_high_water FROM perp_accounts WHERE agent_id = ? AND mode = ?`)
    .get(perpAgent(agentId), perpMode(mode))) as { nonce_high_water: string | null } | undefined;
  if (!row || row.nonce_high_water === null) return null;
  const v = textInt(row.nonce_high_water);
  if (v === null) throw new Error(`perp ledger: nonce high-water ${row.nonce_high_water} is unreadable`);
  return v;
}

// ── reading orders back ──────────────────────────────────────────────────────

export interface PerpLegRow {
  orderId: string;
  role: PerpLegRole;
  clientOrderIndex: number;
  venueOrderIndex: string | null;
  status: PerpLegStatus;
  venueStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PerpOrderRow {
  id: string;
  agentId: string;
  mode: PerpMode;
  epoch: number;
  accountIndex: number | null;
  apiKeyIndex: number | null;
  nonce: number | null;
  txHash: string | null;
  txType: number | null;
  /** The signed bytes — for re-sending only, and never before logging's redactor. */
  txInfo: string | null;
  /** ms */
  expiredAt: number | null;
  status: PerpOrderStatus;
  effect: PerpOrderEffect;
  reduceOnly: boolean;
  marketId: number | null;
  worstNotionalMicro: bigint;
  filledBase: bigint | null;
  filledQuoteMicro: bigint | null;
  decisionId: string | null;
  reason: string | null;
  createdAt: number;
  resolvedAt: number | null;
  updatedAt: number;
  legs: PerpLegRow[];
}

function legRowOf(r: Record<string, unknown>): PerpLegRow {
  return {
    orderId: String(r.order_id),
    role: r.role as PerpLegRole,
    clientOrderIndex: Number(r.client_order_index),
    venueOrderIndex: (r.venue_order_index as string | null) ?? null,
    status: r.status as PerpLegStatus,
    venueStatus: (r.venue_status as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

async function ordersWithLegs(db: Db, rows: Record<string, unknown>[]): Promise<PerpOrderRow[]> {
  const out: PerpOrderRow[] = [];
  for (const r of rows) {
    const worst = textInt(r.worst_notional_micro);
    if (worst === null) throw new Error(`perp_orders ${String(r.id)}: worst notional ${String(r.worst_notional_micro)} is unreadable`);
    const legs = (await db
      .prepare(`SELECT * FROM perp_order_legs WHERE order_id = ? ORDER BY client_order_index ASC`)
      .all(r.id)) as Record<string, unknown>[];
    out.push({
      id: String(r.id),
      agentId: String(r.agent_id),
      mode: r.mode as PerpMode,
      epoch: Number(r.epoch),
      accountIndex: nullableNum(r.account_index),
      apiKeyIndex: nullableNum(r.api_key_index),
      nonce: nullableNum(r.nonce),
      txHash: (r.tx_hash as string | null) ?? null,
      txType: nullableNum(r.tx_type),
      txInfo: (r.tx_info as string | null) ?? null,
      expiredAt: nullableNum(r.expired_at),
      status: r.status as PerpOrderStatus,
      effect: r.effect as PerpOrderEffect,
      reduceOnly: Number(r.reduce_only) === 1,
      marketId: nullableNum(r.market_id),
      worstNotionalMicro: worst,
      filledBase: r.filled_base === null || r.filled_base === undefined ? null : textInt(r.filled_base),
      filledQuoteMicro: r.filled_quote_micro === null || r.filled_quote_micro === undefined ? null : textInt(r.filled_quote_micro),
      decisionId: (r.decision_id as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      createdAt: Number(r.created_at),
      resolvedAt: nullableNum(r.resolved_at),
      updatedAt: Number(r.updated_at),
      legs: legs.map(legRowOf),
    });
  }
  return out;
}

/**
 * EVERY ROW STILL WAITING ON THE VENUE — `submitted` (sent or not, outcome
 * unknown) and `executed` (ran; its fills not yet booked) — oldest nonce
 * first, with the signed bytes for a re-send before ExpiredAt. What reconcile
 * resolves at arm and every tick, and what keeps a second nonce from being
 * signed for an intent while its row is ambiguous.
 */
export async function listSubmittedPerpOrders(agentId: string, mode: PerpMode): Promise<PerpOrderRow[]> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT * FROM perp_orders WHERE agent_id = ? AND mode = ? AND status IN ('submitted', 'executed')
        ORDER BY created_at ASC, nonce ASC, id ASC`,
    )
    .all(perpAgent(agentId), perpMode(mode))) as Record<string, unknown>[];
  return ordersWithLegs(db, rows);
}

/** One rule-9 row by its venue tx hash (80 hex), or null. */
export async function perpOrderByTxHash(agentId: string, mode: PerpMode, txHash: string): Promise<PerpOrderRow | null> {
  const db = getDb();
  const rows = (await db
    .prepare(`SELECT * FROM perp_orders WHERE agent_id = ? AND mode = ? AND tx_hash = ?`)
    .all(perpAgent(agentId), perpMode(mode), hashText(txHash, "tx hash", { prefixed: false }))) as Record<string, unknown>[];
  return (await ordersWithLegs(db, rows))[0] ?? null;
}

/** One rule-9 row by its id, or null. */
export async function getPerpOrder(agentId: string, mode: PerpMode, id: string): Promise<PerpOrderRow | null> {
  const db = getDb();
  const rows = (await db
    .prepare(`SELECT * FROM perp_orders WHERE agent_id = ? AND mode = ? AND id = ?`)
    .all(perpAgent(agentId), perpMode(mode), idText(id, "order id"))) as Record<string, unknown>[];
  return (await ordersWithLegs(db, rows))[0] ?? null;
}

/** The order and the leg a client order index belongs to — how a venue order or fill is matched to ours. */
export async function perpOrderByCoi(
  agentId: string,
  mode: PerpMode,
  clientOrderIndex: number | bigint,
): Promise<{ order: PerpOrderRow; leg: PerpLegRow } | null> {
  const coi = typeof clientOrderIndex === "bigint" ? Number(intText(clientOrderIndex, "client order index", { min: 0n })) : clientOrderIndex;
  safeInt(coi, "client order index", 0, Number(PERP_COI_MAX));
  const db = getDb();
  const leg = (await db
    .prepare(`SELECT * FROM perp_order_legs WHERE agent_id = ? AND mode = ? AND client_order_index = ?`)
    .get(perpAgent(agentId), perpMode(mode), coi)) as Record<string, unknown> | undefined;
  if (!leg) return null;
  const rows = (await db.prepare(`SELECT * FROM perp_orders WHERE id = ?`).all(leg.order_id)) as Record<string, unknown>[];
  const order = (await ordersWithLegs(db, rows))[0];
  return order ? { order, leg: legRowOf(leg) } : null;
}

// ── budgets (docs/perps.md, "Budgets") ───────────────────────────────────────

/**
 * THE OPENING NOTIONAL THIS RAIL HAS COMMITTED SINCE `sinceSec`, integer
 * micro-USDG — rule 6's "counts against the signed dailyUsdg".
 *
 * Every perp_orders row with reduce_only = 0: the signed flag, never the
 * model's `effect` label — any order that is not reduce-only can open or flip
 * a position, whatever it was called. Reduce-only rows count nothing: an exit
 * is never spend (rule 8).
 *
 * A row whose outcome is not yet known — `submitted`, `executed`, or any row
 * whose filled amount is still NULL — counts its WORST notional; a resolved
 * row counts what it actually filled, whatever its final status, so an IOC
 * that part-filled and was then cancelled counts its fill and one that filled
 * nothing counts nothing. Summed in BigInt: the column is TEXT precisely so
 * no sum passes through a float.
 *
 * ALREADY INSIDE getSpentTodayUsdg. Do not add it to that function's result.
 */
export async function perpOpenNotionalSince(agentId: string, mode: PerpMode, sinceSec: number): Promise<bigint> {
  const rows = (await getDb()
    .prepare(
      `SELECT id, status, worst_notional_micro, filled_quote_micro FROM perp_orders
        WHERE agent_id = ? AND mode = ? AND reduce_only = 0 AND created_at > ?`,
    )
    .all(perpAgent(agentId), perpMode(mode), Math.floor(sinceSec))) as {
    id: string;
    status: string;
    worst_notional_micro: string;
    filled_quote_micro: string | null;
  }[];
  let sum = 0n;
  for (const r of rows) {
    const unresolved = (PERP_UNRESOLVED_ORDER_STATUSES as readonly string[]).includes(r.status) || r.filled_quote_micro === null;
    const v = textInt(unresolved ? r.worst_notional_micro : r.filled_quote_micro);
    // An unreadable amount is not a zero one: the budget must not be seeded
    // from a sum that silently skipped a row.
    if (v === null) throw new Error(`perp_orders ${r.id}: an amount is unreadable`);
    sum += v;
  }
  return sum;
}

/**
 * THE PERP OPS THIS RAIL HAS SPENT SINCE `sinceSec` — every signed venue tx in
 * an ALLOW-LISTED status (perp-ledger-rules.ts PERP_OPS_ORDER_STATUSES; a new
 * status counts toward no cap until someone says it should), reduce-only
 * exits included: an exit is COUNTED as an op, as a spot sell is, and never
 * BLOCKED by the count (rule 8).
 *
 * Withdrawal requests: an L2 Withdraw is itself a perp_orders row (rule 9) and
 * counts there. A perp_transfers withdrawal counts only when it has NO order
 * row behind it — never both, which would charge one request twice.
 *
 * ALREADY INSIDE getOpsToday. Do not add it to that function's result.
 */
export async function perpOpsSince(agentId: string, mode: PerpMode, sinceSec: number): Promise<number> {
  const agent = perpAgent(agentId);
  const m = perpMode(mode);
  const since = Math.floor(sinceSec);
  const orderMarks = PERP_OPS_ORDER_STATUSES.map(() => "?").join(", ");
  const withdrawMarks = PERP_OPS_WITHDRAW_STATES.map(() => "?").join(", ");
  const orders = (await getDb()
    .prepare(`SELECT COUNT(*) AS n FROM perp_orders WHERE agent_id = ? AND mode = ? AND created_at > ? AND status IN (${orderMarks})`)
    .get(agent, m, since, ...PERP_OPS_ORDER_STATUSES)) as { n: number } | undefined;
  const withdrawals = (await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM perp_transfers t
        WHERE t.agent_id = ? AND t.mode = ? AND t.direction = 'withdraw' AND t.created_at > ? AND t.state IN (${withdrawMarks})
          AND NOT EXISTS (SELECT 1 FROM perp_orders o
                           WHERE o.agent_id = t.agent_id AND o.mode = t.mode
                             AND ((t.order_id IS NOT NULL AND o.id = t.order_id)
                                  OR (t.venue_tx_hash IS NOT NULL AND o.tx_hash = t.venue_tx_hash)))`,
    )
    .get(agent, m, since, ...PERP_OPS_WITHDRAW_STATES)) as { n: number } | undefined;
  return Number(orders?.n ?? 0) + Number(withdrawals?.n ?? 0);
}

// ── positions ────────────────────────────────────────────────────────────────

export interface PerpPositionInput {
  agentId: string;
  mode: PerpMode;
  marketId: number;
  /** null exactly when flat. */
  side: PerpSide | null;
  /** |position|, venue base units; 0 when flat. */
  base: bigint;
  /** Venue price units. */
  entryPrice?: bigint | null;
  allocatedMarginMicro: bigint;
  imfBp?: number | null;
  marginMode?: "isolated" | "cross" | null;
  realizedMicro?: bigint | null;
  fundingMicro?: bigint | null;
  stopTrigger?: bigint | null;
  stopPrice?: bigint | null;
  takeTrigger?: bigint | null;
  takePrice?: bigint | null;
  /** Paper: the last funding hour charged, unix seconds. */
  fundingHourApplied?: number | null;
  /** Unix seconds. */
  openedAt?: number | null;
  /** 'venue' on live (a cache of the venue), 'paper' on paper (the book). Never crossed. */
  source: "venue" | "paper";
}

export interface PerpPositionRow {
  agentId: string;
  mode: PerpMode;
  marketId: number;
  side: PerpSide | null;
  base: bigint;
  entryPrice: bigint | null;
  allocatedMarginMicro: bigint;
  imfBp: number | null;
  marginMode: "isolated" | "cross" | null;
  realizedMicro: bigint | null;
  fundingMicro: bigint | null;
  stopTrigger: bigint | null;
  stopPrice: bigint | null;
  takeTrigger: bigint | null;
  takePrice: bigint | null;
  fundingHourApplied: number | null;
  openedAt: number | null;
  updatedAt: number;
  source: "venue" | "paper";
}

/**
 * Write one position row inside a caller's transaction — the `with` hook of a
 * paper fill, so the book and the fact that moved it commit together.
 * Validated here as well: a flat row has no side and a held one has one, and
 * a paper position is never written as the venue's or the reverse (rule 14's
 * "never a paper perps book beside its live book").
 */
export async function putPerpPosition(db: Db, p: PerpPositionInput): Promise<void> {
  const agent = perpAgent(p.agentId);
  const mode = perpMode(p.mode);
  const source = oneOf(p.source, ["venue", "paper"] as const, "position source");
  if ((mode === "paper") !== (source === "paper")) throw new RangeError(`perp ledger: a ${mode} position is never sourced '${source}'`);
  const marketId = safeInt(p.marketId, "market id", 0, 65_535);
  const base = intText(p.base, "position base", { min: 0n });
  const side = p.side === null ? null : oneOf(p.side, ["long", "short"] as const, "position side");
  if ((side === null) !== (base === "0")) throw new RangeError("perp ledger: a position has a side exactly when it has a size");
  const margin = intText(p.allocatedMarginMicro, "allocated margin", { min: 0n });
  const imf = optSafeInt(p.imfBp, "imf (bp)", 1, 10_000);
  const marginMode = p.marginMode === null || p.marginMode === undefined ? null : oneOf(p.marginMode, ["isolated", "cross"] as const, "margin mode");
  await db
    .prepare(
      `INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp, margin_mode,
                                   realized_micro, funding_micro, stop_trigger, stop_price, take_trigger, take_price,
                                   funding_hour_applied, opened_at, updated_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)
       ON CONFLICT(agent_id, mode, market_id) DO UPDATE SET
         side = excluded.side, base = excluded.base, entry_price = excluded.entry_price,
         allocated_margin_micro = excluded.allocated_margin_micro, imf_bp = excluded.imf_bp,
         margin_mode = excluded.margin_mode, realized_micro = excluded.realized_micro,
         funding_micro = excluded.funding_micro, stop_trigger = excluded.stop_trigger,
         stop_price = excluded.stop_price, take_trigger = excluded.take_trigger, take_price = excluded.take_price,
         funding_hour_applied = excluded.funding_hour_applied, opened_at = excluded.opened_at,
         updated_at = excluded.updated_at, source = excluded.source`,
    )
    .run(agent, mode, marketId, side, base, optInt(p.entryPrice, "entry price", { min: 0n }), margin, imf, marginMode,
      optInt(p.realizedMicro, "position realized"), optInt(p.fundingMicro, "position funding"),
      optInt(p.stopTrigger, "stop trigger", { min: 0n }), optInt(p.stopPrice, "stop price", { min: 0n }),
      optInt(p.takeTrigger, "take trigger", { min: 0n }), optInt(p.takePrice, "take price", { min: 0n }),
      optSafeInt(p.fundingHourApplied, "funding hour applied"), optSafeInt(p.openedAt, "opened at"), source);
}

/** Write one position row. Throws on a failed or malformed write. */
export async function upsertPerpPosition(p: PerpPositionInput): Promise<void> {
  await putPerpPosition(getDb(), p);
}

/**
 * REPLACE THE WHOLE LIVE CACHE (or paper book) FROM ONE READ, atomically: every
 * row given is written, and every market this rail held that the read does not
 * show goes FLAT — its row stays, keeping the market's leverage state, with no
 * side and no size. One transaction, so a reader never sees half of one venue
 * snapshot beside half of the last.
 */
export async function setPerpPositions(
  agentId: string,
  mode: PerpMode,
  source: "venue" | "paper",
  rows: readonly Omit<PerpPositionInput, "agentId" | "mode" | "source">[],
): Promise<void> {
  const agent = perpAgent(agentId);
  const m = perpMode(mode);
  const markets = new Set<number>();
  for (const r of rows) {
    if (markets.has(r.marketId)) throw new RangeError(`perp ledger: market ${r.marketId} appears twice in one snapshot`);
    markets.add(r.marketId);
  }
  await getDb().tx(async (db) => {
    for (const r of rows) await putPerpPosition(db, { ...r, agentId, mode: m, source });
    const held = [...markets];
    await db
      .prepare(
        `UPDATE perp_positions SET side = NULL, base = '0', allocated_margin_micro = '0', entry_price = NULL,
                stop_trigger = NULL, stop_price = NULL, take_trigger = NULL, take_price = NULL,
                opened_at = NULL, updated_at = unixepoch()
          WHERE agent_id = ? AND mode = ? AND base <> '0'${held.length ? ` AND market_id NOT IN (${held.map(() => "?").join(", ")})` : ""}`,
      )
      .run(agent, m, ...held);
  });
}

function positionRowOf(r: Record<string, unknown>): PerpPositionRow {
  const base = textInt(r.base);
  const margin = textInt(r.allocated_margin_micro);
  if (base === null || margin === null) throw new Error(`perp_positions ${String(r.market_id)}: an amount is unreadable`);
  const opt = (v: unknown) => (v === null || v === undefined ? null : textInt(v));
  return {
    agentId: String(r.agent_id),
    mode: r.mode as PerpMode,
    marketId: Number(r.market_id),
    side: (r.side as PerpSide | null) ?? null,
    base,
    entryPrice: opt(r.entry_price),
    allocatedMarginMicro: margin,
    imfBp: nullableNum(r.imf_bp),
    marginMode: (r.margin_mode as "isolated" | "cross" | null) ?? null,
    realizedMicro: opt(r.realized_micro),
    fundingMicro: opt(r.funding_micro),
    stopTrigger: opt(r.stop_trigger),
    stopPrice: opt(r.stop_price),
    takeTrigger: opt(r.take_trigger),
    takePrice: opt(r.take_price),
    fundingHourApplied: nullableNum(r.funding_hour_applied),
    openedAt: nullableNum(r.opened_at),
    updatedAt: Number(r.updated_at),
    source: r.source as "venue" | "paper",
  };
}

/** This rail's positions, open ones only unless asked. Throws on a read failure — never an empty book. */
export async function getPerpPositions(
  agentId: string,
  mode: PerpMode,
  opts: { includeFlat?: boolean } = {},
): Promise<PerpPositionRow[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM perp_positions WHERE agent_id = ? AND mode = ?${opts.includeFlat ? "" : " AND base <> '0'"}
        ORDER BY market_id ASC`,
    )
    .all(perpAgent(agentId), perpMode(mode))) as Record<string, unknown>[];
  return rows.map(positionRowOf);
}

// ── the account row ──────────────────────────────────────────────────────────

/** Rule 16's durable flag. `kind` is a short slug; `detail` stays in the child (the mirror carries kind and time only). */
export interface PerpIncident {
  kind: string;
  /** Unix seconds. */
  at: number;
  detail?: unknown;
}

export interface PerpAccountRow {
  agentId: string;
  mode: PerpMode;
  accountIndex: number | null;
  /** 0x + 80 hex, lowercase. */
  registeredPubkey: string | null;
  retiredPubkeys: string[];
  nonceHighWater: bigint | null;
  paperCollateralMicro: bigint | null;
  incident: PerpIncident | null;
  entriesHalted: boolean;
  lastVenueReadAt: number | null;
  /** The venue snapshot's transaction_time, µs. */
  lastSnapshotTime: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A change to the account row. Absent keys are left alone; `null` clears.
 * The nonce high-water is not here — it moves only through bumpNonceHighWater.
 */
export interface PerpAccountPatch {
  accountIndex?: number | null;
  registeredPubkey?: string | null;
  /** Added to the retired set, which only grows: a retired key is never registered again. */
  retirePubkeys?: readonly string[];
  /** Paper rail only. */
  paperCollateralMicro?: bigint | null;
  incident?: PerpIncident | null;
  entriesHalted?: boolean;
  lastVenueReadAt?: number | null;
  /**
   * µs. Only ever RAISED: an older snapshot never replaces a newer one's time,
   * because rule 12 refuses a snapshot older than the last one used, and a
   * time that could be written down would let a stale read pass that check.
   */
  lastSnapshotTime?: number;
}

function pubkeyText(v: unknown): string {
  return hashText(v, "public key", { prefixed: true, hexLen: 80 });
}

/** The paper book's cross collateral, inside a caller's transaction (a paper fill's or transfer's `with`). */
export async function putPaperCollateral(db: Db, agentId: string, collateralMicro: bigint): Promise<void> {
  const agent = perpAgent(agentId);
  const c = intText(collateralMicro, "paper collateral", { min: 0n });
  await db.prepare(`INSERT INTO perp_accounts (agent_id, mode) VALUES (?, 'paper') ON CONFLICT DO NOTHING`).run(agent);
  await db
    .prepare(`UPDATE perp_accounts SET paper_collateral_micro = ?, updated_at = unixepoch() WHERE agent_id = ? AND mode = 'paper'`)
    .run(c, agent);
}

/** Apply a patch to this rail's account row, creating it if needed. One transaction; throws on refusal or failure. */
export async function patchPerpAccount(agentId: string, mode: PerpMode, patch: PerpAccountPatch): Promise<void> {
  const agent = perpAgent(agentId);
  const m = perpMode(mode);
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (patch.accountIndex !== undefined) set("account_index", optSafeInt(patch.accountIndex, "account index"));
  const registering = patch.registeredPubkey === undefined || patch.registeredPubkey === null ? null : pubkeyText(patch.registeredPubkey);
  if (patch.registeredPubkey !== undefined) set("registered_pubkey", registering);
  const retiring = (patch.retirePubkeys ?? []).map(pubkeyText);
  if (patch.paperCollateralMicro !== undefined) {
    if (m !== "paper") throw new RangeError("perp ledger: only the paper book holds its own collateral");
    set("paper_collateral_micro", optInt(patch.paperCollateralMicro, "paper collateral", { min: 0n }));
  }
  if (patch.incident !== undefined) {
    if (patch.incident === null) set("incident_json", null);
    else {
      const kind = idText(patch.incident.kind, "incident kind");
      const at = safeInt(patch.incident.at, "incident time");
      set("incident_json", JSON.stringify({ kind, at, detail: patch.incident.detail ?? null }));
    }
  }
  if (patch.entriesHalted !== undefined) set("entries_halted", patch.entriesHalted ? 1 : 0);
  if (patch.lastVenueReadAt !== undefined) set("last_venue_read_at", optSafeInt(patch.lastVenueReadAt, "last venue read"));
  const snapshot = patch.lastSnapshotTime === undefined ? null : safeInt(patch.lastSnapshotTime, "snapshot time");
  await getDb().tx(async (db) => {
    await db.prepare(`INSERT INTO perp_accounts (agent_id, mode) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(agent, m);
    const row = (await db
      .prepare(`SELECT retired_pubkeys FROM perp_accounts WHERE agent_id = ? AND mode = ?`)
      .get(agent, m)) as { retired_pubkeys: string } | undefined;
    let retired: string[];
    try {
      const parsed = JSON.parse(row?.retired_pubkeys ?? "[]") as unknown;
      if (!Array.isArray(parsed) || !parsed.every((k) => typeof k === "string")) throw new Error("not a list of keys");
      retired = parsed as string[];
    } catch {
      // A retired set we cannot read is not an empty one: registering against
      // it could re-admit a key the owner rotated away.
      throw new Error("perp ledger: the retired key set is unreadable");
    }
    const union = [...new Set([...retired, ...retiring])].sort();
    if (registering !== null && union.includes(registering)) {
      throw new RangeError("perp ledger: that public key was retired and is never registered again");
    }
    const allSets = [...sets];
    const allArgs = [...args];
    if (retiring.length) {
      allSets.push("retired_pubkeys = ?");
      allArgs.push(JSON.stringify(union));
    }
    if (snapshot !== null) {
      allSets.push("last_snapshot_time = CASE WHEN last_snapshot_time IS NULL OR last_snapshot_time < ? THEN ? ELSE last_snapshot_time END");
      allArgs.push(snapshot, snapshot);
    }
    if (!allSets.length) return;
    await db
      .prepare(`UPDATE perp_accounts SET ${allSets.join(", ")}, updated_at = unixepoch() WHERE agent_id = ? AND mode = ?`)
      .run(...allArgs, agent, m);
  });
}

/** This rail's account row, or null when there is none. Throws on a read failure or an unreadable row. */
export async function getPerpAccount(agentId: string, mode: PerpMode): Promise<PerpAccountRow | null> {
  const r = (await getDb()
    .prepare(`SELECT * FROM perp_accounts WHERE agent_id = ? AND mode = ?`)
    .get(perpAgent(agentId), perpMode(mode))) as Record<string, unknown> | undefined;
  if (!r) return null;
  const retired = JSON.parse(String(r.retired_pubkeys ?? "[]")) as unknown;
  if (!Array.isArray(retired)) throw new Error("perp ledger: the retired key set is unreadable");
  const high = r.nonce_high_water === null || r.nonce_high_water === undefined ? null : textInt(r.nonce_high_water);
  const collateral = r.paper_collateral_micro === null || r.paper_collateral_micro === undefined ? null : textInt(r.paper_collateral_micro);
  if ((r.nonce_high_water != null && high === null) || (r.paper_collateral_micro != null && collateral === null)) {
    throw new Error("perp ledger: an amount on the account row is unreadable");
  }
  let incident: PerpIncident | null = null;
  if (typeof r.incident_json === "string") {
    // An incident whose detail cannot be parsed is STILL an incident: the
    // flag is what refuses opens (rule 16), and a parse error must not clear it.
    try {
      const j = JSON.parse(r.incident_json) as { kind?: unknown; at?: unknown; detail?: unknown };
      incident = { kind: typeof j.kind === "string" ? j.kind : "unreadable", at: Number(j.at ?? 0), detail: j.detail ?? null };
    } catch {
      incident = { kind: "unreadable", at: 0, detail: null };
    }
  }
  return {
    agentId: String(r.agent_id),
    mode: r.mode as PerpMode,
    accountIndex: nullableNum(r.account_index),
    registeredPubkey: (r.registered_pubkey as string | null) ?? null,
    retiredPubkeys: retired.map(String),
    nonceHighWater: high,
    paperCollateralMicro: collateral,
    incident,
    entriesHalted: Number(r.entries_halted) === 1,
    lastVenueReadAt: nullableNum(r.last_venue_read_at),
    lastSnapshotTime: nullableNum(r.last_snapshot_time),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// ── the paper venue's bookings (perps/paper.ts, perps/executor.ts) ───────────

/**
 * ONE PAPER PERP ACTION — an open, a reduce or close, a funding hour, a stop,
 * take-profit or liquidation the paper venue ran, or a leverage change —
 * booked WHOLE: its rule-9 order row and legs, every fill and funding payment
 * with its hash-chained journal entry, the resting children it ends, every
 * position row it moves and the paper_book cash it draws or returns, in ONE
 * transaction (docs/perps.md rule 14; accounting.md paper-perp-checkpoint-and-
 * restore: "the paper perp margin move from paper cash … is one db.tx with its
 * journal entry").
 *
 * WHY ITS OWN WRITER AND NOT insertPerpFill's `with` HOOK. A paper action is
 * more than one fact: an open is an order row, up to three legs, a fill and a
 * position; a zero-fill IOC is an order row and no fact at all. Transactions do
 * not nest (db.ts), and a crash between a fill and the cash it moved is a paper
 * book whose margin is in two places or none — the checkpoint would carry that
 * into shared storage. So the whole action is one function, validated before
 * the first write like every other perp writer, and journaled in the SAME
 * payload shapes insertPerpFill and insertPerpFunding use, so audit.ts reads a
 * paper fill exactly as it reads one from the venue.
 *
 * THREE GUARDS, each refusing the whole transaction:
 *   identity    every fill and funding carries the paper venue's own id. All
 *               already booked is the ordinary re-run — `duplicate`, nothing
 *               moves; some booked and some not is a mismatch and throws.
 *   the book    `expect` names every market the action moves and what its row
 *               held when the engine computed it. A row that has moved since
 *               (a concurrent tick, a reset) refuses the booking: a paper
 *               engine applying a delta to a book it did not read is exactly a
 *               double close. A position may only be written for a market it
 *               names.
 *   the epoch   the action was computed in `epoch`; if a paper reset opened
 *               the next one in between, it books nothing.
 *
 * THE CASH. paper_book.cash_usdg is REAL USDG (the spot paper book's own
 * column); the delta is exact micro-USDG converted once, here. A debit the
 * cash cannot cover refuses — margin is never drawn into a negative book. The
 * row is matched case-insensitively (the perp tables are lowercased, paper_book
 * keeps the spelling index.ts seeded it with) and must be exactly one.
 */
export interface PaperPerpExpect {
  marketId: number;
  /** What the row held; null = flat (no row, or a row with no size). */
  held: {
    side: PerpSide;
    base: bigint;
    entryPrice: bigint;
    allocatedMarginMicro: bigint;
    stopTrigger: bigint | null;
    takeTrigger: bigint | null;
    fundingHourApplied: number | null;
  } | null;
  /** When set, the row must hold this market ISOLATED at exactly this IMF (an open rides the leverage it was judged at). */
  isolatedImfBp?: number;
}

export interface PaperPerpFillBooking {
  venueTradeId: string;
  marketId: number;
  side: PerpSide;
  sideRole: "ask" | "bid";
  base: bigint;
  price: bigint;
  quoteMicro: bigint;
  feeMicro: bigint;
  /** The paper engine always derives it — never null here. */
  realizedMicro: bigint;
  positionBefore: bigint;
  entryQuoteBeforeMicro: bigint;
  tradeType: PerpTradeType;
  attribution: PerpAttribution;
  /** This action's own leg, or the market's resting child it executes; null for a venue-forced fill. */
  leg: { own: PerpLegRole } | { resting: "sl" | "tp" } | null;
  venueTsMs: number;
}

export interface PaperPerpBooking {
  agentId: string;
  epoch: number;
  expect: readonly PaperPerpExpect[];
  order?: {
    id?: string;
    nonce: bigint;
    effect: "open" | "reduce" | "close";
    reduceOnly: boolean;
    marketId: number;
    status: "filled" | "partial" | "cancelled";
    worstNotionalMicro: bigint;
    filledBase: bigint;
    filledQuoteMicro: bigint;
    decisionId?: string | null;
    reason?: string | null;
    legs: readonly { role: PerpLegRole; clientOrderIndex: number; status: PerpLegStatus }[];
  } | null;
  fills?: readonly PaperPerpFillBooking[];
  funding?: {
    fundingId: string;
    marketId: number;
    fundingHour: number;
    paymentMicro: bigint;
    ratePpm: number | null;
    positionBase: bigint;
    positionSide: PerpSide;
  } | null;
  /** Resting children (sl/tp) of a market that end with this action. */
  restingEnd?: readonly { marketId: number; role: "sl" | "tp"; status: PerpLegStatus; venueStatus: string }[];
  positions: readonly Omit<PerpPositionInput, "agentId" | "mode" | "source">[];
  cashDeltaMicro: bigint;
}

export async function bookPaperPerp(b: PaperPerpBooking): Promise<"booked" | "duplicate"> {
  const agent = perpAgent(b.agentId);
  const epochWanted = safeInt(b.epoch, "epoch", 1);
  const cashDelta = BigInt(intText(b.cashDeltaMicro, "paper cash delta"));
  const expected = new Map<number, PaperPerpExpect>();
  for (const e of b.expect) {
    const id = safeInt(e.marketId, "market id", 0, 65_535);
    if (expected.has(id)) throw new RangeError(`perp ledger: market ${id} is expected twice`);
    if (e.held) {
      oneOf(e.held.side, ["long", "short"] as const, "expected side");
      intText(e.held.base, "expected base", { min: 1n });
    }
    if (e.isolatedImfBp !== undefined) safeInt(e.isolatedImfBp, "expected imf (bp)", 1, 10_000);
    expected.set(id, e);
  }
  for (const p of b.positions) {
    if (!expected.has(p.marketId)) throw new RangeError(`perp ledger: a paper position for market ${p.marketId} was written without reading it`);
  }
  const o = b.order ?? null;
  const order = o === null ? null : {
    id: o.id === undefined ? randomUUID() : idText(o.id, "order id"),
    nonce: safeInt(Number(intText(o.nonce, "nonce", { min: 1n })), "nonce", 1),
    effect: oneOf(o.effect, ["open", "reduce", "close"] as const, "effect"),
    marketId: safeInt(o.marketId, "market id", 0, 65_535),
    status: oneOf(o.status, ["filled", "partial", "cancelled"] as const, "paper order status"),
    worst: intText(o.worstNotionalMicro, "worst notional", { min: 0n }),
    filledBase: intText(o.filledBase, "filled base", { min: 0n }),
    filledQuote: intText(o.filledQuoteMicro, "filled quote", { min: 0n }),
    decisionId: o.decisionId ?? null,
    reason: o.reason ?? null,
    legs: o.legs.map((l) => ({
      role: oneOf(l.role, PERP_LEG_ROLES, "leg role"),
      coi: safeInt(l.clientOrderIndex, "client order index", 1, Number(PERP_COI_MAX)),
      status: oneOf(l.status, PERP_LEG_STATUSES, "leg status"),
    })),
    reduceOnly: o.reduceOnly,
  };
  if (order) {
    if (typeof order.reduceOnly !== "boolean") throw new RangeError("perp ledger: reduceOnly must be a boolean");
    if ((order.effect === "open") === order.reduceOnly) throw new RangeError(`perp ledger: a paper ${order.effect} is reduce-only exactly when it is an exit`);
    if (!expected.has(order.marketId)) throw new RangeError("perp ledger: a paper order names a market it did not read");
    for (const l of order.legs) {
      // Rule 9's derivation holds on paper too: nonce × 8 + leg, so a paper
      // client order index never repeats across restarts or a reset either.
      if (BigInt(l.coi) !== perpCoi(BigInt(order.nonce), PERP_LEG[l.role])) {
        throw new RangeError(`perp ledger: client order index ${l.coi} is not nonce × 8 + ${PERP_LEG[l.role]} for its ${l.role} leg`);
      }
    }
  }
  const fills = (b.fills ?? []).map((f) => {
    const leg = f.leg;
    if (leg !== null && "own" in leg && (!order || !order.legs.some((l) => l.role === leg.own))) {
      throw new RangeError(`perp ledger: a fill names this action's ${leg.own} leg, which it does not carry`);
    }
    return {
      venueTradeId: idText(f.venueTradeId, "venue trade id"),
      marketId: safeInt(f.marketId, "market id", 0, 65_535),
      side: oneOf(f.side, ["long", "short"] as const, "side"),
      sideRole: oneOf(f.sideRole, ["ask", "bid"] as const, "side role"),
      base: intText(f.base, "fill base", { min: 1n }),
      price: intText(f.price, "fill price", { min: 1n }),
      quote: intText(f.quoteMicro, "fill quote", { min: 0n }),
      fee: intText(f.feeMicro, "fill fee"),
      realized: intText(f.realizedMicro, "realized"),
      positionBefore: intText(f.positionBefore, "position before"),
      entryQuoteBefore: intText(f.entryQuoteBeforeMicro, "entry quote before"),
      tradeType: oneOf(f.tradeType, PERP_TRADE_TYPES, "trade type"),
      attribution: oneOf(f.attribution, PERP_ATTRIBUTIONS, "attribution"),
      leg,
      venueTsMs: safeInt(f.venueTsMs, "venue timestamp (ms)", 1),
    };
  });
  for (const f of fills) if (!expected.has(f.marketId)) throw new RangeError(`perp ledger: a paper fill in market ${f.marketId} was booked without reading it`);
  const fu = b.funding ?? null;
  const funding = fu === null ? null : {
    fundingId: idText(fu.fundingId, "funding id"),
    marketId: safeInt(fu.marketId, "market id", 0, 65_535),
    fundingHour: safeInt(fu.fundingHour, "funding hour", 0),
    payment: intText(fu.paymentMicro, "funding payment"),
    ratePpm: optSafeInt(fu.ratePpm, "funding rate (ppm)", -1_000_000, 1_000_000),
    positionBase: intText(fu.positionBase, "funding position base", { min: 0n }),
    positionSide: oneOf(fu.positionSide, ["long", "short"] as const, "position side"),
  };
  if (funding && funding.fundingHour % 3600 !== 0) throw new RangeError(`perp ledger: funding hour ${funding.fundingHour} is not on the hour`);
  if (funding && !expected.has(funding.marketId)) throw new RangeError("perp ledger: a paper funding names a market it did not read");
  const ends = (b.restingEnd ?? []).map((r) => ({
    marketId: safeInt(r.marketId, "market id", 0, 65_535),
    role: oneOf(r.role, ["sl", "tp"] as const, "resting leg role"),
    status: oneOf(r.status, PERP_LEG_STATUSES, "leg status"),
    venueStatus: idText(r.venueStatus, "venue status"),
  }));
  const cashUsdg = Number(cashDelta) / 1e6;

  return getDb().tx(async (db) => {
    const { epoch, journalAs } = await perpBookingOf(db, b.agentId);
    if (epoch !== epochWanted) throw new RangeError(`perp ledger: the paper book is in epoch ${epoch}, not the ${epochWanted} this action was computed in`);

    // Identity first: a re-run of an action already booked moves nothing.
    const ids = fills.length + (funding ? 1 : 0);
    if (ids > 0) {
      let held = 0;
      for (const f of fills) {
        const r = await db
          .prepare(`SELECT 1 AS ok FROM perp_fills WHERE agent_id = ? AND mode = 'paper' AND venue_trade_id = ? AND side_role = ?`)
          .get(agent, f.venueTradeId, f.sideRole);
        if (r) held += 1;
      }
      if (funding) {
        const r = await db
          .prepare(`SELECT 1 AS ok FROM perp_funding WHERE agent_id = ? AND mode = 'paper' AND market_id = ? AND (funding_id = ? OR funding_hour = ?)`)
          .get(agent, funding.marketId, funding.fundingId, funding.fundingHour);
        if (r) held += 1;
      }
      if (held === ids) return "duplicate";
      if (held > 0) throw new RangeError("perp ledger: part of this paper action is already booked and part is not");
    }

    for (const [marketId, e] of expected) {
      const r = (await db
        .prepare(
          `SELECT side, base, entry_price, allocated_margin_micro, stop_trigger, take_trigger, funding_hour_applied, imf_bp, margin_mode
             FROM perp_positions WHERE agent_id = ? AND mode = 'paper' AND market_id = ?`,
        )
        .get(agent, marketId)) as Record<string, unknown> | undefined;
      const flat = r === undefined || r.base === "0";
      const moved = (why: string) => new RangeError(`perp ledger: the paper book moved under this action (market ${marketId}: ${why})`);
      if (e.held === null) {
        if (!flat) throw moved("it holds a position");
      } else {
        if (flat || r === undefined) throw moved("it is flat");
        const opt = (v: unknown) => (v === null || v === undefined ? null : textInt(v));
        const hourHeld = r.funding_hour_applied === null || r.funding_hour_applied === undefined ? null : Number(r.funding_hour_applied);
        if (
          r.side !== e.held.side ||
          textInt(r.base) !== e.held.base ||
          opt(r.entry_price) !== e.held.entryPrice ||
          textInt(r.allocated_margin_micro) !== e.held.allocatedMarginMicro ||
          opt(r.stop_trigger) !== e.held.stopTrigger ||
          opt(r.take_trigger) !== e.held.takeTrigger ||
          hourHeld !== e.held.fundingHourApplied
        ) {
          throw moved("its position changed");
        }
      }
      if (e.isolatedImfBp !== undefined && (r === undefined || Number(r.imf_bp) !== e.isolatedImfBp || r.margin_mode !== "isolated")) {
        throw moved(`it is not isolated at ${e.isolatedImfBp} bp`);
      }
    }

    // The resting children the fills execute, read before any leg is ended.
    const restingOf = async (marketId: number, role: "sl" | "tp") =>
      (await db
        .prepare(
          `SELECT l.order_id AS order_id, l.client_order_index AS coi FROM perp_order_legs l
             JOIN perp_orders o ON o.id = l.order_id
            WHERE l.agent_id = ? AND l.mode = 'paper' AND l.role = ? AND l.status IN ('submitted', 'pending', 'open')
              AND o.agent_id = l.agent_id AND o.mode = 'paper' AND o.market_id = ?
            ORDER BY l.client_order_index DESC LIMIT 1`,
        )
        .get(agent, role, marketId)) as { order_id: string; coi: number } | undefined;

    if (order) {
      await db
        .prepare(
          `INSERT INTO perp_orders (id, agent_id, mode, epoch, nonce, status, effect, reduce_only, market_id, worst_notional_micro,
                                    filled_base, filled_quote_micro, decision_id, reason, resolved_at)
           VALUES (?, ?, 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
        )
        .run(order.id, agent, epoch, order.nonce, order.status, order.effect, order.reduceOnly ? 1 : 0, order.marketId, order.worst,
          order.filledBase, order.filledQuote, order.decisionId, order.reason);
      for (const l of order.legs) {
        await db
          .prepare(
            `INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, venue_status)
             VALUES (?, 'paper', ?, ?, ?, ?, 'paper')`,
          )
          .run(agent, order.id, l.role, l.coi, l.status);
      }
    }

    for (const f of fills) {
      let orderId: string | null = null;
      let coi: number | null = null;
      if (f.leg !== null && "own" in f.leg && order) {
        const own = f.leg.own;
        orderId = order.id;
        coi = order.legs.find((l) => l.role === own)?.coi ?? null;
      } else if (f.leg !== null && "resting" in f.leg) {
        const r = await restingOf(f.marketId, f.leg.resting);
        orderId = r?.order_id ?? null;
        coi = r === undefined ? null : Number(r.coi);
      }
      await db
        .prepare(
          `INSERT INTO perp_fills (agent_id, mode, epoch, venue_trade_id, side_role, market_id, side, role, base, price,
                                   quote_micro, fee_micro, realized_micro, position_before, entry_quote_before_micro,
                                   trade_type, attribution, order_id, client_order_index, venue_ts_ms)
           VALUES (?, 'paper', ?, ?, ?, ?, ?, 'taker', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(agent, epoch, f.venueTradeId, f.sideRole, f.marketId, f.side, f.base, f.price, f.quote, f.fee, f.realized,
          f.positionBefore, f.entryQuoteBefore, f.tradeType, f.attribution, orderId, coi, f.venueTsMs);
      // insertPerpFill's payload, key for key: audit.ts reads one shape.
      await appendJournalRow(db, journalAs, epoch, "perp-fill", {
        attribution: f.attribution,
        base: f.base,
        clientOrderIndex: coi,
        entryQuoteBeforeMicro: f.entryQuoteBefore,
        feeMicro: f.fee,
        market: marketKeyOf(f.marketId),
        marketId: f.marketId,
        mode: "paper",
        orderId,
        positionBefore: f.positionBefore,
        price: f.price,
        quoteMicro: f.quote,
        realizedMicro: f.realized,
        role: "taker",
        side: f.side,
        sideRole: f.sideRole,
        tradeType: f.tradeType,
        venueOrderIndex: null,
        venueTradeId: f.venueTradeId,
        venueTsMs: f.venueTsMs,
        venueTxHash: null,
      });
    }

    if (funding) {
      await db
        .prepare(
          `INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro,
                                     rate_ppm, position_base, position_side)
           VALUES (?, 'paper', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(agent, epoch, funding.marketId, funding.fundingId, funding.fundingHour, funding.payment, funding.ratePpm,
          funding.positionBase, funding.positionSide);
      // insertPerpFunding's payload, key for key.
      await appendJournalRow(db, journalAs, epoch, "funding", {
        fundingHour: funding.fundingHour,
        fundingId: funding.fundingId,
        market: marketKeyOf(funding.marketId),
        marketId: funding.marketId,
        mode: "paper",
        paymentMicro: funding.payment,
        positionBase: funding.positionBase,
        positionSide: funding.positionSide,
        ratePpm: funding.ratePpm,
      });
    }

    for (const r of ends) {
      await db
        .prepare(
          `UPDATE perp_order_legs SET status = ?, venue_status = ?, updated_at = unixepoch()
            WHERE agent_id = ? AND mode = 'paper' AND role = ? AND status IN ('submitted', 'pending', 'open')
              AND order_id IN (SELECT id FROM perp_orders WHERE agent_id = ? AND mode = 'paper' AND market_id = ?)
              ${order ? "AND order_id <> ?" : ""}`,
        )
        .run(r.status, r.venueStatus, agent, r.role, agent, r.marketId, ...(order ? [order.id] : []));
    }

    // THE PAPER BOOK'S CROSS COLLATERAL IS A READ ZERO, NOT AN ABSENT ONE.
    // This engine draws margin straight from paper cash (ΣM lives on the
    // rows), so its C is 0 by construction — but the account row it books
    // under was created by bumpNonceHighWater with the column NULL, and
    // paper-checkpoint.ts reads NULL collateral beside open positions as a
    // torn book and refuses the WHOLE checkpoint row: spot cash, shares and
    // basis with it. A hosted redeploy then restored the checkpoint from
    // before the open (the position gone, its margin back in cash) or, with
    // none for the epoch, refused to start the agent (the review's
    // R3-PAPER-CKPT-NULL-COLLATERAL). Seeded here, in the booking's own
    // transaction, so no committed paper position exists without it; a value
    // already there (a restored checkpoint's) is never overwritten, and a
    // genuinely torn book still reads as one.
    await db
      .prepare(
        `INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro) VALUES (?, 'paper', '0')
         ON CONFLICT(agent_id, mode) DO UPDATE SET paper_collateral_micro = COALESCE(perp_accounts.paper_collateral_micro, '0')`,
      )
      .run(agent);

    for (const p of b.positions) await putPerpPosition(db, { ...p, agentId: b.agentId, mode: "paper", source: "paper" });

    if (cashDelta !== 0n) {
      const res = await db
        .prepare(
          `UPDATE paper_book SET cash_usdg = cash_usdg + ?, updated_at = unixepoch()
            WHERE LOWER(agent_id) = LOWER(?)${cashDelta < 0n ? " AND cash_usdg >= ?" : ""}`,
        )
        .run(cashUsdg, b.agentId, ...(cashDelta < 0n ? [-cashUsdg] : []));
      if (Number(res.changes) !== 1) {
        throw new RangeError(
          cashDelta < 0n
            ? `perp ledger: the paper book cannot fund ${-cashUsdg} USDG of margin and fees`
            : "perp ledger: there is no single paper book to return the cash to",
        );
      }
    }
    return "booked";
  });
}

// ── the perp lane's own reads (perps/lane.ts) ────────────────────────────────

/**
 * WHAT THE PERPS VIEW NEEDS FROM THE LEDGER THAT NO OTHER READ ALREADY GIVES —
 * the day's opens, the last exit per market and what caused it (the cooldown
 * clock perp-trend reads), and the last open per market (the candle it was
 * taken on). One call, so the lane builds its view from one moment of the
 * ledger rather than three.
 *
 *   opensToday   perp_orders rows that are NOT reduce-only, created in the
 *                trailing window, in an ops-counting status — the count
 *                perpsMaxOpensPerDay judges. The signed flag, never `effect`:
 *                an order that is not reduce-only can open, whatever it was
 *                called (perpOpenNotionalSince's rule).
 *   lastExits    per market, the newest fill that REDUCED a position (a long's
 *                ask, a short's bid), and why: a forced fill (liquidation,
 *                deleverage, settlement) is `forced`; our resting child is
 *                `stop` or `take` by its leg (or, on paper, the event id the
 *                engine minted); an order of ours is `risk` when its decision
 *                was a hard risk exit (protect.ts, a venue stop) and
 *                `strategy` otherwise. Anything else is `unknown`, which
 *                perp-trend cools down for longest. Newer than `sinceSec`.
 *   lastOpenAt   per market, the newest open order's created_at (unix s).
 *
 * THROWS on a read failure — never an empty map: an unreadable cooldown is
 * not "no cooldown", and the lane then builds no view (unread).
 */
export async function perpLaneLedgerFacts(
  agentId: string,
  mode: PerpMode,
  sinceSec: number,
): Promise<{
  opensToday: number;
  lastExits: Map<number, { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" }>;
  lastOpenAt: Map<number, number>;
}> {
  const agent = perpAgent(agentId);
  const m = perpMode(mode);
  const since = Math.floor(sinceSec);
  const db = getDb();
  const statuses = PERP_OPS_ORDER_STATUSES.map(() => "?").join(", ");
  const opens = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM perp_orders
        WHERE agent_id = ? AND mode = ? AND reduce_only = 0 AND effect = 'open' AND created_at > ? AND status IN (${statuses})`,
    )
    .get(agent, m, since, ...PERP_OPS_ORDER_STATUSES)) as { n: number } | undefined;
  const lastOpenRows = (await db
    .prepare(
      `SELECT market_id, MAX(created_at) AS at FROM perp_orders
        WHERE agent_id = ? AND mode = ? AND reduce_only = 0 AND effect = 'open' AND market_id IS NOT NULL AND created_at > ?
        GROUP BY market_id`,
    )
    .all(agent, m, since)) as { market_id: number; at: number }[];
  const lastOpenAt = new Map<number, number>();
  for (const r of lastOpenRows) lastOpenAt.set(Number(r.market_id), Number(r.at));

  const exitRows = (await db
    .prepare(
      `SELECT f.market_id AS market_id, f.venue_ts_ms AS ts, f.trade_type AS trade_type, f.attribution AS attribution,
              f.venue_trade_id AS trade_id, l.role AS leg_role, d.provenance AS provenance
         FROM perp_fills f
         LEFT JOIN perp_order_legs l
           ON l.agent_id = f.agent_id AND l.mode = f.mode AND l.client_order_index = f.client_order_index
         LEFT JOIN perp_orders o ON o.id = f.order_id
         LEFT JOIN decisions d ON d.id = o.decision_id
        WHERE f.agent_id = ? AND f.mode = ? AND f.venue_ts_ms > ?
          AND ((f.side = 'long' AND f.side_role = 'ask') OR (f.side = 'short' AND f.side_role = 'bid'))
        ORDER BY f.venue_ts_ms DESC`,
    )
    .all(agent, m, since * 1000)) as {
    market_id: number;
    ts: number;
    trade_type: string;
    attribution: string;
    trade_id: string;
    leg_role: string | null;
    provenance: string | null;
  }[];
  const lastExits = new Map<number, { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" }>();
  for (const r of exitRows) {
    const market = Number(r.market_id);
    if (lastExits.has(market)) continue; // newest first: the first row per market is the last exit
    let cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown";
    if (r.attribution === "venue-forced" || r.trade_type !== "trade") cause = "forced";
    else if (r.attribution === "venue-stop") {
      cause = r.leg_role === "tp" || (r.leg_role === null && r.trade_id.startsWith("paper:tp:")) ? "take" : "stop";
    } else if (r.attribution === "intent") cause = r.provenance === "hard-risk-exit" ? "risk" : "strategy";
    else cause = "unknown";
    lastExits.set(market, { atSec: Math.floor(Number(r.ts) / 1000), cause });
  }
  return { opensToday: Number(opens?.n ?? 0), lastExits, lastOpenAt };
}
