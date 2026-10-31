/** Local owner-DM reads and reduce-only exits, isolated from the Spot worker's ledger. */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { grantPurpose, type StoredGrant } from "../../../packages/core/src/index";
import { perpsCeilingOf } from "../../../packages/core/src/perps-ceiling";
import { fsyncDirSync } from "../atomic-write";
import { openCommands, writeCommand } from "../command-files";
import { wrapSqlite } from "../db";
import { readFleetCommandRefusal } from "../fleet-recovery";
import { merrymenHome } from "../home";
import { readLocalPerpsBinding } from "../local-perps-binding";
import { withLocalStateLock } from "../local-state-lock";
import { holdsSlot, orderTtlMs } from "../order-window";
import type { TelegramPerpsPort, TelegramPerpsSnapshot } from "../telegram/perps";
import { readPerpExitOrder } from "./owner-order";
import { readPerpsBotView } from "./telegram-admission";
import { parsePerpsBotRequest, readBoundedPerpsJson, readPerpsBotAuthority, type PerpsBotAuthority } from "./telegram-bridge";

export const LOCAL_PERPS_BOT_CLAIMS = "telegram-perps-requests.db";
const ADDRESS = /^0x[0-9a-f]{40}$/i;
function readGrant(home: string): StoredGrant | null {
  let value: unknown;
  try { value = readBoundedPerpsJson(path.join(home, "grant.json"), 256_000); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (readLocalPerpsBinding(home)) throw new Error("Perps permission replacement is pending.");
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Perps permission unreadable.");
  const g = value as StoredGrant;
  if (grantPurpose(g) !== "perps" || typeof g.smartAccount !== "string" || !ADDRESS.test(g.smartAccount)
      || typeof g.owner !== "string" || !ADDRESS.test(g.owner) || !Number.isSafeInteger(g.chainId) || g.chainId <= 0
      || !Number.isSafeInteger(g.expiresAt) || g.expiresAt <= 0) throw new Error("Perps permission unreadable.");
  return g;
}
function openBook(home: string): DatabaseSync {
  const file = path.join(home, "merrymen.db");
  if (!lstatSync(file).isFile()) throw new Error("Perps ledger unreadable.");
  return new DatabaseSync(file, { readOnly: true });
}
function tickSeconds(home: string): number {
  let cfg: unknown;
  try { cfg = readBoundedPerpsJson(path.join(home, "settings.json"), 256_000); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 60; throw error; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("Perps settings unreadable.");
  const tick = (cfg as { tickSeconds?: unknown }).tickSeconds;
  if (tick === undefined) return 60;
  if (typeof tick !== "number" || !Number.isFinite(tick) || tick <= 0) throw new Error("Perps cadence unreadable.");
  return tick;
}
const sameAuthority = (a: PerpsBotAuthority | null, b: PerpsBotAuthority): boolean => !!a
  && a.botId === b.botId && a.tokenTag === b.tokenTag && a.ownerId === b.ownerId && a.linkedAtSec === b.linkedAtSec;

/** Public claim commits BEFORE command publication: an interrupted write is never retried. */
function claimOnce(home: string, id: string, account: string, nowMs: number): boolean {
  const file = path.join(home, LOCAL_PERPS_BOT_CLAIMS);
  try { if (!lstatSync(file).isFile()) throw new Error("Perps request history unreadable."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const claims = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    fsyncDirSync(home);
    claims.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, account TEXT NOT NULL, created_at INTEGER NOT NULL)");
    const old = claims.prepare("SELECT account FROM requests WHERE id=?").get(id);
    if (old) return false;
    claims.prepare("INSERT INTO requests(id,account,created_at) VALUES(?,?,?)").run(id, account, nowMs);
    return true;
  } finally { claims.close(); }
}

/** `installHome` is the owner install, never the currently selected wallet's home. */
export function createLocalPerpsPort(installHome = merrymenHome()): TelegramPerpsPort {
  const home = path.join(installHome, "accounts", "perps");
  return {
    read: async (): Promise<TelegramPerpsSnapshot> => {
      try {
        return await withLocalStateLock(installHome, async () => {
          const grant = readGrant(home);
          if (!grant) return { state: "absent" };
          let raw: DatabaseSync;
          try { raw = openBook(home); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "ready", account: grant.smartAccount, grantExpiresAt: grant.expiresAt, report: null };
            throw error;
          }
          try { return await readPerpsBotView(wrapSqlite(raw), grant); }
          finally { raw.close(); }
        });
      } catch { return { state: "unread" }; }
    },
    exit: async input => {
      if (perpsCeilingOf(process.env.MERRYMEN_PERPS) !== "paper") return "Paper Perps is not running. Nothing was queued; check the desk.";
      const authority = readPerpsBotAuthority(installHome), nowMs = Date.now();
      const request = parsePerpsBotRequest({ kind: input.action, expectedAccount: input.expectedAccount, requestId: input.requestId,
        askedAtSec: input.askedAtSec, ...(input.market ? { market: input.market } : {}), ...(authority ? { authority } : {}) }, nowMs);
      if (!authority || !request || (request.kind !== "close" && request.kind !== "flatten")) return "The current Telegram owner request could not be verified. Nothing was queued; use the desk.";
      try {
        return await withLocalStateLock(installHome, async () => {
          if (!sameAuthority(readPerpsBotAuthority(installHome), authority)) return "The Telegram owner link changed. Nothing was queued; use the desk.";
          const grant = readGrant(home);
          if (!grant || grant.smartAccount.toLowerCase() !== request.expectedAccount.toLowerCase() || grant.expiresAt * 1000 <= Date.now()) return "The Perps permission changed or expired. Nothing was queued; reload the desk.";
          const read = readPerpExitOrder({ purpose: request.kind === "close" ? "close-perp" : "flatten-perps", side: "sell", symbol: request.kind === "close" ? request.market : "ALL-PERPS", usdgAmount: 0, book: "paper" });
          if (!read || "error" in read) return "That is not a paper Perps exit. Nothing was queued.";
          const expiresAt = request.askedAtSec * 1000 + orderTtlMs(tickSeconds(home));
          if (!Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) return "That Perps exit request expired. Nothing was queued.";
          const raw = openBook(home), account = grant.smartAccount.toLowerCase();
          try {
            const db = wrapSqlite(raw), snapshot = await readPerpsBotView(db, grant);
            if (snapshot.state !== "ready") return "The Perps practice book could not be identified safely. Nothing was queued.";
            const mode = raw.prepare("SELECT mode FROM agents WHERE LOWER(smart_account)=?").get(account)?.mode;
            if (mode !== "paper" && mode !== "idle") return "The Perps practice book has not reported safely. Nothing was queued.";
            if (await readFleetCommandRefusal(db, account, request.askedAtSec * 1000)) return "The Perps book is held for recovery. Nothing was queued.";
            const present = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_recovery_health'").get();
            if (present) {
              const health = raw.prepare("SELECT blocked FROM paper_recovery_health WHERE LOWER(agent_id)=?").get(account);
              if (health && health.blocked !== 0) return "The Perps practice book is held or unreadable. Nothing was queued.";
            }
          } finally { raw.close(); }
          const id = createHash("sha256").update(JSON.stringify(["telegram-perps-local-v1", request.requestId])).digest("hex");
          // The install lock is shared with HTTP Perps placement and grant writers.
          if (openCommands(home).filter(f => f.kind === undefined || f.kind === "trade").some(f => holdsSlot({ claimed: f.state === "running", at: f.at, expiresAt: f.expiresAt }, Date.now()))) return "Another Perps order is still pending. Check its result before asking again.";
          if (!sameAuthority(readPerpsBotAuthority(installHome), authority) || !parsePerpsBotRequest(request) || perpsCeilingOf(process.env.MERRYMEN_PERPS) !== "paper") return "The Telegram owner request changed or expired. Nothing was queued.";
          if (!claimOnce(home, id, account, nowMs)) return "This Perps request was already recorded. It was not sent again; check its result on the desk.";
          writeCommand(home, { id, kind: "trade", at: request.askedAtSec * 1000, account, expiresAt, args: read.order });
          return "Your paper Perps exit was queued. This is not a fill; check the Perps desk for its result.";
        });
      } catch { return "The Perps queue could not be reached. No execution was confirmed; check the desk before asking again."; }
    },
  };
}
