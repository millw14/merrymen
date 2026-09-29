/**
 * NO PINNED SIGNER, NO KEY — named, never a key from anywhere else.
 *
 * Its own file because the process's signer loader is shared and remembers a
 * failure for a while (signer.ts signerLoader): the operator override points
 * at an empty directory BEFORE anything loads, so the first build fails as
 * `artifact-missing` and the route must answer a named, uncached 503 — and
 * write no key file.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_LIGHTER_VENDOR_DIR"].map((k) => [k, process.env[k]]));
const root = mkdtempSync(path.join(tmpdir(), "mm-perp-keygen-unavailable-"));
const empty = path.join(root, "no-signer-here");
mkdirSync(empty);
process.env.MERRYMEN_HOME = path.join(root, "home");
process.env.MERRYMEN_LIGHTER_VENDOR_DIR = empty;
delete process.env.MERRYMEN_HOSTED;

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("the signer cannot be built: 503 perp-signer-unavailable, reason named, uncached, no key file", async () => {
  const { POST } = await import("./route");
  const res = await POST(
    new Request("http://localhost:3100/api/perps/keygen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ smartAccount: "0x00000000000000000000000000000000000000a1" }),
    }),
  );
  const body = (await res.json()) as { code?: string; reason?: string; ownerFacing?: boolean };
  assert.equal(res.status, 503, JSON.stringify(body));
  assert.equal(body.code, "perp-signer-unavailable");
  assert.equal(body.reason, "artifact-missing");
  assert.equal(body.ownerFacing, true);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(existsSync(path.join(root, "home", "perp-keys")), false);
});
