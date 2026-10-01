import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import type { StoredGrant } from "@merrymen/core";
import { mintSession } from "@/lib/auth";
import { GET } from "./route";
import { readTradePnl } from "@/lib/trade-pnl";
import { wrapSqlite } from "../../../../../worker/src/db";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000a2";
const ENV = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
const cwd = process.cwd();
let home: string;
let raw: DatabaseSync;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "merrymen-pnl-route-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SESSION_SECRET = "pnl-test-secret-at-least-thirty-two-characters";
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_HOSTED;
  resetGrantStoreForTest();
  for (const [tenant, smartAccount] of [[OWNER, ACCOUNT], [OTHER, OTHER_ACCOUNT]] as const) {
    await getGrantStore().put(tenant, { smartAccount, chainId: 4663, serialized: "test-only", demoSessionPrivateKey: "" } as unknown as StoredGrant);
  }
  process.env.MERRYMEN_HOSTED = "1";
  process.chdir(fileURLToPath(new URL("../../../../", import.meta.url)));
  raw = new DatabaseSync(path.join(home, "merrymen.db"));
  raw.exec(`CREATE TABLE agents(smart_account TEXT, epoch INTEGER);
    INSERT INTO agents VALUES ('${ACCOUNT}', 2), ('${OTHER_ACCOUNT}', 2);
    CREATE TABLE decisions(id TEXT, agent_id TEXT, symbol TEXT, display_name TEXT);
    CREATE TABLE trades(id INTEGER PRIMARY KEY, agent_id TEXT, target TEXT, kind TEXT, sell_token TEXT, buy_token TEXT,
      status TEXT, user_op_hash TEXT, decision_id TEXT, created_at INTEGER, fill_side TEXT, fill_symbol TEXT,
      fill_cash_usdg REAL, realized_pnl_usdg REAL, fill_qty_raw TEXT, basis_source TEXT, epoch INTEGER);
  `);
  const insert = raw.prepare(`INSERT INTO trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const fill = (id: number, token: string, side: string, source: string, status = "landed", cash: number | null = side === "sell" ? 7 : 5,
    pnl: number | null = side === "sell" ? 2 : null, account = ACCOUNT, epoch = 2, symbol = "CASHCAT") => {
    insert.run(id, account, "0xRouter", "curve-trade", side === "sell" ? token : "0xUSDG", side === "buy" ? token : "0xUSDG", status,
      status === "paper" ? null : `0xop${id}`, null, id, side, symbol, cash, pnl, "10", source, epoch);
  };
  fill(1, "0xREAL", "buy", "receipt"); fill(2, "0xREAL", "sell", "receipt");
  fill(3, "0xQUOTE", "buy", "quote"); fill(4, "0xQUOTE", "sell", "receipt");
  fill(5, "0xESTIMATED", "buy", "receipt"); fill(6, "0xESTIMATED", "sell", "quote");
  fill(7, "0xPAPER", "buy", "paper", "paper"); fill(8, "0xPAPER", "sell", "paper", "paper");
  fill(9, "0xREFUSED", "sell", "receipt", "rejected");
  fill(10, "0xPENDING", "sell", "receipt", "submitted");
  fill(11, "0xUNKNOWN", "sell", "receipt", "landed", null, null);
  fill(12, "0xDUST", "sell", "receipt", "landed", 0.005, 0.001);
  fill(13, "0xBAD", "sell", "receipt", "landed", -1, -2);
  fill(14, "0xBAD", "sell", "receipt", "landed", Infinity, 2);
  fill(15, "0xNAME", "sell", "receipt", "landed", 7, 2, ACCOUNT, 2, "T123456789AB");
  fill(16, "0xOLD", "sell", "receipt", "landed", 7, 2, ACCOUNT, 1);
  fill(17, "0xOTHER", "buy", "receipt", "landed", 5, null, OTHER_ACCOUNT);
  fill(18, "0xOTHER", "sell", "receipt", "landed", 7, 2, OTHER_ACCOUNT);
  // A duplicate with forged figures must not acquire the real fill's evidence.
  fill(19, "0xREAL", "sell", "receipt", "landed", 7000, 6995);
  raw.prepare("UPDATE trades SET user_op_hash = '0xop2' WHERE id = 19").run();
  fill(20, "0xNAMED", "sell", "receipt", "landed", 7, 2, ACCOUNT, 2, "T123456789AB");
  raw.prepare("INSERT INTO decisions VALUES ('named', ?, 'T123456789AB', 'Cash Cat')").run(ACCOUNT);
  raw.prepare("UPDATE trades SET decision_id = 'named' WHERE id = 20").run();
  fill(21, "0xFOREIGNNAME", "sell", "receipt", "landed", 7, 2, ACCOUNT, 2, "T123456789AB");
  raw.prepare("INSERT INTO decisions VALUES ('foreign-name', ?, 'CASHCAT', 'Cash Cat')").run(OTHER_ACCOUNT);
  raw.prepare("UPDATE trades SET decision_id = 'foreign-name' WHERE id = 21").run();
});
after(() => {
  raw?.close();
  process.chdir(cwd);
  resetGrantStoreForTest();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});
const request = (query: string, owner: typeof OWNER | typeof OTHER | null = OWNER) => GET(new Request(`https://app.example.test/api/pnl${query}`, {
  headers: owner ? { cookie: `mm_session=${mintSession(owner)}` } : {},
}));
const privateResponse = (res: Response) => {
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("vary"), "Cookie");
};

