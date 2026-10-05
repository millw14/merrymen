/**
 * NO SECRET LEAVES GET /api/settings IN CLEAR — EVERY SECRET_SETTING_KEYS MEMBER, HOSTED AND SELF-HOSTED.
 *
 * The route's own header promises "Secrets NEVER travel back to the browser".
 * GET masked secrets by destructuring ten names by hand, so `fomoApiKey` —
 * added to core's SECRET_SETTING_KEYS, and so accepted and stored by PUT — was
 * left in `values` and returned verbatim to every dashboard load. These drive
 * the real GET with every shared secret stored and assert that no stored
 * secret value appears anywhere in the body, that each comes back as
 * { set, hint }, and that none is under `values`. A secret added to core later
 * is covered by the loop without anyone editing this file.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { SECRET_SETTING_KEYS } from "@merrymen/core";

const TENANT = "0xcccccccccccccccccccccccccccccccccccccccc";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let GET: (req: Request) => Promise<Response>;

/** A distinct, recognisable value per secret; the last four ("WXYZ") are the only part a hint may show. */
const SECRETS: Record<string, string> = Object.fromEntries(SECRET_SETTING_KEYS.map((k) => [k, `live-${k}-${randomBytes(8).toString("hex")}-WXYZ`]));

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-secrets-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // After the env: the route resolves its settings path when it loads.
  ({ GET } = await import("./route"));
});
afterEach(() => {
  delete process.env.MERRYMEN_HOSTED;
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function get(cookie?: string): Promise<{ text: string; body: Record<string, unknown> & { values: Record<string, unknown> } }> {
  const res = await GET(new Request("https://app.example.test/api/settings", { headers: cookie ? { cookie } : {} }));
  assert.equal(res.status, 200);
  const text = await res.text();
  return { text, body: JSON.parse(text) };
}

function assertNoSecretEchoed(text: string, body: Record<string, unknown> & { values: Record<string, unknown> }): void {
  for (const key of SECRET_SETTING_KEYS) {
    assert.ok(!text.includes(SECRETS[key]), `${key} came back in plaintext`);
    assert.equal(key in body.values, false, `${key} is under values`);
    assert.deepEqual(body[key], { set: true, hint: "WXYZ" }, `${key} is not masked as { set, hint }`);
  }
}

describe("GET /api/settings never returns a secret in clear", () => {
  it("self-hosted: every SECRET_SETTING_KEYS member in settings.json comes back masked — fomoApiKey included", async () => {
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ strategy: "trencher", ...SECRETS }));
    const { text, body } = await get();
    assertNoSecretEchoed(text, body);
    assert.equal(body.values.strategy, "trencher", "non-secret values still come back");
    assert.ok(SECRET_SETTING_KEYS.includes("fomoApiKey"), "the key this test was written for is still a shared secret");
  });

  it("hosted: a tenant blob holding every secret (however it got there) comes back masked", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    await getSettingsStore().put(TENANT, { strategy: "trencher", ...SECRETS });
    const { text, body } = await get(`mm_session=${mintSession(TENANT)}`);
    assertNoSecretEchoed(text, body);
    assert.equal(body.values.strategy, "trencher");
  });

  it("an unset secret reads as not set, never as an empty string under values", async () => {
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ strategy: "trencher" }));
    const { body } = await get();
    for (const key of SECRET_SETTING_KEYS) {
      assert.deepEqual(body[key], { set: false, hint: null }, key);
      assert.equal(key in body.values, false, key);
    }
  });
});
