/**
 * ONE BOT, ONE TENANT — through the real settings PUT.
 *
 * In the incident this came from, a second login saved the owner's bot token,
 * the save said "Changes saved", and from then on two agents fought over one
 * bot. Now the save claims the bot: another account's bot is refused with a
 * 409 that names nobody, "Move it here" re-sends the save with `moveBot`, and a
 * move needs Telegram to vouch for the token. A move carries nothing across:
 * the account the bot leaves keeps its settings, and the account it joins
 * keeps its own allowlist and links the bot with its own code.
 *
 * Hosted, over the file settings store and no DATABASE_URL, as
 * owner.test.ts runs; the bot claims are kept in node:sqlite through the
 * route's own seam, and getMe is a stubbed fetch.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { BOT_CLAIMED_TEXT, NOT_A_BOT_TOKEN_TEXT, SETTINGS_SAVE_LOCK, settingsSaveLockKey, useBotClaimsDbForTest } from "@/lib/telegram-claims";
import { getSettingsStore, resetSettingsStoreForTest, useSettingsStoreForTest } from "@merrymen/settings-store";
import { advisoryLockWaitersForTest, wrapSqlite, type Db } from "../../../../../worker/src/db";
import { readBotClaims } from "../../../../../worker/src/telegram-claims";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let dir: string;
let PUT: (req: Request) => Promise<Response>;
let claims: Db;
/** Tokens getMe refuses (revoked, mistyped); any other `<id>:<secret>` answers for bot <id>. */
let refused = new Set<string>();
const getMeAsked: string[] = [];

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-bot-claim-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/api\.telegram\.org\/bot(.+)\/getMe$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const token = m[1]!;
    getMeAsked.push(token);
    const id = /^(\d+):/.exec(token)?.[1];
    return Response.json(id && !refused.has(token) ? { ok: true, result: { id: Number(id), is_bot: true, username: `bot${id}` } } : { ok: false, error_code: 401 });
  }) as typeof fetch;
  ({ PUT } = await import("./route"));
});
beforeEach(() => {
  claims = wrapSqlite(new DatabaseSync(":memory:"));
  useBotClaimsDbForTest(claims);
  refused = new Set();
  getMeAsked.length = 0;
  resetSettingsStoreForTest();
  rmSync(path.join(dir, "tenant-settings"), { recursive: true, force: true });
});
after(() => {
  globalThis.fetch = realFetch;
  useBotClaimsDbForTest(null);
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function put(session: `0x${string}`, body: Record<string, unknown>) {
  const res = await PUT(
    new Request("https://app.example.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `mm_session=${mintSession(session)}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; errors?: string[]; botMoved?: boolean; ignored?: string[] } };
}
const held = async () => Object.fromEntries(await readBotClaims(claims));

describe("PUT /api/settings claims the bot", () => {
  it("A SECOND ACCOUNT SAVING THE SAME BOT GETS 409 bot_claimed, NAMING NOBODY, AND NOTHING IS SAVED", async () => {
    assert.equal((await put(A, { telegramBotToken: "111:AAA-first-secret", telegramAllowlist: [777] })).status, 200);
    assert.deepEqual(await held(), { "111": A });
    // A re-issued secret for the same bot: the same bot.
    const res = await put(B, { telegramBotToken: "111:BBB-reissued-secret", telegramEnabled: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "bot_claimed");
    assert.deepEqual(res.body.errors, [BOT_CLAIMED_TEXT]);
    assert.ok(!JSON.stringify(res.body).includes(A.slice(2)), "the other account is not identified");
    assert.equal(await getSettingsStore().get(B), null, "a refusal writes nothing");
    assert.deepEqual(await held(), { "111": A });
  });

  it("A TOKEN TELEGRAM REFUSES IS SAVED AS TYPED AND CLAIMS NOTHING — a bot id alone takes no bot, and learns nothing", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret" });
    // Anyone signed in can type another bot's public id with a made-up secret.
    refused.add("111:guessed-secret");
    const res = await put(B, { telegramBotToken: "111:guessed-secret" });
    assert.equal(res.status, 200, "the same answer it would get for a free bot");
    assert.equal(res.body.error, undefined);
    assert.deepEqual(await held(), { "111": A }, "the owner keeps the bot");
    assert.ok(getMeAsked.includes("111:guessed-secret"), "Telegram was asked before any claim");
  });

  it("A TOKEN THAT COULD STEER THE getMe URL IS REFUSED (400), NEVER SENT, AND MOVES NOTHING", async () => {
    // `111:x/../../bot<own>/getChat?chat_id=111&z=` read as bot 111, fetch
    // resolved it into a call on the sender's own bot, and that answer, id
    // 111, "confirmed" them as bot 111's owner: a 409 that told them the bot
    // was a Merrymen agent's, and with moveBot, the bot.
    await put(A, { telegramBotToken: "111:AAA-first-secret", telegramAllowlist: [777] });
    getMeAsked.length = 0;
    for (const crafted of [
      "111:x/../../bot999:own-secret/getChat?chat_id=111&z=",
      "111:x/../../file/bot999:own-secret/documents/file_0.json#",
    ]) {
      for (const move of [{}, { moveBot: true }]) {
        const res = await put(B, { telegramBotToken: crafted, ...move });
        assert.equal(res.status, 400, `${crafted} ${JSON.stringify(move)}`);
        assert.deepEqual(res.body.errors, [`telegramBotToken: ${NOT_A_BOT_TOKEN_TEXT}`]);
        assert.equal(res.body.error, undefined, "no bot_claimed to say whether the bot is held");
      }
    }
    assert.deepEqual(getMeAsked, [], "nothing was sent to Telegram");
    assert.deepEqual(await held(), { "111": A }, "the owner keeps the bot");
    assert.equal(await getSettingsStore().get(B), null, "and nothing was saved");
    // A real token, pasted with the spaces a copy picks up, still saves.
    assert.equal((await put(B, { telegramBotToken: "  222:AAH_dq-Tc  " })).status, 200);
    assert.equal((await getSettingsStore().get(B))?.telegramBotToken, "222:AAH_dq-Tc");
  });

  it("MOVE IT HERE: getMe must confirm the token, the claim moves, and no allowlist or owner comes with it", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret", telegramAllowlist: [777] });
    // B's own settings, saved before: its own allowlist.
    await put(B, { telegramAllowlist: [4242] });
    // Telegram does not vouch for the token: nothing moves, and nothing is saved.
    refused.add("111:BBB-reissued-secret");
    const unvouched = await put(B, { telegramBotToken: "111:BBB-reissued-secret", moveBot: true });
    assert.equal(unvouched.status, 409);
    assert.equal(unvouched.body.error, "bot_unconfirmed");
    assert.deepEqual(await held(), { "111": A });
    assert.equal((await getSettingsStore().get(B))?.telegramBotToken, undefined);

    refused.delete("111:BBB-reissued-secret");
    const moved = await put(B, { telegramBotToken: "111:BBB-reissued-secret", moveBot: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.botMoved, true);
    assert.equal(moved.body.ignored, undefined, "`moveBot` is not a setting, and not reported as one");
    assert.deepEqual(await held(), { "111": B });
    const b = (await getSettingsStore().get(B)) as Record<string, unknown>;
    assert.equal(b.telegramBotToken, "111:BBB-reissued-secret");
    assert.deepEqual(b.telegramAllowlist, [4242], "B's own allowlist, untouched: not A's, not merged, not cleared");
    assert.equal("moveBot" in b, false);
    assert.equal("ownerId" in b, false);
    const a = (await getSettingsStore().get(A)) as Record<string, unknown>;
    assert.equal(a.telegramBotToken, "111:AAA-first-secret", "the account it left keeps what its owner saved");
    assert.deepEqual(a.telegramAllowlist, [777]);
  });

  it("A SAVE THAT FAILS TAKES ITS CLAIM BACK", async () => {
    const real = getSettingsStore();
    const failing = Object.create(real) as typeof real;
    failing.put = async () => {
      throw new Error("store down");
    };
    useSettingsStoreForTest(failing);
    await assert.rejects(put(A, { telegramBotToken: "111:AAA-first-secret" }), /store down/);
    assert.deepEqual(await held(), {}, "no claim for a token that was never stored");
  });

  it("CLEARING THE TOKEN LETS GO OF THIS ACCOUNT'S CLAIM, AND ONLY ITS OWN", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret" });
    await put(B, { telegramBotToken: "222:BBB-own-bot" });
    assert.equal((await put(B, { telegramBotToken: "" })).status, 200);
    assert.deepEqual(await held(), { "111": A });
    // Now free, the bot can be saved by B with no move.
    assert.equal((await put(B, { telegramBotToken: "222:BBB-own-bot" })).status, 200);
    assert.deepEqual(await held(), { "111": A, "222": B });
  });

  it("A SAVE THAT DOES NOT CARRY THE TOKEN ASKS NOTHING — even for an account whose bot is held elsewhere", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret" });
    await getSettingsStore().put(B, { telegramBotToken: "111:BBB-from-before-claims" });
    const res = await put(B, { telegramEnabled: true, buyPerTickUsdg: 5 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await held(), { "111": A });
  });
});

/**
 * SAVES FOR ONE ACCOUNT TAKE TURNS (lib/telegram-claims.ts withSettingsSaveLock).
 *
 * Each save reads the whole settings blob, changes its fields and writes it
 * all back, and a token save claims its bot before the write and settles or
 * takes it back after. Two at once for one account (two tabs, a double click)
 * used to overlap: a save of the allowlist that read before a token save
 * wrote put the old token back, and a double-clicked "Move it here" whose
 * first write failed handed the bot back to the other account after the
 * second click's save had landed and said "saved". Now the second save waits
 * for the first to finish, reads what it stored, and decides on what it left.
 *
 * A store whose put, call by call, arrives, then waits to be told to write,
 * to fail, or to write and then fail; the second save's arrival at the lock
 * is waited for as a state, never as a count of turns.
 */
describe("saves for one account take turns", () => {
  const PRIOR = "111:AAA-prior";
  const TO_222 = "222:AAA-bee";
  const TO_333 = "333:AAA-sea";
  const deferred = <T = void>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  type How = "write" | "fail" | "write-then-fail";
  /** A store whose n-th put arrives, then does what it is told. */
  const gatedPuts = () => {
    const real = getSettingsStore();
    const calls: { arrived: ReturnType<typeof deferred<void>>; how: ReturnType<typeof deferred<How>> }[] = [];
    const at = (i: number) => (calls[i] ??= { arrived: deferred(), how: deferred<How>() });
    let n = 0;
    const store = Object.create(real) as typeof real;
    store.put = async (tenant, settings) => {
      const call = at(n++);
      call.arrived.resolve();
      const how = await call.how.promise;
      if (how !== "fail") await real.put(tenant, settings);
      if (how !== "write") throw new Error("store down");
    };
    useSettingsStoreForTest(store);
    return { arrived: (i: number) => at(i).arrived.promise, go: (i: number, how: How) => at(i).how.resolve(how) };
  };
  /** Wait for a state, polled each turn; failing only after a real-time bound. */
  const until = async (what: string, ok: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!ok()) {
      if (Date.now() > deadline) assert.fail(`never reached: ${what}`);
      await setImmediate();
    }
  };
  const queuedBehind = (tenant: `0x${string}`) =>
    until("a second save waiting for the account's lock", () => advisoryLockWaitersForTest(claims, SETTINGS_SAVE_LOCK, settingsSaveLockKey(tenant)) === 1);

  it("A SAVE WITHOUT THE TOKEN WAITS FOR A TOKEN SAVE IN FLIGHT, AND NEITHER LOSES THE OTHER'S CHANGE", async () => {
    assert.equal((await put(A, { telegramBotToken: PRIOR })).status, 200);
    const g = gatedPuts();
    const tokenSave = put(A, { telegramBotToken: TO_222 });
    await g.arrived(0);
    const allowlistSave = put(A, { telegramAllowlist: [4242] });
    await queuedBehind(A);
    g.go(0, "write");
    assert.equal((await tokenSave).status, 200);
    await g.arrived(1);
    g.go(1, "write");
    assert.equal((await allowlistSave).status, 200);
    const a = await getSettingsStore().get(A);
    assert.equal(a?.telegramBotToken, TO_222, "the new token was not written back over with the old one");
    assert.deepEqual(a?.telegramAllowlist, [4242]);
    assert.deepEqual(await held(), { "222": A }, "and the account holds the bot it stores");
  });

  for (const [first, second] of [[TO_222, TO_333], [TO_333, TO_222]]) {
    it(`TWO TOKEN SAVES, ${botOf(first)} THEN ${botOf(second)}: the second decides after the first has settled, and the claims end on it`, async () => {
      assert.equal((await put(A, { telegramBotToken: PRIOR })).status, 200);
      const g = gatedPuts();
      const one = put(A, { telegramBotToken: first });
      await g.arrived(0);
      const two = put(A, { telegramBotToken: second });
      await queuedBehind(A);
      assert.deepEqual(await held(), { "111": A, [botOf(first)]: A }, "the second has claimed nothing yet");
      g.go(0, "write");
      assert.equal((await one).status, 200);
      await g.arrived(1);
      g.go(1, "write");
      assert.equal((await two).status, 200);
      assert.equal((await getSettingsStore().get(A))?.telegramBotToken, second);
      assert.deepEqual(await held(), { [botOf(second)]: A });
    });
  }

  for (const [label, firstToken, secondToken] of [
    ["THE TOKEN IT ALREADY STORES", "111:AAA-same", "111:AAA-same"],
    ["A NEW TOKEN EACH CLICK", "111:AAA-first", "111:AAA-second"],
  ] as const) {
    it(`A DOUBLE-CLICKED MOVE OF ${label}, WHOSE FIRST WRITE FAILS: THE SECOND CLICK MOVES THE BOT, AND IT STAYS`, async () => {
      // B holds the bot. For the first case A stored its token before (its
      // child was stripped of it) and re-enters it to get the bot back, the
      // re-claim path the 409 offers.
      assert.equal((await put(B, { telegramBotToken: "111:BBB-secret" })).status, 200);
      if (firstToken === secondToken) await getSettingsStore().put(A, { telegramBotToken: firstToken });
      const g = gatedPuts();
      const one = put(A, { telegramBotToken: firstToken, moveBot: true });
      await g.arrived(0);
      assert.deepEqual(await held(), { "111": A }, "the first click moved it");
      const two = put(A, { telegramBotToken: secondToken, moveBot: true });
      await queuedBehind(A);
      g.go(0, "fail");
      await assert.rejects(one, /store down/);
      await g.arrived(1);
      g.go(1, "write");
      const res = await two;
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.botMoved, true, "the second click moved it itself, from B, where the first one's undo put it");
      assert.deepEqual(await held(), { "111": A }, "A stores the bot and holds it: the save that said so is true");
      assert.equal((await getSettingsStore().get(A))?.telegramBotToken, secondToken);
    });
  }

  it("A WRITE THAT WENT THROUGH AND THEN FAILED KEEPS ITS CLAIM, AND LETS GO OF THE BOT THE ACCOUNT LEFT", async () => {
    assert.equal((await put(A, { telegramBotToken: PRIOR })).status, 200);
    const g = gatedPuts();
    const save = put(A, { telegramBotToken: TO_222 });
    await g.arrived(0);
    g.go(0, "write-then-fail");
    await assert.rejects(save, /store down/);
    assert.equal((await getSettingsStore().get(A))?.telegramBotToken, TO_222);
    assert.deepEqual(await held(), { "222": A }, "not 111 as well, held by an account that no longer stores it");
  });

  it("A SAVE WITHOUT THE TOKEN LETS GO OF A CLAIM ON A BOT THE ACCOUNT NO LONGER STORES, AND CLAIMS NOTHING", async () => {
    assert.equal((await put(B, { telegramBotToken: "333:BBB-own-bot" })).status, 200);
    assert.equal((await put(A, { telegramBotToken: PRIOR })).status, 200);
    assert.equal((await put(A, { telegramBotToken: TO_222 })).status, 200);
    assert.deepEqual(await held(), { "222": A, "333": B });
    // A writer that does not take the lock or settle (the orchestrator's
    // allowlist promotion, holder, x-proof) read before the token save and
    // writes what it read back: the old token.
    await getSettingsStore().put(A, { telegramBotToken: PRIOR, telegramAllowlist: [4242] });
    getMeAsked.length = 0;
    assert.equal((await put(A, { telegramEnabled: true })).status, 200);
    assert.deepEqual(await held(), { "333": B }, "222 is let go; 111 is not claimed on a token nobody confirmed; B's is not A's to touch");
    assert.deepEqual(getMeAsked, [], "and Telegram was not asked");
  });
});
function botOf(token: string): string {
  return token.slice(0, token.indexOf(":"));
}

describe("the Settings screen's answer to bot_claimed", () => {
  it("KEEP IT THERE TAKES THE TOKEN OUT OF THE FORM, so the next Save saves everything else", () => {
    // Left in the draft, the token rode along with every later save, each was
    // refused the same way, and the owner's other changes were never saved.
    const src = readFileSync(new URL("../../../terminal/screens/Settings.tsx", import.meta.url), "utf8");
    const at = src.indexOf("{botClaimed && (");
    assert.ok(at > 0);
    const keep = src.slice(at, src.indexOf("Keep it there", at));
    assert.match(keep, /setDraft\(\(\{ telegramBotToken: _kept, \.\.\.rest \}\) => rest\);/);
    assert.match(keep, /setBotClaimed\(null\);/);
    assert.match(keep, /Nothing has been saved yet\./, "and the owner is told the save did not land");
  });
});
