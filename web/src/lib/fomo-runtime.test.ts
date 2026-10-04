/**
 * THE WEB'S FOMO RUNTIME: where its key, plan, permissions, tenant and store
 * come from, and that one runtime is kept per process — and forgotten when
 * building it failed, so the next question tries again. Offline: no key is
 * set, the hosted store is an in-memory SQLite behind the MCP seam, and the
 * self-hosted store is fomo.sqlite in a temporary MERRYMEN_HOME.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, describe, it } from "node:test";
import type { StoredGrant } from "@merrymen/core";
import { wrapSqlite } from "../../../worker/src/db";
import { closeLocalFomoDbsForTest, LOCAL_FOMO_DB_FILE } from "../../../worker/src/fomo/local-db";
import { getGrantStore, resetGrantStoreForTest } from "../../../worker/src/grant-store";
import { setMcpDbForTest } from "../mcp/db";
import {
  createWebFomoRuntime,
  FOMO_MODEL_BUDGET,
  fomoPlanCredits,
  fomoRuntime,
  fomoTenantFor,
  grantStoreOwnerReader,
  hostedFomoAccess,
  hostedFomoApiKey,
  hostedFomoOwner,
  selfHostedFomoAccess,
  setFomoOwnerReaderForTest,
  setFomoRuntimeForTest,
} from "./fomo-runtime";
import { projectSettings, setSettingsReaderForTest } from "./services/settings-view";

const A = `0x${"a".repeat(40)}` as const;
const B = `0x${"b".repeat(40)}` as const;
const ENV_KEYS = [
  "MERRYMEN_HOSTED", "MERRYMEN_HOME", "DATABASE_URL", "MERRYMEN_FOMO_API_KEY", "FOMO_API_KEY", "MERRYMEN_FOMO_ENABLED",
  "MERRYMEN_FOMO_PLAN_CREDITS", "MERRYMEN_FOMO_DATA_ACCESS", "MERRYMEN_SETTINGS_FILE", "MERRYMEN_STORE_DEK",
] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-fomo-runtime-"));

before(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MERRYMEN_HOME = home;
});

afterEach(() => {
  setFomoRuntimeForTest(null);
  setMcpDbForTest(null);
  setSettingsReaderForTest(null);
  setFomoOwnerReaderForTest(null);
  resetGrantStoreForTest();
  delete process.env.MERRYMEN_FOMO_DATA_ACCESS;
});

/** Owners with an agent, for the hosted permission tests: A and B unless a test says otherwise. */
const owners = (...ts: string[]) => setFomoOwnerReaderForTest({ async hasAgent(t) { return ts.includes(t); } });

