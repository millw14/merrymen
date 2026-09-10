/**
 * Decoded against the SHARED ABI, never eyeballed.
 *
 * The wall derives its pinned selector and its argument offsets from the same
 * constants these builders encode with, so a decode is the only check that
 * actually proves the call the policy matches is the call that gets sent. A
 * hand-written hex comparison would pass while matching nothing on chain.
 */
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress } from "viem";
import { describe, it } from "node:test";
import {
  buildClassBuyCalls,
  buildClassSellCalls,
  buildClassVaultDeployCall,
} from "./pons-class";
import {
  PONS_CLASS_VAULT_ABI,
  PONS_CLASS_VAULT_FACTORY_DEPLOY_ABI,
} from "../../../packages/core/src/index";

const VAULT = "0x00000000000000000000000000000000000000c0" as const;
const FACTORY = "0x00000000000000000000000000000000000000fa" as const;
const CURVE = "0x00000000000000000000000000000000000000c3" as const;
const USDG = "0x0000000000000000000000000000000000000dd0" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
/** The ERC-20 approve selector, so a stray approve can be spotted by shape. */
const APPROVE_SELECTOR = "0x095ea7b3";

const buy = (over: Partial<Parameters<typeof buildClassBuyCalls>[0]> = {}) =>
  buildClassBuyCalls({
    vault: VAULT,
    curve: CURVE,
    quoteAsset: USDG,
    quoteInRaw: 25_000_000n,
    minTokensOutRaw: 1n,
    deadline: 1_800_000_000n,
    ...over,
  });

const sell = (over: Partial<Parameters<typeof buildClassSellCalls>[0]> = {}) =>
  buildClassSellCalls({
    vault: VAULT,
    curve: CURVE,
    tokensInRaw: 400n * 10n ** 18n,
    minQuoteOutRaw: 1n,
    deadline: 1_800_000_000n,
    ...over,
  });

describe("a class buy is approve-then-buy, in that order", () => {
  it("emits exactly two calls, to the quote asset then the vault", () => {
    const calls = buy();
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.to, USDG);
    assert.equal(calls[1]!.to, VAULT);
  });

  it("THE APPROVE NAMES THE VAULT, not an adapter", () => {
    // The likeliest copy-paste from pons-trade.ts, and it would approve the
    // wrong spender while looking entirely correct.
    const { args } = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ type: "bool" }],
        },
      ] as const,
      data: buy()[0]!.data,
    });
    // getAddress on both sides: viem decodes to EIP-55 checksummed form, and a
    // case mismatch here would be a test failing for the wrong reason.
    assert.equal(getAddress((args as readonly string[])[0]!), getAddress(VAULT));
    assert.equal((args as readonly unknown[])[1], 25_000_000n);
  });

  it("approves the exact trade size, never the maximum", () => {
    const { args } = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ type: "bool" }],
        },
      ] as const,
      data: buy({ quoteInRaw: 7n })[0]!.data,
    });
    assert.equal((args as readonly unknown[])[1], 7n);
    assert.notEqual((args as readonly unknown[])[1], 2n ** 256n - 1n);
  });

  it("the buy's five words are in the order the wall pins", () => {
    // args[1] is the funding leg and the ONLY word the policy constrains. A
    // reordering would put an unpinned value in a pinned slot and vice versa —
    // and the encoding would still be valid, so nothing else would notice.
    const { functionName, args } = decodeFunctionData({
      abi: PONS_CLASS_VAULT_ABI,
      data: buy()[1]!.data,
    });
    assert.equal(functionName, "buy");
    const a = args as readonly unknown[];
    assert.equal(getAddress(a[0] as string), getAddress(CURVE));
    assert.equal(getAddress(a[1] as string), getAddress(USDG), "word 1 is the funding leg the wall pins");
    assert.deepEqual([a[2], a[3], a[4]], [25_000_000n, 1n, 1_800_000_000n]);
  });

  it("every call carries value 0, which is what keeps valueLimit 0 true", () => {
    for (const c of buy()) assert.equal(c.value, 0n);
  });
});

