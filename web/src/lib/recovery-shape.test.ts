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

/**
 * THE CLASS VAULT SWEEP, AND WHY THE RELAY MAY CARRY IT.
 *
 * The hosted relay could never carry one: `isRecoveryShape` admitted only ERC-20
 * `transfer()` and one native leg, so a `sweep(address)` on the vault was
 * refused as "a call this relay cannot decode as an ERC-20 transfer". That is
 * why Shogun's DOGGOS sat in its vault through two recovery attempts — the first
 * skipped the leg silently, the second failed loudly once the leg was made
 * mandatory.
 *
 * `PonsClassVault.sweep` takes NO recipient. It pays `owner`, fixed at
 * construction to the smart account, and is gated by `only`. So a relayed sweep
 * moves tokens between two addresses the same owner already controls — strictly
 * less power than the `transfer()` legs above, which do name a destination.
 *
 * It is pinned anyway, to the vault named in the ticket's hmac-signed body.
 */
const VAULT = "0x3fcdde6e011769ca05f0115f1543290862473216" as const;
const DOGGOS = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461" as const;
const SWEEP_ABI = [
  {
    type: "function",
    name: "sweep",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;
const sweep = (token: `0x${string}`) =>
  encodeFunctionData({ abi: SWEEP_ABI, functionName: "sweep", args: [token] });

describe("the class vault sweep", () => {
  it("IS CARRIED when it targets the vault this ticket names", async () => {
    const cd = await batch([
      { to: VAULT, value: 0n, data: sweep(DOGGOS) },
      { to: VAULT, value: 0n, data: sweep(USDG) },
    ]);
    const v = isRecoveryShape(cd, { classVault: VAULT });
    assert.equal(v.ok, true, v.ok ? "" : v.why);
    assert.equal(v.ok && v.classSweep, true, "and is reported as the vault shape, not a transfer");
    assert.equal(v.ok && v.tokenLegs, 2, "both assets");
  });

  it("and as a SINGLE call too, since one token is not a batch", async () => {
    const cd = await single({ to: VAULT, value: 0n, data: sweep(DOGGOS) });
    assert.equal(isRecoveryShape(cd, { classVault: VAULT }).ok, true);
  });

  it("IS REFUSED when the ticket names no vault", async () => {
    // The default. Most owners have no class vault, and a ticket that does not
    // name one must not bless a sweep at any address.
    const cd = await batch([{ to: VAULT, value: 0n, data: sweep(DOGGOS) }]);
    const v = isRecoveryShape(cd, {});
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.why, /does not name a class vault/);
  });

  it("IS REFUSED when aimed at a vault that is not this account's", async () => {
    // The pin. Without it a ticket holder could call sweep(address) on any
    // contract that happens to have that selector.
    const cd = await batch([{ to: OTHER, value: 0n, data: sweep(DOGGOS) }]);
    const v = isRecoveryShape(cd, { classVault: VAULT });
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.why, /other than this account's own class vault/);
  });

  it("IS REFUSED when it carries native value", async () => {
    const cd = await batch([{ to: VAULT, value: 1n, data: sweep(DOGGOS) }]);
    assert.equal(isRecoveryShape(cd, { classVault: VAULT }).ok, false);
  });

  it("IS REFUSED when mixed with a transfer", async () => {
    // The two shapes are two operations by design — planClassSweep explains
    // why. Allowing them together would widen one allowance into two.
    const cd = await batch([
      { to: VAULT, value: 0n, data: sweep(DOGGOS) },
      { to: USDG, value: 0n, data: xfer(DEST, 5n) },
    ]);
    const v = isRecoveryShape(cd, { classVault: VAULT });
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.why, /cannot be mixed/);
  });

  it("IS REFUSED when the selector is right but the arguments are not", async () => {
    // Four bytes are not a function. A longer payload wearing the same prefix
    // is a different call.
    const cd = await batch([{ to: VAULT, value: 0n, data: `${sweep(DOGGOS)}deadbeef` as `0x${string}` }]);
    assert.equal(isRecoveryShape(cd, { classVault: VAULT }).ok, false);
  });

  it("and an ordinary withdrawal is unaffected by any of this", async () => {
    // The regression that would hurt most people: the class allowance must not
    // change what a plain sweep of USDG and ETH is allowed to do.
    const cd = await batch([
      { to: USDG, value: 0n, data: xfer(DEST, 318_000000n) },
      { to: DEST, value: 4_000_000_000_000_000n, data: "0x" },
    ]);
    const v = isRecoveryShape(cd, { classVault: VAULT });
    assert.equal(v.ok, true, v.ok ? "" : v.why);
    assert.equal(v.ok && v.classSweep, false);
  });
});
