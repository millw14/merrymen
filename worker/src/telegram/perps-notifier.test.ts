import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { notifyPerps, parsePerpsNotifyState, perpFundingLine, type PerpsNotifyState } from "./perps-notifier";
import type { PerpsReport } from "../../../packages/core/src/perps";
const AGENT = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222";
const T = 1_800_000_000;
const report = (over: Partial<PerpsReport> = {}): PerpsReport => ({ v: 1, mode: "live", blocker: null, venueReadAt: T * 1000, protectAt: T * 1000, accountIndex: 10,
  positions: [{ market: "BTC-PERP", side: "long", baseAmount: "0.001", entryPrice: "90000", markPrice: "90010", leverage: 2, marginMicro: "45000000", liqPrice: "45000", unrealizedMicro: "10000", stopTrigger: "85500", fundingMicro: "0" }],
  openNotionalMicro: "90000000", collateralMicro: "20000000", inTransitMicro: "0", minLiqDistanceBps: 5000, stopsMissing: 0, incident: false, ...over });
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE agents(smart_account TEXT, perps TEXT, mode TEXT); CREATE TABLE perp_fills(agent_id TEXT, created_at INTEGER, mode TEXT, venue_trade_id TEXT, side_role TEXT, market_id INTEGER, side TEXT, quote_micro TEXT, fee_micro TEXT, realized_micro TEXT, attribution TEXT, trade_type TEXT); CREATE TABLE perp_funding(agent_id TEXT, mode TEXT, funding_hour INTEGER, payment_micro TEXT)");
  db.prepare("INSERT INTO agents VALUES (?, ?, 'live')").run(AGENT, JSON.stringify(report()));
  let state: PerpsNotifyState | null = null, now = T;
  const sent: string[] = [];
  let succeeds = true;
  const put = (r: PerpsReport) => db.prepare("UPDATE agents SET perps=? WHERE smart_account=?").run(JSON.stringify(r), AGENT);
  const fill = (id: string, mode = "live", attribution = "intent", agent = AGENT) => db.prepare("INSERT INTO perp_fills VALUES (?, ?, ?, ?, 'ask', 0, 'long', '12000000', '12000', '500000', ?, 'trade')").run(agent, now, mode, id, attribution);
  const pass = () => notifyPerps({ db, agent: AGENT, owner: 17, nowSec: now, enabled: true, liqBufferPct: 3, previous: state, save: (s) => { state = s; }, send: async (text) => { if (!succeeds) return false; sent.push(text); return true; } });
  return { db, sent, put, fill, pass, at: (n: number) => { now = n; }, fail: (yes: boolean) => { succeeds = !yes; }, state: () => state, restore: () => { state = parsePerpsNotifyState(JSON.parse(JSON.stringify(state))); } };
}
describe("perps notification facts and durable episodes", () => {
  it("fills are account scoped, include stop/forced and paper labels, and survive restart without replay", async () => {
    const f = fixture();
    try {
      f.at(T - 1); f.fill("history"); f.at(T); await f.pass(); assert.equal(f.sent.length, 0);
      f.fill("stop", "paper", "venue-stop"); f.fill("forced", "live", "venue-forced"); f.fill("private-neighbor", "live", "intent", OTHER);
      await f.pass(); assert.equal(f.sent.length, 0, "the current second is not finalized");
      f.at(T + 1); await f.pass(); assert.equal(f.sent.length, 2);
      assert.match(f.sent.join("\n"), /Paper.*Venue stop/); assert.match(f.sent.join("\n"), /Forced fill/);
      assert.doesNotMatch(f.sent.join("\n"), /private-neighbor|history/);
      f.restore(); await f.pass(); assert.equal(f.sent.length, 2);
      // Physical insertion order can change when the hosted ledger is restored.
      f.db.exec("CREATE TABLE restored AS SELECT * FROM perp_fills ORDER BY venue_trade_id DESC; DROP TABLE perp_fills; ALTER TABLE restored RENAME TO perp_fills");
      await f.pass(); assert.equal(f.sent.length, 2);
    } finally { f.db.close(); }
  });
  it("a failed send advances no fill cursor and retry delivers every pending fact", async () => {
    const f = fixture();
    try { await f.pass(); f.fill("one"); f.fill("two"); f.at(T + 1); f.fail(true); await f.pass(); assert.equal(f.sent.length, 0);
      f.restore(); f.fail(false); await f.pass(); assert.equal(f.sent.length, 2); await f.pass(); assert.equal(f.sent.length, 2);
    } finally { f.db.close(); }
  });
  it("unread alerts fire at 2 and 10 minutes, once per episode, across restart", async () => {
    const f = fixture();
    try {
      f.put(report({ venueReadAt: null })); await f.pass(); f.at(T + 119); await f.pass(); assert.equal(f.sent.length, 0);
      f.at(T + 120); await f.pass(); assert.match(f.sent[0]!, /2 minutes/); f.restore(); f.at(T + 599); await f.pass(); assert.equal(f.sent.length, 1);
      f.at(T + 600); await f.pass(); assert.match(f.sent[1]!, /10 minutes/); await f.pass(); assert.equal(f.sent.length, 2);
      f.put(report({ venueReadAt: (T + 600) * 1000 })); await f.pass(); assert.equal(f.state()!.unreadSince, null);
      f.put(report({ venueReadAt: null })); await f.pass(); f.at(T + 720); await f.pass(); assert.equal(f.sent.length, 3);
    } finally { f.db.close(); }
  });
  it("liquidation and incident warnings persist until recovery and failed sends retry", async () => {
    const f = fixture();
    try {
      f.put(report({ minLiqDistanceBps: 200, incident: true })); f.fail(true); await f.pass(); assert.equal(f.sent.length, 0);
      f.fail(false); await f.pass(); assert.equal(f.sent.length, 2); f.restore(); await f.pass(); assert.equal(f.sent.length, 2);
      f.put(report()); await f.pass(); f.put(report({ minLiqDistanceBps: 200, incident: true })); await f.pass(); assert.equal(f.sent.length, 4);
    } finally { f.db.close(); }
  });
  it("funding is signed, separated by book and isolated to this agent and last 24 hours", () => {
    const f = fixture();
    try {
      const add = f.db.prepare("INSERT INTO perp_funding VALUES (?, ?, ?, ?)");
      add.run(AGENT, "live", T - 3600, "-1250000"); add.run(AGENT, "paper", T - 3600, "2500000"); add.run(OTHER, "live", T - 3600, "900000000"); add.run(AGENT, "live", T - 90_000, "900000000");
      assert.match(perpFundingLine(f.db, AGENT, T), /real −1.25 USDG · paper 2.50 USDG/);
      assert.match(perpFundingLine(null, AGENT, T), /not assumed to be zero/);
    } finally { f.db.close(); }
  });
});
