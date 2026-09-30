/**
 * readAccountBalances had no tests at all, which is how it shipped the mirror
 * image of the bug positions.ts is careful about: a failed read collapsing into
 * a zero balance that is indistinguishable from an empty wallet.
 *
 * That zero is not harmless. It writes a ~0 equity row, and every last-minus-
 * first P&L reader takes the FIRST row as its baseline — so one RPC hiccup at
 * the wrong moment misreports the account's whole return, permanently.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { readAccountBalances } from "./snapshot";

const ACCT = "0x00000000000000000000000000000000000000a1" as const;
const USDG = 6n; // decimals, for readability below
const usdg = (v: number) => BigInt(Math.round(v * 10 ** Number(USDG)));

type CallResult = { status: "success"; result: bigint } | { status: "failure"; error: Error };
const good = (v: bigint): CallResult => ({ status: "success", result: v });
const bad = (): CallResult => ({ status: "failure", error: new Error("reverted") });

/** A viem-shaped client with just the three reads readAccountBalances makes. */
function client(opts: {
  eth?: bigint | "throw";
  multi?: CallResult[] | "throw";
  convert?: bigint | "throw";
}): PublicClient {
  return {
    async getBalance() {
      if (opts.eth === "throw") throw new Error("rpc down");
      return opts.eth ?? 0n;
    },
    async multicall() {
      if (opts.multi === "throw") throw new Error("rpc down");
      return opts.multi ?? [good(0n), good(0n)];
    },
    async readContract() {
      if (opts.convert === "throw") throw new Error("rpc down");
      return opts.convert ?? 0n;
    },
  } as unknown as PublicClient;
}

describe("readAccountBalances — an unknown is never a zero", () => {
  it("a clean read reports every figure and no gaps", async () => {
    const b = await readAccountBalances(
      client({ eth: 5n, multi: [good(usdg(250)), good(0n)] }),
      ACCT,
    );
    assert.equal(b.cashUsdg, usdg(250));
    assert.equal(b.vaultUsdg, 0n);
    assert.equal(b.ethWei, 5n);
    assert.deepEqual(b.unread, []);
  });

  it("a totally failed multicall reports BOTH balances unread, not zero", async () => {
    const b = await readAccountBalances(client({ eth: 1n, multi: "throw" }), ACCT);
    assert.deepEqual(b.unread, ["cash", "vault"]);
  });

  it("a reverted cash call is unread even though the vault answered", async () => {
    const b = await readAccountBalances(client({ multi: [bad(), good(0n)] }), ACCT);
    assert.deepEqual(b.unread, ["cash"]);
  });

  it("holding shares we cannot convert marks the vault unread — the worst zero of the three", async () => {
    // Shares read fine, so the old code took the convertToAssets catch(() => 0n)
    // and silently erased the entire vault leg from equity.
    const b = await readAccountBalances(
      client({ multi: [good(usdg(10)), good(999n)], convert: "throw" }),
      ACCT,
    );
    assert.equal(b.cashUsdg, usdg(10));
    assert.deepEqual(b.unread, ["vault"]);
  });

  it("zero shares needs no conversion and is a real answer, not a gap", async () => {
    const b = await readAccountBalances(client({ multi: [good(usdg(10)), good(0n)] }), ACCT);
    assert.equal(b.vaultUsdg, 0n);
    assert.deepEqual(b.unread, []);
  });

  it("a failed ETH read is reported too — gas is spent from it", async () => {
    const b = await readAccountBalances(client({ eth: "throw" }), ACCT);
    assert.deepEqual(b.unread, ["eth"]);
  });
});

describe("readAccountBalances — the cash and the block it was read at are ONE read (docs/perps.md rule 12)", () => {
  /** A client that records the aggregate it was asked for. */
  function recording(results: CallResult[] | "throw") {
    const asked: { contracts: { address: string; functionName: string }[] }[] = [];
    const c = {
      async getBalance() {
        return 0n;
      },
      async multicall(args: { contracts: { address: string; functionName: string }[] }) {
        asked.push(args);
        if (results === "throw") throw new Error("rpc down");
        return results;
      },
      async readContract() {
        return 0n;
      },
    } as unknown as PublicClient;
    return { c, asked };
  }

  it("Multicall3.getBlockNumber rides the SAME aggregate as balanceOf, last, so the cash keeps its place", async () => {
    const { c, asked } = recording([good(usdg(42)), good(0n), good(12_345n)]);
    const b = await readAccountBalances(c, ACCT);
    assert.equal(b.cashUsdg, usdg(42));
    assert.equal(b.cashReadBlock, 12_345n);
    assert.equal(asked.length, 1, "one eth_call — one state");
    const fns = asked[0]!.contracts.map((x) => x.functionName);
    assert.deepEqual(fns, ["balanceOf", "balanceOf", "getBlockNumber"]);
    assert.equal(asked[0]!.contracts[2]!.address.toLowerCase(), "0xca11bde05977b3631167028862be2a173976ca11");
  });

  it("a block that did not read is null — never a guess — and a block without a cash pins nothing", async () => {
    assert.equal((await readAccountBalances(recording([good(usdg(42)), good(0n), bad()]).c, ACCT)).cashReadBlock, null);
    assert.equal((await readAccountBalances(recording([good(usdg(42)), good(0n)]).c, ACCT)).cashReadBlock, null, "an aggregate that did not answer for it");
    const noCash = await readAccountBalances(recording([bad(), good(0n), good(99n)]).c, ACCT);
    assert.deepEqual(noCash.unread, ["cash"]);
    assert.equal(noCash.cashReadBlock, null);
    assert.equal((await readAccountBalances(recording("throw").c, ACCT)).cashReadBlock, null);
  });
});
