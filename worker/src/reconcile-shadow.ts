/**
 * RUN THE NEW RECONCILER BESIDE THE OLD ONE AND COMPARE. NEVER MUTATE.
 *
 * reconcile-modes.ts replaces one thing and one thing only: HOW the EntryPoint
 * logs are FETCHED. The accounting on top of them is untouched — the same
 * findOrphanOps decides what a log means, the same addTrade writes it. So this
 * is what shadow mode has to establish equivalence of: THE FETCH. Comparing
 * ledger effects would be comparing code that did not change.
 *
 * THE COMPARISON IS AGAINST WHAT THE AUTHORITATIVE PATH REALLY SAW, not against
 * a third scan of the same range. findOrphanOps hands its own logs out through
 * `onLogs`, so a mismatch is a genuine difference between two fetches of the same
 * blocks rather than two fetches of two slightly different moments.
 *
 * WHAT SHADOW MODE COSTS. One extra scan of the same range per armed canary
 * tenant — the new fetch — on top of the old one. That is the price of the
 * comparison and it is temporary; it is also why the canary is a small set
 * rather than the fleet.
 *
 * WHAT IT CANNOT ESTABLISH, stated because the measurement says so rather than
 * because it is a nice caveat. Over 9.066 hours the fleet had ZERO outstanding
 * operations and the arm sweep found NOTHING on all 22 children. An empty set
 * compared against an empty set is not evidence of equivalence — it is evidence
 * that nothing happened. `ShadowVerdict.informative` is false for exactly that
 * case, and a promotion decision that counts uninformative comparisons is
 * counting nothing. Getting real evidence needs operations that actually landed:
 * deliberate re-arms against accounts with history, not calendar time.
 */
import type { Hex } from "viem";
import type { RawLog, ReconcileChain } from "./inflight-reconcile";
import { fetchSharedBySender } from "./reconcile-modes";

/**
 * Which tenants are shadowing.
 *
 * MERRYMEN_RECONCILE_SHADOW is either "all" or a comma-separated list of
 * address PREFIXES, matched case-insensitively against the smart account and
 * the tenant alike — the log lines carry the smart account, the operator thinks
 * in tenants, and being able to paste either is worth more than being strict.
 *
 * ABSENT MEANS OFF. A shadow that switched itself on by default would put an
 * extra scan on every arm in the fleet to answer a question nobody asked.
 */
export function shadowEnabledFor(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MERRYMEN_RECONCILE_SHADOW ?? "").trim();
  if (!raw) return false;
  const want = id.trim().toLowerCase();
  if (!want) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => p === "all" || want.startsWith(p));
}

/** One event, reduced to the identity two fetches must agree on. */
export interface EventKey {
  userOpHash: string;
  txHash: string;
  blockNumber: string;
}

export function keyOf(l: RawLog): EventKey {
  return {
    userOpHash: String(l.topics[1] ?? "").toLowerCase(),
    txHash: String(l.transactionHash ?? "").toLowerCase(),
    blockNumber: String(l.blockNumber ?? "").toLowerCase(),
  };
}

const idOf = (k: EventKey) => `${k.userOpHash}@${k.txHash}#${k.blockNumber}`;

export interface ShadowVerdict {
  equivalent: boolean;
  /**
   * False when BOTH sides are empty. Not a failure — a comparison that had
   * nothing to compare, which must never be counted as evidence of agreement.
   */
  informative: boolean;
  inBoth: number;
  onlyInOld: EventKey[];
  onlyInNew: EventKey[];
  /** Coverage has to match too: equal event sets over unequal ranges prove nothing. */
  coverageMatches: boolean;
  detail: string;
}

/**
 * Compare two fetches of the same range. Pure.
 *
 * COVERAGE IS PART OF THE ANSWER. Two scans that agree on events while one of
 * them covered less of the range have not agreed about anything — the shorter
 * scan simply had fewer chances to differ. So a coverage mismatch makes the
 * verdict non-equivalent even when the sets are identical, and says which.
 */
