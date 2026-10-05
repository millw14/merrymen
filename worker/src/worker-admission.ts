/**
 * WHAT THIS WORKER MAY START, AND THE MOMENT IT MUST STOP STARTING ANYTHING.
 *
 * A fleet coming back from a hold is brought back one tenant at a time, and a
 * tenant is not brought back all at once either: first it runs and is watched
 * (`observe`), then it may close what it holds (`exits-only`), and only then
 * may it trade (`trade`). The orchestrator decides which, per tenant, and
 * hands the answer to the child it spawns as MERRYMEN_ADMISSION_LEVEL
 * (orchestrator.ts childEnv). This file is the child's half: it reads that
 * answer, and judges every intent against it at the one place every intent
 * passes — the top of processIntentLocked (index.ts), before a budget is
 * reserved, a quote is fetched or anything is signed.
 *
 * WHY THERE AND NOWHERE ELSE. An owner's typed order, a Brain order, the
 * strategy loop, the class route, a dashboard command, the energy buy and the
 * selftest probe all reach the chain through that one function, on the one
 * serialising intent chain; admission-invariant.test.ts pins that nothing
 * signs from anywhere else. A gate at each producer would be a gate some new
 * producer forgets. A gate in the funnel cannot be walked around.
 *
 * ONLY EVER RESTRICTIVE. A refusal writes a `rejected` row, which is what
 * every other refusal in that function writes and what the ledger is for, and
 * it is taken before `reserveBudget`, so it reserves nothing and holds nothing
 * open: there is no half-done operation for a crash to leave behind, and
 * nothing a restart could replay. Every gate behind this one — the wall, the
 * caps, the breaker, the energy plan — still runs for whatever this lets past.
 *
 * AND THE LEVEL IS READ ONCE, at boot. The orchestrator changes it by
 * respawning the child, never by editing a live process's environment, so a
 * level that changed under a running process is not a thing that happens.
 */

import { countsAsEntry, sellsHeldLeg, type HeldCurveLeg } from "./energy";
import { isExitIntent, type AgentLimits, type TradeIntent } from "./policy";

/** Where the orchestrator puts this child's level (orchestrator.ts childEnv). */
export const ADMISSION_LEVEL_ENV = "MERRYMEN_ADMISSION_LEVEL";

/**
 * The three levels, least to most.
 *
 *   observe     — run, read, decide and record; start nothing. Every intent is
 *                 refused, exits included: a tenant at this level has not been
 *                 looked at yet, and "it only sold" is still a trade nobody
 *                 has checked the book behind.
 *   exits-only  — close what it holds. An intent that would count as a NEW
 *                 trade (energy.ts countsAsEntry: anything the drawdown
 *                 breaker's own exit test does not call money coming home,
 *                 short of a curve sale out of a held leg or a vault deposit)
 *                 is refused; everything else goes on to the usual gates.
 *   trade       — no admission refusal at all. What a worker always was.
 */
export type AdmissionLevel = "observe" | "exits-only" | "trade";

const LEVELS: ReadonlySet<string> = new Set<AdmissionLevel>(["observe", "exits-only", "trade"]);

/** The level this process runs at, and the sentence its boot line says about why. */
export interface Admission {
  level: AdmissionLevel;
  why: string;
}

/**
 * The level from the environment, FAILING CLOSED.
 *
 *   one of the three words  → that level, hosted or not.
 *   unset or blank, hosted  → observe. A hosted child is only ever spawned by
 *                             the orchestrator, which always sets it; a child
 *                             without it was spawned by something that did
 *                             not decide, and an undecided tenant trades
 *                             nothing.
 *   unset or blank, self-hosted → trade. Nobody rolls a self-hosted worker out
 *                             tenant by tenant; its owner started it to trade,
 *                             and this file must not change that.
 *   anything else           → observe, hosted or not. A value nobody can read
 *                             is not permission. Exact words only — a case or
 *                             a spelling the orchestrator never writes is
 *                             somebody else's guess at the grammar.
 */
export function admissionFrom(raw: string | undefined, hosted: boolean): Admission {
  const v = (raw ?? "").trim();
  if (LEVELS.has(v)) return { level: v as AdmissionLevel, why: `${ADMISSION_LEVEL_ENV}=${v}` };
  if (v === "") {
    return hosted
      ? { level: "observe", why: `${ADMISSION_LEVEL_ENV} is not set on a hosted worker — nothing is admitted until it is` }
      : { level: "trade", why: `${ADMISSION_LEVEL_ENV} is not set — a self-hosted worker trades as it always has` };
  }
  return {
    level: "observe",
    // The value itself is left out on purpose: it is operator input, and a
    // boot line is not the place to echo whatever it happened to contain.
    why: `${ADMISSION_LEVEL_ENV} is set to something that is not observe, exits-only or trade — read as observe`,
  };
}

/**
 * The `reject_rule` a refused intent is written with.
 *
 *   rollout-hold — this tenant's level does not admit it.
 *   draining     — the process is leaving (SIGTERM) and starts nothing new.
 */
export type AdmissionRule = "rollout-hold" | "draining";

