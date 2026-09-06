/**
 * WHERE IN THE TICK A WORKER'S FIRST PASS FALLS.
 *
 * The orchestrator forks one child per tenant and they all reach the loop
 * within a second of each other, so every deploy fires thirty-two identical
 * first ticks simultaneously at one endpoint. Batching cut what a single tick
 * costs (see rpc-meter.ts); it does nothing about thirty-two of them landing
 * together, and the boot burst is exactly where the fleet's rate limiting was
 * worst — measured after batching shipped, the first ticks still came back
 * "market unreadable" while a child that happened to start late read the
 * market cleanly on its first try.
 *
 * Its own module because index.ts runs `main()` at import: anything a test
 * needs to call cannot live there without starting a worker.
 */

/**
 * A stable hash of the tenant, spread over the interval.
 *
 * DERIVED, NOT RANDOM. The same agent takes the same slot on every restart, so
 * a crash-looping child cannot walk into a different neighbour's slot each
 * time and two deploys are comparable. Bounded by the tick itself: nobody
 * waits longer for their first tick than they will routinely wait for their
 * second.
 */
export function startupSlotMs(tenant: string, tickMs: number): number {
  if (!tenant || !Number.isFinite(tickMs) || tickMs <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < tenant.length; i += 1) {
    h ^= tenant.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % tickMs);
}