describe("a class sell is ONE call, and that is the whole point", () => {
  it("emits exactly one call", () => {
    // If this ever returns two, the class route has no exit: an approve's
    // target is the token contract, the wall has no permission for a token
    // nobody enumerated, and a refused call reverts the whole UserOp.
    assert.equal(sell().length, 1);
  });

  it("and contains no approve anywhere, by selector", () => {
    // Catches it even if someone merges the approve into the same call array.
    assert.ok(!sell().some((c) => c.data.startsWith(APPROVE_SELECTOR)));
  });

  it("decodes to sell with FOUR words — no asset legs at all", () => {
    // The class token is not an argument. A six-word tradeExactIn shape here
    // would be a different selector and would match no permission on chain.
    const { functionName, args } = decodeFunctionData({
      abi: PONS_CLASS_VAULT_ABI,
      data: sell()[0]!.data,
    });
    assert.equal(functionName, "sell");
    assert.equal((args as readonly unknown[]).length, 4);
    const a = args as readonly unknown[];
    assert.equal(getAddress(a[0] as string), getAddress(CURVE));
    assert.deepEqual([a[1], a[2], a[3]], [400n * 10n ** 18n, 1n, 1_800_000_000n]);
  });
});

describe("uint256, not uint128 — the guard that must NOT be copied over", () => {
  it("accepts a size beyond uint128 rather than refusing it", () => {
    // pons-trade.ts's checked128 is correct for ITS ABI. Copying it here would
    // refuse trades the chain accepts — a mirror stricter than the chain, in
    // the encoder, where nothing else would ever look for it. An 18dp token
    // with a large supply reaches these numbers ordinarily.
    const big = 2n ** 128n;
    assert.doesNotThrow(() => buy({ quoteInRaw: big, minTokensOutRaw: big }));
    const { args } = decodeFunctionData({
      abi: PONS_CLASS_VAULT_ABI,
      data: buy({ quoteInRaw: big, minTokensOutRaw: big })[1]!.data,
    });
    assert.equal((args as readonly unknown[])[2], big, "the value must survive the round trip exactly");
    assert.equal((args as readonly unknown[])[3], big);
  });

  it("the sell takes a beyond-uint128 quantity too", () => {
    const big = 2n ** 130n;
    assert.doesNotThrow(() => sell({ tokensInRaw: big }));
  });
});

describe("what the builders refuse before anything is signed", () => {
  it("a non-positive size", () => {
    assert.throws(() => buy({ quoteInRaw: 0n }), /positive/);
    assert.throws(() => sell({ tokensInRaw: -1n }), /positive/);
  });

  it("a zero floor — STRICTER than the adapter path, on purpose", () => {
    // The adapter tolerates one because the wall pins both its asset legs. Here
    // the output leg is un-enumerated by design, so the floor is the only thing
    // between this trade and a token nobody vouched for.
    assert.throws(() => buy({ minTokensOutRaw: 0n }), /minTokensOutRaw/);
    assert.throws(() => sell({ minQuoteOutRaw: 0n }), /minQuoteOutRaw/);
  });

  it("a native-quoted curve, before it can approve into nothing", () => {
    // A CALL to a codeless address SUCCEEDS with empty returndata, so the
    // approve would appear to work and the vault would revert afterwards having
    // already spent the gas.
    assert.throws(
      () => buy({ quoteAsset: "0x0000000000000000000000000000000000000000" }),
      /native/i,
    );
  });

  it("a curve that is the vault itself", () => {
    assert.throws(() => buy({ curve: VAULT }), /own curve/);
  });
});

describe("the deploy call", () => {
  it("targets the factory and names this account as owner", () => {
    const call = buildClassVaultDeployCall(FACTORY, ACCOUNT);
    assert.equal(call.to, FACTORY);
    assert.equal(call.value, 0n);
    const { functionName, args } = decodeFunctionData({
      abi: PONS_CLASS_VAULT_FACTORY_DEPLOY_ABI,
      data: call.data,
    });
    assert.equal(functionName, "deploy");
    // The wall pins this word EQUAL to the account. An encoder that sent
    // anything else would be refused — which is the correct outcome, and this
    // asserts we never build the refused call in the first place.
    assert.equal((args as readonly unknown[]).length, 1);
    assert.equal(getAddress((args as readonly string[])[0]!), getAddress(ACCOUNT));
  });
});
