/**
 * THE TELEGRAM GROUPS FERRY — docs/tg-groups.md "Storage and the ferry".
 *
 * Against a real (in-memory) sqlite for the statements and real temp homes for
 * the files, plus the Postgres translation of every statement it sends,
 * because sqlite cannot see a Postgres-only failure. What is pinned:
 *
 *   - a published file comes back byte for byte in a fresh home, mode 0600;
 *   - an unchanged file is not published again, and a version is remembered
 *     only once its upsert landed;
 *   - a restore never replaces a file the home already has, never creates a
 *     home, and never writes anything it could not open and validate;
 *   - the row is ciphertext bound to its tenant: no plaintext in the column,
 *     and one tenant's row cannot be restored as another's;
 *   - nothing here throws, and no log line carries the memory or the DEK;
 *   - a forget request reaches the stored copy whatever the child holds: a
 *     publish applies it, a held child's row is patched in place, a restore
 *     applies the home's requests, and they are cleared only once the child's
 *     own file reflects them;
 *   - the group files leave a home whose grant is gone while no child runs
 *     there, so a re-grant never finds them "present";
 *   - the orchestrator calls all of it where the contract says, behind the
 *     lease, before spawn and on the kill switch, and the group model key
 *     reaches children while the DEK does not.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { describe } from "node:test";

import { translateQuery, translateSchema, wrapSqlite, type Db, type Stmt } from "./db";
import { openSecret, sealSecret } from "./store-crypto";
import {
  TG_GROUPS_FILE_NAME,
  TG_GROUPS_FORGET_BATCH,
  TG_GROUPS_MAX_BYTES,
  TG_GROUPS_SCHEMA_LOCK,
  TG_GROUPS_TABLE_SQL,
  deleteTgGroups,
  ensureTgGroupsSchema,
  forgetStoredTgGroups,
  forgetTgGroupsHome,
  forgetTgGroupsInHomes,
  forgetUnwantedTgGroups,
  isTgGroupsText,
  publishTgGroups,
  restoreTgGroups,
  tgGroupsHeldOff,
  tgGroupsToForget,
  type TgGroupsRestore,
} from "./tg-groups-ferry";
import { TG_GROUPS_FILE, TG_GROUPS_FORGET_FILE, TG_LIMITS, TgGroupsStore, parseTgForgets } from "./telegram/tg-groups/store";

const A = `0x${"ab".repeat(20)}`;
const B = `0x${"cd".repeat(20)}`;
const DEK = randomBytes(32);
const MARKER = "wen lambo said frogwhisperer at the full moon";

type T = { after(fn: () => void): void };

async function sqlite(t: T, ensure = true): Promise<{ db: Db; raw: DatabaseSync }> {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw);
  if (ensure) await ensureTgGroupsSchema(db, "sqlite");
  return { db, raw };
}

function home(t: T): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-tg-ferry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A plausible memory file: the shape the child's store writes, with a line anybody could have typed. */
function memory(text = MARKER, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    rooms: {
      "-1001234567890": {
        chatId: -1001234567890,
        title: "frog pond",
        status: "approved",
        lines: [{ messageId: 7, fromId: 42, name: "kermit", text, atMs: 1_790_000_000_000 }],
        claims: { "7:0x1111111111111111111111111111111111111111": 1_790_000_000_000 },
      },
    },
    llm: { day: "2026-09-28", used: 17 },
    nominations: { day: "2026-09-28", n: 2, entries: 1 },
    ...extra,
  });
}

function put(dir: string, text: string): string {
  const file = path.join(dir, TG_GROUPS_FILE_NAME);
  writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  return file;
}

async function rowOf(db: Db, tenant: string): Promise<{ sealed: string; bytes: number; updated_at_ms: number } | undefined> {
  return (await db.prepare("SELECT sealed, bytes, updated_at_ms FROM tenant_tg_groups WHERE tenant = ?").get(tenant)) as
    | { sealed: string; bytes: number; updated_at_ms: number }
    | undefined;
}

async function rowCount(db: Db): Promise<number> {
  const r = (await db.prepare("SELECT COUNT(*) AS n FROM tenant_tg_groups").get()) as { n: number };
  return Number(r.n);
}

function logs(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l) };
}

/** No line may carry the memory, the sealed value or the key. */
function assertClean(lines: string[], extra: string[] = []): void {
  const secrets = [MARKER, DEK.toString("base64"), DEK.toString("hex"), DEK.toString("base64url"), ...extra];
  for (const l of lines) for (const s of secrets) assert.ok(!l.includes(s), `a log line carries something it must not: ${l.slice(0, 80)}`);
}

// ── the schema ──────────────────────────────────────────────────────────────

describe("the table", () => {
  test("is the contract's four columns, and translates to Postgres cleanly", () => {
    assert.match(TG_GROUPS_TABLE_SQL, /CREATE TABLE IF NOT EXISTS tenant_tg_groups/);
    for (const col of ["tenant TEXT PRIMARY KEY", "sealed TEXT NOT NULL", "bytes INTEGER NOT NULL", "updated_at_ms INTEGER NOT NULL"]) {
      assert.ok(TG_GROUPS_TABLE_SQL.includes(col), col);
    }
    assert.ok(!TG_GROUPS_TABLE_SQL.includes("?"), "exec never renumbers placeholders");
    assert.ok(!TG_GROUPS_TABLE_SQL.includes("'"), "no quotes in text translateSchema rewrites blind");
    const pg = translateSchema(TG_GROUPS_TABLE_SQL);
    assert.ok(!/\bINTEGER\b/.test(pg), "every INTEGER widened to BIGINT");
    assert.match(pg, /bytes BIGINT NOT NULL/);
    assert.match(pg, /updated_at_ms BIGINT NOT NULL/);
  });

  test("sqlite: created once, idempotent", async (t) => {
    const { db } = await sqlite(t);
    await ensureTgGroupsSchema(db, "sqlite");
    // A second process (a fresh Db on the same file) is a no-op too.
    const raw = new DatabaseSync(":memory:");
    t.after(() => raw.close());
    const other = wrapSqlite(raw);
    await ensureTgGroupsSchema(other, "sqlite");
    await other.exec(TG_GROUPS_TABLE_SQL);
    assert.equal(await rowCount(db), 0);
  });

  test("memoised per Db, and retried after a failure", async () => {
    let attempts = 0;
    const flaky: Db = {
      prepare: () => {
        throw new Error("not used");
      },
      exec: async () => {
        attempts++;
        if (attempts === 1) throw new Error("database briefly unreachable");
      },
      tx: async (fn) => fn(flaky),
    };
    await assert.rejects(ensureTgGroupsSchema(flaky, "sqlite"), /briefly unreachable/);
    await ensureTgGroupsSchema(flaky, "sqlite");
    await ensureTgGroupsSchema(flaky, "sqlite");
    assert.equal(attempts, 2, "one failure, one success, then memoised");
  });

  test("postgres: the DDL runs inside one transaction, behind an advisory lock nobody else uses", async () => {
    const events: string[] = [];
    let lockKey: unknown;
    const scoped: Db = {
      prepare: (sql) => {
        const stmt: Stmt = {
          run: async () => ({ changes: 0, lastInsertRowid: 0 }),
          get: async (...params) => {
            events.push(`prepare:${sql}`);
            lockKey = params[0];
            return {};
          },
          all: async () => [],
        };
        return stmt;
      },
      exec: async (sql) => {
        events.push(sql === TG_GROUPS_TABLE_SQL ? "exec:schema" : "exec:other");
      },
      tx: () => Promise.reject(new Error("nested")),
    };
    const pg: Db = {
      prepare: () => {
        throw new Error("outside the transaction");
      },
      exec: async () => {
        throw new Error("outside the transaction");
      },
      tx: async (fn) => {
        events.push("begin");
        const out = await fn(scoped);
        events.push("commit");
        return out;
      },
    };
    await ensureTgGroupsSchema(pg, "postgres");
    assert.deepEqual(events, ["begin", "prepare:SELECT pg_advisory_xact_lock(?)", "exec:schema", "commit"]);
    assert.equal(lockKey, TG_GROUPS_SCHEMA_LOCK);
    assert.ok(Number.isSafeInteger(lockKey));
    // Every other advisory key in the repo, single-key and namespace alike.
    for (const taken of [
      1_297_691_982, 1_297_692_081, 1_297_692_082, 1_297_692_083, 1_297_692_084, 1_297_692_090, 1_297_692_091,
      1_297_692_101, 1_297_692_103, 1_297_692_110, 1_297_692_111, 1_297_692_112,
    ]) {
      assert.notEqual(lockKey, taken);
    }
  });

  test("every statement the ferry prepares translates to numbered Postgres placeholders", async (t) => {
    const seenSql: string[] = [];
    const recorder: Db = {
      prepare: (sql) => {
        seenSql.push(sql);
        return {
          run: async () => ({ changes: 1, lastInsertRowid: 0 }),
          get: async () => undefined,
          all: async () => [],
        };
      },
      exec: async () => {},
      tx: async (fn) => fn(recorder),
    };
    const src = home(t);
    put(src, memory());
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: recorder, dek: DEK, seen: new Map(), log: () => {} }), "published");
    assert.equal(await restoreTgGroups({ tenant: A, home: home(t), shared: recorder, dek: DEK, log: () => {} }), "none");
    await deleteTgGroups(A, recorder, () => {});
    assert.equal(seenSql.length, 3);
    for (const sql of seenSql) {
      const pg = translateQuery(sql);
      assert.ok(!pg.includes("?"), `untranslated placeholder in: ${pg}`);
      assert.match(pg, /\$1\b/);
    }
    const upsert = translateQuery(seenSql[0]!);
    assert.match(upsert, /VALUES \(\$1, \$2, \$3, \$4\)/);
    // Column-scoped: the conflict branch names exactly the three columns it replaces.
    assert.match(
      upsert,
      /ON CONFLICT \(tenant\) DO UPDATE SET sealed = excluded\.sealed, bytes = excluded\.bytes, updated_at_ms = excluded\.updated_at_ms$/,
    );
  });
});