after(() => {
  closeLocalFomoDbsForTest();
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("the key, the plan and the switch", () => {
  it("reads the house's key name first, then the provider docs' name; a blank value is no key", () => {
    assert.equal(hostedFomoApiKey({ MERRYMEN_FOMO_API_KEY: " house-test ", FOMO_API_KEY: "docs-test" }), "house-test");
    assert.equal(hostedFomoApiKey({ MERRYMEN_FOMO_API_KEY: "   ", FOMO_API_KEY: "docs-test" }), "docs-test");
    assert.equal(hostedFomoApiKey({ FOMO_API_KEY: "  " }), null);
    assert.equal(hostedFomoApiKey({}), null);
  });

  it("MERRYMEN_FOMO_ENABLED=0 turns the web's lookups off too: no key, so every answer is 'not configured'", () => {
    assert.equal(hostedFomoApiKey({ MERRYMEN_FOMO_ENABLED: "0", MERRYMEN_FOMO_API_KEY: "house-test" }), null);
  });

  it("reads the plan exactly as the orchestrator does (they share the allowance counters)", async () => {
    // Loaded by a computed specifier so the web typecheck does not take in the whole orchestrator.
    const orchestrator = "../../../worker/src/orchestrator";
    const { fomoSetup } = (await import(orchestrator)) as { fomoSetup(env: Record<string, string | undefined>): { planCredits: number | undefined } };
    for (const raw of [undefined, "", "lots", "-5", "0", "1000000", " 250000 ", "1e6", "NaN", "Infinity"]) {
      const env = raw === undefined ? {} : { MERRYMEN_FOMO_PLAN_CREDITS: raw };
      assert.equal(fomoPlanCredits(env), fomoSetup({ DATABASE_URL: "postgres://x", ...env }).planCredits, `plan ${JSON.stringify(raw)}`);
    }
    assert.equal(fomoPlanCredits({ MERRYMEN_FOMO_PLAN_CREDITS: "1000000" }), 1_000_000);
  });
});

describe("who the tenant is", () => {
  it("hosted: only a verified session tenant, lowercased; nothing else is one", () => {
    assert.equal(fomoTenantFor(A.toUpperCase().replace("0X", "0x"), true), A);
    for (const bad of [null, undefined, "", "self", "0x123", `${A} `, "tenant-evil"]) assert.equal(fomoTenantFor(bad, true), null, String(bad));
  });

  it("self-hosted: the install's one fixed tenant, whatever is passed", () => {
    assert.equal(fomoTenantFor(null, false), "self");
    assert.equal(fomoTenantFor(A, false), "self");
  });
});

describe("the permissions", () => {
  it("hosted: the owner's sealed settings, with the catalogue defaults for anything never stored", async () => {
    owners(A, B);
    const stored: Record<string, Record<string, unknown> | null> = {
      [A]: null,
      [B]: { fomoDataAccess: false, fomoMonitoringEnabled: true },
    };
    setSettingsReaderForTest({ async settingsFor(t) { return projectSettings(stored[t.toLowerCase()] ?? null); } });
    assert.deepEqual(await hostedFomoAccess(A), { dataAccess: true, monitoring: false, follow: false });
    assert.deepEqual(await hostedFomoAccess(B.toUpperCase().replace("0X", "0x")), { dataAccess: false, monitoring: true, follow: false });
  });

  it("hosted: something that is not a tenant has no access, and an unreadable store is not a default", async () => {
    owners(A);
    setSettingsReaderForTest({ async settingsFor() { throw new Error("store down"); } });
    assert.deepEqual(await hostedFomoAccess("self"), { dataAccess: false, monitoring: false, follow: false });
    await assert.rejects(hostedFomoAccess(A), /store down/, "the service turns a failed permission read into not-authorized");
  });

  it("hosted: a signed-in wallet with NO AGENT has no access at all, whatever its settings say", async () => {
    // Sign-in is open: without this, every fresh wallet was a Fomo tenant with
    // caps of its own, all spending the one shared credit pool.
    owners(A);
    let settingsRead = 0;
    setSettingsReaderForTest({ async settingsFor() { settingsRead++; return projectSettings({ fomoDataAccess: true }); } });
    assert.deepEqual(await hostedFomoAccess(B), { dataAccess: false, monitoring: false, follow: false });
    assert.equal(settingsRead, 0, "no settings read for a wallet that owns no agent");
    assert.equal((await hostedFomoAccess(A)).dataAccess, true, "an owner with an agent keeps the default");
  });

  it("hosted: an unreadable grant store is neither 'owner' nor 'not an owner' — it throws", async () => {
    setFomoOwnerReaderForTest({ async hasAgent() { throw new Error("grants down"); } });
    setSettingsReaderForTest({ async settingsFor() { return projectSettings(null); } });
    await assert.rejects(hostedFomoAccess(A), /grants down/, "the service turns a failed permission read into not-authorized");
    await assert.rejects(hostedFomoOwner(A), /grants down/);
    assert.equal(await hostedFomoOwner("self"), false, "not a tenant is never an owner");
  });

  it("hosted, against the real grant store: a grant with a smart account is an agent; none is not", async () => {
    delete process.env.MERRYMEN_STORE_DEK;
    resetGrantStoreForTest();
    const grant = {
      smartAccount: `0x${"5".repeat(40)}`,
      owner: "0x0000000000000000000000000000000000000fee",
      sessionKeyAddress: "0x0000000000000000000000000000000000000abc",
      serialized: "not-a-permission-account",
      caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 },
      grantedAt: 1,
      expiresAt: 4_000_000_000,
      chainId: 4663,
      demoSessionPrivateKey: `0x${"1".repeat(64)}`,
    } as unknown as StoredGrant;
    await getGrantStore().put(A, grant);
    assert.equal(await grantStoreOwnerReader.hasAgent(A), true);
    assert.equal(await grantStoreOwnerReader.hasAgent(B), false);
    // And through the access reader every web surface uses, with the production reader in place.
    setSettingsReaderForTest({ async settingsFor() { return projectSettings(null); } });
    assert.equal((await hostedFomoAccess(A.toUpperCase().replace("0X", "0x"))).dataAccess, true);
    assert.equal((await hostedFomoAccess(B)).dataAccess, false);
  });

  it("self-hosted: the install's own config, and only for the install's tenant", async () => {
    assert.equal((await selfHostedFomoAccess("self")).dataAccess, true);
    process.env.MERRYMEN_FOMO_DATA_ACCESS = "0";
    assert.equal((await selfHostedFomoAccess("self")).dataAccess, false);
    assert.deepEqual(await selfHostedFomoAccess(A), { dataAccess: false, monitoring: false, follow: false });
  });
});

describe("one runtime per process", () => {
  it("self-hosted: built once on fomo.sqlite in MERRYMEN_HOME; without a key it is honestly not configured", async () => {
    const first = fomoRuntime(false);
    const second = fomoRuntime(false);
    assert.equal(first, second, "the same promise, not a second build");
    const rt = await first;
    assert.equal(rt, await fomoRuntime(false));
    assert.ok(existsSync(path.join(home, LOCAL_FOMO_DB_FILE)), "the file the local worker opens too");
    assert.equal(rt.service.configured(), false);
    assert.equal(rt.client, null);
    const health = await rt.service.health(Date.now());
    assert.equal(health.state, "not-configured");
  });

  it("hosted: a failed build is forgotten, and the next caller builds again", async () => {
    const failed = fomoRuntime(true);
    await assert.rejects(failed, /DATABASE_URL/);
    // The shared database becomes reachable (here: the MCP test seam).
    const raw = new DatabaseSync(":memory:");
    setMcpDbForTest({ db: wrapSqlite(raw), dialect: "sqlite" });
    const again = fomoRuntime(true);
    assert.notEqual(again, failed, "not the rejected promise again");
    const rt = await again;
    assert.equal(rt.service.configured(), false, "no key in this environment");
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fomo_%'").all() as { name: string }[];
    assert.ok(tables.some((t) => t.name === "fomo_meta"), "the schema is ensured before use");
  });

  it("carries a per-tenant model budget on the durable fomo_meta counters, shared by every runtime on the store", async () => {
    const raw = new DatabaseSync(":memory:");
    const now = Date.UTC(2026, 9, 4, 12);
    const first = await createWebFomoRuntime({ hosted: true, db: wrapSqlite(raw), dialect: "sqlite", apiKey: null, now: () => now, log: () => {} });
    assert.deepEqual({ ...first.modelBudget.config }, { ...FOMO_MODEL_BUDGET });
    for (let i = 0; i < FOMO_MODEL_BUDGET.callsPerDay; i++) {
      assert.equal((await first.modelBudget.tryStart({ tenant: A, estimatedTokens: 10, now })).ok, true, `call ${i + 1}`);
    }
    // A second web replica (or a restart) over the same store sees the same day's spend.
    const second = await createWebFomoRuntime({ hosted: true, db: wrapSqlite(raw), dialect: "sqlite", apiKey: null, now: () => now, log: () => {} });
    assert.deepEqual(await second.modelBudget.tryStart({ tenant: A, estimatedTokens: 10, now }), { ok: false, reason: "model-calls-daily" });
    assert.equal((await second.modelBudget.tryStart({ tenant: B, estimatedTokens: 10, now })).ok, true, "per tenant: B has its own allowance");
    assert.equal((await second.modelBudget.tryStart({ tenant: A, estimatedTokens: 10, now: now + 86_400_000 })).ok, true, "a new UTC day");
  });

  it("the test seam serves an injected runtime and, cleared, goes back to building", async () => {
    const fake = { service: { configured: () => true } } as never;
    setFomoRuntimeForTest(fake);
    assert.equal(await fomoRuntime(true), fake);
    assert.equal(await fomoRuntime(false), fake);
    setFomoRuntimeForTest(null);
    assert.notEqual(await fomoRuntime(false), fake);
  });
});
