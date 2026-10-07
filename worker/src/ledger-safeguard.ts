/** Final, operator-approved checkpoint of stopped homes through the EXISTING mirror. */
import { lstatSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant, openChildLedger, type MirrorReport } from "./ledger-mirror";
import { readMemoryRoster, type MemoryBackup } from "./memory-safeguard";
import { acquireTenantLease, type TenantLease } from "./tenant-lease";
import { ensureTgGroupsSchema, forgetStoredTgGroups, publishTgGroups } from "./tg-groups-ferry";
import { openSecret } from "./store-crypto";
import { parseTgGroupsState } from "./telegram/tg-groups/store";

const refuse = () => new Error("Final checkpoint refused; retain the old deployment and review source, lease, held book, pending operation or mirror failure.");
const silent = () => {};
function groupContent(tenant: string, sealed: string, dek: Buffer): string {
  const header = `tg-groups/v1 ${tenant}\n`, text = openSecret(sealed, dek);
  if (!text.startsWith(header)) throw refuse();
  const state = parseTgGroupsState(JSON.parse(text.slice(header.length)) as unknown);
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort) : x !== null && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : x;
  return JSON.stringify(sort(state));
}
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (e) { if ((e as { code?: unknown }).code === "ENOENT") return false; throw refuse(); }
}
/** Cold/rebuilt sources must be diagnosed BEFORE advancing any cursor. */
export async function assertLedgerSourceContinuity(child: Db, shared: Db, tenant: string): Promise<void> {
  for (const [table, stamp] of [["events", "created_at"], ["posts", "created_at"], ["trades", "created_at"],
    ["equity", "at"], ["flows", "at"], ["fee_accruals", "at"]] as const) {
    const mark = await shared.prepare("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = ?")
      .get(tenant, table) as { last_id?: unknown; last_stamp?: unknown } | undefined;
    if (!mark || String(mark.last_id) === "0") continue;
    if (!/^\d+$/.test(String(mark.last_id)) || !Number.isSafeInteger(Number(mark.last_id)) || mark.last_stamp === null || mark.last_stamp === undefined) throw refuse();
    const row = await child.prepare(`SELECT ${stamp} AS source_stamp FROM ${table} WHERE id = ?`).get(Number(mark.last_id)) as { source_stamp?: unknown } | undefined;
    if (!row || String(row.source_stamp) !== String(mark.last_stamp)) throw refuse();
  }
}

/**
 * No trade, sign, reset, new accounting anchor or raw database export. Successful
 * batches retain the mirror's transactional cursors and deduplication. Failure
 * can leave safe completed batches, but never reports a complete handover.
 */
