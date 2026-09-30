/**
 * AN EXIT IS NAMED BY WHAT ITS BUY CALLED THE COIN.
 *
 * A held coin drops off the tape's qualified list, and discovery then labels it
 * with its own id — so every exit and review of it was written unnamed and
 * published "sell TA151B4A9E1B 5.01 USDG" (live feed, 2026-09-23). The name its
 * buy used is still in this agent's ledger, and `displayNameFor` is the one
 * place the writer asks for it. These drive the real store.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-decision-names-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const COIN = "TA151B4A9E1B";

test("AN EXIT WRITTEN AFTER THE TAPE FORGOT THE COIN IS NAMED BY WHAT THE BUY CALLED IT", async () => {
  await store.addDecision({ id: "buy-named", agent_id: AGENT, source: "brain", symbol: COIN, action: "buy", display_name: "CASHCAT" });
  // Another agent calls the same id something else. It must never leak across.
  await store.addDecision({ id: "other-named", agent_id: OTHER, source: "brain", symbol: COIN, action: "buy", display_name: "IMPOSTOR" });
  // The tape has nothing for it any more — the caller's own lookup came back null.
  assert.equal(await store.displayNameFor(AGENT, COIN, null), "CASHCAT");
  assert.equal(await store.displayNameFor(OTHER, COIN, null), "IMPOSTOR");
});

test("the tape's own name wins when it has one", async () => {
  assert.equal(await store.displayNameFor(AGENT, COIN, "CASHCAT2"), "CASHCAT2");
});

test("a coin nobody named stays unnamed, and a stock is never looked up", async () => {
  assert.equal(await store.displayNameFor(AGENT, "TFFFFFFFFFFF", null), null);
  // A stock's name is its ticker. Even a (malformed) named row for it must not
  // turn "TSLA" into something else: the lookup is only for address-derived ids.
  await store.addDecision({ id: "stock-named", agent_id: AGENT, source: "brain", symbol: "TSLA", action: "hold", display_name: "Tesla" });
  assert.equal(await store.displayNameFor(AGENT, "TSLA", null), null);
});

test("TWO NAMES IN ONE SECOND: the same answer whichever row was written first", async () => {
  // `at` is whole seconds, so a buy and its review, or two reviews, routinely
  // share one. `ORDER BY at DESC LIMIT 1` alone then returns whichever row the
  // engine happens to reach first — SQLite and Postgres need not agree, and
  // neither promises the same row twice — so the name an exit was written with
  // could differ between two identical runs. The tie is broken on the name.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
  try {
    const AT = 1_800_000_000;
    for (const [coin, first, second] of [
      ["TB0B0B0B0B0B", "ZEDCOIN", "ALPHACAT"],
      ["TC0C0C0C0C0C", "ALPHACAT", "ZEDCOIN"],
    ] as const) {
      await store.addDecision({ id: `${coin}-1`, agent_id: AGENT, source: "brain", symbol: coin, action: "buy", display_name: first });
      await store.addDecision({ id: `${coin}-2`, agent_id: AGENT, source: "brain", symbol: coin, action: "hold", display_name: second });
      raw.prepare("UPDATE decisions SET at = ? WHERE symbol = ?").run(AT, coin);
    }
    assert.equal(await store.displayNameFor(AGENT, "TB0B0B0B0B0B", null), "ALPHACAT");
    assert.equal(await store.displayNameFor(AGENT, "TC0C0C0C0C0C", null), "ALPHACAT");
  } finally {
    raw.close();
  }
});

test("a newer name still wins over an older one — the tiebreak is only for a tie", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
  try {
    await store.addDecision({ id: "renamed-old", agent_id: AGENT, source: "brain", symbol: "TD0D0D0D0D0D", action: "buy", display_name: "ALPHACAT" });
    await store.addDecision({ id: "renamed-new", agent_id: AGENT, source: "brain", symbol: "TD0D0D0D0D0D", action: "hold", display_name: "ZEDCOIN" });
    raw.prepare("UPDATE decisions SET at = ? WHERE id = ?").run(1_800_000_000, "renamed-old");
    raw.prepare("UPDATE decisions SET at = ? WHERE id = ?").run(1_800_000_060, "renamed-new");
    assert.equal(await store.displayNameFor(AGENT, "TD0D0D0D0D0D", null), "ZEDCOIN");
  } finally {
    raw.close();
  }
});
