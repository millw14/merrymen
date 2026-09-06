/**
 * Reserve + surplus arithmetic for ETH→USDG converts, shared by the worker
 * tick and the /swap quote preview so the two paths cannot disagree about
 * what "gas kept" means.
 *
 * The owner's split (percent of balance) with a NON-configurable floor beneath
 * it: enough for one operating swap's gas at the live price. Sponsored gas
 * leaves the paymaster's deposit, not the account, so the floor is a small
 * drift margin; self-paid is ~2M gas deployed, ~5M for the undeployed fallback.
 * Pure — tested below.
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
