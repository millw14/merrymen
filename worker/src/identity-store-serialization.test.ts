import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountAlreadyClaimed, PgIdentityStore, type SocialIdentity } from "./identity-store";

const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000c3" as const;
const SLUG = "0123456789abcdef";
const SOCIAL: SocialIdentity = { did: "did:privy:one", provider: "twitter", subject: "subject-one" };
const empty = () => ({ rows: [] as Record<string, unknown>[] });
const row = (tenant: string, did: string | null = null) => ({
  tenant, slug: SLUG, accounts: [ACCOUNT], privy_did: did, provider: did ? "twitter" : null,
  subject: did ? "subject-one" : null, handle: null, display_name: null,
  avatar_url: null, created_at: 1, updated_at: 1,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("the hosted identity store's one-client operation queue", () => {
  it("keeps every public read and write outside another request's transaction", async () => {
    const entered = deferred();
    const proceed = deferred();
    const queries: string[] = [];
    const identities = new Map<string, ReturnType<typeof row>>();
    const claims = new Map<string, string>();
    let blockBegin = false;
    const client = {
      async query(sql: string, args: unknown[] = []) {
        const statement = sql.trim();
        queries.push(statement);
        if (statement === "BEGIN" && blockBegin) {
          blockBegin = false;
          entered.resolve();
          await proceed.promise;
        }
        if (statement.startsWith("SELECT tenant, accounts FROM agent_identity") ||
            statement.startsWith("SELECT tenant, grant_json") ||
            statement.startsWith("SELECT smart_account, tenant FROM agent_account")) return empty();
        if (statement.startsWith("INSERT INTO agent_account")) {
          const account = String(args[0]);
          if (!claims.has(account)) claims.set(account, String(args[1]));
          return empty();
        }
        if (statement.startsWith("SELECT tenant FROM agent_account")) {
          const tenant = claims.get(String(args[0]));
          return { rows: tenant ? [{ tenant }] : [] };
        }
        if (statement.startsWith("SELECT * FROM agent_identity WHERE tenant")) {
          const found = identities.get(String(args[0]));
          return { rows: found ? [found] : [] };
        }
        if (statement.startsWith("INSERT INTO agent_identity") && statement.includes("RETURNING *")) {
          const created = row(String(args[0]));
          identities.set(created.tenant, created);
          return { rows: [created] };
        }
        if (statement.startsWith("SELECT * FROM agent_identity WHERE slug")) {
          return { rows: [...identities.values()].filter((v) => v.slug === args[0]) };
        }
        if (statement.startsWith("SELECT * FROM agent_identity WHERE privy_did")) {
          return { rows: [...identities.values()].filter((v) => v.privy_did === args[0]) };
        }
        if (statement === "SELECT * FROM agent_identity") return { rows: [...identities.values()] };
        if (statement.startsWith("UPDATE agent_identity")) return { ...empty(), rowCount: 1 };
        if (statement.startsWith("DELETE FROM agent_identity")) {
          identities.delete(String(args[0]));
          return empty();
        }
        return empty();
      },
    };
    const store = new PgIdentityStore("postgres://stand-in", async () => client);
    await store.get(A); // complete schema/backfill before holding a request open
    queries.length = 0;
    blockBegin = true;
    const writing = store.ensure(A, ACCOUNT);
    await entered.promise;
    const reads = [store.get(A), store.all(), store.bySlug(SLUG), store.byDid(SOCIAL.did)];
    const writes = [store.linkSocial(A, SOCIAL), store.remove(B)];
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(queries, ["BEGIN"], "nothing may enter the shared pg.Client inside ensure's transaction");
    proceed.resolve();
    await writing;
    await Promise.all([...reads, ...writes]);
    const commit = queries.indexOf("COMMIT");
    assert.ok(commit > 0);
    assert.equal(queries.slice(0, commit).filter((q) => q === "BEGIN").length, 1);
    assert.ok(queries.slice(commit + 1).some((q) => q.startsWith("SELECT * FROM agent_identity")));
  });

  it("rechecks the account holder after a slug retry rolls back its first claim", async () => {
    let armed = false;
    let holder: string = A;
    let identityInserts = 0;
    const client = {
      async query(sql: string) {
        const statement = sql.trim();
        if (statement.startsWith("SELECT tenant, accounts FROM agent_identity") ||
            statement.startsWith("SELECT tenant, grant_json") ||
            statement.startsWith("SELECT smart_account, tenant FROM agent_account")) return empty();
        if (statement.startsWith("SELECT tenant FROM agent_account")) return { rows: [{ tenant: holder }] };
        if (statement.startsWith("SELECT * FROM agent_identity WHERE tenant")) return empty();
        if (statement.startsWith("INSERT INTO agent_identity") && statement.includes("RETURNING *")) {
          identityInserts += 1;
          throw Object.assign(new Error("slug collision"), { code: "23505", constraint: "agent_identity_slug_key" });
        }
        if (statement === "ROLLBACK" && armed) holder = B;
        return empty();
      },
    };
    const store = new PgIdentityStore("postgres://stand-in", async () => client);
    await store.get(A);
    armed = true;
    await assert.rejects(store.ensure(A, ACCOUNT), (e: unknown) =>
      e instanceof AccountAlreadyClaimed && e.holder === B);
    assert.equal(identityInserts, 1, "the retry must not create identity A after B claimed its account");
  });

  it("never retries an uncertain identity write or a different unique constraint", async () => {
    for (const failure of [
      new Error("connection lost after identity write"),
      Object.assign(new Error("different unique constraint"), { code: "23505", constraint: "agent_identity_pkey" }),
    ]) {
      let armed = false;
      let begins = 0;
      let identityInserts = 0;
      const client = {
        async query(sql: string) {
          const statement = sql.trim();
          if (statement.startsWith("SELECT tenant, accounts FROM agent_identity") ||
              statement.startsWith("SELECT tenant, grant_json") ||
              statement.startsWith("SELECT smart_account, tenant FROM agent_account")) return empty();
          if (statement === "BEGIN" && armed) begins += 1;
          if (statement.startsWith("SELECT tenant FROM agent_account")) return { rows: [{ tenant: A }] };
          if (statement.startsWith("SELECT * FROM agent_identity WHERE tenant")) return empty();
          if (statement.startsWith("INSERT INTO agent_identity") && statement.includes("RETURNING *")) {
            identityInserts += 1;
            throw failure;
          }
          return empty();
        },
      };
      const store = new PgIdentityStore("postgres://stand-in", async () => client);
      await store.get(A);
      armed = true;
      await assert.rejects(store.ensure(A, ACCOUNT), failure);
      assert.equal(identityInserts, 1, "the identity insert must not be replayed");
      assert.equal(begins, 1, "the claim transaction must not restart");
    }
  });

  it("never retries an identity insert after an ambiguous COMMIT response", async () => {
    let armed = false;
    let identityInserts = 0;
    let commits = 0;
    const client = {
      async query(sql: string, args: unknown[] = []) {
        const statement = sql.trim();
        if (statement.startsWith("SELECT tenant, accounts FROM agent_identity") ||
            statement.startsWith("SELECT tenant, grant_json") ||
            statement.startsWith("SELECT smart_account, tenant FROM agent_account")) return empty();
        if (statement.startsWith("SELECT tenant FROM agent_account")) return { rows: [{ tenant: A }] };
        if (statement.startsWith("SELECT * FROM agent_identity WHERE tenant")) return empty();
        if (statement.startsWith("INSERT INTO agent_identity") && statement.includes("RETURNING *")) {
          identityInserts += 1;
          return { rows: [row(String(args[0]))] };
        }
        if (statement === "COMMIT" && armed) {
          commits += 1;
          throw new Error("COMMIT answer lost");
        }
        return empty();
      },
    };
    const store = new PgIdentityStore("postgres://stand-in", async () => client);
    await store.get(A);
    armed = true;
    await assert.rejects(store.ensure(A, ACCOUNT), /COMMIT answer lost/);
    assert.equal(identityInserts, 1, "an uncertain COMMIT must not replay the insert");
    assert.equal(commits, 1);
  });

  it("reads a unique-constraint winner inside resolveOrClaimDid without reacquiring its own queue", async () => {
    let armed = false;
    let didReads = 0;
    const client = {
      async query(sql: string) {
        const statement = sql.trim();
        if (statement.startsWith("SELECT tenant, accounts FROM agent_identity") ||
            statement.startsWith("SELECT tenant, grant_json") ||
            statement.startsWith("SELECT smart_account, tenant FROM agent_account")) return empty();
        if (statement.startsWith("SELECT tenant FROM agent_identity WHERE privy_did")) return empty();
        if (statement.startsWith("SELECT slug FROM agent_identity WHERE tenant")) return empty();
        if (statement.startsWith("INSERT INTO agent_identity") && armed) {
          throw Object.assign(new Error("DID claimed elsewhere"), { code: "23505" });
        }
        if (statement.startsWith("SELECT * FROM agent_identity WHERE privy_did")) {
          didReads += 1;
          return { rows: [row(B, SOCIAL.did)] };
        }
        return empty();
      },
    };
    const store = new PgIdentityStore("postgres://stand-in", async () => client);
    await store.get(A);
    armed = true;
    const result = await Promise.race([
      store.resolveOrClaimDid(A, SOCIAL),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("identity queue deadlocked")), 1000)),
    ]);
    assert.deepEqual(result, { ok: true, tenant: B, created: false });
    assert.equal(didReads, 1);
  });

  it("retires a session whose transaction cannot roll back before serving another owner", async () => {
    let connects = 0;
    let closed = 0;
    let armed = false;
    const store = new PgIdentityStore("postgres://stand-in", async () => {
      const first = ++connects === 1;
      return {
        async query(sql: string) {
          const statement = sql.trim();
          if (statement.startsWith("SELECT tenant, accounts FROM agent_identity") ||
              statement.startsWith("SELECT tenant, grant_json") ||
              statement.startsWith("SELECT smart_account, tenant FROM agent_account")) return empty();
          if (armed && first && statement.startsWith("INSERT INTO agent_identity")) throw new Error("write failed");
          if (armed && first && statement === "ROLLBACK") throw new Error("rollback failed");
          return empty();
        },
        async end() { closed += 1; },
      };
    });
    await store.get(A);
    armed = true;
    await assert.rejects(store.resolveOrClaimDid(A, SOCIAL), /write failed/);
    assert.equal(closed, 1, "the uncertain transaction's session must be retired");
    assert.equal(await store.get(B), null);
    assert.equal(connects, 2, "the next owner uses a new session");
  });
});
