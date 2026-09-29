/**
 * POST /api/perps/keygen, SELF-HOSTED, WHERE THE OPERATOR HAS NOT OFFERED
 * PERPS (docs/perps.md rule 1, "Rollout"; review: perp-optin-ungated).
 *
 * The self-hosted owner is the operator, so perps default to live there — but
 * MERRYMEN_PERPS=off|paper, or anything the lever does not recognise, is a
 * restriction keygen must honour: no key is minted, nothing is written to the
 * key store, and the refusal is named and uncached. (Hosted cases are in
 * keygen.test.ts.) Its own file because the route's limiter is per caller and
 * every self-hosted request is the same caller.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_LIGHTER_VENDOR_DIR", "MERRYMEN_PERPS", "MERRYMEN_PERPS_LIVE_TENANTS"].map((k) => [k, process.env[k]]),
);
const root = mkdtempSync(path.join(tmpdir(), "mm-perp-keygen-offer-"));
delete process.env.MERRYMEN_HOSTED;
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_LIGHTER_VENDOR_DIR;
delete process.env.MERRYMEN_PERPS;
delete process.env.MERRYMEN_PERPS_LIVE_TENANTS;

let route: typeof import("./route");
before(async () => {
  route = await import("./route");
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const post = () =>
  route.POST(
    new Request("http://localhost:3100/api/perps/keygen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ smartAccount: "0x00000000000000000000000000000000000000a1" }),
    }),
  );

it("MERRYMEN_PERPS=off, paper or a typo: 403 perp-not-offered, uncached, and no key file", async () => {
  for (const ceiling of ["off", "paper", "lvie"]) {
    const home = path.join(root, ceiling);
    process.env.MERRYMEN_HOME = home;
    process.env.MERRYMEN_PERPS = ceiling;
    const res = await post();
    const text = await res.text();
    assert.equal(res.status, 403, `${ceiling}: ${text}`);
    assert.match(res.headers.get("cache-control") ?? "", /private, no-store/);
    const body = JSON.parse(text) as { code?: string; ownerFacing?: boolean };
    assert.equal(body.code, "perp-not-offered");
    assert.equal(body.ownerFacing, true);
    assert.ok(!existsSync(path.join(home, "perp-keys")), `${ceiling}: no key is made where the opt-in is not offered`);
  }
});

it("unset (the self-hosted default, live): the key is made", async () => {
  delete process.env.MERRYMEN_PERPS;
  const home = path.join(root, "default");
  process.env.MERRYMEN_HOME = home;
  const res = await post();
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(existsSync(path.join(home, "perp-keys")));
});
