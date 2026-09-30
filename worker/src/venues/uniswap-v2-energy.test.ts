import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  CASH,
  ENERGY_ROUTE_V1,
  ENERGY_SWAP_SELECTOR,
  UNISWAP_V2_ENERGY_ABI,
  energyCallWords,
  type EnergyRoute,
} from "../../../packages/core/src/index";
import { checkEnergySwapCalls } from "../final-fence";
import { buildEnergyCalls } from "./uniswap-v2-energy";
import { energyMinOut, grossNeededFor } from "./uniswap-v2";

const ME = "0x00000000000000000000000000000000000000a9" as const;
const IN = 7_250_000n;
const MIN = 15_000_000_000_000_000_000_000n;
const DEADLINE = 1_800_000_180n;
const build = () => buildEnergyCalls({ route: ENERGY_ROUTE_V1, amountIn: IN, minOut: MIN, recipient: ME, deadline: DEADLINE });

describe("buildEnergyCalls", () => {
  it("is [approve USDG → router for EXACTLY amountIn, the fee-on-transfer swap], no value", () => {
    const [approve, swap] = build();
    assert.equal(approve!.to.toLowerCase(), (CASH.USDG as string).toLowerCase());
    assert.equal(approve!.value, 0n);
    const a = decodeFunctionData({ abi: erc20Abi, data: approve!.data });
    assert.equal(a.functionName, "approve");
    assert.deepEqual(
      (a.args as readonly unknown[]).map((x) => (typeof x === "string" ? x.toLowerCase() : x)),
      [ENERGY_ROUTE_V1.router, IN],
    );
    assert.equal(swap!.to, ENERGY_ROUTE_V1.router);
    assert.equal(swap!.value, 0n);
    const s = decodeFunctionData({ abi: UNISWAP_V2_ENERGY_ABI, data: swap!.data });
    assert.equal(s.functionName, "swapExactTokensForTokensSupportingFeeOnTransferTokens");
    const [amountIn, minOut, path, to, deadline] = s.args as [bigint, bigint, string[], string, bigint];
    assert.equal(amountIn, IN);
    assert.equal(minOut, MIN);
    assert.deepEqual(path.map((p) => p.toLowerCase()), [...ENERGY_ROUTE_V1.path]);
    assert.equal(to.toLowerCase(), ME);
    assert.equal(deadline, DEADLINE);
  });

  it("lays out EXACTLY the words the wall pins (shared helper with wall.test.ts)", () => {
    const [, swap] = build();
    const w = energyCallWords(swap!.data)!;
    assert.equal(w.selector, ENERGY_SWAP_SELECTOR);
    assert.equal(swap!.data.length, 10 + 9 * 64, "292 bytes: selector + nine words");
    assert.equal(w.words[0], IN);
    assert.equal(w.words[1], MIN);
    assert.equal(w.words[2], 0xa0n, "the path offset the wall's w2 pin names");
    assert.equal(w.words[3], BigInt(ME));
    assert.equal(w.words[4], DEADLINE);
    assert.equal(w.words[5], 3n, "a three-hop path");
    ENERGY_ROUTE_V1.path.forEach((hop, i) => assert.equal(w.words[6 + i], BigInt(hop)));
  });

  it("passes the final fence it will meet", () => {
    assert.deepEqual(
      checkEnergySwapCalls(build(), { route: ENERGY_ROUTE_V1, recipient: ME, amountIn: IN, minOut: MIN, deadline: DEADLINE }),
      { ok: true },
    );
  });

  it("refuses to encode an intent built wrong", () => {
    const base = { route: ENERGY_ROUTE_V1, amountIn: IN, minOut: MIN, recipient: ME, deadline: DEADLINE } as const;
    assert.throws(() => buildEnergyCalls({ ...base, amountIn: 0n }), /not a size/);
    assert.throws(() => buildEnergyCalls({ ...base, amountIn: -1n }), /not a size/);
    assert.throws(() => buildEnergyCalls({ ...base, minOut: 0n }), /not a floor/);
    assert.throws(() => buildEnergyCalls({ ...base, deadline: 0n }), /not a time/);
    const wrongStart = {
      ...ENERGY_ROUTE_V1,
      path: [ENERGY_ROUTE_V1.path[1], ENERGY_ROUTE_V1.path[1], ENERGY_ROUTE_V1.path[2]],
    } as unknown as EnergyRoute;
    assert.throws(() => buildEnergyCalls({ ...base, route: wrongStart }), /not USDG/);
  });

  it("a floor built from grossNeededFor always admits what was asked for (post-tax, post-slippage)", () => {
    // The planner sizes with grossNeededFor and the executor floors with
    // energyMinOut; the round trip must never ask for less than it wanted.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 1000; i++) {
      const want = BigInt(Math.floor(rnd() * 1e9)) * 10n ** 12n + 1n;
      const tax = Math.floor(rnd() * 201);
      const slip = Math.floor(rnd() * 500);
      assert.ok(energyMinOut(grossNeededFor(want, tax, slip), tax, slip) >= want);
    }
  });
});

describe("the write side is the only side that writes", () => {
  const code = (f: string) =>
    readFileSync(new URL(f, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
  it("opens no client and sends nothing itself — the executor sends", () => {
    const src = code("./uniswap-v2-energy.ts");
    assert.doesNotMatch(src, /createPublicClient|chainRead\(|metered\(|http\(|sendUserOp|writeContract|execute\(/);
  });
  it("and the read side stays read-only (its own pin, restated so a move cannot quietly undo it)", () => {
    assert.doesNotMatch(code("./uniswap-v2.ts"), /encodeFunctionData|UNISWAP_V2_ENERGY_ABI|buildEnergyCalls/);
  });
});
