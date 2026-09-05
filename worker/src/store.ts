/**
 * Trade/event/equity persistence — SQLite (node:sqlite, built into Node 22+).
 * One durable file at .data/merrymen.db shared by worker (writer) and web
 * (reader via /api/feed). No external service, no keys. Migration path to
 * Postgres is a schema port when the platform goes multi-user.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { StoredGrant } from "../../packages/core/src/index";
import { ensureHome, homePaths } from "./home";
import { wrapSqlite, makePgDb, type Db } from "./db";
// The one definition of a flow's identity. Imported rather than restated so
// the reader and the writer cannot disagree about what makes a flow unique.
import { flowKey } from "./deposit-log";
// The paper/live boundary. A rule rather than a convention, enforced at the one
// function every flow writer passes through — see addFlow.
import { admitCapitalFlow, tradingModeOf, type TradingMode } from "./paper-boundary";

let driver: Db | null = null;

/**
 * The schema, written once in the sqlite dialect — the single source of truth for
 * BOTH backends. Self-hosted runs it verbatim on node:sqlite; the hosted Postgres
 * path runs it through db.ts's translateSchema(). Keeping ONE string, rather than a
 * hand-maintained parallel Postgres DDL, is what stops the two dialects drifting.
 */
const SQLITE_SCHEMA = `
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
      claimed_at INTEGER,
      done_at INTEGER,
      result TEXT
    )`,
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
  await db.exec(SQLITE_SCHEMA);
  for (const ddl of SQLITE_ALTERS) {
    try {
      await db.exec(ddl);
    } catch {
      // column already exists — the same no-op the two init paths rely on
    }
  }
}
/** Open the shared Postgres ledger (hosted, multi-tenant): connect, then run the
 *  same schema + migrations through the async driver, which translates each to the
 *  Postgres dialect. Selected by DATABASE_URL, mirroring the grant store. */
