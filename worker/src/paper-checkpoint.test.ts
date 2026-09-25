import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { mirrorPaperCheckpoints, multipliersFrom, paperCheckpointRejection, restorePaperCheckpoint, validPaperCheckpoint } from "./paper-checkpoint";

test("paper cash, inventory and basis survive a fresh child without resetting or overwriting a running book", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [child,shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [child!,shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await child!.prepare(`INSERT INTO paper_book VALUES('a',900,0,1000,?,10)`).run(JSON.stringify({AAPL:{token:'0x'+'1'.repeat(40),shares:2}}));
    await child!.exec(`INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10)`);
    assert.equal(await mirrorPaperCheckpoints(child!,shared!),1);
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    assert.equal((await fresh!.prepare(`SELECT cash_usdg FROM paper_book`).get() as {cash_usdg:number}).cash_usdg,900);
    assert.equal((await fresh!.prepare(`SELECT cost_usdg FROM cost_basis`).get() as {cost_usdg:string}).cost_usdg,'100000000');
    await fresh!.exec(`UPDATE paper_book SET cash_usdg=875`);
    assert.equal(await restorePaperCheckpoint(fresh!,shared!,'a'),'local book retained');
    assert.equal((await fresh!.prepare(`SELECT cash_usdg FROM paper_book`).get() as {cash_usdg:number}).cash_usdg,875);
    // A book read between an inventory write and its basis write is rejected.
    await child!.exec(`UPDATE cost_basis SET qty_raw='1000000000000000000'`);
    assert.equal(await mirrorPaperCheckpoints(child!,shared!),0);
    // Upgrade from the old mirror's reconciled equity + position snapshot.
    await fresh!.exec('DELETE FROM paper_book; DELETE FROM cost_basis;');
    await shared!.exec(`DELETE FROM paper_checkpoints;
      CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,900,0,110,1010);
      INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10);`);
    await shared!.prepare(`INSERT INTO positions VALUES('a','AAPL',?,'2000000000000000000',110)`).run('0x'+'1'.repeat(40));
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    assert.equal((await fresh!.prepare('SELECT cash_usdg FROM paper_book').get() as {cash_usdg:number}).cash_usdg,900);
    await fresh!.exec('DELETE FROM paper_book;');
    await shared!.exec("INSERT INTO trades VALUES('a',1,'paper',11)");
    await assert.rejects(restorePaperCheckpoint(fresh!,shared!,'a'),/newer/);
  } finally {raws.forEach(r=>r.close());}
});

/**
 * THE FAILURE THAT KILLED EIGHT AGENTS, reproduced.
 *
 * The existing round-trip test above builds a world where the positions table
 * and the equity row were captured in the same instant — `value_usdg` 110
 * against `positions_usdg` 110 — which is the one case the old check could
 * pass. Production is never that world: `setPositions` replaces the positions
 * table every tick and the equity row is written only when the book is
 * complete, so the two drift apart and never come back.
 *
 * The consequence was not a warning. `restorePaperCheckpoint` throwing makes
 * the orchestrator skip `spawn()` for a paper agent, so the agent does not run
 * at all — and since the drift is permanent, it never runs again.
 */
test("a price that moved since the recoverable valuation does not block recovery", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await shared!.exec(`CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,900,0,110,1010);
      INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10);`);
    // THE ONLY DIFFERENCE FROM THE PASSING CASE: the holding is now marked at
    // 120 rather than the 110 the equity row recorded. Same shares, same cash,
    // no fills — just a later mark. Production deltas ran from 0.0066 to
    // 948.40 USDG; ten is comfortably inside that and 1,000,000x the old
    // tolerance of 0.00001.
    await shared!.prepare(`INSERT INTO positions VALUES('a','AAPL',?,'2000000000000000000',120)`).run('0x'+'1'.repeat(40));
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    const book = await fresh!.prepare('SELECT cash_usdg,hwm_usdg FROM paper_book').get() as {cash_usdg:number;hwm_usdg:number};
    // Cash comes from the mark and is untouched by the re-mark: `later.n`
    // proved no fill landed after it, so the cash cannot have moved.
    assert.equal(book.cash_usdg,900);
    // The HWM takes today's valuation, which is above anything the series held.
    assert.equal(book.hwm_usdg,1020);
  } finally {raws.forEach(r=>r.close());}
});

