/**
 * NO SIGNER IS SERVED $MERRYMEN AS A CUSTOM TOKEN.
 *
 * Every signer — the web tabs, iOS GrantScreen (`extraTokens:
 * fresh.setting("customTokens")`), Android, the RN app — builds its wall from
 * GET /api/settings. Current signers drop the reserve themselves, but an iOS
 * engine or a tab from before energy seals whatever this list says, and the
 * server's canonical rebuild (which drops it) then refuses the grant — the owner
 * could not re-sign or renew. These run the real GET, self-hosted and hosted:
 * the reserve is left out of what is served, in any address case, and nothing
 * else is touched — neither the other tokens nor what is stored.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { MERRYMEN_TOKEN } from "@merrymen/core";
import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";

const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const MERRY_SHOUT = `0x${MERRYMEN_TOKEN.address.slice(2).toUpperCase()}`;
const CATE = { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00", decimals: 18 };
/** A coin that merely calls itself MERRYMEN somewhere else — not the reserve. */
const NAMESAKE = { symbol: "MERRYMEN", address: "0x0000000000000000000000000000000000003333", decimals: 18 };
const STORED = [
  { symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address, decimals: 18 },
  CATE,
  { symbol: "MERRY", address: MERRY_SHOUT, decimals: 18 },
  NAMESAKE,
];
let dir: string;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-reserve-"));
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

async function served(session: `0x${string}` | null): Promise<unknown> {
  const res = await GET(
    new Request("https://app.example.test/api/settings", {
      headers: session ? { cookie: `mm_session=${mintSession(session)}` } : {},
    }),
  );
  assert.equal(res.status, 200);
  return ((await res.json()) as { values: { customTokens?: unknown } }).values.customTokens;
}

describe("GET /api/settings leaves the energy reserve out of customTokens", () => {
  it("SELF-HOSTED: the file's reserve entries are not served, in any case; the rest are, in order; the file is untouched", async () => {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ customTokens: STORED }));
    const before = readFileSync(file, "utf8");
    assert.deepEqual(await served(null), [CATE, NAMESAKE]);
    assert.equal(readFileSync(file, "utf8"), before, "a read never rewrites what the owner stored");
  });

  it("HOSTED: the tenant's reserve entries are not served; the stored settings keep them", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    await getSettingsStore().put(TENANT, { customTokens: STORED });
    assert.deepEqual(await served(TENANT), [CATE, NAMESAKE]);
    assert.deepEqual((await getSettingsStore().get(TENANT))?.customTokens, STORED);
  });

  it("no list stays no list, and a list without the reserve is served as stored", async () => {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({}));
    assert.equal(await served(null), undefined);
    writeFileSync(file, JSON.stringify({ customTokens: [CATE, NAMESAKE] }));
    assert.deepEqual(await served(null), [CATE, NAMESAKE]);
  });
});
