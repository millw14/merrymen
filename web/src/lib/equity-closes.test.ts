import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readEquityCloses } from "./equity-closes";

async function ledger(rows: [id: number, agent: string, epoch: number, at: number, equity: number, mode: string | null][]) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE equity (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, equity_usdg REAL NOT NULL,
    at INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, mode TEXT)`);
  for (const [id, agent, epoch, at, equity, mode] of rows) {
    await db.prepare("INSERT INTO equity (id, agent_id, equity_usdg, at, epoch, mode) VALUES (?, ?, ?, ?, ?, ?)").run(id, agent, equity, at, epoch, mode);
  }
  return { raw, db };
}

const H = 3600;
const T0 = 1_000 * H; // an hour boundary

test("the chart reads the whole period as hourly closes, and keeps its opening and its newest mark", async () => {
  const { raw, db } = await ledger([
    [1, "a", 2, T0 + 10, 100, "live"], // the first reading of the period: the open
    [2, "a", 2, T0 + 1_800, 101, "live"],
    [3, "a", 2, T0 + 3_000, 102, "live"], // hour 0 closes here
    [4, "a", 2, T0 + H + 5, 103, "live"],
    [5, "a", 2, T0 + H + 5, 104, "live"], // same second, later id: this is the close
    [6, "a", 2, T0 + 30 * 24 * H + 60, 150, "live"], // a month later: the newest reading
    [7, "a", 1, T0 + 2 * H, 999, "live"], // another period
    [8, "b", 2, T0 + 2 * H, 999, "live"], // another agent
  ]);
  try {
    const r = await readEquityCloses(db, "a", 2);
    assert.equal(r.complete, true);
    assert.deepEqual(r.marks.map((m) => [m.at, m.equity_usdg]), [
      [T0 + 10, 100],
      [T0 + 3_000, 102],
      [T0 + H + 5, 104],
      [T0 + 30 * 24 * H + 60, 150],
    ]);
    // THE RIGHT-HAND END IS THE HEADLINE'S NUMERATOR. The old read took the
    // last 500 rows and thinned them by a modulo that had to be told to keep
    // the final index; a close per hour keeps it by construction.
    assert.equal(r.marks.at(-1)!.equity_usdg, 150);
  } finally { raw.close(); }
});

test("each book closes on its own marks, so the switch hour cannot borrow the other book's value", async () => {
  // Practising and then going live inside one hour: the paper book's last mark
  // is later than the live book's first, and a close taken across both would
  // hand the live series a paper number.
  const { raw, db } = await ledger([
    [1, "a", 1, T0 + 10, 1_000, "paper"],
    [2, "a", 1, T0 + 100, 50, "live"],
    [5, "a", 1, T0 + 150, 52, "live"], // the live book's close for the switch hour
    [3, "a", 1, T0 + 200, 1_001, "paper"],
    [4, "a", 1, T0 + H + 10, 51, "live"],
  ]);
  try {
    const r = await readEquityCloses(db, "a", 1);
    assert.deepEqual(r.marks.map((m) => [m.at, m.mode, m.equity_usdg]), [
      [T0 + 10, "paper", 1_000],
      [T0 + 100, "live", 50],
      [T0 + 150, "live", 52],
      [T0 + 200, "paper", 1_001],
      [T0 + H + 10, "live", 51],
    ]);
  } finally { raw.close(); }
});

test("a read that reaches its cap says the series is not the whole period", async () => {
  const rows: [number, string, number, number, number, string | null][] = [];
  for (let i = 0; i < 6; i++) rows.push([i + 1, "a", 1, T0 + i * H, 100 + i, null]);
  const { raw, db } = await ledger(rows);
  try {
    const whole = await readEquityCloses(db, "a", 1, 6);
    assert.equal(whole.complete, true);
    assert.equal(whole.marks.length, 6);
    const capped = await readEquityCloses(db, "a", 1, 4);
    assert.equal(capped.complete, false, "the oldest hours were not read");
    // Truncation drops the OLDEST closes, never the newest.
    assert.deepEqual(capped.marks.map((m) => m.equity_usdg), [102, 103, 104, 105]);
  } finally { raw.close(); }
});

test("a missing equity table throws, so the caller says unread instead of drawing nothing as a flat line", async () => {
  const raw = new DatabaseSync(":memory:");
  try { await assert.rejects(readEquityCloses(wrapSqlite(raw), "a", 1)); }
  finally { raw.close(); }
});

test("a mark taken while flow inference was held is never a close; the newest mark still comes back, flagged, because it names the book", async () => {
  // store.ts `flows_held`: a held row's cash can carry a movement the flows
  // table has not booked yet, so the growth index read over it dips (or
  // spikes) until the booking lands, and the drawdown keeps the dip. The
  // hour's close is its last MEASURED reading; an hour with none has no close.
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE equity (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, equity_usdg REAL NOT NULL,
      at INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, mode TEXT, flows_held INTEGER)`);
    const rows: [id: number, at: number, equity: number, held: number | null][] = [
      [1, T0 + 10, 100, null], // written before the column: not held
      [2, T0 + 1_800, 101, 0], // hour 0's measured close
      [3, T0 + 3_000, 90, 1], // held, and later in hour 0
      [4, T0 + H + 100, 95, 1], // hour 1 was held throughout
      [5, T0 + 2 * H + 10, 100, 0], // hour 2's measured close
      [6, T0 + 2 * H + 50, 92, 1], // the newest mark, held
    ];
    for (const [id, at, equity, held] of rows) {
      await db.prepare("INSERT INTO equity (id, agent_id, equity_usdg, at, epoch, mode, flows_held) VALUES (?, 'a', ?, ?, 1, 'live', ?)").run(id, equity, at, held);
    }
    const r = await readEquityCloses(db, "a", 1);
    assert.equal(r.complete, true);
    assert.deepEqual(r.marks.map((m) => [m.at, m.equity_usdg, m.held]), [
      [T0 + 10, 100, false],
      [T0 + 1_800, 101, false],
      [T0 + 2 * H + 10, 100, false],
      [T0 + 2 * H + 50, 92, true],
    ]);
    // A cap counts measured closes only: the flagged newest mark rides on top.
    const capped = await readEquityCloses(db, "a", 1, 3);
    assert.equal(capped.complete, true, "three measured closes fit a cap of three");
    assert.equal(capped.marks.length, 4);
    const short = await readEquityCloses(db, "a", 1, 2);
    assert.equal(short.complete, false);
    assert.deepEqual(short.marks.map((m) => m.at), [T0 + 1_800, T0 + 2 * H + 10, T0 + 2 * H + 50]);
  } finally { raw.close(); }
});
