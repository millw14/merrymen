/**
 * GIVE A REBUILT CHILD BACK TODAY'S ENERGY — OR SAY THAT IT COULD NOT.
 *
 * A redeploy empties a hosted child's sqlite, and with it `energy_days`: the
 * day's used reviews and new trades, the notice stamp, the last reading that
 * decided the level. The mirror carries those up to shared Postgres
 * (ledger-mirror.ts); this carries today's and yesterday's back down before
 * the child arms, merged by energy-days.ts's one statement — counters only
 * rise, the first stamp stands, the newer reading wins. The orchestrator opens
 * the two databases (seedEnergyForChild); everything that decides lives here,
 * where a test can run it (energy-seed.test.ts).
 *
 * A SEED THAT FAILED USED TO BE LOGGED AND FORGOTTEN. The child then armed
 * with an EMPTY energy_days and read it as "nothing used today", so a
 * low-energy agent got a fresh day's reviews and new trades from every
 * redeploy that met a shared-database or schema failure — repeat the outage,
 * repeat the allowance. Keeping the child unarmed would close that, and would
 * also stop its stop-losses, its take-profits and the owner's own orders,
 * which energy must never touch.
 *
 * SO A FAILED SEED LEAVES A MARKER in the child's home naming the days it
 * could not put back, and the child's store reads each of those days as
 * UNREADABLE (store.ts getEnergyDay → null). The plan already fails closed on
 * an unreadable day — only while enforcing, only for an agent that is not at
 * full energy, only on NEW work (energy.ts energyPlan and claimCap) — so a
 * full-energy agent, an observe or off fleet, and every exit run exactly as
 * they did. The orchestrator tries again on every reconcile pass while the
 * marker stands (retryEnergySeed) and on the next spawn. The marker goes only
 * AFTER every row is merged in: nothing the child counted meanwhile is lost
 * (the merge takes the larger of each counter), and no day reads as restored
 * before it is.
 *
 * A FILE, NOT A ROW. The failure being reported may be the child's own
 * sqlite. And the orchestrator already hands a child everything else it must
 * know before it arms as a file in its home (grant, settings, bootstrap, the
 * kill request); a redeploy that wipes the home wipes the marker together
 * with the ledger it described.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Db } from "./db";
import { ensureEnergyDays, mergeEnergyDayRow, readEnergyDaysSince } from "./energy-days";
import { planEnergySeed, utcDay } from "./energy";

/** In the child's home, beside merrymen.db. Present = some day's energy history was not put back. */
export const ENERGY_UNRESTORED_FILE = "energy-unrestored.json";

const markerIn = (home: string) => path.join(home, ENERGY_UNRESTORED_FILE);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The days a marker names, or null when it names nothing a reader can trust. */
function daysOf(text: string): string[] | null {
  try {
    const o = JSON.parse(text) as { days?: unknown };
    if (!Array.isArray(o?.days) || !o.days.every((d) => typeof d === "string" && DAY.test(d))) return null;
    return o.days as string[];
  } catch {
    return null;
  }
}

/** A marker stands in `home`: the orchestrator has a seed to retry. */
export function energyUnrestoredPending(home: string): boolean {
  try {
    readFileSync(markerIn(home));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

/**
 * Is `day` a day whose history was not put back into this home?
 *
 * FAILS CLOSED. A marker exists only because a seed failed, so one that cannot
 * be read or parsed covers EVERY day. Only a marker that is not there — or one
 * that names other days — says no. One read of a small file, at most twice a
 * tick.
 */
export function energyDayUnrestored(home: string, day: string): boolean {
  let text: string;
  try {
    text = readFileSync(markerIn(home), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
  const days = daysOf(text);
  return days === null || days.includes(day);
}

/**
 * Mark `days` unrestored, keeping any day an earlier marker already named: a
 * crash-restart whose seed fails again must not un-mark the day an earlier
 * failed seed could not put back. Written whole and renamed into place, so a
 * reader never sees half a file. Returns the days now marked.
 */
export function markEnergyUnrestored(home: string, days: readonly string[], atSec: number): string[] {
  let had: string[] = [];
  try {
    had = daysOf(readFileSync(markerIn(home), "utf8")) ?? [];
  } catch {
    /* no marker yet */
  }
  const all = [...new Set([...had, ...days])].sort();
  mkdirSync(home, { recursive: true });
  const tmp = `${markerIn(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, days: all, at: Math.floor(atSec) }), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, markerIn(home));
  return all;
}

/** The history is back: every day reads as what it is. */
export function clearEnergyUnrestored(home: string): void {
  rmSync(markerIn(home), { force: true });
}

export type EnergySeedResult =
  | { ok: true; restored: number }
  /** `marked`: the days the child now reads as unreadable; null when this attempt wrote no marker. */
  | { ok: false; why: string; marked: string[] | null };

/**
 * ONE SEED ATTEMPT, for one agent's child.
 *
 *   spawn — before the child arms. A failure marks today and yesterday (the
 *           days a seed carries), so the child starts with them unreadable.
 *   retry — a running child whose marker stands. A failure leaves the marker
 *           exactly as it is: every day since the spawn is the child's own
 *           and complete, so a later day is never added.
 *
 * Success merges every row, THEN clears the marker. Both databases are opened
 * through the thunks inside the try, so a child ledger that will not open is
 * a failed seed like any other, never a throw into spawnChild.
 */
export async function seedEnergyDays(i: {
  home: string;
  agent: string;
  nowSec: number;
  when: "spawn" | "retry";
  local: () => Db;
  shared: () => Promise<Db>;
}): Promise<EnergySeedResult> {
  const sinceDay = utcDay(i.nowSec - 86_400);
  try {
    const local = i.local();
    // With every column: a child's sqlite kept across a crash-restart, and the
    // shared table, can both predate the refund counter.
    await ensureEnergyDays(local);
    const shared = await i.shared();
    // The mirror creates this table on its first pass; a spawn can come first.
    await ensureEnergyDays(shared);
    const plan = planEnergySeed({
      shared: await readEnergyDaysSince(shared, i.agent, sinceDay),
      child: await readEnergyDaysSince(local, i.agent, sinceDay),
      sinceDay,
    });
    for (const row of plan) await mergeEnergyDayRow(local, i.agent, row);
    // ONLY NOW, with every row in, may the child read these days again.
    clearEnergyUnrestored(i.home);
    return { ok: true, restored: plan.length };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (i.when === "retry") return { ok: false, why, marked: null };
    try {
      return { ok: false, why, marked: markEnergyUnrestored(i.home, [sinceDay, utcDay(i.nowSec)], i.nowSec) };
    } catch (m) {
      return { ok: false, why: `${why}; the unrestored marker could not be written either (${m instanceof Error ? m.message : String(m)})`, marked: null };
    }
  }
}
