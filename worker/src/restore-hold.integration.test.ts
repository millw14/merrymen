/**
 * A HELD TENANT, THROUGH THE REAL reconcile().
 *
 * A paper tenant whose practice book will not restore is held: no worker, a
 * hold process answering its bot, the restore retried on a backoff, and the
 * owner told once. When the restore takes, the hold process is stopped, its
 * exit awaited, and exactly one worker starts. restore-hold.test.ts pins the
 * shape; this drives it.
 *
 * The harness is double-spawn.integration.test.ts's: a real file-backed grant
 * and settings store, the no-op lease (no DATABASE_URL), node's spawn replaced
 * by a fake (setSpawnForTest) that tells a worker from a hold process by its
 * entry, and the clock in the test's hands where the backoff matters. The
 * restore and the owner notice need Postgres, so they are seams here
 * (setPaperRestoreForTest, setHoldNoticeForTest); the notice's durable dedupe
 * is driven over sqlite in restore-hold.test.ts.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so this never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-restore-hold-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");
process.env.MERRYMEN_TICK_SECONDS = "60";

const {
  reconcile,
  childHome,
  setSpawnForTest,
  setPaperRestoreForTest,
  setHoldNoticeForTest,
  adoptHolderForTest,
  isHeldForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { readRestoreBlocked } = await import("./restore-block");

const TENANT = "0x00000000000000000000000000000000000000a8" as const;
/** A second tenant, trading, for the bot de-duplication. */
const OTHER = "0x00000000000000000000000000000000000000a9" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000c8" as const;
const NEWER = "paper fills are newer than the recoverable valuation";
const NO_BASIS = "invalid paper checkpoint: MU is held with no paper cost basis";
/** What a database blip looks like to the restore: no rule of the book's. */
const BLIP = "Connection terminated unexpectedly";
const NEWER_CLASS = "trades newer than the last valuation";

const grant = (): StoredGrant =>
  ({
    smartAccount: ACCOUNT,
    owner: "0x00000000000000000000000000000000000000b8",
    sessionKeyAddress: "0x00000000000000000000000000000000000000d8",
    serialized: "eyJ-a-zerodev-blob-restore-hold",
    chainId: 4663,
    grantedAt: Math.floor(Date.now() / 1000) - 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
  }) as unknown as StoredGrant;

/** A process reduced to what the orchestrator does with one. */
class FakeProc extends EventEmitter {
  static next = 50_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  private gone = false;
  /** Takes a second (of the test's clock) to go after a signal, as a process shutting down does. */
  slowExit = false;
  constructor(readonly kind: "worker" | "hold") {
    super();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    const go = () => this.die(null, String(signal ?? "SIGTERM"));
    if (!this.gone) {
      if (this.slowExit) setTimeout(go, 1_000);
      else setImmediate(go);
    }
    return true;
  }
  die(code: number | null, signal: string | null = null): void {
    if (this.gone) return;
    this.gone = true;
    events.push(`${this.kind}-exit`);
    this.emit("exit", code, signal);
  }
}

/** What happened, in order: spawns and exits, by kind. */
const events: string[] = [];
const spawned: FakeProc[] = [];
const workers = () => spawned.filter((p) => p.kind === "worker");
const holds = () => spawned.filter((p) => p.kind === "hold");
setSpawnForTest((_cmd, args, opts) => {
  const kind = args.some((a) => a.endsWith("telegram-hold.ts")) ? "hold" : "worker";
  // Both run with the child's env: a tenant's own home, no shared database.
  assert.ok([childHome(TENANT), childHome(OTHER)].includes(String(opts.env?.MERRYMEN_HOME)));
  assert.equal(opts.env?.DATABASE_URL, undefined);
  const p = new FakeProc(kind);
  spawned.push(p);
  events.push(`${kind}-spawn`);
  return p as unknown as ChildProcess;
});

