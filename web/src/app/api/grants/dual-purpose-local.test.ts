import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, it } from "node:test";
import type { StoredGrant } from "@merrymen/core";
const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL"].map(k => [k, process.env[k]]));
const home = mkdtempSync(path.join(os.tmpdir(), "mm-local-dual-intake-"));
process.env.MERRYMEN_HOME = home; delete process.env.MERRYMEN_HOSTED; delete process.env.DATABASE_URL;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const spot: StoredGrant = { owner: addr(1), smartAccount: addr(2), chainId: 4663, demoSessionPrivateKey: `0x${"ab".repeat(32)}`, sessionKeyAddress: addr(4), serialized: "local-permission",
  grantedAt: 1, expiresAt: 9_999_999_999, caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 } };
const perps: StoredGrant = { ...spot, purpose: "perps", smartAccount: addr(3) };
let POST: typeof import("./route").POST, DELETE: typeof import("./route").DELETE;
before(async () => { ({ POST, DELETE } = await import("./route")); });
beforeEach(() => { for (const name of ["grant.json", "accounts", "grants"]) rmSync(path.join(home, name), { force: true, recursive: true }); });
after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(home, { recursive: true, force: true }); });
const post = (grant: StoredGrant) => POST(new Request(`http://localhost/api/grants${grant.purpose === "perps" ? "?purpose=perps" : ""}`, { method: "POST", body: JSON.stringify(grant) }));
const file = (purpose: "spot" | "perps") => path.join(home, ...(purpose === "perps" ? ["accounts", "perps"] : []), "grant.json");

it("simultaneous first local setup cannot install different owner keys", async () => {
  const responses = await Promise.all([post(spot), post({ ...perps, owner: addr(99) })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const refused = responses.find(r => r.status === 409)!;
  assert.equal((await refused.json()).code, "account-owner-mismatch");
  assert.notEqual(existsSync(file("spot")), existsSync(file("perps")));
});

it("concurrent same-owner setup arms two whole files and Perps replacement/revocation preserves Spot", async () => {
  const responses = await Promise.all([post(spot), post(perps)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const before = readFileSync(file("spot"), "utf8");
  assert.deepEqual(JSON.parse(before), spot);
  assert.deepEqual(JSON.parse(readFileSync(file("perps"), "utf8")), perps);
  assert.equal(statSync(file("perps")).mode & 0o777, 0o600);
  assert.equal((await post({ ...perps, serialized: "renewed" })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "accounts", "perps", "grants", `${perps.smartAccount}.json`), "utf8")), perps);
  assert.equal((await DELETE(new Request("http://localhost/api/grants?purpose=perps", { method: "DELETE" }))).status, 200);
  assert.equal(existsSync(file("perps")), false);
  assert.equal(readFileSync(file("spot"), "utf8"), before);
});
