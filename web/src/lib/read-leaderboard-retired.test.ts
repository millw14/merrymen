import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "../../../worker/src/db";
import { readLeaderboard } from "./read-leaderboard";
import { RECENT_BEAT_SEC, isRetired, type AgentLifecycle } from "./retired-agent";

const NOW = 2_000_000_000;
const HOUR = 3600;
const DAY = 24 * HOUR;

const agent = (over: Partial<AgentLifecycle>): AgentLifecycle => ({
  slug: "slugaaaaaaaaaaaa",
  mode: "paper",
  status: "armed",
  beatAt: NOW - 60,
  expiresAt: NOW + 30 * DAY,
  ...over,
});

describe("which agents are retired from the board", () => {
  it("a killed or expired agent is retired, whatever its heartbeat says", () => {
    assert.equal(isRetired(agent({ status: "killed" }), NOW), true);
    assert.equal(isRetired(agent({ status: "expired" }), NOW), true);
  });

  it("a key past its expiry is retired even when nobody wrote the status", () => {
    // The worker only ever retires the grant it loaded. A re-grant leaves the
    // OLD account's row reading 'armed' forever, and that row is exactly one
    // of the clones this exists to fold away.
    assert.equal(isRetired(agent({ expiresAt: NOW }), NOW), true);
    assert.equal(isRetired(agent({ expiresAt: NOW - DAY }), NOW), true);
    assert.equal(isRetired(agent({ expiresAt: NOW + 1 }), NOW), false);
  });

  it("an account with no public id stays only while something is running it", () => {
    // The "Robin 24 trades –" rows: accounts from before the identity store,
    // which nothing links to and nobody is running.
    assert.equal(isRetired(agent({ slug: null, mode: "live", beatAt: NOW - 10 * DAY }), NOW), true);
    assert.equal(isRetired(agent({ slug: null, mode: null, beatAt: null }), NOW), true);
    assert.equal(isRetired(agent({ slug: null, mode: "paper", beatAt: NOW - HOUR }), NOW), false);
    assert.equal(isRetired(agent({ slug: null, mode: "idle", beatAt: NOW - HOUR }), NOW), false);
  });

  it("an idle agent that has stopped beating is retired; one still beating is only waiting", () => {
    // 'idle' is the worker refusing to trade — no cash, no gas, a dead policy.
    // While it beats, it is an agent waiting on its owner, and calling it
    // retired would be a claim about it that is false.
    assert.equal(isRetired(agent({ mode: "idle", beatAt: NOW - 2 * DAY }), NOW), true);
    assert.equal(isRetired(agent({ mode: "idle", beatAt: NOW - HOUR }), NOW), false);
  });

  it("a named agent with a live key keeps its row through a quiet worker", () => {
    // A deploy, a crash-loop cool-off or an outage silences the heartbeat
    // without ending anything. The key is still good; the row stays.
    assert.equal(isRetired(agent({ mode: "live", beatAt: NOW - 3 * DAY }), NOW), false);
    // And one that has never beaten is newborn, not retired.
    assert.equal(isRetired(agent({ mode: null, beatAt: null }), NOW), false);
  });

  it("'recently' is a day, and a heartbeat in milliseconds reads the same as one in seconds", () => {
    assert.equal(isRetired(agent({ slug: null, beatAt: NOW - RECENT_BEAT_SEC }), NOW), false);
    assert.equal(isRetired(agent({ slug: null, beatAt: NOW - RECENT_BEAT_SEC - 1 }), NOW), true);
    assert.equal(isRetired(agent({ slug: null, beatAt: (NOW - HOUR) * 1000 }), NOW), false);
    // Read as seconds, a milliseconds stamp is centuries ahead and would keep a
    // month-dead account "beating" for ever.
    assert.equal(isRetired(agent({ slug: null, beatAt: (NOW - 40 * DAY) * 1000 }), NOW), true);
  });
});

