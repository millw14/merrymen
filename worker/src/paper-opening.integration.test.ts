import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { applyPaperIntent, paperEquityUsdg } from "./paper";
import { tickPlan, tickRatchets } from "./command-wake";
import { verifyChain } from "./audit";
import { wrapSqlite } from "./db";
import { PAPER_CHECKPOINT_SCHEMA, restorePaperCheckpoint } from "./paper-checkpoint";
import { readPaperReturn } from "../../web/src/lib/paper-return";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-paper-opening-"));
const isolated = path.join(scratch, "cwd");
mkdirSync(isolated);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const store = await import("./store");
const cwd = process.cwd();
try { process.chdir(isolated); await store.initStore(); } finally { process.chdir(cwd); }
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
const db = wrapSqlite(raw);
after(() => { raw.close(); store.closeStoreForTest(); rmSync(scratch, { recursive: true, force: true }); });

let next = 0xa0;
async function ensurePaperAgent(id: string) {
  await store.ensureAgent({ smartAccount: id, owner: id, sessionKeyAddress: id, chainId: 4663,
    caps: {}, grantedAt: 1, expiresAt: 2_000_000_000, serialized: "fixture" } as never);
  await store.setAgentMode(id, "paper", 1, false);
}
async function agent() {
  const id = `0x${(next++).toString(16).padStart(40, "0")}`;
  await ensurePaperAgent(id);
  return id;
}
const count = (table: "equity" | "paper_book" | "flows", id: string) => Number(
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE LOWER(agent_id)=LOWER(?)`).get(id) as {n:number}).n,
);
const USDG = "0x0000000000000000000000000000000000000001" as const;
const TOKEN = "0x0000000000000000000000000000000000000002" as const;

/** A real fill before the first scheduled valuation, as a command tick allows. */
async function buy(id: string, start: number) {
  const book = await store.getPaperBook(id, start);
  const price = () => ({ priceUsd: 100, stale: false });
  const fill = applyPaperIntent({ kind: "swap", target: TOKEN, sellToken: USDG, buyToken: TOKEN,
    sellAmountRaw: 0n, notionalUsdg: 0n }, book, [], {
    usdgAddress: USDG, slippageBps: 100, notionalUsdg: 100, priceUsdOf: price,
    symbolOf: () => "LOCAL", multiplierOf: () => 1,
  });
  assert.ok(fill.ok);
  await store.setPaperBook(id, { ...fill.book, shares: Object.fromEntries(fill.positions.map(p => [p.symbol, { token: p.token, shares: p.shares }])) });
  assert.equal(await store.addTrade({ agent_id: id, kind: "swap", target: TOKEN, status: "paper", amount_usdg: 100,
    sell_token: USDG, buy_token: TOKEN, fill_side: "buy", fill_qty_raw: "990000000000000000",
    fill_cash_usdg: 100, fill_price_usd: 100, basis_source: "paper" }), true);
  await tickRatchets(tickPlan("command"), { incomplete: false, curveMarked: 0 }).equityRow(async () => {
    assert.fail("command ticks must not manufacture scheduled valuations");
  });
  const equity = paperEquityUsdg(fill.book, fill.positions, price, () => 1);
  await store.addEquity(id, { mode: "paper", ethWei: 0n, cashUsdg: fill.book.cashUsdg, vaultUsdg: 0,
    positionsUsdg: equity - fill.book.cashUsdg, equityUsdg: equity, quarantinedCostUsdg: 0, marks: [] });
  return fill;
}

describe("paper returns start at a durable actual stake", () => {
  it("includes the first trade's loss against a non-default stake before its first regular tick", async () => {
    const id = await agent();
    await buy(id, 250);
    assert.equal(await readPaperReturn(db, id, 1), -40, "250 became 249; the already-traded mark is not an opening stake");
    assert.equal(count("equity", id), 2);
    assert.equal(count("flows", id), 0, "simulated cash never becomes real capital");
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(verifyChain(journal), []);
    const opening = JSON.parse(journal[0]!.payload_json);
    assert.deepEqual(opening, { blockNumber: null, cashUsdg: 250, equityUsdg: 250, ethWei: "0",
      marks: [], mode: "paper", paperOpening: true, positionsUsdg: 0, quarantinedCostUsdg: 0, vaultUsdg: 0 });
  });

  it("retries and account spelling changes reuse one book without reseeding its baseline", async () => {
    const id = await agent();
    await Promise.all([store.getPaperBook(id, 275), store.getPaperBook(id.toUpperCase(), 275)]);
    assert.equal(count("paper_book", id), 1);
    assert.equal(count("equity", id), 1);
    const book = await store.getPaperBook(id.toUpperCase(), 9999);
    await store.setPaperBook(id.toUpperCase(), { ...book, cashUsdg: 271 });
    assert.equal((await store.getPaperBook(id, 9999)).cashUsdg, 271);
    assert.equal(count("equity", id), 1);
    assert.equal((await store.readJournal(id, 1)).length, 1);
  });

  it("keeps an exact recorded account's opening, reset and next valuation in the same epoch", async () => {
    const id = await agent();
    const alias = id.toUpperCase();
    await ensurePaperAgent(alias);
    await store.getPaperBook(id, 250);
    assert.equal((await store.readJournal(id, 1)).length, 1, "the exact caller owns the opening");
    assert.equal((await store.readJournal(alias, 1)).length, 0);
    assert.equal(await store.resetPaperLedger(id, 333), 2);
    assert.equal(await store.getAgentEpoch(id), 2);
    assert.equal(await store.getAgentEpoch(alias), 1, "reset does not advance another recorded alias");
    await store.addEquity(id, { mode: "paper", ethWei: 0n, cashUsdg: 332, vaultUsdg: 0,
      positionsUsdg: 0, equityUsdg: 332, quarantinedCostUsdg: 0, marks: [] });
    assert.equal((await store.readJournal(id, 2)).length, 2);
    assert.equal(await readPaperReturn(db, id, 2), -30, "the next mark compares against the reset stake");
    const marks = raw.prepare("SELECT agent_id, epoch, equity_usdg FROM equity WHERE LOWER(agent_id)=LOWER(?) ORDER BY id").all(id);
    assert.deepEqual(marks.map(mark => ({ ...mark })), [
      { agent_id: id, epoch: 1, equity_usdg: 250 },
      { agent_id: id, epoch: 2, equity_usdg: 333 },
      { agent_id: id, epoch: 2, equity_usdg: 332 },
    ]);
  });

  it("does not reset a paper alias when the exact recorded caller is live", async () => {
    const id = await agent();
    const alias = id.toUpperCase();
    await ensurePaperAgent(alias);
    await store.getPaperBook(id, 250);
    await store.setAgentMode(id, "live", 1, false);
    await store.openNextEpoch(alias, 0);
    await assert.rejects(store.resetPaperLedger(id, 333), /paper rail/);
    assert.equal(await store.getAgentEpoch(id), 1);
    assert.equal(await store.getAgentEpoch(alias), 2);
    assert.equal((await store.getPaperBook(id, 9999)).cashUsdg, 250);
    assert.equal(count("equity", id), 1);
    assert.equal((await store.readJournal(alias, 2)).length, 0);
  });

  it("never calls restored cash an initial stake or seeds evidence at the current configuration", async () => {
    const id = await agent();
    const sharedRaw = new DatabaseSync(":memory:");
    const shared = wrapSqlite(sharedRaw);
    try {
      await store.applyLedgerSchema(shared);
      await shared.exec(PAPER_CHECKPOINT_SCHEMA);
      await shared.prepare(`INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`).run(id, id, id, 4663, "{}", 1, 2_000_000_000);
      await shared.prepare(`INSERT INTO paper_checkpoints(agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at)
        VALUES(?,1,400,0,450,'{}','[]',1)`).run(id);
      assert.match(await restorePaperCheckpoint(db, shared, id), /restored/);
      assert.equal((await store.getPaperBook(id, 250)).cashUsdg, 400);
      assert.equal(count("equity", id), 0);
      assert.equal((await store.readJournal(id, 1)).length, 0);
      assert.equal(await readPaperReturn(db, id, 1), null);
    } finally { sharedRaw.close(); }
  });

  it("rolls back a new book and opening row when its journal cannot commit", async () => {
    const id = await agent();
    raw.exec(`CREATE TRIGGER fail_paper_seed BEFORE INSERT ON journal WHEN NEW.agent_id='${id}'
      BEGIN SELECT RAISE(ABORT,'injected paper journal failure'); END;`);
    try {
      await assert.rejects(store.getPaperBook(id, 300), /injected paper journal failure/);
      assert.equal(count("paper_book", id), 0);
      assert.equal(count("equity", id), 0);
    } finally { raw.exec("DROP TRIGGER fail_paper_seed"); }
    await store.getPaperBook(id, 300);
    assert.equal(count("equity", id), 1);
  });

  it("commits a reset's cash, new epoch and opening mark together, preserving real basis and history", async () => {
    const id = await agent();
    await buy(id, 250);
    await store.setBasis(id, "paper", "LOCAL", { qtyRaw: 99n * 10n ** 16n, costUsdg: 100_000_000n });
    await store.setBasis(id, "live", "REAL", { qtyRaw: 1n, costUsdg: 20_000_000n });
    raw.prepare(`INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,price_stale,value_usdg)
      VALUES(?,'LOCAL',?,'990000000000000000','1000000000000000000',100,0,99)`).run(id, TOKEN);
    raw.exec(`CREATE TRIGGER fail_paper_reset BEFORE INSERT ON journal WHEN NEW.agent_id='${id}' AND NEW.epoch=2
      BEGIN SELECT RAISE(ABORT,'injected reset journal failure'); END;`);
    try {
      await assert.rejects(store.resetPaperLedger(id, 333), /injected reset journal failure/);
      assert.equal(await store.getAgentEpoch(id), 1);
      assert.equal((await store.getPaperBook(id, 9999)).cashUsdg, 150);
      assert.equal((await store.getBasis(id, "paper", "LOCAL")).costUsdg, 100_000_000n);
      assert.ok(raw.prepare("SELECT 1 FROM positions WHERE agent_id=?").get(id));
      assert.equal(count("equity", id), 2);
    } finally { raw.exec("DROP TRIGGER fail_paper_reset"); }
    assert.equal(await store.resetPaperLedger(id.toUpperCase(), 333), 2);
    assert.deepEqual(await store.getPaperBook(id, 9999), { cashUsdg: 333, vaultUsdg: 0, hwmUsdg: 0, shares: {} });
    assert.equal((await store.getBasis(id, "paper", "LOCAL")).costUsdg, 0n);
    assert.equal((await store.getBasis(id, "live", "REAL")).costUsdg, 20_000_000n);
    assert.equal(raw.prepare("SELECT 1 FROM positions WHERE agent_id=?").get(id), undefined);
    assert.equal(await readPaperReturn(db, id, 1), -40, "prior history remains available in its old epoch");
    assert.equal(await readPaperReturn(db, id, 2), 0);
    assert.equal((await store.readJournal(id, 2)).length, 1);
    assert.equal(count("flows", id), 0);
  });

  it("refuses reset on a live agent and does not manufacture a paper opening on generic epoch boundaries", async () => {
    const id = await agent();
    await store.getPaperBook(id, 250);
    await store.setAgentMode(id, "live", 1, false);
    await assert.rejects(store.resetPaperLedger(id, 333), /paper rail/);
    assert.equal(await store.getAgentEpoch(id), 1);
    assert.equal((await store.getPaperBook(id, 9999)).cashUsdg, 250);
    await store.setAgentMode(id, "paper", 1, false);
    assert.equal(await store.openNextEpoch(id, 9999), 2);
    assert.equal((await store.readJournal(id, 2)).length, 0);
    assert.equal(count("equity", id), 1);
    assert.equal(count("flows", id), 0);
  });
});
