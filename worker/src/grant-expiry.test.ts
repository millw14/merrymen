import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { grantExpired, grantKey } from "./grant";
import type { StoredGrant } from "../../packages/core/src/index";

/**
 * The two predicates that decide whether a session key still counts, and
 * whether we have already said so.
 *
 * They exist as exports mainly because index.ts is one 2400-line main() with no
 * seams — but they are also the part of the retire path a future edit is most
 * likely to get subtly wrong, in ways that are invisible until an owner's
 * roster says 'armed' for a key that died a week ago.
 */

const grant = (over: Partial<StoredGrant>): StoredGrant =>
  ({
    smartAccount: "0x00000000000000000000000000000000000000a1",
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 25, dailyUsdg: 100, maxOpsPerDay: 48, maxDrawdownBps: 2000, ttlDays: 14 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000,
    chainId: 4663,
    ...over,
  }) as StoredGrant;

test("a grant is dead AT its expiry, not one second later", () => {
  // `expiresAt` is the first second the on-chain timestamp policy refuses. Off
  // by one here and the worker submits a final op the account contract rejects
  // — paying gas to be told no.
  const g = grant({ expiresAt: 2_000_000 });
  assert.equal(grantExpired(g, 1_999_999), false, "one second short is still live");
  assert.equal(grantExpired(g, 2_000_000), true, "AT expiresAt it is over");
  assert.equal(grantExpired(g, 2_000_001), true);
});

test("re-signing produces a different key, so the new grant gets its own warning", () => {
  // Re-signing yields the SAME smart account — the address derives from the
  // owner key alone, which is what makes restore work. If the dedup key were
  // the account, a freshly signed key that is itself already lapsed would be
  // silently swallowed by the previous grant's announcement.
  const first = grant({ grantedAt: 1_000_000 });
  const resigned = grant({ grantedAt: 1_500_000 });
  assert.equal(first.smartAccount, resigned.smartAccount, "same wallet, as designed");
  assert.notEqual(grantKey(first), grantKey(resigned), "but a different signature");
});

test("two grants minted in the same second COLLIDE — which is why convergence may not be gated on this", () => {
  // `grantedAt` is whole seconds (both signers use Math.floor(Date.now()/1000)),
  // so this is reachable, not theoretical. It is the reason retireGrant writes
  // the status and clears `active` OUTSIDE the dedup and keys only the event:
  // gating the status write on this would leave a dead grant reading 'armed' in
  // the roster forever, and nothing would ever correct it.
  const a = grant({ grantedAt: 1_700_000 });
  const b = grant({ grantedAt: 1_700_000, serialized: "a different signature entirely" });
  assert.equal(grantKey(a), grantKey(b), "the key cannot tell these apart");
});

test("a different account is a different key even at the same instant", () => {
  const a = grant({ grantedAt: 1_700_000 });
  const b = grant({ grantedAt: 1_700_000, smartAccount: "0x00000000000000000000000000000000000000ff" });
  assert.notEqual(grantKey(a), grantKey(b));
});

test("syncGrant refuses an expired grant BEFORE its unchanged short-circuit", () => {
  // THE ORDERING IS THE FIX, so it is pinned structurally — index.ts exports
  // nothing, so there is no other way to reach it.
  //
  // The flap worked like this: the tick's expiry branch set `active = null`,
  // which made `unchanged` falsy, which re-armed the same dead grant next tick,
  // which the tick then retired again. Putting the guard AFTER the short-circuit
  // would look correct and change nothing — `unchanged` is falsy on exactly the
  // ticks that matter. Only an expiry check that runs first breaks the cycle.
  const src = readFileSync(fileURLToPath(new URL("index.ts", import.meta.url)), "utf8");
  const sync = src.slice(src.indexOf("async function syncGrant()"));
  const guard = sync.indexOf("grantExpired(");
  const shortCircuit = sync.indexOf("if (unchanged && !tradingSponsorNeedsRearm(cfg, active)) return true;");
  assert.ok(guard > 0, "syncGrant must check grantExpired at all");
  assert.ok(shortCircuit > 0, "sanity: the unchanged short-circuit still exists");
  assert.ok(
    guard < shortCircuit,
    "the expiry guard must run BEFORE the unchanged short-circuit — after it, a grant that " +
      "lapsed while armed re-arms every tick forever, which is the flap this replaced",
  );
});

test("retireGrant converges even when the announcement is suppressed", () => {
  // Pinned as source because the ordering inside retireGrant is the subtle part:
  // `active = null` and the status write must precede the dedup `return`, or a
  // same-second re-sign leaves a dead grant reading 'armed' in the roster.
  const src = readFileSync(fileURLToPath(new URL("index.ts", import.meta.url)), "utf8");
  const body = src.slice(src.indexOf("async function retireGrant("), src.indexOf("async function syncGrant()"));
  const clear = body.indexOf("active = null");
  const status = body.indexOf('setAgentStatus(agentId, "expired")');
  const dedup = body.indexOf("=== retiredGrantKey");
  assert.ok(clear >= 0 && status >= 0 && dedup >= 0, "sanity: all three still present");
  assert.ok(clear < dedup, "clearing the armed handle must not be gated on the dedup key");
  assert.ok(status < dedup, "the status write must not be gated on the dedup key");
});
