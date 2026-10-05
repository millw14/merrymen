import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "../../../worker/src/db";
import { FLEET_RECOVERY_SCHEMA } from "../../../worker/src/fleet-recovery";
import { readLeaderboard } from "./read-leaderboard";
import { INCIDENT_WINDOW, RECENT_BEAT_SEC, isRetired, notRunning, type AgentLifecycle } from "./retired-agent";

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

describe("the recovery hold is not retirement", () => {
  // Days into the hold: every beat below is far more than a day old.
  const HELD_NOW = INCIDENT_WINDOW.untilSec + 3 * DAY;
  // The fleet's last beats, at about 03:18Z on 2026-10-04.
  const LAST_BEAT = INCIDENT_WINDOW.fromSec + 3 * HOUR + 18 * 60;
  const held = (over: Partial<AgentLifecycle>): AgentLifecycle =>
    agent({ beatAt: LAST_BEAT, expiresAt: HELD_NOW + 30 * DAY, ...over });

  it("an idle named agent silent for more than a day during the hold stays listed, as not running", () => {
    // SirSendIt: idle, named, a good key, and stopped by the hold rather than
    // by its owner. The day-long rule folded it; its own last beat says why.
    const sirSendIt = held({ mode: "idle" });
    assert.ok(HELD_NOW - LAST_BEAT > RECENT_BEAT_SEC);
    assert.equal(isRetired(sirSendIt, HELD_NOW), false);
    assert.equal(notRunning(sirSendIt, HELD_NOW), true);
    // Its own hold row is evidence on its own: an idle agent that went quiet
    // in the day before the window opened had not yet been folded when the
    // hold began, and its row says the hold is why it has not been back.
    const reported = held({ mode: "idle", beatAt: INCIDENT_WINDOW.fromSec - 6 * HOUR, held: true });
    assert.equal(isRetired(reported, HELD_NOW), false);
    assert.equal(notRunning(reported, HELD_NOW), true);
  });

  it("an account that was over before the hold began stays folded, whatever its hold row says", () => {
    // A key that lapsed on 10-03, before the halt, on an agent still beating
    // into the window: the expiry is not the hold's doing.
    const lapsedFirst = held({ expiresAt: INCIDENT_WINDOW.fromSec - 16 * HOUR });
    assert.equal(isRetired(lapsedFirst, HELD_NOW), true);
    assert.equal(notRunning(lapsedFirst, HELD_NOW), false);
    // The reporter writes rows for stopped and expired tenants alike: a hold
    // row does not bring back a key that lapsed a year ago, nor an idle agent
    // a month silent — the day-long rule had folded both before the incident.
    for (const over of [
      { expiresAt: INCIDENT_WINDOW.fromSec - 365 * DAY, beatAt: INCIDENT_WINDOW.fromSec - 365 * DAY },
      { mode: "idle", beatAt: INCIDENT_WINDOW.fromSec - 30 * DAY },
      { mode: "idle", beatAt: (INCIDENT_WINDOW.fromSec - 30 * DAY) * 1000 },
    ]) {
      const ended = held({ held: true, ...over });
      assert.equal(isRetired(ended, HELD_NOW), true, JSON.stringify(over));
      assert.equal(notRunning(ended, HELD_NOW), false, JSON.stringify(over));
    }
    // A worker that said its key lapsed, on a row with no expiry to date it
    // by: nothing shows the lapse came after the halt, so it folds as before.
    assert.equal(isRetired(held({ status: "expired", expiresAt: null }), HELD_NOW), true);
    assert.equal(isRetired(held({ status: "expired", expiresAt: null, held: true }), HELD_NOW), true);
  });

  it("an account whose key expired during the hold stays listed, as not running", () => {
    const lapsed = held({ expiresAt: INCIDENT_WINDOW.untilSec + DAY });
    assert.equal(isRetired(lapsed, HELD_NOW), false);
    assert.equal(notRunning(lapsed, HELD_NOW), true);
    // Whether or not anything wrote the status, and whichever evidence speaks.
    assert.equal(isRetired(held({ status: "expired", expiresAt: INCIDENT_WINDOW.untilSec }), HELD_NOW), false);
    assert.equal(isRetired(held({ status: "expired", beatAt: null, held: true }), HELD_NOW), false);
  });

  it("a killed account is folded, hold or not", () => {
    for (const over of [{}, { held: true }, { mode: "idle" }, { beatAt: null, held: true }]) {
      const killed = held({ status: "killed", ...over });
      assert.equal(isRetired(killed, HELD_NOW), true);
      assert.equal(notRunning(killed, HELD_NOW), false);
    }
  });

  it("a heartbeat in milliseconds reads the same as one in seconds", () => {
    for (const beat of [LAST_BEAT, INCIDENT_WINDOW.fromSec, INCIDENT_WINDOW.untilSec, INCIDENT_WINDOW.fromSec - 1, INCIDENT_WINDOW.untilSec + 1]) {
      for (const over of [{ mode: "idle" }, { expiresAt: INCIDENT_WINDOW.untilSec }]) {
        const s = held({ beatAt: beat, ...over });
        const ms = held({ beatAt: beat * 1000, ...over });
        assert.equal(isRetired(ms, HELD_NOW), isRetired(s, HELD_NOW), `beat ${beat}`);
        assert.equal(notRunning(ms, HELD_NOW), notRunning(s, HELD_NOW), `beat ${beat}`);
      }
    }
    // And the window really does decide it — in both units.
    assert.equal(isRetired(held({ mode: "idle", beatAt: LAST_BEAT * 1000 }), HELD_NOW), false);
    assert.equal(isRetired(held({ mode: "idle", beatAt: (INCIDENT_WINDOW.fromSec - 1) * 1000 }), HELD_NOW), true);
  });

  it("only the account's own evidence speaks, and the ordinary rules hold outside it", () => {
    // Silent since before the incident, with no hold row: not the hold's doing.
    assert.equal(isRetired(held({ mode: "idle", beatAt: INCIDENT_WINDOW.fromSec - DAY }), HELD_NOW), true);
    assert.equal(isRetired(held({ expiresAt: INCIDENT_WINDOW.fromSec - DAY, beatAt: INCIDENT_WINDOW.fromSec - DAY }), HELD_NOW), true);
    // A worker the resume restarted beats after the window, and is judged as
    // before when it stops again.
    assert.equal(isRetired(held({ mode: "idle", beatAt: INCIDENT_WINDOW.untilSec + 1 }), HELD_NOW + 30 * DAY), true);
    // An account with no public id is the clone row, held or not.
    assert.equal(isRetired(held({ slug: null, held: true }), HELD_NOW), true);
    assert.equal(isRetired(held({ slug: null }), HELD_NOW), true);
    assert.equal(notRunning(held({ slug: null, held: true }), HELD_NOW), false);
  });

  it("not running is said only of a silent row: a held account still beating is listed as before", () => {
    const fresh = held({ held: true, beatAt: HELD_NOW - HOUR });
    assert.equal(isRetired(fresh, HELD_NOW), false);
    assert.equal(notRunning(fresh, HELD_NOW), false);
    // And a quiet worker with no hold evidence keeps its row, unlabelled.
    const quiet = agent({ mode: "live", beatAt: NOW - 3 * DAY });
    assert.equal(isRetired(quiet, NOW), false);
    assert.equal(notRunning(quiet, NOW), false);
  });

  it("an account still beating is judged by the ordinary rules: one whose key lapsed is folded", () => {
    // A worker restarted inside the window, whose key then lapsed. It is not
    // the hold's doing, so it is not kept as an unlabelled row for a day and
    // relabelled "Not running" after it — it is over, as it was before.
    const inside = INCIDENT_WINDOW.untilSec - HOUR;
    const now = inside + HOUR;
    for (const over of [{ status: "expired" }, { expiresAt: inside }, { status: "expired", held: true }]) {
      const restarted = agent({ beatAt: inside, ...over });
      assert.equal(isRetired(restarted, now), true, JSON.stringify(over));
      assert.equal(notRunning(restarted, now), false, JSON.stringify(over));
    }
    // And in milliseconds, the same.
    assert.equal(isRetired(agent({ status: "expired", beatAt: inside * 1000 }), now), true);
  });
});

