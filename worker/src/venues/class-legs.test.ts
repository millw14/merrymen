/**
 * THE FILTERS THAT RUN BEFORE ANY RPC, and the one that reads depth honestly.
 *
 * This reader cannot reuse the reserves the tick already paid for — a class
 * token is never in `watchTokens`, so it is never in `lastCurveLegs` — which
 * makes every candidate that survives the free filters cost an eth_call. Half
 * these tests are about NOT spending one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readClassLegs, type ClassCandidate } from "./class-legs";

const USDG = "0x0000000000000000000000000000000000000dd0" as const;
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const THRESHOLD = 10_000_000_000n; // 10,000 USDG at 6dp
const SEED = (THRESHOLD * 40n) / 100n;

const candidate = (over: Partial<ClassCandidate> = {}): ClassCandidate => ({
  token: "0x0000000000000000000000000000000000000ee0",
  symbol: "PEPE",
  decimals: 18,
  curve: "0x00000000000000000000000000000000000000c3",
  quoteToken: USDG,
  graduationThresholdRaw: THRESHOLD,
  ...over,
});

/** Counts calls so "was an RPC spent" is a testable question. */
function client(reserves: { quoteRaw: bigint; tokenRaw: bigint } | Error) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      call: async (p: { to: string }) => {
        calls.push(p.to);
        if (reserves instanceof Error) throw reserves;
        const hex = (v: bigint) => v.toString(16).padStart(64, "0");
        return { data: `0x${hex(reserves.quoteRaw)}${hex(reserves.tokenRaw)}` };
      },
    } as never,
  };
}

const live = { quoteRaw: SEED + 5_000_000_000n, tokenRaw: 1_000n * 10n ** 18n };

describe("the free filters spend no RPC", () => {
  it("a native-quoted launch is refused without a call", async () => {
    // 53.6% of the launchpad. The vault refuses these by name and every wall
    // permission carries valueLimit 0, so the account cannot send native value.
    const c = client(live);
    const out = await readClassLegs({
      client: c.client,
      candidates: [candidate({ quoteToken: NATIVE })],
      usdg: USDG,
      minRealDepthUsdg: 0n,
      maxReads: 10,
    });
    assert.deepEqual(out.legs, []);
    assert.equal(c.calls.length, 0, "a refusal that needs no chain must not touch it");
    assert.match(out.refused[0]!.reason, /native/i);
  });

  it("a launch quoted in something other than USDG is refused without a call", async () => {
    const c = client(live);
    const out = await readClassLegs({
      client: c.client,
      candidates: [candidate({ quoteToken: "0x00000000000000000000000000000000000000aa" })],
      usdg: USDG,
      minRealDepthUsdg: 0n,
      maxReads: 10,
    });
    assert.equal(c.calls.length, 0);
    assert.match(out.refused[0]!.reason, /second hop/);
  });

  it("a launch with no threshold on record is refused without a call", async () => {
    // Without it the virtual seed cannot be subtracted, so no depth figure for
    // that curve is real — reading it would produce a number that looks like
    // money and is not.
    const c = client(live);
    const out = await readClassLegs({
      client: c.client,
      candidates: [candidate({ graduationThresholdRaw: 0n })],
      usdg: USDG,
      minRealDepthUsdg: 0n,
      maxReads: 10,
    });
    assert.equal(c.calls.length, 0);
    assert.match(out.refused[0]!.reason, /threshold/);
  });

  it("maxReads bounds the chain calls, not the candidate list", async () => {
    const c = client(live);
    await readClassLegs({
      client: c.client,
      candidates: [candidate(), candidate({ symbol: "B" }), candidate({ symbol: "C" })],
      usdg: USDG,
      minRealDepthUsdg: 0n,
      maxReads: 2,
    });
    assert.equal(c.calls.length, 2);
  });
});

describe("depth is REAL depth", () => {
  it("a curve holding only its virtual seed reports nothing and is refused", async () => {
    // The confusion pons-price.ts records having already been made once: the
    // quote reserve includes a seed worth 40% of the threshold, which nobody
    // can sell into.
    const c = client({ quoteRaw: SEED, tokenRaw: 1_000n * 10n ** 18n });
    const out = await readClassLegs({
      client: c.client,
      candidates: [candidate()],
      usdg: USDG,
      minRealDepthUsdg: 250_000_000n,
      maxReads: 10,
    });
    assert.deepEqual(out.legs, []);
    assert.match(out.refused[0]!.reason, /virtual seed/);
  });

  it("and one holding real money above the floor becomes a leg", async () => {
    const c = client(live);
    const out = await readClassLegs({
      client: c.client,
      candidates: [candidate()],
      usdg: USDG,
      minRealDepthUsdg: 250_000_000n,
      maxReads: 10,
    });
    assert.equal(out.legs.length, 1);
    assert.equal(out.legs[0]!.symbol, "PEPE");
  });

  it("a graduated curve is refused — it reads like a fresh launch and is not", async () => {
    // Graduation RESETS the reserves, so a graduated curve looks brand new
    // while its real market has moved to a pool.
    const c = client({ quoteRaw: SEED + 5_000_000_000n, tokenRaw: 0n });
    const out = await readClassLegs({
      client: c.client,
      candidates: [candidate()],
      usdg: USDG,
      minRealDepthUsdg: 0n,
      maxReads: 10,
    });
    assert.deepEqual(out.legs, []);
    assert.match(out.refused[0]!.reason, /graduated/);
  });
});

describe("one bad curve does not take the pass down", () => {
  it("an unreadable curve refuses that candidate and no other", async () => {
    // Unlike the custody read, nothing here is destructive and the remaining
    // candidates are still honestly readable — so this fails per-candidate
    // rather than per-pass.
    let n = 0;
    const flaky = {
      call: async (p: { to: string }) => {
        void p;
        if (n++ === 0) throw new Error("rpc");
        const hex = (v: bigint) => v.toString(16).padStart(64, "0");
        return { data: `0x${hex(live.quoteRaw)}${hex(live.tokenRaw)}` };
      },
    } as never;
    const out = await readClassLegs({
      client: flaky,
      candidates: [candidate({ symbol: "BAD" }), candidate({ symbol: "GOOD" })],
      usdg: USDG,
      minRealDepthUsdg: 0n,
      maxReads: 10,
    });
    assert.deepEqual(out.legs.map((l) => l.symbol), ["GOOD"]);
    assert.equal(out.refused.length, 1);
    assert.equal(out.refused[0]!.symbol, "BAD");
  });
});
