/**
 * The auto-convert latch — ONCE PER DEPOSIT, persisted across restarts.
 *
 * THE BUG THIS FIXES. `lastAutoConvertAt` used to live in worker memory, so
 * every terminal stop/start reset the hourly cooldown and the next tick
 * re-converted the SAME funds — the reserve left behind by the previous fire
 * always reads as fresh surplus. The latch moves that memory to disk
 * (~/.merrymen/auto-convert.json) and adds the missing half of the rule: not
 * just "an hour since the last fire" but "new money since the last fire".
 *
 * THE RULE. After a fire the worker records the balance it left behind
 * (`consideredWei`). A later tick may fire only when the balance EXCEEDS that
 * marker — i.e. a deposit (or any inbound transfer) arrived. Balance only ever
 * grows that way; gas spend and trades move it down, and a downward move
 * ratchets the marker down with it, so a spend-then-small-deposit still counts
 * as a deposit. The hourly cooldown stays as anti-flap: two deposits inside one
 * hour convert on the second hour's tick, not twice at once.
 *
 * MANUAL SWAPS share the latch: a manual fire sets the same marker and clock,
 * so auto-convert cannot re-eat a manual swap's leftover an hour later, and a
 * manual request does not bypass the grant, the reserve, or the wall.
 *
 * AT-MOST-ONCE for manual requests: completed `manualSwapId`s are recorded
 * (bounded list). A settings file resurrected by the orchestrator — or a
 * double-submitted form — replays an id the worker has already honoured, and
 * is ignored rather than re-spent. Gas spends once per instruction.
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface AutoConvertLatch {
  /** ms epoch of the last fire (auto or manual). 0 = never. */
  firedAtMs: number;
  /** Balance (wei, decimal string) left behind by the last fire — the high-water
   * mark of "already considered" funds. Only an excess over this may fire. */
  consideredWei: string;
  /** Manual request ids already honoured. Bounded; newest last. */
  completedSwapIds: string[];
}

export const AUTO_CONVERT_COOLDOWN_MS = 3_600_000;
const MAX_COMPLETED_IDS = 50;

export function emptyLatch(): AutoConvertLatch {
  return { firedAtMs: 0, consideredWei: "0", completedSwapIds: [] };
}

function toWei(s: string | undefined): bigint {
  try {
    if (typeof s !== "string" || !/^\d+$/.test(s)) return 0n;
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Read the latch; a missing or corrupt file is "never fired". */
export function loadLatch(path: string): AutoConvertLatch {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AutoConvertLatch>;
    const latch = emptyLatch();
    if (typeof raw.firedAtMs === "number" && Number.isFinite(raw.firedAtMs) && raw.firedAtMs >= 0) {
      latch.firedAtMs = Math.floor(raw.firedAtMs);
    }
    latch.consideredWei = toWei(raw.consideredWei).toString();
    if (Array.isArray(raw.completedSwapIds)) {
      latch.completedSwapIds = raw.completedSwapIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(-MAX_COMPLETED_IDS);
    }
    return latch;
  } catch {
    return emptyLatch();
  }
}

/** Persist the latch. Best-effort at the call site — a lost write only means
 * the next tick re-derives from the chain, never a double spend without a
 * deposit (the cooldown + marker both still gate). */
export function saveLatch(path: string, latch: AutoConvertLatch): void {
  writeFileSync(
    path,
    JSON.stringify({
      firedAtMs: latch.firedAtMs,
      consideredWei: toWei(latch.consideredWei).toString(),
      completedSwapIds: latch.completedSwapIds.slice(-MAX_COMPLETED_IDS),
    }),
    "utf8",
  );
}

/**
 * May this tick fire? Both halves must hold: new money (balance above the
 * marker) AND the cooldown elapsed. Pure — exported for tests.
 */
export function latchAllowsFire(
  latch: AutoConvertLatch,
  balanceWei: bigint,
  nowMs: number,
): boolean {
  if (balanceWei <= toWei(latch.consideredWei)) return false; // same funds — never again
  if (nowMs - latch.firedAtMs < AUTO_CONVERT_COOLDOWN_MS) return false; // too soon after the last fire
  return true;
}

/**
 * Ratchet the marker down when funds leave WITHOUT a fire (gas, trades, a
 * withdrawal made while the worker was stopped). Without this a spend
 * followed by a smaller deposit would sit forever under a stale-high marker.
 * Returns true when the caller should persist.
 */
export function ratchetMarkerDown(latch: AutoConvertLatch, balanceWei: bigint): boolean {
  if (balanceWei < toWei(latch.consideredWei)) {
    latch.consideredWei = balanceWei.toString();
    return true;
  }
  return false;
}

/** Record a fire: the clock restarts and the marker becomes what was left. */
export function recordFire(latch: AutoConvertLatch, nowMs: number, leftoverWei: bigint): void {
  latch.firedAtMs = nowMs;
  latch.consideredWei = leftoverWei.toString();
}

/** True when this manual request id was already honoured. */
export function swapIdCompleted(latch: AutoConvertLatch, id: string): boolean {
  return latch.completedSwapIds.includes(id);
}

/** Remember a honoured manual request id (bounded). */
export function recordSwapId(latch: AutoConvertLatch, id: string): void {
  if (!latch.completedSwapIds.includes(id)) {
    latch.completedSwapIds.push(id);
    latch.completedSwapIds = latch.completedSwapIds.slice(-MAX_COMPLETED_IDS);
  }
}

/**
 * Reserve + surplus arithmetic shared by auto-convert and manual swaps so the
 * two paths cannot disagree about what "gas kept" means.
 *
 * The owner's split (percent of balance) with a NON-configurable floor beneath
 * it: enough for one operating swap's gas at the live price. Sponsored gas
 * leaves the paymaster's deposit, not the account, so the floor is a small
 * drift margin; self-paid is ~2M gas deployed, ~5M for the undeployed fallback
 * (the deploy probe normally removes that case first). Pure — tested below.
 */
export function convertReserve(
  balanceWei: bigint,
  gasPrice: bigint,
  deployed: boolean,
  reservePct: number,
  sponsored: boolean,
): { reserve: bigint; surplus: bigint } {
  const pct = BigInt(Math.min(Math.max(Math.round(reservePct), 1), 50));
  const pctReserve = (balanceWei * pct) / 100n;
  const opFloor = sponsored ? gasPrice * 100_000n : gasPrice * (deployed ? 2_000_000n : 5_000_000n);
  const reserve = pctReserve > opFloor ? pctReserve : opFloor;
  return { reserve, surplus: balanceWei > reserve ? balanceWei - reserve : 0n };
}

export interface ManualSwapRequest {
  wei: bigint;
  id: string;
}

/**
 * Validate a manual-swap handoff (settings fields). Digits-only wei and a
 * tight id shape — anything else is ignored, never executed. Pure.
 */
export function parseManualSwap(s: {
  manualSwapWei?: unknown;
  manualSwapId?: unknown;
}): ManualSwapRequest | null {
  if (typeof s.manualSwapWei !== "string" || !/^\d{1,30}$/.test(s.manualSwapWei)) return null;
  if (typeof s.manualSwapId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(s.manualSwapId)) {
    return null;
  }
  const wei = BigInt(s.manualSwapWei); // safe: digits-only, bounded length
  if (wei <= 0n) return null;
  return { wei, id: s.manualSwapId };
}
