/**
 * The Solana worker as it runs (runSolanaAgent), with its own database file and env: the live
 * rollout digest its first tick publishes is the worker's, never the web's. Built as the web's
 * runtime, it would write over the web's row and read a worker row nobody writes, so neither
 * service would see the other run different settings (SETTINGS THAT MUST MATCH, CHECKED).
 * No network: there is no binding to trade, and nothing reads a provider.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runSolanaAgent } from "./solana-agent";
import { solanaLiveRolloutFingerprint } from "./solana-live-rollout";
import { solanaRuntimeDbFile } from "./solana-runtime-db";

test("runSolanaAgent publishes its live rollout settings as the worker's, under the settings it runs", async t => {
  const home = mkdtempSync(path.join(tmpdir(), "solana-agent-run-"));
  const saved = { ...process.env };
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(home, { recursive: true, force: true });
  });
  // A self-hosted worker on its own SQLite file; the market is built but never asked.
  delete process.env.DATABASE_URL; delete process.env.MERRYMEN_HOSTED;
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SOLANA_RPC_MAINNET = "https://rpc.solana-agent-run.invalid/";
  process.env.MERRYMEN_SOLANA_LIVE_TENANTS = `0x${"ab".repeat(20)}`;
  process.env.MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG = "20";
  const controller = new AbortController();
  const running = runSolanaAgent(controller.signal);
  let rows: Array<{ service: string; fingerprint: string }> = [];
  try {
    // Up to 30 s for its first tick under a loaded test run; usually well under a second.
    for (let i = 0; i < 1200 && !rows.length; i++) {
      await delay(25);
      try {
        const db = new DatabaseSync(solanaRuntimeDbFile(), { readOnly: true });
        try { rows = db.prepare("SELECT service,fingerprint FROM solana_runtime_live_rollout_seen ORDER BY service").all() as typeof rows; }
        finally { db.close(); }
      } catch { /* Not created yet. */ }
    }
  } finally { controller.abort(); await running; }
  assert.deepEqual(rows.map(row => ({ ...row })), [{ service: "worker", fingerprint: solanaLiveRolloutFingerprint(process.env) }]);
});
