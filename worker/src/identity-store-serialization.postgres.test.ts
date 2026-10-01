/** Opt-in real Postgres check for the one-client identity transaction queue.
 * Only a disposable local database is accepted; CI needs no pg package. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { AccountAlreadyClaimed, PgIdentityStore } from "./identity-store";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  end(): Promise<void>;
  on(event: "error" | "end", cb: () => void): void;
}
const pg = (url ? createRequire(import.meta.url)("pg") : null) as {
  Client: new (c: { connectionString: string }) => PgClient;
} | null;
const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const C = "0x00000000000000000000000000000000000000e5" as const;
const D = "0x00000000000000000000000000000000000000f6" as const;
const FIRST = "0x00000000000000000000000000000000000000c3" as const;
const CONTESTED = "0x00000000000000000000000000000000000000d4" as const;
const social = { did: "did:privy:identity-queue", provider: "twitter" as const, subject: "identity-queue" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Postgres: identity operations cannot enter another operation's transaction", { skip: !url, timeout: 20_000 }, async () => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only local Postgres is allowed");
  const schema = `mm_identity_queue_${randomBytes(8).toString("hex")}`;
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000`);
  const admin = new pg!.Client({ connectionString: url! });
  const opened: PgClient[] = [];
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    let holdBegin = false;
    const entered = deferred();
    const proceed = deferred();
    const queries: string[] = [];
    const connect = async (): Promise<PgClient> => {
      const c = new pg!.Client({ connectionString: scoped.toString() });
      await c.connect();
      opened.push(c);
      return {
        connect: async () => {},
        query: async (sql, values) => {
          const result = await c.query(sql, values);
          queries.push(sql.trim());
          if (sql.trim() === "BEGIN" && holdBegin) {
            holdBegin = false;
            entered.resolve();
            await proceed.promise;
          }
          return result;
        },
        end: () => c.end(),
        on: (event, cb) => c.on(event, cb),
      };
    };
    const store = new PgIdentityStore(scoped.toString(), connect);
    await store.get(A); // schema and claim backfill are complete
    queries.length = 0;
    holdBegin = true;
    const first = store.ensure(A, FIRST);
    await entered.promise;
    const second = store.resolveOrClaimDid(B, social);
    const read = store.all();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(queries, ["BEGIN"], "other requests must wait outside the shared transaction");
    proceed.resolve();
    await first;
    assert.deepEqual(await second, { ok: true, tenant: B, created: true });
    assert.equal((await read).length, 2);
    const firstCommit = queries.indexOf("COMMIT");
    assert.ok(firstCommit > 0);
    assert.equal(queries.slice(0, firstCommit).filter((q) => q === "BEGIN").length, 1);

    // Separate store instances use separate connections; Postgres's unique
    // claim index must still let only one tenant own a contested account.
    const contenderA = new PgIdentityStore(scoped.toString(), connect);
    const contenderB = new PgIdentityStore(scoped.toString(), connect);
    await contenderA.get(A);
    await contenderB.get(B);
    const results = await Promise.allSettled([
      contenderA.ensure(A, CONTESTED),
      contenderB.ensure(B, CONTESTED),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected" && r.reason instanceof AccountAlreadyClaimed).length, 1);
    const { rows } = await admin.query(`SELECT tenant FROM ${schema}.agent_account WHERE smart_account = $1`, [CONTESTED]);
    assert.equal(rows.length, 1);

    const anotherDid = { did: "did:privy:identity-queue-race", provider: "twitter" as const, subject: "identity-queue-race" };
    const didClaims = await Promise.all([
      contenderA.resolveOrClaimDid(C, anotherDid),
      contenderB.resolveOrClaimDid(D, anotherDid),
    ]);
    assert.ok(didClaims.every((claim) => claim.ok));
    assert.equal(didClaims[0]!.ok && didClaims[0]!.tenant, didClaims[1]!.ok && didClaims[1]!.tenant);
    const didRows = await admin.query(`SELECT tenant FROM ${schema}.agent_identity WHERE privy_did = $1`, [anotherDid.did]);
    assert.equal(didRows.rows.length, 1, "a verified DID must resolve to one tenant across instances");
  } finally {
    await Promise.all(opened.map((c) => c.end().catch(() => {})));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