test("a recoverable valuation whose own terms do not add up is still refused", async()=>{
  // The check that REPLACED the cross-temporal one, and it has to bite: this
  // tests one row against itself, which is a question that has a right answer
  // at any instant. Production passes it every time — the old error message
  // proved as much, printing identical snapshotDelta and equityDelta, which
  // reduces algebraically to exactly this identity holding.
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await shared!.exec(`CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,900,0,110,5000);
      INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10);`);
    await shared!.prepare(`INSERT INTO positions VALUES('a','AAPL',?,'2000000000000000000',110)`).run('0x'+'1'.repeat(40));
    await assert.rejects(restorePaperCheckpoint(fresh!,shared!,'a'),/does not add up/);
  } finally {raws.forEach(r=>r.close());}
});

test("a rejected checkpoint says which clause rejected it", async()=>{
  // The boolean is why eight dead agents could only be described as "invalid".
  const base = {agent_id:'a',epoch:1,cash_usdg:900,vault_usdg:0,hwm_usdg:1000,updated_at:10};
  const token = '0x'+'1'.repeat(40);
  const held = JSON.stringify({AAPL:{token,shares:2}});
  const ok = {...base,shares:held,basis_json:JSON.stringify([{symbol:'AAPL',qty_raw:'2000000000000000000',cost_usdg:'100000000'}])};
  assert.equal(paperCheckpointRejection(ok),null);
  assert.equal(validPaperCheckpoint(ok),true,'the boolean wrapper still agrees');

  assert.match(paperCheckpointRejection({...ok,cash_usdg:-1})!,/cash is -1/);
  assert.match(paperCheckpointRejection({...ok,basis_json:'[]'})!,/AAPL is held with no paper cost basis/);
  assert.match(
    paperCheckpointRejection({...ok,basis_json:JSON.stringify([{symbol:'AAPL',qty_raw:'1000000000000000000',cost_usdg:'100000000'}])})!,
    /AAPL basis 1000000000000000000 raw disagrees with 2 shares/,
  );
  assert.match(paperCheckpointRejection({...ok,shares:'{'})!,/unreadable/);
  assert.match(paperCheckpointRejection({...ok,shares:'[]'})!,/shares is not an object/);
  assert.match(paperCheckpointRejection({...ok,shares:JSON.stringify({AAPL:{token:'nope',shares:2}})})!,/no usable token address/);
  assert.match(
    paperCheckpointRejection({...ok,basis_json:JSON.stringify([
      {symbol:'AAPL',qty_raw:'2000000000000000000',cost_usdg:'100000000'},
      {symbol:'MSFT',qty_raw:'5000000000000000000',cost_usdg:'1'},
    ])})!,
    /MSFT has basis for 5000000000000000000 raw but is not held/,
  );
});

/**
 * THE SEVEN AGENTS THAT STAYED BLOCKED, with their real numbers.
 *
 * `paper_book.shares` is split-invariant — shares at multiplier 1.0, held that
 * way on purpose so a stock split does not read as a 50% loss and retire an
 * agent. `cost_basis.qty_raw` is a raw balance, which is tradeable units. The
 * validator compared them directly, which is only correct while every
 * multiplier is exactly 1.0 — an assumption paper.ts wrote down and production
 * has outgrown.
 *
 * The ratios below are measured, not invented: constant per symbol across five
 * different agents and different sizes, which is what a multiplier looks like
 * and what a fee does not.
 */
const NVDA_MUL = 1.000775;
const SPLIT_MUL = 2.001550; // exactly 2x NVDA's — a 2:1 split on top

