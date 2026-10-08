import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { it } from "node:test";
import { LocalWorkers, localWorkerEnv } from "./local-workers";
import { acquireLocalWorkerLease } from "./local-worker-lease";

it("a wallet lifetime lock refuses overlap until the previous worker has released its kernel lock", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mm-local-worker-lease-"));
  let a: (() => void) | undefined, b: (() => void) | undefined;
  try {
    a = acquireLocalWorkerLease(home);
    assert.throws(() => acquireLocalWorkerLease(home), /already has a running worker/);
    b = acquireLocalWorkerLease(path.join(home, "accounts", "perps"));
    a(); a = acquireLocalWorkerLease(home);
    assert.throws(() => acquireLocalWorkerLease(path.join(home, "accounts", "perps")), /already has a running worker/);
  } finally { a?.(); b?.(); rmSync(home, { recursive: true, force: true }); }
});

it("a Perps wallet created after startup gets a separate process and cannot inherit Spot file overrides or credentials", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mm-local-workers-"));
  const perpsHome = path.join(home, "accounts", "perps");
  const launched: { child: EventEmitter; env: NodeJS.ProcessEnv; killed: string[] }[] = [];
  let now = 0;
  const manager = new LocalWorkers({ home, now: () => now, log: () => {},
    env: { MERRYMEN_GRANT_FILE: "/spot/secret", MERRYMEN_SETTINGS_FILE: "/spot/settings", MERRYMEN_TELEGRAM_BOT_TOKEN: "spot-bot", MERRYMEN_RECOVER_OWNER_KEY: "owner-secret", DATABASE_URL: "spot-ledger" },
    spawn: ((_cmd, _args, opts) => {
      const child = new EventEmitter(), killed: string[] = [];
      Object.assign(child, { kill: (signal: string) => { killed.push(signal); return true; } });
      launched.push({ child, env: opts!.env!, killed });
      return child as ChildProcess;
    }) as typeof spawn,
  });
  try {
    manager.reconcile(); manager.reconcile(); assert.equal(launched.length, 1);
    mkdirSync(perpsHome, { recursive: true });
    writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify({ purpose: "perps", smartAccount: `0x${"22".repeat(20)}` }));
    manager.reconcile(); manager.reconcile(); assert.equal(launched.length, 2);
    const perps = launched[1]!;
    assert.equal(perps.env.MERRYMEN_HOME, perpsHome);
    assert.equal(perps.env.MERRYMEN_GRANT_FILE, path.join(perpsHome, "grant.json"));
    assert.equal(perps.env.MERRYMEN_SETTINGS_FILE, path.join(perpsHome, "settings.json"));
    assert.equal(perps.env.MERRYMEN_WALLET_PURPOSE, "perps");
    assert.equal(perps.env.MERRYMEN_TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(perps.env.MERRYMEN_RECOVER_OWNER_KEY, undefined);
    assert.equal(perps.env.DATABASE_URL, undefined);
    // Revocation is consumed by the worker's protective loop, not an abrupt
    // supervisor kill before it could read a stand-down request.
    unlinkSync(path.join(perpsHome, "grant.json")); manager.reconcile();
    assert.deepEqual(perps.killed, []);
    perps.child.emit("close", 1); manager.reconcile(); assert.equal(launched.length, 2);
    now = 2_001; manager.reconcile(); assert.equal(launched.length, 3);
    assert.equal(launched[2]!.env.MERRYMEN_HOME, perpsHome);
    assert.deepEqual(launched[0]!.killed, [], "Perps restart never restarts Spot");
    manager.stop(); manager.reconcile(); assert.equal(launched.length, 3);
    assert.deepEqual(launched[0]!.killed, ["SIGTERM"]); assert.deepEqual(launched[2]!.killed, ["SIGTERM"]);
  } finally { manager.stop(); rmSync(home, { recursive: true, force: true }); }
});

it("a legacy or duplicate Spot account cannot be started in the Perps slot", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mm-local-workers-refuse-"));
  const perpsHome = path.join(home, "accounts", "perps"); mkdirSync(perpsHome, { recursive: true });
  let count = 0;
  const manager = new LocalWorkers({ home, log: () => {}, spawn: (() => { count++; return Object.assign(new EventEmitter(), { kill() {} }) as unknown as ChildProcess; }) as typeof spawn });
  try {
    const account = `0x${"11".repeat(20)}`;
    writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: account }));
    writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify({ smartAccount: account }));
    manager.reconcile(); assert.equal(count, 1);
    writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify({ purpose: "perps", smartAccount: account }));
    manager.reconcile(); assert.equal(count, 1);
  } finally { manager.stop(); rmSync(home, { recursive: true, force: true }); }
});

it("the local supervisor preserves explicit Spot connection settings while isolating the Perps home", () => {
  const env = localWorkerEnv("/home/test", "spot", { MERRYMEN_RPC_MAINNET: "http://test-rpc", MERRYMEN_RECOVER_OWNER_KEY: "never" });
  assert.equal(env.MERRYMEN_RPC_MAINNET, "http://test-rpc");
  assert.equal(env.MERRYMEN_HOME, "/home/test"); assert.equal(env.MERRYMEN_RECOVER_OWNER_KEY, undefined);
});
