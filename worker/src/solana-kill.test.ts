/**
 * SELF-HOSTED KILLS STOP THE LOCAL SOLANA STRATEGY (review finalise).
 *
 * Telegram /kill on a self-hosted worker and `merrymen kill` deleted or kept
 * grant.json and nothing else, so the `merrymen solana-agent` worker kept
 * running the owner's autonomous strategy. Both now stop every local strategy
 * first (selfHostedSolanaKill; the CLI through solana-kill-cli.ts), whatever
 * happens to the grant, and say when they could not.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { base58Encode } from "../../packages/core/src/ids";
import { SqlSolanaBindingStore, type SolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite } from "./db";
import { selfHostedSolanaKill } from "./solana-kill";
import { killDoneText } from "./telegram/kill-confirm";

const T = `0x${"22".repeat(20)}` as `0x${string}`;
const OWNER = base58Encode(new Uint8Array(32).fill(20));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3_600_000 };
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 300 };

/** A self-hosted home whose local accounts file holds an enabled strategy. */
async function home(t: TestContext): Promise<{ dir: string; store: SqlSolanaBindingStore; revision: number }> {
  const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, db: process.env.DATABASE_URL };
  const dir = mkdtempSync(path.join(tmpdir(), "solana-kill-home-"));
  process.env.MERRYMEN_HOME = dir; delete process.env.MERRYMEN_HOSTED; delete process.env.DATABASE_URL;
  const raw = new DatabaseSync(path.join(dir, "solana-accounts.sqlite"));
  t.after(() => {
    raw.close();
    for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["DATABASE_URL", saved.db]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new SqlSolanaBindingStore(async () => wrapSqlite(raw), "sqlite");
  await store.bind(T, "did:privy:owner", OWNER);
  await store.settings(T, OWNER, 0, "paper", limits);
  const { revision } = await store.strategy(T, OWNER, 1, strategy);
  return { dir, store, revision };
}

test("the self-hosted Telegram kill's Solana half stops every local strategy, says when there was none, and fails closed", async (t) => {
  const { store, revision } = await home(t);
  assert.equal(await selfHostedSolanaKill(store), "stopped");
  const after = (await store.get(T))!;
  assert.equal(after.strategy?.enabled, false); assert.ok(after.revision > revision);
  assert.equal(await selfHostedSolanaKill(store), null, "nothing left to stop");
  const broken = { strategyTenants: async () => { throw new Error("database is locked"); } } as unknown as SolanaBindingStore;
  assert.equal(await selfHostedSolanaKill(broken), "not-stopped");
});

test("the Telegram answer says whether the Solana strategy stopped, after what happened to the grant", () => {
  assert.match(killDoneText({ ok: true, archived: "0xabc", solana: "stopped" }), /grant destroyed[\s\S]*Your Solana strategy is stopped too\.$/);
  assert.match(killDoneText({ ok: false, reason: "no grant", solana: "stopped" }), /^nothing to kill: no grant\nYour Solana strategy is stopped too\.$/);
  assert.match(killDoneText({ ok: false, reason: "x", archiveFailed: { why: "disk full", paused: true }, solana: "not-stopped" }),
    /grant was NOT destroyed[\s\S]*Kill incomplete: your Solana strategy could not be stopped and may still trade\. \/kill again\.$/);
  assert.doesNotMatch(killDoneText({ ok: true, archived: null }), /Solana/);
});

test("the worker's self-hosted Telegram kill runs the Solana half before it touches the grant", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const start = source.indexOf("    kill: async () => {");
  assert.ok(start > 0, "the Telegram kill dependency");
  const body = source.slice(start, source.indexOf("function robinhoodKill(): KillResult", start));
  assert.match(body, /const solana = isHostedMode\(\) \? null : await selfHostedSolanaKill\(\);[\s\S]*const result = robinhoodKill\(\);/);
});

test("`merrymen kill` stops the local Solana strategy before the grant, and with no grant at all", { timeout: 120_000 }, async (t) => {
  const { dir, store, revision } = await home(t);
  const bin = fileURLToPath(new URL("../../cli/bin.mjs", import.meta.url));
  writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ smartAccount: "0x1111111111111111111111111111111111111111", serialized: "0xserialized", chainId: 4663 }));
  const run = () => spawnSync(process.execPath, [bin, "kill"], { input: "y\n", encoding: "utf8", timeout: 100_000,
    env: { ...process.env, MERRYMEN_HOME: dir, MERRYMEN_HOSTED: "", DATABASE_URL: "" } });
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Solana strategy stopped/);
  assert.match(first.stdout, /grant destroyed/);
  assert.equal(existsSync(path.join(dir, "grant.json")), false);
  const after = (await store.get(T))!;
  assert.equal(after.strategy?.enabled, false); assert.ok(after.revision > revision);
  // No grant left: the kill still reaches the Solana strategy, which a new one turned on.
  await store.strategy(T, OWNER, after.revision, strategy);
  const second = run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /no grant to call in[\s\S]*Solana strategy stopped/);
  assert.equal((await store.get(T))!.strategy?.enabled, false);
});

test("`merrymen kill` with a Solana stop that fails removes the grant but never reports a stand-down", { timeout: 120_000 }, async (t) => {
  const { dir } = await home(t);
  const bin = fileURLToPath(new URL("../../cli/bin.mjs", import.meta.url));
  writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ smartAccount: "0x1111111111111111111111111111111111111111", serialized: "0xserialized", chainId: 4663 }));
  // A Solana store the kill cannot open: its stop fails.
  writeFileSync(path.join(dir, "solana-accounts.sqlite"), "not a database");
  const run = spawnSync(process.execPath, [bin, "kill"], { input: "y\n", encoding: "utf8", timeout: 100_000,
    env: { ...process.env, MERRYMEN_HOME: dir, MERRYMEN_HOSTED: "", DATABASE_URL: "" } });
  const said = run.stdout + run.stderr;
  assert.equal(run.status, 1, said);
  assert.match(said, /Kill incomplete: your Solana strategy could not be stopped/);
  assert.match(said, /grant destroyed and the Robinhood band stands down, but the kill is incomplete/);
  assert.doesNotMatch(said, /the band stands down on the next tick/);
  assert.equal(existsSync(path.join(dir, "grant.json")), false, "the Robinhood grant is still torn down");
});