// ── up and back down ────────────────────────────────────────────────────────

describe("publish, then restore", () => {
  test("round trip: the exact bytes come back in a fresh home, mode 0600, and nothing else is left there", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    const text = memory();
    put(src, text);
    const { lines, log } = logs();
    const seen = new Map<string, string>();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "published");
    const row = await rowOf(db, A);
    assert.ok(row, "a row");
    assert.equal(row.bytes, Buffer.byteLength(text, "utf8"));
    assert.ok(Math.abs(row.updated_at_ms - Date.now()) < 60_000);
    assert.ok(seen.has(A), "the version is remembered once it landed");

    const dst = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log }), "restored");
    const file = path.join(dst, TG_GROUPS_FILE_NAME);
    assert.equal(readFileSync(file, "utf8"), text, "byte for byte what the child wrote");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dst), [TG_GROUPS_FILE_NAME], "no temp file left behind");
    assertClean(lines, [row.sealed]);
  });

  test("a checksummed tenant and a lowercased one are the same row", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory());
    const mixed = `0x${"AB".repeat(20)}`;
    assert.equal(await publishTgGroups({ tenant: mixed, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} }), "published");
    assert.ok(await rowOf(db, A), "keyed lowercased, as childHome spells it");
    assert.equal(await restoreTgGroups({ tenant: A, home: home(t), shared: db, dek: DEK, log: () => {} }), "restored");
  });

  test("an unchanged file is not published again; a changed one is", async (t) => {
    const { db, raw } = await sqlite(t);
    const src = home(t);
    const file = put(src, memory("first"));
    const seen = new Map<string, string>();
    const log = () => {};
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "published");
    // Mark the row so a second upsert would be visible.
    raw.prepare("UPDATE tenant_tg_groups SET updated_at_ms = 0").run();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "unchanged");
    assert.equal((await rowOf(db, A))!.updated_at_ms, 0, "no upsert for an unchanged file");

    // The child rewrites it the way the store does: a new file renamed over.
    const next = memory("second, and longer than the first");
    writeFileSync(`${file}.tmp`, next, { mode: 0o600 });
    const { renameSync } = await import("node:fs");
    renameSync(`${file}.tmp`, file);
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "published");
    assert.ok((await rowOf(db, A))!.updated_at_ms > 0);
    const dst = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log }), "restored");
    assert.equal(readFileSync(path.join(dst, TG_GROUPS_FILE_NAME), "utf8"), next);
    assert.equal(await rowCount(db), 1, "one row per tenant, replaced whole");
  });

  test("the version is remembered only after the upsert landed", async (t) => {
    const { db } = await sqlite(t, false); // no table yet: the upsert fails
    const src = home(t);
    put(src, memory());
    const seen = new Map<string, string>();
    const { lines, log } = logs();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "failed");
    assert.equal(seen.has(A), false, "a failed upsert must be tried again");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /not published/);
    // The same failure again is not said again on the next pass.
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "failed");
    assert.equal(lines.length, 1, "a repeated failure is logged once, not every pass");
    await ensureTgGroupsSchema(db, "sqlite");
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "published");
    assert.ok(seen.has(A));
    assertClean(lines);
  });

  test("absent: nothing is published, and an absent file never deletes the stored copy", async (t) => {
    const { db } = await sqlite(t);
    const seen = new Map<string, string>();
    const empty = home(t);
    assert.equal(await publishTgGroups({ tenant: A, home: empty, shared: db, dek: DEK, seen, log: () => {} }), "absent");
    assert.equal(await rowCount(db), 0);

    const src = home(t);
    put(src, memory());
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log: () => {} }), "published");
    // A respawned child that has not written yet (its restore failed, say).
    assert.equal(await publishTgGroups({ tenant: A, home: empty, shared: db, dek: DEK, seen, log: () => {} }), "absent");
    assert.ok(await rowOf(db, A), "the stored copy stands");
    // …and a missing home is absent too, not a crash.
    assert.equal(
      await publishTgGroups({ tenant: A, home: path.join(empty, "gone"), shared: db, dek: DEK, seen, log: () => {} }),
      "absent",
    );
  });

  test("publishing never writes, renames or adds anything in the child's home", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    const file = put(src, memory());
    const before = lstatSync(file);
    const listing = readdirSync(src);
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const after = lstatSync(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.mode, before.mode);
    assert.equal(readFileSync(file, "utf8"), memory());
    assert.deepEqual(readdirSync(src), listing);
  });

  test("the upsert touches only its own tenant's row", async (t) => {
    const { db } = await sqlite(t);
    const a = home(t);
    const b = home(t);
    put(a, memory("from a"));
    put(b, memory("from b"));
    const seen = new Map<string, string>();
    await publishTgGroups({ tenant: A, home: a, shared: db, dek: DEK, seen, log: () => {} });
    await publishTgGroups({ tenant: B, home: b, shared: db, dek: DEK, seen, log: () => {} });
    const bBefore = await rowOf(db, B);
    put(a, memory("from a, again"));
    seen.delete(A);
    assert.equal(await publishTgGroups({ tenant: A, home: a, shared: db, dek: DEK, seen, log: () => {} }), "published");
    assert.deepEqual(await rowOf(db, B), bBefore);
    assert.equal(await rowCount(db), 2);
    const dst = home(t);
    await restoreTgGroups({ tenant: B, home: dst, shared: db, dek: DEK, log: () => {} });
    assert.equal(readFileSync(path.join(dst, TG_GROUPS_FILE_NAME), "utf8"), memory("from b"));
  });
});

// ── what the column holds ───────────────────────────────────────────────────

describe("the sealed column", () => {
  test("never holds the plaintext, in any encoding a reader would try", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    const text = memory();
    put(src, text);
    const { lines, log } = logs();
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log });
    const { sealed } = (await rowOf(db, A))!;
    for (const needle of [MARKER, "frog pond", "kermit", '"version"', text.slice(0, 40)]) {
      assert.ok(!sealed.includes(needle), `plaintext in the column: ${needle}`);
      for (const enc of ["base64", "base64url", "hex"] as const) {
        assert.ok(!sealed.includes(Buffer.from(needle).toString(enc).slice(0, 16)), `${enc} plaintext in the column: ${needle}`);
      }
    }
    assert.match(sealed, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "iv.tag.ciphertext");
    assert.ok(!sealed.includes(DEK.toString("base64")));
    // And it opens under the DEK to this tenant's envelope around the file.
    const plain = openSecret(sealed, DEK);
    assert.ok(plain.endsWith(text));
    assert.ok(plain.startsWith(`tg-groups/v1 ${A}\n`));
    assertClean(lines, [sealed]);
  });
});

