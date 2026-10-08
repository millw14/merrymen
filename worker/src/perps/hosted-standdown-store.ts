/** Durable hosted kill/expiry custody. No session key or signed grant enters this table. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { grantPerp, grantPurpose, isGrantPurpose, type GrantPurpose, type StoredGrant } from "../../../packages/core/src/index";
import type { Db } from "../db";
import { openPerpKey } from "./key-seal";
import { PAGED_CHECKPOINT_SCHEMA, savePagedCheckpointStream, loadPagedCheckpoint, readPagedCheckpoint, deletePagedCheckpoint, isPagedCheckpoint } from "./hosted-financial-pages";
import { inspectFinancialStream, transformFinancialStream, validateFinancialStream } from "./hosted-financial-stream";
import { mergeFinancialStreams } from "./hosted-financial-merge";

export const HOSTED_STANDDOWN_TTL_MS = 15 * 60_000;
export const STANDDOWN_CHECKPOINT_MAX = 32 * 1024 * 1024;
export const HOSTED_STANDDOWN_SCHEMA = `CREATE TABLE IF NOT EXISTS perp_standdown (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'spot', smart_account TEXT NOT NULL,
 api_public_key TEXT NOT NULL, api_key_index INTEGER NOT NULL, sealed_key TEXT,
 reason TEXT NOT NULL, created_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, claimant TEXT, state TEXT NOT NULL DEFAULT 'pending',
 checkpoint TEXT, result_json TEXT, mirrored INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS perp_standdown_tenant ON perp_standdown(tenant);
CREATE INDEX IF NOT EXISTS perp_standdown_account ON perp_standdown(smart_account);
CREATE TABLE IF NOT EXISTS perp_standdown_closes (
 job_id TEXT NOT NULL, market_id INTEGER NOT NULL, tx_hash TEXT NOT NULL,
 PRIMARY KEY (job_id, tx_hash)
);
CREATE INDEX IF NOT EXISTS perp_standdown_closes_market ON perp_standdown_closes(job_id, market_id);
CREATE TABLE IF NOT EXISTS perp_live_checkpoint (
 tenant TEXT NOT NULL, smart_account TEXT NOT NULL, api_public_key TEXT NOT NULL,
 generation INTEGER NOT NULL, claimant TEXT NOT NULL, checkpoint TEXT,
 PRIMARY KEY (tenant, smart_account)
);
CREATE TABLE IF NOT EXISTS perps_grants (
 tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json JSONB NOT NULL,
 sealed_session_key TEXT NOT NULL, updated_at BIGINT NOT NULL
);
${PAGED_CHECKPOINT_SCHEMA}`;

export interface HostedStanddownJob {
 id: string; tenant: `0x${string}`; purpose?: GrantPurpose; smartAccount: `0x${string}`;
 apiPublicKey: `0x${string}`; apiKeyIndex: number; sealedKey: string | null;
 reason: "kill" | "expiry"; createdAtMs: number; expiresAtMs: number;
 generation: number; claimant: string | null; state: "pending" | "running" | "done" | "expired";
 checkpoint: string | null; resultJson: string | null; mirrored: boolean;
}

/** Postgres IF NOT EXISTS still races on catalog rows when services boot together. */
export async function createHostedTables(exec: (sql: string) => Promise<unknown>, schema: string): Promise<void> {
 for (let attempt = 0; ; attempt++) {
  try { await exec(schema); return; }
  catch (error) {
   const code = (error as { code?: string }).code;
   // Retry the idempotent DDL after the competing catalog transaction commits.
   // Do not swallow the error: the retry must prove the whole schema exists.
   if (attempt >= 3 || !["23505", "42P07", "42710"].includes(code ?? "")) throw error;
  }
 }
}
export async function initHostedStanddownSchema(exec: (sql: string) => Promise<unknown>): Promise<void> {
 await createHostedTables(exec, HOSTED_STANDDOWN_SCHEMA);
 try { await exec("ALTER TABLE perp_standdown ADD COLUMN purpose TEXT NOT NULL DEFAULT 'spot'"); }
 catch (error) {
  if ((error as { code?: string }).code !== "42701" && !/duplicate column|column .+ already exists/i.test(String((error as Error).message))) throw error;
 }
 await createHostedTables(exec, "CREATE INDEX IF NOT EXISTS perp_standdown_tenant_purpose ON perp_standdown(tenant, purpose, created_at_ms)");
}
function of(r: Record<string, unknown>): HostedStanddownJob {
 return { id: String(r.id), purpose: grantPurpose({ purpose: r.purpose }), tenant: String(r.tenant) as `0x${string}`, smartAccount: String(r.smart_account) as `0x${string}`,
 apiPublicKey: String(r.api_public_key) as `0x${string}`, apiKeyIndex: Number(r.api_key_index), sealedKey: r.sealed_key == null ? null : String(r.sealed_key),
 reason: r.reason as HostedStanddownJob["reason"], createdAtMs: Number(r.created_at_ms), expiresAtMs: Number(r.expires_at_ms), generation: Number(r.generation),
 claimant: r.claimant == null ? null : String(r.claimant), state: r.state as HostedStanddownJob["state"], checkpoint: r.checkpoint == null ? null : String(r.checkpoint),
 resultJson: r.result_json == null ? null : String(r.result_json), mirrored: Number(r.mirrored) === 1 };
}

