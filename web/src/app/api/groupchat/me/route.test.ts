/**
 * AN OWNER'S ROOM SETTINGS, DRIVEN THROUGH THE REAL HANDLERS.
 *
 * Same harness as ../route.test.ts: real session cookies, the file-backed grant
 * and identity stores under a temporary home, and the room's real SQL on an
 * in-memory sqlite through the ledger's driver. The property that matters most
 * here is the one a browser can silently break: an owner's chosen zone is never
 * replaced by whatever zone their laptop happens to be in.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { agentNameForSlug, type StoredGrant } from "@merrymen/core";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { wrapSqlite, type Db } from "../../../../../../worker/src/db";
import { getGrantStore, resetGrantStoreForTest } from "../../../../../../worker/src/grant-store";
import { getIdentityStore, resetIdentityStoreForTest } from "../../../../../../worker/src/identity-store";
import { fmtHm, sleepWindow } from "../../../../../../worker/src/groupchat/clock";
import { ensureGroupchatSchema, getMember, setMemberPrefs } from "../../../../../../worker/src/groupchat/store";
import type { MeResponse } from "../../../../../../worker/src/groupchat/types";
import { setRoomForTest } from "../room";
import { GET, POST } from "./route";

const ORIGIN = "https://app.merrymen.dev";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const D = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
/** Signed in, no grant. */
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const SA_A = "0x00000000000000000000000000000000000000a1" as const;
const SA_D = "0x00000000000000000000000000000000000000d4" as const;

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK", "MERRYMEN_GROUPCHAT"].map((k) => [
    k,
    process.env[k],
  ]),
);
let home: string;
let slugA: string;
let slugD: string;

function grantFor(smartAccount: `0x${string}`): StoredGrant {
  return {
    smartAccount,
    owner: "0x0000000000000000000000000000000000000fee",
    sessionKeyAddress: "0x0000000000000000000000000000000000000abc",
    serialized: "not-a-permission-account",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 },
    grantedAt: 1,
    expiresAt: 4_000_000_000,
    chainId: 4663,
    demoSessionPrivateKey: `0x${"1".repeat(64)}`,
  } as unknown as StoredGrant;
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-groupchat-me-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "groupchat-me-test-secret-at-least-32-characters";
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_STORE_DEK;
  resetGrantStoreForTest();
  resetIdentityStoreForTest();
  await getGrantStore().put(A, grantFor(SA_A));
  await getGrantStore().put(D, grantFor(SA_D));
  slugA = (await getIdentityStore().ensure(A, SA_A)).slug;
  slugD = (await getIdentityStore().ensure(D, SA_D)).slug;
});

after(() => {
  setRoomForTest(null);
  mock.restoreAll();
  resetGrantStoreForTest();
  resetIdentityStoreForTest();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let raw: DatabaseSync;
let db: Db;

beforeEach(async () => {
  process.env.MERRYMEN_HOSTED = "1";
  delete process.env.MERRYMEN_GROUPCHAT;
  raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT)");
  raw.prepare("INSERT INTO agents (smart_account, name) VALUES (?, ?)").run(SA_A, "Kestrel");
  db = wrapSqlite(raw);
  await ensureGroupchatSchema(db, "sqlite");
  // Every write a distinct instant, so "wrote nothing" is visible in updated_at_ms.
  let tick = 1_000_000;
  setRoomForTest({ db, now: () => (tick += 1000) });
});

afterEach(() => {
  setRoomForTest(null);
  mock.restoreAll();
  try {
    raw.close();
  } catch {
    /* already closed by the test */
  }
});

const headers = (tenant: string | null): Record<string, string> =>
  tenant ? { cookie: `${SESSION_COOKIE}=${mintSession(tenant as `0x${string}`)}` } : {};

const get = (tenant: string | null) => GET(new Request(`${ORIGIN}/api/groupchat/me`, { headers: headers(tenant) }));

const post = (tenant: string | null, body: unknown, raw = false) =>
  POST(
    new Request(`${ORIGIN}/api/groupchat/me`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers(tenant) },
      body: raw ? String(body) : JSON.stringify(body),
    }),
  );

