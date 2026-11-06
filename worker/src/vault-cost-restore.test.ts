/**
 * THE RESTORE, AND WHAT IT DOES TO THE BOOK.
 *
 * The point of restoring a vault coin's cost is the quarantine downstream: a
 * held coin nobody can price is carried at its cost, and one carried at ZERO
 * is `unknownCost`, which makes the whole book unknown and skips the drawdown
 * breaker (index.ts). So each case here runs the restore against an in-memory
 * `cost_basis` and then the quarantine exactly as the tick builds it —
 * quarantineOf over the basis, and unknownCostOf — before and after.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { quarantineOf, unknownCostOf } from "./quarantine";
import type { SellCheck } from "./sell-lock";
import { restoreUnpricedVaultCosts, zeroCostMemo, type UnpricedVaultRestore } from "./vault-cost-restore";

const MOON = "0x00000000000000000000000000000000000000aa" as const;
const GATO = "0x436b01e41314d4b010edd24cf7c997a7d111c0ab" as const;
const RAW = 2_842_330_000_000_000_000_000n;
const PAID = 2_500_000n; // 2.5 USDG, what the vault's cost() says

const SELLABLE: SellCheck = { verdict: "sellable" };
const LOCKED: SellCheck = {
  verdict: "locked",
  pool: "0xd97ffa831A40116877918FeC2C430b77D10f0d56",
  detail: "a test sale into its pool 0xd97ffa831A40116877918FeC2C430b77D10f0d56 was refused, while a plain transfer of the same amount went through",
};

/** The tick's own arithmetic: quarantine over cost_basis, then the coins with no cost on record. */
function book(basis: Map<string, { qtyRaw: bigint; costUsdg: bigint }>, unpriced: string[]) {
  const q = quarantineOf(unpriced, (s) => basis.get(s)?.costUsdg ?? 0n, () => undefined);
  return { costOf: Object.fromEntries(q.holdings.map((h) => [h.symbol, h.costUsdg])), unknownCost: unknownCostOf(q) };
}

function harness(over: Partial<UnpricedVaultRestore> & { sell?: Record<string, SellCheck>; cost?: Record<string, bigint | null> } = {}) {
  const basis = new Map<string, { qtyRaw: bigint; costUsdg: bigint }>();
  const asked = { cost: 0, sell: 0, basis: 0 };
  const tokens: Record<string, `0x${string}`> = { MOON, GATO };
  const deps: UnpricedVaultRestore = {
    unpriced: ["MOON"],
    accountUnread: new Set(),
    accountHeld: new Set(),
    tokenOf: (s) => tokens[s],
    vaultRawOf: () => RAW,
    readBasis: async (s) => {
      asked.basis++;
      return basis.get(s) ?? { qtyRaw: 0n, costUsdg: 0n };
    },
    sellCheck: async (token) => {
      asked.sell++;
      return over.sell?.[token] ?? SELLABLE;
    },
    vaultCost: async (token) => {
      asked.cost++;
      const c = over.cost?.[token];
      return c === undefined ? PAID : c;
    },
    setBasis: async (s, b) => {
      basis.set(s, b);
    },
    ...over,
  };
  return { basis, asked, deps };
}

