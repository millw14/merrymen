/**
 * ONE BOT, ONE TENANT — the claim, its store and its gate.
 *
 * In the incident this came from, a second X login saved the owner's bot
 * token, its child drained the bot's backlog with the owner's chat not on its
 * allowlist, and counted five stale `/link` codes as five wrong guesses: the
 * owner was locked out of their own bot. The guard of the day was a Set of raw
 * token strings rebuilt every pass, which forgot its answer every pass, saw
 * `111:AAA` and `111:BBB` as two bots, and was not asked at spawn at all.
 *
 * The store is run on node:sqlite through the same Db seam production uses,
 * so these are the statements Postgres runs, translated. The gate is pure and
 * run directly. The orchestrator's use of it is pinned from the source, and
 * driven through the real reconcile() in bot-claims.integration.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import {
  botIdOf,
  claimBot,
  claimGate,
  ensureBotClaims,
  moveBotClaim,
  ownerLinked,
  pollerKeyOf,
  readBotClaims,
  releaseBotClaims,
  telegramDidNotAnswer,
  unclaimedBot,
  undoBotClaim,
} from "./telegram-claims";
import { getMe, type FetchLike } from "./telegram/api";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_A = "111:AAAsecret-of-the-first-issue";
const TOKEN_B = "111:BBBsecret-reissued-in-botfather";

async function fresh(): Promise<Db> {
  const db = wrapSqlite(new DatabaseSync(":memory:"));
  await ensureBotClaims(db);
  return db;
}
const bot = (token: string) => {
  const id = botIdOf(token);
  assert.ok(id, `${token} names a bot`);
  return id;
};

describe("the claim store", () => {
  it("'111:AAA' AND '111:BBB' COLLIDE: the claim is the bot, not the string", async () => {
    // The same bot after its owner revokes and re-issues the token. The raw
    // string guard saw two bots here, and let both be polled.
    const db = await fresh();
    const first = await claimBot(db, bot(TOKEN_A), A, bot(TOKEN_A), 1_000);
    assert.deepEqual(first, { holder: A, fresh: true, stamp: 1_000 });
    const second = await claimBot(db, bot(TOKEN_B), B, bot(TOKEN_B), 2_000);
    assert.deepEqual(second, { holder: A, fresh: false, stamp: 1_000 }, "the second account learns it is held, and by whom only here");
    assert.deepEqual([...(await readBotClaims(db))], [["111", A]]);
  });

  it("THE FIRST CLAIM WINS, across two connections racing for one bot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "merrymen-bot-claims-"));
    const file = path.join(dir, "claims.sqlite");
    const one = new DatabaseSync(file);
    const two = new DatabaseSync(file);
    try {
      one.exec("PRAGMA busy_timeout = 5000");
      two.exec("PRAGMA busy_timeout = 5000");
      const a = wrapSqlite(one);
      const b = wrapSqlite(two);
      await ensureBotClaims(a);
      await ensureBotClaims(b);
      const [ra, rb] = (await Promise.all([claimBot(a, "111", A, "111", 1_000), claimBot(b, "111", B, "111", 1_001)])).map((r) => {
        assert.ok(r, "both were confirmed");
        return r;
      });
      assert.equal(ra!.holder, rb!.holder, "both are told the same holder");
      assert.equal([ra!.fresh, rb!.fresh].filter(Boolean).length, 1, "exactly one made the claim");
      const again = await claimBot(b, "111", ra!.holder === A ? B : A, "111", 3_000);
      assert.equal(again?.holder, ra!.holder, "and it stays theirs");
    } finally {
      one.close();
      two.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("A CLAIM REQUIRES THE BOT TO HAVE ANSWERED FOR THE TOKEN: a bot id is public, so the id alone claims nothing", async () => {
    // `<id>:anything` is something any signed-in stranger can type. A claim
    // made for it would keep the real owner's process off their own bot.
    const db = await fresh();
    assert.equal(await claimBot(db, "111", B, null, 1_000), null, "Telegram refused the token");
    assert.equal(await claimBot(db, "111", B, "222", 1_000), null, "another bot answered for it");
    assert.equal((await readBotClaims(db)).size, 0, "nothing was written");
    assert.deepEqual(await claimBot(db, "111", A, "111", 2_000), { holder: A, fresh: true, stamp: 2_000 });
  });

  it("A MOVE REQUIRES THE BOT TO HAVE ANSWERED FOR THE TOKEN (validated by getMe)", async () => {
    const db = await fresh();
    await claimBot(db, "111", A, "111", 1_000);
    assert.deepEqual(await moveBotClaim(db, "111", B, null, 2_000), { moved: false, why: "unconfirmed" }, "Telegram refused it");
    assert.deepEqual(await moveBotClaim(db, "111", B, "222", 2_000), { moved: false, why: "unconfirmed" }, "another bot answered");
    assert.deepEqual([...(await readBotClaims(db))], [["111", A]], "nothing moved");
    const moved = await moveBotClaim(db, "111", B, "111", 3_000);
    assert.deepEqual(moved, { moved: true, from: { tenant: A, claimedAt: 1_000 }, stamp: 3_000 });
    assert.deepEqual([...(await readBotClaims(db))], [["111", B]]);
    // A move to a bot nobody holds is a plain claim.
    assert.deepEqual(await moveBotClaim(db, "333", B, "333", 4_000), { moved: true, from: null, stamp: 4_000 });
  });

  it("ONLY THE HOLDER CAN RELEASE, and a release keeps the bot still in use", async () => {
    const db = await fresh();
    await claimBot(db, "111", A, "111", 1_000);
    await claimBot(db, "222", A, "222", 1_000);
    await claimBot(db, "333", B, "333", 1_000);
    assert.equal(await releaseBotClaims(db, B, "999"), 1, "B lets go of its own bot only");
    assert.deepEqual([...(await readBotClaims(db))].sort(), [["111", A], ["222", A]]);
    assert.equal(await releaseBotClaims(db, B), 0, "and can release nothing of A's");
    assert.equal(await releaseBotClaims(db, A.toUpperCase().replace("0X", "0x"), "222"), 1, "A, however cased, keeps the bot it now uses");
    assert.deepEqual([...(await readBotClaims(db))], [["222", A]]);
  });

  it("AN UNDO TAKES BACK ONLY THE CLAIM IT MADE", async () => {
    const db = await fresh();
    // A fresh claim for a save that failed: gone.
    const c = await claimBot(db, "111", A, "111", 1_000);
    await undoBotClaim(db, "111", A, c!.stamp, null);
    assert.equal((await readBotClaims(db)).size, 0);
    // A move for a save that failed: back to the holder it replaced, with its stamp.
    await claimBot(db, "111", A, "111", 1_000);
    const m = await moveBotClaim(db, "111", B, "111", 2_000);
    assert.ok(m.moved);
    await undoBotClaim(db, "111", B, m.stamp, m.from);
    assert.deepEqual(await claimBot(db, "111", B, "111", 9_000), { holder: A, fresh: false, stamp: 1_000 });
    // A claim somebody made since is not the one to take back.
    const late = await moveBotClaim(db, "111", B, "111", 3_000);
    assert.ok(late.moved);
    await moveBotClaim(db, "111", A, "111", 4_000);
    await undoBotClaim(db, "111", B, late.stamp, late.from);
    assert.deepEqual([...(await readBotClaims(db))], [["111", A]]);
    assert.deepEqual(await claimBot(db, "111", A, "111", 9_000), { holder: A, fresh: false, stamp: 4_000 }, "A's own move stands");
  });

  it("THE TOKEN IS NEVER STORED: bot id, tenant, and when", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    await ensureBotClaims(db);
    await claimBot(db, bot(TOKEN_A), A, bot(TOKEN_A), 1_000);
    const cols = (raw.prepare("PRAGMA table_info(telegram_bot_claims)").all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ["bot_id", "tenant", "claimed_at"]);
    const dump = JSON.stringify(raw.prepare("SELECT * FROM telegram_bot_claims").all());
    assert.ok(!dump.includes("secret"), dump);
  });

  it("the table is made once per connection, a lost CREATE race is no failure, and any other failure is tried again", async () => {
    let execs = 0;
    let fail: unknown = Object.assign(new Error('relation "telegram_bot_claims" already exists'), { code: "42P07" });
    const fake = {
      exec: async () => {
        execs++;
        if (fail) throw fail;
      },
    } as unknown as Db;
    await ensureBotClaims(fake);
    await ensureBotClaims(fake);
    assert.equal(execs, 1, "the other service made it: done");
    const other = { ...fake, exec: fake.exec } as unknown as Db;
    fail = new Error("permission denied");
    await assert.rejects(ensureBotClaims(other), /permission denied/);
    fail = null;
    await ensureBotClaims(other);
    assert.equal(execs, 3, "a real failure is not remembered as success");
  });
});

describe("claimGate — who may poll the bot", () => {
  const on = (token: string, extra: Record<string, unknown> = {}) => ({ telegramEnabled: true, telegramBotToken: token, strategy: "trencher", ...extra });

  it("THE LOSER'S SETTINGS LACK THE TOKEN AT SPAWN, not only after the first refresh", () => {
    // A spawn has no pass, so no pass-level de-dupe: the claims alone must
    // keep a second login's child from ever starting with the bot.
    const claims = new Map([["111", A]]);
    const loser = on(TOKEN_B);
    const out = claimGate(loser, B, claims);
    assert.deepEqual(out.verdict, { kind: "strip", bot: "111", by: "claim" });
    assert.equal("telegramBotToken" in out.settings, false, "the child's file will not carry it");
    assert.equal(out.settings.strategy, "trencher", "the rest of its config is untouched");
    assert.equal(loser.telegramBotToken, TOKEN_B, "and the input is not mutated: the owner's saved settings are theirs");
    const winner = claimGate(on(TOKEN_A), A, claims);
    assert.deepEqual(winner.verdict, { kind: "keep", bot: "111" });
    assert.equal(winner.settings.telegramBotToken, TOKEN_A);
  });

  it("a bot nobody has claimed is kept, and is the one the caller claims first (unclaimedBot)", () => {
    const out = claimGate(on(TOKEN_A), A, new Map());
    assert.deepEqual(out.verdict, { kind: "keep", bot: "111" });
    assert.equal(out.settings.telegramBotToken, TOKEN_A);
    assert.equal(unclaimedBot(on(TOKEN_A), new Map()), "111");
    assert.equal(unclaimedBot(on(TOKEN_A), new Map([["111", B]])), null, "claimed already: nothing to add");
    assert.equal(unclaimedBot(on(TOKEN_A), null), null, "unreadable claims: nothing to add to");
    assert.equal(unclaimedBot({ telegramEnabled: false, telegramBotToken: TOKEN_A }, new Map()), null, "a tenant that does not poll claims nothing");
    assert.equal(unclaimedBot(on("not-a-token"), new Map()), null);
  });

  it("the claim is compared on the account however it is cased", () => {
    const out = claimGate(on(TOKEN_A), A.toUpperCase().replace("0X", "0x"), new Map([["111", A]]));
    assert.equal(out.verdict.kind, "keep");
  });

  it("THE PASS'S OWN DE-DUPE IS THE SECOND GUARD, one poller per token, and never strips a tenant for its own entry", () => {
    // The incident's shape: the same token saved under a second login.
    const seen = new Map([[pollerKeyOf(TOKEN_A)!, A]]);
    // With no claim to go by, a second poller of it in one pass is refused…
    assert.deepEqual(claimGate(on(TOKEN_A), B, new Map(), seen).verdict, { kind: "strip", bot: "111", by: "pass" });
    // …and with the claims unreadable it is the only guard there is…
    assert.deepEqual(claimGate(on(TOKEN_A), B, null, seen).verdict, { kind: "strip", bot: "111", by: "pass" });
    // …however it is typed: trimmed as the child trims it, and the id read as a number.
    assert.deepEqual(claimGate(on(` 0${TOKEN_A} `), B, null, seen).verdict, { kind: "strip", bot: "111", by: "pass" });
    // A tenant already recorded as polling it (a hold handed back to trading
    // in the same pass) is not stripped by its own claim.
    assert.equal(claimGate(on(TOKEN_A), A, null, seen).verdict.kind, "keep");
    // Distinct bots both survive.
    assert.equal(claimGate(on("222:CCCsecret"), B, null, seen).verdict.kind, "keep");
  });

  it("WITH NOTHING TO VOUCH FOR EITHER, A DIFFERENT SECRET FOR THE SAME BOT STRIPS NOBODY", () => {
    // Telegram keeps one secret live per bot, so two secrets are never two
    // pollers. Keyed on the bot, whoever the pass met first took it: a
    // stranger's `111:guess`, or the secret the owner revoked, and the live
    // one went unpolled for as long as the claims could not say otherwise.
    for (const first of ["111:guessed-by-a-stranger", TOKEN_A]) {
      const seen = new Map([[pollerKeyOf(first)!, A]]);
      const owner = claimGate(on(TOKEN_B), B, null, seen);
      assert.deepEqual(owner.verdict, { kind: "keep", bot: "111" }, first);
      assert.equal(owner.settings.telegramBotToken, TOKEN_B);
    }
  });

  it("pollerKeyOf is the token, as the child reads it, and never the token itself", () => {
    assert.equal(pollerKeyOf(" 0111:abc "), pollerKeyOf("111:abc"));
    assert.notEqual(pollerKeyOf("111:abc"), pollerKeyOf("111:abd"));
    assert.equal(pollerKeyOf("not-a-token"), null);
    assert.ok(!pollerKeyOf(TOKEN_A)!.includes("AAAsecret"));
  });

  it("A CONFIRMED CLAIM OUTRANKS THE PASS'S RECORD, which holds whoever the pass met first, confirmed or not", () => {
    // A stranger's `111:anything` met first in a pass is recorded as polling
    // the bot (its process cannot: Telegram refuses the token). The owner's
    // claim, made for a token Telegram confirmed, must still decide.
    const seen = new Map([[pollerKeyOf(TOKEN_B)!, B]]);
    assert.deepEqual(claimGate(on(TOKEN_A), A, new Map([["111", A]]), seen).verdict, { kind: "keep", bot: "111" });
    assert.deepEqual(claimGate(on(TOKEN_B), B, new Map([["111", A]]), seen).verdict, { kind: "strip", bot: "111", by: "claim" });
  });

  it("UNREADABLE CLAIMS STRIP NOTHING BUT A SECOND POLLER: the silence this ends is the worse failure", () => {
    const out = claimGate(on(TOKEN_A), A, null);
    assert.deepEqual(out.verdict, { kind: "keep", bot: "111" });
    assert.equal(out.settings.telegramBotToken, TOKEN_A);
  });

  it("ONLY A TENANT THAT WILL POLL CLAIMS: a token saved with Telegram off takes nothing and loses nothing", () => {
    const prev = process.env.MERRYMEN_TELEGRAM_ENABLED;
    delete process.env.MERRYMEN_TELEGRAM_ENABLED;
    try {
      const claims = new Map([["111", A]]);
      for (const off of [{ telegramEnabled: false, telegramBotToken: TOKEN_B }, { telegramBotToken: TOKEN_B }]) {
        const out = claimGate(off, B, claims);
        assert.deepEqual(out.verdict, { kind: "idle" });
        assert.equal(out.settings, off, "its file keeps what the owner saved");
      }
      assert.deepEqual(claimGate({ strategy: "steady-basket" }, B, claims).verdict, { kind: "idle" }, "no token is a no-op");
    } finally {
      if (prev !== undefined) process.env.MERRYMEN_TELEGRAM_ENABLED = prev;
    }
  });

  it("a token that is not <digits>:<secret> has no bot to claim: Telegram refuses it anyway", () => {
    for (const token of ["not-a-bot-token", "abc:def"]) {
      const s = on(token);
      assert.deepEqual(claimGate(s, B, new Map([["111", A]])).verdict, { kind: "idle" });
    }
  });

  it("A TOKEN THAT COULD STEER THE getMe URL HAS NO BOT: it claims nothing, is judged against nothing, and is never sent", () => {
    // `<victim id>:x/../../bot<own>/getChat?chat_id=<victim id>&z=` read as the
    // victim's bot, and its "getMe" was answered by the sender's own bot. Its
    // process cannot use it either: telegram/api.ts refuses to send it.
    const crafted = "111:x/../../bot999:own-secret/getChat?chat_id=111&z=";
    assert.equal(unclaimedBot(on(crafted), new Map()), null, "never offered for a claim");
    assert.deepEqual(claimGate(on(crafted), B, new Map()).verdict, { kind: "idle" });
    assert.deepEqual(claimGate(on(TOKEN_A), A, new Map([["111", A]]), new Map()).verdict, { kind: "keep", bot: "111" }, "the owner keeps the bot");
  });

  it("THE TOKEN IS JUDGED AS THE CHILD WILL READ IT: trimmed, with its bot's id as a number", () => {
    // settings.ts trims the token, so ` 111:x` is polled as `111:x`; read
    // untrimmed it had no bot, and was neither claimed nor de-duplicated.
    const claims = new Map([["111", A]]);
    for (const token of [` ${TOKEN_B}`, `${TOKEN_B}\n`, `0${TOKEN_B}`]) {
      const out = claimGate(on(token), B, claims);
      assert.deepEqual(out.verdict, { kind: "strip", bot: "111", by: "claim" }, JSON.stringify(token));
      assert.equal("telegramBotToken" in out.settings, false);
    }
    assert.equal(unclaimedBot(on(" 222:x"), claims), "222");
  });

  it("ownerLinked: a person's own chat on the allowlist, not a group's, and not an empty list", () => {
    assert.equal(ownerLinked({ telegramAllowlist: [4242] }), true);
    assert.equal(ownerLinked({ telegramAllowlist: [-1001234, 4242] }), true);
    assert.equal(ownerLinked({ telegramAllowlist: [-1001234] }), false, "a group is not an owner");
    assert.equal(ownerLinked({ telegramAllowlist: [] }), false);
    assert.equal(ownerLinked({}), false);
  });
});

describe("telegramDidNotAnswer — no answer is not a refusal", () => {
  /** getMe's own failure, through the real call(), for what the far end did. */
  const failureOf = async (fetchFn: FetchLike, timeoutMs?: number) => {
    const { bot, ...failure } = await getMe({ token: "111:secret", fetchFn, ...(timeoutMs ? { timeoutMs } : {}) });
    assert.equal(bot, null);
    return failure;
  };
  const answering = (status: number, body: unknown): FetchLike => async () => ({ ok: status < 400, status, json: async () => body });

  it("a request that failed or timed out, Telegram down, or Telegram throttling: no answer about the token", async () => {
    const cases: [string, Promise<{ reason?: string; errorCode?: number }>][] = [
      ["timed out", failureOf(() => new Promise(() => {}), 20)],
      ["connection reset", failureOf(async () => { throw new Error("ECONNRESET"); })],
      ["502 from the front end, not JSON", failureOf(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("not JSON"); } }))],
      ["500 with a description", failureOf(answering(500, { ok: false, error_code: 500, description: "Internal Server Error" }))],
      ["429", failureOf(answering(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }))],
    ];
    for (const [what, failure] of cases) assert.equal(telegramDidNotAnswer(await failure), true, what);
  });

  it("Telegram refusing the token is a refusal, as it always was", async () => {
    const cases: [string, Promise<{ reason?: string; errorCode?: number }>][] = [
      ["401", failureOf(answering(401, { ok: false, error_code: 401, description: "Unauthorized" }))],
      ["404", failureOf(answering(404, { ok: false, error_code: 404, description: "Not Found" }))],
      ["ok:false with no code", failureOf(answering(200, { ok: false, description: "Unauthorized" }))],
      ["an answer with no bot in it", failureOf(answering(200, { ok: true, result: { id: 111 } }))],
    ];
    for (const [what, failure] of cases) assert.equal(telegramDidNotAnswer(await failure), false, what);
    assert.equal(telegramDidNotAnswer({ reason: "not a bot token (it has characters no Telegram token has)" }), false, "never sent is not no answer");
    assert.equal(telegramDidNotAnswer({}), false);
  });
});