test("a holding whose multiplier has moved is not a disagreement", async()=>{
  const token = '0x'+'1'.repeat(40);
  const base = {agent_id:'a',epoch:1,cash_usdg:900,vault_usdg:0,hwm_usdg:1000,updated_at:10};
  // Production, 0x19bd63: basis 46705938556015296 raw against 0.046669762062241625 shares.
  const row = {...base,
    shares: JSON.stringify({NVDA:{token,shares:0.046669762062241625}}),
    basis_json: JSON.stringify([{symbol:'NVDA',qty_raw:'46705938556015296',cost_usdg:'100000000'}]),
  };
  // The bug: compared as if one share were one raw unit.
  assert.match(paperCheckpointRejection(row)!,/NVDA basis .* disagrees/);
  // The fix: converted first, the two agree.
  assert.equal(paperCheckpointRejection(row,()=>NVDA_MUL),null);
});

test("AT A SPLIT, today's units pass exactly — and no range is admitted where it could hide a torn write", async()=>{
  const token = '0x'+'1'.repeat(40);
  const base = {agent_id:'a',epoch:1,cash_usdg:900,vault_usdg:0,hwm_usdg:1000,updated_at:10};
  // This test once read 0xc94b0f's 2.00155 ratio as a 2:1 split. Production says
  // otherwise: that agent's NVDA multiplier is 1.000775 (orchestrator log,
  // 2026-09-24), so its basis is booked twice, and it stays refused (see "WHAT
  // THE CHECK IS FOR"). At a REAL split a basis in today's units equals the book.
  const current = {...base,
    shares: JSON.stringify({NVDA:{token,shares:0.03889431898463838}}),
    basis_json: JSON.stringify([{symbol:'NVDA',qty_raw:'38894318984638380',cost_usdg:'100000000'}]),
  };
  assert.equal(paperCheckpointRejection(current,()=>SPLIT_MUL),null);
  // Kaka's review of #164: a sell of 0.4 from one share that updated the book
  // and crashed before its basis — book 0.6, stale basis 1.0 — sits inside
  // [0.6, 1.2] at a multiplier of 2. Past dividend-scale drift, no range.
  const torn = {...base,
    shares: JSON.stringify({NVDA:{token,shares:0.6}}),
    basis_json: JSON.stringify([{symbol:'NVDA',qty_raw:'1000000000000000000',cost_usdg:'100000000'}]),
  };
  assert.match(paperCheckpointRejection(torn,()=>2)!,/disagrees/);
});

test("a REAL disagreement still fails once the multiplier is applied", async()=>{
  // The check has to keep biting. Same multiplier, a basis that is genuinely
  // for a different quantity, and it must still be refused — otherwise this
  // change would have traded seven blocked agents for a silent accounting hole.
  const token = '0x'+'1'.repeat(40);
  const base = {agent_id:'a',epoch:1,cash_usdg:900,vault_usdg:0,hwm_usdg:1000,updated_at:10};
  const row = {...base,
    shares: JSON.stringify({NVDA:{token,shares:0.046669762062241625}}),
    basis_json: JSON.stringify([{symbol:'NVDA',qty_raw:'96705938556015296',cost_usdg:'100000000'}]),
  };
  assert.match(paperCheckpointRejection(row,()=>NVDA_MUL)!,/disagrees/);
  assert.match(paperCheckpointRejection(row,()=>NVDA_MUL)!,/at multiplier 1.000775/);
});

test("an absent or unreadable multiplier is 1.0, so nothing that never split changes", async()=>{
  const of = multipliersFrom([
    {symbol:'NVDA',ui_multiplier:'1000775000000000000'},
    {symbol:'BAD',ui_multiplier:'0'},
    {symbol:'WORSE',ui_multiplier:'not a number'},
  ]);
  assert.ok(Math.abs(of('NVDA')-1.000775)<1e-9);
  assert.equal(of('BAD'),1,'a zero multiplier is a column we could not use, not a zero holding');
  assert.equal(of('WORSE'),1);
  assert.equal(of('NEVER SEEN'),1);
});

test("the upgrade path reads a paper raw balance as the split-invariant shares index.ts wrote into it", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await shared!.exec(`CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,ui_multiplier TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,900,0,110,1010);
      INSERT INTO cost_basis VALUES('a','paper','NVDA','2000000000000000000','100000000',10);`);
    // A paper position's raw balance is `shares * 1e18` (index.ts), whatever the
    // multiplier: two raw units at a 2.0 multiplier are two split-invariant
    // shares. Dividing by the multiplier again restored one — half the holding.
    await shared!.prepare(`INSERT INTO positions VALUES('a','NVDA',?,'2000000000000000000','2000000000000000000',110)`).run('0x'+'1'.repeat(40));
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    const book = await fresh!.prepare('SELECT shares FROM paper_book').get() as {shares:string};
    const held = (JSON.parse(book.shares) as Record<string,{shares:number}>).NVDA!.shares;
    assert.ok(Math.abs(held-2)<1e-9, `expected the 2 split-invariant shares the book held, got ${held}`);
  } finally {raws.forEach(r=>r.close());}
});