/** The restore, as the test wants it to come out. */
let restoreSays: { ok: true; line: string } | { ok: false; reason: string } = { ok: false, reason: NEWER };
let restores = 0;
setPaperRestoreForTest(async () => {
  restores += 1;
  return restoreSays;
});
const notices: string[] = [];
setHoldNoticeForTest(async (_tenant, cls) => {
  notices.push(cls);
  return "sent";
});

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => {
  said.push(a.map(String).join(" "));
};
after(() => {
  console.log = realLog;
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const store = getGrantStore();
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const alerts = () => said.filter((l) => l.includes("[alert] paper restore blocked"));

async function withClock(fn: () => Promise<void>) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    await fn();
  } finally {
    mock.timers.runAll();
    await settle(50);
    mock.timers.reset();
  }
}

const paperWithBot = { paperTradingEnabled: true, telegramEnabled: true, telegramBotToken: "111:a", telegramAllowlist: [4242] };
const readSettings = (t: string) =>
  JSON.parse(readFileSync(path.join(childHome(t), "settings.json"), "utf8")) as { telegramBotToken?: string };

beforeEach(async () => {
  // With no stored grant, a pass stands down whatever an earlier test left.
  await store.remove(TENANT);
  await store.remove(OTHER);
  await reconcile();
  await settle();
  rmSync(childHome(TENANT), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(childHome(OTHER), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await getSettingsStore().put(TENANT, paperWithBot as never);
  restoreSays = { ok: false, reason: NEWER };
  restores = 0;
  spawned.length = 0;
  events.length = 0;
  notices.length = 0;
  said.length = 0;
});

describe("a paper book that will not restore holds the tenant", () => {
  it("A HOLD PROCESS ANSWERS THE BOT, NO WORKER STARTS, AND THE PASS AFTER DOES NOT TRY AGAIN", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      await settle();
      assert.equal(holds().length, 1, `one hold process:\n${said.join("\n")}`);
      assert.equal(workers().length, 0, "and no worker: the book would restart its cash");
      assert.ok(isHeldForTest(TENANT));
      const block = readRestoreBlocked(childHome(TENANT));
      assert.equal(block?.reason, NEWER);
      assert.equal(block?.class, "trades newer than the last valuation");
      assert.deepEqual(alerts(), [`[orchestrator] [alert] paper restore blocked: ${TENANT} — trades newer than the last valuation`]);
      assert.deepEqual(notices, ["trades newer than the last valuation"], "the owner is told");

      // The pass that used to fail the same restore every 17 seconds.
      for (let i = 0; i < 4; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(restores, 1, "not re-run before its backoff");
      assert.equal(spawned.length, 1, "nothing else started");
      assert.equal(alerts().length, 1, "and said once");
    });
  });

  it("A TENANT WITH NO BOT IS HELD TOO, WITH NO PROCESS, AND STILL NOT RETRIED EVERY PASS", async () => {
    await getSettingsStore().put(TENANT, { paperTradingEnabled: true } as never);
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.ok(isHeldForTest(TENANT));
      assert.equal(spawned.length, 0, "nothing to answer, and nothing trades");
      assert.equal(restores, 1);
      assert.equal(notices.length, 1, "the notice is tried even with no hold process");
      // The owner switches Telegram on: the next pass answers the bot.
      await getSettingsStore().put(TENANT, paperWithBot as never);
      await reconcile();
      assert.equal(holds().length, 1, `the hold process starts from the refresh:\n${said.join("\n")}`);
      assert.equal(restores, 1, "without another restore");
    });
  });

  it("A LIVE OR UNFLAGGED BOOK IS NOT HELD: THE WORKER STARTS AS IT ALWAYS DID", async () => {
    await getSettingsStore().put(TENANT, { paperTradingEnabled: false, telegramEnabled: true, telegramBotToken: "111:a" } as never);
    await store.put(TENANT, grant());
    await reconcile();
    assert.equal(workers().length, 1);
    assert.equal(holds().length, 0);
    assert.ok(!isHeldForTest(TENANT));
    assert.ok(said.some((l) => l.includes(`paper restore: ${TENANT} FAILED — ${NEWER}`)));
  });
});