describe("the board folds retired agents into a count", () => {
  async function board(extraSql = "", opts: { lifecycle?: boolean; now?: number } = {}) {
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
      { tenant: "0x6" as const, slug: "ffffffffffffffff", accounts: ["0xf1"] as `0x${string}`[], createdAt: 1, updatedAt: 1 },
    ];
    try {
      return await readLeaderboard((fn) => fn(db), identities, () => opts.now ?? NOW, async () => null);
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

  describe("during the recovery hold", () => {
    const HELD_NOW = INCIDENT_WINDOW.untilSec + 3 * DAY;
    const LAST_BEAT = INCIDENT_WINDOW.fromSec + 3 * HOUR + 18 * 60;
    const LAPSED_AT = INCIDENT_WINDOW.untilSec;
    // Quiet in the day before the window opened: not yet folded when the hold began.
    const QUIET = INCIDENT_WINDOW.fromSec - 6 * HOUR;
    const BEFORE = INCIDENT_WINDOW.fromSec - 10 * DAY;
    const fleet = (beat: (sec: number) => number, holds = true) => `
      INSERT INTO agents VALUES
        ('0xa1','SirSendIt',NULL,0,1,'idle',9,1,'armed',${beat(LAST_BEAT)},${HELD_NOW + 30 * DAY}),
        ('0xb1','Lapsed',NULL,0,1,'live',8,1,'armed',${beat(LAST_BEAT)},${LAPSED_AT}),
        ('0xc1','Killed',NULL,0,1,'live',7,1,'killed',${beat(LAST_BEAT)},${HELD_NOW + 30 * DAY}),
        ('0xd1','Reported',NULL,0,1,'idle',6,1,'armed',${beat(QUIET)},${HELD_NOW + 30 * DAY}),
        ('0xe1','Gone',NULL,0,1,'idle',5,1,'armed',${beat(QUIET)},${HELD_NOW + 30 * DAY}),
        ('0xf1','Over',NULL,0,1,'idle',3,1,'armed',${beat(BEFORE)},${HELD_NOW + 30 * DAY}),
        ('0xr1','Robin',NULL,0,1,'idle',4,1,'armed',${beat(LAST_BEAT)},${HELD_NOW + 30 * DAY});
      ${holds ? `${FLEET_RECOVERY_SCHEMA}
      INSERT INTO fleet_recovery_health VALUES
        ('0x3','0xc1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x4','0xd1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x9','0xe1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x5','0xe1',4663,0,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x6','0xf1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x0','0xr1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT});` : ""}`;
    const seconds = (sec: number) => sec;

    it("an idle named agent and one whose key lapsed stay listed as not running; killed is folded", async () => {
      const r = await board(fleet(seconds), { now: HELD_NOW });
      // SirSendIt and Lapsed on their own last beats inside the incident
      // window; Reported on its own hold row, though it went quiet earlier.
      assert.deepEqual(r.agents.map((a) => a.name).sort(), ["Lapsed", "Reported", "SirSendIt"]);
      for (const a of r.agents) assert.equal(a.notRunning, true, a.name);
      // Killed whatever its hold row says; Gone went quiet before the incident
      // and only ANOTHER tenant's row, or a cleared one, names its account;
      // Over had been folded days before the hold, and its own row does not
      // bring it back; Robin has no public id, held or not. The count stays
      // exact.
      assert.equal(r.retired, 4, "Killed, Gone, Over and Robin");
    });

    it("the public payload says neither expired nor re-sign, and carries no expiry", async () => {
      const r = await board(fleet(seconds), { now: HELD_NOW });
      const wire = JSON.stringify(r);
      assert.doesNotMatch(wire, /expire|re-?sign|renew/i);
      assert.ok(!wire.includes(String(LAPSED_AT)), "the lapsed key's expiry is not published");
    });

    it("a heartbeat in milliseconds gives the same board as one in seconds", async () => {
      const s = await board(fleet(seconds), { now: HELD_NOW });
      const ms = await board(fleet((sec) => sec * 1000), { now: HELD_NOW });
      const shape = (r: typeof s) => ({ retired: r.retired, rows: r.agents.map((a) => [a.name, a.notRunning]).sort() });
      assert.deepEqual(shape(ms), shape(s));
      assert.equal(s.agents.length, 3);
    });

    it("a ledger with no recovery table is no hold, and each account's own beat still speaks", async () => {
      const r = await board(fleet(seconds, false), { now: HELD_NOW });
      assert.deepEqual(r.agents.map((a) => a.name).sort(), ["Lapsed", "SirSendIt"]);
      assert.equal(r.retired, 5, "Killed, Reported, Gone, Over and Robin");
    });

    it("outside the hold nothing changes: rows still beating carry no label", async () => {
      const r = await board(`INSERT INTO agents VALUES
        ('0xa1','Amber Heron',NULL,0,1,'paper',9,1,'armed',${NOW - 60},${NOW + DAY}),
        ('0xd1','Waiting',NULL,0,1,'idle',6,1,'armed',${NOW - 60},${NOW + DAY});`);
      assert.deepEqual(r.agents.map((a) => [a.name, a.notRunning]).sort(), [["Amber Heron", false], ["Waiting", false]]);
    });
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
        async () => null,
      );
      assert.deepEqual(readable.agents.map((a) => a.name).sort(), ["Shogun", "SirSendIt"]);
      assert.equal(readable.retired, 0);
      const unreadable = await readLeaderboard(
        (fn) => fn(db),
        async () => {
          throw new Error("identity store down");
        },
        () => NOW,
        async () => null,
      );
      assert.deepEqual(unreadable.agents.map((a) => a.name).sort(), ["Shogun", "SirSendIt"]);
      assert.equal(unreadable.retired, null);
    } finally {
      raw.close();
    }
  });
});