/**
 * ── THE UNITS THE PAPER ENGINE ACTUALLY WRITES ─────────────────────────────
 *
 * Since d2c652db (2026-09-19) a paper fill books its basis in SPLIT-INVARIANT
 * units — index.ts passes `qtyRaw: rawShares * 1e18`, where rawShares is the
 * quantity the book stores — so a book and a basis written by today's engine
 * are EQUAL, whatever the multiplier. Before it, the basis took the tradeable
 * quantity at the multiplier of the day. A position that spans the change
 * holds a mix, so its basis sits anywhere from 1× to multiplier× its shares.
 *
 * Checking `basis == shares × multiplier` (the rule this replaces) passed only
 * the old half and refused every book today's engine writes — and a refused
 * book is an agent the orchestrator never starts: no ticks, no trades, and a
 * Telegram bot that stops answering while the dashboard still says connected.
 * Production, 2026-09-24: ten paper agents, every ferry pass refused.
 */
import { applyPaperIntent } from "./paper";

const NVDA_NOW = 1.0007751591646306;
const AAPL_NOW = 1.0005660800610925;
const QQQ_NOW = 1.0007007912414054;
const TOKEN = ('0x'+'2'.repeat(40)) as `0x${string}`;
const USDG = ('0x'+'5'.repeat(40)) as `0x${string}`;
const base = {agent_id:'a',epoch:1,cash_usdg:900,vault_usdg:0,hwm_usdg:1000,updated_at:10};
const row = (symbol: string, shares: number, qtyRaw: bigint | string) => ({...base,
  shares: JSON.stringify({[symbol]:{token:TOKEN,shares}}),
  basis_json: JSON.stringify([{symbol,qty_raw:String(qtyRaw),cost_usdg:'100000000'}]),
});

test("A BOOK TODAY'S ENGINE WROTE is valid at any multiplier — a buy, then a partial sell, through the real paper fill", ()=>{
  const opts = {
    priceUsdOf: () => ({ priceUsd: 180, stale: false }),
    symbolOf: () => 'NVDA',
    multiplierOf: () => NVDA_NOW,
    usdgAddress: USDG,
    slippageBps: 30,
    notionalUsdg: 50,
  };
  const book = { cashUsdg: 1000, vaultUsdg: 0 };
  const buy = applyPaperIntent({ kind:'swap', sellToken:USDG, buyToken:TOKEN } as never, book as never, [], opts);
  assert.ok(buy.ok && buy.fill);
  // Exactly what index.ts books: the stored (split-invariant) quantity.
  let qty = BigInt(Math.round(buy.fill!.rawShares * 1e18));
  const held = buy.positions.find(p=>p.symbol==='NVDA')!.shares;
  assert.equal(paperCheckpointRejection(row('NVDA', held, qty), ()=>NVDA_NOW), null, 'the buy it just booked');

  const sell = applyPaperIntent({ kind:'swap', sellToken:TOKEN, buyToken:USDG } as never, buy.book, buy.positions, { ...opts, notionalUsdg: 20 });
  assert.ok(sell.ok && sell.fill);
  qty -= BigInt(Math.round(sell.fill!.rawShares * 1e18));
  const left = sell.positions.find(p=>p.symbol==='NVDA')!.shares; // rounded to 6dp by the engine
  assert.equal(paperCheckpointRejection(row('NVDA', left, qty), ()=>NVDA_NOW), null, 'and after a sell the book rounded');
});

