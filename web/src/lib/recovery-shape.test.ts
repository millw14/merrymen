import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, erc20Abi } from "viem";
import { isRecoveryShape } from "./recovery-shape";

/**
 * THE DECODER IS PINNED AGAINST KERNEL'S OWN ENCODER, not against my idea of it.
 *
 * This validator decides whether the house relays an operation. Too strict and it
 * strands somebody's withdrawal; too loose and app.merrymen.dev becomes a free
 * transaction-submission service on the house's bundler account. Both failure
 * modes are silent, so the fixtures come from `@zerodev/sdk`'s own
 * `encodeExecuteBatchCall` / `encodeExecuteSingleCall` — the exact functions
 * `account.encodeCalls()` reaches. If Kernel changes its encoding, these fail
 * loudly rather than the gate quietly swinging open or shut.
 */

// Loaded lazily: the runner transpiles to CJS, where top-level await is not
// available. Memoised so the fixtures still come from ONE copy of the SDK.
let sdk: { batch: Function; single: Function } | null = null;
async function enc() {
  if (sdk) return sdk;
  // BY FILE URL, deliberately past the package exports map. These encoders are
  // internal to @zerodev/sdk and not exported — but they are exactly what
  // account.encodeCalls() reaches, and pinning the decoder against a
  // reimplementation would only prove the decoder agrees with itself.
  const base = new URL(
    "../../../node_modules/@zerodev/sdk/_esm/accounts/kernel/utils/ep0_7/",
    import.meta.url,
  );
  const [b, s] = await Promise.all([
    import(new URL("encodeExecuteBatchCall.js", base).href),
    import(new URL("encodeExecuteSingleCall.js", base).href),
  ]);
  sdk = { batch: (b as any).encodeExecuteBatchCall, single: (s as any).encodeExecuteSingleCall };
  return sdk;
}

const DEST = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const NVDA = "0x3333333333333333333333333333333333333333" as const;
const ROUTER = "0x4444444444444444444444444444444444444444" as const;

const xfer = (to: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

const batch = async (calls: { to: `0x${string}`; value?: bigint; data?: `0x${string}` }[]) =>
  (await enc()).batch(calls, { execType: "0x00" }, false) as `0x${string}`;
const single = async (c: { to: `0x${string}`; value?: bigint; data?: `0x${string}` }) =>
  (await enc()).single(c, { execType: "0x00" }, false) as `0x${string}`;

describe("what the relay will carry", () => {
  it("accepts the exact shape recover.ts builds — tokens then the ETH leg", async () => {
    const cd = await batch([
      { to: USDG, value: 0n, data: xfer(DEST, 318_000000n) },
      { to: NVDA, value: 0n, data: xfer(DEST, 5n) },
      { to: DEST, value: 4_000_000_000_000_000n, data: "0x" },
    ]);
    const v = isRecoveryShape(cd);
    assert.equal(v.ok, true, v.ok ? "" : v.why);
    if (!v.ok) return;
    assert.equal(v.to.toLowerCase(), DEST.toLowerCase());
    assert.equal(v.tokenLegs, 2);
    assert.equal(v.nativeLeg, true);
  });

  it("accepts a SINGLE-call sweep — which is not a batch at all", async () => {
    // encodeCallData switches on `calls.length > 1`, so sweeping one token takes
    // the packed single-call path. A decoder that only understood batches would
    // strand the simplest possible recovery.
    const v = isRecoveryShape(await single({ to: USDG, value: 0n, data: xfer(DEST, 318_000000n) }));
    assert.equal(v.ok, true, v.ok ? "" : v.why);
    if (!v.ok) return;
    assert.equal(v.to.toLowerCase(), DEST.toLowerCase());
    assert.equal(v.tokenLegs, 1);
    assert.equal(v.nativeLeg, false);
  });

  it("accepts an ETH-only sweep", async () => {
    const v = isRecoveryShape(await single({ to: DEST, value: 10n ** 15n, data: "0x" }));
    assert.equal(v.ok, true, v.ok ? "" : v.why);
    if (!v.ok) return;
    assert.equal(v.nativeLeg, true);
    assert.equal(v.tokenLegs, 0);
  });
});

describe("what it refuses — the reason this file exists", () => {
  it("REFUSES an approve, which is how a relay becomes a drain", async () => {
    const cd = await batch([
      {
        to: USDG,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, 2n ** 255n] }),
      },
    ]);
    const v = isRecoveryShape(cd);
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.match(v.why, /only transfer/);
  });

  it("REFUSES an arbitrary contract call — a swap, or anything else", async () => {
    const v = isRecoveryShape(await single({ to: ROUTER, value: 0n, data: "0x414bf389deadbeef" }));
    assert.equal(v.ok, false, "arbitrary calldata must not be relayable");
  });

  it("REFUSES legs paying DIFFERENT destinations", async () => {
    // This is what separates a withdrawal from a payment run. Without it, a
    // caller could move money to anywhere as long as every leg was a transfer.
    const cd = await batch([
      { to: USDG, value: 0n, data: xfer(DEST, 1n) },
      { to: NVDA, value: 0n, data: xfer(OTHER, 1n) },
    ]);
    const v = isRecoveryShape(cd);
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.match(v.why, /one destination/);
  });

  it("REFUSES a native leg that disagrees with the token legs", async () => {
    const cd = await batch([
      { to: USDG, value: 0n, data: xfer(DEST, 1n) },
      { to: OTHER, value: 10n ** 15n, data: "0x" },
    ]);
    assert.equal(isRecoveryShape(cd).ok, false);
  });

  it("REFUSES two native legs", async () => {
    const cd = await batch([
      { to: DEST, value: 1n, data: "0x" },
      { to: DEST, value: 2n, data: "0x" },
    ]);
    const v = isRecoveryShape(cd);
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.match(v.why, /more than one native/);
  });

  it("REFUSES a token call carrying native value", async () => {
    const cd = await batch([{ to: USDG, value: 5n, data: xfer(DEST, 1n) }]);
    assert.equal(isRecoveryShape(cd).ok, false);
  });

  it("REFUSES a delegatecall outright", async () => {
    // execMode's first byte 0xFF. Built by hand because the SDK's delegate
    // encoder takes a different argument shape, and the point is the mode byte.
    const cd = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "execute",
          inputs: [
            { name: "execMode", type: "bytes32" },
            { name: "executionCalldata", type: "bytes" },
          ],
          outputs: [],
          stateMutability: "payable",
        },
      ] as const,
      functionName: "execute",
      args: [`0xff${"00".repeat(31)}`, "0xdeadbeef"],
    });
    const v = isRecoveryShape(cd);
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.match(v.why, /delegatecall/);
  });

  it("REFUSES calldata that is not a Kernel execute at all", async () => {
    assert.equal(isRecoveryShape("0xdeadbeef").ok, false);
    assert.equal(isRecoveryShape("0x").ok, false);
  });
});