describe("restore", () => {
  test("never replaces a file the home already has", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory("stored"));
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });

    const dst = home(t);
    const own = memory("the child's own, newer than any stored copy");
    const file = put(dst, own);
    const before = lstatSync(file);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log: () => {} }), "present");
    assert.equal(readFileSync(file, "utf8"), own);
    assert.equal(lstatSync(file).mtimeMs, before.mtimeMs);
    assert.deepEqual(readdirSync(dst), [TG_GROUPS_FILE_NAME]);
  });

  test("anything at the path counts as present, a dangling link included", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory());
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const dst = home(t);
    symlinkSync(path.join(dst, "nowhere"), path.join(dst, TG_GROUPS_FILE_NAME));
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log: () => {} }), "present");
    assert.equal(existsSync(path.join(dst, "nowhere")), false, "the link was not followed");
  });

  test("none: no stored copy, nothing written", async (t) => {
    const { db } = await sqlite(t);
    const dst = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log: () => {} }), "none");
    assert.deepEqual(readdirSync(dst), []);
  });

  test("a tampered row is unreadable, and nothing is written", async (t) => {
    const { db, raw } = await sqlite(t);
    const src = home(t);
    put(src, memory());
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const { sealed } = (await rowOf(db, A))!;
    const [iv, tag, ct] = sealed.split(".") as [string, string, string];
    const flipped = Buffer.from(ct, "base64url");
    const last = flipped.length - 1;
    flipped[last] = flipped[last]! ^ 0x01;
    raw.prepare("UPDATE tenant_tg_groups SET sealed = ? WHERE tenant = ?").run(`${iv}.${tag}.${flipped.toString("base64url")}`, A);

    const dst = home(t);
    const { lines, log } = logs();
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log }), "unreadable");
    assert.deepEqual(readdirSync(dst), [], "no file and no temp file");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /unreadable/);
    assertClean(lines, [sealed, ct]);

    // A row that is not even the sealed shape is the same answer.
    raw.prepare("UPDATE tenant_tg_groups SET sealed = ? WHERE tenant = ?").run("not-a-sealed-value", A);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log }), "unreadable");
    assert.deepEqual(readdirSync(dst), []);
  });

  test("a row sealed under another key is unreadable", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory());
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const dst = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: randomBytes(32), log: () => {} }), "unreadable");
    assert.deepEqual(readdirSync(dst), []);
  });

  test("ANOTHER TENANT'S ROW, copied onto this key, is refused: memory never crosses agents", async (t) => {
    const { db, raw } = await sqlite(t);
    const src = home(t);
    put(src, memory("said only in A's groups"));
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const { sealed } = (await rowOf(db, A))!;
    raw.prepare("INSERT INTO tenant_tg_groups (tenant, sealed, bytes, updated_at_ms) VALUES (?, ?, ?, ?)").run(B, sealed, 1, 1);
    const dst = home(t);
    assert.equal(await restoreTgGroups({ tenant: B, home: dst, shared: db, dek: DEK, log: () => {} }), "unreadable");
    assert.deepEqual(readdirSync(dst), []);
  });

  test("a row that opens but is not version 1 memory is unreadable", async (t) => {
    const { db, raw } = await sqlite(t);
    const dst = home(t);
    const insert = raw.prepare("INSERT OR REPLACE INTO tenant_tg_groups (tenant, sealed, bytes, updated_at_ms) VALUES (?, ?, ?, ?)");
    for (const body of ['{"version":2,"rooms":{}}', "[1,2,3]", "null", "not json at all", ""]) {
      insert.run(A, sealSecret(`tg-groups/v1 ${A}\n${body}`, DEK), body.length, 1);
      const { lines, log } = logs();
      assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log }), "unreadable", body);
      assert.deepEqual(readdirSync(dst), [], body);
      assertClean(lines, ["not json at all"]);
    }
    // No envelope at all: the file alone, sealed under the right key.
    insert.run(A, sealSecret(memory(), DEK), 1, 1);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log: () => {} }), "unreadable");
    assert.deepEqual(readdirSync(dst), []);
  });

  test("never creates a home that is gone", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory());
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const gone = path.join(home(t), "children", A);
    assert.equal(await restoreTgGroups({ tenant: A, home: gone, shared: db, dek: DEK, log: () => {} }), "failed");
    assert.equal(existsSync(gone), false);
  });

  test("a failed read or write is failed, never a throw", async (t) => {
    const broken: Db = {
      prepare: () => ({
        run: () => Promise.reject(new Error("connection reset")),
        get: () => Promise.reject(new Error("connection reset")),
        all: () => Promise.reject(new Error("connection reset")),
      }),
      exec: () => Promise.reject(new Error("connection reset")),
      tx: () => Promise.reject(new Error("connection reset")),
    };
    const { lines, log } = logs();
    const dst = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: broken, dek: DEK, log }), "failed");
    assert.deepEqual(readdirSync(dst), []);
    assert.match(lines[0]!, /could not be read/);

    // A home the orchestrator cannot write into.
    if (process.getuid?.() !== 0) {
      const { db } = await sqlite(t);
      const src = home(t);
      put(src, memory());
      await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
      const locked = home(t);
      chmodSync(locked, 0o500);
      // Hooks may run after the temp home is already removed; an empty
      // directory is removable read-only anyway.
      t.after(() => {
        try {
          chmodSync(locked, 0o700);
        } catch {
          /* already gone */
        }
      });
      assert.equal(await restoreTgGroups({ tenant: A, home: locked, shared: db, dek: DEK, log }), "failed");
      assert.deepEqual(readdirSync(locked), []);
    }
    assertClean(lines);
  });

  // The orchestrator holds a child's groups off on `failed` (tgGroupsHeldOff),
  // so `failed` must mean the home had no file. A database that cannot be
  // reached at a crash restart must not hold off a child whose own file
  // survived.
  test("a database opened lazily: only for a home without the file, and an open that fails is failed", async (t) => {
    const { db } = await sqlite(t);
    let opened = 0;
    const lazy = async (): Promise<Db> => {
      opened++;
      return db;
    };
    const kept = home(t);
    put(kept, memory("the child's own"));
    assert.equal(await restoreTgGroups({ tenant: A, home: kept, shared: lazy, dek: DEK, log: () => {} }), "present");
    assert.equal(opened, 0, "a home that kept its file never touches the database");

    const unreachable = async (): Promise<Db> => {
      throw new Error("connect ECONNREFUSED");
    };
    const kept2 = home(t);
    put(kept2, memory("the child's own"));
    assert.equal(await restoreTgGroups({ tenant: A, home: kept2, shared: unreachable, dek: DEK, log: () => {} }), "present");

    const { lines, log } = logs();
    const empty = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: empty, shared: unreachable, dek: DEK, log }), "failed");
    assert.deepEqual(readdirSync(empty), []);
    assert.match(lines[0]!, /could not be read — connect ECONNREFUSED/);

    const src = home(t);
    put(src, memory("stored"));
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const fresh = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: fresh, shared: lazy, dek: DEK, log: () => {} }), "restored");
    assert.equal(opened, 1);
    assert.equal(readFileSync(path.join(fresh, TG_GROUPS_FILE_NAME), "utf8"), memory("stored"));
  });
});

// ── refusals on the way up ──────────────────────────────────────────────────

describe("publish refuses", () => {
  test("a file over the cap, without reading it, and stores nothing", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    const pad = "x".repeat(TG_GROUPS_MAX_BYTES);
    put(src, memory(MARKER, { pad }));
    const seen = new Map<string, string>();
    const { lines, log } = logs();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "too-big");
    assert.equal(await rowCount(db), 0);
    assert.equal(seen.has(A), false, "a refused file is not remembered as published");
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "too-big");
    assert.equal(lines.length, 1, "said once per file, not once per pass");
    assert.match(lines[0]!, /over the \d+ cap/);
    assertClean(lines);
    // Back under the cap, it goes up.
    put(src, memory());
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "published");
  });

  test("a file exactly at the cap is fine", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    const base = memory("", { pad: "" });
    const text = memory("", { pad: "y".repeat(TG_GROUPS_MAX_BYTES - Buffer.byteLength(base)) });
    assert.equal(Buffer.byteLength(text), TG_GROUPS_MAX_BYTES);
    put(src, text);
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} }), "published");
    const dst = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log: () => {} }), "restored");
    assert.equal(readFileSync(path.join(dst, TG_GROUPS_FILE_NAME), "utf8"), text);
  });

  test("anything that is not version 1 JSON, and it never replaces a good stored copy", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory("the good copy"));
    const seen = new Map<string, string>();
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log: () => {} });
    const good = await rowOf(db, A);
    for (const bad of [`{"version":2}`, `{"version":1`, `[{"version":1}]`, `${MARKER} is not json`]) {
      put(src, bad);
      const { lines, log } = logs();
      assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "failed", bad);
      assert.deepEqual(await rowOf(db, A), good, bad);
      assertClean(lines);
    }
  });

  test("a symlink, even to a real memory file, and does not follow it", async (t) => {
    const { db } = await sqlite(t);
    const other = home(t);
    const target = put(other, memory("another tenant's groups"));
    const src = home(t);
    symlinkSync(target, path.join(src, TG_GROUPS_FILE_NAME));
    const { lines, log } = logs();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log }), "failed");
    assert.equal(await rowCount(db), 0);
    assert.match(lines[0]!, /not a plain file/);
  });

  test("a FIFO, without blocking the loop on it", async (t) => {
    const src = home(t);
    const fifo = path.join(src, TG_GROUPS_FILE_NAME);
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      t.skip("mkfifo is not available here");
      return;
    }
    const { db } = await sqlite(t);
    const r = await Promise.race([
      publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} }),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    assert.equal(r, "failed");
    assert.equal(await rowCount(db), 0);
  });

  test("a directory where the file should be", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    mkdirSync(path.join(src, TG_GROUPS_FILE_NAME));
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} }), "failed");
    assert.equal(await rowCount(db), 0);
  });

  test("a tenant that is not an address, in every function, without throwing", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory());
    for (const bad of ["", "not-an-address", `0x${"ab".repeat(19)}`, `0x${"ab".repeat(20)}\nX`]) {
      assert.equal(await publishTgGroups({ tenant: bad, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} }), "failed");
      assert.equal(await restoreTgGroups({ tenant: bad, home: home(t), shared: db, dek: DEK, log: () => {} }), "failed");
      await deleteTgGroups(bad, db, () => {});
    }
    assert.equal(await rowCount(db), 0);
  });

  test("a bad key is a logged failure that never prints the key", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    put(src, memory());
    const short = randomBytes(16);
    const { lines, log } = logs();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: short, seen: new Map(), log }), "failed");
    assert.equal(await rowCount(db), 0);
    assertClean(lines, [short.toString("base64"), short.toString("hex")]);
  });

  test("a database that throws synchronously is still a failure, not a throw", async (t) => {
    const src = home(t);
    put(src, memory());
    const hostile: Db = {
      prepare: () => {
        throw new Error("pool is closed");
      },
      exec: () => Promise.reject(new Error("pool is closed")),
      tx: () => Promise.reject(new Error("pool is closed")),
    };
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: hostile, dek: DEK, seen: new Map(), log: () => {} }), "failed");
    assert.equal(await restoreTgGroups({ tenant: A, home: home(t), shared: hostile, dek: DEK, log: () => {} }), "failed");
    await deleteTgGroups(A, hostile, () => {});
  });
});

// ── the kill switch ─────────────────────────────────────────────────────────

