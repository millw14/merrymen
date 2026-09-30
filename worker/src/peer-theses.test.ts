import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { peerThesesForSlugs, readPeerTheses, PEER_THESIS_LIMIT } from "./peer-theses";

let raw: DatabaseSync;
let db: Db;
const account = "0x1111111111111111111111111111111111111111" as const;
const prior = "0x2222222222222222222222222222222222222222" as const;
const unrelated = "0x3333333333333333333333333333333333333333" as const;
const slug = "0123456789abcdef";
const now = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  raw = new DatabaseSync(":memory:");
  db = wrapSqlite(raw);
  await db.exec(`
    CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, x_handle TEXT, mode TEXT);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY, agent_id TEXT, at INTEGER, action TEXT,
      symbol TEXT, size_usdg REAL, source TEXT, reason TEXT, dropped_rule TEXT, hold_kind TEXT, signals_json TEXT);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, decision_id INTEGER, status TEXT, reject_rule TEXT);
    CREATE TABLE posts (decision_id INTEGER, body TEXT);
  `);
  for (const a of [account, prior, unrelated]) await db.prepare("INSERT INTO agents VALUES (?, ?, NULL, 'paper')").run(a, "Desk");
});
afterEach(() => raw.close());

async function decision(id: number, options: { reason?: string; agent?: string; holdKind?: string; source?: string; at?: number } = {}) {
  await db.prepare("INSERT INTO decisions VALUES (?, ?, ?, 'hold', 'NVDA', 0, ?, ?, NULL, ?, ?)").run(
    id, options.agent ?? account, options.at ?? now - id, options.source ?? "brain",
    options.reason ?? `Quote review ${id}: depth held; wait for the next quote to confirm.`, options.holdKind ?? "MODEL_HOLD", "PRIVATE OWNER BALANCES",
  );
}

describe("peer publication from the real SQLite query", () => {
  it("finds genuine theses behind more than a full page of operational-only rows", async () => {
    for (let id = 1; id <= 120; id++) await decision(id, { reason: `provider failed: outage ${id}` });
    for (let id = 121; id <= 150; id++) await decision(id);
    const posts = await readPeerTheses(db, [account]);
    assert.equal(posts.length, PEER_THESIS_LIMIT);
    assert.match(posts[0]!.reason!, /review 121:/);
    assert.match(posts.at(-1)!.reason!, /review 144:/);
    assert.doesNotMatch(JSON.stringify(posts), /PRIVATE OWNER|0x1111|provider failed/);
  });

  it("carries published prose, latest outcomes and stable identities across account re-grants", async () => {
    await decision(1);
    await decision(2, { agent: prior });
    await decision(3, { agent: unrelated });
    await db.prepare("INSERT INTO posts VALUES (1, ?)").run("Depth held but buyers narrowed; wait for breadth to recover.");
    await db.exec("INSERT INTO trades VALUES (1, 1, 'submitted', NULL); INSERT INTO trades VALUES (2, 1, 'rejected', 'daily-cap')");
    const posts = await peerThesesForSlugs(db, [slug, "dangling"], {
      bySlug: async (asked) => asked === slug
        ? { tenant: account, slug, accounts: [account, prior], createdAt: now, updatedAt: now }
        : null,
    });
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.post, "Depth held but buyers narrowed; wait for breadth to recover.");
    assert.equal(posts[0]!.outcome, "refused");
    assert.ok(posts.every((p) => p.slug === slug && p.paper));
    assert.doesNotMatch(JSON.stringify(posts), /review 3:/);
  });

  describe("a peer's book is as public as the feed makes it (D1)", () => {
    // Two owners: `account`'s opted into a public book, `unrelated`'s did not.
    const identity = {
      bySlug: async (asked: string) =>
        asked === slug
          ? { tenant: account, slug, accounts: [account], createdAt: now, updatedAt: now }
          : asked === "hr5k2m9q4w7x3z8n"
            ? { tenant: unrelated, slug: "hr5k2m9q4w7x3z8n", accounts: [unrelated], createdAt: now, updatedAt: now }
            : null,
    };
    const buy = async (id: number, agent: string) => {
      await db
        .prepare("INSERT INTO decisions VALUES (?, ?, ?, 'buy', 'TSLA', 5, 'brain', 'Adding under its average.', NULL, NULL, NULL)")
        .run(id, agent, now - id);
      await db.prepare("INSERT INTO trades VALUES (?, ?, 'landed', NULL)").run(id, id);
    };

    it("A PUBLIC BOOK'S PEERS READ ITS SIZE, as the feed shows it; a private one's read none", async () => {
      await buy(1, account);
      await buy(2, unrelated);
      const settings = async (tenant: `0x${string}`) => ({ strategy: "custom", publicBook: tenant === account });
      const posts = await peerThesesForSlugs(db, [slug, "hr5k2m9q4w7x3z8n"], identity, settings);
      const open = posts.find((p) => p.slug === slug)!;
      const shut = posts.find((p) => p.slug === "hr5k2m9q4w7x3z8n")!;
      assert.equal(open.sizeUsdg, 5);
      assert.equal(open.head, "buy TSLA 5.00 USDG");
      assert.equal(shut.sizeUsdg, null);
      assert.equal(shut.head, "buy TSLA");
    });

    it("only an explicit true opens it, and an unreadable setting is private", async () => {
      await buy(1, account);
      for (const settings of [
        async () => ({ publicBook: "true" }),
        async () => ({ publicBook: 1 }),
        async () => null,
        async () => {
          throw new Error("settings store down");
        },
      ]) {
        const [post] = await peerThesesForSlugs(db, [slug], identity, settings);
        assert.equal(post!.sizeUsdg, null);
        assert.equal(post!.head, "buy TSLA");
      }
    });

    it("the agent's own memory, read with no lookup, keeps the private default", async () => {
      await buy(1, account);
      const [post] = await readPeerTheses(db, [account]);
      assert.equal(post!.sizeUsdg, null);
    });
  });

  it("does not collapse a forced hold into a model hold with the same prose", async () => {
    const reason = "Depth held; I would wait for a new quote before adding.";
    await decision(1, { reason, holdKind: "GATE_FORCED_HOLD" });
    await decision(2, { reason });
    await decision(3, { source: "chat" });
    await decision(4, { at: now - 25 * 3600 });
    const posts = await readPeerTheses(db, [account]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.said, 1);
    assert.equal(posts[0]!.at, now - 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n, 4, "publication never deletes owner records");
  });
});