async function initPostgres(url: string): Promise<Db> {
  const d = await makePgDb(url);
  await d.exec(SQLITE_SCHEMA);
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

/** Test seam: drop the cached driver so a test can point MERRYMEN_HOME elsewhere. */
export function resetStoreForTest(): void {
  driver = null;
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
  tx_hash?: string;
  /**
   * Our coarse verdict, not the broker's. 'submitted' is the brokerage rail's
   * committed-but-not-yet-filled state: the money is already reserved against
   * the caps (a submitted order is spend the instant it leaves), and step 6's
   * reconciler resolves it to landed/reverted from the wire. The broker's own
   * state words live in settlement_status, verbatim — two vocabularies, never
   * mixed.
   */
  status: "landed" | "reverted" | "rejected" | "paper" | "submitted";
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
  /** That gas in USDG at the price when it was burned. NULL = unpriced, NOT free. */
  gas_usdg?: number;
  /** Measured execution quality: how far the fill landed from the quote, in bps (+ is worse). */
  fill_slippage_bps?: number;
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
}

/** A fresh decision id. Kept here so every producer stamps the same shape. */
export function newDecisionId(): string {
  return randomUUID();
}

export async function addDecision(row: DecisionRow): Promise<void> {
  try {
    await getDb()
      .prepare(
        `INSERT INTO decisions (id, agent_id, source, strategy, provider, model, symbol, action, size_usdg, reason, dropped_rule, signals_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  } catch (e) {
    console.error("[store] decision insert failed:", e);
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

/** Persisted HWM + accrued fees, loaded at arm time. */
export async function getAgentFinancials(
  agentId: string,
): Promise<{ hwmUsdg: number; accruedFeeUsdg: number }> {
  const row = await getDb()
    .prepare("SELECT hwm_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?")
    .get(agentId) as { hwm_usdg: number; accrued_fee_usdg: number } | undefined;
  return { hwmUsdg: row?.hwm_usdg ?? 0, accruedFeeUsdg: row?.accrued_fee_usdg ?? 0 };
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

export async function setAgentHwm(agentId: string, hwmUsdg: number): Promise<boolean> {
  try {
    await getDb()
      .prepare("UPDATE agents SET hwm_usdg = MAX(hwm_usdg, ?) WHERE smart_account = ?")
      .run(hwmUsdg, agentId);
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
 */
export async function adjustAgentHwm(agentId: string, deltaUsdg: number): Promise<void> {
  try {
    await getDb()
      .prepare("UPDATE agents SET hwm_usdg = MAX(0, hwm_usdg + ?) WHERE smart_account = ?")
      .run(deltaUsdg, agentId);
  } catch (e) {
    console.error("[store] hwm adjust failed:", e);
  }
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

export type JournalKind = "fill" | "flow" | "mark" | "fee";

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
 * The worker is the single writer, so this is about crash-atomicity rather than
 * concurrency: a process that dies between the two writes must leave neither,
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
  // its journal entry commit together or not at all — the Postgres backend needs
  // the single-connection guarantee that sqlite got for free.
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

/**
 * What the heartbeat last said this agent is doing — the BACKSTOP for the paper
 * boundary, not its primary source.
 *
 * Null means the column has not been written yet, which is a genuinely different
 * fact from "live" and is carried as such: `tradingModeOf` turns it into
 * `unknown`, and an unknown mode admits the flow. That is deliberate. Refusing
 * on unknown would silently drop a LIVE agent's opening balance during the
 * window before its first heartbeat — trading one accounting bug for another —
 * so the narrow window is closed at the call site instead, where the answer is
 * known synchronously and never absent.
 */
async function modeOf(agentId: string): Promise<string | null> {
  try {
    const row = (await getDb().prepare("SELECT mode FROM agents WHERE smart_account = ?").get(agentId)) as
      | { mode: string | null }
      | undefined;
    return row?.mode ?? null;
  } catch {
    return null;
  }
}

/**
 * Which chain this agent's grant is on, for a flow that did not carry it.
 *
 * Read from `agents` rather than from config so it is the chain the GRANT was
 * signed for, which is the chain any transaction touching this account is on.
 * Null when the agent row is not there yet: a null chain_id is honest and merely
 * leaves the identity index inert for that row, whereas guessing a chain would
 * make two different chains' transactions collide under one identity.
 */
async function chainIdOf(agentId: string): Promise<number | null> {
  try {
    const row = (await getDb().prepare("SELECT chain_id FROM agents WHERE smart_account = ?").get(agentId)) as
      | { chain_id: number | null }
      | undefined;
    return row?.chain_id ?? null;
  } catch {
    return null;
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
 * Does this agent have rows from BEFORE the audit work? Used once, at the first
 * arm, to decide whether an epoch boundary is needed. A brand-new agent has
 * nothing to quarantine and stays in epoch 1.
 */
export async function hasEpochOneHistory(agentId: string): Promise<boolean> {
  try {
    const row = await getDb()
      .prepare(
        `SELECT (SELECT COUNT(*) FROM trades WHERE agent_id = ? AND epoch = 1 AND created_at < ?)
              + (SELECT COUNT(*) FROM equity WHERE agent_id = ? AND epoch = 1 AND at < ?) AS n`,
      )
      .get(agentId, ACCOUNTING_FIXED_AT, agentId, ACCOUNTING_FIXED_AT) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
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
export async function openNextEpoch(agentId: string, openingBalanceUsdg?: number): Promise<number> {
  const next = (await getAgentEpoch(agentId)) + 1;
  await getDb().prepare("UPDATE agents SET epoch = ? WHERE smart_account = ?").run(next, agentId);
  // AFTER the UPDATE, deliberately: addFlow stamps the row with the agent's
  // CURRENT epoch, so this lands in the new one. Written the other way round it
  // would file the opening balance in the epoch being closed and change nothing.
  if (openingBalanceUsdg !== undefined && openingBalanceUsdg > 0) {
    await addFlow({
      agentId,
      direction: "in",
      amountUsdg: openingBalanceUsdg,
      // NOT 'inferred'. This is the closing equity of the epoch just closed,
      // which is a figure already in the journal — a deterministic bridge, not a
      // deduction from a balance nobody can point at. Sharing a source value with
      // real inference condemned every agent that had ever crossed a boundary to
      // permanent contributionsKnown=false, with no recovery that could exist:
      // no deposit scan can retroactively give a bookkeeping entry a transaction
      // hash it never had. A carry is checkable against the prior epoch's own
      // closing mark instead — see reconcileEpochCarry in accounting-scope.ts.
      source: "epoch-carry",
    });
  }
  return next;
}

/** How the ledger came to know about a flow. See the flows DDL — these are not equal evidence. */
export type FlowSource = "chain-log" | "epoch-carry" | "transfer-intent" | "inferred";

export interface FlowRow {
  agentId: string;
  direction: "in" | "out";
  amountUsdg: number;
  source: FlowSource;
  txHash?: string;
  blockNumber?: number;
  /** Position within the block. Set only for 'chain-log' — see the migration. */
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
  const mode = flow.mode ?? tradingModeOf(await modeOf(flow.agentId));
  const admission = admitCapitalFlow({ mode, source: flow.source, txHash: flow.txHash });
  if (!admission.admit) {
    // Loud, and on the agent's own event log rather than only stderr: a refused
    // flow means a figure the owner can see did NOT move, and the reason has to
    // be somewhere they can find it.
    console.error(`[flows] refused ${flow.source} ${flow.direction} ${flow.amountUsdg} — ${admission.why}`);
    await addEvent(flow.agentId, "warn", `capital flow not recorded — ${admission.why}`).catch(() => {});
    // FALSE, because the caller must not move the high-water mark for money the
    // ledger has no record of. A refusal is a decision, not an error, but the
    // pairing rule is the same either way.
    return false;
  }
  try {
    const epoch = await epochOf(flow.agentId);
    const amount = Math.abs(flow.amountUsdg);
    // LOWERCASE, ALWAYS. A hash is a number, but it reaches here as a string and
    // an RPC may return it in either case — and a case difference defeats both
    // the unique index and the repair's read-back, so the same log written by
    // the scanner and by the backfill would sit in the table twice, both stamped
    // 'chain-log'. Normalising at the single write point is the only place the
    // two writers can be made to agree.
    const txHash = flow.txHash ? flow.txHash.toLowerCase() : null;
    const chainId = flow.chainId ?? (await chainIdOf(flow.agentId));
    await journaled(
      flow.agentId,
      epoch,
      "flow",
      {
        amountUsdg: amount,
        blockNumber: flow.blockNumber ?? null,
        direction: flow.direction,
        logIndex: flow.logIndex ?? null,
        source: flow.source,
        txHash,
      },
      async (db: Db) => {
        await db
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
      },
    );
    return true;
  } catch (e) {
    console.error("[store] flow insert failed:", e);
    return false;
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
export async function recentDecisions(
  agentId: string,
  limit = 6,
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
    return (await getDb()
      .prepare(
        `SELECT d.at AS at, d.action AS action, d.symbol AS symbol, d.size_usdg AS size_usdg,
                d.reason AS reason, d.dropped_rule AS dropped_rule,
                t.status AS status, t.reject_rule AS reject_rule
           FROM decisions d
           LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
          WHERE d.agent_id = ?
          ORDER BY d.at DESC
          LIMIT ?`,
      )
      .all(agentId, limit)) as never;
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
): Promise<{ usdg: number; unpricedTrades: number }> {
  try {
    const where = epoch === undefined ? "" : " AND epoch = ?";
    const params = epoch === undefined ? [agentId] : [agentId, epoch];
    const row = await getDb()
      .prepare(
        `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
           FROM trades WHERE agent_id = ? AND status = 'landed'${where}`,
      )
      .get(...params) as { usdg: number; unpriced: number | null } | undefined;
    return { usdg: row?.usdg ?? 0, unpricedTrades: row?.unpriced ?? 0 };
  } catch {
    return { usdg: 0, unpricedTrades: 0 }; // pre-migration ledger
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
 * Cash as of the most recent equity row for this agent's current epoch.
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
  try {
    const epoch = await epochOf(agentId);
    const row = await getDb()
      .prepare(
        "SELECT cash_usdg FROM equity WHERE agent_id = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(agentId, epoch) as { cash_usdg: number } | undefined;
    return row ? row.cash_usdg : null;
  } catch {
    return null;
  }
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
): Promise<void> {
  try {
    await getDb()
      .prepare("UPDATE agents SET mode = ?, beat_at = ?, sponsor_gas = ? WHERE smart_account = ?")
      .run(mode, atSec, sponsorGas ? 1 : 0, agentId);
  } catch {
    /* a missing heartbeat is a worse thing to crash over than to lose */
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
                    gas_wei = ?, fill_slippage_bps = ?, fill_cash_usdg = ?, gas_usdg = ?
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
                             order_id, settlement_status, gas_wei, fill_slippage_bps, epoch, fill_cash_usdg, gas_usdg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  },
): Promise<void> {
  try {
    const epoch = await epochOf(agentId);
    await journaled(
      agentId,
      epoch,
      "mark",
      {
        blockNumber: b.blockNumber?.toString() ?? null,
        cashUsdg: b.cashUsdg,
        equityUsdg: b.equityUsdg,
        ethWei: b.ethWei.toString(),
        marks: (b.marks ?? []).map((m) => ({
          priceUsd: m.priceUsd,
          source: m.source,
          stale: m.stale,
          symbol: m.symbol,
        })),
        positionsUsdg: b.positionsUsdg,
        // Written only when the caller knows it, so an auditor can tell "there
        // was none" from "nobody said". Undefined is dropped by JSON.stringify,
        // which is exactly the distinction we want on the wire.
        quarantinedCostUsdg: b.quarantinedCostUsdg,
        vaultUsdg: b.vaultUsdg,
      },
      async (db: Db) => {
        await db
          .prepare(
            "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(agentId, b.ethWei.toString(), b.cashUsdg, b.vaultUsdg, b.positionsUsdg, b.equityUsdg, epoch);
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
 */
export async function getOpsToday(agentId: string, rail: BudgetRail = "live"): Promise<number> {
  const { sql, params } = railFilter(rail);
  const row = await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
       WHERE agent_id = ? AND status IN (${sql}) AND created_at > unixepoch() - 86400`,
    )
    .get(agentId, ...params) as { n: number } | undefined;
  return row?.n ?? 0;
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
export async function setAgentXHandle(agentId: string, handle: string | null): Promise<void> {
  try {
    await getDb()
      .prepare(`UPDATE agents SET x_handle = ? WHERE smart_account = ?`)
      .run(handle, agentId);
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
 */
export async function getSpentTodayUsdg(agentId: string, rail: BudgetRail = "live"): Promise<number> {
  const { sql, params } = railFilter(rail);
  const row = await getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status IN (${sql}) AND kind != 'vault-withdraw'
         AND created_at > unixepoch() - 86400`,
    )
    .get(agentId, ...params) as { spent: number } | undefined;
  return row?.spent ?? 0;
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
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT user_op_hash FROM trades
       WHERE agent_id = ? AND user_op_hash IS NOT NULL AND status <> 'submitted'`,
    )
    .all(agentId)) as { user_op_hash: string | null }[];
  const set = new Set<string>();
  for (const r of rows) if (r.user_op_hash) set.add(r.user_op_hash.toLowerCase());
  return set;
}

/** One op that left and never came back — the input to the resolver. */
export interface SubmittedOp {
  userOpHash: string;
  kind: string;
  target: string;
  amountUsdg: number;
  /** unixepoch seconds, stamped at INSERT and never rewritten by a resolution. */
  createdAt: number;
  epoch: number;
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
      `SELECT user_op_hash, kind, target, amount_usdg, created_at, epoch FROM trades
       WHERE agent_id = ? AND status = 'submitted' AND user_op_hash IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all(agentId)) as {
    user_op_hash: string;
    kind: string;
    target: string;
    amount_usdg: number;
    created_at: number;
    epoch: number;
  }[];
  return rows.map((r) => ({
    userOpHash: r.user_op_hash.toLowerCase(),
    kind: r.kind,
    target: r.target,
    amountUsdg: Number(r.amount_usdg),
    createdAt: Number(r.created_at),
    epoch: Number(r.epoch),
  }));
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
 * NOT age-windowed and NOT LIMIT-bounded, unlike `recentCandidates`. A position
 * opened last week must still be exitable today, and an exit refused because the
 * curve aged out of a recency window would be the worst possible time to
 * discover that this list was the wrong shape.
 *
 * Returns null on failure, never []. Empty means "no curves known", which would
 * refuse the whole venue; null means "could not ask", which leaves the rule
 * unable to run rather than silently converting a database hiccup into a
 * blanket refusal.
 */
export async function knownCurves(): Promise<string[] | null> {
  try {
    const rows = (await getDb()
      .prepare(`SELECT DISTINCT curve FROM discovered_pools WHERE curve IS NOT NULL`)
      .all()) as { curve: string | null }[];
    return rows.map((r) => r.curve).filter((c): c is string => !!c).map((c) => c.toLowerCase());
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