describe("delete", () => {
  test("removes this tenant's row and only it", async (t) => {
    const { db } = await sqlite(t);
    const a = home(t);
    const b = home(t);
    put(a, memory("a"));
    put(b, memory("b"));
    const seen = new Map<string, string>();
    await publishTgGroups({ tenant: A, home: a, shared: db, dek: DEK, seen, log: () => {} });
    await publishTgGroups({ tenant: B, home: b, shared: db, dek: DEK, seen, log: () => {} });
    await deleteTgGroups(`0x${"AB".repeat(20)}`, db, () => {});
    assert.equal(await rowOf(db, A), undefined);
    assert.ok(await rowOf(db, B));
    assert.equal(await restoreTgGroups({ tenant: A, home: home(t), shared: db, dek: DEK, log: () => {} }), "none");
    // Deleting what is not there is not an error.
    await deleteTgGroups(A, db, () => {});
  });

  test("a failed delete is logged, never thrown", async () => {
    const { lines, log } = logs();
    const broken: Db = {
      prepare: () => ({
        run: () => Promise.reject(new Error("connection reset")),
        get: () => Promise.reject(new Error("connection reset")),
        all: () => Promise.reject(new Error("connection reset")),
      }),
      exec: () => Promise.reject(new Error("connection reset")),
      tx: () => Promise.reject(new Error("connection reset")),
    };
    await deleteTgGroups(A, broken, log);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /could not be deleted — connection reset/);
  });
});

// ── the kill switch, following the grant store ──────────────────────────────

describe("the sweep: every row whose grant is gone, whether or not its child runs here", () => {
  const C = `0x${"ef".repeat(20)}`;

  async function publishAll(db: Db, t: T, tenants: string[]): Promise<void> {
    const seen = new Map<string, string>();
    for (const tenant of tenants) {
      const dir = home(t);
      put(dir, memory(`memory of ${tenant}`));
      assert.equal(await publishTgGroups({ tenant, home: dir, shared: db, dek: DEK, seen, log: () => {} }), "published");
    }
  }

  // The finding: the kill switch deleted a row only for a child running on
  // this replica at that moment, so a grant discarded during a redeploy, a
  // restart back-off or a fleet halt left the row for good, and a re-grant
  // restored it. Nothing here knows about children: the listing decides.
  test("deletes the rows of tenants the listing no longer has, and only those", async (t) => {
    const { db } = await sqlite(t);
    await publishAll(db, t, [A, B, C]);
    const { lines, log } = logs();
    const gone = await forgetUnwantedTgGroups({ shared: db, wanted: new Set([A]), listedAtMs: Date.now() + 1, log });
    assert.deepEqual([...gone].sort(), [B, C].sort());
    assert.ok(await rowOf(db, A), "a wanted tenant keeps its memory");
    assert.equal(await rowOf(db, B), undefined);
    assert.equal(await rowOf(db, C), undefined);
    // The same wallet granting again gets a child with no old memory.
    assert.equal(await restoreTgGroups({ tenant: B, home: home(t), shared: db, dek: DEK, log: () => {} }), "none");
    assert.equal(lines.length, 2);
    assertClean(lines);
    // Nothing left to do is nothing done.
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: db, wanted: new Set([A]), listedAtMs: Date.now() + 1, log }), []);
  });

  test("an empty listing forgets every row", async (t) => {
    const { db } = await sqlite(t);
    await publishAll(db, t, [A, B]);
    await forgetUnwantedTgGroups({ shared: db, wanted: new Set(), listedAtMs: Date.now() + 1, log: () => {} });
    assert.equal(await rowCount(db), 0);
  });

  test("the listing is matched whatever the case of its addresses", async (t) => {
    const { db } = await sqlite(t);
    await publishAll(db, t, [A]);
    const gone = await forgetUnwantedTgGroups({ shared: db, wanted: new Set([`0x${"AB".repeat(20)}`]), listedAtMs: Date.now() + 1, log: () => {} });
    assert.deepEqual(gone, []);
    assert.ok(await rowOf(db, A));
  });

  test("a row written after the listing was read is not this pass's to judge", async (t) => {
    const { db } = await sqlite(t);
    await publishAll(db, t, [B]);
    const at = (await rowOf(db, B))!.updated_at_ms;
    // A tenant granted since the listing, its child armed elsewhere and already publishing.
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: db, wanted: new Set(), listedAtMs: at, log: () => {} }), []);
    assert.ok(await rowOf(db, B));
    // The next pass's listing is newer than the row, and judges it.
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: db, wanted: new Set(), listedAtMs: at + 1, log: () => {} }), [B]);
    assert.equal(await rowOf(db, B), undefined);
  });

  test("bounded per pass; the rest go on the next", async (t) => {
    const { db } = await sqlite(t);
    await publishAll(db, t, [A, B, C]);
    const first = await forgetUnwantedTgGroups({ shared: db, wanted: new Set(), listedAtMs: Date.now() + 1, max: 2, log: () => {} });
    assert.equal(first.length, 2);
    assert.equal(await rowCount(db), 1);
    const second = await forgetUnwantedTgGroups({ shared: db, wanted: new Set(), listedAtMs: Date.now() + 1, max: 2, log: () => {} });
    assert.equal(second.length, 1);
    assert.equal(await rowCount(db), 0);
    assert.ok(TG_GROUPS_FORGET_BATCH > 0 && TG_GROUPS_FORGET_BATCH <= 100, "a pass stays short");
  });

  test("a failure is logged, never thrown, and what failed is deleted on the next pass", async (t) => {
    const { db } = await sqlite(t);
    await publishAll(db, t, [A, B]);
    let failDeletesFor: string | null = A;
    const flaky: Db = {
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: (...params) => (params[0] === failDeletesFor ? Promise.reject(new Error("connection reset")) : stmt.run(...params)),
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params),
        };
      },
      exec: (sql) => db.exec(sql),
      tx: (fn) => db.tx(fn),
    };
    const { lines, log } = logs();
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: flaky, wanted: new Set(), listedAtMs: Date.now() + 1, log }), [B]);
    assert.ok(await rowOf(db, A), "the failed one is still there");
    assert.ok(lines.some((l) => /could not be deleted — connection reset \(tried again next pass\)/.test(l)));
    failDeletesFor = null;
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: flaky, wanted: new Set(), listedAtMs: Date.now() + 1, log }), [A]);
    assert.equal(await rowCount(db), 0);

    const broken: Db = {
      prepare: () => {
        throw new Error("pool is closed");
      },
      exec: () => Promise.reject(new Error("pool is closed")),
      tx: () => Promise.reject(new Error("pool is closed")),
    };
    const quiet = logs();
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: broken, wanted: new Set(), listedAtMs: Date.now(), log: quiet.log }), []);
    assert.match(quiet.lines[0]!, /not swept this pass — pool is closed/);
  });

  test("tgGroupsToForget: well-formed keys only, each once, lowercased, capped", () => {
    const upper = `0x${"CD".repeat(20)}`;
    const stored: unknown[] = [A, upper, B, "not-an-address", null, 7, `0x${"ab".repeat(19)}`, C];
    assert.deepEqual(tgGroupsToForget(stored, new Set([A])), [B, C]);
    assert.deepEqual(tgGroupsToForget(stored, new Set([A]), 1), [B]);
    assert.deepEqual(tgGroupsToForget(stored, new Set([A, B, C])), []);
    assert.deepEqual(tgGroupsToForget([], new Set()), []);
  });

  test("its statements translate to numbered Postgres placeholders, and the delete carries the listing bound", async () => {
    const seenSql: string[] = [];
    const seenParams: unknown[][] = [];
    const recorder: Db = {
      prepare: (sql) => {
        seenSql.push(sql);
        return {
          run: async (...params) => {
            seenParams.push(params);
            return { changes: 1, lastInsertRowid: 0 };
          },
          get: async () => undefined,
          all: async (...params) => {
            seenParams.push(params);
            return [{ tenant: B }];
          },
        };
      },
      exec: async () => {},
      tx: async (fn) => fn(recorder),
    };
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: recorder, wanted: new Set([A]), listedAtMs: 1234, log: () => {} }), [B]);
    assert.equal(seenSql.length, 2);
    const [select, del] = seenSql.map((s) => translateQuery(s));
    assert.equal(select, "SELECT tenant FROM tenant_tg_groups WHERE updated_at_ms < $1");
    assert.equal(del, "DELETE FROM tenant_tg_groups WHERE tenant = $1 AND updated_at_ms < $2");
    assert.deepEqual(seenParams, [[1234], [B, 1234]]);
  });
});

// ── a restore that fails holds the child's groups off ───────────────────────

describe("held off: a failed restore never lets an empty memory overwrite the stored one", () => {
  test("the decision, for every restore answer", () => {
    const cases: [TgGroupsRestore, boolean, boolean][] = [
      ["failed", false, true],
      ["failed", true, true],
      // A held child can still record who added or removed it, so a file in
      // its home is its own near-empty one, never the memory.
      ["present", true, true],
      ["present", false, false],
      ["restored", true, false],
      ["restored", false, false],
      ["none", true, false],
      ["none", false, false],
      // The documented behaviour: the child's next publish replaces an unreadable row.
      ["unreadable", true, false],
      ["unreadable", false, false],
    ];
    for (const [r, before, held] of cases) assert.equal(tgGroupsHeldOff(r, before), held, `${r}, held before: ${before}`);
  });

  // The finding's scenario, spawn by spawn: a redeploy whose restore fails,
  // a held child that writes what little the switch lets it, a crash restart
  // in the same container, then the next redeploy. The stored row must come
  // through all of it and reach a child.
  test("the stored row survives a failed restore, the held child's own file and a crash restart", async (t) => {
    const { db } = await sqlite(t);
    const before = home(t);
    const good = memory("approved room, today's caps used");
    put(before, good);
    assert.equal(await publishTgGroups({ tenant: A, home: before, shared: db, dek: DEK, seen: new Map(), log: () => {} }), "published");
    const stored = (await rowOf(db, A))!.sealed;

    // Spawn 1, after a redeploy: the database is unreachable.
    const child = home(t);
    const unreachable = async (): Promise<Db> => {
      throw new Error("connect ETIMEDOUT");
    };
    let held = false;
    let r = await restoreTgGroups({ tenant: A, home: child, shared: unreachable, dek: DEK, log: () => {} });
    held = tgGroupsHeldOff(r, held);
    assert.equal(held, true, "a failed restore holds the child off");

    // The held child records a membership change: a nearly empty file.
    put(child, JSON.stringify({ version: 1, rooms: { "-100777": { chatId: -100777, status: "pending", lines: [] } } }));
    // The orchestrator publishes nothing for a held child, so the row stands.
    assert.equal((await rowOf(db, A))!.sealed, stored);

    // Spawn 2, a crash restart in the same container: the file is the held child's own.
    r = await restoreTgGroups({ tenant: A, home: child, shared: db, dek: DEK, log: () => {} });
    assert.equal(r, "present");
    held = tgGroupsHeldOff(r, held);
    assert.equal(held, true, "still held: publishing that file would be the overwrite");

    // Spawn 3, the next redeploy: a fresh home, the row comes back, the hold lets go.
    const next = home(t);
    r = await restoreTgGroups({ tenant: A, home: next, shared: db, dek: DEK, log: () => {} });
    held = tgGroupsHeldOff(r, held);
    assert.equal(r, "restored");
    assert.equal(held, false);
    assert.equal(readFileSync(path.join(next, TG_GROUPS_FILE_NAME), "utf8"), good);
  });
});

