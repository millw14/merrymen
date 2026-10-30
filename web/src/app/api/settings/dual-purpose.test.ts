/**
 * ONE LOGIN, TWO WALLETS, TWO SETS OF SETTINGS — and neither reaches the other.
 *
 * `/api/settings?wallet=perps` reads and writes the Perps wallet's own
 * settings (its store hosted, accounts/perps/settings.json self-hosted); no
 * `?wallet=`, or `spot`, is the Spot wallet's, exactly as before. Driven
 * through the real handlers:
 *   - each wallet keeps its own values, and a Perps save cannot move the Spot
 *     wallet's strategy (or its own off perps-only);
 *   - an unreadable `?wallet=`, another session and no session are refused
 *     before anything is read or written;
 *   - a Perps save never takes, settles or releases the Spot wallet's
 *     Telegram bot claim (lib/telegram-claims.ts);
 *   - hosted, a Perps save takes its turn under the login's save lock, the
 *     one Spot's saves take, and writes nothing while another save holds it;
 *   - WHERE PERPS ARE NOT OFFERED (MERRYMEN_PERPS unset), a Perps save may
 *     only turn things off, hosted and self-hosted (D1, D19): everything else
 *     is refused 403 with nothing written, and the GET still answers.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { SETTINGS_SAVE_LOCK, settingsSaveLockKey, useBotClaimsDbForTest, withSettingsSaveLock } from "@/lib/telegram-claims";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { advisoryLockWaitersForTest, wrapSqlite, type Db } from "../../../../../worker/src/db";
import { readBotClaims } from "../../../../../worker/src/telegram-claims";

const OWNER = `0x${"aa".repeat(20)}` as const;
const OTHER = `0x${"bb".repeat(20)}` as const;
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_PERPS_PAPER_TENANTS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const getMeAsked: string[] = [];
let home: string;
let GET: (r: Request) => Promise<Response>;
let PUT: (r: Request) => Promise<Response>;

/** `query` is the URL's query ("" is no `?wallet=`); `tenant` the session, or none. */
function request(query: string, body?: object, tenant: `0x${string}` | null = OWNER) {
  return new Request(`https://app.example.test/api/settings${query}`, {
    method: body ? "PUT" : "GET",
    headers: { "content-type": "application/json", ...(tenant ? { cookie: `mm_session=${mintSession(tenant)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { errors?: string[]; ignored?: string[]; saved?: string[]; code?: string };

async function currentVersion(tenant: `0x${string}` | null = OWNER): Promise<string> {
  const view = await json(await GET(request("?wallet=perps", undefined, tenant)));
  assert.equal(typeof view.version, "string");
  return view.version as string;
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-dual-settings-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  // getMe, for the Spot wallet's bot claim: any `<id>:<secret>` answers for bot <id>.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/api\.telegram\.org\/bot(.+)\/getMe$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    getMeAsked.push(m[1]!);
    const id = /^(\d+):/.exec(m[1]!)?.[1];
    return Response.json(id ? { ok: true, result: { id: Number(id), is_bot: true, username: `bot${id}` } } : { ok: false, error_code: 401 });
  }) as typeof fetch;
  ({ GET, PUT } = await import("./route"));
});
beforeEach(() => {
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_PERPS = "paper";
  process.env.MERRYMEN_PERPS_PAPER_TENANTS = `${OWNER},${OTHER}`;
  resetSettingsStoreForTest();
  for (const d of ["tenant-settings", "tenant-settings-perps", "accounts"]) rmSync(path.join(home, d), { recursive: true, force: true });
  rmSync(path.join(home, "settings.json"), { force: true });
});
afterEach(() => useBotClaimsDbForTest(null));
after(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSettingsStoreForTest();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("each wallet keeps its own settings", () => {
  it("one session saves independent limits, and a Perps save cannot set a Spot strategy", async () => {
    assert.equal((await PUT(request("", { owner: OWNER, strategy: "trencher", slippageBps: 150 }))).status, 200);
    assert.equal((await PUT(request("?wallet=perps", { owner: OWNER, expectedVersion: await currentVersion(), perpsMaxCollateralUsdg: 20, perpsEnabled: true }))).status, 200);
    assert.equal((await getSettingsStore("spot").get(OWNER))?.strategy, "trencher");
    assert.equal((await getSettingsStore("spot").get(OWNER))?.perpsMaxCollateralUsdg, undefined, "the Perps wallet's number never lands on Spot");
    assert.equal((await getSettingsStore("perps").get(OWNER))?.perpsMaxCollateralUsdg, 20);
    assert.equal((await getSettingsStore("perps").get(OWNER))?.strategy, "perps-only");
    assert.equal((await getSettingsStore("perps").get(OWNER))?.slippageBps, undefined, "and Spot's never on Perps");
    const view = await json(await GET(request("?wallet=perps")));
    assert.equal(view.owner, OWNER);
    assert.deepEqual(view.strategies, { builtin: ["perps-only"], custom: [] });
    assert.equal((view.values as Record<string, unknown>).perpsMaxCollateralUsdg, 20);
    // Spot's GET is Spot's, unchanged: its own strategy, and no Perps number.
    const spot = await json(await GET(request("")));
    assert.equal((spot.values as Record<string, unknown>).strategy, "trencher");
    assert.equal((spot.values as Record<string, unknown>).perpsMaxCollateralUsdg, undefined);
    // A Spot strategy sent to the Perps wallet is refused; the off beside it is still saved.
    const refused = await PUT(request("?wallet=perps", { owner: OWNER, strategy: "trencher", perpsEnabled: false }));
    assert.equal(refused.status, 400);
    assert.deepEqual((await json(refused)).saved, ["perpsEnabled"]);
    assert.equal((await getSettingsStore("perps").get(OWNER))?.perpsEnabled, false);
    assert.equal((await getSettingsStore("perps").get(OWNER))?.strategy, "perps-only");
    assert.equal((await getSettingsStore("spot").get(OWNER))?.strategy, "trencher");
  });

  it("an unreadable ?wallet=, another session and no session are refused before anything is read or written", async () => {
    await getSettingsStore("perps").put(OTHER, { strategy: "perps-only", perpsMaxLeverage: 2 });
    assert.equal((await PUT(request("?wallet=perps", { owner: OWNER, perpsMaxCollateralUsdg: 99 }, OTHER))).status, 409);
    assert.equal((await PUT(request("?wallet=perps", { owner: OWNER, perpsMaxCollateralUsdg: 99 }, null))).status, 401);
    for (const query of ["?wallet=other", "?wallet=perps&wallet=spot", "?wallet=", "?wallet=Perps"]) {
      const g = await GET(request(query));
      assert.equal(g.status, 400, query);
      assert.equal((await json(g)).code, "wallet-unknown", query);
      const p = await PUT(request(query, { owner: OWNER, perpsMaxCollateralUsdg: 99 }));
      assert.equal(p.status, 400, query);
      assert.equal((await json(p)).code, "wallet-unknown", query);
    }
    assert.equal(await getSettingsStore("perps").get(OWNER), null);
    assert.equal(await getSettingsStore("spot").get(OWNER), null);
    assert.deepEqual(await getSettingsStore("perps").get(OTHER), { strategy: "perps-only", perpsMaxLeverage: 2 });
    // A body that is not an object of settings is no save.
    for (const body of [null, [1], "perpsEnabled"]) {
      const res = await PUT(new Request("https://app.example.test/api/settings?wallet=perps", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: `mm_session=${mintSession(OWNER)}` },
        body: JSON.stringify(body),
      }));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(await getSettingsStore("perps").get(OWNER), null);
  });

  it("self-hosted, the Perps wallet writes its own home and never touches Spot's settings.json", async () => {
    delete process.env.MERRYMEN_HOSTED;
    assert.equal((await PUT(request("", { strategy: "steady-basket", slippageBps: 120 }, null))).status, 200);
    const spotFile = path.join(home, "settings.json");
    const before = readFileSync(spotFile, "utf8");
    assert.equal((await PUT(request("?wallet=perps", { expectedVersion: await currentVersion(null), perpsMaxCollateralUsdg: 25, perpsEnabled: true }, null))).status, 200);
    assert.equal(readFileSync(spotFile, "utf8"), before);
    const perpsFile = path.join(home, "accounts", "perps", "settings.json");
    assert.deepEqual(JSON.parse(readFileSync(perpsFile, "utf8")), { strategy: "perps-only", perpsMaxCollateralUsdg: 25, perpsEnabled: true });
    const view = await json(await GET(request("?wallet=perps", undefined, null)));
    assert.equal(view.owner, null);
    assert.equal((view.values as Record<string, unknown>).perpsMaxCollateralUsdg, 25);
    // A Perps file that will not read is refused, never rewritten from nothing, and the GET says so.
    writeFileSync(perpsFile, "{ broken");
    const put = await PUT(request("?wallet=perps", { perpsEnabled: false }, null));
    assert.equal(put.status, 409);
    assert.match((await json(put)).errors?.join(" ") ?? "", /Perps wallet's settings\.json is not valid JSON.*nothing was saved.*accounts\/perps\/settings\.json/);
    assert.equal(readFileSync(perpsFile, "utf8"), "{ broken");
    const get = await GET(request("?wallet=perps", undefined, null));
    assert.equal(get.status, 503);
    assert.equal((await json(get)).code, "settings-unreadable");
    assert.equal(readFileSync(spotFile, "utf8"), before);
  });
});

describe("a Perps save never touches the Spot wallet's bot claim", () => {
  let claims: Db;
  beforeEach(() => {
    claims = wrapSqlite(new DatabaseSync(":memory:"));
    useBotClaimsDbForTest(claims);
    getMeAsked.length = 0;
  });
  const held = async () => Object.fromEntries(await readBotClaims(claims));

  it("THE SPOT WALLET'S BOT STAYS CLAIMED, AND A TOKEN SENT TO PERPS IS NEITHER STORED NOR CLAIMED", async () => {
    assert.equal((await PUT(request("", { owner: OWNER, telegramBotToken: "111:AAA-first-secret", telegramAllowlist: [777] }))).status, 200);
    assert.deepEqual(await held(), { "111": OWNER });
    const asked = getMeAsked.length;
    // A Perps save with no token: run through Spot's claims it would settle
    // the login's claims to the token THIS store holds — none — and release
    // the bot for another account to take.
    const plain = await PUT(request("?wallet=perps", { owner: OWNER, expectedVersion: await currentVersion(), perpsEnabled: true, perpsMaxLeverage: 3 }));
    assert.equal(plain.status, 200, JSON.stringify(await json(plain.clone())));
    assert.deepEqual(await held(), { "111": OWNER }, "the Spot bot is still this login's");
    // A Perps save that carries a token: reported, never stored, never claimed, never asked about.
    const token = await PUT(request("?wallet=perps", { owner: OWNER, expectedVersion: await currentVersion(), telegramBotToken: "222:BBB-other-secret", moveBot: true, perpsEnabled: true }));
    assert.equal(token.status, 200);
    assert.deepEqual((await json(token)).ignored, ["telegramBotToken"]);
    assert.deepEqual(await held(), { "111": OWNER }, "bot 222 was not claimed");
    assert.equal(getMeAsked.length, asked, "Telegram was not asked about anything");
    assert.equal((await getSettingsStore("perps").get(OWNER))?.telegramBotToken, undefined);
    assert.equal((await getSettingsStore("spot").get(OWNER))?.telegramBotToken, "111:AAA-first-secret");
    // And another account still cannot take the Spot bot.
    assert.equal((await PUT(request("", { owner: OTHER, telegramBotToken: "111:CCC-reissued" }, OTHER))).status, 409);
    assert.deepEqual(await held(), { "111": OWNER });
  });
});

/**
 * A HOSTED PERPS SAVE TAKES THE LOGIN'S SAVE LOCK (lib/telegram-claims.ts
 * withSettingsSaveLock) — the one Spot's saves take, so one save at a time per
 * login across both wallets (the route's putPerps, docs/perps.md 5c).
 *
 * The compare-and-swap is what keeps a save from writing over a blob it never
 * read; the lock is what makes saves take turns, so that a save's three
 * judgements (PERPS_SAVE_ATTEMPTS) are only ever spent on the one writer that
 * takes no lock, the kill. Without it, saves for one login (two tabs, the
 * phone and the desktop) miss each other's swap, and enough of them at once
 * run out of attempts into a 503 nobody caused. Nothing read the lock before
 * this: putPerps could call savePerpsSettings bare and every settings suite
 * still passed.
 */
describe("a hosted Perps save takes the login's save lock", () => {
  let claims: Db;
  beforeEach(() => {
    claims = wrapSqlite(new DatabaseSync(":memory:"));
    useBotClaimsDbForTest(claims);
  });
  const waiters = (tenant: `0x${string}`) => advisoryLockWaitersForTest(claims, SETTINGS_SAVE_LOCK, settingsSaveLockKey(tenant));
  /** Wait for a state, polled each turn; failing only after a real-time bound. */
  const until = async (what: string, ok: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!ok()) {
      if (Date.now() > deadline) assert.fail(`never reached: ${what}`);
      await setImmediate();
    }
  };

  it("WHILE ANOTHER SAVE FOR THE LOGIN HOLDS IT, A PERPS SAVE WAITS ITS TURN AND WRITES NOTHING, then saves; another login's waits for nobody", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    // Another save for this login (a Spot save in another tab, say) has the turn.
    const holder = withSettingsSaveLock(OWNER, async () => {
      entered();
      await released;
      return "held";
    });
    await inside;
    let answered = false;
    const perpsSave = PUT(request("?wallet=perps", { owner: OWNER, expectedVersion: await currentVersion(), perpsEnabled: true, perpsMaxLeverage: 3 })).finally(() => {
      answered = true;
    });
    await until("the Perps save waiting for the login's lock", () => {
      if (answered) assert.fail("the Perps save was answered while another save for the login held the lock");
      return waiters(OWNER) === 1;
    });
    assert.equal(await getSettingsStore("perps").get(OWNER), null, "nothing written while another save has the turn");
    // The lock is the login's: another login's Perps save goes straight through.
    const other = await PUT(request("?wallet=perps", { owner: OTHER, expectedVersion: await currentVersion(OTHER), perpsEnabled: true }, OTHER));
    assert.equal(other.status, 200, JSON.stringify(await json(other.clone())));
    assert.equal(answered, false, "and this login's is still waiting");
    release();
    assert.equal(await holder, "held");
    const res = await perpsSave;
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
    assert.equal(waiters(OWNER), 0);
    const stored = await getSettingsStore("perps").get(OWNER);
    assert.equal(stored?.perpsEnabled, true);
    assert.equal(stored?.perpsMaxLeverage, 3);
  });
});

describe("where Perps are not offered, a Perps save may only turn things off (D1)", () => {
  beforeEach(() => {
    delete process.env.MERRYMEN_PERPS;
  });

  it("HOSTED: anything but an off is refused 403 with nothing written; an off is written; the GET still answers", async () => {
    for (const body of [{ perpsEnabled: true }, { perpsMaxLeverage: 3 }, { perpsMarkets: ["BTC-PERP"] }, { liveTradingEnabled: true }, { telegramEnabled: false }, { perpsMaxLeverage: 99 }]) {
      const res = await PUT(request("?wallet=perps", { owner: OWNER, ...body }));
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(res.headers.get("cache-control"), "private, no-store", `${JSON.stringify(body)}: answered as every wallet-aware route's not-offered refusal is`);
      const out = await json(res);
      assert.equal(out.code, "perps-wallet-not-offered", JSON.stringify(body));
      assert.match(out.errors?.join(" ") ?? "", /not offered on this server yet, so only switching perpetuals off can be saved for one\. Nothing was saved\./);
      assert.equal(await getSettingsStore("perps").get(OWNER), null, `${JSON.stringify(body)}: nothing written`);
    }
    // An off with nothing on to turn off: answered, and no Perps settings are made for it.
    const nothing = await PUT(request("?wallet=perps", { owner: OWNER, perpsEnabled: false, liveTradingEnabled: false }));
    assert.equal(nothing.status, 200);
    assert.equal(await getSettingsStore("perps").get(OWNER), null, "no Perps settings grown on a server that offers none");
    // An off with something to turn off: written, and only that.
    await getSettingsStore("perps").put(OWNER, { strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 2 });
    const off = await PUT(request("?wallet=perps", { owner: OWNER, perpsEnabled: false }));
    assert.equal(off.status, 200);
    assert.deepEqual((await json(off)).saved, ["perpsEnabled"]);
    assert.deepEqual(await getSettingsStore("perps").get(OWNER), { strategy: "perps-only", perpsEnabled: false, perpsMaxLeverage: 2 });
    // An off beside anything else: the off is written, the rest refused 403.
    await getSettingsStore("perps").put(OWNER, { strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 2 });
    const mixed = await PUT(request("?wallet=perps", { owner: OWNER, perpsEnabled: false, perpsMaxLeverage: 5 }));
    assert.equal(mixed.status, 403);
    assert.equal(mixed.headers.get("cache-control"), "private, no-store");
    const mixedOut = await json(mixed);
    assert.deepEqual(mixedOut.saved, ["perpsEnabled"]);
    assert.match(mixedOut.errors?.join(" ") ?? "", /Switched off \(perpsEnabled\) — that was saved\. Nothing else was\./);
    assert.deepEqual(await getSettingsStore("perps").get(OWNER), { strategy: "perps-only", perpsEnabled: false, perpsMaxLeverage: 2 });
    // The GET answers whatever MERRYMEN_PERPS says: an owner can see the wallet to switch it off.
    const view = await GET(request("?wallet=perps"));
    assert.equal(view.status, 200);
    assert.equal(((await json(view)).values as Record<string, unknown>).perpsEnabled, false);
    // And the Spot wallet's settings are Spot's, whatever the lever.
    assert.equal((await PUT(request("", { owner: OWNER, slippageBps: 150 }))).status, 200);
  });

  it("SELF-HOSTED MATCHES HOSTED (D19): nothing but an off is written into the Perps home", async () => {
    delete process.env.MERRYMEN_HOSTED;
    const perpsFile = path.join(home, "accounts", "perps", "settings.json");
    const res = await PUT(request("?wallet=perps", { perpsEnabled: true, perpsMaxLeverage: 3 }, null));
    assert.equal(res.status, 403);
    assert.equal(existsSync(path.join(home, "accounts")), false, "no Perps home made for a wallet the server does not offer");
    mkdirSync(path.dirname(perpsFile), { recursive: true });
    writeFileSync(perpsFile, JSON.stringify({ strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 2 }));
    const off = await PUT(request("?wallet=perps", { perpsEnabled: false }, null));
    assert.equal(off.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(perpsFile, "utf8")), { strategy: "perps-only", perpsEnabled: false, perpsMaxLeverage: 2 });
    assert.equal((await PUT(request("?wallet=perps", { perpsEnabled: true }, null))).status, 403);
    assert.equal(JSON.parse(readFileSync(perpsFile, "utf8")).perpsEnabled, false);
    assert.equal((await GET(request("?wallet=perps", undefined, null))).status, 200);
  });
});


