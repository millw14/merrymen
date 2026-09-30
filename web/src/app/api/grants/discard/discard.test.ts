/**
 * START OVER, ON THE SERVER: THE KILL FIRST AND UNCONDITIONALLY, THE RESET
 * FROM THE GRANT IT KILLED.
 *
 * lib/start-over.ts says why the ordering moved here from the browser. This
 * drives it: startOver with stand-ins, where each step is recorded and each
 * can fail or hang, and then POST /api/grants/discard itself, self-hosted over real
 * files (the grant archived and removed, the reset queued as a command file the
 * worker drains) and hosted over the file grant store with a real session.
 * Hosted, the reset is a Postgres row and there is no Postgres here, so that
 * half is driven as the one thing that must hold when the ledger cannot be
 * reached: the kill still happens, and the answer says the reset did not.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { StoredGrant } from "@merrymen/core";
import { startOver, type StartOverDeps } from "@/lib/start-over";

describe("startOver: the ordering", () => {
  const recorded = (over: Partial<StartOverDeps> = {}) => {
    const steps: string[] = [];
    const deps: StartOverDeps = {
      account: async () => (steps.push("read"), "0xacc"),
      remove: async () => void steps.push("remove"),
      queueReset: async (a) => (steps.push(`queue ${a}`), true),
      ...over,
    };
    return { steps, deps };
  };

  it("READ THE ACCOUNT, REMOVE THE GRANT, THEN QUEUE THE RESET FOR THE ACCOUNT READ", async () => {
    const { steps, deps } = recorded();
    assert.equal(await startOver(deps), "queued");
    assert.deepEqual(steps, ["read", "remove", "queue 0xacc"]);
  });

  it("THE KILL WAITS FOR NO RESET: A QUEUE THAT NEVER ANSWERS COMES AFTER THE GRANT IS GONE", async () => {
    const steps: string[] = [];
    let queued: () => void = () => {};
    const out = startOver({
      account: async () => "0xacc",
      remove: async () => void steps.push("remove"),
      queueReset: () => (steps.push("queue"), new Promise<boolean>((r) => (queued = () => r(true)))),
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(steps, ["remove", "queue"], "removed before the reset was even asked for");
    queued();
    assert.equal(await out, "queued");
  });

  it("A RESET THAT CANNOT BE READ, QUEUED OR REACHED IS REPORTED, AND THE GRANT IS STILL REMOVED", async () => {
    for (const [over, want] of [
      [{ account: async () => Promise.reject(new Error("store down")) }, "no-agent"],
      [{ account: async () => null }, "no-agent"],
      [{ queueReset: async () => false }, "failed"],
      [{ queueReset: async () => Promise.reject(new Error("ledger down")) }, "failed"],
    ] as const) {
      const { steps, deps } = recorded(over as Partial<StartOverDeps>);
      assert.equal(await startOver(deps), want);
      assert.ok(steps.includes("remove"), `${want}: the kill happened`);
    }
  });

  it("A KILL THAT FAILS IS THE REQUEST'S FAILURE, AND NOTHING IS QUEUED BEHIND IT", async () => {
    const { steps, deps } = recorded({ remove: async () => Promise.reject(new Error("grant store down")) });
    await assert.rejects(startOver(deps), /grant store down/);
    assert.deepEqual(steps, ["read"], "a reset for a grant that is still armed would be half a Start over");
  });
});

describe("POST /api/grants/discard", () => {
  const ACCOUNT = "0x00000000000000000000000000000000000000c7";
  const saved = Object.fromEntries(
    ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"].map((k) => [k, process.env[k]]),
  );
  let home: string;
  let POST: (req: Request) => Promise<Response>;
  let DELETE: (req: Request) => Promise<Response>;
  let auth: typeof import("@/lib/auth");
  let grants: typeof import("../../../../../../worker/src/grant-store");
  let commandDir: (home: string) => string;

  const grant = (): StoredGrant =>
    ({
      smartAccount: ACCOUNT,
      owner: "0x00000000000000000000000000000000000000b7",
      sessionKeyAddress: "0x00000000000000000000000000000000000000d7",
      serialized: "eyJ-a-zerodev-blob-start-over",
      chainId: 4663,
      grantedAt: Math.floor(Date.now() / 1000) - 3600,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
      caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
      demoSessionPrivateKey: "0x" + "cd".repeat(32),
    }) as unknown as StoredGrant;
  const commands = (): { kind?: string }[] => {
    try {
      return readdirSync(commandDir(home))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(path.join(commandDir(home), f), "utf8")) as { kind?: string });
    } catch {
      return [];
    }
  };

  before(async () => {
    home = mkdtempSync(path.join(tmpdir(), "mm-start-over-"));
    process.env.MERRYMEN_HOME = home;
    process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
    process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
    delete process.env.DATABASE_URL;
    delete process.env.MERRYMEN_HOSTED;
    auth = await import("@/lib/auth");
    // THROUGH require, as owner-facing.test.ts explains: the route reaches the
    // worker's modules that way, and a second ESM instance is one it never uses.
    const req = createRequire(import.meta.url);
    grants = req("../../../../../../worker/src/grant-store.ts") as typeof grants;
    ({ commandDir } = req("../../../../../../worker/src/command-files.ts") as { commandDir: (home: string) => string });
    ({ POST } = await import("./route"));
    ({ DELETE } = await import("../route"));
  });
  beforeEach(() => {
    delete process.env.MERRYMEN_HOSTED;
    rmSync(commandDir(home), { recursive: true, force: true });
    rmSync(path.join(home, "grant.json"), { force: true });
  });
  after(() => {
    mock.restoreAll();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("SELF-HOSTED: THE GRANT ARCHIVED AND GONE, AND THE RESET QUEUED FOR THE WORKER", async () => {
    writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant()));
    const res = await POST(new Request("http://localhost/api/grants/discard", { method: "POST" }));
    assert.deepEqual(await res.json(), { ok: true, paperReset: "queued" });
    assert.ok(!existsSync(path.join(home, "grant.json")), "the kill switch did its job");
    assert.ok(existsSync(path.join(home, "grants", `${ACCOUNT}.json`)), "and archived first, so the owner key survives");
    assert.deepEqual(commands().map((c) => c.kind), ["paper-reset"], "one reset, for the worker to drain");
  });

  it("SELF-HOSTED WITH NO AGENT: NOTHING TO QUEUE FOR; AND THE BARE KILL SWITCH STILL QUEUES NOTHING", async () => {
    const none = await POST(new Request("http://localhost/api/grants/discard", { method: "POST" }));
    assert.deepEqual(await none.json(), { ok: true, paperReset: "no-agent" });
    writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant()));
    const bare = await DELETE(new Request("http://localhost/api/grants", { method: "DELETE" }));
    assert.deepEqual(await bare.json(), { ok: true });
    assert.ok(!existsSync(path.join(home, "grant.json")), "removed the same way");
    assert.ok(existsSync(path.join(home, "grants", `${ACCOUNT}.json`)), "archived the same way");
    assert.deepEqual(commands(), []);
  });

  it("SELF-HOSTED: AN ARCHIVE FAILURE KEEPS THE KEY, PAUSES, AND QUEUES NO RESET", async () => {
    const live = JSON.stringify(grant());
    const archive = path.join(home, "grants");
    writeFileSync(path.join(home, "grant.json"), live);
    rmSync(archive, { recursive: true, force: true });
    writeFileSync(archive, "not a directory");
    try {
      const res = await POST(new Request("http://localhost/api/grants/discard", { method: "POST" }));
      assert.equal(res.status, 409);
      const result = await res.json() as { error: string; paused: boolean };
      assert.match(result.error, /The grant was NOT deleted/);
      assert.equal(result.paused, true);
      assert.equal(readFileSync(path.join(home, "grant.json"), "utf8"), live);
      assert.ok(existsSync(path.join(home, "paused")));
      assert.deepEqual(commands(), [], "a grant still armed cannot have half a Start over");
    } finally {
      rmSync(archive, { force: true });
      rmSync(path.join(home, "paused"), { force: true });
    }
  });

  it("HOSTED: THE ACCOUNT IS READ FROM THE GRANT, THE GRANT REMOVED, AND A LEDGER OUT OF REACH COSTS ONLY THE RESET", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    grants.resetGrantStoreForTest();
    const store = grants.getGrantStore();
    const wallet = "0x00000000000000000000000000000000000000e7" as const;
    await store.put(wallet, grant());
    const steps: string[] = [];
    const get = store.get.bind(store);
    const remove = store.remove.bind(store);
    const g = mock.method(store, "get", async (t: `0x${string}`) => (steps.push("get"), get(t)));
    const r = mock.method(store, "remove", async (t: `0x${string}`) => (steps.push("remove"), remove(t)));
    try {
      const res = await POST(
        new Request("https://app.merrymen.dev/api/grants/discard", {
          method: "POST",
          headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(wallet)}` },
        }),
      );
      // No Postgres here, so no row: said, and not thrown.
      assert.deepEqual(await res.json(), { ok: true, paperReset: "failed" });
      assert.deepEqual(steps, ["get", "remove"], "the account read while the grant was there, then the kill");
      assert.equal(await get(wallet), null, "the grant is gone");
      assert.deepEqual(commands(), [], "hosted never writes a command file into this service's home");
    } finally {
      g.mock.restore();
      r.mock.restore();
    }
  });

  it("HOSTED, NOT SIGNED IN: REFUSED, AND NOBODY'S GRANT IS TOUCHED", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    grants.resetGrantStoreForTest();
    const wallet = "0x00000000000000000000000000000000000000e8" as const;
    await grants.getGrantStore().put(wallet, grant());
    const res = await POST(new Request("https://app.merrymen.dev/api/grants/discard", { method: "POST" }));
    assert.equal(res.status, 401);
    assert.ok(await grants.getGrantStore().get(wallet), "still stored");
  });
});