// ── forget requests reach the stored copy, whatever the child holds ─────────

const CHAT = -1001234567890;
const ALICE = 42;
const BO = 43;
const COIN = `0x${"11".repeat(20)}`;

/**
 * A child's own store in `dir`, remembering Alice (the MARKER line, a note, a
 * coin post and a summary naming her) and Bo. Written before it returns.
 */
function childStore(dir: string): TgGroupsStore {
  const s = TgGroupsStore.open(dir, { debounceMs: 60_000 });
  const at = Date.now();
  s.ensureRoom(CHAT, { title: "frog pond", kind: "supergroup" }, { owner: true });
  s.setStatus(CHAT, "approved");
  s.addLine(CHAT, { messageId: 1, fromId: ALICE, name: "alice", text: MARKER, atMs: at - 60_000 });
  s.addLine(CHAT, { messageId: 2, fromId: BO, name: "bo", text: "bo was here", atMs: at - 50_000 });
  s.upsertPerson(CHAT, { id: ALICE, name: "alice", note: "frogwhisperer", lastSeenMs: at - 60_000 });
  s.upsertPerson(CHAT, { id: BO, name: "bo", note: "the skeptic", lastSeenMs: at - 50_000 });
  s.rememberCoin(CHAT, { address: COIN, byId: ALICE, byName: "alice", messageId: 1, atMs: at - 60_000, verdict: "passed" });
  s.update(CHAT, (r) => {
    r.summary = "alice keeps saying wen lambo";
    r.lastSummaryAtMs = at - 40_000;
  });
  s.flush();
  return s;
}

/** The file text the stored row opens to. */
async function storedText(db: Db, tenant = A): Promise<string> {
  const plain = openSecret((await rowOf(db, tenant))!.sealed, DEK);
  return plain.slice(plain.indexOf("\n") + 1);
}

/** Whether a memory's text still holds anything of Alice's. */
function holdsAlice(text: string): boolean {
  const st = JSON.parse(text) as { rooms: Record<string, { lines: { fromId: number }[]; people: { id: number }[]; coins: { byId: number }[]; summary: string }> };
  const r = st.rooms[String(CHAT)]!;
  return (
    text.includes(MARKER) ||
    r.lines.some((l) => l.fromId === ALICE) ||
    r.people.some((p) => p.id === ALICE) ||
    r.coins.some((c) => c.byId === ALICE) ||
    /alice/i.test(r.summary)
  );
}

const forgetFile = (dir: string) => path.join(dir, TG_GROUPS_FORGET_FILE);
const aliceForgets = (s: TgGroupsStore) => assert.equal(s.recordForget({ chatId: CHAT, userId: ALICE, atMs: Date.now() }), true);

describe("forget requests reach the stored memory, whatever the child holds", () => {
  // The finding: a spawn could not read the row, so the child runs held with
  // an empty store. Alice's /forgetme there erased nothing, nothing was
  // published, and the next restore handed her lines, note and coin memo back.
  test("THE FINDING: a /forgetme made while the child's groups are held off reaches the row, and no restore brings her back", async (t) => {
    const { db, raw } = await sqlite(t);
    const src = home(t);
    const before = childStore(src);
    before.close();
    const seen = new Map<string, string>();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log: () => {} }), "published");
    assert.ok(holdsAlice(await storedText(db)), "the row holds her");

    // A redeploy whose restore cannot reach the database: held off.
    const held = home(t);
    const unreachable = async (): Promise<Db> => {
      throw new Error("connect ETIMEDOUT");
    };
    const r = await restoreTgGroups({ tenant: A, home: held, shared: unreachable, dek: DEK, log: () => {} });
    assert.equal(tgGroupsHeldOff(r, false), true);

    // The held child's empty store: it knows no room, but records the request.
    const child = TgGroupsStore.open(held, { debounceMs: 60_000 });
    assert.equal(child.room(CHAT), undefined);
    aliceForgets(child);
    child.close();

    // The mirror pass for a held tenant.
    const { lines, log } = logs();
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: held, shared: db, dek: DEK, seen, log }), "applied");
    const stored = await storedText(db);
    assert.equal(holdsAlice(stored), false, "the stored row no longer holds anything of hers");
    assert.ok(stored.includes("bo was here"), "and nothing of anyone else's went");
    assert.ok(existsSync(forgetFile(held)), "not cleared: the held child's own file does not reflect it");

    // Nothing new: no second write.
    raw.prepare("UPDATE tenant_tg_groups SET updated_at_ms = 0").run();
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: held, shared: db, dek: DEK, seen, log }), "unchanged");
    assert.equal((await rowOf(db, A))!.updated_at_ms, 0);

    // The next redeploy: a fresh home, the row comes back without her.
    const next = home(t);
    assert.equal(await restoreTgGroups({ tenant: A, home: next, shared: db, dek: DEK, log }), "restored");
    assert.equal(holdsAlice(readFileSync(path.join(next, TG_GROUPS_FILE_NAME), "utf8")), false);
    assertClean(lines, ["frogwhisperer", "alice"]);
  });

  test("a crash restart in the same container: the restore applies the home's requests before it writes", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    childStore(src).close();
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    // A held child recorded the request, and the row was not patched (the
    // database was down every pass since). No memory file in the home.
    const h = home(t);
    const held = TgGroupsStore.open(h, { debounceMs: 60_000 });
    aliceForgets(held);
    held.close();
    assert.ok(holdsAlice(await storedText(db)), "the row still holds her");
    assert.equal(await restoreTgGroups({ tenant: A, home: h, shared: db, dek: DEK, log: () => {} }), "restored");
    const text = readFileSync(path.join(h, TG_GROUPS_FILE_NAME), "utf8");
    assert.equal(holdsAlice(text), false);
    assert.ok(text.includes("bo was here"));
    assert.ok(isTgGroupsText(text));
  });

  test("a publish applies them to what it seals, and clears them only once the child's own file reflects them", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    const s = childStore(src);
    const seen = new Map<string, string>();
    // Recorded, but the child's memory file lags it (its write failed, or the
    // pass read the file between the two).
    aliceForgets(s);
    const { lines, log } = logs();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "published");
    assert.equal(holdsAlice(await storedText(db)), false, "never sealed with what she asked to forget");
    assert.ok(holdsAlice(readFileSync(path.join(src, TG_GROUPS_FILE_NAME), "utf8")), "the child's file is not touched");
    assert.ok(existsSync(forgetFile(src)), "kept: the child's own memory still holds her");
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "unchanged");

    // The child catches up.
    s.forgetPerson(CHAT, ALICE);
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "published");
    assert.equal(existsSync(forgetFile(src)), false, "cleared once the file it published already reflected it");
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log }), "unchanged");
    assert.deepEqual(readdirSync(src).sort(), [TG_GROUPS_FILE_NAME], "no temp file left");
    s.close();
    assertClean(lines, ["frogwhisperer"]);
  });

  test("a request the child appends while a publish is carrying the file is kept", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    const s = childStore(src);
    aliceForgets(s);
    s.forgetPerson(CHAT, ALICE);
    // Between the publish's read of the forget file and its clear, the
    // upsert: the child records Bo's /forgetme right then.
    const racing: Db = {
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: async (...params) => {
            if (sql.startsWith("INSERT INTO tenant_tg_groups")) {
              assert.equal(s.recordForget({ chatId: CHAT, userId: BO, atMs: Date.now() }), true);
            }
            return stmt.run(...params);
          },
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params),
        };
      },
      exec: (sql) => db.exec(sql),
      tx: (fn) => db.tx(fn),
    };
    const seen = new Map<string, string>();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: racing, dek: DEK, seen, log: () => {} }), "published");
    const left = parseTgForgets(readFileSync(forgetFile(src), "utf8"));
    assert.ok(left.some((o) => o.userId === BO), "Bo's request survived the clear");
    assert.ok(!left.some((o) => o.userId === ALICE), "Alice's, which the child's file reflected, went");

    // The next pass carries Bo's too, and his lines never reach the row.
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log: () => {} }), "published");
    assert.ok(!(await storedText(db)).includes("bo was here"));
    assert.ok(existsSync(forgetFile(src)), "the child has not caught up with Bo's yet");
    s.forgetPerson(CHAT, BO);
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen, log: () => {} }), "published");
    assert.equal(existsSync(forgetFile(src)), false);
    s.close();
  });

  test("the stored row is patched in place: never brought back once deleted, never written over a newer one", async (t) => {
    const { db, raw } = await sqlite(t);
    const src = home(t);
    childStore(src).close();
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const h = home(t);
    const child = TgGroupsStore.open(h, { debounceMs: 60_000 });
    aliceForgets(child);
    child.close();

    // Between the read and the write, the sweep (on another replica) deletes the row.
    const between = (fn: () => void): Db => ({
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: async (...params) => {
            if (sql.startsWith("UPDATE tenant_tg_groups")) fn();
            return stmt.run(...params);
          },
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params),
        };
      },
      exec: (sql) => db.exec(sql),
      tx: (f) => db.tx(f),
    });
    const { lines, log } = logs();
    const deleting = between(() => raw.prepare("DELETE FROM tenant_tg_groups WHERE tenant = ?").run(A));
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: h, shared: deleting, dek: DEK, seen: new Map(), log }), "failed");
    assert.equal(await rowCount(db), 0, "the deleted row was not brought back");

    // Republished, then replaced between the read and the write.
    await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    const newer = sealSecret(`tg-groups/v1 ${A}\n${memory("a newer copy")}`, DEK);
    // (memory()'s line is from user 42, who is Alice here.)
    const replacing = between(() => raw.prepare("UPDATE tenant_tg_groups SET sealed = ? WHERE tenant = ?").run(newer, A));
    const seen = new Map<string, string>();
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: h, shared: replacing, dek: DEK, seen, log }), "failed");
    assert.equal((await rowOf(db, A))!.sealed, newer, "the newer row stands");
    // …and is judged afresh on the next pass: its line from her goes too.
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: h, shared: db, dek: DEK, seen, log }), "applied");
    assert.ok(!(await storedText(db)).includes("a newer copy"));
    assertClean(lines, [newer]);
  });

  test("nothing to do is nothing done: no file, no request, no row", async (t) => {
    const { db } = await sqlite(t);
    const seen = new Map<string, string>();
    const empty = home(t);
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: empty, shared: db, dek: DEK, seen, log: () => {} }), "none");
    const h = home(t);
    const child = TgGroupsStore.open(h, { debounceMs: 60_000 });
    aliceForgets(child);
    child.close();
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: h, shared: db, dek: DEK, seen, log: () => {} }), "none", "no stored row");
    assert.equal(await rowCount(db), 0, "and none is created");
    assert.equal(await forgetStoredTgGroups({ tenant: "not-an-address", home: h, shared: db, dek: DEK, seen, log: () => {} }), "failed");
  });

  test("requests that cannot be read hold a restore back, and a publish goes on as the child wrote it", async (t) => {
    const { db } = await sqlite(t);
    const src = home(t);
    childStore(src).close();
    mkdirSync(forgetFile(src));
    const { lines, log } = logs();
    assert.equal(await publishTgGroups({ tenant: A, home: src, shared: db, dek: DEK, seen: new Map(), log }), "published");
    assert.ok(existsSync(forgetFile(src)), "never cleared");
    const dst = home(t);
    mkdirSync(forgetFile(dst));
    assert.equal(await restoreTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, log }), "failed");
    assert.equal(existsSync(path.join(dst, TG_GROUPS_FILE_NAME)), false, "nothing written");
    assert.equal(tgGroupsHeldOff("failed", false), true, "so the child runs held, saying nothing");
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: dst, shared: db, dek: DEK, seen: new Map(), log }), "failed");
    assertClean(lines);
  });

  test("the patch translates to numbered Postgres placeholders and is an UPDATE of the row it read", async (t) => {
    const h = home(t);
    const child = TgGroupsStore.open(h, { debounceMs: 60_000 });
    aliceForgets(child);
    child.close();
    const src = home(t);
    childStore(src).close();
    const text = readFileSync(path.join(src, TG_GROUPS_FILE_NAME), "utf8");
    const sealed = sealSecret(`tg-groups/v1 ${A}\n${text}`, DEK);
    const seenSql: string[] = [];
    const seenParams: unknown[][] = [];
    const recorder: Db = {
      prepare: (sql) => {
        seenSql.push(sql);
        return {
          run: async (...params) => {
            seenParams.push(params);
            return { changes: 1, lastInsertRowid: 0 };
          },
          get: async () => ({ sealed }),
          all: async () => [],
        };
      },
      exec: async () => {},
      tx: async (fn) => fn(recorder),
    };
    assert.equal(await forgetStoredTgGroups({ tenant: A, home: h, shared: recorder, dek: DEK, seen: new Map(), log: () => {} }), "applied");
    assert.equal(seenSql.length, 2);
    assert.equal(translateQuery(seenSql[0]!), "SELECT sealed FROM tenant_tg_groups WHERE tenant = $1");
    assert.equal(
      translateQuery(seenSql[1]!),
      "UPDATE tenant_tg_groups SET sealed = $1, bytes = $2, updated_at_ms = $3 WHERE tenant = $4 AND sealed = $5",
    );
    const [newSealed, , , tenant, was] = seenParams[0]!;
    assert.equal(tenant, A);
    assert.equal(was, sealed, "it names the row it read");
    assert.equal(holdsAlice(openSecret(newSealed as string, DEK).slice(`tg-groups/v1 ${A}\n`.length)), false);
  });
});

