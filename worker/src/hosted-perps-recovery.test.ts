import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { wrapSqlite } from "./db";
import { readHostedPerpsRecovery, writeHostedPerpsRecovery } from "./hosted-perps-recovery";

const A = `0x${"a1".repeat(20)}`;
const B = `0x${"b2".repeat(20)}`;
const ACCOUNT = `0x${"c3".repeat(20)}`;
const OTHER = `0x${"d4".repeat(20)}`;

it("recovery status is bound to owner and account and clears only on verified success", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    const db = wrapSqlite(raw);
    await writeHostedPerpsRecovery(db, { tenant: A, account: ACCOUNT, ok: false, nowMs: 20 });
    assert.equal((await readHostedPerpsRecovery(db, A.toUpperCase().replace("0X", "0x"), ACCOUNT))?.state, "paused");
    assert.equal(await readHostedPerpsRecovery(db, B, ACCOUNT), null);
    assert.equal(await readHostedPerpsRecovery(db, A, OTHER), null);
    assert.equal((await readHostedPerpsRecovery(db, A))?.state, "paused", "removing the grant must not hide its failed recovery");
    await writeHostedPerpsRecovery(db, { tenant: A, account: ACCOUNT, ok: true, nowMs: 19 });
    assert.equal((await readHostedPerpsRecovery(db, A, ACCOUNT))?.state, "paused", "stale success cannot overwrite a newer refusal");
    await writeHostedPerpsRecovery(db, { tenant: A, account: ACCOUNT, ok: true, nowMs: 21 });
    assert.equal(await readHostedPerpsRecovery(db, A, ACCOUNT), null);
    assert.equal(await readHostedPerpsRecovery(db, A), null);
  } finally { raw.close(); }
});

it("unavailable storage is unknown, with fixed copy and no database error details", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  raw.close();
  const value = await readHostedPerpsRecovery(db, A, ACCOUNT);
  assert.equal(value?.state, "unknown");
  assert.match(value!.message, /could not be checked/);
  assert.doesNotMatch(value!.message, /sqlite|database|secret|closed/i);
});
