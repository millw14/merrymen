import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mintSession } from "@/lib/auth";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { resetSettingsStoreForTest } from "@merrymen/settings-store";
import type { StoredGrant } from "@merrymen/core";
import { homePaths } from "../../../../../../worker/src/home";
import { runTickCommand } from "../../../../../../worker/src/command-files";
import { POST, GET } from "./route";
import { POST as EXIT } from "../../orders/route";
const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACCOUNT = "0x1111111111111111111111111111111111111111", SECOND = "0x2222222222222222222222222222222222222222";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_SETTINGS_FILE", "DATABASE_URL"] as const;
const previous = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mm-perps-controls-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_SETTINGS_FILE = path.join(dir, "missing-settings.json");
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL; delete process.env.MERRYMEN_HOSTED;
  resetGrantStoreForTest(); resetSettingsStoreForTest();
  writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ smartAccount: ACCOUNT }));
});
afterEach(() => { resetGrantStoreForTest(); resetSettingsStoreForTest(); rmSync(dir, { recursive: true, force: true }); });
after(() => { for (const k of KEYS) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
const req = (url: string, body: unknown, tenant: typeof TENANT | typeof OTHER | null = null) => new Request(`https://app.test${url}`, {
  method: "POST", headers: { "content-type": "application/json", ...(tenant ? { cookie: `mm_session=${mintSession(tenant)}` } : {}) }, body: JSON.stringify(body),
});
async function hosted() {
  process.env.MERRYMEN_HOSTED = "1";
  await getGrantStore().put(TENANT, { smartAccount: ACCOUNT } as unknown as StoredGrant);
  await getGrantStore().put(OTHER, { smartAccount: SECOND } as unknown as StoredGrant);
}
describe("dashboard perps resume and owner exit routes", () => {
  it("ordinary and energy IDs keep their old hash, while paper and live exits differ", async () => {
    const ids: string[] = [];
    for (const order of [
      { side: "buy", symbol: "BTC", usdgAmount: 1 },
      { side: "buy", symbol: "MERRYMEN", usdgAmount: 1, purpose: "energy" },
      { side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp", book: "paper" },
      { side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp", book: "live" },
    ]) {
      const before = Date.now();
      const response = await EXIT(req("/api/orders", order));
      assert.equal(response.status, 200);
      const body = await response.json(); ids.push(body.id);
      const expected = (now: number) => createHash("sha256").update(`${ACCOUNT}|${order.side}|${order.symbol}|${order.usdgAmount}|${Math.floor(now / 60_000)}${order.purpose ? `|${order.purpose}` : ""}${order.book ? `|${order.book}` : ""}`).digest("hex").slice(0, 32);
      assert.ok([expected(before), expected(Date.now())].includes(body.id));
      await runTickCommand(dir, { now: Date.now, told: async () => {}, run: async () => ({ ok: true, line: "test complete" }) });
    }
    assert.notEqual(ids[2], ids[3]);
  });
  it("requires session and binds the owner for resume and exit", async () => {
    await hosted();
    assert.equal((await POST(req("/api/perps/resume", { mode: "live", confirm: true }))).status, 401);
    for (const owner of [undefined, OTHER, false]) assert.equal((await POST(req("/api/perps/resume", { owner, mode: "live", confirm: true }, TENANT))).status, 409);
    assert.equal((await EXIT(req("/api/orders", { owner: OTHER, book: "live", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp" }, TENANT))).status, 409);
    assert.equal((await POST(req("/api/perps/resume", { owner: TENANT, mode: "live", confirm: true }, TENANT))).status, 503, "missing ledger is not success");
  });
  it("requires an explicit mode and confirmation, never accepts incident reset or arbitrary commands", async () => {
    for (const body of [null, {}, { mode: "live" }, { mode: "live", confirm: "true" }, { mode: "live;reset-incident", confirm: true }]) assert.equal((await POST(req("/api/perps/resume", body))).status, 400);
    const answer = await POST(req("/api/perps/resume", { mode: "paper", confirm: true, kind: "reset-incident", incident: false }));
    assert.equal(answer.status, 200);
    let ran = 0;
    await runTickCommand(dir, { now: Date.now, told: async () => {}, run: async (cmd) => {
      ran++; assert.equal(cmd.kind, "resume-perps"); assert.deepEqual(Object.keys(cmd.args!).sort(), ["expiresAt", "mode"]);
      assert.equal(cmd.args!.mode, "paper"); assert.ok(cmd.expiresAt! > Date.now()); return { ok: true, line: "paper entries resumed" };
    } });
    await runTickCommand(dir, { now: Date.now, told: async () => {}, run: async () => { throw new Error("replay"); } });
    const again = await POST(req("/api/perps/resume", { mode: "paper", confirm: true }));
    assert.equal((await again.json()).duplicate, true);
    assert.equal(ran, 1);
  });
  it("an exit uses the same claimed-once queue and never accepts an open-shaped payload", async () => {
    const bad = await EXIT(req("/api/orders", { book: "live", side: "buy", symbol: "BTC-PERP", usdgAmount: 10, purpose: "close-perp" }));
    assert.equal(bad.status, 400);
    const answer = await EXIT(req("/api/orders", { book: "live", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp" }));
    assert.equal(answer.status, 200);
    assert.equal((await POST(req("/api/perps/resume", { mode: "paper", confirm: true }))).status, 409, "resume waits behind the exit");
    await runTickCommand(dir, { now: Date.now, told: async () => {}, run: async (cmd) => {
      assert.equal(cmd.kind, "trade"); assert.equal(cmd.args!.purpose, "close-perp"); assert.equal(cmd.args!.usdgAmount, 0); return { ok: false, line: "could not read Lighter" };
    } });
  });
  it("polling can only read the signed-in tenant's current account", async () => {
    await hosted();
    const id = "abcdef0123456789abcdef0123456789";
    const db = new DatabaseSync(homePaths.db());
    db.exec("CREATE TABLE agent_commands (id TEXT, agent_id TEXT, kind TEXT, created_at INTEGER, claimed_at INTEGER, done_at INTEGER, args TEXT, result TEXT)");
    db.prepare("INSERT INTO agent_commands VALUES (?, ?, 'resume-perps', 1, 2, 3, '{}', ?)").run(id, ACCOUNT, "private result"); db.close();
    const get = (tenant: typeof TENANT | typeof OTHER, owner = tenant) => GET(new Request(`https://app.test/api/perps/resume?id=${id}&owner=${owner}`, { headers: { cookie: `mm_session=${mintSession(tenant)}` } }));
    assert.equal((await (await get(TENANT)).json()).result, "private result");
    assert.deepEqual(await (await get(OTHER)).json(), { state: "none" });
    assert.equal((await get(OTHER, TENANT)).status, 409);
  });
});