// ── gone with the grant, from the home too ──────────────────────────────────

describe("the group files leave a home whose grant is gone while no child runs there", () => {
  const C = `0x${"ef".repeat(20)}`;

  function fleet(t: T): string {
    const dir = path.join(home(t), "children");
    mkdirSync(dir);
    return dir;
  }

  function tenantHome(children: string, tenant: string): string {
    const dir = path.join(children, tenant);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "grant.json"), "{}");
    put(dir, memory());
    return dir;
  }

  test("forgetTgGroupsHome: the memory, the requests and every copy of either go, and nothing else", (t) => {
    const dir = home(t);
    put(dir, memory());
    for (const f of [
      "tg-groups.json.tmp",
      "tg-groups.json.bad",
      TG_GROUPS_FORGET_FILE,
      `${TG_GROUPS_FORGET_FILE}.tmp`,
      ".tg-groups.json.123.abc.restore",
      `.${TG_GROUPS_FORGET_FILE}.1.x.clear`,
      "grant.json",
      "settings.json",
      "merrymen.db",
      "telegram.json",
    ]) {
      writeFileSync(path.join(dir, f), MARKER);
    }
    const { lines, log } = logs();
    assert.equal(forgetTgGroupsHome(dir, log), 7);
    assert.deepEqual(readdirSync(dir).sort(), ["grant.json", "merrymen.db", "settings.json", "telegram.json"]);
    assert.equal(forgetTgGroupsHome(dir, log), 0, "nothing left is nothing done");
    assert.equal(forgetTgGroupsHome(path.join(dir, "gone"), log), 0, "a missing home is not an error");
    assertClean(lines);
  });

  test("forgetTgGroupsHome with a bound leaves a file written since", (t) => {
    const dir = home(t);
    const file = put(dir, memory());
    const at = Date.now();
    utimesSync(file, new Date(at + 60_000), new Date(at + 60_000));
    assert.equal(forgetTgGroupsHome(dir, () => {}, at), 0);
    assert.ok(existsSync(file));
    utimesSync(file, new Date(at - 60_000), new Date(at - 60_000));
    assert.equal(forgetTgGroupsHome(dir, () => {}, at), 1);
    assert.equal(existsSync(file), false);
  });

  // The finding: the grant went while the child was not running here (a
  // restart back-off, a stand-down, a fleet halt, a lost lease), so no kill
  // branch removed its home. The re-grant's restore found the old file
  // "present", the child used it, and the mirror sealed it back into Postgres.
  test("THE FINDING: a grant removed while its child is not running, then a re-grant: the restore finds nothing, not the old memory", async (t) => {
    const { db } = await sqlite(t);
    const children = fleet(t);
    const a = tenantHome(children, A);
    await publishTgGroups({ tenant: A, home: a, shared: db, dek: DEK, seen: new Map(), log: () => {} });
    // The grant goes: the row sweep deletes the row…
    assert.deepEqual(await forgetUnwantedTgGroups({ shared: db, wanted: new Set(), listedAtMs: Date.now() + 1, log: () => {} }), [A]);
    // …and the home walk the file.
    const { lines, log } = logs();
    assert.deepEqual(forgetTgGroupsInHomes({ childrenDir: children, keep: () => false, before: Date.now() + 1, log }), [A]);
    assert.equal(existsSync(path.join(a, TG_GROUPS_FILE_NAME)), false);
    assert.ok(existsSync(path.join(a, "grant.json")), "the rest of the home is not the walk's");
    // The same wallet signs again; its spawn restores.
    assert.equal(await restoreTgGroups({ tenant: A, home: a, shared: db, dek: DEK, log }), "none", "not \"present\" with the old memory");
    assertClean(lines);
  });

  test("the walk keeps what it is told to, skips what is not a tenant's home, and is bounded per pass", (t) => {
    const children = fleet(t);
    const a = tenantHome(children, A);
    const b = tenantHome(children, B);
    const c = tenantHome(children, C);
    mkdirSync(path.join(children, "not-a-tenant"));
    put(path.join(children, "not-a-tenant"), memory());
    const keep = (x: string) => x === B;
    const first = forgetTgGroupsInHomes({ childrenDir: children, keep, before: Date.now() + 1, max: 1, log: () => {} });
    assert.equal(first.length, 1);
    const second = forgetTgGroupsInHomes({ childrenDir: children, keep, before: Date.now() + 1, max: 1, log: () => {} });
    assert.equal(second.length, 1);
    assert.deepEqual([...first, ...second].sort(), [A, C].sort());
    assert.deepEqual(forgetTgGroupsInHomes({ childrenDir: children, keep, before: Date.now() + 1, log: () => {} }), []);
    assert.equal(existsSync(path.join(a, TG_GROUPS_FILE_NAME)), false);
    assert.equal(existsSync(path.join(c, TG_GROUPS_FILE_NAME)), false);
    assert.ok(existsSync(path.join(b, TG_GROUPS_FILE_NAME)), "a kept tenant's file stays");
    assert.ok(existsSync(path.join(children, "not-a-tenant", TG_GROUPS_FILE_NAME)), "not a home childHome makes");
    // A file written after the listing (a newer grant's spawn) is the next pass's.
    const fresh = tenantHome(children, `0x${"12".repeat(20)}`);
    assert.deepEqual(forgetTgGroupsInHomes({ childrenDir: children, keep, before: Date.now() - 60_000, log: () => {} }), []);
    assert.ok(existsSync(path.join(fresh, TG_GROUPS_FILE_NAME)));
    assert.deepEqual(forgetTgGroupsInHomes({ childrenDir: path.join(children, "gone"), keep, before: Date.now(), log: () => {} }), []);
  });

  test("the orchestrator, run: a reconcile clears a home no child runs in, and a /kill carried out with no child here clears it at once", async (t) => {
    const saved = { ...process.env };
    const fleetHome = home(t);
    const { resetGrantStoreForTest, getGrantStore } = await import("./grant-store");
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      resetGrantStoreForTest();
    });
    process.env.MERRYMEN_HOME = fleetHome;
    delete process.env.DATABASE_URL;
    resetGrantStoreForTest();
    const { reconcile, childHome, honourPendingKills } = await import("./orchestrator");
    const { writeKillRequest } = await import("./kill-request");

    // Not in the grant store, not running here: what a discard during a
    // restart back-off leaves.
    const gone = childHome(C);
    mkdirSync(gone, { recursive: true });
    writeFileSync(path.join(gone, "grant.json"), "{}");
    put(gone, memory());
    writeFileSync(path.join(gone, TG_GROUPS_FORGET_FILE), `\n${JSON.stringify({ chatId: CHAT, userId: ALICE, atMs: 1 })}\n`);
    // An mtime before the pass's listing: the walk judges only older files.
    const old = new Date(Date.now() - 60_000);
    for (const f of [TG_GROUPS_FILE_NAME, TG_GROUPS_FORGET_FILE]) utimesSync(path.join(gone, f), old, old);
    await reconcile();
    assert.equal(existsSync(path.join(gone, TG_GROUPS_FILE_NAME)), false, "the reconcile removed the memory");
    assert.equal(existsSync(path.join(gone, TG_GROUPS_FORGET_FILE)), false);
    // The reconcile also wipes the whole home of a tenant that is neither
    // wanted nor running here (orchestrator.ts, kill-request.ts's promise),
    // so the memory is gone with everything else. The walk itself touches
    // only the group files: "the walk keeps what it is told to" above.
    assert.equal(existsSync(path.join(gone, "grant.json")), false, "the home goes with the grant");

    // A /kill for a tenant whose child is not running here (it crashed): the
    // three-second ferry carries it out, and the memory goes with the grant.
    const nowSec = Math.floor(Date.now() / 1000);
    const grant = {
      smartAccount: "0x00000000000000000000000000000000000000c3",
      owner: "0x00000000000000000000000000000000000000b2",
      sessionKeyAddress: "0x00000000000000000000000000000000000000d4",
      serialized: `eyJ-a-zerodev-blob-${nowSec}`,
      chainId: 4663,
      grantedAt: nowSec - 3600,
      expiresAt: nowSec + 7 * 86_400,
      caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
      grantFeatures: ["tradeable-v2"],
      grantTokens: [],
    } as unknown as Parameters<ReturnType<typeof getGrantStore>["put"]>[1];
    await getGrantStore().put(B as `0x${string}`, grant);
    const killed = childHome(B);
    mkdirSync(killed, { recursive: true });
    put(killed, memory());
    writeKillRequest(killed, grant, nowSec);
    await honourPendingKills();
    assert.equal(await getGrantStore().get(B as `0x${string}`), null, "the grant is removed");
    assert.equal(existsSync(path.join(killed, TG_GROUPS_FILE_NAME)), false, "and its group memory with it, before any reconcile");
  });
});

