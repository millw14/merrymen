import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { FLEET_RECOVERY_SCHEMA } from "../../../worker/src/fleet-recovery";
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

describe("no calendar date decides a row", () => {
  // The Oct 4–6 recovery hold's window (2026-10-04T00:00Z to 10-06T00:00Z),
  // retired on 2026-11-04. Kept here only as a date to test against: nothing
  // in retired-agent.ts may treat it, or any other date, as special.
  const OLD_FROM = 1_791_072_000;
  const OLD_UNTIL = 1_791_244_800;
  // The fleet's last beats before the halt, at about 03:18Z on 10-04.
  const LAST_BEAT = OLD_FROM + 3 * HOUR + 18 * 60;
  // The day the window was retired: a month after those beats.
  const A_MONTH_ON = 1_793_793_600;

  it("an agent silenced on 10-04 is judged a month on by its own beat and key, like any other", () => {
    // SirSendIt's shape: named, idle, a good key, last beat 10-04 03:18Z.
    // Idle and silent for a month: over, and counted with the retired.
    assert.equal(isRetired(agent({ mode: "idle", beatAt: LAST_BEAT, expiresAt: A_MONTH_ON + 30 * DAY }), A_MONTH_ON), true);
    // A key that lapsed since: over, whether or not the worker wrote it.
    assert.equal(isRetired(agent({ mode: "live", beatAt: LAST_BEAT, expiresAt: OLD_UNTIL + DAY }), A_MONTH_ON), true);
    assert.equal(isRetired(agent({ mode: "paper", beatAt: LAST_BEAT, status: "expired", expiresAt: null }), A_MONTH_ON), true);
    // A named agent with a good key keeps its row through a quiet worker, as
    // it always has — unlabelled, because nothing on the row is a hold now.
    assert.equal(isRetired(agent({ mode: "live", beatAt: LAST_BEAT, expiresAt: A_MONTH_ON + DAY }), A_MONTH_ON), false);
    assert.equal(isRetired(agent({ mode: "paper", beatAt: LAST_BEAT * 1000, expiresAt: A_MONTH_ON + DAY }), A_MONTH_ON), false);
    // Killed is over, and an account with no public id is the clone row.
    assert.equal(isRetired(agent({ status: "killed", beatAt: LAST_BEAT }), A_MONTH_ON), true);
    assert.equal(isRetired(agent({ slug: null, beatAt: LAST_BEAT }), A_MONTH_ON), true);
  });

  it("the verdict depends on how old the beat and the key are, never on which day it is", () => {
    // Slide the same lifecycle across months, through the old window and its
    // edges, in both units: a rule pinned to a date flips somewhere here.
    const shapes: [string, (t: number) => Partial<AgentLifecycle>][] = [
      ["idle, quiet two days", (t) => ({ mode: "idle", beatAt: t - 2 * DAY, expiresAt: t + 30 * DAY })],
      ["idle, still beating", (t) => ({ mode: "idle", beatAt: t - HOUR, expiresAt: t + 30 * DAY })],
      ["live, quiet two days, good key", (t) => ({ mode: "live", beatAt: t - 2 * DAY, expiresAt: t + DAY })],
      ["live, key lapsed yesterday", (t) => ({ mode: "live", beatAt: t - 2 * DAY, expiresAt: t - DAY })],
      ["unnamed, quiet two days", (t) => ({ slug: null, mode: "paper", beatAt: t - 2 * DAY, expiresAt: t + DAY })],
    ];
    const at = (t: number) => shapes.map(([, f]) => isRetired(agent(f(t)), t));
    const want = at(NOW);
    assert.deepEqual(want, [true, false, false, true, true]);
    for (let t = OLD_FROM - 10 * DAY; t <= A_MONTH_ON + 10 * DAY; t += 7 * HOUR) {
      assert.deepEqual(at(t), want, `now ${t}`);
    }
    for (const t of [OLD_FROM, LAST_BEAT, OLD_UNTIL, OLD_FROM + DAY, OLD_UNTIL + DAY]) {
      assert.deepEqual(at(t), want, `edge ${t}`);
      const ms = shapes.map(([, f]) => {
        const l = f(t);
        return isRetired(agent({ ...l, beatAt: l.beatAt! * 1000 }), t);
      });
      assert.deepEqual(ms, want, `edge ${t} in ms`);
    }
  });
});

