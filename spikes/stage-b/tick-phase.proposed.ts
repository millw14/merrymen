/**
 * WHEN this process ticks — a permanent phase per tenant, and an absolute grid.
 *
 * TWO THINGS WERE WRONG, and they compounded.
 *
 * 1. The orchestrator spawns the whole fleet in one tight loop (orchestrator.ts
 *    :426, no stagger), measured at a 3ms burst, and runLoop starts by calling
 *    tick() immediately. So every child arms and runs its first tick at the same
 *    instant: 1,495 RPC calls in 13.1s, 114/s fleet-wide against 8.08/s
 *    sustained, 108 of them rate-limited.
 *
 * 2. runLoop rescheduled with `setTimeout(runLoop, tickSeconds * 1000)` in the
 *    `.finally`, i.e. a period measured from when the PREVIOUS tick finished. The
 *    real period is therefore `tickSeconds + tickDuration`, and tick duration
 *    differs per child — so phases wander apart at ~0.37s per tick. Measured:
 *    6.1s of spread at start, ~57s nine hours later, and a deploy collapses it
 *    back to 3ms. Accidental drift is not a schedule; it cannot be relied on and
 *    it is destroyed by the one event that needs it most.
 *
 * The fix is one phase per tenant, derived from the tenant address, on an
 * absolute grid. No coordination, no shared counter, no parent to ask, no
 * persisted state: the same answer after every restart, crash and redeploy,
 * computed independently by each child from something it already knows.
 */

/**
 * djb2 (xor variant), 32-bit, over the lowercased tenant address.
 *
 * NOT because it is a better hash. Measured over 20,000 independent random
 * 22-address rosters, djb2, FNV-1a, SHA-256/32 and SHA-256/48 produce a
 * statistically identical spread — mean max-children-in-an-8s-window of
 * 3.487 / 3.491 / 3.492 / 3.502, all matching the null model of 22 uniform
 * points on a circle. They are all uniform. Which one you pick does not change
 * the QUALITY of the spread; it only chooses WHICH DRAW you get.
 *
 * So it was chosen on the roster that actually exists. On the 22 live tenants
 * djb2's draw is a good one — at most 3 children inside any 8s window, largest
 * hole 28.7s, chi-square 9.6 on 11df — where SHA-256/48's draw on the same 22 is
 * the p99 bad one: 5 inside an 8s window and a 61-second hole.
 *
 * THE COROLLARY, which matters more than the choice: this is selection on a
 * sample that happens to be the whole population TODAY. It is not a property of
 * djb2 and it does not transfer to tenant 23. Re-run spikes/stage-b/ when the
 * roster changes; if the draw ever goes bad, the answer is not a different hash
 * (they are all the same) but an assigned offset — see the note at the bottom.
 */
export function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** settings.ts clamps tickSeconds to [15, 3600]; be defensive about it anyway. */
export function periodMsOf(tickSeconds: number): number {
  const ms = Math.round(Number(tickSeconds) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
}

/**
 * This process's permanent phase inside the tick period, in ms.
 *
 * Pure. No clock, no I/O, no randomness, no process identity — so it survives a
 * restart by construction rather than by being saved anywhere.
 */
export function tickOffsetMs(identity: string, tickSeconds: number): number {
  const periodMs = periodMsOf(tickSeconds);
  const key = String(identity ?? "").trim().toLowerCase();
  if (!key) return 0;
  return djb2(key) % periodMs;
}

/**
 * Milliseconds until this process's next slot on the absolute grid
 *
 *     t ≡ offsetMs   (mod periodMs)
 *
 * ALWAYS in (0, periodMs]. Never 0 — a zero delay would spin. Never negative.
 * Never more than one period, so no clock jump in either direction can strand
 * the agent or fire it twice in a row.
 *
 * Grid-aligned rather than relative, because a relative delay is exactly the
 * drift described at the top of this file: a phase that is not re-derived from
 * the wall clock every time is not a phase, it is an initial condition.
 *
 * CADENCE IS UNCHANGED. Consecutive ticks are separated by exactly periodMs, or
 * by an integer multiple of it when a tick overran its own slot — never less.
 * The nominal period is untouched; only the phase moves. One second-order
 * effect, measured rather than guessed: today's real period is tickSeconds PLUS
 * the tick's own duration, and grid alignment drops that addend. Over the 9.066h
 * Stage A run, 2,990 summaries across 22 children is 135.9 ticks each, i.e. a
 * real period of 240.143s against a nominal 240s — a mean tick duration of
 * 143ms. So alignment raises the tick rate by 0.060%, not by anything that
 * shows up in an RPC budget. (The 5-13s figure is the COLD tick; steady-state
 * ticks are two orders of magnitude shorter, which is also why the fleet's
 * accidental drift took nine hours to reach 57s: the slowest and fastest
 * children's periods differ by only 0.375s.)
 */
export function msUntilNextSlot(nowMs: number, offsetMs: number, periodMs: number): number {
  const slot = Math.floor((nowMs - offsetMs) / periodMs) + 1;
  const delay = slot * periodMs + offsetMs - nowMs;
  // floor() already guarantees (0, periodMs]; the clamp is against a non-finite
  // clock reading, not a real branch.
  return delay > 0 && delay <= periodMs ? delay : periodMs;
}

/**
 * Which tenant am I?
 *
 * MERRYMEN_TENANT is set explicitly by childEnv(). The MERRYMEN_HOME basename is
 * the fallback, because childHome() is `<home>/children/<lowercased tenant>` —
 * but it is ONLY a fallback, and the caller logs which one answered. If this
 * ever silently stopped resolving to a tenant address, every child would hash
 * the same string, every offset would be identical, and the whole fleet would
 * quietly re-synchronise into the burst this module exists to prevent. That
 * failure must be loud, so the source is returned rather than swallowed.
 */
export function tenantIdentity(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): { id: string; source: string } {
  const explicit = (env.MERRYMEN_TENANT ?? "").trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(explicit)) return { id: explicit, source: "MERRYMEN_TENANT" };
  const base = String(homeDir).split(/[\\/]/).filter(Boolean).pop() ?? "";
  const low = base.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(low)) return { id: low, source: "MERRYMEN_HOME basename" };
  // Self-hosted: one process, nothing to spread against. Deterministic anyway.
  return { id: String(homeDir).toLowerCase(), source: "home path (not a tenant address)" };
}

/**
 * IF THE DRAW EVER GOES BAD. The orchestrator already knows the entire tenant
 * set (reconcile() lists it) and already writes a per-child file every 15s, so
 * an ASSIGNED offset — rank within the sorted roster, times periodMs/N — needs
 * no new channel and gives a perfect spread (exactly one child per periodMs/N,
 * no clustering, no draw) instead of this function's "3 within 8s on a good
 * day". It was not chosen here because an assigned rank reshuffles every
 * tenant's phase whenever the roster changes, where the hash never moves an
 * incumbent. Keep this function as the child's self-sufficient default; layer
 * an assignment on top only if the measured spread stops being good enough.
 */
