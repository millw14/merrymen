import assert from "node:assert/strict";
import { it } from "node:test";
import { PgPerpsIntroStore } from "./perps-intro-store";
it("hosted claim uses one atomic insert, normalized owner and retries initial connection failures", async () => {
  let connects = 0;
  const owners = new Set<string>();
  const store = new PgPerpsIntroStore("unused", async () => {
    if (++connects === 1) throw new Error("temporarily offline");
    return { async query(sql, params) {
      if (sql.startsWith("CREATE TABLE")) return { rows: [] };
      assert.match(sql, /ON CONFLICT \(owner\) DO NOTHING RETURNING owner/);
      const owner = String(params?.[0]);
      if (owners.has(owner)) return { rows: [] };
      owners.add(owner); return { rows: [{ owner }] };
    } };
  });
  const owner = `0x${"AB".repeat(20)}`;
  await assert.rejects(store.claim(owner), /offline/);
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim(owner)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.deepEqual([...owners], [owner.toLowerCase()]);
  assert.equal(connects, 2);
  await assert.rejects(store.claim("../owner"), /Invalid intro owner/);
});

it("an uncertain committed insert fails once, then reconnects without replaying the intro", async () => {
  let connects = 0, inserts = 0, ended = 0;
  const owners = new Set<string>();
  const store = new PgPerpsIntroStore("unused", async () => {
    const first = ++connects === 1;
    return {
      async end() { ended++; },
      async query(sql, params) {
        if (sql.startsWith("CREATE TABLE")) return { rows: [] };
        inserts++;
        const owner = String(params?.[0]), alreadyClaimed = owners.has(owner);
        owners.add(owner);
        if (first) throw new Error("connection lost after commit");
        return { rows: alreadyClaimed ? [] : [{ owner }] };
      },
    };
  });
  await assert.rejects(store.claim("local"), /after commit/);
  assert.equal(connects, 1, "the ambiguous request is never automatically retried");
  assert.equal(inserts, 1);
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim("local")));
  assert.ok(claims.every(play => !play));
  assert.equal(connects, 2);
  assert.equal(ended, 1);
});

it("idle connection errors reconnect once for concurrent claims and late old errors preserve the replacement", async () => {
  const errors: Array<(error: Error) => void> = [];
  let connects = 0, ended = 0;
  const owners = new Set<string>();
  const store = new PgPerpsIntroStore("unused", async () => {
    connects++;
    return {
      on(_event, listener) { errors.push(listener); },
      async end() { ended++; },
      async query(sql, params) {
        if (sql.startsWith("CREATE TABLE")) return { rows: [] };
        const owner = String(params?.[0]);
        if (owners.has(owner)) return { rows: [] };
        owners.add(owner); return { rows: [{ owner }] };
      },
    };
  });
  assert.equal(await store.claim("local"), true);
  errors[0](new Error("idle socket lost"));
  const owner = `0x${"ab".repeat(20)}`;
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim(owner)));
  assert.equal(claims.filter(Boolean).length, 1);
  errors[0](new Error("late old socket error"));
  assert.equal(await store.claim(owner), false);
  assert.equal(connects, 2);
  assert.equal(ended, 1);
});

it("a late concurrent query rejection cannot discard a healthy replacement connection", async () => {
  let connects = 0;
  const failures: Array<(error: Error) => void> = [];
  const store = new PgPerpsIntroStore("unused", async () => {
    const first = ++connects === 1;
    return { async query(sql) {
      if (sql.startsWith("CREATE TABLE")) return { rows: [] };
      if (first) return new Promise<{ rows: Record<string, unknown>[] }>((_resolve, reject) => failures.push(reject));
      return { rows: [] };
    } };
  });
  const first = assert.rejects(store.claim("local"), /lost/);
  const second = assert.rejects(store.claim("local"), /lost/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures.length, 2);
  failures[0](new Error("lost")); await first;
  assert.equal(await store.claim("local"), false);
  failures[1](new Error("lost late")); await second;
  assert.equal(await store.claim("local"), false);
  assert.equal(connects, 2);
});
