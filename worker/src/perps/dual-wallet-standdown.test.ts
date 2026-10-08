import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { spawn } from "node:child_process";
import { wrapSqlite } from "../db";
import { applyLedgerSchema } from "../store";
import { workerExecutionKey } from "../worker-execution";
import { sealPerpKey } from "./key-seal";
import { HostedStanddownSupervisor } from "./hosted-standdown";
import { HostedStanddownStore, revokeHostedGrant } from "./hosted-standdown-store";

test("Perps shutdown acquires, stops and erases only its own worker slot for the shared login", async () => {
  const owner = "0x00000000000000000000000000000000000000a1" as const;
  const account = "0x00000000000000000000000000000000000000b1" as const;
  const key = workerExecutionKey(owner, "perps");
  const dek = Buffer.alloc(32, 5);
  const pub = `0x${("01" + "00".repeat(7)).repeat(5)}` as `0x${string}`;
  const privateKey = `0x${"ab".repeat(40)}` as `0x${string}`;
  const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-dual-shutdown-"));
  const normalHome = (execution: string) => path.join(home, "children", execution);
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
  const acquired: string[] = [], stopped: string[] = [], health: string[] = [];
  let attempts = 0;
  const supervisor = new HostedStanddownSupervisor({ db, dek, home, normalHome,
    executionKey: job => workerExecutionKey(job.tenant, job.purpose ?? "spot"),
    acquire: async execution => { acquired.push(execution); return execution === key; },
    healthy: execution => { health.push(execution); return execution === key; },
    stopNormal: async execution => { stopped.push(execution); return execution === key; },
    log: () => {},
    spawnRunner: (() => { attempts++; throw new Error("inert test spawn"); }) as unknown as typeof spawn,
  });
  try {
    await applyLedgerSchema(db);
    await db.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE perps_grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const store = new HostedStanddownStore(db, dek); await store.init();
    const grant = { purpose: "perps", smartAccount: account, chainId: 4663, expiresAt: Math.floor(Date.now() / 1000) + 100,
      grantFeatures: ["perp-lighter-v1"], perp: { route: "perp-lighter-v1", apiPublicKey: pub, apiKeyIndex: 16,
        apiKeySealed: sealPerpKey(privateKey, { tenant: owner, smartAccount: account, apiPublicKey: pub, apiKeyIndex: 16 }, dek) } };
    await db.prepare("INSERT INTO perps_grants VALUES (?, ?, ?)").run(owner, JSON.stringify(grant), 1);
    await db.prepare("INSERT INTO grants VALUES (?, ?, ?)").run(owner, JSON.stringify({ smartAccount: owner }), 1);
    for (const execution of [owner, key]) {
      mkdirSync(normalHome(execution), { recursive: true });
      writeFileSync(path.join(normalHome(execution), "grant.json"), `session:${execution}`);
      writeFileSync(path.join(normalHome(execution), "perp-key.json"), `venue:${execution}`);
    }
    await revokeHostedGrant(db, owner, dek, { purpose: "perps" });
    assert.ok(await db.prepare("SELECT tenant FROM grants WHERE tenant = ?").get(owner));
    const blocked = await supervisor.reconcile();
    assert.deepEqual([...blocked], [key]);
    assert.deepEqual(acquired, [key]);
    assert.deepEqual(stopped, [key]);
    assert.ok(health.every(execution => execution === key));
    assert.equal(attempts, 1, "the true owner still authenticates the sealed Perps key");
    assert.equal(existsSync(path.join(normalHome(key), "grant.json")), false);
    assert.equal(existsSync(path.join(normalHome(key), "perp-key.json")), false);
    assert.equal(readFileSync(path.join(normalHome(owner), "grant.json"), "utf8"), `session:${owner}`);
    assert.equal(readFileSync(path.join(normalHome(owner), "perp-key.json"), "utf8"), `venue:${owner}`);
  } finally { supervisor.stopAll(); raw.close(); rmSync(home, { recursive: true, force: true }); }
});
