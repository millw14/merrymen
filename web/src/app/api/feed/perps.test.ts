/**
 * /api/feed CARRIES THE PERPS BESIDE THE BOOK, NEVER IN IT — and the desk and
 * the chat take them from there (docs/perps.md rule 11, "Surfaces").
 *
 *   - `perps` is its own array; `positions` is exactly the spot holdings it
 *     always was, with no `-PERP` row in it
 *   - a report the worker has not written is null/null; one that cannot be
 *     read is `perpsAccount: {state: "unreadable"}` — neither is an empty book
 *   - the terminal's mapper keeps those answers apart, and the chat model is
 *     handed the perps (or a line saying Lighter could not be read) so it
 *     never says "I hold nothing" while leveraged
 *
 * Driven through the real GET, self-hosted, against the worker's own schema.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { PerpsReport } from "@merrymen/core";
import { chatPositionsOf } from "@/terminal/account";
import { mineOf } from "@/terminal/live";

const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90124";
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, database: process.env.DATABASE_URL };
let dir: string;
let GET: (req: Request) => Promise<Response>;

const REPORT: PerpsReport = {
  v: 1,
  mode: "paper",
  blocker: null,
  venueReadAt: Date.now() - 20_000,
  protectAt: Date.now() - 5_000,
  accountIndex: null,
  positions: [
    {
      market: "ETH-PERP",
      side: "short",
      baseAmount: "0.0100",
      entryPrice: "3100.50",
      markPrice: "3050.00",
      leverage: 3,
      marginMicro: "10335000",
      liqPrice: "4050.00",
      unrealizedMicro: "505000",
      stopTrigger: "3255.52",
      fundingMicro: "1200",
    },
  ],
  openNotionalMicro: "31005000",
  collateralMicro: "10335000",
  inTransitMicro: "0",
  minLiqDistanceBps: 3278,
  stopsMissing: 0,
  incident: false,
};

async function ledger(perps: string | null, agentMode = "paper") {
  const { wrapSqlite } = await import("../../../../../worker/src/db");
  const { applyLedgerSchema } = await import("../../../../../worker/src/store");
  const file = path.join(dir, "merrymen.db");
  await rm(file, { force: true });
  const raw = new DatabaseSync(file);
  try {
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    await db
      .prepare(
        `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, perps)
         VALUES (?, 'Shogun', '0x1', '0x2', 4663, '{}', 0, 0, ?, 2, ?)`,
      )
      .run(ACCOUNT, agentMode, perps);
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 900, 0, 12, 922.84, ?, 2, 'paper')")
      .run(ACCOUNT, now - 60);
    await db
      .prepare("INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg) VALUES (?, 'TSLA', '0xtsla', '1000', '1', 12, 0, 12)")
      .run(ACCOUNT);
  } finally {
    raw.close();
  }
}

async function feed(): Promise<Record<string, any>> {
  return (await (await GET(new Request("http://localhost/api/feed"))).json()) as Record<string, any>;
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mm-feed-perps-"));
  process.env.MERRYMEN_HOME = dir;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.DATABASE_URL;
  ({ GET } = await import("./route"));
});

after(async () => {
  for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["DATABASE_URL", saved.database]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("the feed's perps", () => {
  it("A SEPARATE ARRAY: the spot book is untouched, the perps ride beside it, paper labelled", async () => {
    await ledger(JSON.stringify(REPORT));
    const f = await feed();
    assert.deepEqual(
      f.positions.map((p: { symbol: string }) => p.symbol),
      ["TSLA"],
      "no perp row among the holdings",
    );
    assert.equal(f.perps.length, 1);
    assert.deepEqual(
      { market: f.perps[0].market, side: f.perps[0].side, paper: f.perps[0].paper, margin: f.perps[0].margin_usdg },
      { market: "ETH-PERP", side: "short", paper: true, margin: 10.335 },
    );
    assert.equal(f.perpsAccount.state, "ok");
    assert.equal(f.perpsAccount.paper, true);
    assert.equal(f.perpsAccount.at_lighter_usdg, 10.84);
  });

  it("PRACTICE HELD WHILE PRACTICE PERPS ARE OFF is still paper — the account's book decides, not the rail", async () => {
    // worker lane.ts readPaperLocked with perpsEnabled off: rail "off", the paper position, the paper collateral.
    await ledger(JSON.stringify({ ...REPORT, mode: "off", blocker: "perps-off" }), "paper");
    const f = await feed();
    assert.equal(f.perps[0].paper, true);
    assert.equal(f.perpsAccount.paper, true);
    assert.equal(f.perpsAccount.book, "paper");
    const mine = mineOf(f as never, [])!;
    assert.equal(mine.perps?.book, "paper");
    const perp = chatPositionsOf({ ...mine, autonomy: {} as never }).find((p) => p.kind === "perp");
    assert.equal(perp?.paper, true);
    assert.match(perp?.note ?? "", /PRACTICE \(paper\)/);
  });

  it("NOT SAID: both null — not an empty list", async () => {
    await ledger(null);
    const f = await feed();
    assert.equal(f.perps, null);
    assert.equal(f.perpsAccount, null);
  });

  it("UNREADABLE: rows null and the account says so", async () => {
    await ledger("{ this is not a report");
    const f = await feed();
    assert.equal(f.perps, null);
    assert.deepEqual(f.perpsAccount, { state: "unreadable" });
  });
});

describe("the desk and the chat take them from the feed", () => {
  it("the mapper carries the rows beside the spot positions, and the chat is handed them", async () => {
    await ledger(JSON.stringify(REPORT));
    const mine = mineOf((await feed()) as never, [])!;
    assert.deepEqual(mine.positions?.map((p) => p.symbol), ["TSLA"]);
    assert.equal(mine.perps?.read, "ok");
    assert.equal(mine.perps?.rows[0]?.market, "ETH-PERP");
    assert.equal(mine.perps?.paper, true);
    assert.equal(mine.perps?.atLighterUsd, 10.84);
    const chat = chatPositionsOf({ ...mine, autonomy: {} as never });
    const perp = chat.find((p) => p.kind === "perp");
    assert.ok(perp, "the chat model is told about the leveraged position");
    assert.equal(perp.symbol, "ETH-PERP");
    assert.equal(perp.side, "short");
    assert.equal(perp.paper, true);
    assert.match(perp.note ?? "", /PRACTICE \(paper\) short leveraged perpetual future on Lighter/);
    assert.ok(chat.some((p) => p.symbol === "TSLA" && p.kind === undefined), "and the spot holding as before");
  });

  it("AN UNREADABLE REPORT IS A LINE TOO — the model is never left to say it holds nothing", async () => {
    await ledger("garbage");
    const mine = mineOf((await feed()) as never, [])!;
    assert.equal(mine.perps?.read, "unreadable");
    const chat = chatPositionsOf({ ...mine, autonomy: {} as never });
    const unread = chat.find((p) => p.kind === "perps-unread");
    assert.ok(unread);
    assert.match(unread.note ?? "", /could not be read/);
    assert.match(unread.note ?? "", /never say you hold nothing/);
  });

  it("NOT SAID adds nothing to the chat and draws no panel — nothing invented either way", async () => {
    await ledger(null);
    const mine = mineOf((await feed()) as never, [])!;
    assert.equal(mine.perps, null);
    assert.equal(chatPositionsOf({ ...mine, autonomy: {} as never }).filter((p) => p.kind !== undefined).length, 0);
  });

  it("LIGHTER UNREAD WITH NOTHING LISTED is still a line to the model, with what was last held", async () => {
    // A hosted child restarted while Lighter was down: live positions are re-read at arm, never seeded.
    const unread = {
      ...REPORT,
      mode: "live",
      accountIndex: 22149,
      positions: [],
      openNotionalMicro: null,
      collateralMicro: null,
      inTransitMicro: null,
      minLiqDistanceBps: null,
      stopsMissing: 2,
    };
    await ledger(JSON.stringify(unread), "live");
    const mine = mineOf((await feed()) as never, [])!;
    assert.equal(mine.perps?.venueRead, false);
    const chat = chatPositionsOf({ ...mine, autonomy: {} as never });
    const line = chat.find((p) => p.kind === "perps-unread");
    assert.ok(line, "the model is not left with spot and cash alone");
    assert.match(line.note ?? "", /Lighter could not be read just now/);
    assert.match(line.note ?? "", /2 positions were held at the last record and are not listed/);
    assert.match(line.note ?? "", /Never say you hold nothing/);
  });

  it("A FLAT ACCOUNT WITH COLLATERAL AT LIGHTER is money the model is told about", async () => {
    const flat = { ...REPORT, mode: "live", accountIndex: 22149, positions: [], openNotionalMicro: "0", collateralMicro: "900000000", inTransitMicro: "0", minLiqDistanceBps: null };
    await ledger(JSON.stringify(flat), "live");
    const mine = mineOf((await feed()) as never, [])!;
    assert.equal(mine.perps?.atLighterUsd, 900);
    const line = chatPositionsOf({ ...mine, autonomy: {} as never }).find((p) => p.kind === "perps-account");
    assert.ok(line);
    assert.equal(line.atLighterUsd, 900);
    assert.equal(line.paper, false);
    assert.match(line.note ?? "", /Money at Lighter .*: 900\.00 USD/);
  });

  it("a held book the report cannot place is handed to the model as unplaced — never as real", async () => {
    await ledger(JSON.stringify({ ...REPORT, mode: "off", blocker: "perps-off" }), "idle");
    const f = await feed();
    assert.equal(f.perpsAccount.book, null);
    const mine = mineOf(f as never, [])!;
    const perp = chatPositionsOf({ ...mine, autonomy: {} as never }).find((p) => p.kind === "perp");
    assert.equal(perp?.paper, null);
    assert.match(perp?.note ?? "", /Whether it is a practice \(paper\) or a real-money position is not stated/);
  });

  it("an older server that sends no perps at all is undefined — not said, not empty", () => {
    const mine = mineOf({ agent: { name: "Shogun", strategy: "trencher", slug: null }, positions: [] } as never, [])!;
    assert.equal(mine.perps, undefined);
  });
});

it("private feeds use the current local grant instead of a newer unrelated agent", async () => {
  await ledger(JSON.stringify(REPORT));
  const other = "0xffffffffffffffffffffffffffffffffffffffff";
  const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
  raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, perps, created_at)
    VALUES (?, 'Other', '0x1', '0x2', 4663, '{}', 0, 0, 'paper', 2, ?, ?)`).run(other, JSON.stringify({ ...REPORT, positions: [] }), Math.floor(Date.now() / 1000) + 10);
  raw.close();
  await writeFile(path.join(dir, "grant.json"), JSON.stringify({ smartAccount: ACCOUNT }));
  try {
    const response = await GET(new Request("http://localhost/api/feed"));
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("Vary"), "Cookie");
    const result = await response.json();
    assert.equal(result.perps[0].market, "ETH-PERP");
  } finally { await rm(path.join(dir, "grant.json"), { force: true }); }
});

it("an unreadable current grant never falls back to a historical local account", async () => {
  await ledger(JSON.stringify(REPORT));
  await writeFile(path.join(dir, "grant.json"), "broken JSON");
  try { assert.equal((await feed()).perps, null); }
  finally { await rm(path.join(dir, "grant.json"), { force: true }); }
});