describe("restoreUnpricedVaultCosts — what it does to the quarantine", () => {
  it("A SELLABLE VAULT COIN WITH NO BASIS GETS THE VAULT'S COST: the quarantine carries it at cost and the book is whole again", async () => {
    const { basis, deps } = harness();
    assert.deepEqual(book(basis, ["MOON"]), { costOf: { MOON: 0n }, unknownCost: ["MOON"] }, "before: carried at zero, the book unknown");
    const out = await restoreUnpricedVaultCosts(deps);
    assert.deepEqual(out, [{ symbol: "MOON", result: "restored", costUsdg: PAID }]);
    assert.deepEqual(basis.get("MOON"), { qtyRaw: RAW, costUsdg: PAID }, "the vault's own balance, at the vault's own cost");
    assert.deepEqual(book(basis, ["MOON"]), { costOf: { MOON: PAID }, unknownCost: [] }, "after: carried at cost, no unknown");
  });

  it("A SELL-LOCKED COIN IS NEVER REBOOKED AT COST (GATO): it stays unknown, the breaker stays honest, and cost() is not even read", async () => {
    const { basis, asked, deps } = harness({ unpriced: ["GATO"], sell: { [GATO]: LOCKED } });
    const out = await restoreUnpricedVaultCosts(deps);
    assert.equal(out[0]!.result, "not-sellable");
    assert.match(out[0]!.detail ?? "", /test sale into its pool .* was refused/);
    assert.equal(basis.size, 0);
    assert.equal(asked.cost, 0);
    assert.deepEqual(book(basis, ["GATO"]).unknownCost, ["GATO"]);
  });

  it("a sale that could not be shown is the same: nothing is restored on an unknown", async () => {
    const { basis, deps } = harness({ sell: { [MOON]: { verdict: "unknown", transient: true, detail: "a test sale could not be run (HTTP 429)" } } });
    assert.equal((await restoreUnpricedVaultCosts(deps))[0]!.result, "not-sellable");
    assert.deepEqual(book(basis, ["MOON"]).unknownCost, ["MOON"]);
  });

  it("#384: NEVER FROM A PARTIAL BALANCE — a coin whose ACCOUNT row is unread seeds nothing, and nothing is read for it", async () => {
    const { basis, asked, deps } = harness({ accountUnread: new Set(["MOON"]) });
    assert.equal((await restoreUnpricedVaultCosts(deps))[0]!.result, "account-unread");
    assert.equal(basis.size, 0);
    assert.deepEqual(asked, { cost: 0, sell: 0, basis: 0 });
  });

  it("a coin the account holds too is left alone, as the priced restore leaves it: the vault's cost is only the vault's half", async () => {
    const { basis, deps } = harness({ accountHeld: new Set(["MOON"]) });
    assert.equal((await restoreUnpricedVaultCosts(deps))[0]!.result, "account-holds");
    assert.equal(basis.size, 0);
  });

  it("#384: A FAILED cost() READ SEEDS NOTHING, never a zero — the next tick asks again", async () => {
    const { basis, deps } = harness({ cost: { [MOON]: null } });
    assert.equal((await restoreUnpricedVaultCosts(deps))[0]!.result, "cost-unread");
    assert.equal(basis.has("MOON"), false);
    assert.deepEqual(book(basis, ["MOON"]).unknownCost, ["MOON"]);
  });

  it("A FAILED BASIS LOOKUP SEEDS NOTHING: readBasis throws, and a vault figure must not overwrite a basis nobody could read", async () => {
    const { basis, asked, deps } = harness({
      readBasis: async () => {
        throw new Error("SQLITE_BUSY");
      },
    });
    assert.equal((await restoreUnpricedVaultCosts(deps))[0]!.result, "basis-unread");
    assert.equal(basis.size, 0);
    assert.equal(asked.cost + asked.sell, 0);
  });

  it("a basis already on record always wins", async () => {
    const { basis, asked, deps } = harness();
    basis.set("MOON", { qtyRaw: RAW, costUsdg: 1_000_000n });
    assert.equal((await restoreUnpricedVaultCosts(deps))[0]!.result, "has-basis");
    assert.deepEqual(basis.get("MOON"), { qtyRaw: RAW, costUsdg: 1_000_000n });
    assert.equal(asked.cost + asked.sell, 0);
  });

  it("a coin the vault never paid for (cost() is zero) is not given a cost", async () => {
    const { basis, deps } = harness({ cost: { [MOON]: 0n } });
    assert.equal((await restoreUnpricedVaultCosts(deps))[0]!.result, "cost-zero");
    assert.equal(basis.size, 0);
  });

  it("each coin is judged on its own: a locked one does not stop a sellable one", async () => {
    const { basis, deps } = harness({ unpriced: ["GATO", "MOON"], sell: { [GATO]: LOCKED } });
    const out = await restoreUnpricedVaultCosts(deps);
    assert.deepEqual(out.map((o) => o.result), ["not-sellable", "restored"]);
    assert.deepEqual(book(basis, ["GATO", "MOON"]), { costOf: { GATO: 0n, MOON: PAID }, unknownCost: ["GATO"] });
  });
});

describe("zeroCostMemo", () => {
  it("a zero is not asked again inside its window; a failed read is never remembered", async () => {
    let t = 0;
    let reads = 0;
    let answer: bigint | null = 0n;
    const memo = zeroCostMemo(600_000, () => t);
    const read = () => memo(`vault|${MOON}`, async () => (reads++, answer));
    assert.equal(await read(), 0n);
    assert.equal(await read(), 0n);
    assert.equal(reads, 1);
    t += 600_001;
    answer = null;
    assert.equal(await read(), null);
    assert.equal(await read(), null);
    assert.equal(reads, 3, "a failure is asked again");
    answer = PAID;
    assert.equal(await read(), PAID);
  });
});

describe("index.ts wiring", () => {
  const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const at = SRC.indexOf("restoreUnpricedVaultCosts({");
  it("RUNS IN THE VAULT MERGE, before the quarantine reads its costs", () => {
    assert.ok(at > 0, "the restore is called");
    assert.ok(SRC.lastIndexOf("for (const p of custodyRead.positions)", at) > 0, "inside the vault merge, after the priced restore");
    assert.ok(SRC.indexOf("const quarantine = quarantineOf(", at) > at, "before the quarantine");
    assert.ok(SRC.indexOf("unknownCostOf(quarantine)", at) > at, "and the tick's unknownCost is the tested helper");
  });
  it("reads the THROWING basis lookup, asks the sale on the vault's own holding, and takes the account side from before the merge", () => {
    const call = SRC.slice(at, SRC.indexOf("for (const r of restored)", at));
    assert.ok(call.length > 0 && call.length < 4000, "the call, and only the call");
    assert.match(call, /readBasis\(agentId, "live", symbol\)/);
    assert.doesNotMatch(call, /getBasis/);
    assert.match(call, /heldRaw: raw/, "the chain's own state, no override");
    assert.match(call, /accountUnread/);
    assert.match(call, /accountHeld/);
    const merge = SRC.slice(SRC.lastIndexOf("const accountUnread = new Set(posRead.unreadBalances);", at), at);
    const held = merge.indexOf("const accountHeld = new Set(");
    assert.ok(held > 0 && held < merge.indexOf("for (const p of custodyRead.positions)"), "the account's own holdings, before the vault's are merged into them");
  });
});
