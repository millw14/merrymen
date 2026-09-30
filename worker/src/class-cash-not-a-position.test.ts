/**
 * USDG IN THE VAULT IS CASH, AND A ROW FOR IT COSTS REAL MONEY.
 *
 * Shogun's `class_positions` carried a row keyed on `0x5fc5…d168` — the chain's
 * USDG, the asset every class position is priced IN. It had no symbol, no
 * curve, no entry transaction, no cost and no opening block, and the reconciler
 * had classified it `recovered`: a standing position, for ever.
 *
 * It was not an inert record. It:
 *   - occupied a slot under `classMaxPositions`, which with a closed round trip
 *     and a swept token made 3 of 3 and shut the entry route permanently;
 *   - offered itself to the exit producer, which cannot sell cash and warned
 *     the owner every pass that it was stuck;
 *   - took a six-hour hold clock it can never age out of;
 *   - sat in the class P&L inventory with a basis that cannot exist.
 *
 * These tests are behavioural over real sqlite wherever the public API reaches
 * the behaviour, because a guard asserted by source-match is a guard that
 * passes when somebody moves it inside `if (false)`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-cashrow-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, classPositions, upsertClassPosition, writeClassLedger } = await import("./store");
const { CASH } = await import("../../packages/core/src/index");

await initStore();
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const DOGGOS = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461";
const CURVE = "0x7d5369f126d98340d8aa88a80beeb03fc3ccff59";

describe("the writers refuse a cash row", () => {
  it("upsertClassPosition writes a real token and REFUSES the quote asset", async () => {
    await upsertClassPosition(AGENT, {
      token: DOGGOS,
      symbol: "DOGGOS",
      decimals: 18,
      curve: CURVE,
      quoteToken: CASH.USDG,
    });
    // The exact shape the reconciler offered: the cash token, with no curve and
    // no pair token, because there is no curve to read one from.
    await upsertClassPosition(AGENT, {
      token: CASH.USDG,
      symbol: null,
      decimals: 6,
      curve: null,
      quoteToken: null,
    });

    const rows = (await classPositions(AGENT)) ?? [];
    const tokens = rows.map((r) => r.token.toLowerCase());
    assert.ok(tokens.includes(DOGGOS), "a real position must still be recorded");
    assert.ok(
      !tokens.includes(CASH.USDG.toLowerCase()),
      "the vault's cash must never become a position row",
    );
  });

  it("writeClassLedger refuses it too — the OTHER producer of this table", async () => {
    // Two functions write `class_positions`. Guarding one would leave the bug
    // reachable through the other, which is the reconciler's own path.
    await writeClassLedger(AGENT, {
      token: CASH.USDG,
      vault: "0x3fcdde6e011769ca05f0115f1543290862473216",
      curve: null,
      costRaw: null,
      qtyRaw: null,
      proceedsRaw: null,
      openedAtBlock: null,
      entryTx: null,
      exitTx: null,
      state: "recovered",
      sweptRaw: null,
    });
    const rows = (await classPositions(AGENT)) ?? [];
    assert.ok(
      !rows.some((r) => r.token.toLowerCase() === CASH.USDG.toLowerCase()),
      "the ledger writer must refuse the cash token as well",
    );
  });

  it("AND STILL RECORDS A LAUNCH TOKEN THAT CALLS ITSELF USDG", async () => {
    // Address-keyed, never symbol-keyed. A deployer chooses the symbol; if the
    // guard trusted it, minting a token named USDG would exempt it from the
    // position ceiling — an attacker-controlled hole in a risk limit.
    const impostor = "0x999999999999999999999999999999999999aaaa";
    await upsertClassPosition(AGENT, {
      token: impostor,
      symbol: "USDG",
      decimals: 18,
      curve: CURVE,
      quoteToken: CASH.USDG,
    });
    const rows = (await classPositions(AGENT)) ?? [];
    assert.ok(
      rows.some((r) => r.token.toLowerCase() === impostor),
      "a token is identified by its address, not by the name it gives itself",
    );
  });
});

/**
 * The remaining exclusions live inside closures in `index.ts` and cannot be
 * reached through any exported function, so they are read from source. Each
 * assertion names the specific failure it prevents rather than pinning a shape.
 */
describe("the four places a cash row could still do damage", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("the reconciler's candidate list drops it — before anything is written", () => {
    assert.match(
      CODE,
      /const isCash = \(t: string\) => t\.toLowerCase\(\) === CASH\.USDG\.toLowerCase\(\);/,
      "address-keyed, for the reason above",
    );
    assert.match(
      CODE,
      /const candidates = \[\.\.\.new Set\(\[\.\.\.folded\.keys\(\)[\s\S]{0,80}\]\)\][\s\S]{0,40}!isCash\(t\)/,
      "folded events must not reintroduce it",
    );
  });

  it("and its CACHED list too, or a legacy row books a phantom sweep", () => {
    // `writeClassLedger` refuses the row either way, but `rec.positions` is
    // also walked to book sweeps — and a USDG entry there tells the owner they
    // swept their own cash out of the vault, at a cost it "never saw".
    assert.match(
      CODE,
      /cached: cachedRows\.map\(\(r\) => r\.token\)\.filter\(\(t\) => !isCash\(t\)\)/,
      "the cached list feeds rec.positions, which is walked for sweeps and bases",
    );
  });

  it("EXIT CONSTRUCTION skips it — you cannot sell cash", () => {
    assert.match(
      CODE,
      /if \(isQuoteTokenRow\(p\)\) continue;\s*\r?\n\s*const balance = lastClassBalances\.get\(p\.token\)/,
      "the exit loop must skip the cash row before its balance test",
    );
  });

  it("but the MONEY is still counted, by a direct balance read", () => {
    // The whole hazard of this change. Vault cash reached equity only because
    // the phantom row existed; removing the row without this would take real
    // money out of the book and deepen the drawdown against a ratcheting peak.
    assert.match(
      CODE,
      /classCashUsdg = classRead\.balances\.get\(CASH\.USDG\.toLowerCase\(\)\)/,
      "cash is a balance to read, not a position to record",
    );
    assert.match(CODE, /cashUsdg: balances\.cashUsdg \+ classCashUsdg,/, "and it joins equity");
  });
});

describe("and the P&L inventory does not ask what the cash cost", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("classHeldRows excludes it at the source, not only at the valuation", () => {
    // `classHeldRows` feeds `scoutCostOf` — the class P&L inventory — which
    // read a cash row as "a held position whose cost we cannot name". Shogun
    // printed `[class] 1 held position(s) with an unknown basis` every tick,
    // about its own USDG. The two valuation sites below it already filtered the
    // cash token; this one did not, because it was added for a different
    // question and nobody joined them up.
    assert.match(
      CODE,
      /const classHeldRows = \(classRows \?\? \[\]\)\.filter\([\s\S]{0,600}!isQuoteTokenRow\(r\) &&/,
      "the cash token must not enter the held-position inventory",
    );
  });
});
