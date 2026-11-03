/** Login pause/resume for the Perps-only Telegram seat, under the parent's owner lease. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db";
import { fsyncDirSync, writeFileAtomicSync } from "../atomic-write";
import { PAUSED_FILE } from "../recovery-reply-arm";
import { clearDurablePause, ensureTelegramSchema, readDurablePause, recordDurablePause } from "../telegram-store";
import { parsePerpsBotRequest, type PerpsBotRequest } from "./telegram-bridge";

const SCHEMA = `CREATE TABLE IF NOT EXISTS perps_telegram_control_receipts (
  tenant TEXT NOT NULL, request_id TEXT NOT NULL, bot_id TEXT NOT NULL, update_id BIGINT NOT NULL,
  smart_account TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pause','resume')),
  asked_at_sec BIGINT NOT NULL, applied_at_ms BIGINT NOT NULL, marker_fingerprint TEXT,
  PRIMARY KEY (tenant, request_id)
);
CREATE INDEX IF NOT EXISTS perps_telegram_control_bot_order
  ON perps_telegram_control_receipts (tenant, bot_id, update_id);
CREATE TABLE IF NOT EXISTS perps_telegram_control_state (
  tenant TEXT PRIMARY KEY, request_id TEXT, bot_id TEXT, asked_at_sec BIGINT
)`;

export interface PerpsBotControlOptions {
  db: Db;
  tenant: string;
  /** The login owner's home, never a path chosen by the Telegram request. */
  home: string;
  /** Account binding and bot ownership have already been checked by the parent. */
  request: PerpsBotRequest;
  mayWrite: () => boolean;
  /** Fixed test clock; production callers omit this so awaited work still ages requests. */
  nowMs?: number;
}

interface Receipt {
  request_id: string;
  smart_account: string;
  kind: "pause" | "resume";
  asked_at_sec: number | string;
  marker_fingerprint: string | null;
}

const ready = new WeakSet<Db>();
const queues = new WeakMap<Db, Map<string, Promise<unknown>>>();
const lost = () => new Error("The Perps owner-control writer lost its lease.");
const REFUSED = "The pause or resume request is stale or could not be identified. Nothing was changed; ask again if needed.";
const PAUSED = "Your login is paused. Paper entries are paused; existing Perps stops can still close positions.";
const RESUMED = "Your login pause is lifted. The Perps entry switch and Close all halt are unchanged.";

function storedInteger(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value))) throw new Error("The owner-control history is unreadable.");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("The owner-control history is unreadable.");
  return n;
}

/** Serializes the file operation after COMMIT with the next control in this process. */
async function inOrder<T>(db: Db, tenant: string, run: () => Promise<T>): Promise<T> {
  let owners = queues.get(db);
  if (!owners) { owners = new Map(); queues.set(db, owners); }
  const previous = owners.get(tenant) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  owners.set(tenant, next);
  try { return await next; }
  finally { if (owners.get(tenant) === next) owners.delete(tenant); }
}