describe("the row is read here and nowhere else", () => {
  test("no other worker or web source names the table", () => {
    const repo = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) return [];
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walk(full) : /\.tsx?$/.test(e.name) ? [full] : [];
      });
    const files = [...walk(path.join(repo, "worker", "src")), ...walk(path.join(repo, "web", "src"))];
    assert.ok(files.length > 100, "the walk reached the sources");
    const naming = files
      .filter((f) => readFileSync(f, "utf8").includes("tenant_tg_groups"))
      .map((f) => path.relative(repo, f).split(path.sep).join("/"))
      .sort();
    // The file never becomes a trading input, a web read or a second writer.
    assert.deepEqual(naming, ["worker/src/tg-groups-ferry.test.ts", "worker/src/tg-groups-ferry.ts"]);
  });
});

describe("isTgGroupsText", () => {
  test("a JSON object with version 1, and nothing else", () => {
    assert.equal(isTgGroupsText(memory()), true);
    assert.equal(isTgGroupsText('{"version":1}'), true);
    for (const bad of ['{"version":"1"}', '{"version":2}', "[]", "1", "null", "", "{", '{"rooms":{}}']) {
      assert.equal(isTgGroupsText(bad), false, bad);
    }
  });
});

// ── the orchestrator's wiring ───────────────────────────────────────────────

describe("the ferry and the child's store agree", () => {
  // The ferry keeps its own copy of the memory file's name (the file is opaque
  // to it; only the forget requests are read, with the store's own helpers),
  // so the two can drift apart silently: a ferry reading a different name
  // restores nothing and publishes nothing, and every redeploy would wipe
  // every agent's group memory.
  test("the same file name", () => {
    assert.equal(TG_GROUPS_FILE_NAME, TG_GROUPS_FILE);
  });

  test("the ferry's size refusal sits above anything the store writes", () => {
    assert.ok(TG_GROUPS_MAX_BYTES > TG_LIMITS.fileBytes, "a real file is never refused as too big");
  });
});