test("THE TEN THAT WOULD NOT START: their real rows restore, in both units", ()=>{
  // Today's engine: basis == shares (the AAPL one rounded to 6dp by a sell).
  assert.equal(paperCheckpointRejection(row('NVDA', 0.7682579240244635, '768257924024463289'), ()=>NVDA_NOW), null, '0xfe0db6');
  assert.equal(paperCheckpointRejection(row('AAPL', 0.002073, '2072280544600463'), ()=>AAPL_NOW), null, '0x69ae62');
  assert.equal(paperCheckpointRejection(row('QQQ', 0.0054979829144916085, '5497982914491609'), ()=>QQQ_NOW), null, '0xa222ba');
  // The engine before 2026-09-19: basis tradeable at the multiplier of the day.
  assert.equal(paperCheckpointRejection(row('NVDA', 0.046669762062241625, '46705938556015296'), ()=>NVDA_NOW), null, '0x19bd63');
});

test("WHAT THE CHECK IS FOR still fails: a torn write, a doubled basis, and anything outside the two units", ()=>{
  // A DCA leg whose book write landed and whose basis write had not.
  assert.match(paperCheckpointRejection(row('NVDA', 0.1, '70000000000000000'), ()=>NVDA_NOW)!, /disagrees/);
  // 0xc94b0f: a basis twice its holding at a multiplier of 1.000775 — booked twice, not split.
  assert.match(paperCheckpointRejection(row('NVDA', 0.03886419304922031, '77848936544902784'), ()=>NVDA_NOW)!, /disagrees/);
  // Just past each end of the range the two units allow.
  assert.match(paperCheckpointRejection(row('NVDA', 1, BigInt(Math.round(1e18 * NVDA_NOW)) + 2_000_000_000_000n), ()=>NVDA_NOW)!, /disagrees/);
  assert.match(paperCheckpointRejection(row('NVDA', 1, 999_990_000_000_000_000n), ()=>NVDA_NOW)!, /disagrees/);
  // And a holding with no basis is still no restore point.
  assert.match(paperCheckpointRejection({...base, shares: JSON.stringify({MU:{token:TOKEN,shares:1}}), basis_json:'[]'})!, /MU is held with no paper cost basis/);
});

test("0x19bd63, THROUGH THE UPGRADE PATH: an old tradeable basis against the raw balance the book wrote restores the holding it had", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await shared!.exec(`CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,ui_multiplier TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,990,0,8.4,998.4);
      INSERT INTO cost_basis VALUES('a','paper','NVDA','46705938556015296','8400000',10);`);
    // Production numbers, as the mirror holds them.
    await shared!.prepare(`INSERT INTO positions VALUES('a','NVDA',?,'46669762062241625','1000775159164630600',8.4)`).run('0x'+'1'.repeat(40));
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    const book = await fresh!.prepare('SELECT shares FROM paper_book').get() as {shares:string};
    const held = (JSON.parse(book.shares) as Record<string,{shares:number}>).NVDA!.shares;
    assert.ok(Math.abs(held-0.046669762062241625)<1e-12, `the holding the book had, got ${held}`);
  } finally {raws.forEach(r=>r.close());}
});

/**
 * KAKA'S FIRST FINDING ON #164: admitting a mixed basis is not enough. A sell
 * takes split-invariant quantity off a basis whose older part is tradeable,
 * so a legacy position later sold down drifts past shares × multiplier and is
 * refused on the NEXT restart. The fix is to normalise at every restore, and
 * in what the mirror writes: after it, basis == shares, and fills keep it so.
 */
const SCHEMA = `CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
  CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
  CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
  CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,ui_multiplier TEXT,value_usdg REAL);
  INSERT INTO agents VALUES('a',1);`;
const NVDA_RAW_MUL = '1000775159164630600';

