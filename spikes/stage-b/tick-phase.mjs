/**
 * PROPOSED worker/src/tick-phase.ts, kept here as .mjs so it can be tested
 * without touching worker/. The shipping file is TypeScript; the logic is
 * identical line for line.
 *
 * WHY A PHASE AT ALL.
 *
 * runLoop reschedules with `setTimeout(runLoop, tickSeconds * 1000)` AFTER the
 * tick finishes, and the orchestrator spawns the whole fleet in a 3ms burst. So
 * every child starts at the same instant and stays roughly in phase: a deploy
 * puts 22 processes into their arm + first tick simultaneously — measured at
 * 1,495 RPC calls in 13.1s (114/s fleet-wide, 19x the 8.08/s sustained rate)
 * with 108 of them rate-limited.
 *
 * The phase is derived from the TENANT, not from a random number and not from
 * anything the parent has to hand out, so it is the same after every restart,
 * every redeploy and every crash — no coordination, no state, no clock.
 */

/**
 * djb2 (xor variant), 32-bit.
 *
 * WHY THIS ONE AND NOT SHA-256: it is not "better". Measured over 20,000
 * random 22-address rosters, djb2, FNV-1a, SHA-256/32 and SHA-256/48 give a
 * statistically identical spread (mean max-in-8s-window 3.487 / 3.491 / 3.492 /
 * 3.502) — they are all uniform, and which one you pick only decides WHICH
 * draw you get. djb2 is chosen because on the fleet that actually exists its
 * draw is the good one (max 3 children within any 8s window, largest hole
 * 28.7s) where SHA-256/48's is the p99 bad one (5 within 8s, a 61s hole).
 * See spikes/stage-b/. Re-run that check when the roster changes.
 */
export function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/**
 * This process's permanent phase within the tick period, in ms.
 *
 * Pure: no clock, no I/O, no randomness. Same input, same answer, for ever.
 */
export function tickOffsetMs(identity, tickSeconds) {
  const periodMs = periodMsOf(tickSeconds);
  const key = String(identity ?? "").trim().toLowerCase();
  if (!key) return 0;
  return djb2(key) % periodMs;
}

/** tickSeconds is clamped to [15, 3600] by settings.ts; be defensive anyway. */
export function periodMsOf(tickSeconds) {
  const ms = Math.round(Number(tickSeconds) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
}

/**
 * Milliseconds until this process's next slot on the absolute grid
 *   t ≡ offset  (mod period)
 *
 * ALWAYS in (0, period]. Never zero (which would spin), never negative, never
 * more than one period (so a clock that jumps cannot strand the agent).
 *
 * Grid-aligned rather than "period after the last tick finished" because a
 * relative delay makes the real period `period + tickDuration`, which differs
 * per child — that is precisely the drift that pulled this fleet from 6.1s of
 * spread to ~57s over nine hours. A phase that drifts is not a phase.
 */
export function msUntilNextSlot(nowMs, offsetMs, periodMs) {
  const slot = Math.floor((nowMs - offsetMs) / periodMs) + 1;
  const delay = slot * periodMs + offsetMs - nowMs;
  // floor() already guarantees (0, periodMs]; clamp is belt-and-braces against
  // a non-finite clock reading rather than a real branch.
  return delay > 0 && delay <= periodMs ? delay : periodMs;
}

/**
 * Who am I? The orchestrator sets MERRYMEN_TENANT explicitly (one line in
 * childEnv). The MERRYMEN_HOME basename is the fallback, because childHome()
 * is `<home>/children/<lowercased tenant>` — but it is only a fallback, and
 * the caller LOGS what it resolved: if this ever silently stopped yielding a
 * tenant address the whole fleet would quietly re-synchronise, which is the
 * exact failure this module exists to prevent, and it must not be silent.
 */
export function tenantIdentity(env, homeDir) {
  const explicit = (env.MERRYMEN_TENANT ?? "").trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(explicit)) return { id: explicit, source: "MERRYMEN_TENANT" };
  const base = String(homeDir).split(/[\\/]/).filter(Boolean).pop() ?? "";
  const low = base.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(low)) return { id: low, source: "MERRYMEN_HOME basename" };
  // Self-hosted: one process, nothing to spread against. Stable either way.
  return { id: String(homeDir).toLowerCase(), source: "home path (not a tenant address)" };
}