describe("the restore is retried on a backoff, and the owner told once per class", () => {
  it("2 MINUTES, THEN 4, AND A NEW CLASS IS A NEW ALERT AND A NEW NOTICE", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.equal(restores, 1);
      mock.timers.tick(2 * 60_000 + 1);
      await reconcile();
      assert.equal(restores, 2, "retried at 2 minutes");
      assert.equal(notices.length, 1, "the same class: not told again");
      assert.equal(alerts().length, 1);
      mock.timers.tick(2 * 60_000 + 1);
      await reconcile();
      assert.equal(restores, 2, "the next wait is 4 minutes");
      restoreSays = { ok: false, reason: NO_BASIS };
      mock.timers.tick(2 * 60_000);
      await reconcile();
      assert.equal(restores, 3);
      assert.deepEqual(notices, ["trades newer than the last valuation", "a holding has no cost basis"], "a new class is news");
      assert.equal(alerts().length, 2);
      assert.equal(readRestoreBlocked(childHome(TENANT))?.class, "a holding has no cost basis", "and the hold process says the new one");
      assert.equal(workers().length, 0);
      assert.equal(holds().length, 1, "the same hold process throughout");
    });
  });

  it("A HELD TENANT IS NOT RESPAWNED WHILE THE RESTORE FAILS (adopted hold)", async () => {
    await store.put(TENANT, grant());
    const proc = new FakeProc("hold");
    await adoptHolderForTest(TENANT, ACCOUNT, proc as unknown as ChildProcess);
    await withClock(async () => {
      for (let i = 0; i < 6; i++) {
        await reconcile();
        mock.timers.tick(15_000);
      }
      assert.equal(spawned.length, 0, "no worker, no second hold process");
      assert.equal(restores, 0, "and no restore inside its first 2 minutes");
      mock.timers.tick(60_000);
      await reconcile();
      assert.equal(restores, 1, "then it is tried");
      assert.equal(spawned.length, 0, "and still fails, so still held");
      assert.deepEqual(proc.signals, [], "the hold process keeps answering");
    });
  });

  it("A HOLD WHOSE RETRIES FLAP BETWEEN ITS CAUSE AND A DATABASE BLIP ALERTS ONCE PER CLASS AND TELLS THE OWNER ONCE", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const flap = async (reason: string, wait: number) => {
        restoreSays = { ok: false, reason };
        mock.timers.tick(wait + 1);
        await reconcile();
      };
      await flap(BLIP, 2 * 60_000);
      assert.equal(restores, 2);
      assert.equal(readRestoreBlocked(childHome(TENANT))?.class, NEWER_CLASS, "a blip does not replace the cause the hold process says");
      // A blip is tried again about a pass later, not on the book's backoff.
      await flap(NEWER, 15_000);
      assert.equal(restores, 3, "the blip was retried a pass later");
      await flap(BLIP, 4 * 60_000);
      await flap(NEWER, 15_000);
      assert.equal(restores, 5);
      assert.deepEqual(notices, [NEWER_CLASS], "the owner is told once, and never about the blip");
      assert.deepEqual(
        alerts(),
        [
          `[orchestrator] [alert] paper restore blocked: ${TENANT} — ${NEWER_CLASS}`,
          `[orchestrator] [alert] paper restore blocked: ${TENANT} — restore error`,
        ],
        "one alert per class, not one per flip",
      );
      assert.equal(readRestoreBlocked(childHome(TENANT))?.class, NEWER_CLASS);
      // And between two real causes: each is news once, a return to the first is not.
      await flap(NO_BASIS, 8 * 60_000);
      await flap(NEWER, 16 * 60_000);
      assert.equal(restores, 7);
      assert.deepEqual(notices, [NEWER_CLASS, "a holding has no cost basis"]);
      assert.equal(alerts().length, 3);
      assert.equal(readRestoreBlocked(childHome(TENANT))?.class, NEWER_CLASS, "the hold process says the cause of the day");
      assert.equal(holds().length, 1);
      assert.equal(workers().length, 0);
    });
  });

  it("A BLIP AT SPAWN HOLDS A HEALTHY BOOK ONLY UNTIL THE NEXT PASS OR SO, AND SAYS NOTHING TO ITS OWNER", async () => {
    restoreSays = { ok: false, reason: BLIP };
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.ok(isHeldForTest(TENANT), "held, so the bot is answered while the database is away");
      assert.deepEqual(notices, [], "a dropped connection is not a broken book, and the owner is not told it is");
      restoreSays = { ok: true, line: "paper cash, holdings and basis restored" };
      mock.timers.tick(15_000 + 1);
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `trading resumes a pass later, not two minutes later:\n${said.join("\n")}`);
      assert.ok(!isHeldForTest(TENANT));
      assert.deepEqual(notices, []);
    });
  });
});

