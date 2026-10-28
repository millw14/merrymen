/**
 * SELF-HOSTED "KILL ALL AGENTS" STOPS THE LOCAL SOLANA STRATEGY WHATEVER HAPPENS
 * TO THE ROBINHOOD GRANT.
 *
 * The self-hosted kill archives grant.json before removing it; an archive it
 * cannot write keeps the grant and pauses trading instead (409). The local
 * Solana strategy is stopped first, so that answer never leaves autonomous
 * Solana trading running behind it. Driven through the real handler against a
 * real home and a real local accounts file.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { base58Encode } from "../../../../../packages/core/src/ids";

const T = `0x${"22".repeat(20)}` as `0x${string}`;
const OWNER = base58Encode(new Uint8Array(32).fill(20));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3_600_000 };
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 300 };
const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL"].map((key) => [key, process.env[key]]));

let home = "";
let DELETE: (req: Request) => Promise<Response>;
let store: import("@/lib/solana-binding-store").SolanaBindingStore;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-kill-solana-"));
  process.env.MERRYMEN_HOME = home;
  for (const key of ["MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL"]) delete process.env[key];
  ({ DELETE } = await import("./route"));
  store = (await import("@/lib/solana-binding-store")).getSolanaBindingStore();
});
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("an archive refusal (409) still stops the local Solana strategy, and says so", async () => {
  await store.bind(T, "did:privy:owner", OWNER);
  await store.settings(T, OWNER, 0, "paper", limits);
  const before = await store.strategy(T, OWNER, 1, strategy);
  assert.equal(before.strategy?.enabled, true);
  assert.ok(existsSync(path.join(home, "solana-accounts.sqlite")));
  // A grant.json the archive cannot name a copy for: the kill keeps it and pauses trading instead.
  const grant = JSON.stringify({ smartAccount: "not-an-address", serialized: "0xserialized", demoOwnerPrivateKey: "0xowner", chainId: 4663 });
  writeFileSync(path.join(home, "grant.json"), grant);
  const refused = await DELETE(new Request("http://localhost/api/grants", { method: "DELETE" }));
  assert.equal(refused.status, 409);
  const body = await refused.json() as { error: string; solana?: string };
  assert.match(body.error, /The grant was NOT deleted: its smartAccount is not an address/);
  assert.match(body.error, /Your Solana strategy was stopped\./);
  assert.equal(body.solana, "stopped");
  assert.equal(readFileSync(path.join(home, "grant.json"), "utf8"), grant, "the grant is kept");
  const after = (await store.get(T))!;
  assert.equal(after.strategy?.enabled, false, "autonomous Solana trading is off");
  assert.ok(after.revision > before.revision, "with a revision bump that fences an admission in flight");
});
