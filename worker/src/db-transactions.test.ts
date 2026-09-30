import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SQLite transaction isolation", () => {
  it("keeps unrelated writes, reads and DDL outside a transaction that rolls back", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec("CREATE TABLE entries (value TEXT)");
      const entered = deferred();
      const release = deferred();
      const insert = db.prepare("INSERT INTO entries VALUES (?)");
      const transaction = db.tx(async (tx) => {
        await tx.prepare("INSERT INTO entries VALUES (?)").run("rolled back");
        entered.resolve();
        await release.promise;
        throw new Error("injected rollback");
      });
      const rollback = assert.rejects(transaction, /injected rollback/);
      await entered.promise;

      const completed: string[] = [];
      const outsideWrite = insert.run("independent").then(() => { completed.push("write"); });
      const outsideGet = db.prepare("SELECT COUNT(*) AS n FROM entries").get()
        .then((row) => { completed.push("get"); return row as { n: number }; });
      const outsideAll = db.prepare("SELECT value FROM entries").all()
        .then((rows) => { completed.push("all"); return rows as { value: string }[]; });
      const outsideDdl = db.exec("CREATE TABLE independent (value TEXT)")
        .then(() => { completed.push("exec"); });
      await setImmediate();
      assert.deepEqual(completed, [], "every access waits for the transaction boundary");

      release.resolve();
      await rollback;
      await Promise.all([outsideWrite, outsideDdl]);
      assert.equal((await outsideGet).n, 1);
      assert.deepEqual((await outsideAll).map((row) => row.value), ["independent"]);
      assert.equal((await db.prepare("SELECT name FROM sqlite_master WHERE name = 'independent'").all()).length, 1);
    } finally {
      raw.close();
    }
  });

  it("publishes the complete committed transaction to an outside reader", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec("CREATE TABLE entries (value TEXT)");
      const entered = deferred();
      const release = deferred();
      const transaction = db.tx(async (tx) => {
        await tx.prepare("INSERT INTO entries VALUES (?)").run("first");
        entered.resolve();
        await release.promise;
        await tx.prepare("INSERT INTO entries VALUES (?)").run("second");
        return (await tx.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
      });
      await entered.promise;
      let readCompleted = false;
      const outsideRead = db.prepare("SELECT COUNT(*) AS n FROM entries").get()
        .then((row) => { readCompleted = true; return row as { n: number }; });
      await setImmediate();
      assert.equal(readCompleted, false);
      release.resolve();
      assert.equal(await transaction, 2, "scoped operations do not wait on their own transaction");
      assert.equal((await outsideRead).n, 2);
    } finally {
      raw.close();
    }
  });

  it("serializes simultaneous transactions, even through a second wrapper", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    const sameConnection = wrapSqlite(raw);
    try {
      await db.exec("CREATE TABLE entries (value INTEGER)");
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? db : sameConnection).tx(async (tx) => {
          const before = await tx.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
          await setImmediate();
          await tx.prepare("INSERT INTO entries VALUES (?)").run(index);
          return before.n;
        }),
      ));
      assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.equal((await db.prepare("SELECT * FROM entries").all()).length, 8);
    } finally {
      raw.close();
    }
  });

  it("continues after failed statements and failed transactions", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec("CREATE TABLE entries (value TEXT NOT NULL)");
      await assert.rejects(db.prepare("INSERT INTO entries VALUES (?)").run(null));
      await assert.rejects(db.tx(async (tx) => {
        await tx.prepare("INSERT INTO entries VALUES (?)").run("aborted");
        await tx.prepare("INSERT INTO entries VALUES (?)").run(null);
      }));
      await db.tx(async (tx) => {
        await tx.exec("INSERT INTO entries VALUES ('kept')");
      });
      assert.deepEqual((await db.prepare("SELECT value FROM entries").all() as { value: string }[])
        .map((row) => row.value), ["kept"]);
    } finally {
      raw.close();
    }
  });

  it("rejects nested or escaped transaction handles without blocking later work", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec("CREATE TABLE entries (value TEXT)");
      let escaped!: Db;
      await db.tx(async (tx) => {
        escaped = tx;
        await assert.rejects(tx.tx(async () => {}), /nested transactions/);
        await tx.prepare("INSERT INTO entries VALUES (?)").run("kept");
      });
      await assert.rejects(escaped.prepare("SELECT * FROM entries").all(), /no longer active/);
      await assert.rejects(escaped.exec("DELETE FROM entries"), /no longer active/);
      assert.equal((await db.prepare("SELECT * FROM entries").all()).length, 1);
    } finally {
      raw.close();
    }
  });
});
