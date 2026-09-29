/**
 * ONE BOT, ONE TENANT — through the real reconcile().
 *
 * The raw-string de-dupe this replaced was not asked at spawn: a second login's
 * child started with the owner's bot token and polled it until the next
 * refresh took it away, long enough to drain the backlog and lock the owner
 * out with it. So what is checked here is the settings.json each child finds
 * AT THE MOMENT IT IS SPAWNED, read inside the spawn itself, as well as after
 * the pass.
 *
 * The file stores and the no-op lease, as in double-spawn.integration.test.ts,
 * with the worker process replaced by a fake (setSpawnForTest) and the bot
 * claims kept in node:sqlite (setBotClaimsDbForTest): the same SQL the shared
 * Postgres runs.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so this never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it, mock } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-bot-claims-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_TELEGRAM_ENABLED;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");

const { reconcile, childHome, setSpawnForTest, setBotClaimsDbForTest, setBotConfirmForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { wrapSqlite } = await import("./db");
const { NO_ANSWER, botIdOf, claimBot, ensureBotClaims, moveBotClaim, readBotClaims } = await import("./telegram-claims");

const claimsDb = wrapSqlite(new DatabaseSync(":memory:"));
await ensureBotClaims(claimsDb);
setBotClaimsDbForTest(claimsDb);
/**
 * getMe, standing in for Telegram: every token answers for the bot its prefix
 * names, except one whose secret starts "fake", which Telegram refuses. A
 * test that needs no answer at all (NO_ANSWER) sets its own for a while.
 */
const getMeAsked: string[] = [];
const confirm = async (token: string) => {
  getMeAsked.push(token);
  return /^\d+:fake/.test(token) ? null : botIdOf(token);
};
setBotConfirmForTest(confirm);

const tenant = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const grant = (n: number): StoredGrant =>
  ({
    smartAccount: tenant(0xc00 + n),
    owner: tenant(0xb00 + n),
    sessionKeyAddress: tenant(0xd00 + n),
    serialized: `eyJ-a-zerodev-blob-bot-claims-${n}`,
    chainId: 4663,
    grantedAt: Math.floor(Date.now() / 1000) - 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
  }) as unknown as StoredGrant;

