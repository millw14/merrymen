import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { LocalNonceStore, SqlNonceStore } from "./auth-nonce-store";
import { wrapSqlite, type Db } from "./db";

const run = promisify(execFile);

test("independent SQL store instances share one atomic claim and survive reopening", async () => {
  const home = mkdtempSync(join(tmpdir(), "merrymen-nonce-sql-"));
  const file = join(home, "nonces.sqlite");
  const firstDb = new DatabaseSync(file);
  const secondDb = new DatabaseSync(file);
  const now = Date.now();
  try {
    const first = new SqlNonceStore(async () => wrapSqlite(firstDb), "sqlite");
    const second = new SqlNonceStore(async () => wrapSqlite(secondDb), "sqlite");
    const claims = await Promise.all([
      first.consume("shared-challenge", now + 60_000, now),
      second.consume("shared-challenge", now + 60_000, now),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
  } finally {
    firstDb.close();
    secondDb.close();
  }
  const reopened = new DatabaseSync(file);
  try {
    const fresh = new SqlNonceStore(async () => wrapSqlite(reopened), "sqlite");
    assert.equal(await fresh.consume("shared-challenge", now + 60_000, now), false);
    assert.equal(await fresh.consume("different-challenge", now + 60_000, now), true);
    assert.equal(await fresh.consume("expired-challenge", now, now), false);
  } finally {
    reopened.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("local replay protection survives separate processes and process restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "merrymen-nonce-process-"));
  const now = Date.now();
  const source = `import { LocalNonceStore } from './worker/src/auth-nonce-store';
    new LocalNonceStore(${JSON.stringify(home)}).consume('process-challenge', ${now + 60_000}, ${now})
      .then(result => console.log(JSON.stringify(result)));`;
  const child = () => run(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "-e", source], {
    cwd: process.cwd(), env: { ...process.env, MERRYMEN_HOME: home, DATABASE_URL: "", MERRYMEN_HOSTED: "" },
  });
  try {
    const results = await Promise.all([child(), child()]);
    assert.deepEqual(results.map((result) => JSON.parse(result.stdout.trim())).sort(), [false, true]);
    assert.equal(JSON.parse((await child()).stdout.trim()), false);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("expired cleanup does not reopen an unexpired nonce", async () => {
  const home = mkdtempSync(join(tmpdir(), "merrymen-nonce-cleanup-"));
  try {
    const store = new LocalNonceStore(home);
    const now = Date.now();
    assert.equal(await store.consume("old", now - 20 * 60_000, now - 21 * 60_000), true);
    assert.equal(await store.consume("current", now + 60_000, now), true);
    assert.equal(await store.consume("current", now + 60_000, now), false);
    assert.equal(await store.consume("old", now - 20 * 60_000, now), false);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("SQL storage errors never report a successful claim and failed initialization can retry", async () => {
  let attempts = 0;
  const store = new SqlNonceStore(async () => {
    attempts++;
    throw new Error("database unavailable");
  }, "sqlite");
  await assert.rejects(store.consume("nonce", Date.now() + 60_000, Date.now()), /database unavailable/);
  await assert.rejects(store.consume("nonce", Date.now() + 60_000, Date.now()), /database unavailable/);
  assert.equal(attempts, 2);

  const broken = new SqlNonceStore(async () => ({
    exec: async () => {},
    prepare: () => ({ run: async () => { throw new Error("write failed"); } }),
  } as unknown as Db), "sqlite");
  await assert.rejects(broken.consume("nonce", Date.now() + 60_000, Date.now()), /write failed/);
});