describe("the orchestrator asks the claims on every path that writes a settings.json", () => {
  const SRC = path.dirname(fileURLToPath(import.meta.url));
  const ORCH = readFileSync(path.join(SRC, "orchestrator.ts"), "utf8");
  /** The source of one top-level function, up to the next one. */
  const body = (sig: string) => {
    const at = ORCH.indexOf(sig);
    assert.ok(at > 0, `${sig} must exist`);
    const next = ORCH.slice(at + sig.length).search(/\n(?:export )?(?:async )?function /);
    return next < 0 ? ORCH.slice(at) : ORCH.slice(at, at + sig.length + next);
  };

  it("THE RAW-STRING GUARD IS GONE", () => {
    assert.ok(!/\bdedupeBotToken\b/.test(ORCH), "dedupeBotToken compared token strings, per pass, and never at spawn");
    assert.ok(!/\bseenBotTokens\b/.test(ORCH));
  });

  it("writeSettingsForChild GATES THE BOT BEFORE THE FILE IS WRITTEN", () => {
    const fn = body("async function writeSettingsForChild(");
    const noSettings = fn.indexOf("if (!settings) return null;");
    const gate = fn.indexOf("settings = await gateBot(tenant, settings, seenBots, botClaimsRead);");
    const build = fn.indexOf("childSettingsFor(settings, holder)");
    const write = fn.indexOf("writeChildSettings(tenant, forChild)");
    assert.ok(noSettings > 0 && gate > noSettings && build > gate && write > build, "gated, then built, then written");
    assert.match(fn, /return settings;/, "and the gated settings are what the caller sees (holderBotReady reads them)");
  });

  it("gateBot READS THE CLAIMS ITSELF FOR A SPAWN, CLAIMS AN UNCLAIMED BOT FIRST, THEN ASKS claimGate", () => {
    const fn = body("async function gateBot(");
    assert.match(fn, /claimsRead !== undefined \? claimsRead : botWillPoll\(settings\) \? await readBotClaimsForPass\(\) : null/);
    const backfill = fn.indexOf("await backfillBotClaim(");
    const gate = fn.indexOf("const gate = claimGate(settings, tenant, claims, seen);");
    assert.ok(backfill > 0 && gate > backfill, "the claim is made before the bot is judged, so the judgement sees it");
    assert.match(fn, /if \(holder\) claims\.set\(unclaimed, holder\);/, "and the pass learns who holds it");
    assert.match(fn, /seen\?\.set\(pollerKeyOf\(botTokenOf\(settings\)!\)!, lc\)/, "the pass records who polls each token");
  });

  it("AT A SPAWN, AN UNCLAIMED BOT IS CLAIMED ONLY FOR A LINKED OWNER; anyone else starts without it", () => {
    // After a restart every tenant is spawned, in listTenants order, before
    // any refresh: first one wins there was heap order.
    const fn = body("async function gateBot(");
    assert.match(fn, /const linked = ownerLinked\(settings\);/);
    const wait = fn.indexOf("if (unclaimed && spawn && !linked) {");
    const backfill = fn.indexOf("await backfillBotClaim(");
    assert.ok(wait > 0 && backfill > wait, "decided before anything is claimed");
    assert.match(fn.slice(wait, backfill), /return withoutBotToken\(settings\);/);
    assert.match(fn, /const spawn = claimsRead === undefined;/);
  });

  it("THE ORCHESTRATOR CLAIMS ONLY FOR A TOKEN TELEGRAM CONFIRMS, and does not ask about a refused one every pass", () => {
    const fn = body("async function backfillBotClaim(");
    const asked = fn.indexOf("const confirmed = await confirmBotId(token);");
    const noAnswer = fn.indexOf("if (confirmed === NO_ANSWER) {");
    const claim = fn.indexOf("await claimBot(db, bot, tenant, confirmed, Date.now())");
    assert.ok(asked > 0 && noAnswer > asked && claim > noAnswer, "no answer claims nothing: it returns before claimBot is asked");
    assert.match(fn.slice(noAnswer, claim), /return null;/);
    assert.match(fn, /if \(refused && refused\.tag === tag && Date\.now\(\) < refused\.until\) return null;/);
    const confirm = body("async function botIdFromTelegram(");
    assert.match(confirm, /telegramGetMe\(\{ token \}\)/);
    assert.ok(confirm.indexOf("if (botIdOf(token) === null) return null;") < confirm.indexOf("telegramGetMe("), "nothing but a token is sent");
    assert.match(confirm, /if \(!bot && telegramDidNotAnswer\(failure\)\) return NO_ANSWER;/, "no answer only when there is no bot");
    assert.match(confirm, /return bot\?\.isBot \? String\(bot\.id\) : null;/, "and only a bot's answer vouches");
  });

  it("THE SPAWN PATH IS GATED: spawnChild writes the settings with no pass, before a hold or a worker starts", () => {
    const fn = body("async function spawnChild(");
    const write = fn.indexOf("const settings = await writeSettingsForChild(tenant);");
    const hold = fn.indexOf("await spawnHolder(tenant, smartAccount, restore.reason, settings, lease, honour);");
    const start = fn.indexOf("const proc = spawn(");
    assert.ok(write > 0 && hold > write, "a hold is started with the gated settings");
    assert.ok(start > hold, "and a worker only after them");
    assert.equal(fn.split("writeSettingsForChild(").length - 1, 1, "one write, and it is the gated one");
  });

  it("THE REFRESH PATH IS GATED: the claims are read once per pass and passed to held and trading tenants alike", () => {
    const rec = body("export async function reconcile(");
    const read = rec.indexOf("const botClaims = await readBotClaimsForPass();");
    const held = rec.indexOf("for (const [tenant, held] of [...holders])", read);
    const kids = rec.indexOf("for (const tenant of children.keys())", held);
    assert.ok(read > 0 && held > read && kids > held, "read once, before both loops, held tenants first");
    const call = "writeSettingsForChild(tenant as `0x${string}`, seenBots, holderClaims, botClaims)";
    assert.ok(rec.indexOf(call, held) > held && rec.indexOf(call, held) < kids, "the holders' refresh");
    assert.ok(rec.indexOf(call, kids) > kids, "the children's refresh");
    assert.equal(rec.split("readBotClaimsForPass()").length - 1, 1, "once per pass, not once per tenant");
  });
});
