import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { restorePaperCheckpoint } from "./paper-checkpoint";

const ACCOUNT = "0x" + "a".repeat(40);
const LIVE_TOKEN = "0x" + "1".repeat(40);

async function world() {
  const rawShared = new DatabaseSync(":memory:"), rawChild = new DatabaseSync(":memory:");
  const shared = wrapSqlite(rawShared), child = wrapSqlite(rawChild);
  for (const db of [shared, child]) await db.exec(`
    CREATE TABLE agents(smart_account TEXT, epoch INTEGER);
    CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY, cash_usdg REAL, vault_usdg REAL, hwm_usdg REAL, shares TEXT, updated_at INTEGER);
    CREATE TABLE cost_basis(agent_id TEXT, mode TEXT, symbol TEXT, qty_raw TEXT, cost_usdg TEXT, updated_at INTEGER);
  `);
  await shared.prepare("INSERT INTO agents VALUES(?,2)").run(ACCOUNT);
  await child.prepare("INSERT INTO agents VALUES(?,2)").run(ACCOUNT);
  await shared.exec(`
    CREATE TABLE equity(id INTEGER, agent_id TEXT, epoch INTEGER, mode TEXT, at INTEGER,
      cash_usdg REAL, vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, flows_held INTEGER);
    CREATE TABLE trades(agent_id TEXT, epoch INTEGER, status TEXT, kind TEXT, created_at INTEGER);
    CREATE TABLE positions(agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, value_usdg REAL, ui_multiplier TEXT);
  `);
  // The paper mark predates the current LIVE inventory snapshot. There are
  // deliberately no paper cost-basis rows to borrow from the real book.
  await shared.prepare("INSERT INTO equity VALUES(1,?,2,'paper',100,725.13,0,0,725.13,NULL)").run(ACCOUNT.toUpperCase());
  await shared.prepare("INSERT INTO positions VALUES(?,'MU',?,'5365685809818',0.005,'1000074823219171086')").run(ACCOUNT, LIVE_TOKEN);
  await shared.prepare("INSERT INTO cost_basis VALUES(?,'live','MU','5365685809818','5026',110)").run(ACCOUNT);
  return { shared, child, close() { rawChild.close(); rawShared.close(); } };
}

test("an untouched recorded paper cash book ignores a later live inventory snapshot", async () => {
  const w = await world();
  try {
    assert.match(await restorePaperCheckpoint(w.child, w.shared, ACCOUNT), /restored/);
    const book = await w.child.prepare("SELECT cash_usdg,vault_usdg,hwm_usdg,shares FROM paper_book").get();
    assert.deepEqual({ ...(book as object) }, { cash_usdg: 725.13, vault_usdg: 0, hwm_usdg: 725.13, shares: "{}" });
    assert.equal((await w.child.prepare("SELECT COUNT(*) AS n FROM cost_basis").get() as {n:number}).n, 0);
    assert.equal((await w.shared.prepare("SELECT COUNT(*) AS n FROM equity").get() as {n:number}).n, 1, "no opening valuation or baseline is invented");
    assert.equal((await w.shared.prepare("SELECT cost_usdg FROM cost_basis WHERE mode='live'").get() as {cost_usdg:string}).cost_usdg, "5026", "real cost basis is untouched");
  } finally { w.close(); }
});

test("six-decimal cash and vault arithmetic does not require exact binary equality", async () => {
  const w = await world();
  try {
    await w.shared.exec("UPDATE equity SET cash_usdg=0.1,vault_usdg=0.2,equity_usdg=0.3,flows_held=0");
    await restorePaperCheckpoint(w.child, w.shared, ACCOUNT);
    const book = await w.child.prepare("SELECT cash_usdg,vault_usdg,shares FROM paper_book").get() as {cash_usdg:number;vault_usdg:number;shares:string};
    assert.equal(book.cash_usdg, 0.1);
    assert.equal(book.vault_usdg, 0.2);
    assert.equal(book.shares, "{}");
  } finally { w.close(); }
});

for (const [name, mutate] of [
  ["a prior paper operation in this epoch", async (w: Awaited<ReturnType<typeof world>>) => w.shared.prepare("INSERT INTO trades VALUES(?,2,'paper','vault-deposit',90)").run(ACCOUNT.toUpperCase())],
  ["a paper operation after the valuation", async (w: Awaited<ReturnType<typeof world>>) => w.shared.prepare("INSERT INTO trades VALUES(?,2,'paper','swap',101)").run(ACCOUNT)],
  ["retained paper cost basis", async (w: Awaited<ReturnType<typeof world>>) => w.shared.prepare("INSERT INTO cost_basis VALUES(?,'paper','NVDA','1000000000000000000','100000000',90)").run(ACCOUNT)],
  ["a current held valuation", async (w: Awaited<ReturnType<typeof world>>) => w.shared.exec("UPDATE equity SET flows_held=1")],
  ["positive recorded holdings", async (w: Awaited<ReturnType<typeof world>>) => w.shared.exec("UPDATE equity SET positions_usdg=0.005,equity_usdg=725.135")],
  ["an unexplained one-micro-dollar equity term", async (w: Awaited<ReturnType<typeof world>>) => w.shared.exec("UPDATE equity SET equity_usdg=725.130001")],
  ["unread recorded holdings", async (w: Awaited<ReturnType<typeof world>>) => w.shared.exec("UPDATE equity SET positions_usdg=NULL")],
] as const) {
  test(`cash-only recovery still refuses ${name}`, async () => {
    const w = await world();
    try {
      await mutate(w);
      await assert.rejects(restorePaperCheckpoint(w.child, w.shared, ACCOUNT));
      assert.equal((await w.child.prepare("SELECT COUNT(*) AS n FROM paper_book").get() as {n:number}).n, 0);
      assert.equal((await w.shared.prepare("SELECT COUNT(*) AS n FROM equity").get() as {n:number}).n, 1);
    } finally { w.close(); }
  });
}

test("old-period paper operations do not belong to an untouched current book", async () => {
  const w = await world();
  try {
    await w.shared.prepare("INSERT INTO trades VALUES(?,1,'paper','swap',150)").run(ACCOUNT);
    await restorePaperCheckpoint(w.child, w.shared, ACCOUNT);
    assert.equal((await w.child.prepare("SELECT shares FROM paper_book").get() as {shares:string}).shares, "{}");
  } finally { w.close(); }
});
