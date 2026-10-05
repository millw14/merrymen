/**
 * CALL THE FLEET HOME ON SIGTERM: IN ORDER, INSIDE ONE BUDGET, AND SAY HOW IT WENT.
 *
 * The orchestrator's stop used to signal every child and hold process, release
 * every lease at once, and exit a second later. Releasing a lease is what
 * tells a mirror pass that it no longer owns its tenant — and a pass that
 * learns that between writing its pending-mirror marker and its ownership
 * check KEEPS the marker, on purpose (orchestrator.ts mirrorGuardedLedger): a
 * copy that may have been interrupted must never be certified. So an ordinary
 * redeploy that landed while the fifteen-second mirror was copying left
 * `ledger-source-blocked.json` in that tenant's home, and the next container
 * refused to arm the tenant until its accounting was recovered by hand. The
 * barrier was right. The stop was what made it fire.
 *
 * THE ORDER, and why each step is where it is:
 *
 *  1. STOP STARTING THINGS. `stopping` is set: no spawn, no restart, no new
 *     mirror pass, and the loops of a pass in hand stop at the next tenant.
 *     Who was running, and under which lease, is written down here, before
 *     anything is signalled — the maps empty as processes exit, and the final
 *     pass needs to know what each home WAS (step 6).
 *  2. THE beforeChildren HOOKS. Work beside the children that must stop before
 *     they do: a pass still feeding them, a sidecar answering the bots they are
 *     about to hand back. Each is said and skipped if it throws; together they
 *     have an allowance, and an overrun is waited for no longer.
 *  3. SETTLE. Every copy already started finishes WITH ITS LEASE STILL HELD —
 *     the whole point — and every spawn still preparing reaches its last check
 *     and refuses. Capped; once this step ends, no new copy may start except
 *     the drain's own final pass.
 *  4. CHILDREN AND HOLD PROCESSES: SIGTERM, then wait. No three-second SIGKILL:
 *     a worker answers SIGTERM by finishing the intent in hand and closing its
 *     store, and SIGKILL in the middle of that is the crash a drain exists to
 *     avoid. Only what is still running when the wait ends gets SIGKILL.
 *  5. TELEGRAM KILLS still pending in a home, AFTER the children: a child's
 *     last act may be writing one. Capped, as the old stop's was.
 *  6. THE FINAL PASS: each home that had a child or a hold process, copied one
 *     last time now that nothing writes it (orchestrator.ts drainFinalPass).
 *     A source batch at a time, until there is no more. A copy is started only
 *     with at least `finalPassMinMs` of the budget left: one cut off by the
 *     backstop below leaves the very barrier this module exists to avoid, so a
 *     copy that might not finish is not begun. The next owner's spawn copies
 *     what is left (finalMirrorBeforeAnchor), as after any crash.
 *  7. THE RECEIPT: `ops/last-shutdown.json`, 0600, counts only — no tenant, no
 *     address — so it can be published as it stands. The next start reads it
 *     and says whether this stop was clean (takePreviousShutdown).
 *  8. LEASES, LAST, and exit 0. Nothing above runs without its lease, so
 *     nothing above can be cut off by losing it.
 *
 * ONE BUDGET OVER ALL OF IT, MERRYMEN_DRAIN_BUDGET_MS (default 50s), set
 * inside the platform's draining time so this process, not the platform,
 * decides how the stop ends. Every step's cap is cut to what is left of it,
 * less a reserve for the receipt and the leases. And a BACKSTOP: when the
 * budget is spent with the drain still running, the receipt says where, and
 * the process exits 1. What was interrupted then is interrupted as a crash
 * interrupts it — under its barriers, which is what they are for.
 *
 * THIS MODULE IS THE SEQUENCE AND THE CLOCK. It knows nothing of tenants;
 * orchestrator.ts supplies every step (drainFleet there). So the order, the
 * caps and the receipt are tested here without a fleet (fleet-drain.test.ts),
 * and the real steps over the real orchestrator in
 * orchestrator-drain.integration.test.ts.
 */

import { mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

import { fsyncDirSync, writeFileAtomicSync } from "./atomic-write";

/** The whole drain, when MERRYMEN_DRAIN_BUDGET_MS does not say otherwise: inside a 75s platform drain. */
export const DRAIN_BUDGET_DEFAULT_MS = 50_000;
/** What MERRYMEN_DRAIN_BUDGET_MS may say. Less than a second drains nothing; more than ten minutes is a typo. */
const DRAIN_BUDGET_MIN_MS = 1_000;
const DRAIN_BUDGET_MAX_MS = 10 * 60_000;

/**
 * EACH STEP'S CAP. Every one is cut further to what the budget has left (less
 * `reserveMs`), so a small budget shrinks them and a large one never stretches
 * them. With the default budget the capped steps (5 + 10 + 20 + 1 + 3) leave
 * the final pass at least its `finalPassMinMs` and the reserve.
 */
export interface DrainLimits {
  /** Step 2, all the hooks together. */
  hooksMs: number;
  /** Step 3: copies already started, and spawns still preparing. */
  settleMs: number;
  /** Step 4: children and hold processes, after SIGTERM. */
  exitWaitMs: number;
  /** Step 4 again: the stragglers, after SIGKILL. */
  killGraceMs: number;
  /** Step 5. */
  pendingKillsMs: number;
  /** Step 6: no copy starts with less of the budget than this left. */
  finalPassMinMs: number;
  /** Kept back from every step for the receipt and the leases. */
  reserveMs: number;
  /** How often a wait looks again. */
  pollMs: number;
}

export const DRAIN_LIMITS: Readonly<DrainLimits> = Object.freeze({
  hooksMs: 5_000,
  settleMs: 10_000,
  exitWaitMs: 20_000,
  killGraceMs: 1_000,
  pendingKillsMs: 3_000,
  finalPassMinMs: 8_000,
  reserveMs: 2_000,
  pollMs: 50,
});

/** The steps a receipt reports, in the order they run. The receipt and the leases come after it is written. */
export type DrainStep = "hooks" | "settle" | "children" | "pending-kills" | "final-pass" | "late-settle";
export type DrainStepOutcome = "done" | "timeout" | "failed";

/**
 * What one home's final pass came to (orchestrator.ts drainFinalPass):
 * - saved: copied and its memory handled;
 * - more: another source batch is waiting — asked again while the budget allows;
 * - retained: refused or failed, its barrier kept for the next owner;
 * - skipped: not this process's to copy (lease gone, a process still running,
 *   a copy of its own still in flight).
 */
export type FinalPassOutcome = "saved" | "more" | "retained" | "skipped";

/** Run before any child is signalled (step 2). */
export interface DrainHook {
  name: string;
  run: () => void | Promise<void>;
}

/**
 * THE RECEIPT: what the next start reads, and what an operator checks after a
 * deploy. Counts and step names only, never a tenant: it is meant to be
 * publishable as it stands.
 */
export interface ShutdownReceipt {
  version: 1;
  /** The signal that started it: SIGTERM from the platform, SIGINT by hand. */
  signal: string;
  /** "budget-exceeded" when the backstop ended it. */
  outcome: "drained" | "budget-exceeded";
  /** Every step done in time, nothing SIGKILLed, every home copied, nothing in flight at release. */
  clean: boolean;
  /** Unix ms. */
  startedAt: number;
  finishedAt: number;
  budgetMs: number;
  /** The step the backstop found running, or null. */
  stalledAt: DrainStep | null;
  steps: { step: DrainStep; ms: number; outcome: DrainStepOutcome }[];
  /** Hooks that threw. */
  hooksFailed: number;
  /** Processes still running when their wait ended, and sent SIGKILL. */
  stragglers: number;
  finalPass: { homes: number; saved: number; retained: number; skipped: number; outOfTime: number };
  /** A copy or a spawn still running when the leases were released: its barrier stays, as after a crash. */
  inFlightAtRelease: boolean;
}

/**
 * EVERY STEP, SUPPLIED BY THE ORCHESTRATOR. `T` is whatever it records about a
 * home in `stop()` and hands back to `finalPass`; this module only counts them.
 */
export interface FleetDrainPlan<T> {
  signal: string;
  budgetMs: number;
  limits?: Partial<DrainLimits>;
  log: (line: string) => void;
  /** Step 1, synchronous: set stopping, wake whatever waits to start, and say what each home was. */
  stop: () => T[];
  /** Step 2. */
  beforeChildren: readonly DrainHook[];
  /** Step 3: nothing in flight — no copy, no spawn preparing, no mirror pass. */
  settled: () => boolean;
  /** After step 3: from here, only the final pass may start a copy. */
  closeCopies: () => void;
  /** Step 4: signal every child and hold process still running; how many were. */
  signalFleet: (signal: "SIGTERM" | "SIGKILL") => number;
  /** Step 4: no child or hold process is running. */
  fleetGone: () => boolean;
  /** Step 5. */
  honourPendingKills: () => Promise<void>;
  /** Step 6, one home, one source batch. */
  finalPass: (home: T) => Promise<FinalPassOutcome>;
  /** Step 7. */
  writeReceipt: (receipt: ShutdownReceipt) => void;
  /** Step 8. */
  releaseLeases: () => Promise<void>;
  exit: (code: number) => void;
}

/**
 * THE BUDGET MERRYMEN_DRAIN_BUDGET_MS ASKS FOR, or the default and a reason.
 * The value itself is never echoed: an operator reads the variable's name and
 * the rule, and the default is safe to drain with.
 */
export function drainBudgetMs(env: NodeJS.ProcessEnv = process.env): { ms: number; refused: string | null } {
  const raw = env.MERRYMEN_DRAIN_BUDGET_MS;
  if (raw === undefined || raw.trim() === "") return { ms: DRAIN_BUDGET_DEFAULT_MS, refused: null };
  const value = raw.trim();
  if (/^[1-9][0-9]{0,9}$/.test(value)) {
    const ms = Number(value);
    if (ms >= DRAIN_BUDGET_MIN_MS && ms <= DRAIN_BUDGET_MAX_MS) return { ms, refused: null };
  }
  return {
    ms: DRAIN_BUDGET_DEFAULT_MS,
    refused: `MERRYMEN_DRAIN_BUDGET_MS is not a whole number of milliseconds from ${DRAIN_BUDGET_MIN_MS} to ${DRAIN_BUDGET_MAX_MS} — draining within the default ${DRAIN_BUDGET_DEFAULT_MS}ms`,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether `pred` came true within `ms`, looking every `pollMs`. */
async function waitUntil(pred: () => boolean, ms: number, pollMs: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (!pred()) {
    const left = until - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(pollMs, left));
  }
  return true;
}

/** How `work` ended within `ms`: done, failed (it threw), or still running (timeout — and left to run). */
async function within(work: Promise<unknown>, ms: number): Promise<DrainStepOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DrainStepOutcome>((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  try {
    return await Promise.race([work.then((): DrainStepOutcome => "done", (): DrainStepOutcome => "failed"), late]);
  } finally {
    clearTimeout(timer);
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * RUN THE DRAIN, ONCE. The caller keeps the promise and hands it back to a
 * second signal (orchestrator.ts drainFleet): a drain is never started twice.
 * Resolves after `exit` has been called — in production it never returns.
 */
export async function runFleetDrain<T>(plan: FleetDrainPlan<T>): Promise<void> {
  const limits: DrainLimits = { ...DRAIN_LIMITS, ...plan.limits };
  const startedAt = Date.now();
  const end = startedAt + plan.budgetMs;
  const remaining = () => end - Date.now();
  /** A step's cap, cut to the budget left after the reserve. */
  const allow = (cap: number) => Math.max(0, Math.min(cap, remaining() - limits.reserveMs));
  const receipt: ShutdownReceipt = {
    version: 1, signal: plan.signal, outcome: "drained", clean: false, startedAt, finishedAt: startedAt,
    budgetMs: plan.budgetMs, stalledAt: null, steps: [], hooksFailed: 0, stragglers: 0,
    finalPass: { homes: 0, saved: 0, retained: 0, skipped: 0, outOfTime: 0 }, inFlightAtRelease: false,
  };
  let current: DrainStep | null = null;
  // Set by whichever ending comes first, the backstop's or the drain's own.
  // Every step asks before it starts, so after a backstop in a test (where
  // `exit` returns) nothing more is done and nothing is said twice.
  let finished = false;
  const writeReceipt = () => {
    receipt.finishedAt = Date.now();
    try {
      plan.writeReceipt(receipt);
    } catch (e) {
      plan.log(`[alert] shutdown receipt could not be written — ${e instanceof Error ? e.message : String(e)}; the next start will read this stop as unclean`);
    }
  };
  const backstop = setTimeout(() => {
    if (finished) return;
    finished = true;
    receipt.outcome = "budget-exceeded";
    receipt.clean = false;
    receipt.stalledAt = current;
    receipt.inFlightAtRelease = !plan.settled();
    plan.log(
      `[alert] drain budget of ${seconds(plan.budgetMs)} spent during ${current ?? "the receipt"} — exiting 1; ` +
        `anything interrupted keeps its recovery barrier, as after a crash`,
    );
    writeReceipt();
    plan.exit(1);
  }, plan.budgetMs);

  /** One step: timed, reported, and skipped once the drain has ended. */
  const step = async (name: DrainStep, run: () => Promise<DrainStepOutcome>): Promise<DrainStepOutcome | null> => {
    if (finished) return null;
    current = name;
    const t0 = Date.now();
    let outcome: DrainStepOutcome;
    try {
      outcome = await run();
    } catch (e) {
      plan.log(`[alert] drain step ${name} failed — ${e instanceof Error ? e.message : String(e)}; going on to the next`);
      outcome = "failed";
    }
    if (!finished) receipt.steps.push({ step: name, ms: Date.now() - t0, outcome });
    return outcome;
  };

  // 1. Synchronously, in the signal's own turn: nothing is started from here.
  plan.log(`stopping on ${plan.signal} — calling the whole fleet home (drain budget ${seconds(plan.budgetMs)})`);
  const homes = plan.stop();
  receipt.finalPass.homes = homes.length;

  // 2.
  await step("hooks", () => {
    const hooks = (async () => {
      for (const hook of plan.beforeChildren) {
        try {
          await hook.run();
        } catch (e) {
          receipt.hooksFailed += 1;
          plan.log(`[alert] drain hook ${hook.name} failed — ${e instanceof Error ? e.message : String(e)}; going on without it`);
        }
      }
    })();
    return within(hooks, allow(limits.hooksMs)).then((outcome) => {
      if (outcome === "timeout") plan.log(`[alert] drain hooks still running after ${seconds(allow(limits.hooksMs))} — no longer waited for`);
      return outcome === "done" && receipt.hooksFailed > 0 ? "failed" : outcome;
    });
  });

  // 3.
  await step("settle", async () => {
    const settled = await waitUntil(plan.settled, allow(limits.settleMs), limits.pollMs);
    if (!settled) plan.log("[alert] a copy or a spawn is still running after the settle wait — its home keeps its barrier, and no new copy starts");
    return settled ? "done" : "timeout";
  });
  plan.closeCopies();

  // 4.
  await step("children", async () => {
    const told = plan.signalFleet("SIGTERM");
    if (told) plan.log(`${told} process(es) sent SIGTERM — waiting up to ${seconds(allow(limits.exitWaitMs))} for them to finish`);
    if (await waitUntil(plan.fleetGone, allow(limits.exitWaitMs), limits.pollMs)) return "done";
    receipt.stragglers = plan.signalFleet("SIGKILL");
    plan.log(`[alert] ${receipt.stragglers} process(es) still running after SIGTERM — SIGKILL; their homes get no final pass`);
    await waitUntil(plan.fleetGone, allow(limits.killGraceMs), limits.pollMs);
    return "timeout";
  });

  // 5.
  await step("pending-kills", async () => {
    const outcome = await within(plan.honourPendingKills(), allow(limits.pendingKillsMs));
    if (outcome === "timeout") plan.log("[alert] pending Telegram kills not all carried out in time — the next start carries them out before arming");
    return outcome;
  });

  // 6.
  await step("final-pass", async () => {
    let failed = false;
    for (let i = 0; i < homes.length && !finished; i++) {
      for (;;) {
        if (remaining() < limits.finalPassMinMs) {
          receipt.finalPass.outOfTime = homes.length - i;
          plan.log(
            `[alert] ${receipt.finalPass.outOfTime} home(s) left without a final pass: under ${seconds(limits.finalPassMinMs)} of the drain budget remains, ` +
              `and a copy cut off by the backstop would block its tenant — the next owner's spawn copies them`,
          );
          return "timeout";
        }
        let outcome: FinalPassOutcome;
        try {
          outcome = await plan.finalPass(homes[i]!);
        } catch (e) {
          plan.log(`[alert] a final pass failed — ${e instanceof Error ? e.message : String(e)}; its barrier stays`);
          failed = true;
          outcome = "retained";
        }
        if (finished) return "timeout";
        if (outcome === "more") continue;
        receipt.finalPass[outcome] += 1;
        break;
      }
    }
    return failed ? "failed" : "done";
  });

  // Anything step 3 could not wait out has had the final pass's time since.
  // Given what is left of the budget, not a cap of its own: a lease released
  // under a copy still running is the barrier this module exists to avoid.
  await step("late-settle", async () => {
    if (plan.settled()) return "done";
    return (await waitUntil(plan.settled, allow(Number.POSITIVE_INFINITY), limits.pollMs)) ? "done" : "timeout";
  });

  if (finished) return;
  // 7.
  current = null;
  receipt.inFlightAtRelease = !plan.settled();
  const { finalPass } = receipt;
  receipt.clean = receipt.steps.every((s) => s.outcome === "done") && receipt.hooksFailed === 0 && receipt.stragglers === 0
    && finalPass.retained === 0 && finalPass.skipped === 0 && finalPass.outOfTime === 0 && !receipt.inFlightAtRelease;
  writeReceipt();

  // 8. Best-effort and briefly: a dropped connection releases its locks anyway.
  await within(plan.releaseLeases(), Math.min(limits.reserveMs, Math.max(0, remaining() - 100)));
  if (finished) return;
  finished = true;
  clearTimeout(backstop);
  plan.log(
    `drained ${receipt.clean ? "cleanly" : "with problems (see the receipt)"} in ${seconds(Date.now() - startedAt)} — ` +
      `${finalPass.saved}/${finalPass.homes} home(s) given a final pass; leases released; exiting 0`,
  );
  plan.exit(0);
}

/** Where the receipt lives: `<home>/ops`, beside the fleet's children rather than inside any one of them. */
export function shutdownReceiptDir(home: string): string {
  return path.join(home, "ops");
}
export const SHUTDOWN_RECEIPT_FILE = "last-shutdown.json";
/** Where the next start moves it once read, kept for an operator. */
export const PREVIOUS_SHUTDOWN_FILE = "previous-shutdown.json";

/** Step 7: whole or not at all, owner-only, and durable before the leases go. */
export function writeShutdownReceipt(dir: string, receipt: ShutdownReceipt): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path.join(dir, SHUTDOWN_RECEIPT_FILE), JSON.stringify(receipt, null, 2), 0o600, { durable: true });
}

/** What a receipt says went wrong, in a few words. */
function problems(r: ShutdownReceipt): string {
  const said: string[] = [];
  const late = r.steps.filter((s) => s.outcome !== "done").map((s) => `${s.step} ${s.outcome}`);
  if (late.length) said.push(late.join(", "));
  if (r.hooksFailed) said.push(`${r.hooksFailed} hook(s) failed`);
  if (r.stragglers) said.push(`${r.stragglers} process(es) SIGKILLed`);
  const f = r.finalPass;
  if (f.retained || f.skipped || f.outOfTime) said.push(`final pass ${f.saved}/${f.homes} saved, ${f.retained} retained, ${f.skipped} skipped, ${f.outOfTime} out of time`);
  if (r.inFlightAtRelease) said.push("a copy or spawn still in flight at release");
  return said.join("; ") || "no step reported";
}

function isReceipt(value: unknown): value is ShutdownReceipt {
  const r = value as Partial<ShutdownReceipt> | null;
  return !!r && typeof r === "object" && r.version === 1 && typeof r.clean === "boolean" && typeof r.signal === "string"
    && (r.outcome === "drained" || r.outcome === "budget-exceeded") && typeof r.startedAt === "number"
    && typeof r.finishedAt === "number" && Array.isArray(r.steps) && !!r.finalPass && typeof r.finalPass === "object";
}

/**
 * AT START: WAS THE LAST STOP CLEAN? One line to log, and the receipt moved
 * aside to `previous-shutdown.json`.
 *
 * MOVED, NOT LEFT, because a receipt is only evidence about the stop that
 * wrote it. Left in place, a crash of THIS run writes none, and the next start
 * would read the old clean one as its own. Moved, its absence means the run
 * before did not drain: a crash, a SIGKILL, an image without the drain, or a
 * first start — which is what the line says. Never thrown: a start is not
 * refused over a log line.
 *
 * `at` is when that stop finished (Unix ms), null without a readable receipt:
 * this is the one read of it, so whatever else reports the last stop (the
 * fleet heartbeat) takes it from here rather than from the file, which is no
 * longer there.
 */
export function takePreviousShutdown(dir: string): { clean: boolean | null; at: number | null; line: string } {
  const file = path.join(dir, SHUTDOWN_RECEIPT_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { clean: null, at: null, line: "previous shutdown left no receipt — it did not drain (a crash, a SIGKILL, an image without the drain, or a first start)" };
    }
    return { clean: false, at: null, line: "[alert] previous shutdown receipt is unreadable — read as NOT clean" };
  }
  let moved = true;
  try {
    renameSync(file, path.join(dir, PREVIOUS_SHUTDOWN_FILE));
    fsyncDirSync(dir);
  } catch {
    moved = false;
  }
  const stays = moved ? "" : " (it could not be moved aside, so the next start may read it again)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const malformed = { clean: false, at: null, line: `[alert] previous shutdown receipt is malformed — read as NOT clean${stays}` };
  if (!isReceipt(parsed)) return malformed;
  // Described inside a try: a receipt shaped right on the outside (a step that
  // is null, a time no Date can hold) is still malformed, never a throw.
  try {
    const at = new Date(parsed.finishedAt).toISOString();
    const took = seconds(parsed.finishedAt - parsed.startedAt);
    if (parsed.clean) return { clean: true, at: parsed.finishedAt, line: `previous shutdown was clean — ${parsed.signal} drained in ${took}, finished ${at}${stays}` };
    const where = parsed.outcome === "budget-exceeded" ? `budget exceeded${parsed.stalledAt ? ` during ${parsed.stalledAt}` : ""}` : "drained";
    return { clean: false, at: parsed.finishedAt, line: `[alert] previous shutdown was NOT clean — ${parsed.signal}, ${where} in ${took}, finished ${at}: ${problems(parsed)}${stays}` };
  } catch {
    return malformed;
  }
}
