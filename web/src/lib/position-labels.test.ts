import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CASH, STOCK_TOKENS } from "../../../packages/core/src/index";
import { wrapSqlite } from "../../../worker/src/db";
import { positionFillSymbol, positionTokenAddress, readPositionLabels } from "./position-labels";

const SWARM = "0x7eebda046d451bc7a7d12491eff72a861aa8136e";
const INDEX = "0x56910d4409f3a0c78c64dd8d0545ff0705389870";
const VORTA = "0xcb77210e1a8caac7684021b31410cbee89668018";
const OTHER = "0x11111111111111111111111111111a861aa8136e";

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE trades(id INTEGER PRIMARY KEY, agent_id TEXT, kind TEXT, status TEXT,
    buy_token TEXT, sell_token TEXT, fill_symbol TEXT, created_at INTEGER);
    CREATE INDEX trades_agent_time ON trades(agent_id, created_at DESC);`);
  let at = 0;
  const insert = raw.prepare("INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const add = (token: string, label: string | null, o: { account?: string; status?: string; kind?: string; sell?: boolean; cash?: string } = {}) => {
    ++at;
    insert.run(at, o.account ?? "owner", o.kind ?? "swap", o.status ?? "landed",
      o.sell ? o.cash ?? CASH.USDG : token, o.sell ? token : o.cash ?? CASH.USDG, label, at);
  };
  return { raw, db: wrapSqlite(raw), add };
}

describe("saved position display labels", () => {
  it("protects an official ticker by full address, including punctuation and casing variants", () => {
    // The shipped official registry is empty; this is a synthetic future listing.
    const official = [{ symbol: "CURATED", address: OTHER as `0x${string}`, decimals: 18 }];
    for (const copied of ["CURATED", "$curated", "c-u-r-a-t-e-d"]) assert.equal(positionFillSymbol(SWARM, copied, official), null);
    assert.equal(positionFillSymbol(OTHER, "UntrustedName", official), "CURATED");
    assert.equal(positionFillSymbol(SWARM, "SWARM", official), "SWARM");
  });

  it("keeps curated cash and stocks readable by full address without fill rows or a fill schema", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    const stock = STOCK_TOKENS.find(t => t.symbol === "NVDA")!;
    try {
      const expected = new Map([[stock.address.toLowerCase(), stock.symbol]]);
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [stock.address.toUpperCase(), SWARM]), expected);
      raw.exec("CREATE TABLE trades(id INTEGER, agent_id TEXT, kind TEXT, status TEXT, buy_token TEXT, sell_token TEXT, created_at INTEGER)");
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [stock.address, SWARM]), expected);
      raw.exec("ALTER TABLE trades ADD COLUMN fill_symbol TEXT");
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [stock.address, SWARM]), expected);
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [CASH.USDG, CASH.WETH]),
        new Map([[CASH.USDG.toLowerCase(), "USDG"], [CASH.WETH.toLowerCase(), "WETH"]]));
    } finally { raw.close(); }
  });

  it("resolves the real tickers from fills by full address, without decisions or chain reads", async () => {
    const { raw, db, add } = fixture();
    try {
      add(SWARM, "SWARM"); add(INDEX, "Index"); add(VORTA, "VORTA", { sell: true });
      raw.exec("PRAGMA query_only = ON");
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [SWARM, INDEX, VORTA]),
        new Map([[VORTA, "VORTA"], [INDEX, "Index"], [SWARM, "SWARM"]]));
    } finally { raw.close(); }
  });

  it("keeps the owner, book and full address separate even when shortened IDs collide", async () => {
    const { raw, db, add } = fixture();
    try {
      add(SWARM, "SWARM");
      add(OTHER, "Different");
      add(SWARM, "Practise", { status: "paper" });
      add(SWARM, "OtherOwner", { account: "other" });
      add(SWARM, "NotFilled", { status: "failed" });
      add(SWARM, "NotASwap", { kind: "deposit" });
      add(SWARM, "Ambiguous", { cash: INDEX });
      assert.equal(SWARM.slice(-11), OTHER.slice(-11), "the shortened ledger ID alone would collide");
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [SWARM]), new Map([[SWARM, "SWARM"]]));
      assert.deepEqual(await readPositionLabels(db, "owner", "paper", [SWARM]), new Map([[SWARM, "Practise"]]));
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [OTHER]), new Map([[OTHER, "Different"]]));
      assert.deepEqual(await readPositionLabels(db, "missing", "live", [SWARM]), new Map());
    } finally { raw.close(); }
  });

  it("normalizes address casing and chooses the newest usable label for that token", async () => {
    const { raw, db, add } = fixture();
    try {
      add(SWARM, "Old");
      add(SWARM.toUpperCase().replace("0X", "0x"), "SWARM", { cash: CASH.USDG.toUpperCase() });
      add(SWARM, "<script>");
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [SWARM.toUpperCase(), SWARM]), new Map([[SWARM, "SWARM"]]));
    } finally { raw.close(); }
  });

  it("reads recorded curve-trade fills in their own live or paper book", async () => {
    const { raw, db, add } = fixture();
    try {
      add(SWARM, "SWARM", { kind: "curve-trade" });
      add(SWARM, "Practise", { kind: "curve-trade", status: "paper", sell: true });
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [SWARM]), new Map([[SWARM, "SWARM"]]));
      assert.deepEqual(await readPositionLabels(db, "owner", "paper", [SWARM]), new Map([[SWARM, "Practise"]]));
    } finally { raw.close(); }
  });

  it("does not display addresses, internal IDs, unsafe labels or impersonated trusted tickers", async () => {
    const { raw, db, add } = fixture();
    try {
      for (const label of [null, "", "?", "TA861AA8136E", "ta861aa8136e", SWARM, "<svg>", "😀", "has spaces", "NVDA", "$USDG", "t-sla"]) add(SWARM, label);
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [SWARM]), new Map());
    } finally { raw.close(); }
  });

  it("returns no label for missing history or an old schema, and never expands a shortened ID", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [SWARM]), new Map());
      raw.exec("CREATE TABLE trades(id INTEGER, agent_id TEXT, kind TEXT, status TEXT, buy_token TEXT, sell_token TEXT, created_at INTEGER)");
      assert.deepEqual(await readPositionLabels(db, "owner", "live", [SWARM]), new Map());
      for (const bad of [null, undefined, "", "TA861AA8136E", "0xa861aa8136e", `${SWARM}0`, ` ${SWARM}`]) assert.equal(positionTokenAddress(bad), null);
      assert.equal(positionTokenAddress(SWARM.toUpperCase()), SWARM);
      assert.deepEqual(await readPositionLabels(db, "owner", "live", ["TA861AA8136E", null]), new Map());
    } finally { raw.close(); }
  });
});