/** A worker process that never exits unless killed. */
class FakeProc extends EventEmitter {
  static next = 50_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  kill(): boolean {
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

/** Each spawn, with the bot token its settings.json held at that moment. */
const spawnedWith = new Map<string, string | undefined>();
setSpawnForTest(((_cmd: string, _args: readonly string[], opts: SpawnOptions) => {
  const home = String(opts.env?.MERRYMEN_HOME);
  const file = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")) as { telegramBotToken?: string };
  spawnedWith.set(path.basename(home), file.telegramBotToken);
  return new FakeProc() as unknown as ChildProcess;
}) as never);

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => {
  said.push(a.map(String).join(" "));
};
after(() => {
  console.log = realLog;
  setBotClaimsDbForTest(null);
  setBotConfirmForTest(null);
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const tokenInFile = (t: string) =>
  (JSON.parse(readFileSync(path.join(childHome(t), "settings.json"), "utf8")) as { telegramBotToken?: string }).telegramBotToken;
const withBot = (token: string) => ({ telegramEnabled: true, telegramBotToken: token, telegramAllowlist: [4242] });

describe("one bot, one tenant, from the first spawn", () => {
  const A = tenant(0xa1);
  const B = tenant(0xb1);

  it("THE LOSER NEVER STARTS WITH THE BOT: its settings.json lacks the token at spawn, not only after a refresh", async () => {
    await claimBot(claimsDb, "111", A, "111", 1_000);
    // The incident's shape: the same bot, re-saved under a second login (here
    // with a re-issued secret, which the old string compare took for a
    // different bot).
    await getSettingsStore().put(A, withBot("111:AAA-first-secret") as never);
    await getSettingsStore().put(B, withBot("111:BBB-reissued-secret") as never);
    await getGrantStore().put(A, grant(1));
    await getGrantStore().put(B, grant(2));
    await reconcile();
    assert.equal(spawnedWith.get(A), "111:AAA-first-secret", "the claim's holder starts with its bot");
    assert.ok(spawnedWith.has(B), "the other login trades");
    assert.equal(spawnedWith.get(B), undefined, "but never starts with the bot");
    assert.equal(tokenInFile(B), undefined, "nor gets it on the refresh");
    assert.equal(tokenInFile(A), "111:AAA-first-secret");
    const refused = said.filter((l) => l.includes(`${B}: telegram bot token already claimed by another tenant`));
    assert.equal(refused.length, 1, `said once, not every write:\n${said.join("\n")}`);
    assert.ok(!said.some((l) => l.includes("BBB-reissued") || l.includes("AAA-first")), "no token in the log");
    assert.equal((await getSettingsStore().get(B))?.telegramBotToken, "111:BBB-reissued-secret", "the owner's saved settings are untouched");
  });

  it("A MOVE HANDS THE BOT OVER ON THE NEXT PASS, and takes it from the account it left", async () => {
    const moved = await moveBotClaim(claimsDb, "111", B, "111", 2_000);
    assert.ok(moved.moved);
    await reconcile();
    assert.equal(tokenInFile(B), "111:BBB-reissued-secret");
    assert.equal(tokenInFile(A), undefined, "the account it left stops polling it");
    assert.ok(said.some((l) => l.includes(`${A}: telegram bot token already claimed by another tenant`)), said.join("\n"));
  });
});

describe("a bot nobody has claimed yet", () => {
  it("GOES TO THE FIRST TENANT TO POLL IT, IS RECORDED, AND THE SECOND NEVER STARTS WITH IT", async () => {
    // Every token saved before claims existed: no row. The first tenant the
    // orchestrator judges claims it, first one wins, and keeps it.
    const C = tenant(0xc1);
    const D = tenant(0xd1);
    await getSettingsStore().put(C, withBot("222:CCC-secret") as never);
    await getSettingsStore().put(D, withBot("222:DDD-secret") as never);
    await getGrantStore().put(C, grant(3));
    await getGrantStore().put(D, grant(4));
    await reconcile();
    const holder = (await readBotClaims(claimsDb)).get("222");
    assert.ok(holder === C || holder === D, "claimed for one of them");
    const loser = holder === C ? D : C;
    assert.ok(spawnedWith.has(C) && spawnedWith.has(D));
    assert.ok(spawnedWith.get(holder!), "the holder started with its bot");
    assert.equal(spawnedWith.get(loser), undefined, "and the other never did");
    for (let i = 0; i < 2; i++) await reconcile();
    assert.equal((await readBotClaims(claimsDb)).get("222"), holder, "and it stays theirs, pass after pass");
    assert.ok(tokenInFile(holder!));
    assert.equal(tokenInFile(loser), undefined);
  });

  it("A STRANGER'S `<bot id>:anything` CLAIMS NOTHING, IS NOT ASKED ABOUT EVERY PASS, AND DOES NOT KEEP THE OWNER OFF THEIR BOT", async () => {
    // A bot id is public. A token Telegram refuses must not make a claim, or
    // any signed-in account could take any owner's bot offline by typing its
    // id. Here the owner's Telegram is off at first, so no claim of theirs
    // exists yet for the stranger to lose to.
    // The stranger sorts first, so the pass meets it before the owner.
    const STRANGER = tenant(0x01);
    const OWNER = tenant(0x02);
    await getSettingsStore().put(OWNER, { telegramEnabled: false, telegramBotToken: "444:the-real-secret" } as never);
    await getSettingsStore().put(STRANGER, withBot("444:fake-guessed-secret") as never);
    await getGrantStore().put(OWNER, grant(7));
    await getGrantStore().put(STRANGER, grant(8));
    getMeAsked.length = 0;
    await reconcile();
    await reconcile();
    assert.equal((await readBotClaims(claimsDb)).get("444"), undefined, "no claim for a token Telegram refused");
    assert.equal(getMeAsked.filter((t) => t.startsWith("444:fake")).length, 1, "and Telegram is not asked again every pass");
    assert.ok(said.some((l) => l.includes(`${STRANGER}: Telegram refused the token for telegram bot 444`)), said.join("\n"));
    // The owner switches Telegram on: their confirmed claim decides, whoever
    // the pass meets first.
    await getSettingsStore().put(OWNER, withBot("444:the-real-secret") as never);
    await reconcile();
    assert.equal((await readBotClaims(claimsDb)).get("444"), OWNER);
    assert.equal(tokenInFile(OWNER), "444:the-real-secret", "the owner's child polls its bot");
    await reconcile();
    assert.equal(tokenInFile(STRANGER), undefined, "and the stranger's is refused it");
  });

  it("AT A SPAWN, THE AGENT ITS OWNER LINKED WINS OVER A LOGIN NOBODY LINKED, IN WHATEVER ORDER THEY COME", async () => {
    // After a restart every tenant is spawned, in listTenants order, before
    // any refresh, and after the deploy that brings claims no bot is claimed:
    // first one wins was heap order there. The incident's shape: one token,
    // saved under the owner's agent and again under a second login whose
    // allowlist nobody ever linked. Two pairs, named so that one pair meets
    // the unlinked login first whichever way the store lists them.
    const pairs = [
      { unlinked: tenant(0x31), linked: tenant(0x32), token: "555:one-token-two-logins" },
      { unlinked: tenant(0x34), linked: tenant(0x33), token: "556:one-token-two-logins" },
    ];
    for (const p of pairs) {
      await getSettingsStore().put(p.unlinked, { telegramEnabled: true, telegramBotToken: p.token } as never);
      await getSettingsStore().put(p.linked, withBot(p.token) as never);
      await getGrantStore().put(p.unlinked, grant(0x31 + pairs.indexOf(p) * 2));
      await getGrantStore().put(p.linked, grant(0x32 + pairs.indexOf(p) * 2));
    }
    await reconcile();
    for (const p of pairs) {
      const bot = botIdOf(p.token)!;
      assert.equal((await readBotClaims(claimsDb)).get(bot), p.linked, `bot ${bot} is claimed for the linked agent`);
      assert.equal(spawnedWith.get(p.linked), p.token, "which starts with it");
      assert.ok(spawnedWith.has(p.unlinked), "the other login trades");
      assert.equal(spawnedWith.get(p.unlinked), undefined, "but never starts with the bot");
      assert.equal(tokenInFile(p.unlinked), undefined, "nor is handed it by the refresh");
    }
  });

  it("A BOT ONLY AN UNLINKED LOGIN USES IS STILL ITS OWN, BY THE END OF THE SAME PASS", async () => {
    // Waiting for a linked owner costs a lone unlinked tenant its bot only
    // from the spawn to the refresh that follows it: it must be able to poll
    // to be linked at all.
    const LONE = tenant(0x41);
    await getSettingsStore().put(LONE, { telegramEnabled: true, telegramBotToken: "666:lone-login-secret" } as never);
    await getGrantStore().put(LONE, grant(0x41));
    await reconcile();
    assert.equal(spawnedWith.get(LONE), undefined, "started without it");
    assert.ok(said.some((l) => l.includes(`${LONE}: telegram bot 666 is not claimed yet and no chat is linked here`)), said.join("\n"));
    assert.equal((await readBotClaims(claimsDb)).get("666"), LONE, "claimed at the refresh");
    assert.equal(tokenInFile(LONE), "666:lone-login-secret", "and handed to its process in the same pass");
  });

  it("A TOKEN CRAFTED TO STEER getMe IS NEVER SENT, NEVER CLAIMS, AND THE OWNER KEEPS THEIR BOT", async () => {
    // Through the real getMe (telegram/api.ts), with Telegram answering any
    // request that is not a plain getMe the way the sender's own bot would:
    // with the id they chose. `<victim id>:x/../../bot<own>/…` used to read as
    // the victim's bot and be "confirmed" by that answer.
    const ATTACKER = tenant(0x51);
    const VICTIM = tenant(0x52);
    const crafted = "777:x/../../bot999:attacker-secret/getChat?chat_id=777&z=";
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input)).href;
      sent.push(url);
      const getMe = /^https:\/\/api\.telegram\.org\/bot(\d+):[A-Za-z0-9_-]+\/getMe$/.exec(url);
      const id = getMe ? Number(getMe[1]) : 777;
      return Response.json({ ok: true, result: { id, is_bot: true, username: `bot${id}` } });
    }) as typeof fetch;
    setBotConfirmForTest(null);
    try {
      // The victim's Telegram is off at first, so the attacker's token is the
      // only one on the bot: nothing of the victim's is there to win first.
      await getSettingsStore().put(VICTIM, { telegramEnabled: false, telegramBotToken: "777:the-victims-live-secret" } as never);
      await getSettingsStore().put(ATTACKER, withBot(crafted) as never);
      await getGrantStore().put(ATTACKER, grant(0x51));
      await getGrantStore().put(VICTIM, grant(0x52));
      await reconcile();
      assert.equal(sent.length, 0, `nothing was sent for the crafted token:\n${sent.join("\n")}`);
      assert.equal((await readBotClaims(claimsDb)).get("777"), undefined, "and it claimed nothing");
      await getSettingsStore().put(VICTIM, withBot("777:the-victims-live-secret") as never);
      await reconcile();
    } finally {
      globalThis.fetch = realFetch;
      setBotConfirmForTest(confirm);
    }
    assert.ok(!sent.some((u) => u.includes("attacker") || u.includes("getChat")), `nothing but the victim's getMe was sent:\n${sent.join("\n")}`);
    assert.equal((await readBotClaims(claimsDb)).get("777"), VICTIM, "the bot is claimed for the token Telegram really answered for");
    assert.equal(tokenInFile(VICTIM), "777:the-victims-live-secret", "and its owner's agent polls it");
  });

  it("A TENANT WITH TELEGRAM OFF CLAIMS NOTHING, so the one that polls keeps the bot", async () => {
    const E = tenant(0xe1);
    const F = tenant(0xf1);
    await getSettingsStore().put(E, { telegramEnabled: false, telegramBotToken: "333:EEE-secret" } as never);
    await getSettingsStore().put(F, withBot("333:FFF-secret") as never);
    await getGrantStore().put(E, grant(5));
    await getGrantStore().put(F, grant(6));
    await reconcile();
    assert.equal((await readBotClaims(claimsDb)).get("333"), F);
    assert.equal(spawnedWith.get(F), "333:FFF-secret");
    assert.equal(tokenInFile(E), "333:EEE-secret", "the switched-off login's file keeps what its owner saved");
  });

  /** A pass as if `ms` had gone by: only Date is the test's, the timers stay real. */
  const passAfter = async (ms: number) => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() + ms });
    try {
      await reconcile();
    } finally {
      mock.timers.reset();
    }
  };

  it("NO ANSWER IS NOT A REFUSAL: A LINKED AGENT TELEGRAM DID NOT ANSWER FOR AT ITS SPAWN IS ASKED AGAIN, AND THE UNLINKED LOGIN WAITS FOR IT", async () => {
    // One blip on the deploy pass: getMe for the linked agent's token gets no
    // answer (call() gives up at TG_CALL_TIMEOUT_MS). Read as a refusal, it
    // was not asked again for ten minutes, and the unlinked login on the same
    // token claimed the bot at the refresh that followed, for good. Two
    // pairs, so one meets the unlinked login first whichever way the store
    // lists them.
    const pairs = [
      { unlinked: tenant(0x61), linked: tenant(0x62), token: "881:one-token-and-a-blip" },
      { unlinked: tenant(0x64), linked: tenant(0x63), token: "882:one-token-and-a-blip" },
    ];
    const blipped = new Set<string>();
    setBotConfirmForTest(async (token) => {
      if (!pairs.some((p) => p.token === token) || blipped.has(token)) return confirm(token);
      blipped.add(token);
      getMeAsked.push(token);
      return NO_ANSWER;
    });
    try {
      for (const [i, p] of pairs.entries()) {
        await getSettingsStore().put(p.unlinked, { telegramEnabled: true, telegramBotToken: p.token } as never);
        await getSettingsStore().put(p.linked, withBot(p.token) as never);
        await getGrantStore().put(p.unlinked, grant(0x61 + i * 3));
        await getGrantStore().put(p.linked, grant(0x62 + i * 3));
      }
      getMeAsked.length = 0;
      await reconcile();
      await reconcile();
      for (const p of pairs) {
        const bot = botIdOf(p.token)!;
        assert.equal((await readBotClaims(claimsDb)).get(bot), undefined, `bot ${bot}: no answer claims nothing`);
        assert.equal(spawnedWith.get(p.linked), p.token, "the linked agent starts with its bot, and polls it meanwhile");
        assert.equal(spawnedWith.get(p.unlinked), undefined, "the unlinked login does not");
        assert.equal(tokenInFile(p.unlinked), undefined, "nor is handed it by a refresh while the linked agent waits on Telegram");
        assert.equal(tokenInFile(p.linked), p.token);
        assert.equal(getMeAsked.filter((t) => t === p.token).length, 1, "Telegram was asked once, for the linked agent, and not every pass");
        assert.ok(said.some((l) => l.includes(`${p.linked}: Telegram did not answer for telegram bot ${bot}`)), said.join("\n"));
        assert.ok(said.some((l) => l.includes(`${p.unlinked}: telegram bot ${bot} is not claimed yet, and a linked agent on it is waiting on Telegram`)), said.join("\n"));
      }
      // A minute on, the linked agent is asked again, and Telegram answers.
      await passAfter(61_000);
      for (const p of pairs) {
        const bot = botIdOf(p.token)!;
        assert.equal((await readBotClaims(claimsDb)).get(bot), p.linked, `bot ${bot} is claimed for the linked agent`);
        assert.equal(tokenInFile(p.linked), p.token);
        assert.equal(tokenInFile(p.unlinked), undefined, "and the unlinked login is refused it by the claim");
      }
    } finally {
      setBotConfirmForTest(confirm);
    }
  });

  it("THE WAIT IS BOUNDED: A LINKED TOKEN TELEGRAM NEVER ANSWERS FOR KEEPS AN UNLINKED LOGIN OFF ITS BOT TEN MINUTES AT MOST", async () => {
    // Anyone can put a chat id on their own allowlist, so "linked" is not
    // proof of anything; a token that never gets an answer must not hold the
    // bot from a login whose token Telegram does confirm for longer than a
    // blip could last.
    const LINKED = tenant(0x67);
    const UNLINKED = tenant(0x68);
    const deaf = "883:linked-never-answered";
    setBotConfirmForTest(async (token) => {
      if (token !== deaf) return confirm(token);
      getMeAsked.push(token);
      return NO_ANSWER;
    });
    try {
      await getSettingsStore().put(LINKED, withBot(deaf) as never);
      await getSettingsStore().put(UNLINKED, { telegramEnabled: true, telegramBotToken: "883:unlinked-live-secret" } as never);
      await getGrantStore().put(LINKED, grant(0x67));
      await getGrantStore().put(UNLINKED, grant(0x68));
      await reconcile();
      assert.equal((await readBotClaims(claimsDb)).get("883"), undefined);
      assert.equal(tokenInFile(UNLINKED), undefined, "waits while the linked token could still be a blip");
      await passAfter(5 * 60_000);
      assert.equal((await readBotClaims(claimsDb)).get("883"), undefined, "and still waits five minutes on");
      assert.equal(tokenInFile(UNLINKED), undefined);
      await passAfter(10 * 60_000 + 1_000);
      assert.equal((await readBotClaims(claimsDb)).get("883"), UNLINKED, "past ten minutes the token Telegram confirms claims it");
      assert.equal(tokenInFile(UNLINKED), "883:unlinked-live-secret");
      await passAfter(30 * 60_000);
      assert.equal((await readBotClaims(claimsDb)).get("883"), UNLINKED, "and keeps it");
    } finally {
      setBotConfirmForTest(confirm);
    }
  });
});
