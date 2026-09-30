/**
 * AN ORDER IS PLACED FOR THE OWNER WHO CONFIRMED IT, OR NOT AT ALL.
 *
 * A browser sends the session it holds when a request LEAVES, not the one it
 * held when the owner tapped. A snipe's order leaves only after its lookup
 * answers, and another tab can sign a different wallet in without the tab that
 * tapped ever knowing — so POST /api/orders went out with that wallet's cookie
 * and placed a real order for an owner who never confirmed it. The chat card
 * now names the owner who tapped (`owner`), and these run the real handlers:
 * a session that is not that owner's places nothing.
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
import { resetSettingsStoreForTest } from "@merrymen/settings-store";
import { GET, POST } from "./route";
import { POST as SNIPE } from "../snipe/route";

const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_SETTINGS_FILE", "MERRYMEN_TELEGRAM_MAX_ACTION_USDG", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-owner-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_SETTINGS_FILE = path.join(dir, "no-such-settings.json");
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  resetGrantStoreForTest();
  const grantOf = (smartAccount: string) =>
    ({ smartAccount, chainId: 4663, serialized: "not-a-permission-account", demoSessionPrivateKey: "" }) as unknown as StoredGrant;
  await getGrantStore().put(TENANT, grantOf("0x00000000000000000000000000000000000000a1"));
  await getGrantStore().put(OTHER, grantOf("0x00000000000000000000000000000000000000a2"));
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

const request = (url: string, session: `0x${string}` | null, body: Record<string, unknown>) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(session ? { cookie: `mm_session=${mintSession(session)}` } : {}) },
    body: JSON.stringify(body),
  });

/** POST /api/orders as the chat's card sends it, under `session`, naming `owner` when given. */
async function place(session: `0x${string}` | null, owner: unknown, usdgAmount = 5) {
  const res = await POST(
    request("https://app.example.test/api/orders", session, { side: "buy", symbol: "TSLA", usdgAmount, ...(owner === undefined ? {} : { owner }) }),
  );
  return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" };
}

describe("POST /api/orders", () => {
  it("HOSTED, A SESSION THAT IS NOT THE OWNER WHO CONFIRMED PLACES NOTHING — and says why", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const other = await place(OTHER, TENANT);
    assert.equal(other.status, 409);
    assert.match(other.error, /different wallet now than the one that confirmed this, so nothing was placed/);
    // Before the ceiling: "over your limit" would be the OTHER wallet's limit,
    // about an order that was never theirs.
    process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "1";
    assert.equal((await place(OTHER, TENANT, 50)).status, 409);
    assert.equal((await place(OTHER, 42)).status, 409, "a claim that is not an address is nobody's");
  });

  it("the owner who confirmed goes on to the queue, however the address is cased", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    // No ledger to queue into here, so the queue answers — past every refusal.
    for (const owner of [TENANT, TENANT.toUpperCase().replace("0X", "0x")]) {
      const own = await place(TENANT, owner);
      assert.equal(own.status, 503, owner);
      assert.match(own.error, /couldn't queue it/);
    }
  });

  it("a card that names nobody is judged by its session, as before", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    assert.match((await place(TENANT, undefined)).error, /couldn't queue it/);
    assert.equal((await place(null, TENANT)).status, 401, "signed out is still signed out");
  });

  it("self-hosted there is no sign-in to hold it against, and the order is queued", async () => {
    writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ smartAccount: "0x00000000000000000000000000000000000000a1" }));
    const res = await place(null, TENANT);
    assert.equal(res.status, 200, res.error);
  });
});

describe("GET /api/orders, asked what is open after a placement's answer was lost", () => {
  /** The lookup as the chat makes it, under `session`, naming `owner` when given. */
  const lookup = async (session: `0x${string}` | null, owner?: string) => {
    const res = await GET(
      new Request(`https://app.example.test/api/orders${owner === undefined ? "" : `?owner=${encodeURIComponent(owner)}`}`, {
        headers: session ? { cookie: `mm_session=${mintSession(session)}` } : {},
      }),
    );
    return { status: res.status, body: (await res.json()) as { error?: string; state?: string } };
  };

  it("HOSTED, ANOTHER SESSION'S OPEN ORDER IS NOT READ FOR THE OWNER WHO CONFIRMED — it would be followed as theirs", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const other = await lookup(OTHER, TENANT);
    assert.equal(other.status, 409);
    assert.equal(other.body.state, undefined, "no order, and no 'none' either — nothing was read");
    assert.equal((await lookup(OTHER, "")).status, 409, "a claim that names no wallet is nobody's");
  });

  it("the owner who confirmed, or a lookup that names nobody, is read as before", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    // No ledger to read here, so the read answers 503 — past the owner check.
    for (const owner of [TENANT, TENANT.toUpperCase().replace("0X", "0x"), undefined]) {
      assert.equal((await lookup(TENANT, owner)).status, 503, String(owner));
    }
    assert.equal((await lookup(null, TENANT)).status, 401, "signed out is still signed out");
  });

  it("self-hosted there is no sign-in to hold it against", async () => {
    writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ smartAccount: "0x00000000000000000000000000000000000000a1" }));
    const res = await lookup(null, TENANT);
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.state, "none");
  });
});

describe("POST /api/snipe", () => {
  const snipe = async (session: `0x${string}` | null, body: Record<string, unknown>) => {
    const res = await SNIPE(request("https://app.example.test/api/snipe", session, body));
    return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" };
  };

  it("HOSTED, A LOOKUP FOR ANOTHER OWNER'S CONFIRM IS REFUSED — it would resolve against the wrong wallet's coins", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const res = await snipe(OTHER, { query: "TSLA", usdgAmount: 5, owner: TENANT });
    assert.equal(res.status, 409);
    assert.match(res.error, /different wallet now than the one that confirmed this/);
  });

  it("the owner who confirmed, or a card that names nobody, is looked up as before", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    // An empty query is refused on its own merits — AFTER the owner check,
    // which is how these show they passed it without searching anything.
    for (const body of [{ query: "", usdgAmount: 5, owner: TENANT }, { query: "", usdgAmount: 5 }]) {
      const res = await snipe(TENANT, body);
      assert.equal(res.status, 400);
      assert.match(res.error, /name a coin/);
    }
  });
});