/** A later writer's identical text is still a new pause, and must not be unlinked. */
function markerFingerprint(file: string): string | null {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.size > 4096n) throw new Error("The login pause marker is unreadable.");
    return createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"))
      .update(readFileSync(file)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function finishResume(o: PerpsBotControlOptions, tenant: string, receipt: Receipt): Promise<string> {
  const latest = await o.db.prepare("SELECT request_id FROM perps_telegram_control_state WHERE tenant = ?").get(tenant) as { request_id: string } | undefined;
  if (latest?.request_id !== receipt.request_id) return "This request was already recorded. A later owner control stands; nothing was changed.";
  if (await readDurablePause(o.db, tenant) !== null) return "Another login pause is standing. Nothing was resumed; ask again if you want to lift it.";
  if (!o.mayWrite()) throw lost();
  if (!parsePerpsBotRequest(o.request, o.nowMs ?? Date.now())) return REFUSED;
  const file = path.join(o.home, PAUSED_FILE);
  const current = markerFingerprint(file);
  if (current !== null && current !== receipt.marker_fingerprint) {
    return "Another login pause is standing. Nothing was resumed; ask again if you want to lift it.";
  }
  // No await between the last lease/marker checks and unlink. The parent owns
  // this home under its tenant lease. A later pause has a different fingerprint.
  if (current !== null) unlinkSync(file);
  fsyncDirSync(o.home);
  return RESUMED;
}

/**
 * A pause writes its marker before the receipt commits. A resume commits its
 * receipt and conditional durable-pause clear before unlinking that exact
 * marker. Crashes can leave an extra pause; they cannot replay an old resume
 * over a later one. No grant, Perps setting, or paper halt is changed here.
 */
export async function applyPerpsBotControl(o: PerpsBotControlOptions): Promise<string> {
  const tenant = o.tenant.toLowerCase(), r = { ...o.request }, nowMs = o.nowMs ?? Date.now();
  const key = /^tg-perps-([0-9]{1,20})-(0|[1-9][0-9]{0,15})$/.exec(r.requestId);
  const updateId = key ? Number(key[2]) : NaN;
  if (!/^0x[0-9a-f]{40}$/.test(tenant) || !parsePerpsBotRequest(r, nowMs)
      || (r.kind !== "pause" && r.kind !== "resume") || !key || !Number.isSafeInteger(updateId)) return REFUSED;
  const botId = key[1]!;
  const kind = r.kind;
  return inOrder(o.db, tenant, async () => {
    if (!o.mayWrite()) throw lost();
    if (!parsePerpsBotRequest(r, o.nowMs ?? Date.now())) return REFUSED;
    if (!ready.has(o.db)) {
      await ensureTelegramSchema(o.db);
      if (!o.mayWrite()) throw lost();
      await o.db.exec(SCHEMA);
      ready.add(o.db);
    }
    const receipt = await o.db.tx(async tx => {
      if (!o.mayWrite()) throw lost();
      await tx.prepare("INSERT INTO perps_telegram_control_state (tenant) VALUES (?) ON CONFLICT (tenant) DO NOTHING").run(tenant);
      // A real row lock on Postgres; SQLite's transaction serializes writers.
      await tx.prepare("UPDATE perps_telegram_control_state SET tenant = tenant WHERE tenant = ?").run(tenant);
      const prior = await tx.prepare("SELECT request_id, smart_account, kind, asked_at_sec, marker_fingerprint FROM perps_telegram_control_receipts WHERE tenant = ? AND request_id = ?")
        .get(tenant, r.requestId) as Receipt | undefined;
      if (prior) {
        if (prior.kind !== r.kind || prior.smart_account !== r.expectedAccount.toLowerCase() || storedInteger(prior.asked_at_sec) !== r.askedAtSec
            || (prior.marker_fingerprint !== null && !/^[a-f0-9]{64}$/.test(prior.marker_fingerprint))) return null;
        return { receipt: prior, fresh: false };
      }
      const cursor = await tx.prepare("SELECT MAX(update_id) AS last_update FROM perps_telegram_control_receipts WHERE tenant = ? AND bot_id = ?")
        .get(tenant, botId) as { last_update: number | string | null };
      if (cursor.last_update !== null && storedInteger(cursor.last_update) >= updateId) return null;
      const state = await tx.prepare("SELECT request_id, bot_id, asked_at_sec FROM perps_telegram_control_state WHERE tenant = ?")
        .get(tenant) as { request_id: string | null; bot_id: string | null; asked_at_sec: number | string | null };
      // Numeric order is per bot. Across a bot change, a same-second resume
      // has no reliable ordering proof, so it cannot lift the other bot's pause.
      if (state.asked_at_sec !== null && (storedInteger(state.asked_at_sec) > r.askedAtSec
          || (state.bot_id !== botId && storedInteger(state.asked_at_sec) === r.askedAtSec && r.kind === "resume"))) return null;
      const observedPause = await readDurablePause(tx, tenant);
      if (r.kind === "resume" && observedPause !== null && observedPause > r.askedAtSec) return null;
      const observedMarker = markerFingerprint(path.join(o.home, PAUSED_FILE));
      const marker = r.kind === "resume" ? observedMarker : null;
      if (!o.mayWrite()) throw lost();
      if (!parsePerpsBotRequest(r, o.nowMs ?? Date.now())) return null;
      if (r.kind === "pause") await recordDurablePause(tx, tenant, r.askedAtSec);
      else if (observedPause !== null) await clearDurablePause(tx, tenant, observedPause);
      await tx.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, ?, ?, ?)")
        .run(r.expectedAccount.toLowerCase(), r.kind === "pause" ? "warn" : "ok",
          `Telegram: ${r.kind === "pause" ? "paused" : "resumed"} by chat (Perps owner controls)`, Math.floor(nowMs / 1000));
      await tx.prepare(`INSERT INTO perps_telegram_control_receipts
        (tenant, request_id, bot_id, update_id, smart_account, kind, asked_at_sec, applied_at_ms, marker_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant, r.requestId, botId, updateId, r.expectedAccount.toLowerCase(), r.kind, r.askedAtSec, nowMs, marker);
      await tx.prepare("UPDATE perps_telegram_control_state SET request_id = ?, bot_id = ?, asked_at_sec = ? WHERE tenant = ?")
        .run(r.requestId, botId, r.askedAtSec, tenant);
      if (!o.mayWrite()) throw lost();
      if (!parsePerpsBotRequest(r, o.nowMs ?? Date.now())) throw new Error("The owner-control request expired before it could commit.");
      if (r.kind === "pause") {
        mkdirSync(o.home, { recursive: true, mode: 0o700 });
        writeFileAtomicSync(path.join(o.home, PAUSED_FILE), `paused by Perps owner control ${r.requestId}\n`, 0o600, { durable: true, followSymlinks: false });
      }
      return { receipt: { request_id: r.requestId, smart_account: r.expectedAccount.toLowerCase(), kind,
        asked_at_sec: r.askedAtSec, marker_fingerprint: marker } satisfies Receipt, fresh: true };
    });
    if (!receipt) return REFUSED;
    if (receipt.receipt.kind === "pause") return receipt.fresh ? PAUSED : "This pause request was already recorded. It was not applied again; any later owner control stands.";
    return finishResume({ ...o, request: r }, tenant, receipt.receipt);
  });
}