export async function checkpointFleetLedger(o: {
  backup: MemoryBackup; childrenDir: string; shared: Db; dek: Buffer;
  assertSource: () => void | Promise<void>;
  accountingHolds?: ReadonlySet<string>;
  acquireLease?: (tenant: `0x${string}`) => Promise<TenantLease | null>;
  mirror?: typeof mirrorTenant;
}): Promise<{ checkpointed: number; homesWithoutLedger: number; passes: number; groupSnapshots: number }> {
  const b = o.backup;
  if (!b.source.quiescent || !b.source.singleReplicaConfirmed
      || Date.now() - b.capturedAtMs > 5 * 60_000 || b.capturedAtMs > Date.now() + 10_000) throw refuse();
  await o.assertSource();
  if (JSON.stringify(b.roster) !== JSON.stringify(await readMemoryRoster(o.shared))) throw refuse();
  const ready = [];
  // Validate ALL homes before any financial write, so a known held book cannot
  // be discovered only after unrelated checkpoint work has begun.
  for (const e of b.entries) {
    if (e.homeIno === null) continue; // No local book to lose. Durable rows were verified by the runner.
    const home = path.join(o.childrenDir, e.tenant), st = lstatSync(home, { bigint: true });
    if (!st.isDirectory() || String(st.dev) !== e.homeDev || String(st.ino) !== e.homeIno
        || o.accountingHolds?.has(e.tenant) || ["restore-blocked.json", "energy-unrestored.json", "telegram-held-groups.json", "ledger-source-blocked.json"]
          .some(file => present(path.join(home, file)))) throw refuse();
    const file = path.join(home, "merrymen.db");
    if (!present(file)) { ready.push({ e, home, file, identity: null }); continue; }
    const ds = lstatSync(file, { bigint: true });
    if (!ds.isFile()) throw refuse();
    const handle = openChildLedger(home);
    if (!handle) throw refuse();
    try {
      const agents = await handle.db.prepare("SELECT smart_account FROM agents").all() as Array<{ smart_account?: unknown }>;
      if (agents.length !== 1 || typeof agents[0]?.smart_account !== "string" || agents[0].smart_account.toLowerCase() !== e.smartAccount) throw refuse();
      // A process exit does not prove that the chain decided an already sent
      // operation. Refuse the handover until receipt reconciliation finishes.
      const pending = await handle.db.prepare("SELECT count(*) AS n FROM trades WHERE status IN ('submitted', 'sent', 'pending')").get() as { n?: unknown };
      if (Number(pending?.n) !== 0) throw refuse();
    } finally { handle.close(); }
    ready.push({ e, home, file, identity: { dev: String(ds.dev), ino: String(ds.ino), size: String(ds.size), mtime: String(ds.mtimeNs) } });
  }
  const result = { checkpointed: 0, homesWithoutLedger: 0, passes: 0, groupSnapshots: 0 };
  for (const item of ready) {
    const lease = await (o.acquireLease ?? acquireTenantLease)(item.e.tenant as `0x${string}`);
    if (!lease || lease.backend !== "postgres") throw refuse();
    let handle: ReturnType<typeof openChildLedger> = null;
    const gate = async () => {
      await o.assertSource();
      if (!lease.healthy() || JSON.stringify(b.roster) !== JSON.stringify(await readMemoryRoster(o.shared))) throw refuse();
      const home = lstatSync(item.home, { bigint: true });
      if (!home.isDirectory() || String(home.dev) !== item.e.homeDev || String(home.ino) !== item.e.homeIno) throw refuse();
      if (item.identity) {
        const st = lstatSync(item.file, { bigint: true });
        if (!st.isFile() || String(st.dev) !== item.identity.dev || String(st.ino) !== item.identity.ino
            || String(st.size) !== item.identity.size || String(st.mtimeNs) !== item.identity.mtime) throw refuse();
      }
    };
    try {
      await gate();
      await ensureTgGroupsSchema(o.shared, "postgres");
      const opts = { tenant: item.e.tenant, home: item.home, shared: o.shared, dek: o.dek, seen: new Map<string, string>(), log: silent };
      // Old main keeps failed-group-restore state only in process memory. A
      // held-style empty local file must never replace the protected row. Carry
      // privacy effects first, then require the captured state to agree with
      // durable state; uncertain changes need an ownership-aware handover.
      if (await forgetStoredTgGroups(opts) === "failed") throw refuse();
      await gate();
      const stored = await o.shared.prepare("SELECT sealed FROM tenant_tg_groups WHERE tenant = ?").get(item.e.tenant) as { sealed?: unknown } | undefined;
      if (stored && (typeof stored.sealed !== "string" || !item.e.groups
          || groupContent(item.e.tenant, stored.sealed, o.dek) !== groupContent(item.e.tenant, item.e.groups.sealed, o.dek))) throw refuse();
      if (item.identity) {
        handle = openChildLedger(item.home);
        if (!handle) throw refuse();
        await o.shared.exec(MIRROR_STATE_DDL);
        await assertLedgerSourceContinuity(handle.db, o.shared, item.e.tenant);
        let final: MirrorReport | undefined;
        for (let i = 0; i < 100; i++) {
          await gate();
          // The roster's account (checked against the book above), so an owner
          // operation is copied only under the account the backup names. One
          // that account and the tenant's grant cannot agree on is reported
          // failed (ledger-mirror.ts mirrorOwnerOperations), so it refuses
          // here rather than checkpointing a book whose record is not copied.
          final = await (o.mirror ?? mirrorTenant)({ tenant: item.e.tenant, child: handle.db, shared: o.shared, account: item.e.smartAccount });
          result.passes++;
          if (final.skipped || (final.failed && Object.keys(final.failed).length) || (final.restarted && Object.keys(final.restarted).length)) throw refuse();
          if (!final.hasMore) break;
        }
        if (!final || final.hasMore) throw refuse();
        await gate();
        const check = await (o.mirror ?? mirrorTenant)({ tenant: item.e.tenant, child: handle.db, shared: o.shared, account: item.e.smartAccount });
        result.passes++;
        if (check.hasMore || check.skipped || (check.failed && Object.keys(check.failed).length) || (check.restarted && Object.keys(check.restarted).length)) throw refuse();
        result.checkpointed++;
      } else result.homesWithoutLedger++;
      await gate();
      const published = await publishTgGroups(opts);
      if (published === "failed" || published === "too-big") throw refuse();
      if (published === "published") result.groupSnapshots++;
      await gate();
      if (await forgetStoredTgGroups(opts) === "failed") throw refuse();
      await gate();
    } finally { handle?.close(); await lease.release(); }
  }
  return result;
}