describe("the board folds retired agents into a count", () => {
  async function board(extraSql = "", opts: { lifecycle?: boolean } = {}) {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    const lifecycle = opts.lifecycle !== false;
    await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, x_verified INTEGER, epoch INTEGER, mode TEXT, created_at INTEGER, contributions_known INTEGER${lifecycle ? ", status TEXT, beat_at INTEGER, expires_at INTEGER" : ""});
      CREATE TABLE equity(agent_id TEXT, epoch INTEGER, equity_usdg REAL, at INTEGER, id INTEGER, mode TEXT);
      CREATE TABLE flows(agent_id TEXT, epoch INTEGER, direction TEXT, amount_usdg REAL);
      CREATE TABLE trades(agent_id TEXT, epoch INTEGER, status TEXT, gas_usdg REAL);
      ${extraSql}`);
    const identities = async () => [
      { tenant: "0x1" as const, slug: "aaaaaaaaaaaaaaaa", accounts: ["0xa1", "0xa0"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
      { tenant: "0x2" as const, slug: "bbbbbbbbbbbbbbbb", accounts: ["0xb1"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
      { tenant: "0x3" as const, slug: "cccccccccccccccc", accounts: ["0xc1"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
      { tenant: "0x4" as const, slug: "dddddddddddddddd", accounts: ["0xd1"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
      { tenant: "0x5" as const, slug: "eeeeeeeeeeeeeeee", accounts: ["0xe1"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
    ];
    try {
      return await readLeaderboard((fn) => fn(db), identities, () => NOW);
    } finally {
      raw.close();
    }
  }

  it("clones and dead agents leave the list, and the count says how many", async () => {
    const r = await board(`INSERT INTO agents VALUES
      ('0xa1','Amber Heron',NULL,0,1,'paper',9,1,'armed',${NOW - 60},${NOW + DAY}),
      ('0xa0','Amber Heron (old key)',NULL,0,1,'live',1,1,'armed',${NOW - 90 * DAY},${NOW + DAY}),
      ('0xb1','Killed',NULL,0,1,'live',8,1,'killed',${NOW - 60},${NOW + DAY}),
      ('0xc1','Lapsed',NULL,0,1,'live',7,1,'armed',${NOW - 60},${NOW - 1}),
      ('0xd1','Waiting',NULL,0,1,'idle',6,1,'armed',${NOW - 60},${NOW + DAY}),
      ('0xe1','Newborn',NULL,0,1,NULL,10,NULL,'armed',NULL,${NOW + DAY}),
      ('0xr1','Robin',NULL,0,1,'live',5,1,'armed',${NOW - 40 * DAY},${NOW + DAY}),
      ('0xr2','Robin',NULL,0,1,'paper',4,1,'armed',NULL,${NOW + DAY}),
      ('0xr3','Robin',NULL,0,1,'paper',3,1,'armed',${NOW - HOUR},${NOW + DAY});`);
    // Amber Heron: the newest account wins the slug, as before — its older
    // key is the SAME agent, not a retired one, so it is not counted twice.
    // Newborn has never beaten: the ledger COALESCEs its mode to idle, and it
    // must not be retired for that before its first tick.
    assert.deepEqual(r.agents.map((a) => a.name).sort(), ["Amber Heron", "Newborn", "Robin", "Waiting"]);
    assert.equal(r.agents.find((a) => a.name === "Robin")!.slug, null, "the running unlinked agent stays");
    assert.equal(r.retired, 4, "Killed, Lapsed and two unrun Robins");
  });

  it("a ledger too old to say how agents are doing lists everyone and counts nothing", async () => {
    // Unknown is not zero: a count of 0 would claim there are no retired
    // agents, when the truth is nobody could tell.
    const r = await board(
      `INSERT INTO agents VALUES ('0xr1','Robin',NULL,0,1,'live',5,1),('0xr2','Robin',NULL,0,1,'paper',4,1);`,
      { lifecycle: false },
    );
    assert.equal(r.agents.length, 2);
    assert.equal(r.retired, null);
  });

  it("an unreadable ledger has no retired count either", async () => {
    const r = await readLeaderboard((fn) => fn(null), async () => [], () => NOW);
    assert.equal(r.source, "none");
    assert.equal(r.retired, null);
  });
});

describe("when the identity store cannot be read", () => {
  it("named agents stay listed, and the retired count is unknown rather than built from nothing", async () => {
    // Without slugs every row looked unlinked, and an unlinked row that has not
    // beaten in a day is retired — so Shogun and SirSendIt, live with good keys
    // through a quiet worker, left the board, and `retired` came back 2.
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, x_verified INTEGER, epoch INTEGER, mode TEXT, created_at INTEGER, contributions_known INTEGER, status TEXT, beat_at INTEGER, expires_at INTEGER);
        CREATE TABLE equity(agent_id TEXT, epoch INTEGER, equity_usdg REAL, at INTEGER, id INTEGER, mode TEXT);
        CREATE TABLE flows(agent_id TEXT, epoch INTEGER, direction TEXT, amount_usdg REAL);
        CREATE TABLE trades(agent_id TEXT, epoch INTEGER, status TEXT, gas_usdg REAL);
        INSERT INTO agents VALUES
          ('0xs1','Shogun',NULL,0,1,'live',2,1,'armed',${NOW - 2 * DAY},${NOW + 5 * DAY}),
          ('0xs2','SirSendIt',NULL,0,1,'live',1,1,'armed',${NOW - 2 * DAY},${NOW + 5 * DAY});`);
      const readable = await readLeaderboard(
        (fn) => fn(db),
        async () => [
          { tenant: "0x1" as const, slug: "shogunshogunshog", accounts: ["0xs1"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
          { tenant: "0x2" as const, slug: "sirsendsirsendsi", accounts: ["0xs2"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
        ],
        () => NOW,
      );
      assert.deepEqual(readable.agents.map((a) => a.name).sort(), ["Shogun", "SirSendIt"]);
      assert.equal(readable.retired, 0);
      const unreadable = await readLeaderboard(
        (fn) => fn(db),
        async () => {
          throw new Error("identity store down");
        },
        () => NOW,
      );
      assert.deepEqual(unreadable.agents.map((a) => a.name).sort(), ["Shogun", "SirSendIt"]);
      assert.equal(unreadable.retired, null);
    } finally {
      raw.close();
    }
  });
});