async function me(res: Response): Promise<MeResponse> {
  const body = (await res.json()) as MeResponse & { error?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  return body;
}

const hoursOf = (tenant: string) => {
  const w = sleepWindow(tenant.toLowerCase());
  return { from: fmtHm(w.startMin), to: fmtHm(w.endMin) };
};

describe("hosted only", () => {
  it("404 for both verbs on a self-hosted install", async () => {
    delete process.env.MERRYMEN_HOSTED;
    assert.equal((await get(A)).status, 404);
    assert.equal((await post(A, { muted: true })).status, 404);
  });

  it("MERRYMEN_GROUPCHAT=0 on the web answers both verbs exactly like self-hosted, and writes nothing", async () => {
    const verbs = [() => get(A), () => get(null), () => post(A, { muted: true }), () => post(A, { tz: "Europe/London", source: "browser" })];
    const answer = async (res: Response) => [res.status, res.headers.get("cache-control"), await res.text()];
    delete process.env.MERRYMEN_HOSTED;
    const selfHosted: unknown[][] = [];
    for (const verb of verbs) selfHosted.push(await answer(await verb()));
    assert.deepEqual(selfHosted.map((a) => a[0]), [404, 404, 404, 404]);
    process.env.MERRYMEN_HOSTED = "1";
    for (const off of ["0", " 0 ", "0\n"]) {
      process.env.MERRYMEN_GROUPCHAT = off;
      for (const [i, verb] of verbs.entries()) {
        assert.deepEqual(await answer(await verb()), selfHosted[i], `${JSON.stringify(off)}, verb #${i}`);
      }
    }
    assert.equal(await getMember(db, A), null, "nothing was written");
    process.env.MERRYMEN_GROUPCHAT = "1";
    assert.equal((await get(A)).status, 200);
  });
});

/**
 * Also swept by app/prerender.test.ts, which recognises a route that reaches
 * the database through ../room. Kept here too, beside the route: a prerendered
 * /me would be built where there is no DATABASE_URL.
 */
describe("never prerendered", () => {
  const code = readFileSync(new URL("./route.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("is dynamic, never revalidated, and runs on node", () => {
    assert.match(code, /export const dynamic = "force-dynamic"/);
    assert.match(code, /export const runtime = "nodejs"/);
    assert.doesNotMatch(code, /export const revalidate/);
  });
});

describe("GET /me", () => {
  it("signed out is a complete, private answer", async () => {
    assert.deepEqual(await me(await get(null)), {
      signedIn: false,
      member: false,
      slug: null,
      name: null,
      tz: null,
      tzSource: null,
      muted: false,
      sleep: null,
    });
  });

  it("an owner with an agent is a member, named as the room names their agent; no zone means no sleep", async () => {
    assert.deepEqual(await me(await get(A)), {
      signedIn: true,
      member: true,
      slug: slugA,
      name: "Kestrel",
      tz: null,
      tzSource: null,
      muted: false,
      sleep: null,
    });
  });

  it("an agent with no ledger row yet gets the slug's generated name", async () => {
    assert.equal((await me(await get(D))).name, agentNameForSlug(slugD));
  });

  it("signed in without a Merryman is not a member", async () => {
    const answer = await me(await get(C));
    assert.equal(answer.signedIn, true);
    assert.equal(answer.member, false);
    assert.equal(answer.slug, null);
    assert.equal(answer.name, null);
  });

  it("the sleep hours are clock.sleepWindow of the lowercased tenant, for each owner", async () => {
    await setMemberPrefs(db, A, { tz: "America/New_York", tzSource: "owner" }, 1);
    await setMemberPrefs(db, D, { tz: "Asia/Tokyo", tzSource: "browser" }, 1);
    const a = await me(await get(A));
    const d = await me(await get(D));
    assert.deepEqual(a.sleep, hoursOf(A));
    assert.deepEqual(d.sleep, hoursOf(D));
    assert.equal(a.tz, "America/New_York");
    assert.equal(d.tzSource, "browser");
  });

  it("a stored zone the clock cannot run shows no hours, because the agent never sleeps", async () => {
    raw.prepare("INSERT INTO groupchat_members (tenant, tz, tz_source, muted, joined_at_ms, updated_at_ms) VALUES (?, ?, 'owner', 0, 0, 1)").run(A, "Mars/Olympus_Mons");
    const answer = await me(await get(A));
    assert.equal(answer.tz, "Mars/Olympus_Mons");
    assert.equal(answer.sleep, null);
  });

  it("503 when the room cannot be read, never a false 'not a member'", async () => {
    raw.close();
    assert.equal((await get(A)).status, 503);
    setRoomForTest(null);
    assert.equal((await get(A)).status, 503, "no shared database at all");
  });
});

describe("POST /me: the zone", () => {
  it("a browser capture is recorded, canonicalised, and the hours come back with it", async () => {
    const answer = await me(await post(A, { tz: "  Europe/London ", source: "browser" }));
    assert.equal(answer.tz, "Europe/London");
    assert.equal(answer.tzSource, "browser");
    assert.deepEqual(answer.sleep, hoursOf(A));
    assert.equal((await getMember(db, A))?.tz, "Europe/London");
  });

  it("A BROWSER CAPTURE NEVER OVERWRITES THE OWNER'S CHOICE", async () => {
    await me(await post(A, { tz: "Asia/Tokyo", source: "owner" }));
    const updated = (await getMember(db, A))!.updatedAtMs;
    const answer = await me(await post(A, { tz: "Europe/Paris", source: "browser" }));
    assert.equal(answer.tz, "Asia/Tokyo");
    assert.equal(answer.tzSource, "owner");
    const row = (await getMember(db, A))!;
    assert.equal(row.tz, "Asia/Tokyo");
    assert.equal(row.updatedAtMs, updated, "the capture wrote nothing");
    // The owner can still change their own mind.
    assert.equal((await me(await post(A, { tz: "Europe/Paris", source: "owner" }))).tz, "Europe/Paris");
  });

  it("A BROWSER THAT SAYS UTC IS NOT PLACED: UTC under any name and every Etc/* zone are dropped, never stored", async () => {
    // What Tor Browser and Firefox's resistFingerprinting report to everybody.
    const hiding = ["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Universal", "Zulu", " utc ", "etc/gmt+5", "Etc/GMT-14", "UCT", "Greenwich", "Etc/Zulu"];
    for (const tz of hiding) {
      const answer = await me(await post(A, { tz, source: "browser" }));
      assert.equal(answer.tz, null, tz);
      assert.equal(answer.sleep, null, "an agent whose owner's zone is unknown never sleeps");
    }
    assert.equal(await getMember(db, A), null, "not even a row was created");
    // A zone a browser reported before is kept, untouched.
    await me(await post(A, { tz: "Asia/Tokyo", source: "browser" }));
    const updated = (await getMember(db, A))!.updatedAtMs;
    for (const tz of hiding) {
      const answer = await me(await post(A, { tz, source: "browser" }));
      assert.equal(answer.tz, "Asia/Tokyo", tz);
      assert.equal(answer.tzSource, "browser");
    }
    assert.equal((await getMember(db, A))!.updatedAtMs, updated, "the captures wrote nothing");
    // Dropping the zone does not drop the rest of the request.
    assert.equal((await me(await post(A, { tz: "UTC", source: "browser", muted: true }))).muted, true);
    assert.equal((await getMember(db, A))!.tz, "Asia/Tokyo");
    // A real place that happens to sit on UTC is a place.
    assert.equal((await me(await post(A, { tz: "Africa/Abidjan", source: "browser" }))).tz, "Africa/Abidjan");
  });

  it("A BROWSER THAT SAYS REYKJAVIK IS NOT PLACED EITHER: what Tor Browser 13.5+, Mullvad Browser and resistFingerprinting report now", async () => {
    // Tor Browser spoofs Atlantic/Reykjavik since 13.5 (Bug 42397); Mullvad
    // Browser is built on it; Mozilla's RFP page says "UTC or Icelandic".
    // "Iceland" is the alias Intl resolves to the same zone.
    for (const tz of ["Atlantic/Reykjavik", "Iceland", "atlantic/reykjavik", " ICELAND "]) {
      const answer = await me(await post(A, { tz, source: "browser" }));
      assert.equal(answer.tz, null, tz);
      assert.equal(answer.sleep, null, "an agent whose owner's zone is unknown never sleeps");
    }
    assert.equal(await getMember(db, A), null, "not even a row was created");
    await me(await post(A, { tz: "Asia/Tokyo", source: "browser" }));
    const updated = (await getMember(db, A))!.updatedAtMs;
    assert.equal((await me(await post(A, { tz: "Iceland", source: "browser" }))).tz, "Asia/Tokyo");
    assert.equal((await getMember(db, A))!.updatedAtMs, updated, "the capture wrote nothing");
    // An owner in Iceland picks it on the chat screen, and keeps it.
    const picked = await me(await post(A, { tz: "Atlantic/Reykjavik", source: "owner" }));
    assert.equal(picked.tz, "Atlantic/Reykjavik");
    assert.equal(picked.tzSource, "owner");
    assert.deepEqual(picked.sleep, hoursOf(A));
    assert.equal((await getMember(db, A))?.tz, "Atlantic/Reykjavik");
  });

  it("an owner who PICKS UTC, or an Etc/* zone, on the chat screen keeps it", async () => {
    const utc = await me(await post(A, { tz: "UTC", source: "owner" }));
    assert.equal(utc.tz, "UTC");
    assert.equal(utc.tzSource, "owner");
    assert.deepEqual(utc.sleep, hoursOf(A));
    assert.equal((await me(await post(A, { tz: "Etc/GMT-3", source: "owner" }))).tz, "Etc/GMT-3");
    assert.equal((await getMember(db, A))?.tz, "Etc/GMT-3");
  });

  it("a later browser capture replaces an earlier one", async () => {
    await me(await post(A, { tz: "Asia/Tokyo", source: "browser" }));
    assert.equal((await me(await post(A, { tz: "Europe/Paris", source: "browser" }))).tz, "Europe/Paris");
  });

  it("the owner can clear their zone, and that choice holds against the browser too", async () => {
    await me(await post(A, { tz: "Asia/Tokyo", source: "owner" }));
    const cleared = await me(await post(A, { tz: null, source: "owner" }));
    assert.equal(cleared.tz, null);
    assert.equal(cleared.sleep, null);
    const after = await me(await post(A, { tz: "Europe/Paris", source: "browser" }));
    assert.equal(after.tz, null);
    assert.equal(after.tzSource, "owner");
  });

  it("a signed-in owner without a Merryman still has their zone kept for when they make one", async () => {
    const answer = await me(await post(C, { tz: "Europe/Berlin", source: "browser" }));
    assert.equal(answer.member, false);
    assert.equal(answer.tz, "Europe/Berlin");
    assert.equal((await getMember(db, C))?.joinedAtMs, 0, "a prefs row, not a join");
  });

  it("refuses what it cannot record", async () => {
    const cases: unknown[] = [
      { tz: "Mars/Olympus_Mons", source: "owner" },
      { tz: "+05:30", source: "owner" },
      { tz: "Europe/London" },
      { tz: "Europe/London", source: "guess" },
      { tz: null, source: "browser" },
      { tz: 7, source: "owner" },
      { muted: "yes" },
      {},
      [],
    ];
    for (const body of cases) assert.equal((await post(A, body)).status, 400, JSON.stringify(body));
    assert.equal((await post(A, "not json", true)).status, 400);
    assert.equal((await getMember(db, A)), null, "nothing refused was written");
  });

  it("401 signed out; 413 for a body far larger than any setting", async () => {
    assert.equal((await post(null, { tz: "Europe/London", source: "browser" })).status, 401);
    assert.equal((await post(A, JSON.stringify({ tz: "Europe/London", source: "owner", pad: "x".repeat(2000) }), true)).status, 413);
  });
});

describe("POST /me: mute", () => {
  it("mutes and unmutes without touching the zone", async () => {
    await me(await post(A, { tz: "Asia/Tokyo", source: "owner" }));
    const muted = await me(await post(A, { muted: true }));
    assert.equal(muted.muted, true);
    assert.equal(muted.tz, "Asia/Tokyo");
    assert.equal(muted.tzSource, "owner");
    assert.equal((await me(await post(A, { muted: false }))).muted, false);
  });

  it("503 when the room cannot take the write", async () => {
    raw.close();
    assert.equal((await post(A, { muted: true })).status, 503);
  });
});
