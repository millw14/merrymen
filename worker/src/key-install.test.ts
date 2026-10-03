/**
 * A NEW KEY'S PERMISSIONS, INSTALLED ON THEIR OWN — the call and the gate.
 *
 * When a key's wall and its first trade together exceed the first-enable
 * maximum, the worker installs the key with executor.ts keyInstallCalls() and
 * sends the trade after it (index.ts installKeyAlone). The gas side is pinned in
 * first-enable-headroom.test.ts against the live refusal. This file pins the
 * two properties that make the install safe to send without anyone asking:
 *
 *   - it is ONE fixed call that moves nothing: approve(USDG, Router02, 0);
 *   - every wall the product can sign permits it, so it cannot itself be
 *     refused at the wall and leave the key uninstallable.
 *
 * And the gate: it is sent only for a key the chain says is still uninstalled.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ParamCondition } from "@zerodev/permissions/policies";
import { decodeFunctionData, erc20Abi } from "viem";
import { GasRefused, keyInstallCalls, keyInstallRefusal, perOperationGasProof } from "./executor";
import { CASH, UNISWAP, buildCallPermissions } from "../../packages/core/src/index";

const CAPS = { perTradeUsdg: 25, dailyUsdg: 100, maxOpsPerDay: 48, maxDrawdownBps: 2000, ttlDays: 14 };
const ME = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const token = (i: number) => ({
  symbol: `T${i}`,
  address: ("0x" + (i + 0x2000).toString(16).padStart(40, "0")) as `0x${string}`,
  decimals: 18,
});

type Rule = { condition: number; value: unknown } | null | undefined;
type Perm = { target: string; functionName?: string; valueLimit?: bigint; args?: readonly Rule[] };

/** Does a call permission admit this exact call? Only the conditions a wall uses. */
function admits(p: Perm, to: string, functionName: string, args: readonly unknown[], value: bigint): boolean {
  if (p.target.toLowerCase() !== to.toLowerCase() || p.functionName !== functionName) return false;
  if (value > (p.valueLimit ?? 0n)) return false;
  return (p.args ?? []).every((rule, i) => {
    if (rule === null || rule === undefined) return true;
    const a = args[i];
    switch (rule.condition) {
      case ParamCondition.ONE_OF:
        return (rule.value as string[]).some((v) => String(v).toLowerCase() === String(a).toLowerCase());
      case ParamCondition.EQUAL:
        return String(rule.value).toLowerCase() === String(a).toLowerCase();
      case ParamCondition.LESS_THAN_OR_EQUAL:
        return BigInt(a as bigint) <= BigInt(rule.value as bigint);
      default:
        throw new Error(`a condition this check does not model: ${rule.condition}`);
    }
  });
}

describe("the install is one fixed call that moves nothing", () => {
  it("approve(USDG, Router02, 0), value 0, and nothing else", () => {
    const calls = keyInstallCalls();
    assert.equal(calls.length, 1);
    const [c] = calls;
    assert.equal(c!.to.toLowerCase(), CASH.USDG.toLowerCase());
    assert.equal(c!.value, 0n);
    const d = decodeFunctionData({ abi: erc20Abi, data: c!.data });
    assert.equal(d.functionName, "approve");
    assert.equal(String(d.args[0]).toLowerCase(), UNISWAP.swapRouter02.toLowerCase());
    assert.equal(d.args[1], 0n, "an allowance can only go down");
  });

  it("is built fresh each time, so a caller cannot mutate what the next install sends", () => {
    const a = keyInstallCalls();
    (a[0] as { data: string }).data = "0xdeadbeef";
    assert.notEqual(keyInstallCalls()[0]!.data, "0xdeadbeef");
  });
});

describe("every wall the product signs permits it", () => {
  const CLASS = {
    ponsClassVaultAddress: "0x3fcdde6e011769ca05f0115f1543290862473216",
    ponsClassVaultFactoryAddress: "0x48a5603712d3d4f4e6e4e1cbd4f4f5d1c9e6ab3d",
  };
  const TRENCHER = { trencherVaultAddress: "0x" + "d".repeat(40), trencherFactoryAddress: "0x" + "e".repeat(40) };
  const V4 = { v4AdapterAddress: "0x6666666666666666666666666666666666666666" };
  const walls: Record<string, Record<string, unknown>> = {
    default: {},
    "class vault": CLASS,
    "class + Trencher": { ...CLASS, ...TRENCHER },
    "class + Trencher + v4 + coins, scoped (the live agent's shape)": {
      ...CLASS,
      ...TRENCHER,
      ...V4,
      extraTokens: [token(0), token(1), token(2)],
      scopedSpenders: true,
    },
    "Rialto and v4 opted in, energy sealed": { allowRialto: true, allowUniswapV4: true, energyBuy: true },
  };
  for (const [name, opts] of Object.entries(walls)) {
    it(name, () => {
      const perms = buildCallPermissions(CAPS as never, ME, opts as never) as unknown as Perm[];
      const [c] = keyInstallCalls();
      const d = decodeFunctionData({ abi: erc20Abi, data: c!.data });
      assert.ok(
        perms.some((p) => admits(p, c!.to, d.functionName, d.args, c!.value)),
        "some permission on this wall admits approve(USDG, Router02, 0)",
      );
    });
  }
});

describe("it is sent only for a key the chain says is still uninstalled", () => {
  it("a fresh enable may be installed", () => {
    assert.equal(keyInstallRefusal({ kind: "fresh-enable", permissionId: "0x12345678" }), null);
  });

  it("an operation that carries no enable has nothing to install, and is refused by name", () => {
    const r = keyInstallRefusal({ kind: "not-an-enable" });
    assert.ok(r instanceof GasRefused);
    assert.equal(r.rule, "enable-redundant");
    assert.match(r.message, /nothing to install/);
  });
});

describe("installation cost is proved per operation", () => {
  const txHash = `0x${"3".repeat(64)}` as `0x${string}`;
  const sponsor = "0x5555555555555555555555555555555555555555";
  const receipt = { actualGasCost: 123n, actualGasUsed: 456n, receipt: {
    transactionHash: txHash, gasUsed: 999999n, effectiveGasPrice: 888888n,
  } };
  it("uses the exact operation cost and units rather than the other operations in its bundle", () => {
    assert.deepEqual(perOperationGasProof(receipt), { txHash, gasWei: 123n, gasUnits: 456n, gasPayer: "owner" });
    assert.equal(perOperationGasProof({ ...receipt, paymaster: sponsor })!.gasPayer, "sponsor");
  });
  it("missing or malformed operation fields never fall back to bundled transaction gas", () => {
    for (const missing of [{ actualGasCost: undefined }, { actualGasUsed: undefined },
      { actualGasCost: -1n }, { actualGasUsed: -1n }, { actualGasCost: 123 }, { actualGasUsed: "456" }]) {
      assert.equal(perOperationGasProof({ ...receipt, ...missing }), null);
    }
  });
  it("an omitted receipt payer uses the immutable signed operation, and invalid payer evidence is refused", () => {
    assert.equal(perOperationGasProof(receipt, sponsor)!.gasPayer, "sponsor");
    assert.equal(perOperationGasProof({ ...receipt, paymaster: "0x0000000000000000000000000000000000000000" }, sponsor)!.gasPayer, "owner");
    assert.equal(perOperationGasProof({ ...receipt, paymaster: "bad" }), null);
  });
});
