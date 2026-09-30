/**
 * THE NONCE ALLOCATOR against a real sqlite ledger and the real signer.
 *
 *   the floor     max(now_ms, venue nextNonce, persisted high-water + 1) at
 *                 arm; an unread venue counter or ledger reserves nothing.
 *   commit        every nonce is in the ledger's high-water before next()
 *                 returns it.
 *   order         strictly increasing across concurrent callers, whatever the
 *                 clock does.
 *   coherence     what next() returns satisfies BOTH the signer's
 *                 `nonce > ctx.nonceHighWater` and the store's
 *                 `high-water ≥ nonce` — and the persisted value read after
 *                 the reservation would satisfy neither the signer's contract
 *                 nor its check.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/perps";
import { NonceUnavailable, createNonceAllocator, type NonceStore } from "./nonce";
import { SignerArgumentError, instantiateSigner } from "./signer";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-nonce-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ACCOUNT = 22149;
const KEY = LIGHTER_ROUTE_V1.apiKeyIndex;
const T0 = 1_790_700_000_000;
let clock = T0;
let n = 0;
const agent = () => `0xAbC${(++n).toString(16).padStart(37, "0")}`;

function allocator(agentId: string, over: { venue?: () => Promise<bigint | null>; store?: NonceStore } = {}) {
  return createNonceAllocator({
    agentId,
    accountIndex: ACCOUNT,
    apiKeyIndex: KEY,
    store: over.store ?? store,
    now: () => clock,
    venueNextNonce: over.venue ?? (async () => 0n),
  });
}

describe("the floor at arm", () => {
  it("is max(now_ms, the venue's nextNonce, the persisted high-water + 1)", async () => {
    clock = T0;
    // The clock dominates a fresh ledger and a quiet key.
    const a = agent();
    assert.equal(await allocator(a, { venue: async () => 5n }).arm(), BigInt(T0));
    // A venue counter ahead of our clock (a clock that went back, or a
    // key used from somewhere else) is the floor.
    const b = agent();
    const ahead = BigInt(T0) + 60_000n;
    const nb = allocator(b, { venue: async () => ahead });
    assert.equal(await nb.arm(), ahead);
    assert.equal((await nb.next()).nonce, ahead);
    // A persisted high-water ahead of both: the next nonce clears it.
    const c = agent();
    const hw = BigInt(T0) + 120_000n;
    await store.bumpNonceHighWater(c, "live", hw);
    const nc = allocator(c, { venue: async () => ahead });
    assert.equal(await nc.arm(), hw + 1n);
    const r = await nc.next();
    assert.deepEqual(r, { nonce: hw + 1n, previousHighWater: hw });
  });

  it("reserves nothing while the venue's counter or the ledger is unread", async () => {
    clock = T0;
    const a = agent();
    for (const venue of [async () => null, async () => Promise.reject(new Error("503")), async () => -1n]) {
      const x = allocator(a, { venue: venue as () => Promise<bigint | null> });
      await assert.rejects(x.next(), (e: unknown) => e instanceof NonceUnavailable && e.reason === "venue-unread");
      assert.equal(x.armed(), false);
    }
    assert.equal(await store.getNonceHighWater(a, "live"), null, "an unarmed allocator never touched the high-water");
    const broken: NonceStore = {
      bumpNonceHighWater: () => Promise.reject(new Error("unreachable")),
      getNonceHighWater: () => Promise.reject(new Error("disk")),
    };
    await assert.rejects(allocator(a, { store: broken }).next(), (e: unknown) => e instanceof NonceUnavailable && e.reason === "ledger-unread");
  });
});

describe("next()", () => {
  it("commits each nonce to the ledger before returning it", async () => {
    clock = T0;
    const a = agent();
    const x = allocator(a);
    for (let i = 0; i < 3; i++) {
      const { nonce } = await x.next();
      assert.equal(await store.getNonceHighWater(a, "live"), nonce, "the high-water holds the nonce the caller is about to sign with");
      assert.equal(x.highWater(), nonce);
    }
  });

  it("is strictly increasing across concurrent callers, each nonce above the high-water it was reserved against", async () => {
    clock = T0;
    const a = agent();
    const x = allocator(a);
    const got = await Promise.all(Array.from({ length: 25 }, () => x.next()));
    for (let i = 0; i < got.length; i++) {
      const g = got[i]!;
      assert.ok(g.nonce > g.previousHighWater);
      if (i > 0) {
        // In call order: one in flight, and each one's floor is the last one.
        assert.ok(g.nonce > got[i - 1]!.nonce, `nonce ${i} after ${i - 1}`);
        assert.equal(g.previousHighWater, got[i - 1]!.nonce);
      }
    }
    assert.equal(new Set(got.map((g) => g.nonce)).size, 25);
    assert.equal(got[0]!.nonce, BigInt(T0), "the first is the clock itself");
    assert.equal(got[0]!.previousHighWater, 0n, "none was reserved before it");
  });

  it("keeps rising when the clock goes backwards, and resumes the clock once it is ahead again", async () => {
    clock = T0;
    const a = agent();
    const x = allocator(a);
    const first = (await x.next()).nonce;
    clock = T0 - 3_600_000;
    const second = (await x.next()).nonce;
    assert.equal(second, first + 1n);
    clock = T0 + 10_000;
    assert.equal((await x.next()).nonce, BigInt(T0 + 10_000));
  });

  it("clears another writer's reservation and reports the exact high-water it was reserved against", async () => {
    clock = T0;
    const a = agent();
    const x = allocator(a);
    await x.next();
    // A stand-down child on the same ledger reserves far ahead of us.
    const theirs = await store.bumpNonceHighWater(a, "live", BigInt(T0) + 500_000n);
    const r = await x.next();
    assert.deepEqual(r, { nonce: theirs + 1n, previousHighWater: theirs });
  });

  it("refuses a store that reserved less than it was asked for", async () => {
    clock = T0;
    const a = agent();
    const liar: NonceStore = { getNonceHighWater: async () => null, bumpNonceHighWater: async () => 7n };
    await assert.rejects(allocator(a, { store: liar }).next(), (e: unknown) => e instanceof NonceUnavailable && e.reason === "store-contract");
  });
});

describe("the signer's ctx and the store's row agree on one reservation", () => {
  it("signs with previousHighWater, persists under the committed nonce — and the post-reservation value is refused", async () => {
    clock = T0;
    const signer = await instantiateSigner({ now: () => clock });
    const k = signer.generateApiKey();
    const client = signer.createClient({ accountIndex: ACCOUNT, apiKeyIndex: KEY, privateKey: k.privateKey, apiPublicKey: k.publicKey });
    const a = agent();
    const x = allocator(a);

    const r = await x.next();
    const signed = client.signCancelAllOrders({ marketId: 1 }, { accountIndex: ACCOUNT, nonce: r.nonce, nonceHighWater: r.previousHighWater });
    assert.equal(BigInt(signed.nonce), r.nonce);
    const id = await store.insertPerpOrderSubmitted({ agentId: a, mode: "live", effect: "cancel", reduceOnly: false, marketId: 1, worstNotionalMicro: 0n, signed });
    assert.ok(id);

    // The persisted high-water AFTER the reservation is the nonce itself: a
    // caller that handed the signer that would never sign anything.
    const next = await x.next();
    const persisted = await store.getNonceHighWater(a, "live");
    assert.equal(persisted, next.nonce);
    assert.throws(
      () => client.signCancelAllOrders({ marketId: 1 }, { accountIndex: ACCOUNT, nonce: next.nonce, nonceHighWater: persisted as bigint }),
      (e: unknown) => e instanceof SignerArgumentError && e.field === "ctx.nonce",
    );
    // And a nonce the ledger never reserved is refused by the store, whatever
    // the signer was told.
    const unreserved = client.signCancelAllOrders({ marketId: 1 }, { accountIndex: ACCOUNT, nonce: next.nonce + 5n, nonceHighWater: next.nonce });
    await assert.rejects(
      store.insertPerpOrderSubmitted({ agentId: a, mode: "live", effect: "cancel", reduceOnly: false, marketId: 1, worstNotionalMicro: 0n, signed: unreserved }),
      (e: unknown) => e instanceof store.PerpNotRecorded,
    );
  });
});