describe("private trade P&L PNG", () => {
  it("renders a real 1280x853 PNG only from the owner's evidenced live sale", async () => {
    const res = await request("?trade=2");
    assert.equal(res.status, 200, res.status === 200 ? "" : await res.text());
    privateResponse(res);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="CASHCAT-pnl.png"');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["png", 1280, 853]);
  });
  it("uses the recorded sale proceeds and cost consumed, and resolves only this account's coin name", async () => {
    const expected = { kind: "card", card: { symbol: "CASHCAT", investedUsdg: 5_000_000n, proceedsUsdg: 7_000_000n, realisedUsdg: 2_000_000n } };
    assert.deepEqual(await readTradePnl(wrapSqlite(raw), ACCOUNT, 2), expected);
    assert.deepEqual(await readTradePnl(wrapSqlite(raw), ACCOUNT, 20), { ...expected, card: { ...expected.card, symbol: "Cash Cat" } });
    assert.equal((await request("?trade=21")).status, 409);
  });
  it("reports unavailable history without inventing an empty or zero result", async () => {
    raw.exec("ALTER TABLE trades RENAME TO saved_trades");
    try {
      const res = await request("?trade=2");
      assert.equal(res.status, 503);
      assert.match(await res.text(), /history is unavailable/);
      privateResponse(res);
    } finally { raw.exec("ALTER TABLE saved_trades RENAME TO trades"); }
  });
  it("can load the traced template when the serverless working directory is the repository root", async () => {
    process.chdir(cwd);
    try { assert.equal((await request("?trade=2")).status, 200); }
    finally { process.chdir(fileURLToPath(new URL("../../../../", import.meta.url))); }
  });
  it("does not reveal another account, a past run, a duplicate or a missing id", async () => {
    for (const [id, owner] of [[2, OTHER], [18, OWNER], [2, null], [16, OWNER], [19, OWNER], [999, OWNER]] as const) {
      const res = await request(`?trade=${id}&agent=${ACCOUNT}`, owner);
      assert.equal(res.status, 404, `${id} ${owner}`);
      assert.equal(await res.text(), "Not found.");
      privateResponse(res);
    }
  });
  it("rejects malformed, ambiguous and unsafe ids before looking up any trade", async () => {
    for (const query of ["", "?trade=", "?trade=0", "?trade=-1", "?trade=1.0", "?trade=1e0", "?trade=0x2", "?trade=02", "?trade=9007199254740992", "?trade=2&trade=18"]) {
      const res = await request(query);
      assert.equal(res.status, 400, query);
      privateResponse(res);
    }
  });
  it("never prints estimates, paper fills, unfinished attempts, dust or malformed money as real P&L", async () => {
    for (const id of [1, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15]) {
      const res = await request(`?trade=${id}`);
      assert.equal(res.status, 409, `${id}: ${await res.text()}`);
      privateResponse(res);
    }
  });
  it("self-hosted uses only the disk account and never a query-selected account", async () => {
    delete process.env.MERRYMEN_HOSTED;
    writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: ACCOUNT }));
    try {
      const own = await request("?trade=2", null);
      assert.equal(own.status, 200);
      assert.equal((await request(`?trade=18&agent=${OTHER_ACCOUNT}`, null)).status, 404);
    } finally { process.env.MERRYMEN_HOSTED = "1"; }
  });
});
