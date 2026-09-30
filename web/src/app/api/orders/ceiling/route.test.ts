/**
 * THE CEILING THE CHIPS OFFER IS THE ONE THE ORDERS ROUTE ENFORCES.
 *
 * The chat's amount chips clamp to min(sealed per-trade cap, the chat-order
 * ceiling). They read that ceiling from /api/settings — the owner's value
 * over SETTINGS_DEFAULTS (25) — while the orders route falls back to
 * resolveConfig(): the web process's own settings file and its env,
 * MERRYMEN_TELEGRAM_MAX_ACTION_USDG. A house below 25 therefore offered a
 * "(max)" chip the route refused, hosted as well as self-hosted.
 *
 * This route answers with the same resolution POST applies (lib/order-ceiling),
 * and these tests run it: the real handler, real sessions, the real settings
 * store on disk, the real env.
 *
 * AND POST, AGAINST THE SAME FIXTURE. "One resolution, two readers" was only
 * executed for this GET; POST — the reader that actually refuses — was pinned
 * by reading its source, so it could drift from the chips again with every
 * test green. Both readers now run against one tenant, one store and one env.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import type { StoredGrant } from "@merrymen/core";
import { mintSession } from "@/lib/auth";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { POST } from "../route";
import { GET } from "./route";

const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_SETTINGS_FILE", "MERRYMEN_TELEGRAM_MAX_ACTION_USDG", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-ceiling-"));
  process.env.MERRYMEN_HOME = dir;
  // No house settings file: the env and the defaults decide, as on a fresh box.
  process.env.MERRYMEN_SETTINGS_FILE = path.join(dir, "no-such-settings.json");
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // The grant store reads MERRYMEN_HOME when it is made: made again, here.
  resetGrantStoreForTest();
});
afterEach(() => {
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG;
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  resetGrantStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ask = (tenant: `0x${string}` | null) =>
  GET(new Request("https://app.example.test/api/orders/ceiling", tenant ? { headers: { cookie: `mm_session=${mintSession(tenant)}` } } : {}));
const ceiling = async (tenant: `0x${string}` | null) => {
  const res = await ask(tenant);
  assert.equal(res.status, 200);
  return ((await res.json()) as { ceilingUsdg: unknown }).ceilingUsdg;
};

describe("the ceiling a chat order is held to", () => {
  it("SELF-HOSTED, A HOUSE ENV BELOW THE DEFAULT IS THE CEILING — not the 25 the settings screen shows", async () => {
    process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "10";
    assert.equal(await ceiling(null), 10);
    delete process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG;
    assert.equal(await ceiling(null), 25, "and the default when nothing overrides it");
  });

  it("HOSTED, THE TENANT'S OWN VALUE, else the house's — env included", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "10";
    await getSettingsStore().put(TENANT, { telegramMaxActionUsdg: 7 });
    assert.equal(await ceiling(TENANT), 7, "their own");
    assert.equal(await ceiling(OTHER), 10, "nothing stored: the house's, which the chips used to read as 25");
  });

  it("hosted and signed out, there is no ceiling to tell", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    assert.equal((await ask(null)).status, 401);
  });
});

/** The account each signed-in wallet trades through — what POST resolves the caller to. */
const ACCOUNT = { [TENANT]: "0x00000000000000000000000000000000000000a1", [OTHER]: "0x00000000000000000000000000000000000000a2" } as const;
const grantOf = (smartAccount: string) =>
  ({ smartAccount, chainId: 4663, serialized: "not-a-permission-account", demoSessionPrivateKey: "" }) as unknown as StoredGrant;

/** POST /api/orders, as the chat's card sends it. */
async function place(tenant: `0x${string}` | null, usdgAmount: number) {
  const res = await POST(
    new Request("https://app.example.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", ...(tenant ? { cookie: `mm_session=${mintSession(tenant)}` } : {}) },
      body: JSON.stringify({ side: "buy", symbol: "TSLA", usdgAmount }),
    }),
  );
  return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" };
}

describe("POST refuses at the ceiling GET reports — one fixture, both readers", () => {
  it("HOSTED: the tenant's own 7 over the house's 10 — POST refuses 8 and GET says 7", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "10";
    await getGrantStore().put(TENANT, grantOf(ACCOUNT[TENANT]));
    await getGrantStore().put(OTHER, grantOf(ACCOUNT[OTHER]));
    await getSettingsStore().put(TENANT, { telegramMaxActionUsdg: 7 });

    const over = await place(TENANT, 8);
    assert.equal(over.status, 400, "8 is over the tenant's own 7, whatever the house allows");
    assert.match(over.error, /over your 7 USDG limit/);
    assert.equal(await ceiling(TENANT), 7, "and the chips are told the same 7");
    // At the ceiling it is not the ceiling that answers. There is no ledger to
    // queue into here, so the queue does — which is not a refusal at the limit.
    const at = await place(TENANT, 7);
    assert.equal(at.status, 503);
    assert.match(at.error, /couldn't queue it/, "it reached the queue");

    // A tenant who stored nothing is held to the house's 10 — by both readers.
    assert.equal(await ceiling(OTHER), 10);
    assert.match((await place(OTHER, 8)).error, /couldn't queue it/, "8 is within the house's 10, and reached the queue");
    const houseOver = await place(OTHER, 11);
    assert.equal(houseOver.status, 400);
    assert.match(houseOver.error, /over your 10 USDG limit/);
  });

  it("SELF-HOSTED: the house's env — POST refuses 11, queues 10, and GET says 10", async () => {
    process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "10";
    // The one grant on this machine, where the self-hosted route finds its account.
    writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ smartAccount: ACCOUNT[TENANT] }));
    assert.equal(await ceiling(null), 10);
    const over = await place(null, 11);
    assert.equal(over.status, 400);
    assert.match(over.error, /over your 10 USDG limit/);
    const at = await place(null, 10);
    assert.equal(at.status, 200, `the ceiling itself is allowed: ${at.error}`);
  });

  it("signed out, POST places nothing", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    assert.equal((await place(null, 1)).status, 401);
  });
});