test("A MIXED BASIS, RESTORED, SURVIVES THE SELL THAT WOULD HAVE KILLED IT — through the mirror, the restore and the real paper sell", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [child,shared,fresh]=raws.map(wrapSqlite);
  try {
    for (const db of [child!,shared!,fresh!]) await db.exec(SCHEMA);
    for (const db of [child!,shared!]) await db.prepare(`INSERT INTO positions VALUES('a','NVDA',?,'0',?,0)`).run(TOKEN, NVDA_RAW_MUL);
    // One legacy share (booked tradeable, ×1.000775) plus 0.1 bought today.
    const legacyQty = BigInt(Math.round(1e18 * NVDA_NOW)) + 100_000_000_000_000_000n;
    await child!.prepare(`INSERT INTO paper_book VALUES('a',800,0,1000,?,10)`).run(JSON.stringify({NVDA:{token:TOKEN,shares:1.1}}));
    await child!.prepare(`INSERT INTO cost_basis VALUES('a','paper','NVDA',?,'198000000',10)`).run(String(legacyQty));
    assert.equal(await mirrorPaperCheckpoints(child!,shared!),1,'a mixed basis at dividend-scale drift is admitted');
    const stored = await shared!.prepare('SELECT basis_json FROM paper_checkpoints').get() as {basis_json:string};
    assert.equal((JSON.parse(stored.basis_json) as {qty_raw:string}[])[0]!.qty_raw, String(BigInt(Math.round(1.1 * 1e18))), 'and mirrored in today\'s units');

    // A checkpoint an older mirror wrote still carries the legacy units: the
    // restore normalises it too, and says so in the orchestrator's log line.
    await shared!.prepare(`UPDATE paper_checkpoints SET basis_json=?`).run(JSON.stringify([{symbol:'NVDA',qty_raw:String(legacyQty),cost_usdg:'198000000'}]));
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored \(basis for NVDA moved to split-invariant units\)/);
    const restored = await fresh!.prepare(`SELECT qty_raw, cost_usdg FROM cost_basis`).get() as {qty_raw:string;cost_usdg:string};
    assert.equal(restored.qty_raw, String(BigInt(Math.round(1.1 * 1e18))), 'basis == shares after the restore');
    assert.equal(restored.cost_usdg, '198000000', 'the cost is untouched');

    // Now the sell that pushed an un-normalised basis out of range: most of it.
    const opts = { priceUsdOf: () => ({ priceUsd: 180, stale: false }), symbolOf: () => 'NVDA', multiplierOf: () => NVDA_NOW, usdgAddress: USDG, slippageBps: 30, notionalUsdg: 162 };
    const sell = applyPaperIntent({ kind:'swap', sellToken:TOKEN, buyToken:USDG } as never, { cashUsdg: 800, vaultUsdg: 0 } as never, [{ symbol:'NVDA', token:TOKEN, shares:1.1 }], opts);
    assert.ok(sell.ok && sell.fill);
    const left = sell.positions.find(p=>p.symbol==='NVDA')!.shares;
    const after = (q: bigint) => row('NVDA', left, q - BigInt(Math.round(sell.fill!.rawShares * 1e18)));
    assert.equal(paperCheckpointRejection(after(BigInt(restored.qty_raw)), ()=>NVDA_NOW), null, 'normalised: still valid after the sell');
    assert.match(paperCheckpointRejection(after(legacyQty), ()=>NVDA_NOW)!, /disagrees/, 'not normalised: refused on the next restart — the finding');
  } finally {raws.forEach(r=>r.close());}
});

test("a book that survived the restart keeps its place, and its legacy basis is normalised in place", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [child,shared]=raws.map(wrapSqlite);
  try {
    for (const db of [child!,shared!]) await db.exec(SCHEMA);
    await shared!.prepare(`INSERT INTO positions VALUES('a','NVDA',?,'0',?,0)`).run(TOKEN, NVDA_RAW_MUL);
    await child!.prepare(`INSERT INTO paper_book VALUES('a',800,0,1000,?,10)`).run(JSON.stringify({NVDA:{token:TOKEN,shares:1}}));
    await child!.prepare(`INSERT INTO cost_basis VALUES('a','paper','NVDA',?,'180000000',10)`).run(String(BigInt(Math.round(1e18 * NVDA_NOW))));
    assert.match(await restorePaperCheckpoint(child!,shared!,'a'),/local book retained \(basis for NVDA moved/);
    const q = await child!.prepare(`SELECT qty_raw FROM cost_basis`).get() as {qty_raw:string};
    assert.equal(q.qty_raw, '1000000000000000000');
    assert.equal(await restorePaperCheckpoint(child!,shared!,'a'), 'local book retained', 'and once normalised, nothing more to say');
  } finally {raws.forEach(r=>r.close());}
});
