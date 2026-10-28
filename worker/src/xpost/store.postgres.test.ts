/** Real Postgres locking and reader checks. Opt-in, disposable loopback DB only.
 * MERRYMEN_TEST_PG_URL=postgres://user@127.0.0.1:port/db node --import tsx --test --test-force-exit worker/src/xpost/store.postgres.test.ts
 * With no test URL, this skips without loading the runtime-only pg package.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { makePgDb, type Db } from "../db";
import * as store from "./store";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 18);
const OWNER_A = `0x${"ab".repeat(20)}`, OWNER_B = `0x${"cd".repeat(20)}`;
const BODY = "hey, happy to chat. keeping things simple over here.";
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Pause after acquiring the real shared-author lock, keeping its transaction open. */
function heldAuthor(db: Db, held: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): Db {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      if (!/^\s*INSERT INTO xpost_meta/.test(sql)) return stmt;
      return { ...stmt, run: async (...params) => {
        const result = await stmt.run(...params);
        if (params[0] === store.answerAuthorKey("111", "333")) {
          held.resolve();
          await release.promise;
        }
        return result;
      } };
    },
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.tx((tx) => fn(heldAuthor(tx, held, release))),
  };
}

test("Postgres: small-talk authors serialize across pools and timeline memory survives replies", { skip: !url, timeout: 30_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable LOCAL Postgres is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => PgClient };
  const schema = `mm_xpost_test_${randomBytes(8).toString("hex")}`;
  const scoped = (name: string) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=10000`);
    u.searchParams.set("application_name", `${schema}_${name}`);
    return u.toString();
  };
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const one = await makePgDb(scoped("one")), two = await makePgDb(scoped("two"));
    await Promise.all([store.ensureXpostSchema(one, "postgres"), store.ensureXpostSchema(two, "postgres")]);
    const dek = randomBytes(32);
    for (const [db, tenant] of [[one, OWNER_A], [two, OWNER_B]] as const) {
      await store.upsertAccount(db, dek, { tenant, xUserId: "111", username: "local_fixture", nowMs: NOW - DAY,
        tokens: { accessToken: "local-fixture-access", refreshToken: "local-fixture-refresh", accessExpiresAtMs: NOW + DAY, scope: "tweet.read tweet.write" } });
      await store.setPosting(db, tenant, { enabled: true, xUserId: "111" }, NOW - DAY + 1);
      assert.equal(await store.setReplying(db, tenant, true, "111", NOW - DAY + 2), true);
    }
    const answer = (tenant: string, tag: string, over: Partial<store.NewPost> = {}): store.NewPost => ({
      tenant, xUserId: "111", kind: "answer", dedupeKey: `answer:111:${tag}`, body: BODY, smalltalk: true,
      replyToTweetId: tag, replyRootTweetId: tag, replyAuthorId: "333", nowMs: NOW, dueAtMs: NOW, ...over,
    });

    await t.test("different owners contend on one author lock and cannot schedule the same words twice", async () => {
      const held = deferred(), release = deferred();
      const first = store.schedulePost(heldAuthor(one, held, release), answer(OWNER_A, "7101"));
      await Promise.race([held.promise, first.then(() => { throw new Error("first transaction never held its author lock"); })]);
      const second = store.schedulePost(two, answer(OWNER_B, "7102"));
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const rows = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [`${schema}_two`]);
          if (rows.rows.some((r) => r.wait_event_type === "Lock")) { blocked = true; break; }
          await new Promise((done) => setTimeout(done, 10));
        }
        assert.equal(blocked, true, "the second pool actually waited for the first pool's author lock");
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }
      assert.ok(await first);
      assert.equal(await second, null);
      const rows = await admin.query(`SELECT count(*)::integer AS n FROM ${schema}.xpost_posts WHERE kind = 'answer'`);
      assert.equal(rows.rows[0]?.n, 1);
      assert.equal(await store.schedulePost(two, answer(OWNER_B, "7103", { body: ` ${BODY.toUpperCase()} ` })), null);
      assert.ok(await store.schedulePost(two, answer(OWNER_B, "7104", { replyAuthorId: "444" })), "another recipient is independent");
    });

    await t.test("history and duplicate protection last seven days across owners and uncertain sends", async () => {
      await one.prepare("UPDATE xpost_posts SET status = 'failed' WHERE dedupe_key = ?").run("answer:111:7101");
      assert.deepEqual(await store.smalltalkBodiesToAuthor(two, "111", "333", NOW + 7 * DAY), [BODY]);
      assert.deepEqual(await store.smalltalkBodiesToAuthor(two, "222", "333", NOW), []);
      assert.deepEqual(await store.smalltalkBodiesToAuthor(two, "111", "555", NOW), []);
      assert.equal(await store.schedulePost(two, answer(OWNER_B, "7105", { nowMs: NOW + 7 * DAY })), null);
      assert.deepEqual(await store.smalltalkBodiesToAuthor(two, "111", "333", NOW + 7 * DAY + 1), []);
      assert.ok(await store.schedulePost(two, answer(OWNER_B, "7106", { nowMs: NOW + 7 * DAY + 1 })), "after the window the line is available again");
    });

    await t.test("timeline reader is independently bounded and accepts the translated queries", async () => {
      const timeline = "a notebook full of arrows, somehow still a map";
      assert.ok(await store.schedulePost(one, { tenant: OWNER_A, xUserId: "111", kind: "casual", dedupeKey: "casual:older",
        body: timeline, nowMs: NOW - 2 * DAY, dueAtMs: NOW - 2 * DAY }));
      await admin.query(`INSERT INTO ${schema}.xpost_posts
        (tenant, x_user_id, kind, dedupe_key, body, status, created_at_ms, due_at_ms, updated_at_ms)
        SELECT $1, '111', 'answer', 'newer:' || n, 'newer answer ' || n, 'posted', $2, $2, $2 FROM generate_series(1, 250) AS n`,
      [OWNER_A, NOW + 1]);
      const recent = await store.ownRecentBodies(two, { tenant: OWNER_A, sinceMs: NOW - 3 * DAY, limit: 200 });
      assert.equal(recent.all.length, 200);
      assert.ok(!recent.all.includes(timeline));
      assert.deepEqual(recent.timeline, [{ body: timeline, kind: "casual" }]);
      assert.deepEqual((await store.ownRecentBodies(one, { tenant: OWNER_B, sinceMs: 0, limit: 200 })).timeline, []);
    });
  } finally {
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});
