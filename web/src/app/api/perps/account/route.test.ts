import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { before, after, it } from "node:test";
import { mintSession } from "@/lib/auth";
import { resetGrantStoreForTest } from "@merrymen/grant-store";
import { perpsAccountIdentity } from "@/lib/perps-account-data";
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const A = `0x${"aa".repeat(20)}` as const, B = `0x${"bb".repeat(20)}` as const;
const accountA = `0x${"cc".repeat(20)}`, accountB = `0x${"dd".repeat(20)}`;
let home: string, GET: (req: Request) => Promise<Response>;
const req = (owner?: typeof A | typeof B, query = "") => new Request(`http://localhost/api/perps/account${query}`, { headers: owner ? { cookie: `mm_session=${mintSession(owner)}` } : {} });
before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "mm-perps-account-"));
  process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_HOSTED = "1"; process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
  delete process.env.DATABASE_URL; delete process.env.MERRYMEN_STORE_DEK; resetGrantStoreForTest();
  ({ GET } = await import("./route"));
});
after(async () => {
  resetGrantStoreForTest();
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  await rm(home, { recursive: true, force: true });
});
it("requires session, refuses owner selectors, and distinguishes no grant from unreadable grant", async () => {
  assert.equal((await GET(req())).status, 401);
  assert.equal((await GET(req(A, `?agent=${accountB}`))).status, 400);
  assert.equal((await (await GET(req(A))).json()).state, "not-configured");
  await mkdir(path.join(home, "tenants"), { recursive: true });
  await writeFile(path.join(home, "tenants", `${A}.json`), "malformed");
  assert.equal((await (await GET(req(A))).json()).state, "unread");
});
it("counts only authenticated account fills, separates books and never exposes grant secrets", async () => {
  for (const [tenant, account] of [[A, accountA], [B, accountB]]) await writeFile(path.join(home, "tenants", `${tenant}.json`), JSON.stringify({ tenant, grant: { smartAccount: account, chainId: 4663, ownerPrivateKey: "SECRET", perp: { apiPublicKey: "PRIVATE-METADATA" } }, sealedSessionKey: "0x01" }));
  const db = new DatabaseSync(path.join(home, "merrymen.db"));
  db.exec("CREATE TABLE agents (smart_account TEXT, name TEXT, perps TEXT, mode TEXT); CREATE TABLE perp_fills (agent_id TEXT, mode TEXT)");
  db.prepare("INSERT INTO agents VALUES (?, 'Current agent', NULL, 'paper')").run(accountA);
  for (const mode of ["paper", "paper", "live", "legacy"]) db.prepare("INSERT INTO perp_fills VALUES (?,?)").run(accountA, mode);
  db.prepare("INSERT INTO perp_fills VALUES (?, 'live')").run(accountB);
  db.close();
  const response = await GET(req(A)), data = await response.json();
  assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.equal(response.headers.get("Vary"), "Cookie");
  assert.equal(data.owner, A); assert.equal(data.account.smartAccount, accountA); assert.equal(data.account.profile.name, "Current agent");
  assert.deepEqual(data.activityCounts, { state: "ready", scope: "recorded-fills-all-epochs", paper: 2, live: 1, unknown: 1 });
  assert.doesNotMatch(JSON.stringify(data), /SECRET|PRIVATE-METADATA|sealedSessionKey|ownerPrivateKey/);
  const other = await (await GET(req(B))).json();
  assert.deepEqual(other.activityCounts, { state: "ready", scope: "recorded-fills-all-epochs", paper: 0, live: 1, unknown: 0 });
  assert.equal(other.account.profile, undefined);
});
it("missing count table stays unknown and unsupported chain offers no collateral route", async () => {
  const db = new DatabaseSync(path.join(home, "merrymen.db")); db.exec("DROP TABLE perp_fills"); db.close();
  const data = await (await GET(req(A))).json();
  assert.equal(data.state, "unread"); assert.equal(data.activityCounts.paper, null);
  assert.equal(perpsAccountIdentity({ smartAccount: accountA, chainId: 46630 })?.collateral, null);
  assert.equal(perpsAccountIdentity({ smartAccount: accountA, chainId: "4663" }), null);
});
it("local grant absence differs from corrupt storage and never falls back to a ledger agent", async () => {
  process.env.MERRYMEN_HOSTED = "0";
  try {
    const absent = await (await GET(req())).json();
    assert.equal(absent.owner, null); assert.equal(absent.state, "not-configured"); assert.equal(absent.account, null);
    await writeFile(path.join(home, "grant.json"), "broken");
    const corrupt = await (await GET(req())).json(); assert.equal(corrupt.state, "unread"); assert.equal(corrupt.account, null);
    await writeFile(path.join(home, "grant.json"), JSON.stringify({ smartAccount: accountB, chainId: 46630 }));
    const local = await (await GET(req())).json(); assert.equal(local.owner, null); assert.equal(local.account.smartAccount, accountB); assert.equal(local.account.collateral, null);
  } finally { process.env.MERRYMEN_HOSTED = "1"; }
});