describe("the orchestrator ferries it where the contract says", () => {
  const ORCH = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const body = (start: string): string => {
    const i = ORCH.indexOf(start);
    assert.ok(i >= 0, `${start} not found`);
    return ORCH.slice(i, ORCH.indexOf("\n}\n", i));
  };

  test("publish: in the mirror pass, below the lease gate, with the process's own DEK", () => {
    const mirror = body("async function mirrorLedgers(");
    const gate = mirror.indexOf("if (!lease || !lease.healthy()) continue;");
    const call = mirror.indexOf("await publishTgGroups({");
    assert.ok(gate > 0, "the mirror's lease gate");
    assert.ok(call > gate, "only for a tenant whose lease this replica holds healthily");
    assert.ok(mirror.indexOf("await publishTgGroups({", call + 1) < 0, "one call site");
    assert.match(mirror, /await ensureTgGroupsSchema\(shared, "postgres"\);/, "the schema is ensured where the other shared schemas are");
    assert.equal(ORCH.split("publishTgGroups(").length - 1, 1, "the mirror is the only publisher");
  });

  test("restore: in spawnChild, behind the lease refusal, after the link restore and before spawn()", () => {
    const spawnFn = body("async function spawnChild(");
    const refusal = spawnFn.indexOf("no healthy lease — not spawning");
    const link = spawnFn.indexOf("await writeTelegramForChild(tenant);");
    const restore = spawnFn.indexOf("await restoreTgGroupsForChild(tenant);");
    const proc = spawnFn.indexOf("const proc = spawn(");
    assert.ok(refusal > 0 && link > refusal, "the lease refusal comes first");
    assert.ok(restore > link, "beside the link restore");
    assert.ok(proc > restore, "before the child starts");
    const helper = body("async function restoreTgGroupsForChild(");
    assert.match(helper, /await ensureTgGroupsSchema\(db, "postgres"\);/, "a first spawn can precede the first mirror pass");
    assert.match(helper, /const shared = async \(\): Promise<Db> => \{/, "opened only for a home without the file");
    assert.match(helper, /await restoreTgGroups\(\{ tenant, home: childHome\(tenant\), shared, dek, log \}\)/);
  });

  test("held off: a failed restore spawns the child with its groups off and publishes nothing for it", () => {
    const helper = body("async function restoreTgGroupsForChild(");
    assert.match(helper, /if \(tgGroupsHeldOff\(r, tgGroupsHeld\.has\(lc\)\)\) \{\s*tgGroupsHeld\.add\(lc\);/);
    assert.match(helper, /\} else \{\s*tgGroupsHeld\.delete\(lc\);/, "a spawn that restores lets go");

    const spawnFn = body("async function spawnChild(");
    const restore = spawnFn.indexOf("await restoreTgGroupsForChild(tenant);");
    const env = spawnFn.indexOf("env: childEnv(tenant, { tgGroupsOff: tgGroupsHeld.has(tenant.toLowerCase()) })");
    assert.ok(restore > 0 && env > restore, "the child's env is decided after this spawn's restore");
    // The child's, above, and the hold process's (startHolderProcess), which
    // never opens the group store: while trading is held nothing of the
    // groups runs at all, so there is nothing there to hold off.
    assert.equal(ORCH.split("env: childEnv(").length - 1, 2, "the child's spawn site and the hold process's");
    const holder = body("function startHolderProcess(");
    assert.ok(holder.includes("HOLD_ENTRY") && holder.includes("env: childEnv(tenant)"), "the other one is the hold process");

    const mirror = body("async function mirrorLedgers(");
    assert.match(mirror, /if \(tgGroupsDekThisPass && !tgGroupsHeld\.has\(tenant\.toLowerCase\(\)\)\) \{\s*const published = await publishTgGroups\(\{/);

    const forget = body("async function forgetTgGroups(");
    assert.match(forget, /tgGroupsHeld\.delete\(/, "cleared with the grant");
  });

  test("forget requests: a held child's row is patched, and so is one whose file was not published, under the same lease", () => {
    const mirror = body("async function mirrorLedgers(");
    const gate = mirror.indexOf("if (!lease || !lease.healthy()) continue;");
    const publish = mirror.indexOf("const published = await publishTgGroups({");
    const unpublished = mirror.indexOf('if (published !== "published" && published !== "unchanged") {', publish);
    const patchAfter = mirror.indexOf("await forgetStoredTgGroups({", unpublished);
    const heldBranch = mirror.indexOf("} else if (tgGroupsDekThisPass) {", patchAfter);
    const patchHeld = mirror.indexOf("await forgetStoredTgGroups({", heldBranch);
    assert.ok(gate > 0 && publish > gate, "below the lease gate");
    assert.ok(unpublished > publish && patchAfter > unpublished, "a file that was not published still carries its requests");
    assert.ok(heldBranch > patchAfter && patchHeld > heldBranch, "a held child's requests reach the row");
    // And a tenant whose TRADING is held (the hold process runs, no child):
    // nothing of its groups is published, and a request a child left in the
    // home reaches the row all the same, under that loop's own lease gate.
    const holders = mirror.indexOf("for (const [tenant, held] of [...holders]) {");
    const holdersGate = mirror.indexOf("if (!lease || !lease.healthy()) continue;", holders);
    const patchHolder = mirror.indexOf("await forgetStoredTgGroups({", holdersGate);
    assert.ok(holders > patchHeld && holdersGate > holders && patchHolder > holdersGate, "a held tenant's requests reach the row");
    assert.ok(mirror.indexOf("await publishTgGroups({", holders) < 0, "and nothing of a held tenant is published");
    assert.equal(ORCH.split("forgetStoredTgGroups(").length - 1, 3, "and nowhere else");
  });

  test("gone with the grant, from the home: forgetTgGroups clears a home no child runs in, before it awaits anything", () => {
    const forget = body("async function forgetTgGroups(");
    const clear = forget.indexOf("if (!children.has(lc)) forgetTgGroupsHome(childHome(tenant), log);");
    assert.ok(clear > 0, "only when no child of it runs here");
    assert.ok(forget.indexOf("await ") > clear, "synchronously, before the first await, so no spawn starts in between");
    const sweep = body("async function sweepTgGroups(");
    const walk = sweep.indexOf("forgetTgGroupsInHomes({");
    assert.ok(walk > 0 && walk < sweep.indexOf("const url = process.env.DATABASE_URL;"), "every pass, with or without a database");
    assert.match(sweep, /keep: \(t\) => wanted\.has\(t\) \|\| children\.has\(t\),\s*before: listedAtMs,/);
    assert.match(sweep, /childrenDir: path\.join\(merrymenHome\(\), "children"\),/, "the directory childHome uses");
  });

  test("childEnv, run: a held child gets the operator's switch at 0, and nobody else's is changed", async (t) => {
    const saved = { ...process.env };
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });
    process.env.MERRYMEN_HOME = home(t);
    delete process.env.MERRYMEN_TG_GROUPS;
    const { childEnv } = await import("./orchestrator");
    assert.equal(childEnv(A, { tgGroupsOff: true }).MERRYMEN_TG_GROUPS, "0");
    assert.equal(childEnv(A).MERRYMEN_TG_GROUPS, undefined);
    assert.equal(childEnv(A, { tgGroupsOff: false }).MERRYMEN_TG_GROUPS, undefined);
    // An operator's fleet-wide off stays off for every child.
    process.env.MERRYMEN_TG_GROUPS = "0";
    assert.equal(childEnv(A, { tgGroupsOff: false }).MERRYMEN_TG_GROUPS, "0");
  });

  test("the grant store decides: a /kill that removes the grant, a spawn that finds none, and a sweep every pass", () => {
    const kill = body("async function honourKill(");
    const removed = kill.indexOf("if (k.outcome === \"revoked\" && k.removed) {");
    const forgetOnKill = kill.indexOf("await forgetTgGroups(tenant);");
    assert.ok(removed > 0 && forgetOnKill > removed, "a /kill forgets at once");
    assert.ok(forgetOnKill < kill.indexOf("\n  }\n", removed), "only in the branch whose DELETE removed the grant");

    const spawnFn = body("async function spawnChild(");
    const noGrant = spawnFn.indexOf("no grant in the store — not spawning");
    const ret = spawnFn.indexOf("return;", noGrant);
    const forgetOnSpawn = spawnFn.indexOf("await forgetTgGroups(tenant);", noGrant);
    assert.ok(noGrant > 0 && forgetOnSpawn > noGrant && forgetOnSpawn < ret, "a spawn that finds no grant forgets before it returns");

    const rec = body("export async function reconcile(");
    const stamp = rec.indexOf("const listedAtMs = Date.now();");
    const list = rec.indexOf("tenants = await store.listTenants();");
    const unreadable = rec.indexOf("store unreadable, skipping this reconcile");
    const wanted = rec.indexOf("const wanted = new Set(");
    const killBranch = rec.indexOf("grant removed — standing it down");
    const sweep = rec.indexOf("await sweepTgGroups(wanted, listedAtMs);");
    assert.ok(stamp > 0 && list > stamp, "the bound is taken before the listing is asked for");
    assert.ok(unreadable > list && wanted > unreadable, "an unreadable store returns before anything is judged");
    assert.ok(sweep > wanted && sweep > killBranch, "after the listing, beside the kill switch");
    assert.equal(ORCH.split("sweepTgGroups(").length - 1, 2, "defined once, called once");
    assert.match(body("async function sweepTgGroups("), /await forgetUnwantedTgGroups\(\{ shared, wanted, listedAtMs, log \}\);/);
  });

  test("FLEET_HALT: the reconcile (and so the sweep) runs only when the fleet is not halted", () => {
    const loop = body("export async function runOrchestrator(");
    const halt = loop.indexOf("if (haltRequested()) {");
    const orElse = loop.indexOf("} else {", halt);
    const rec = loop.indexOf("await reconcile();");
    assert.ok(halt > 0 && orElse > halt && rec > orElse, "inside the not-halted branch");
    assert.equal(loop.split("await reconcile();").length - 1, 1);
  });

  test("delete: on the kill switch, with the home", () => {
    const rec = body("export async function reconcile(");
    const kill = rec.indexOf("grant removed — standing it down");
    const rm = rec.indexOf("rmSync(childHome(tenant), { recursive: true, force: true });", kill);
    const forget = rec.indexOf("await forgetTgGroups(tenant);", kill);
    assert.ok(kill > 0 && rm > kill && forget > rm, "the row goes with the home");
    const helper = body("async function forgetTgGroups(");
    assert.match(helper, /tgGroupsSeen\.delete\(/, "a re-armed tenant publishes afresh");
    assert.match(helper, /await deleteTgGroups\(tenant, shared, log\);/);
  });

  test("FLEET_HALT: the mirror (and so the publish) runs only when the fleet is not halted", () => {
    const loop = body("export async function runOrchestrator(");
    const halt = loop.indexOf("if (haltRequested()) {");
    const orElse = loop.indexOf("} else {", halt);
    const mirror = loop.indexOf("await mirrorLedgers();");
    assert.ok(halt > 0 && orElse > halt && mirror > orElse, "inside the not-halted branch");
    assert.equal(loop.split("mirrorLedgers()").length - 1, 1);
  });

  test("the group model key is forwarded to children and the DEK is not", () => {
    const i = ORCH.indexOf("const CHILD_SECRET_STRIP = [");
    const block = ORCH.slice(i, ORCH.indexOf("] as const;", i));
    assert.ok(block.includes('"MERRYMEN_STORE_DEK"'));
    assert.ok(!block.includes("MERRYMEN_TG_GROUPS_LLM_KEY"), "the child polls Telegram and needs its own key");
    const doc = ORCH.slice(ORCH.lastIndexOf("/**", i), i);
    assert.match(doc, /MERRYMEN_TG_GROUPS_LLM_KEY IS FORWARDED ON PURPOSE/, "and it says why, where the next reader looks");
  });

  test("childEnv, run: the key reaches a child, the DEK and the database do not", async (t) => {
    const saved = { ...process.env };
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });
    process.env.MERRYMEN_HOME = home(t);
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_TG_GROUPS_LLM_KEY = "tg-groups-dedicated-key";
    process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
    process.env.DATABASE_URL = "postgres://never-to-a-child";
    const { childEnv } = await import("./orchestrator");
    const env = childEnv(A as `0x${string}`);
    assert.equal(env.MERRYMEN_TG_GROUPS_LLM_KEY, "tg-groups-dedicated-key");
    assert.equal(env.MERRYMEN_STORE_DEK, undefined);
    assert.equal(env.DATABASE_URL, undefined);
  });
});
