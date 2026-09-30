/** Retry infrastructure failures without treating a custody/accounting refusal as permission. */
import type { Db } from "../db";
export function transientHostedRecoveryError(error: unknown, depth = 0): boolean {
 if (!error || typeof error !== "object" || depth > 4) return false;
 const e = error as { code?: unknown; errcode?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
 const code = String(e.code ?? "");
 if (["HOSTED_MIRROR_BACKLOG", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "SQLITE_BUSY", "SQLITE_LOCKED", "40001", "40P01", "53300", "57014", "57P01", "57P02", "57P03"].includes(code) || /^08[0-9A-Z]{3}$/.test(code)) return true;
 // pg's pool/connect timeouts and socket-end errors do not always carry a code.
 if (error instanceof Error && ["Connection terminated unexpectedly", "Connection terminated", "Connection terminated due to connection timeout", "timeout exceeded when trying to connect"].includes(error.message)) return true;
 // node:sqlite exposes SQLITE_BUSY/LOCKED through errcode, not code.
 if (code === "ERR_SQLITE_ERROR" && [5, 6].includes(Number(e.errcode))) return true;
 if (e.cause && transientHostedRecoveryError(e.cause, depth + 1)) return true;
 return Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every(x => transientHostedRecoveryError(x, depth + 1));
}

type Retry = { account: string; attempts: number; nextAt: number };
export class HostedRecoveryRetries {
 private pending = new Map<string, Retry>();
 has(tenant: string): boolean { return this.pending.has(tenant); }
 retain(tenants: ReadonlySet<string>): void { for (const tenant of this.pending.keys()) if (!tenants.has(tenant)) this.clear(tenant); }
 fail(tenant: string, account: string, error: unknown, now = Date.now()): void {
  if (!transientHostedRecoveryError(error)) { this.clear(tenant); return; }
  const prior = this.pending.get(tenant);
  const attempts = prior?.account === account ? prior.attempts + 1 : 1;
  this.pending.set(tenant, { account, attempts, nextAt: now + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)) });
 }
 due(tenant: string, account: string, now = Date.now()): boolean {
  const retry = this.pending.get(tenant);
  if (retry && retry.account !== account) this.clear(tenant);
  return retry?.account === account && retry.nextAt <= now;
 }
 defer(tenant: string, now = Date.now()): void {
  const retry = this.pending.get(tenant);
  if (retry) retry.nextAt = now + Math.min(300_000, 30_000 * 2 ** Math.min(retry.attempts, 4));
 }
 clear(tenant: string): void { this.pending.delete(tenant); }
}

/** No restored capsule or replacement anchor touches a still-running ledger. */
export async function recoverHostedChild(o: {
 healthy(): boolean;
 probe(): Promise<void>;
 stop(): Promise<boolean>;
 mirror(): Promise<boolean>;
 restart(): Promise<void>;
}): Promise<boolean> {
 if (!o.healthy()) return false;
 await o.probe();
 if (!o.healthy() || !(await o.stop()) || !o.healthy()) return false;
 if (!(await o.mirror()) || !o.healthy()) return false;
 await o.restart();
 return true;
}

/** Preserve typed DB failures even when a mirror records its per-table error as prose. */
export function observeRecoveryDbErrors(db: Db, failed: (error: unknown) => void): Db {
 const observe = async <T>(run: () => Promise<T>): Promise<T> => { try { return await run(); } catch (error) { failed(error); throw error; } };
 return {
  prepare: sql => ({
   run: (...args) => observe(() => db.prepare(sql).run(...args)),
   get: (...args) => observe(() => db.prepare(sql).get(...args)),
   all: (...args) => observe(() => db.prepare(sql).all(...args)),
  }),
  exec: sql => observe(() => db.exec(sql)),
  tx: fn => observe(() => db.tx(tx => fn(observeRecoveryDbErrors(tx, failed)))),
 };
}

/** Mirror helpers share an already-pinned read transaction, including nested reads. */
export function recoverySnapshotView(snapshot: Db): Db {
 const view: Db = {
  prepare(sql) { if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) throw new Error("recovery mirror is read-only"); return snapshot.prepare(sql); },
  exec: async () => { throw new Error("recovery mirror is read-only"); },
  tx: fn => fn(view),
 };
 return view;
}
