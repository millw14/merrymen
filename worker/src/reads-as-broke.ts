/**
 * Should this agent's next tick run in PAPER mode because it cannot trade?
 *
 * Pure form of the tick's `readAsBroke`, in a module that imports NO worker
 * loop, so the broke-vs-funded boundary is unit-testable without booting the
 * whole worker (importing worker/src/index.ts runs main()).
 *
 * Broke = the ledger READ a zero cash balance AND the account holds no native
 * ETH:
 *
 *  - null cash = UNKNOWN, never broke (a funded live agent must not be pushed
 *    into simulation by a read that has not happened yet);
 *  - cash 0 with gas = FUNDED — capital arrived as native ETH and the
 *    auto-convert (which refuses to run in paper mode) is about to turn it
 *    into cash. Calling this state broke deadlocks: paper mints pretend USDG
 *    while blocking the very swap that would end the paper mode.
 */
export function readsAsBroke(cashUsdg: bigint | null, gasWei: bigint | null): boolean {
  if (cashUsdg === null || cashUsdg !== 0n) return false;
  return gasWei === null || gasWei === 0n;
}