/**
 * A BALANCE WE COULD NOT READ IS NOT A BALANCE OF ZERO.
 *
 * `readHolderStatus` returned the outsider floor for BOTH "this wallet holds
 * nothing" and "the chain would not answer", and the tick took `.tier` straight
 * off it. On a fleet whose mainnet reads are refused routinely — one egress IP,
 * retryCount 0, a shared circuit breaker — two things then happened on the same
 * tick:
 *
 *   the owner was told "no $MERRYMEN at your holder wallet", a confident claim
 *   about an address nobody had managed to read; and
 *
 *   effectivePerfFeeBps took the UNDISCOUNTED rate, so a tick that also set a
 *   new high-water mark accrued the full performance fee to the ledger —
 *   permanently, against a holder who had paid for the discount.
 *
 * That second one is money, which is why this file exists.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the read says whether it read", () => {
  it("NO ADDRESS AND NO ANSWER ARE DIFFERENT ARMS", async () => {
    const { readHolderStatusResult } = await import("./circle");
    // No wallet configured is a real, knowable answer — there is nothing to
    // hold anything, so the floor is the truth rather than a fallback.
    const none = await readHolderStatusResult(undefined, undefined);
    assert.equal(none.ok, true);
    assert.equal(none.status.tier.id, "outsider");
  });

  it("and a failed read is ok:false with the floor beside it", async () => {
    const { readHolderStatusResult } = await import("./circle");
    // An unroutable endpoint: the call cannot succeed, and the result must say
    // so rather than describing the wallet.
    const failed = await readHolderStatusResult(
      "http://127.0.0.1:9/none",
      `0x${"a".repeat(40)}` as `0x${string}`,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.status.tier.id, "outsider", "still fails closed as a permission");
  });
});

describe("the tick charges nobody for our outage", () => {
  it("A FAILED READ KEEPS THE LAST KNOWN-GOOD TIER", () => {
    // Not "assume they qualify" — that would grant a discount never verified.
    // Keeping the last read grants nothing new and stops an outage silently
    // repricing somebody mid-session.
    const src = read("./index.ts");
    assert.match(src, /const holderRead = await readHolderStatusResult\(/);
    assert.match(src, /if \(holderRead\.ok\) holderTier = holderRead\.status\.tier;/);
  });

  it("AND SAYS NOTHING ABOUT THE WALLET IT COULD NOT READ", () => {
    // The tier-change event is a claim about their holdings. It may only fire
    // on a read that happened.
    const src = read("./index.ts");
    assert.match(src, /if \(holderRead\.ok && holderTier\.id !== lastTierId\)/);
  });

  it("and the fee is derived from that tier, which is why this matters", () => {
    // The line this protects: a wrong tier here is a wrong number in the
    // ledger, not a wrong word on a screen.
    const src = read("./index.ts");
    assert.match(src, /const effFeeBps = effectivePerfFeeBps\(cfg\.perfFeeBps, holderTier\);/);
  });

  it("AND THE IDLE NOTICE NAMES WHICH NO IT IS", () => {
    // Telling a holder to go and hold $MERRYMEN because our read failed is
    // advice they cannot act on — they already did it.
    const src = read("./index.ts");
    assert.match(src, /holderReadOk\s*\?/);
    assert.match(src, /could not read your \$MERRYMEN balance this tick/);
    assert.match(src, /our read failing, not your wallet/);
  });
});

describe("the old shape survives for callers that only want a floor", () => {
  it("but it is documented as unable to answer the question that matters", () => {
    const src = read("./circle.ts");
    assert.match(src, /export async function readHolderStatus\(/);
    assert.match(src, /cannot tell you whether the\s*\*\s*answer was read or assumed/);
  });
});
