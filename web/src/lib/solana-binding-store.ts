/** Chain-scoped wallet bindings. Existing RH tenant identities remain unchanged. */
import { CHAINS } from "../../../packages/core/src/ids";
import { parseSolanaRawAmount, solanaPaperAgentId, validateSolanaAccountLimits, type SolanaPaperLimits } from "../../../packages/core/src/solana";
import type { Db } from "../../../worker/src/db";
import { getSolanaRuntimeDb } from "../../../worker/src/solana-runtime-db";

export type SolanaRequestedMode = "paper" | "live";
export interface SolanaStrategy {
  enabled: boolean;
  targetSolBps: number;
  rebalanceBps: number;
  tradeUsdgRaw: string;
  intervalSeconds: number;
}
export interface SolanaBinding {
  tenant: `0x${string}`;
  did: string;
  chain: typeof CHAINS.solana;
  owner: string;
  requestedMode: SolanaRequestedMode;
  limits: SolanaPaperLimits | null;
  strategy: SolanaStrategy | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}
export class SolanaBindingError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "missing" | "stale") {
    super({ invalid: "Invalid Solana account settings.", conflict: "This Solana wallet is already bound to another account, or this account already has a different Solana wallet.",
      missing: "Connect and verify a Solana wallet first.", stale: "Solana settings changed. Refresh before saving again." }[code]);
    this.name = "SolanaBindingError";
  }
}
export interface SolanaBindingStore {
  get(tenant: `0x${string}`): Promise<SolanaBinding | null>;
  bind(tenant: `0x${string}`, did: string, owner: string): Promise<SolanaBinding>;
  /**
   * RE-BIND after the tenant's verified identity changed (SOLANA OWNER KEY RECOVERY below).
   * Only after the route verified a fresh owner-key proof naming `tenant`, `did` and `owner`.
   */
  rebind(tenant: `0x${string}`, did: string, owner: string, previousDid: string): Promise<SolanaBinding>;
  settings(tenant: `0x${string}`, owner: string, revision: number, mode: SolanaRequestedMode, limits: SolanaPaperLimits): Promise<SolanaBinding>;
  strategy(tenant: `0x${string}`, owner: string, revision: number, value: SolanaStrategy): Promise<SolanaBinding>;
  /** Kill switch: turn the tenant's autonomous strategy off. True when it was on. */
  disableForKill(tenant: `0x${string}`): Promise<boolean>;
  /** Every tenant with a saved strategy, on or off. */
  strategyTenants(): Promise<`0x${string}`[]>;
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS solana_wallet_bindings (
  tenant TEXT PRIMARY KEY, did TEXT NOT NULL, chain TEXT NOT NULL,
  owner TEXT NOT NULL UNIQUE, requested_mode TEXT NOT NULL CHECK (requested_mode IN ('paper', 'live')),
  limits_json TEXT, strategy_json TEXT, revision BIGINT NOT NULL, created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solana_wallet_binding_rebinds (
  tenant TEXT NOT NULL, owner TEXT NOT NULL, previous_did TEXT NOT NULL, did TEXT NOT NULL,
  revision BIGINT NOT NULL, rebound_at_ms BIGINT NOT NULL, PRIMARY KEY (tenant, revision)
);`;
/**
 * SOLANA OWNER KEY RECOVERY: RE-BINDING AFTER THE TENANT'S IDENTITY CHANGED.
 *
 * A binding names the tenant, the Privy DID that verified it and the Solana
 * owner key. Every Solana route admits only that DID for that tenant
 * (solanaContext, the status route). Robinhood sign-in can re-point a tenant
 * at a new DID: a wallet-signed login with a DID never seen before claims the
 * tenant whose wallet signed (identity-store resolveOrClaimDid), and the old
 * DID then maps to no tenant. The binding's DID no longer signs in, the new
 * one does not match it, and status, revoke and withdrawal were all refused.
 *
 * The Solana owner key is the authority here, not the sign-in. A principal
 * whose verified DID now maps to the tenant (authenticateSolana: cookie and
 * DID agree) may re-bind the tenant's EXISTING binding to its DID by signing a
 * fresh RE-BIND challenge with the SAME owner key (bind/rebind-proof.ts): the
 * signed message says it moves the account's controls (mode, limits, the
 * registered permission, the strategy, owner actions) to the new sign-in, and
 * names the tenant, the previous and the new DID, the owner and the origin; its
 * nonce is single-use, and the bind route verifies and consumes it before
 * calling rebind. The ordinary binding message, which says it grants no
 * authority, is never accepted for a re-bind. Holding
 * that key already means holding the vault (every owner transaction needs its
 * signature and pays only to its own accounts), so a re-bind grants nothing
 * the key does not already have, and without the key a remapped DID stays
 * refused exactly as before.
 *
 * What it never does:
 * - change Robinhood sign-in, the identity store or any tenant mapping;
 * - change the owner key: another wallet is still a conflict, and the owner
 *   stays UNIQUE, so no other tenant can take or lose a binding here;
 * - touch any tenant but the authenticated one: the update is keyed by tenant,
 *   owner and the DID it replaces (compare-and-set), in one transaction.
 *
 * What it changes, and records: the DID, a revision bump (which fences any
 * autonomous admission or settings form in flight), and the autonomous
 * strategy turned off, as the kill switch does (owner decision: automation
 * the previous identity enabled waits for the new one to turn it back on;
 * mode, limits and the registered session stay). Each re-bind is kept in
 * solana_wallet_binding_rebinds with both DIDs.
 *
 * Simply signing in again with the original identity also works: it re-points
 * the tenant back at the binding's DID, and nothing here is needed.
 *
 * WHO CAN USE WHICH (said plainly, since the page can only do one of them):
 * - Owners the app created (a Privy embedded wallet, the only owner the page
 *   offers): sign in again with the original login. That is the recovery.
 *   An embedded key belongs to the Privy user that created it, and the page
 *   signs only with an embedded wallet linked to the signed-in Privy user
 *   (useSolanaOwner), so a second Privy user's page can never produce the
 *   bound key's signature. It offers that user's own wallet, which the bind
 *   route refuses with SOLANA_OTHER_SIGN_IN, as every other route does.
 * - A re-bind needs a signature from the bound owner key itself: an exported
 *   key imported into the new identity's embedded wallet, or an external
 *   signer outside the page. solana-rebind.test.ts proves the server side by
 *   signing outside the page's wallet selection.
 */
/** The answer while another sign-in verified this tenant's Solana wallet (solana-sign-in.ts). */
export { SOLANA_OTHER_SIGN_IN } from "./solana-sign-in";
type Row = { tenant: string; did: string; chain: string; owner: string; requested_mode: SolanaRequestedMode;
  limits_json: string | null; strategy_json: string | null; revision: number | string; created_at_ms: number | string; updated_at_ms: number | string };
export function validateSolanaStrategy(value: unknown): SolanaStrategy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SolanaBindingError("invalid");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["enabled", "targetSolBps", "rebalanceBps", "tradeUsdgRaw", "intervalSeconds"].includes(key))
    || typeof item.enabled !== "boolean" || !Number.isInteger(item.targetSolBps) || Number(item.targetSolBps) < 0 || Number(item.targetSolBps) > 10_000
    || !Number.isInteger(item.rebalanceBps) || Number(item.rebalanceBps) < 100 || Number(item.rebalanceBps) > 5_000
    || !Number.isInteger(item.intervalSeconds) || Number(item.intervalSeconds) < 30 || Number(item.intervalSeconds) > 86_400) throw new SolanaBindingError("invalid");
  try { parseSolanaRawAmount(item.tradeUsdgRaw); } catch { throw new SolanaBindingError("invalid"); }
  return { enabled: item.enabled, targetSolBps: Number(item.targetSolBps), rebalanceBps: Number(item.rebalanceBps),
    tradeUsdgRaw: item.tradeUsdgRaw as string, intervalSeconds: Number(item.intervalSeconds) };
}
function tenantKey(value: string): asserts value is `0x${string}` {
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new SolanaBindingError("invalid");
}
function decoded(row: Row): SolanaBinding {
  if (row.chain !== CHAINS.solana) throw new SolanaBindingError("invalid");
  return { tenant: row.tenant as `0x${string}`, did: row.did, chain: CHAINS.solana, owner: row.owner,
    requestedMode: row.requested_mode, limits: row.limits_json ? JSON.parse(row.limits_json) as SolanaPaperLimits : null,
    strategy: row.strategy_json ? validateSolanaStrategy(JSON.parse(row.strategy_json)) : null,
    revision: Number(row.revision), createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) };
}
export class SqlSolanaBindingStore implements SolanaBindingStore {
  private ready: Promise<Db> | null = null;
  constructor(private connect: () => Promise<Db>, private dialect: "sqlite" | "postgres", private now: () => number = Date.now) {}
  private database(): Promise<Db> {
    if (!this.ready) this.ready = this.connect().then(async (db) => {
      if (this.dialect === "postgres") await db.tx(async (tx) => {
        await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_983);
        await tx.exec(SCHEMA);
        // Only when the catalog shows the column missing (as applyLedgerMigrations does): ADD COLUMN IF NOT
        // EXISTS takes an ACCESS EXCLUSIVE lock even when the column exists, so each process's first use queued
        // behind every open reader of the table, and every later reader and kill behind it. The advisory lock
        // serializes the check and the ALTER; Db still sends the ALTER as IF NOT EXISTS.
        const column = await tx.prepare(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('solana_wallet_bindings')
          AND attname = 'strategy_json' AND NOT attisdropped) AS present`).get() as { present?: unknown } | undefined;
        if (column?.present !== true) await tx.exec("ALTER TABLE solana_wallet_bindings ADD COLUMN strategy_json TEXT");
      });
      else await db.tx(async (tx) => {
        await tx.exec(SCHEMA);
        const columns = await tx.prepare("PRAGMA table_info(solana_wallet_bindings)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "strategy_json")) await tx.exec("ALTER TABLE solana_wallet_bindings ADD COLUMN strategy_json TEXT");
      });
      return db;
    }).catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }
  async get(tenant: `0x${string}`): Promise<SolanaBinding | null> {
    tenantKey(tenant);
    const row = await (await this.database()).prepare("SELECT * FROM solana_wallet_bindings WHERE tenant = ?").get(tenant) as Row | undefined;
    return row ? decoded(row) : null;
  }
  async bind(tenant: `0x${string}`, did: string, owner: string): Promise<SolanaBinding> {
    tenantKey(tenant);
    if (!/^did:privy:[A-Za-z0-9_-]{1,160}$/.test(did)) throw new SolanaBindingError("invalid");
    try { solanaPaperAgentId(owner); } catch { throw new SolanaBindingError("invalid"); }
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaBindingError("invalid");
    const db = await this.database();
    // Both uniqueness constraints are decided by one atomic insert. Neither a
    // concurrent first binding nor a second tenant can replace an existing one.
    await db.prepare(`INSERT INTO solana_wallet_bindings
      (tenant,did,chain,owner,requested_mode,limits_json,revision,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,'paper',NULL,0,?,?) ON CONFLICT DO NOTHING`).run(tenant, did, CHAINS.solana, owner, nowMs, nowMs);
    const existing = await this.get(tenant);
    if (!existing || existing.owner !== owner || existing.did !== did) throw new SolanaBindingError("conflict");
    return existing;
  }
  /** See SOLANA OWNER KEY RECOVERY above. The caller verified and consumed a fresh owner-key proof naming `did`. */
  async rebind(tenant: `0x${string}`, did: string, owner: string, previousDid: string): Promise<SolanaBinding> {
    tenantKey(tenant);
    if (!/^did:privy:[A-Za-z0-9_-]{1,160}$/.test(did) || !/^did:privy:[A-Za-z0-9_-]{1,160}$/.test(previousDid)) throw new SolanaBindingError("invalid");
    try { solanaPaperAgentId(owner); } catch { throw new SolanaBindingError("invalid"); }
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaBindingError("invalid");
    const db = await this.database();
    await db.tx(async (tx) => {
      // The same row lock trade admission and the kill switch take.
      const locked = await tx.prepare("UPDATE solana_wallet_bindings SET revision = revision WHERE tenant = ? AND owner = ? AND did = ?").run(tenant, owner, previousDid);
      if (locked.changes !== 1) {
        const current = await tx.prepare("SELECT owner, did FROM solana_wallet_bindings WHERE tenant = ?").get(tenant) as { owner: string; did: string } | undefined;
        // Already re-bound to this DID (a retry): nothing to do. Anything else is not this binding.
        if (current?.owner === owner && current.did === did) return;
        throw new SolanaBindingError(current ? "conflict" : "missing");
      }
      if (previousDid === did) return;
      const row = await tx.prepare("SELECT strategy_json, revision FROM solana_wallet_bindings WHERE tenant = ?").get(tenant) as { strategy_json: string | null; revision: number | string };
      let strategy: SolanaStrategy | null = null;
      try { strategy = row.strategy_json ? validateSolanaStrategy(JSON.parse(row.strategy_json)) : null; } catch { /* Unreadable: cleared below. */ }
      const revision = Number(row.revision) + 1;
      await tx.prepare("UPDATE solana_wallet_bindings SET did = ?, strategy_json = ?, revision = ?, updated_at_ms = ? WHERE tenant = ? AND owner = ? AND did = ?")
        .run(did, strategy ? JSON.stringify({ ...strategy, enabled: false }) : null, revision, nowMs, tenant, owner, previousDid);
      await tx.prepare("INSERT INTO solana_wallet_binding_rebinds (tenant, owner, previous_did, did, revision, rebound_at_ms) VALUES (?,?,?,?,?,?)")
        .run(tenant, owner, previousDid, did, revision, nowMs);
    });
    return (await this.get(tenant))!;
  }
  /** The tenant's re-binds, oldest first (SOLANA OWNER KEY RECOVERY). */
  async rebinds(tenant: `0x${string}`): Promise<Array<{ owner: string; previousDid: string; did: string; revision: number; reboundAtMs: number }>> {
    tenantKey(tenant);
    const rows = await (await this.database()).prepare("SELECT owner, previous_did, did, revision, rebound_at_ms FROM solana_wallet_binding_rebinds WHERE tenant = ? ORDER BY revision")
      .all(tenant) as Array<{ owner: string; previous_did: string; did: string; revision: number | string; rebound_at_ms: number | string }>;
    return rows.map((row) => ({ owner: row.owner, previousDid: row.previous_did, did: row.did, revision: Number(row.revision), reboundAtMs: Number(row.rebound_at_ms) }));
  }
  async settings(tenant: `0x${string}`, owner: string, revision: number, mode: SolanaRequestedMode, limits: SolanaPaperLimits): Promise<SolanaBinding> {
    tenantKey(tenant);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || !["paper", "live"].includes(mode)) throw new SolanaBindingError("invalid");
    const nowMs = this.now();
    let policy: SolanaPaperLimits;
    // The account bounds (96 operations a day, a 168-hour permission) for paper limits
    // too: paper books, paper trades and the strategy refuse anything wider later.
    try { policy = validateSolanaAccountLimits(limits, nowMs); } catch { throw new SolanaBindingError("invalid"); }
    const db = await this.database();
    const saved = await db.prepare(`UPDATE solana_wallet_bindings SET strategy_json = CASE WHEN requested_mode <> ? THEN NULL ELSE strategy_json END,
      requested_mode = ?, limits_json = ?,
      revision = revision + 1, updated_at_ms = ? WHERE tenant = ? AND owner = ? AND revision = ?`)
      .run(mode, mode, JSON.stringify(policy), nowMs, tenant, owner, revision);
    if (saved.changes !== 1) throw new SolanaBindingError("stale");
    return (await this.get(tenant))!;
  }
  async strategy(tenant: `0x${string}`, owner: string, revision: number, value: SolanaStrategy): Promise<SolanaBinding> {
    tenantKey(tenant);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new SolanaBindingError("invalid");
    const strategy = validateSolanaStrategy(value), nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaBindingError("invalid");
    const db = await this.database();
    const saved = await db.prepare(`UPDATE solana_wallet_bindings SET strategy_json = ?, revision = revision + 1,
      updated_at_ms = ? WHERE tenant = ? AND owner = ? AND revision = ?`)
      .run(JSON.stringify(strategy), nowMs, tenant, owner, revision);
    if (saved.changes !== 1) throw new SolanaBindingError("stale");
    return (await this.get(tenant))!;
  }
  /**
   * THE KILL PATHS' DATABASE, or null when Solana was never used here.
   *
   * Robinhood's "kill all agents" and Telegram /kill call the two methods
   * below for every tenant, MERRYMEN_SOLANA on or off. database() writes the
   * schema (under an advisory lock on Postgres), so a kill would create Solana
   * tables in a production database that never ran Solana, and a fault there
   * would report a Robinhood kill incomplete. So the table and its
   * strategy_json column are looked up first, read-only, with no lock and no
   * DDL (to_regclass and pg_attribute on Postgres, which resolve the
   * unqualified name on this connection's search path as every query here
   * does; sqlite_master and pragma_table_info on SQLite). Either absent, no
   * strategy can exist and there is nothing to stop. Both present, the kill
   * runs on the connection as it is: it needs only UPDATE and SELECT, and
   * database()'s ALTER TABLE takes an ACCESS EXCLUSIVE lock that waits behind
   * every open reader of the table (review RHS, round 1: 3 s and a statement
   * timeout behind one read transaction). The lookup runs on every kill, even
   * once this process has started database(): a kill never awaits that schema
   * step, so neither its advisory lock nor its failure holds up or fails a
   * kill (review RHS, round 2). Two catalog reads cost little. One wait is
   * PostgreSQL's own: an ALTER already sent and queued for its lock queues the
   * kill's row lock behind it, from this process or any other. A failure of
   * the kill's own statements still fails the kill.
   */
  private async killDb(): Promise<Db | null> {
    const db = await this.connect();
    const row = await db.prepare(this.dialect === "postgres"
      ? `SELECT to_regclass('solana_wallet_bindings') IS NOT NULL AS found, EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('solana_wallet_bindings') AND attname = 'strategy_json' AND NOT attisdropped) AS strategy`
      : `SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'solana_wallet_bindings') AS found,
          EXISTS (SELECT 1 FROM pragma_table_info('solana_wallet_bindings') WHERE name = 'strategy_json') AS strategy`).get() as { found?: unknown; strategy?: unknown } | undefined;
    const yes = (value: unknown) => value === true || value === 1;
    return yes(row?.found) && yes(row?.strategy) ? db : null;
  }
  async strategyTenants(): Promise<`0x${string}`[]> {
    const db = await this.killDb();
    if (!db) return [];
    const rows = await db.prepare("SELECT tenant FROM solana_wallet_bindings WHERE strategy_json IS NOT NULL ORDER BY tenant").all() as Array<{ tenant: string }>;
    return rows.map((row) => { tenantKey(row.tenant); return row.tenant; });
  }
  async disableForKill(tenant: `0x${string}`): Promise<boolean> {
    tenantKey(tenant);
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaBindingError("invalid");
    const db = await this.killDb();
    if (!db) return false;
    return db.tx(async (tx) => {
      // The same row lock trade admission takes. The revision bump below fences
      // any autonomous admission already in flight, whatever revision it read.
      const locked = await tx.prepare("UPDATE solana_wallet_bindings SET revision = revision WHERE tenant = ?").run(tenant);
      if (locked.changes !== 1) return false;
      const row = await tx.prepare("SELECT strategy_json FROM solana_wallet_bindings WHERE tenant = ?").get(tenant) as { strategy_json: string | null };
      if (!row.strategy_json) return false;
      let strategy: SolanaStrategy | null = null;
      try { strategy = validateSolanaStrategy(JSON.parse(row.strategy_json)); } catch { /* Unreadable: cleared below. */ }
      if (strategy && !strategy.enabled) return false;
      await tx.prepare("UPDATE solana_wallet_bindings SET strategy_json = ?, revision = revision + 1, updated_at_ms = ? WHERE tenant = ?")
        .run(strategy ? JSON.stringify({ ...strategy, enabled: false }) : null, nowMs, tenant);
      return true;
    });
  }
}

/** Lazy: importing a route never opens a database or writes a schema. */
let store: SolanaBindingStore | undefined;
export function getSolanaBindingStore(): SolanaBindingStore {
  if (!store) {
    store = new SqlSolanaBindingStore(getSolanaRuntimeDb, process.env.DATABASE_URL ? "postgres" : "sqlite");
  }
  return store;
}
