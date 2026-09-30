/**
 * A BALANCE NOBODY READ IS NOT A BALANCE OF ZERO.
 *
 * /api/grants turned every failed chain read into `0n`, so an RPC hiccup
 * reported a funded account as empty — and `autonomyOf` answers an empty
 * account with "Add funds". An owner holding $500 was told to deposit because
 * our node did not answer. These drive the reader with calls that fail, and
 * with calls that succeed and return zero, because the two must come out
 * different.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autonomyOf } from "@merrymen/core";
import { readGrantBalances } from "./grant-balances";
import { usdgOrNull } from "../terminal/account-read";

const refuse = () => Promise.reject(new Error("fetch failed"));
const ok = (result: bigint) => ({ status: "success" as const, result });
const failed = { status: "failure" as const, error: new Error("execution reverted") };

describe("the agent's chain balances", () => {
  it("are null, not zero, when the chain did not answer", async () => {
    const b = await readGrantBalances({ eth: refuse, tokens: refuse });
    assert.deepEqual(b, { ethWei: null, cashUsdg: null, vaultUsdg: null });
  });

  it("keep a measured zero as zero", async () => {
    const b = await readGrantBalances({
      eth: async () => 0n,
      tokens: async () => [ok(0n), ok(0n)],
    });
    assert.deepEqual(b, { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" });
  });

  it("null only the call that failed inside a batch that answered", async () => {
    const b = await readGrantBalances({
      eth: async () => 12n,
      tokens: async () => [failed, ok(250_000_000n)],
    });
    assert.deepEqual(b, { ethWei: "12", cashUsdg: null, vaultUsdg: "250000000" });
  });

  it("refuse a 'success' that carried no number", async () => {
    const b = await readGrantBalances({
      eth: async () => 1n,
      tokens: async () => [{ status: "success" as const, result: undefined }, ok(1n)],
    });
    assert.equal(b.cashUsdg, null);
  });

  it("so an unread balance never tells a funded owner to add funds", async () => {
    // The whole reason this matters, end to end: route → shell → verdict.
    const unread = await readGrantBalances({ eth: refuse, tokens: refuse });
    const idle = autonomyOf({ mode: "idle", liveBlocker: null, realCashUsd: usdgOrNull(unread.cashUsdg) });
    assert.equal(idle.action, null, "no 'Add funds' on a balance we could not read");
    const paper = autonomyOf({ mode: "paper", liveBlocker: null, realCashUsd: usdgOrNull(unread.cashUsdg) });
    assert.equal(paper.action, null);

    // …while a balance that WAS read as empty still gets the button.
    const empty = await readGrantBalances({ eth: async () => 0n, tokens: async () => [ok(0n), ok(0n)] });
    const bare = autonomyOf({ mode: "idle", liveBlocker: null, realCashUsd: usdgOrNull(empty.cashUsdg) });
    assert.equal(bare.action?.kind, "add-funds");
  });
});

describe("the route's own calls", () => {
  // The route built these thunks itself, so re-adding `.catch(() => 0n)` inside
  // its `eth` call was invisible to every test. It passes its client now, and
  // this runs the real calls against one that refuses.
  const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;

  it("a client that cannot reach the chain yields nulls, never zeros", async () => {
    const { readGrantBalancesFrom } = await import("./grant-balances");
    const b = await readGrantBalancesFrom({ getBalance: refuse, multicall: refuse }, ACCOUNT);
    assert.deepEqual(b, { ethWei: null, cashUsdg: null, vaultUsdg: null });
  });

  it("asks about the agent's account, and keeps what the chain said", async () => {
    const { readGrantBalancesFrom } = await import("./grant-balances");
    const asked: string[] = [];
    const b = await readGrantBalancesFrom(
      {
        getBalance: async ({ address }) => {
          asked.push(`eth:${address}`);
          return 0n;
        },
        multicall: async ({ contracts }) => {
          for (const c of contracts) asked.push(`${c.functionName}:${c.args[0]}`);
          return [ok(0n), failed];
        },
      },
      ACCOUNT,
    );
    assert.deepEqual(b, { ethWei: "0", cashUsdg: "0", vaultUsdg: null });
    assert.deepEqual(asked, [`eth:${ACCOUNT}`, `balanceOf:${ACCOUNT}`, `balanceOf:${ACCOUNT}`]);
  });
});
