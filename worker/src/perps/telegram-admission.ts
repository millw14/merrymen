import { createHash } from "node:crypto";
import { grantPurpose, parsePerpsReport, type StoredGrant } from "../../../packages/core/src/index";
import type { Db } from "../db";
import { readFleetCommandRefusal, withFleetRecoveryLock } from "../fleet-recovery";
import { holdsSlot, orderExpiresAt, orderTtlMs } from "../order-window";
import { readPerpExitOrder } from "./owner-order";
import { parsePerpsBotRequest, type PerpsBotRequest } from "./telegram-bridge";
import type { TelegramPerpsSnapshot } from "../telegram/perps";

const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
function validGrant(grant: StoredGrant): boolean {
  try { return grantPurpose(grant) === "perps" && address(grant.smartAccount) && address(grant.owner) && Number.isSafeInteger(grant.chainId) && grant.chainId > 0; }
  catch { return false; }
}
function sameIdentity(row: { owner_address: unknown; chain_id: unknown }, grant: StoredGrant): boolean {
  return address(row.owner_address) && row.owner_address.toLowerCase() === grant.owner.toLowerCase() && Number(row.chain_id) === grant.chainId;
}

export async function readPerpsBotView(db: Db, grant: StoredGrant | null): Promise<TelegramPerpsSnapshot> {
  if (!grant) return { state: "absent" };
  if (!validGrant(grant)) return { state: "unread" };
  try {
    const rows = await db.prepare("SELECT owner_address, chain_id, perps FROM agents WHERE LOWER(smart_account) = ? LIMIT 2").all(grant.smartAccount.toLowerCase()) as Array<{ owner_address: unknown; chain_id: unknown; perps: unknown }>;
    if (rows.length > 1 || (rows[0] && !sameIdentity(rows[0], grant))) return { state: "unread" };
    let value = rows[0]?.perps;
    if (typeof value === "string") value = JSON.parse(value);
    const report = value == null ? null : parsePerpsReport(value);
    if (value != null && (!report || report.mode === "live" || report.accountIndex !== null)) return { state: "unread" };
    return { state: "ready", account: grant.smartAccount, grantExpiresAt: Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > 0 ? grant.expiresAt : null, report };
  } catch { return { state: "unread" }; }
}

/** Telegram shares the HTTP queue, per-account recovery lock, and one-in-flight rule. */
export async function queuePerpsBotExit(o: {
  db: Db; tenant: string; grant: StoredGrant; request: PerpsBotRequest;
  tickSeconds: number; nowMs: number; mayWrite: () => boolean;
}): Promise<string> {
  const { db, grant, request: r, nowMs } = o;
  if (!parsePerpsBotRequest(r, nowMs) || (r.kind !== "close" && r.kind !== "flatten") || !validGrant(grant)
      || !address(o.tenant) || grant.owner.toLowerCase() !== o.tenant.toLowerCase()
      || !Number.isFinite(o.tickSeconds) || o.tickSeconds <= 0
      || grant.smartAccount.toLowerCase() !== r.expectedAccount.toLowerCase()
      || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt * 1000 <= nowMs) return "The Perps permission changed or expired. Nothing was queued; reload the desk.";
  const read = readPerpExitOrder({ purpose: r.kind === "close" ? "close-perp" : "flatten-perps", side: "sell", symbol: r.kind === "close" ? r.market : "ALL-PERPS", usdgAmount: 0, book: "paper" });
  if (!read || "error" in read) return "That is not a paper Perps exit. Nothing was queued.";
  const id = createHash("sha256").update(JSON.stringify(["telegram-perps-v1", o.tenant.toLowerCase(), r.requestId])).digest("hex");
  const account = grant.smartAccount.toLowerCase();
  const expiresAt = r.askedAtSec * 1000 + orderTtlMs(o.tickSeconds);
  if (!Number.isSafeInteger(expiresAt) || nowMs > expiresAt) return "That exit request expired. Nothing was queued.";
  try {
    return await withFleetRecoveryLock(db, account, async locked => {
      if (!o.mayWrite()) return "The worker is handing over. Nothing was queued; check the desk.";
      if (await readFleetCommandRefusal(locked, account, r.askedAtSec * 1000)) return "The Perps book is held for recovery. Nothing was queued.";
      // Optional legacy table: read before BEGIN so a missing PG table cannot
      // poison the transaction used for queue admission.
      try {
        const health = await locked.prepare("SELECT blocked FROM paper_recovery_health WHERE LOWER(agent_id) = ?").get(account) as { blocked: unknown } | undefined;
        if (health) {
          if ((typeof health.blocked !== "number" && typeof health.blocked !== "string") || ![0, 1].includes(Number(health.blocked))) throw new Error("The Perps recovery health is unreadable.");
          if (Number(health.blocked) === 1) return "The Perps practice book is held. Nothing was queued.";
        }
      } catch (error) {
        const e = error as { code?: string; message?: string };
        if (e.code !== "42P01" && !/^no such table: (?:\w+\.)?paper_recovery_health$/i.test(e.message ?? "")) throw error;
      }
      return locked.tx(async tx => {
        const reports = await tx.prepare("SELECT mode, owner_address, chain_id FROM agents WHERE LOWER(smart_account) = ? LIMIT 2").all(account) as Array<{ mode: unknown; owner_address: unknown; chain_id: unknown }>;
        const reported = reports[0];
        if (reports.length !== 1 || !reported || !sameIdentity(reported, grant) || (reported.mode !== "paper" && reported.mode !== "idle")) return "The Perps practice book has not reported safely. Nothing was queued.";
        const prior = await tx.prepare("SELECT agent_id FROM agent_commands WHERE id = ?").get(id) as { agent_id: string } | undefined;
        if (prior) return prior.agent_id.toLowerCase() === account ? "This Perps request was already recorded. Check its result on the desk; it was not sent again." : "The request could not be identified safely. Nothing was queued.";
        const open = await tx.prepare("SELECT created_at, claimed_at, args FROM agent_commands WHERE agent_id = ? AND kind = 'trade' AND done_at IS NULL LIMIT 129").all(account) as Array<{ created_at: number; claimed_at: unknown; args: unknown }>;
        if (open.length > 128) return "The Perps queue could not be read safely. Nothing was queued; check the desk.";
        if (open.some(row => holdsSlot({ claimed: row.claimed_at != null, at: Number(row.created_at), expiresAt: orderExpiresAt(row.args) }, nowMs))) return "Another Perps order is still pending. Check its result before asking again.";
        if (!o.mayWrite()) return "The worker is handing over. Nothing was queued; check the desk.";
        await tx.prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)").run(id, account, JSON.stringify({ ...read.order, expiresAt }), r.askedAtSec * 1000);
        if (!o.mayWrite()) throw new Error("The Perps queue lost its writer before commit.");
        return "Your paper Perps exit was queued. This is not a fill; check the Perps desk for its result.";
      });
    });
  } catch { return "The Perps queue could not be reached. No execution was confirmed; check the desk before asking again."; }
}