describe("when the restore takes, trading comes back", () => {
  it("THE HOLD PROCESS IS STOPPED EXACTLY ONCE, ITS EXIT AWAITED, AND EXACTLY ONE WORKER STARTS", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      hold.slowExit = true;
      restoreSays = { ok: true, line: "paper cash, holdings and basis restored" };
      mock.timers.tick(2 * 60_000 + 1);
      const pass = reconcile();
      await settle(50);
      assert.equal(workers().length, 0, "no worker while the hold process is still up: two pollers on one bot");
      assert.ok(isHeldForTest(TENANT), "and the tenant stays held meanwhile, so no pass spawns it");
      mock.timers.tick(1_000);
      await pass;
      await settle();
      assert.deepEqual(hold.signals.filter((s) => s === "SIGTERM"), ["SIGTERM"], "stopped once");
      assert.equal(workers().length, 1, `one worker:\n${said.join("\n")}`);
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"], "the hold process was gone before the worker started");
      assert.ok(!isHeldForTest(TENANT));
      assert.equal(readRestoreBlocked(childHome(TENANT)), null, "and the hold's record with it");
      assert.ok(said.some((l) => /handing the bot back to trading/.test(l)));
      assert.ok(said.some((l) => new RegExp(`${TENANT} stood-down hold process \\(pid ${hold.pid}\\) exited`).test(l)), "its exit is a stand-down");
      // Later passes leave the worker alone.
      mock.timers.tick(15_000);
      await reconcile();
      assert.equal(spawned.length, 2);
    });
  });

  it("PRACTICE SWITCHED OFF WHILE HELD: THE HOLD IS HANDED BACK, ONCE, AND THE WORKER STARTS AS IT DID BEFORE HOLDS", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      hold.slowExit = true;
      // The restore still fails: the book is as broken as it was. What changed
      // is that the gate no longer holds a tenant for it.
      await getSettingsStore().put(TENANT, { ...paperWithBot, paperTradingEnabled: false } as never);
      mock.timers.tick(15_000);
      const pass = reconcile();
      await settle(50);
      assert.equal(workers().length, 0, "no worker while the hold process is still up");
      mock.timers.tick(1_000);
      await pass;
      await settle();
      assert.deepEqual(hold.signals.filter((s) => s === "SIGTERM"), ["SIGTERM"], "stopped once");
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"], "gone before the worker started");
      assert.ok(!isHeldForTest(TENANT));
      assert.equal(readRestoreBlocked(childHome(TENANT)), null, "and the hold's record with it");
      assert.ok(said.some((l) => l.includes(`${TENANT}: practice mode is off`)), said.join("\n"));
      assert.equal(readSettings(TENANT).telegramBotToken, "111:a", "the worker keeps the bot its hold answered");
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(workers().length, 1, "exactly one worker");
      assert.equal(holds().length, 1);
      assert.equal(readSettings(TENANT).telegramBotToken, "111:a", "and it is not taken from it by its own claim");
      assert.ok(!said.some((l) => l.includes("already claimed")), said.join("\n"));
    });
  });
});

