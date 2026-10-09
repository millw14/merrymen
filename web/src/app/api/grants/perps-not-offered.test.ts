/**
 * PERPS SLICE 1: THE SIGNERS CAN CARRY A LIGHTER KEY, BUT NO SERVER TAKES ONE YET.
 *
 * Until the slice that lands keygen and perp-custody's intake, a grant naming
 * the perps marker or a `perp` block is refused exactly as a perps-off server
 * refuses a new opt-in (403 perp-not-offered), and nothing is written.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, grant: process.env.MERRYMEN_GRANT_FILE };
let home = "";
let POST: (req: Request) => Promise<Response>;
const A = "0x00000000000000000000000000000000000000a1";
const KEY = `0x${"1a".repeat(40)}`;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-perps-off-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_GRANT_FILE;
  ({ POST } = await import("./route"));
});
after(() => {
  for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["MERRYMEN_GRANT_FILE", saved.grant]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const grantFile = () => path.join(home, "grant.json");
beforeEach(() => rmSync(grantFile(), { force: true }));
const post = (g: unknown) =>
  POST(new Request("http://localhost/api/grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(g) }));
const base = { smartAccount: A, serialized: "0xserialized", chainId: 4663, grantFeatures: ["tradeable-v2"] };
const perp = { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: KEY };

describe("POST /api/grants refuses perps until the intake slice lands", () => {
  for (const [what, g] of [
    ["marker and block", { ...base, grantFeatures: ["tradeable-v2", "perp-lighter-v1"], perp }],
    ["marker alone", { ...base, grantFeatures: ["tradeable-v2", "perp-lighter-v1"] }],
    ["block alone", { ...base, perp }],
  ] as const) {
    it(`${what}: 403 perp-not-offered, nothing written`, async () => {
      writeFileSync(grantFile(), "{\"smartAccount\":\"0x00000000000000000000000000000000000000b2\"}\n");
      const res = await post(g);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, "perp-not-offered");
      assert.equal(readFileSync(grantFile(), "utf8"), "{\"smartAccount\":\"0x00000000000000000000000000000000000000b2\"}\n");
    });
  }
  it("a grant without perps is untouched by it", async () => {
    const res = await post(base);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.ok(existsSync(grantFile()));
  });
});