export function compareEventSets(args: {
  oldLogs: readonly RawLog[];
  newLogs: readonly RawLog[];
  oldComplete: boolean;
  newComplete: boolean;
  oldScannedTo: bigint;
  newScannedTo: bigint;
}): ShadowVerdict {
  const oldMap = new Map(args.oldLogs.map((l) => [idOf(keyOf(l)), keyOf(l)]));
  const newMap = new Map(args.newLogs.map((l) => [idOf(keyOf(l)), keyOf(l)]));
  const onlyInOld = [...oldMap].filter(([id]) => !newMap.has(id)).map(([, k]) => k);
  const onlyInNew = [...newMap].filter(([id]) => !oldMap.has(id)).map(([, k]) => k);
  const inBoth = [...oldMap].filter(([id]) => newMap.has(id)).length;

  const coverageMatches =
    args.oldComplete === args.newComplete && args.oldScannedTo === args.newScannedTo;
  const setsMatch = onlyInOld.length === 0 && onlyInNew.length === 0;
  const informative = oldMap.size > 0 || newMap.size > 0;

  let detail: string;
  if (!coverageMatches) {
    detail =
      `coverage differs — old complete=${args.oldComplete} scannedTo=${args.oldScannedTo}, ` +
      `new complete=${args.newComplete} scannedTo=${args.newScannedTo}. Equal event sets over ` +
      "unequal ranges prove nothing, so this is NOT equivalence.";
  } else if (!setsMatch) {
    detail =
      `${onlyInOld.length} event(s) only the old fetch saw, ${onlyInNew.length} only the new one. ` +
      "The fetch is what changed, so this is a real difference and promotion must not proceed.";
  } else if (!informative) {
    detail =
      "both fetches returned nothing over the same fully-covered range. That is agreement about " +
      "an absence, not evidence of equivalence — it does not count toward promotion.";
  } else {
    detail = `${inBoth} event(s), identical on both sides over the same fully-covered range.`;
  }

  return {
    equivalent: coverageMatches && setsMatch,
    informative,
    inBoth,
    onlyInOld,
    onlyInNew,
    coverageMatches,
    detail,
  };
}

/**
 * Fetch the same range through the NEW path and compare. Returns the verdict.
 *
 * MUTATES NOTHING. It takes no ledger handle, writes no row, and its return
 * value is consumed by a log line. That is not a convention to be respected
 * later — there is no store in scope here to write to.
 */
export async function runShadowComparison(args: {
  chain: ReconcileChain;
  smartAccount: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  oldLogs: readonly RawLog[];
  oldComplete: boolean;
  oldScannedTo: bigint;
  maxSpan?: bigint;
  log?: (m: string) => void;
}): Promise<{ verdict: ShadowVerdict; newRequests: number }> {
  const shared = await fetchSharedBySender(args.chain, {
    // ONE sender here, because shadow mode compares against a single tenant's
    // authoritative scan. The saving comes from batching senders across the
    // fleet, which is the NEXT phase — this phase only has to prove that the
    // shared fetcher returns the same events for one of them.
    senders: [args.smartAccount],
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    maxSpan: args.maxSpan,
    log: args.log,
  });

  const verdict = compareEventSets({
    oldLogs: args.oldLogs,
    newLogs: shared.bySender.get(args.smartAccount.toLowerCase()) ?? [],
    oldComplete: args.oldComplete,
    newComplete: shared.complete,
    oldScannedTo: args.oldScannedTo,
    newScannedTo: shared.scannedTo,
  });
  return { verdict, newRequests: shared.requests };
}

/** The one line an operator reads to decide whether promotion is earned. */
export function shadowLine(
  smartAccount: string,
  v: ShadowVerdict,
  newRequests: number,
  oldLogs: number,
): string {
  const tag = !v.informative ? "EMPTY" : v.equivalent ? "MATCH" : "MISMATCH";
  return (
    `[shadow] ${smartAccount.slice(0, 10)} ${tag} · old ${oldLogs} event(s) · ` +
    `new ${v.inBoth + v.onlyInNew.length} · +${newRequests} extra request(s) · ${v.detail}` +
    (v.onlyInOld.length ? ` · only-old: ${v.onlyInOld.map(idOf).join(" ")}` : "") +
    (v.onlyInNew.length ? ` · only-new: ${v.onlyInNew.map(idOf).join(" ")}` : "")
  );
}
