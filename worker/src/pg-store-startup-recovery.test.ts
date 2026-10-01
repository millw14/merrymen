import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { PgGrantStore } = await import("./grant-store");
const { PgIdentityStore } = await import("./identity-store");

const TENANT = "0x00000000000000000000000000000000000000a1" as const;
const tooManyClients = () => Object.assign(new Error("sorry, too many clients already"), { code: "53300" });

describe("hosted stores recover from a refused startup", () => {
  it("grant reads fail closed, then retry the next independent connection attempt", async () => {
    let attempts = 0;
    const store = new PgGrantStore("postgres://stand-in", async () => {
      attempts += 1;
      if (attempts === 1) throw tooManyClients();
      return {
        async query(sql: string) {
          return { rows: sql.includes("SELECT tenant FROM grants") ? [{ tenant: TENANT }] : [] };
        },
      };
    });

    // The web must never turn a database refusal into a false "no agent".
    await assert.rejects(store.get(TENANT), (e: unknown) => (e as { code?: string }).code === "53300");
    assert.deepEqual(await store.listTenants(), [TENANT]);
    assert.equal(attempts, 2);
    assert.deepEqual(await store.listTenants(), [TENANT]);
    assert.equal(attempts, 2, "a healthy connection remains shared");
  });

  it("concurrent first callers share one failed grant connection", async () => {
    let attempts = 0;
    const store = new PgGrantStore("postgres://stand-in", async () => {
      attempts += 1;
      throw tooManyClients();
    });
    const results = await Promise.allSettled([store.get(TENANT), store.listTenants()]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
    assert.equal(attempts, 1);
  });

  it("a failed grant table setup closes its connection before retrying", async () => {
    let opened = 0;
    let closed = 0;
    const store = new PgGrantStore("postgres://stand-in", async () => {
      opened += 1;
      const fail = opened <= 2;
      return {
        async query(sql: string) {
          if (fail && sql.includes("CREATE TABLE IF NOT EXISTS grants")) throw tooManyClients();
          return { rows: [] };
        },
        async end() { closed += 1; },
      };
    });
    await assert.rejects(store.listTenants(), /too many clients/);
    await assert.rejects(store.listTenants(), /too many clients/);
    assert.equal(closed, 2);
    assert.deepEqual(await store.listTenants(), []);
    assert.equal(opened, 3);
    assert.equal(closed, 2, "the successful connection remains open");
  });

  it("a grant connection lost after setup is replaced for the next read", async () => {
    let attempts = 0;
    const socket: { error: (() => void) | null } = { error: null };
    const store = new PgGrantStore("postgres://stand-in", async () => {
      attempts += 1;
      return {
        async query() { return { rows: [] }; },
        on(event: "error" | "end", cb: () => void) {
          if (event === "error") socket.error = cb;
        },
        async end() {},
      };
    });
    assert.deepEqual(await store.listTenants(), []);
    assert.equal(attempts, 1);
    assert.ok(socket.error);
    socket.error();
    assert.deepEqual(await store.listTenants(), []);
    assert.equal(attempts, 2);
  });

  it("identity reads retry after an initial connection refusal", async () => {
    let attempts = 0;
    const store = new PgIdentityStore("postgres://stand-in", async () => {
      attempts += 1;
      if (attempts === 1) throw tooManyClients();
      return { async query() { return { rows: [] }; } };
    });
    await assert.rejects(store.get(TENANT), (e: unknown) => (e as { code?: string }).code === "53300");
    assert.equal(await store.get(TENANT), null);
    assert.equal(attempts, 2);
  });

  it("identity schema failure closes its client and retries without a false claim", async () => {
    let opened = 0;
    let closed = 0;
    const store = new PgIdentityStore("postgres://stand-in", async () => {
      opened += 1;
      const fail = opened === 1;
      return {
        async query(sql: string) {
          if (fail && sql.includes("CREATE TABLE IF NOT EXISTS agent_identity")) throw tooManyClients();
          return { rows: [] };
        },
        async end() { closed += 1; },
      };
    });
    await assert.rejects(store.get(TENANT), /too many clients/);
    assert.equal(closed, 1);
    assert.equal(await store.get(TENANT), null);
    assert.equal(opened, 2);
  });

  it("identity backfill refuses an unreadable grants table instead of assuming no account claims", async () => {
    let attempts = 0;
    let closed = 0;
    const store = new PgIdentityStore("postgres://stand-in", async () => {
      attempts += 1;
      const fail = attempts === 1;
      return {
        async query(sql: string) {
          if (fail && sql.includes("FROM grants")) throw tooManyClients();
          return { rows: [] };
        },
        async end() { closed += 1; },
      };
    });
    await assert.rejects(store.get(TENANT), (e: unknown) => (e as { code?: string }).code === "53300");
    assert.equal(closed, 1);
    assert.equal(await store.get(TENANT), null);
    assert.equal(attempts, 2);
  });
});
