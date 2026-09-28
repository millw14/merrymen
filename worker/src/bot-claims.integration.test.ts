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
import { after, describe, it } from "node:test";
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
const { botIdOf, claimBot, ensureBotClaims, moveBotClaim, readBotClaims } = await import("./telegram-claims");

const claimsDb = wrapSqlite(new DatabaseSync(":memory:"));
await ensureBotClaims(claimsDb);
setBotClaimsDbForTest(claimsDb);
/**
 * getMe, standing in for Telegram: every token answers for the bot its prefix
 * names, except one whose secret starts "fake", which Telegram refuses.
 */
const getMeAsked: string[] = [];
setBotConfirmForTest(async (token) => {
  getMeAsked.push(token);
  return /^\d+:fake/.test(token) ? null : botIdOf(token);
});

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
    assert.ok(said.some((l) => l.includes(`${STRANGER}: telegram bot 444 did not answer for its token`)), said.join("\n"));
    // The owner switches Telegram on: their confirmed claim decides, whoever
    // the pass meets first.
    await getSettingsStore().put(OWNER, withBot("444:the-real-secret") as never);
    await reconcile();
    assert.equal((await readBotClaims(claimsDb)).get("444"), OWNER);
    assert.equal(tokenInFile(OWNER), "444:the-real-secret", "the owner's child polls its bot");
    await reconcile();
    assert.equal(tokenInFile(STRANGER), undefined, "and the stranger's is refused it");
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
});