describe("a held tenant is stood down like any other", () => {
  it("ITS GRANT GOES: THE HOLD PROCESS IS STOPPED AND THE HOME WIPED", async () => {
    await store.put(TENANT, grant());
    await reconcile();
    const hold = holds()[0]!;
    await store.remove(TENANT);
    await reconcile();
    await settle();
    assert.equal(hold.signals[0], "SIGTERM");
    assert.ok(!isHeldForTest(TENANT));
    assert.equal(existsSync(childHome(TENANT)), false, "the revoked session key and the bot token go with it");
    assert.equal(workers().length, 0);
  });

  it("A HOLD PROCESS THAT DIES IS PUT BACK BY THE NEXT PASS; THREE DEATHS IN A MINUTE STAND IT DOWN", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      holds()[0]!.die(1);
      assert.ok(!isHeldForTest(TENANT));
      await reconcile();
      assert.equal(restores, 2, "the next pass starts over, restore first");
      assert.equal(holds().length, 2);
      holds()[1]!.die(1);
      await reconcile();
      holds()[2]!.die(1);
      assert.ok(said.some((l) => /hold process keeps dying \(3 exits/.test(l)), said.join("\n"));
      await reconcile();
      mock.timers.tick(4 * 60_000);
      await reconcile();
      assert.equal(holds().length, 3, "stood down: no pass puts it straight back");
      mock.timers.tick(60_000 + 1);
      await reconcile();
      assert.equal(holds().length, 4, "and tried again after the cool-off");
    });
  });

  it("A HELD TENANT'S BOT IS STILL ITS OWN: THE DE-DUPLICATION SEES IT, AND FIRST", async () => {
    // The same bot saved under a second, trading login: the incident's shape.
    await getSettingsStore().put(OTHER, { paperTradingEnabled: false, telegramEnabled: true, telegramBotToken: "111:a" } as never);
    await store.put(TENANT, grant());
    await store.put(OTHER, { ...grant(), smartAccount: "0x00000000000000000000000000000000000000c9" } as never);
    await reconcile();
    assert.ok(isHeldForTest(TENANT));
    assert.equal(workers().length, 1, "the other login trades");
    assert.equal(readSettings(TENANT).telegramBotToken, "111:a", "the held tenant keeps answering its bot");
    assert.equal(readSettings(OTHER).telegramBotToken, undefined, "and a second poller on it is refused the token");
    assert.ok(said.some((l) => l.includes(`${OTHER}: telegram bot token already claimed by another tenant`)), said.join("\n"));
  });

  it("A HELD TENANT WITH TELEGRAM OFF CLAIMS NO BOT: A TRADING LOGIN ON THE SAME TOKEN KEEPS IT", async () => {
    await getSettingsStore().put(TENANT, { paperTradingEnabled: true, telegramEnabled: false, telegramBotToken: "111:a" } as never);
    await getSettingsStore().put(OTHER, { paperTradingEnabled: false, telegramEnabled: true, telegramBotToken: "111:a" } as never);
    await store.put(TENANT, grant());
    await store.put(OTHER, { ...grant(), smartAccount: "0x00000000000000000000000000000000000000c9" } as never);
    await reconcile();
    await reconcile();
    assert.ok(isHeldForTest(TENANT));
    assert.equal(holds().length, 0, "nothing answers the held tenant's bot");
    assert.equal(workers().length, 1);
    assert.equal(readSettings(OTHER).telegramBotToken, "111:a", "so the one login that polls it keeps it: somebody answers");
    assert.ok(!said.some((l) => l.includes("already claimed")), said.join("\n"));
  });

  it("A HELD TENANT REVOKED IN THE PASS ITS OWNER SWITCHES TELEGRAM ON GETS NO HOLD PROCESS", async () => {
    await getSettingsStore().put(TENANT, { paperTradingEnabled: true } as never);
    await store.put(TENANT, grant());
    await reconcile();
    assert.ok(isHeldForTest(TENANT));
    await getSettingsStore().put(TENANT, paperWithBot as never);
    await store.remove(TENANT);
    await reconcile();
    await settle();
    assert.equal(spawned.length, 0, "no process started to poll a revoked tenant's bot, only to be killed in a wiped home");
    assert.ok(!isHeldForTest(TENANT));
    assert.equal(existsSync(childHome(TENANT)), false);
  });
});
