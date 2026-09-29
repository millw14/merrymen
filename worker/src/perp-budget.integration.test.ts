/**
 * A PERP OPEN IS COUNTED ONCE — after refreshBudget, and after a fresh arm
 * (docs/perps.md, "Budgets"; rule 6; the accounting finding
 * budget-counters-blind-to-perp-orders).
 *
 * The daily and ops caps are the settled halves re-read from the ledger by
 * refreshBudget plus the in-flight reservation. An L2 perp order is never a
 * `trades` row, so a settled half that read `trades` alone forgot every perp
 * open at the next refresh and at every restart — and a SECOND reader added
 * beside it would count each one twice. The store answers both in one place:
 * getSpentTodayUsdg and getOpsToday already include the perp orders. So this
 * pins the other half of that bargain: index.ts's refreshBudget REPLACES the
 * settled halves from exactly those two functions, and nothing in index.ts adds
 * the perp part again.
 *
 * refreshBudget is a closure inside main() with no export, so its shape is
 * pinned by scanning the source (the idiom budget-reservation.invariant.test.ts
 * uses), and its arithmetic is run here against a real ledger, step for step
 * in the order the perp lane takes: reserve, write the rule-9 row, refresh,
 * release.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.join(HERE, "index.ts"), "utf8");

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-budget-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
async function open(): Promise<void> {
  try {
    process.chdir(isolatedCwd);
    await store.initStore();
  } finally {
    process.chdir(originalCwd);
  }
}
await open();
after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ACCOUNT = "0xAb00000000000000000000000000000000000077";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

describe("refreshBudget is the one reader of the settled halves", () => {
  it("REPLACES both halves from getSpentTodayUsdg and getOpsToday — never adds to them", () => {
    const at = INDEX.indexOf("const refreshBudget = async (agentId: string): Promise<void> => {");
    assert.ok(at > 0, "refreshBudget must still exist where the budget lives");
    const body = INDEX.slice(at, INDEX.indexOf("\n  };", at));
    assert.match(body, /settledSpentUsdg = usdg\(await getSpentTodayUsdg\(agentId, rail, CASH\.USDG as string\)\);/);
    assert.match(body, /settledOps = await getOpsToday\(agentId, rail\);/);
    assert.doesNotMatch(body, /\+=/, "a settled half that accumulates counts every refresh again");
  });

  it("NOTHING IN index.ts ADDS THE PERP PART A SECOND TIME — the store already counts it", () => {
    // perpOpenNotionalSince / perpOpsSince are the store's perp halves, already
    // inside getSpentTodayUsdg / getOpsToday. A call here would be the second
    // call site the store's own comment warns is how a sum is counted twice.
    assert.doesNotMatch(INDEX, /perpOpenNotionalSince|perpOpsSince/);
  });
});

describe("a perp open, counted once at every step", () => {
  // The closure's state, modelled exactly: the settled halves are what the
  // ledger says; the in-flight halves are the reservation.
  let settledSpent = 0n;
  let settledOps = 0;
  let inFlightSpent = 0n;
  let inFlightOps = 0;
  const refreshBudget = async (agentId: string) => {
    settledSpent = BigInt(Math.round((await store.getSpentTodayUsdg(agentId, "live", USDG)) * 1e6));
    settledOps = await store.getOpsToday(agentId, "live");
  };
  const spentToday = () => settledSpent + inFlightSpent;
  const opsToday = () => settledOps + inFlightOps;

  it("RESERVE → WRITE THE ROW → REFRESH → RELEASE: 25 USDG and one op at every step, never 50 and never 0", async () => {
    const agentId = await store.ensureAgent({
      smartAccount: ACCOUNT,
      owner: "0x00000000000000000000000000000000000000b1",
      sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
      serialized: "x",
      caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
      grantedAt: 1_000_000,
      expiresAt: 2_000_000_000,
      chainId: 4663,
    } as never);
    await refreshBudget(agentId);
    assert.equal(spentToday(), 0n);

    // 1. Reserve before signing.
    inFlightSpent += 25_000_000n;
    inFlightOps += 1;
    assert.equal(spentToday(), 25_000_000n);
    assert.equal(opsToday(), 1);

    // 2. The rule-9 row, with a nonce committed first.
    const nonce = await store.bumpNonceHighWater(agentId, "live", BigInt(Date.now()));
    await store.insertPerpOrderSubmitted({
      agentId,
      mode: "live",
      effect: "open",
      reduceOnly: false,
      marketId: 1,
      worstNotionalMicro: 25_000_000n,
      signed: {
        txType: 28,
        txInfo: `{"Nonce":${nonce},"Sig":"c2ln"}`,
        txHash: nonce.toString(16).padStart(80, "0"),
        accountIndex: 22_149,
        apiKeyIndex: 16,
        nonce: Number(nonce),
        expiredAt: Number(nonce) + 599_000,
        clientOrderIndexes: [
          { role: "entry", clientOrderIndex: Number(nonce * 8n) },
          { role: "sl", clientOrderIndex: Number(nonce * 8n + 1n) },
        ],
      },
    });

    // 3. Refresh BEFORE the release — the order recordTrade uses, so the row
    // is in the settled half the moment the reservation leaves.
    await refreshBudget(agentId);
    assert.equal(settledSpent, 25_000_000n, "the settled half now holds the open");
    assert.equal(settledOps, 1);

    // 4. Release.
    inFlightSpent -= 25_000_000n;
    inFlightOps -= 1;
    assert.equal(spentToday(), 25_000_000n, "counted once — not the row AND the reservation");
    assert.equal(opsToday(), 1);

    // Every later tick refreshes again; a re-read is not a re-count.
    await refreshBudget(agentId);
    await refreshBudget(agentId);
    assert.equal(spentToday(), 25_000_000n);
    assert.equal(opsToday(), 1);

    // A FRESH ARM: a new process, a new connection, no in-flight state — and
    // the open is still there, once.
    store.closeStoreForTest();
    await open();
    settledSpent = 0n;
    settledOps = 0;
    inFlightSpent = 0n;
    inFlightOps = 0;
    await refreshBudget(agentId);
    assert.equal(spentToday(), 25_000_000n, "a restart forgets nothing and doubles nothing");
    assert.equal(opsToday(), 1);
  });
});
