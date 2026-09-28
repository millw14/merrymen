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
let PUT: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-reserve-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // After the env: the route resolves its settings path when it loads.
  ({ GET, PUT } = await import("./route"));
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

/**
 * AND THE BASKET SYMBOL ONLY THE RESERVE SUPPLIED GOES WITH IT, BOTH WAYS.
 *
 * An owner who listed $MERRYMEN before energy has it in basketSymbols too
 * (Settings' add-token and the Proposals approve both select what they add).
 * GET used to strip the token and serve the basket unchanged, so every client
 * that saves both — web Settings add, Proposals approve, iOS, Android — sent a
 * basket naming a coin its own list no longer had and was refused
 * ("basketSymbols: unknown symbols MERRYMEN"); after a tokens-only save had
 * dropped the stored entry, every later basket save was refused, about a coin
 * no screen showed. These run the real GET and PUT, self-hosted.
 */
describe("a legacy basket that names $MERRYMEN", () => {
  const file = () => path.join(dir, "settings.json");
  const RESERVE = { symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address, decimals: 18 };
  const DOGE2 = { symbol: "DOGE2", address: "0x0000000000000000000000000000000000d0ce00", decimals: 18 };
  const FOO = { symbol: "FOO", address: "0x0000000000000000000000000000000000f00f00", decimals: 18 };
  const view = async () =>
    ((await (await GET(new Request("https://app.example.test/api/settings"))).json()) as {
      values: { customTokens?: { symbol: string; address: string }[]; basketSymbols?: string[] };
    }).values;
  const put = async (body: unknown) => {
    const res = await PUT(
      new Request("https://app.example.test/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as { errors?: string[] } };
  };
  const stored = () => JSON.parse(readFileSync(file(), "utf8")) as { customTokens?: unknown[]; basketSymbols?: string[] };

  it("GET serves the basket without the symbol only the reserve supplied; the file keeps it", async () => {
    writeFileSync(file(), JSON.stringify({ customTokens: [RESERVE, CATE], basketSymbols: ["NVDA", "MERRYMEN", "CATE"] }));
    const v = await view();
    assert.deepEqual(v.customTokens, [CATE]);
    assert.deepEqual(v.basketSymbols, ["NVDA", "CATE"]);
    assert.deepEqual(stored().basketSymbols, ["NVDA", "MERRYMEN", "CATE"], "a read never rewrites");
  });

  it("GET keeps MERRYMEN in the basket when a lookalike at another address supplies it", async () => {
    writeFileSync(file(), JSON.stringify({ customTokens: [RESERVE, NAMESAKE], basketSymbols: ["MERRYMEN", "NVDA"] }));
    assert.deepEqual((await view()).basketSymbols, ["MERRYMEN", "NVDA"]);
  });

  it("ADD A TOKEN FROM THE SERVED VIEW (Settings add, Proposals approve, iOS, Android): saved, not refused", async () => {
    writeFileSync(file(), JSON.stringify({ customTokens: [RESERVE, CATE], basketSymbols: ["NVDA", "MERRYMEN", "CATE"] }));
    const v = await view();
    const r = await put({ customTokens: [...(v.customTokens ?? []), DOGE2], basketSymbols: [...(v.basketSymbols ?? []), "DOGE2"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(stored().basketSymbols, ["NVDA", "CATE", "DOGE2"]);
  });

  it("A CLIENT ON AN OLDER VIEW that still sends MERRYMEN in the basket: the reserve's symbol is dropped, the rest saved", async () => {
    writeFileSync(file(), JSON.stringify({ customTokens: [RESERVE, CATE], basketSymbols: ["NVDA", "MERRYMEN", "CATE"] }));
    const r = await put({ customTokens: [CATE, DOGE2], basketSymbols: ["NVDA", "MERRYMEN", "CATE", "DOGE2"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(stored().basketSymbols, ["NVDA", "CATE", "DOGE2"]);
  });

  it("REMOVE A TOKEN, THEN TOGGLE A CHIP: both saves go through — the basket stays editable", async () => {
    writeFileSync(file(), JSON.stringify({ customTokens: [RESERVE, CATE, FOO], basketSymbols: ["NVDA", "MERRYMEN", "CATE"] }));
    const v = await view();
    // Settings.tsx removeToken(FOO): the served list minus FOO, tokens only.
    const r1 = await put({ customTokens: (v.customTokens ?? []).filter((t) => t.address !== FOO.address) });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    // The stored basket outlived its reserve entry; a stale view still names it.
    const r2 = await put({ basketSymbols: ["MERRYMEN", "CATE"] });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(stored().basketSymbols, ["CATE"]);
    // And what the next GET serves round-trips cleanly.
    const again = await view();
    assert.deepEqual(again.basketSymbols, ["CATE"]);
    assert.equal((await put({ basketSymbols: again.basketSymbols, customTokens: again.customTokens })).status, 200);
  });

  it("a symbol nothing supplies that is NOT the reserve's is still refused", async () => {
    writeFileSync(file(), JSON.stringify({ customTokens: [RESERVE, CATE], basketSymbols: ["CATE"] }));
    const r = await put({ basketSymbols: ["CATE", "NOPE"] });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errors, ["basketSymbols: unknown symbols NOPE"]);
  });
});