/** DELETE and key retention commit together. A failed seal check rolls the deletion back. */
export async function revokeHostedGrant(db: Db, tenant: `0x${string}`, dek: Buffer, opts: {
 nowMs?: number; beforeSec?: number; reason?: "kill" | "expiry"; expiredOnly?: boolean; purpose?: GrantPurpose;
} = {}): Promise<"removed" | "absent" | "newer"> {
 const now = opts.nowMs ?? Date.now();
 const purpose = grantPurpose(opts);
 const table = purpose === "perps" ? "perps_grants" : "grants";
 return db.tx(async tx => {
  // The conditional DELETE locks the exact version being revoked; a concurrent newer put survives.
  const row = await tx.prepare(`DELETE FROM ${table} WHERE tenant = ?${opts.beforeSec === undefined ? "" : " AND updated_at <= ?"}${opts.expiredOnly ? " AND CAST(grant_json->>'expiresAt' AS BIGINT) <= ?" : ""} RETURNING grant_json`)
   .get(tenant.toLowerCase(), ...(opts.beforeSec === undefined ? [] : [opts.beforeSec]), ...(opts.expiredOnly ? [Math.floor(now / 1000)] : [])) as { grant_json: unknown } | undefined;
  if (!row) {
   const left = await tx.prepare(`SELECT tenant FROM ${table} WHERE tenant = ?`).get(tenant.toLowerCase());
   return left ? "newer" : "absent";
  }
  const grant = (typeof row.grant_json === "string" ? JSON.parse(row.grant_json) : row.grant_json) as StoredGrant;
  if (grantPurpose(grant) !== purpose) throw new Error("revoked grant purpose mismatch");
  const p = grantPerp(grant);
  if (grant.perp !== undefined && !p) throw new Error("cannot revoke malformed perps custody");
  if (p) {
   if (!p.apiKeySealed) throw new Error("cannot revoke perps without its sealed venue key");
   openPerpKey(p.apiKeySealed, { tenant, smartAccount: grant.smartAccount, apiPublicKey: p.apiPublicKey, apiKeyIndex: p.apiKeyIndex }, dek);
   const id = randomUUID();
   const live = await new HostedLiveCheckpointStore(tx, dek).latest(tenant, grant.smartAccount);
   const bound = { id, purpose, tenant: tenant.toLowerCase(), smartAccount: grant.smartAccount.toLowerCase(), generation: 1 } as HostedStanddownJob;
   const checkpoint = live?.checkpoint ? await writeCheckpointStream(tx, bound,
    transformFinancialStream(readCheckpointStream(tx, liveCheckpointBinding(live), live.checkpoint, dek), grant.smartAccount, { scope: "standdown" }), dek) : null;
   await tx.prepare(`INSERT INTO perp_standdown (id, tenant, purpose, smart_account, api_public_key, api_key_index, sealed_key, reason, created_at_ms, expires_at_ms, generation, checkpoint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(id, tenant.toLowerCase(), purpose, grant.smartAccount.toLowerCase(), p.apiPublicKey, p.apiKeyIndex,
     p.apiKeySealed, opts.reason ?? "kill", now, now + HOSTED_STANDDOWN_TTL_MS, checkpoint);
   // Signed venue bytes move into the bounded shutdown capability. The long-
   // lived financial book keeps identity/nonce/hash evidence, never replay authority.
   if (live?.checkpoint) await tx.prepare("UPDATE perp_live_checkpoint SET checkpoint = ? WHERE tenant = ? AND smart_account = ? AND generation = ?")
    .run(await writeCheckpointStream(tx, liveCheckpointBinding(live),
     transformFinancialStream(readCheckpointStream(tx, liveCheckpointBinding(live), live.checkpoint, dek), grant.smartAccount, { scope: "financial", stripReplay: true }), dek, live.checkpoint), live.tenant, live.smartAccount, live.generation);
  }
  return "removed";
 });
}

export interface HostedLiveCheckpoint {
 tenant: string; smartAccount: string; apiPublicKey: string; generation: number; claimant: string; checkpoint: string | null;
}
export function liveCheckpointBinding(row: HostedLiveCheckpoint): HostedStanddownJob {
 return { id: `live:${row.smartAccount.toLowerCase()}`, tenant: row.tenant.toLowerCase(), smartAccount: row.smartAccount.toLowerCase(), generation: row.generation } as HostedStanddownJob;
}
function liveOf(row: Record<string, unknown>): HostedLiveCheckpoint {
 return { tenant: String(row.tenant), smartAccount: String(row.smart_account), apiPublicKey: String(row.api_public_key), generation: Number(row.generation), claimant: String(row.claimant), checkpoint: row.checkpoint == null ? null : String(row.checkpoint) };
}
export class HostedLiveCheckpointStore {
 constructor(readonly db: Db, private dek: Buffer) {}
 async latest(tenant: string, account: string): Promise<HostedLiveCheckpoint | null> {
  const row = await this.db.prepare("SELECT * FROM perp_live_checkpoint WHERE tenant = ? AND smart_account = ?").get(tenant.toLowerCase(), account.toLowerCase());
  return row ? liveOf(row as Record<string, unknown>) : null;
 }
 /** Caller holds the tenant lease; old children lose their generation immediately. */
 async claim(tenant: string, account: string, pub: string, claimant: string): Promise<HostedLiveCheckpoint> {
  const row = await this.db.prepare(`INSERT INTO perp_live_checkpoint (tenant, smart_account, api_public_key, generation, claimant)
   VALUES (?, ?, ?, 1, ?) ON CONFLICT (tenant, smart_account) DO UPDATE SET generation = perp_live_checkpoint.generation + 1,
   api_public_key = excluded.api_public_key, claimant = excluded.claimant RETURNING *`).get(tenant.toLowerCase(), account.toLowerCase(), pub, claimant);
  return liveOf(row as Record<string, unknown>);
 }
 async restore(row: HostedLiveCheckpoint): Promise<Buffer | null> { return row.checkpoint ? readCheckpoint(this.db, liveCheckpointBinding(row), row.checkpoint, this.dek) : null; }
 loadStream(row: HostedLiveCheckpoint): AsyncIterable<Buffer> { return readCheckpointStream(this.db, liveCheckpointBinding(row), row.checkpoint, this.dek); }
 async fence(row: HostedLiveCheckpoint): Promise<boolean> {
  return !!await this.db.prepare(`SELECT c.tenant FROM perp_live_checkpoint c JOIN (SELECT tenant, grant_json FROM grants UNION ALL SELECT tenant, grant_json FROM perps_grants) g ON g.tenant = c.tenant
   WHERE c.tenant = ? AND c.smart_account = ? AND c.generation = ? AND c.claimant = ?
   AND lower(g.grant_json->>'smartAccount') = c.smart_account AND g.grant_json->'perp'->>'apiPublicKey' = c.api_public_key`)
   .get(row.tenant, row.smartAccount, row.generation, row.claimant);
 }
 async save(row: HostedLiveCheckpoint, bytes: Buffer): Promise<void> {
  return this.saveStream(row, [bytes]);
 }
 async saveStream(row: HostedLiveCheckpoint, chunks: Iterable<Buffer> | AsyncIterable<Buffer>): Promise<void> {
  await this.db.tx(async tx => {
  const current = await new HostedLiveCheckpointStore(tx, this.dek).latest(row.tenant, row.smartAccount);
  const prior = current?.checkpoint ? await inspectFinancialStream(readCheckpointStream(tx, liveCheckpointBinding(current), current.checkpoint, this.dek), row.smartAccount, { scope: "financial" }) : null;
  const sealed = await writeCheckpointStream(tx, liveCheckpointBinding(row), validateFinancialStream(chunks, row.smartAccount, { scope: "financial", priorJournalProof: prior?.journalProof }), this.dek, current?.checkpoint);
  const result = await tx.prepare(`UPDATE perp_live_checkpoint SET checkpoint = ? WHERE tenant = ? AND smart_account = ? AND generation = ? AND claimant = ?
   AND EXISTS (SELECT 1 FROM (SELECT tenant, grant_json FROM grants UNION ALL SELECT tenant, grant_json FROM perps_grants) g WHERE g.tenant = perp_live_checkpoint.tenant AND lower(g.grant_json->>'smartAccount') = perp_live_checkpoint.smart_account
    AND g.grant_json->'perp'->>'apiPublicKey' = perp_live_checkpoint.api_public_key)`)
   .run(sealed, row.tenant, row.smartAccount, row.generation, row.claimant);
  if (result.changes !== 1) throw new Error("live perps checkpoint was fenced");
  });
 }
 /** Parent's final stopped-child mirror, after atomic revocation but before any drainer starts. */
 async saveRetired(row: HostedLiveCheckpoint, bytes: Buffer): Promise<void> {
  return this.saveRetiredStream(row, [bytes]);
 }
 async saveRetiredStream(row: HostedLiveCheckpoint, chunks: Iterable<Buffer> | AsyncIterable<Buffer>): Promise<void> {
  await this.db.tx(async tx => {
   const found = await tx.prepare("SELECT * FROM perp_standdown WHERE tenant = ? AND smart_account = ? AND (state = 'pending' OR (state = 'expired' AND generation = 1)) AND mirrored = 0 ORDER BY created_at_ms DESC LIMIT 1").get(row.tenant, row.smartAccount);
   if (!found) throw new Error("retired financial checkpoint has no pending shutdown");
   const job = of(found as Record<string, unknown>);
   const current = await new HostedLiveCheckpointStore(tx, this.dek).latest(row.tenant, row.smartAccount);
   const prior = current?.checkpoint ? await inspectFinancialStream(readCheckpointStream(tx, liveCheckpointBinding(current), current.checkpoint, this.dek), row.smartAccount, { scope: "financial" }) : null;
   // An unpublished page set lets two bounded readers derive the narrow job
   // and retired ordinary book without duplicating the full history in RAM.
   const staged = await writeCheckpointStream(tx, liveCheckpointBinding(row), validateFinancialStream(chunks, row.smartAccount, { scope: "financial", priorJournalProof: prior?.journalProof }), this.dek);
   const changed = await tx.prepare("UPDATE perp_live_checkpoint SET checkpoint = ? WHERE tenant = ? AND smart_account = ? AND generation = ? AND claimant = ?")
    .run(await writeCheckpointStream(tx, liveCheckpointBinding(row),
     transformFinancialStream(readCheckpointStream(tx, liveCheckpointBinding(row), staged, this.dek), row.smartAccount, { scope: "financial", stripReplay: true }), this.dek, current?.checkpoint), row.tenant, row.smartAccount, row.generation, row.claimant);
   if (changed.changes !== 1) throw new Error("retired financial checkpoint generation changed");
   const checkpoint = await writeCheckpointStream(tx, job,
    transformFinancialStream(readCheckpointStream(tx, liveCheckpointBinding(row), staged, this.dek), row.smartAccount, { scope: "standdown", stripReplay: job.state === "expired" }), this.dek, job.checkpoint);
   const copied = await tx.prepare("UPDATE perp_standdown SET checkpoint = ? WHERE id = ? AND generation = ? AND state = ?")
    .run(checkpoint, job.id, job.generation, job.state);
   if (copied.changes !== 1) throw new Error("retired shutdown checkpoint generation changed");
   await deletePagedCheckpoint(tx, liveCheckpointBinding(row), staged, this.dek);
  });
 }
}

export class HostedStanddownStore {
 constructor(readonly db: Db, private dek: Buffer) {}
 async init(): Promise<void> {
  await initHostedStanddownSchema(sql => this.db.exec(sql));
 }
 async list(): Promise<HostedStanddownJob[]> {
  return (await this.db.prepare("SELECT * FROM perp_standdown WHERE mirrored = 0 OR state IN ('pending', 'running') ORDER BY created_at_ms").all()).map(r => of(r as Record<string, unknown>));
 }
 async latest(tenant: string, purpose: GrantPurpose = "spot"): Promise<HostedStanddownJob | null> {
  if (!isGrantPurpose(purpose)) throw new Error("Unrecognised agent account purpose");
  const r = await this.db.prepare("SELECT * FROM perp_standdown WHERE tenant = ? AND purpose = ? ORDER BY created_at_ms DESC LIMIT 1").get(tenant.toLowerCase(), purpose);
  return r ? of(r as Record<string, unknown>) : null;
 }
 async blocked(tenant: string, account: string, purpose: GrantPurpose = "spot"): Promise<boolean> {
  if (!isGrantPurpose(purpose)) throw new Error("Unrecognised agent account purpose");
  return !!await this.db.prepare("SELECT id FROM perp_standdown WHERE ((tenant = ? AND purpose = ?) OR smart_account = ?) AND (mirrored = 0 OR state IN ('pending', 'running')) LIMIT 1")
   .get(tenant.toLowerCase(), purpose, account.toLowerCase());
 }
 /** Caller MUST already hold the same healthy tenant lease used by normal children. */
 async claim(id: string, claimant: string, now = Date.now()): Promise<HostedStanddownJob | null> {
  const r = await this.db.prepare(`UPDATE perp_standdown SET claimant = ?, generation = generation + 1, state = 'running'
   WHERE id = ? AND state IN ('pending', 'running') AND expires_at_ms > ? AND sealed_key IS NOT NULL RETURNING *`).get(claimant, id, now);
  return r ? of(r as Record<string, unknown>) : null;
 }
 async fence(job: HostedStanddownJob, now = Date.now()): Promise<boolean> {
  return !!await this.db.prepare(`SELECT id FROM perp_standdown WHERE id = ? AND tenant = ? AND smart_account = ? AND generation = ? AND claimant = ?
   AND state = 'running' AND expires_at_ms > ? AND sealed_key IS NOT NULL`).get(job.id, job.tenant, job.smartAccount, job.generation, job.claimant, now);
 }
 /** Advisory pre-sign check; reserveClose remains the atomic final send gate. */
 async remainingCloseAttempts(job: HostedStanddownJob, marketId: number, now = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(marketId) || marketId < 0 || marketId > 65535) throw new Error("shutdown close market refused");
  const row = await this.db.prepare(`SELECT (SELECT COUNT(*) FROM perp_standdown_closes c WHERE c.job_id = s.id AND c.market_id = ?) AS used
   FROM perp_standdown s WHERE s.id = ? AND s.tenant = ? AND s.smart_account = ? AND s.generation = ? AND s.claimant = ?
   AND s.state = 'running' AND s.expires_at_ms > ? AND s.sealed_key IS NOT NULL`)
   .get(marketId, job.id, job.tenant, job.smartAccount, job.generation, job.claimant, now) as { used: number } | undefined;
  if (!row) throw new Error("shutdown close capacity fenced");
  return Math.max(0, 3 - Number(row.used));
 }
 /** One job-wide budget. Exact-byte replays retain their original attempt. */
 async reserveClose(job: HostedStanddownJob, close: { marketId: number; txHash: string }, now?: number): Promise<boolean> {
  if (!Number.isSafeInteger(close.marketId) || close.marketId < 0 || typeof close.txHash !== "string" || !close.txHash.length || close.txHash.length > 256) return false;
  const clock = () => now ?? Date.now();
  return this.db.tx(async tx => {
   // The harmless UPDATE locks this job on Postgres, serializing concurrent
   // claim/replay/budget requests without sharing authority across generations.
   const row = await tx.prepare(`UPDATE perp_standdown SET claimant = claimant
    WHERE id = ? AND tenant = ? AND smart_account = ? AND generation = ? AND claimant = ?
     AND state = 'running' AND expires_at_ms > ? AND sealed_key IS NOT NULL RETURNING *`)
    .get(job.id, job.tenant, job.smartAccount, job.generation, job.claimant, clock());
   if (!row) return false;
   const current = of(row as Record<string, unknown>);
   const held = await tx.prepare("SELECT market_id FROM perp_standdown_closes WHERE job_id = ? AND tx_hash = ?").get(job.id, close.txHash) as { market_id: number } | undefined;
   if (held && Number(held.market_id) !== close.marketId) return false;
   const count = await tx.prepare("SELECT COUNT(*) AS n FROM perp_standdown_closes WHERE job_id = ? AND market_id = ?").get(job.id, close.marketId) as { n: number };
   if ((!held && Number(count.n) >= 3) || !current.checkpoint) return false;
   let recorded = false;
   await inspectFinancialStream(readCheckpointStream(tx, current, current.checkpoint, this.dek), current.smartAccount, { scope: "standdown", onRow(table, value) {
    if (table === "perp_orders" && value.tx_hash === close.txHash && value.market_id === close.marketId && value.tx_type === 14 && value.reduce_only === 1 && value.api_key_index === current.apiKeyIndex && ["close", "reduce"].includes(String(value.effect)) && typeof value.tx_info === "string" && value.tx_info.length > 0) recorded = true;
   } });
   if (!recorded || clock() >= current.expiresAtMs) return false;
   if (held) return true;
   await tx.prepare("INSERT INTO perp_standdown_closes (job_id, market_id, tx_hash) VALUES (?, ?, ?)").run(job.id, close.marketId, close.txHash);
   return true;
  });
 }
 async checkpoint(job: HostedStanddownJob, bytes: Buffer, now?: number): Promise<void> {
  if (!bytes.length) throw new Error("stand-down checkpoint size refused");
  return this.checkpointStream(job, [bytes], now);
 }
 async checkpointStream(job: HostedStanddownJob, chunks: Iterable<Buffer> | AsyncIterable<Buffer>, now?: number): Promise<void> {
  await this.db.tx(async tx => {
  const current = await tx.prepare("SELECT checkpoint FROM perp_standdown WHERE id = ?").get(job.id) as { checkpoint: string | null } | undefined;
  const prior = current?.checkpoint ? await inspectFinancialStream(readCheckpointStream(tx, job, current.checkpoint, this.dek), job.smartAccount, { scope: "standdown" }) : null;
  const sealed = await writeCheckpointStream(tx, job, validateFinancialStream(chunks, job.smartAccount, { scope: "standdown", priorJournalProof: prior?.journalProof }), this.dek, current?.checkpoint);
  const r = await tx.prepare(`UPDATE perp_standdown SET checkpoint = ? WHERE id = ? AND tenant = ? AND smart_account = ? AND generation = ? AND claimant = ?
   AND state = 'running' AND expires_at_ms > ? AND sealed_key IS NOT NULL`).run(sealed, job.id, job.tenant, job.smartAccount, job.generation, job.claimant, now ?? Date.now());
  if (r.changes !== 1) throw new Error("stand-down lease or deadline no longer permits a checkpoint");
  });
 }
 /** Checkpoints bind the original generation in their envelope; reclaim cannot change their meaning. */
 async restore(job: HostedStanddownJob): Promise<Buffer | null> { return job.checkpoint ? readCheckpoint(this.db, job, job.checkpoint, this.dek) : null; }
 loadStream(job: HostedStanddownJob): AsyncIterable<Buffer> { return readCheckpointStream(this.db, job, job.checkpoint, this.dek); }
 async finish(job: HostedStanddownJob, resultJson: string): Promise<boolean> {
  // Only a whitelisted runner result belongs here; never an exception, key or arbitrary child payload.
  return this.db.tx(async tx => {
   const row = await tx.prepare(`UPDATE perp_standdown SET state = 'done', sealed_key = NULL, result_json = ?
    WHERE id = ? AND generation = ? AND claimant = ? AND state = 'running' RETURNING *`).get(resultJson, job.id, job.generation, job.claimant);
   if (!row) return false;
   await this.retireCheckpoint(tx, of(row as Record<string, unknown>));
   return true;
  });
 }
 async expire(now = Date.now()): Promise<void> {
  await this.db.tx(async tx => {
   const rows = await tx.prepare(`UPDATE perp_standdown SET state = 'expired', sealed_key = NULL, result_json = COALESCE(result_json, ?)
    WHERE expires_at_ms <= ? AND state IN ('pending', 'running') RETURNING *`).all(JSON.stringify({ outcome: "unreachable", ingested: false, reason: "The shutdown deadline passed; Lighter custody is unknown. Resting stops were not deliberately removed from open positions." }), now);
   for (const row of rows) await this.retireCheckpoint(tx, of(row as Record<string, unknown>));
  });
 }
 private async retireCheckpoint(tx: Db, job: HostedStanddownJob): Promise<void> {
  if (!job.checkpoint) return;
  let sealed: string | null = null;
  await tx.exec("SAVEPOINT perp_retire_checkpoint");
  try { sealed = await writeCheckpointStream(tx, job,
   transformFinancialStream(readCheckpointStream(tx, job, job.checkpoint, this.dek), job.smartAccount, { scope: "standdown", stripReplay: true }), this.dek, job.checkpoint);
   await tx.exec("RELEASE SAVEPOINT perp_retire_checkpoint");
  }
  catch {
   // A late validation failure may already have staged pages. Roll those back
   // without rolling back the expiry's destruction of the sealed venue key.
   await tx.exec("ROLLBACK TO SAVEPOINT perp_retire_checkpoint");
   await tx.exec("RELEASE SAVEPOINT perp_retire_checkpoint");
   if (isPagedCheckpoint(job.checkpoint)) {
    try { await deletePagedCheckpoint(tx, job, job.checkpoint, this.dek); }
    catch { /* An unauthenticated ownership tag cannot authorize deleting somebody else's pages. */ }
   }
   await tx.prepare("UPDATE perp_standdown SET result_json = ? WHERE id = ? AND generation = ?")
    .run(JSON.stringify({ outcome: "unreachable", ingested: false, reason: "The shutdown recovery record could not be verified; Lighter custody remains unknown." }), job.id, job.generation);
  }
  await tx.prepare("UPDATE perp_standdown SET checkpoint = ? WHERE id = ? AND generation = ? AND state IN ('done', 'expired')")
   .run(sealed, job.id, job.generation);
 }
 async mirrored(job: HostedStanddownJob): Promise<void> {
  await this.db.tx(async tx => {
   const row = await tx.prepare("SELECT * FROM perp_standdown WHERE id = ? AND generation = ? AND state IN ('done', 'expired')").get(job.id, job.generation);
   if (!row) throw new Error("shutdown completion generation changed");
   const current = of(row as Record<string, unknown>);
   const liveStore = new HostedLiveCheckpointStore(tx, this.dek);
   const live = await liveStore.latest(job.tenant, job.smartAccount);
   if (current.checkpoint && live?.checkpoint) {
    const merged = mergeFinancialStreams(readCheckpointStream(tx, liveCheckpointBinding(live), live.checkpoint, this.dek), readCheckpointStream(tx, current, current.checkpoint, this.dek), job.smartAccount);
    await tx.prepare("UPDATE perp_live_checkpoint SET checkpoint = ? WHERE tenant = ? AND smart_account = ? AND generation = ?")
     .run(await writeCheckpointStream(tx, liveCheckpointBinding(live), merged, this.dek, live.checkpoint), live.tenant, live.smartAccount, live.generation);
   }
   if (current.checkpoint && isPagedCheckpoint(current.checkpoint)) await deletePagedCheckpoint(tx, current, current.checkpoint, this.dek);
   await tx.prepare("UPDATE perp_standdown SET mirrored = 1, checkpoint = NULL WHERE id = ? AND generation = ?").run(job.id, job.generation);
  });
 }
}

async function readCheckpoint(db: Db, job: HostedStanddownJob, pointer: string, dek: Buffer): Promise<Buffer> {
 return isPagedCheckpoint(pointer) ? loadPagedCheckpoint(db, job, pointer, dek) : openCheckpoint(job, pointer, dek);
}
async function* readCheckpointStream(db: Db, job: HostedStanddownJob, pointer: string | null, dek: Buffer): AsyncGenerator<Buffer> {
 if (!pointer) return;
 if (isPagedCheckpoint(pointer)) yield* readPagedCheckpoint(db, job, pointer, dek);
 else yield openCheckpoint(job, pointer, dek);
}
async function writeCheckpointStream(db: Db, job: HostedStanddownJob, chunks: Iterable<Buffer> | AsyncIterable<Buffer>, dek: Buffer, previous?: string | null): Promise<string> {
 const pointer = await savePagedCheckpointStream(db, job, chunks, dek);
 if (previous && isPagedCheckpoint(previous)) await deletePagedCheckpoint(db, job, previous, dek);
 return pointer;
}

function aad(job: Pick<HostedStanddownJob, "id" | "tenant" | "smartAccount">, generation: number): Buffer {
 return Buffer.from(`perp-standdown-checkpoint-v1|${job.id}|${job.tenant.toLowerCase()}|${job.smartAccount.toLowerCase()}|${generation}`);
}
export function sealCheckpoint(job: HostedStanddownJob, bytes: Buffer, dek: Buffer): string {
 const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", dek, iv); c.setAAD(aad(job, job.generation));
 const enc = Buffer.concat([c.update(bytes), c.final()]);
 return ["ps1", job.generation, iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}
export function openCheckpoint(job: HostedStanddownJob, sealed: string, dek: Buffer): Buffer {
 try {
  const [v, g, iv, tag, ct, extra] = sealed.split("."); const gen = Number(g);
  if (v !== "ps1" || extra !== undefined || !Number.isSafeInteger(gen) || gen < 1 || gen > job.generation || !ct || ct.length > STANDDOWN_CHECKPOINT_MAX * 1.4) throw new Error();
  const d = createDecipheriv("aes-256-gcm", dek, Buffer.from(iv!, "base64url")); d.setAAD(aad(job, gen)); d.setAuthTag(Buffer.from(tag!, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
 } catch { throw new Error("stand-down checkpoint binding or authentication failed"); }
}