describe("paper entry activation requires current owner revision and pilot admission", () => {
  it("refuses missing, foreign and stale revisions without writing risk fields", async () => {
    const before = await currentVersion();
    assert.match(before, /^[a-f0-9]{64}$/);
    for (const expectedVersion of [undefined, null, "guessed", await currentVersion(OTHER)]) {
      const res = await PUT(request("?wallet=perps", {owner: OWNER, perpsEnabled: true, expectedVersion, perpsMaxLeverage: 3}));
      assert.equal(res.status,409);assert.equal(await getSettingsStore("perps").get(OWNER),null);
    }
    await getSettingsStore("perps").put(OWNER,{perpsEnabled:false,perpsMaxLeverage:2});
    assert.equal((await PUT(request("?wallet=perps",{owner:OWNER,perpsEnabled:true,expectedVersion:before}))).status,409);
    const fresh=await currentVersion();
    assert.equal((await PUT(request("?wallet=perps",{owner:OWNER,perpsEnabled:true,expectedVersion:fresh}))).status,200);
    assert.equal((await getSettingsStore("perps").get(OWNER))?.perpsEnabled,true);
  });
  it("a current revision cannot bypass an absent or malformed pilot list, but off remains available", async () => {
    await getSettingsStore("perps").put(OWNER,{perpsEnabled:false});
    for(const list of [undefined,OTHER,`${OWNER},bad`]) {
      if(list===undefined) delete process.env.MERRYMEN_PERPS_PAPER_TENANTS; else process.env.MERRYMEN_PERPS_PAPER_TENANTS=list;
      const res=await PUT(request("?wallet=perps",{owner:OWNER,perpsEnabled:true,expectedVersion:await currentVersion()}));
      assert.equal(res.status,403);assert.equal((await getSettingsStore("perps").get(OWNER))?.perpsEnabled,false);
      assert.equal((await PUT(request("?wallet=perps",{owner:OWNER,perpsEnabled:false}))).status,200);
    }
  });
  it("the worker control nonce cannot be supplied or cleared by an owner save", async()=>{
    await getSettingsStore("perps").put(OWNER,{perpsEnabled:false,perpsControlNonce:"server-generation"});
    const res=await PUT(request("?wallet=perps",{owner:OWNER,perpsMaxLeverage:3,perpsControlNonce:"forged"}));
    assert.equal(res.status,200);assert.equal((await getSettingsStore("perps").get(OWNER))?.perpsControlNonce,"server-generation");
    const out=await json(await GET(request("?wallet=perps")));assert.ok(!JSON.stringify(out).includes("server-generation"));
  });
});