/**
 * May this intent start? Null when it may, or the rule it is refused under.
 *
 * DRAINING WINS. A worker on its way out refuses everything new whatever its
 * level, and says so: "the service is restarting" is the more useful fact to
 * the owner whose order it was, because retrying in a minute may just work.
 * And it is asked again later, at each broadcast (DrainingRefused below): this
 * function judges the intent once, where it enters; the signal can come after.
 *
 * THE ENTRY TEST IS THE TICK'S OWN (index.ts, the strategy loop and the class
 * entries): energy.ts countsAsEntry over the breaker's isExitIntent and a
 * curve sale out of a held leg. `held` is the tick's most recent answer to
 * which legs it holds. A stale one cannot let a buy through: sellsHeldLeg is
 * true only of a curve trade that PAYS WITH the held token into that leg's own
 * quote, which is a sale whatever the book holds now — at worst the sale fails
 * for want of a balance, the same as it would at any level. An empty map (no
 * tick yet) is the strict reading: such a sale is then judged by the breaker's
 * test alone.
 */
export function admissionRefusal(
  gate: { level: AdmissionLevel; draining: boolean },
  intent: TradeIntent,
  limits: Pick<AgentLimits, "cashToken" | "quoteAssets">,
  held: ReadonlyMap<string, HeldCurveLeg>,
): AdmissionRule | null {
  if (gate.draining) return "draining";
  if (gate.level === "observe") return "rollout-hold";
  if (gate.level === "exits-only" && countsAsEntry(intent.kind, isExitIntent(intent, limits), sellsHeldLeg(intent, held))) {
    return "rollout-hold";
  }
  return null;
}

/**
 * REFUSING TO BROADCAST ON THE WAY OUT.
 *
 * admissionRefusal is asked once, at the top of processIntentLocked, and an
 * intent that passed it a moment before SIGTERM still has a long way to go
 * before anything leaves the process: the risk peak, the scout context and the
 * transfer total are read, a route is quoted, the operation is simulated,
 * bounded and signed. Each of those is an await, and each is long enough for
 * the signal to land in. Before this, node died on the signal and such an
 * intent never went out; a worker that drains must not be the reason one
 * does. So index.ts asks `draining` again at the last moment before each
 * broadcast — and the very last of those is the executor's onSubmitted hook,
 * which runs after signing and before the send, where a throw is already the
 * way to refuse (executor.ts ExecuteHooks). This is that throw.
 *
 * A sibling of NotRecorded and GasRefused, never of a revert: nothing was sent,
 * nothing spent, no `submitted` row written. Its `rule` is the one the gate
 * writes, so the tape says the same thing however late the refusal came.
 */
export class DrainingRefused extends Error {
  readonly rule: AdmissionRule = "draining";
  constructor() {
    super("refusing to broadcast: this worker is draining (SIGTERM) and starts nothing new. Nothing was sent.");
    this.name = "DrainingRefused";
  }
}

/**
 * How long a draining worker waits for the trade already on its intent chain.
 *
 * Sized to fit inside the twenty seconds a fleet drain gives a child between
 * SIGTERM and SIGKILL, so the child leaves by itself rather than being killed
 * mid-write, and far inside the heartbeat watchdog's floor. Where the
 * orchestrator kills sooner (killChild's SIGKILL three seconds on), the child
 * is killed exactly as it always was — only now with nothing new started in
 * those three seconds. Long enough for a send and one receipt read on a
 * healthy chain; a trade still out after it is left exactly as a crash would
 * leave it — its row was written `submitted` before the broadcast, and the
 * stranded-op resolver settles it from the chain on the next arm. Waiting
 * longer would not make that safer, only the restart slower.
 */
export const DRAIN_INTENT_CHAIN_MS = 18_000;

/**
 * Wait for the intent chain to empty, for at most `budgetMs`. True when it
 * did; false when the budget ran out with work still on it.
 *
 * THE TAIL IS RE-READ, NOT CAPTURED. index.ts replaces `intentChain` with a
 * new tail each time an intent joins, so a promise read once at SIGTERM is
 * only the work queued at that instant. An intent that joins during the drain
 * — a Telegram order typed a second later — is refused by the gate above, but
 * the refusal is still a row being written, and the store must not be closed
 * under it. So: wait for the tail, look again, and stop only once a look finds
 * the same tail it waited for. Every pass shares one deadline, so a chain that
 * keeps growing cannot hold the process past the budget.
 *
 * AND THE TICK THAT PUT IT THERE (`tick`, optional). The chain empties before
 * its callers are done with what it told them: the strategy loop refunds an
 * energy claim its refused intent did not consume, and a command tick writes
 * the owner's result file, each a write made AFTER the intent settled. So the
 * running tick's settle (command-wake.ts TickClock.settled) is waited for
 * beside the tail, re-read the same way, under the same one deadline — and the
 * drain ends only once a look finds both where it left them.
 *
 * Never rejects: the chain's own tails never do (processIntent swallows into
 * them), and a rejection here would be read the same as settling — the work
 * that rejected is over either way.
 */
export async function drainIntentChain(deps: {
  /** The chain's current tail — read through a closure, each time it is asked. */
  tail: () => Promise<unknown>;
  /** The tick running now, or null — read through a closure, each time it is asked. */
  tick?: () => Promise<unknown> | null;
  budgetMs: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}): Promise<boolean> {
  const deadline = deps.now() + deps.budgetMs;
  const tickNow = () => deps.tick?.() ?? null;
  for (;;) {
    const tail = deps.tail();
    const tick = tickNow();
    const left = deadline - deps.now();
    if (left <= 0) return false;
    let timer: unknown = null;
    const outOfTime = await Promise.race([
      // Settled, not all(): one that rejects is over, and must not end the
      // wait for the other.
      Promise.allSettled([tail, tick]).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = deps.setTimer(() => resolve(true), left);
      }),
    ]);
    if (timer !== null) deps.clearTimer(timer);
    if (outOfTime) return false;
    if (deps.tail() === tail && tickNow() === tick) return true;
  }
}