describe("the board folds retired agents into a count", () => {
  async function board(
    extraSql = "",
    opts: { lifecycle?: boolean; now?: number; lifecycleRows?: Record<string, unknown>[] } = {},
  ) {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    // `lifecycleRows` collects what the lifecycle read itself returned, so a
    // test can check the SQL's own normalisation rather than the JS after it.
    const seen = opts.lifecycleRows;
    const read: Db = seen
      ? {
          exec: (sql) => db.exec(sql),
          tx: (fn) => db.tx(fn),
          prepare(sql) {
            const stmt = db.prepare(sql);
            if (!sql.includes("AS beat_at")) return stmt;
            return {
              run: (...p) => stmt.run(...p),
              get: (...p) => stmt.get(...p),
              all: async (...p) => {
                const rows = await stmt.all(...p);
                seen.push(...(rows as Record<string, unknown>[]));
                return rows;
              },
            };
          },
        }
      : db;
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
      return await readLeaderboard((fn) => fn(read), identities, () => opts.now ?? NOW, async () => null);
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
    // And each folded account is listed under the count; with no valuation on
    // record none has a return, so none is invented.
    assert.deepEqual(r.retiredAgents.map((a) => a.name).sort(), ["Killed", "Lapsed", "Robin", "Robin"]);
    assert.equal(r.retiredAgents.find((a) => a.name === "Killed")!.slug, "bbbbbbbbbbbbbbbb");
    assert.ok(r.retiredAgents.every((a) => a.pnlBps === null && a.pnlUsdg === null));
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
    assert.deepEqual(r.retiredAgents, []);
  });

  it("an unreadable ledger has no retired count either", async () => {
    const r = await readLeaderboard((fn) => fn(null), async () => [], () => NOW);
    assert.equal(r.source, "none");
    assert.equal(r.retired, null);
  });

  describe("a month after the recovery hold", () => {
    // The seven board agents the Oct 4–6 window kept stamped "Not running":
    // every one last beat inside it, or has a hold row recorded inside it.
    const LAST_BEAT = 1_791_072_000 + 3 * HOUR + 18 * 60;
    const QUIET = 1_791_072_000 - 6 * HOUR;
    const A_MONTH_ON = 1_793_793_600;
    const LAPSED_AT = 1_791_244_800;
    const GOOD_KEY = A_MONTH_ON + 30 * DAY;
    const fleet = (beat: (sec: number) => number, holds = true) => `
      INSERT INTO agents VALUES
        ('0xa1','SirSendIt',NULL,0,1,'idle',9,1,'armed',${beat(LAST_BEAT)},${GOOD_KEY}),
        ('0xb1','Lapsed',NULL,0,1,'live',8,1,'armed',${beat(LAST_BEAT)},${LAPSED_AT}),
        ('0xc1','Killed',NULL,0,1,'live',7,1,'killed',${beat(LAST_BEAT)},${GOOD_KEY}),
        ('0xd1','Reported',NULL,0,1,'idle',6,1,'armed',${beat(QUIET)},${GOOD_KEY}),
        ('0xe1','Quiet',NULL,0,1,'paper',5,1,'armed',${beat(LAST_BEAT)},${GOOD_KEY}),
        ('0xf1','Running',NULL,0,1,'paper',3,1,'armed',${beat(A_MONTH_ON - 60)},${GOOD_KEY}),
        ('0xr1','Robin',NULL,0,1,'idle',4,1,'armed',${beat(LAST_BEAT)},${GOOD_KEY});
      ${holds ? `${FLEET_RECOVERY_SCHEMA}
      INSERT INTO fleet_recovery_health VALUES
        ('0x1','0xa1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x2','0xb1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x3','0xc1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x4','0xd1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x5','0xe1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT}),
        ('0x0','0xr1',4663,1,'persistent-source',${LAST_BEAT},${LAST_BEAT});` : ""}`;
    const seconds = (sec: number) => sec;
    const shape = (r: Awaited<ReturnType<typeof board>>) => ({
      retired: r.retired,
      rows: r.agents.map((a) => a.name).sort(),
      folded: r.retiredAgents.map((a) => a.name).sort(),
    });

    it("each agent is listed or folded on its own beat and key; nothing is kept by a date", async () => {
      const r = await board(fleet(seconds), { now: A_MONTH_ON });
      // Quiet: a named agent with a good key, kept through a quiet worker as
      // main always kept one. Running: beating now.
      assert.deepEqual(shape(r), {
        retired: 5,
        rows: ["Quiet", "Running"],
        folded: ["Killed", "Lapsed", "Reported", "Robin", "SirSendIt"],
      });
    });

    it("no row carries a not-running flag, and the payload names no expiry", async () => {
      const r = await board(fleet(seconds), { now: A_MONTH_ON });
      for (const a of r.agents) assert.equal("notRunning" in a, false, a.name);
      const wire = JSON.stringify(r);
      assert.doesNotMatch(wire, /notRunning|expire|re-?sign|renew/i);
      for (const t of [LAPSED_AT, GOOD_KEY]) assert.ok(!wire.includes(String(t)), `expiry ${t} is not published`);
    });

    it("the recovery table is the owner's report: hold rows change nothing on the public board", async () => {
      const held = await board(fleet(seconds), { now: A_MONTH_ON });
      const none = await board(fleet(seconds, false), { now: A_MONTH_ON });
      assert.deepEqual(shape(held), shape(none));
      // Nor during the incident itself: a hold row is never read here.
      const during = LAST_BEAT + 3 * DAY;
      assert.deepEqual(shape(await board(fleet(seconds), { now: during })), shape(await board(fleet(seconds, false), { now: during })));
    });

    it("a heartbeat in milliseconds gives the same board as one in seconds", async () => {
      const s = await board(fleet(seconds), { now: A_MONTH_ON });
      const ms = await board(fleet((sec) => sec * 1000), { now: A_MONTH_ON });
      assert.deepEqual(shape(ms), shape(s));
    });

    it("the lifecycle read itself hands each beat back in seconds, whichever unit it was written in", async () => {
      // The SQL normalises on its own row and seconds() in retired-agent.ts
      // does again, so the board above agrees in both units with either one
      // gone. This reads what the SQL returned, so each is tested on its own.
      const ms: Record<string, unknown>[] = [];
      await board(fleet((sec) => sec * 1000), { now: A_MONTH_ON, lifecycleRows: ms });
      const s: Record<string, unknown>[] = [];
      await board(fleet(seconds), { now: A_MONTH_ON, lifecycleRows: s });
      const beats = (rows: Record<string, unknown>[]) =>
        Object.fromEntries(rows.map((r) => [String(r.smart_account), Number(r.beat_at)]));
      const want = { "0xa1": LAST_BEAT, "0xb1": LAST_BEAT, "0xc1": LAST_BEAT, "0xd1": QUIET, "0xe1": LAST_BEAT, "0xf1": A_MONTH_ON - 60, "0xr1": LAST_BEAT };
      assert.deepEqual(beats(ms), want);
      assert.deepEqual(beats(s), want);
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
