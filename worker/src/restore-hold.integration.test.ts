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
 * is driven over sqlite in restore-hold.test.ts. The last block swaps the
 * restore seam for the real restore over a sqlite ledger, and gives the
 * practice reset the same ledger (setHeldResetDbForTest).
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so this never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-restore-hold-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");
process.env.MERRYMEN_TICK_SECONDS = "60";

const {
  reconcile,
  childHome,
  fleetHaltFile,
  setSpawnForTest,
  setPaperRestoreForTest,
  setHoldNoticeForTest,
  adoptHolderForTest,
  isHeldForTest,
  loseLeaseForTest,
  hasLeaseForTest,
  honourFleetHalt,
  setHeldResetDbForTest,
} = await import("./orchestrator");
const { applyLedgerSchema } = await import("./store");
const { PAPER_CHECKPOINT_SCHEMA, restorePaperCheckpoint } = await import("./paper-checkpoint");
const { HELD_RESET_DONE, HELD_RESET_EXPIRED } = await import("./held-reset");
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
  /**
   * Does not go at all, SIGKILL included, until the test says (`die`): a
   * process stuck in the kernel, or stopped and resumed, whose exit the
   * orchestrator never sees in time.
   */
  deaf = false;
  constructor(readonly kind: "worker" | "hold") {
    super();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    const go = () => this.die(null, String(signal ?? "SIGTERM"));
    if (!this.gone && !this.deaf) {
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
/**
 * Or, when set, the REAL restore, against this shared ledger and an empty
 * home, which is what a held tenant's home is: a restore that fails writes
 * nothing, and neither does one that finds nothing to restore.
 */
let ledger: Db | null = null;
let restores = 0;
setPaperRestoreForTest(async (_tenant, account) => {
  restores += 1;
  if (!ledger) return restoreSays;
  const raw = new DatabaseSync(":memory:");
  try {
    const home = wrapSqlite(raw);
    await applyLedgerSchema(home);
    return { ok: true, line: await restorePaperCheckpoint(home, ledger, account) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    raw.close();
  }
});
const notices: string[] = [];
/** Whether each notice offered the practice reset, beside `notices`. */
const offered: boolean[] = [];
setHoldNoticeForTest(async (_tenant, cls, resettable) => {
  notices.push(cls);
  offered.push(resettable);
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
/**
 * Turn the loop until `ready()` holds, however many turns that takes.
 *
 * A fixed number of turns is a guess about how much real I/O sits between here
 * and the state the next line assumes, and CI guessed differently: on Node 22
 * the pass had not yet signalled the hold process after fifty turns, so the
 * one-second tick meant for its exit fired at nothing, the pass waited on a
 * mocked timer nobody would ever advance, and the event loop emptied under it.
 * Bounded by the real clock (`performance` is not among the mocked APIs), so
 * a state that never comes fails here, by name, instead of hanging the file.
 */
const waitFor = async (ready: () => boolean, what: string) => {
  const t0 = performance.now();
  while (!ready()) {
    if (performance.now() - t0 > 10_000) assert.fail(`never happened: ${what}\n${said.join("\n")}`);
    await new Promise((r) => setImmediate(r));
  }
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
  // A hold process an earlier test left stuck, gone now, so the stand-down
  // below is not left waiting on it.
  for (const p of spawned) if (p.deaf) p.die(null, "SIGKILL");
  // With no stored grant, a pass stands down whatever an earlier test left.
  await store.remove(TENANT);
  await store.remove(OTHER);
  await reconcile();
  await settle();
  rmSync(childHome(TENANT), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(childHome(OTHER), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await getSettingsStore().put(TENANT, paperWithBot as never);
  restoreSays = { ok: false, reason: NEWER };
  ledger = null;
  setHeldResetDbForTest(null);
  restores = 0;
  spawned.length = 0;
  events.length = 0;
  notices.length = 0;
  offered.length = 0;
  said.length = 0;
  rmSync(fleetHaltFile(), { force: true });
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
      await waitFor(() => hold.signals.includes("SIGTERM"), "the pass asks the hold process to stop");
      await settle();
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
      await waitFor(() => hold.signals.includes("SIGTERM"), "the pass asks the hold process to stop");
      await settle();
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

  /**
   * Hold the tenant, then let its restore take with a hold process that will
   * not exit: the handover sends SIGTERM, SIGKILL three seconds later, and
   * gives up waiting at ten. Returns once that pass is over.
   */
  async function stuckHandover(): Promise<FakeProc> {
    await reconcile();
    const hold = holds()[0]!;
    hold.deaf = true;
    restoreSays = { ok: true, line: "paper cash, holdings and basis restored" };
    mock.timers.tick(2 * 60_000 + 1);
    const pass = reconcile();
    await waitFor(() => hold.signals.includes("SIGTERM"), "the pass asks the hold process to stop");
    mock.timers.tick(3_000);
    assert.ok(hold.signals.includes("SIGKILL"), "and kills it three seconds later");
    mock.timers.tick(7_000);
    await pass;
    await settle();
    return hold;
  }

  it("A HOLD PROCESS THAT WILL NOT EXIT KEEPS TRADING HELD UNTIL IT DOES: ONE ALERT, THEN EXACTLY ONE WORKER", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      const hold = await stuckHandover();
      assert.equal(workers().length, 0, `no worker beside a hold process that may still poll the bot:\n${said.join("\n")}`);
      assert.ok(isHeldForTest(TENANT), "still held, so no pass spawns it");
      const stuck = () => said.filter((l) => l.includes("[alert]") && l.includes(`pid ${hold.pid}`));
      assert.equal(stuck().length, 1, `one alert, naming the process:\n${said.join("\n")}`);
      // Passes go by: nothing starts, nothing is said again, the restore is
      // not run again, and the process is killed again once a pass.
      const kills = hold.signals.length;
      const tried = restores;
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      await settle();
      assert.equal(workers().length, 0);
      assert.equal(holds().length, 1, "and no second hold process beside it either");
      assert.ok(isHeldForTest(TENANT));
      assert.equal(stuck().length, 1, "the alert is said once, not every pass");
      assert.equal(restores, tried, "the handover is decided: its restore is not tried again meanwhile");
      assert.deepEqual(hold.signals.slice(kills), ["SIGKILL", "SIGKILL", "SIGKILL"], "SIGKILL again once a pass, not in a loop");
      // It goes at last. Its exit ends a stand-down, not a crash: no brake,
      // no hold put back, and nothing started from the exit itself.
      hold.die(null, "SIGKILL");
      assert.ok(said.some((l) => l.includes(`${TENANT} stood-down hold process (pid ${hold.pid}) exited`)), said.join("\n"));
      assert.ok(!said.some((l) => /hold process exited \(|keeps dying/.test(l)), said.join("\n"));
      assert.equal(workers().length, 0);
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `the next pass hands over, to exactly one worker:\n${said.join("\n")}`);
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"], "and only after the exit was seen");
      assert.ok(!isHeldForTest(TENANT));
      assert.equal(readRestoreBlocked(childHome(TENANT)), null, "and the hold's record with it");
      for (let i = 0; i < 2; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(spawned.length, 2, "later passes leave the worker alone");
    });
  });

  it("A GRANT REMOVED WHILE THE HOLD PROCESS WILL NOT EXIT STARTS NOTHING, NOR DOES ONE SIGNED AGAIN, UNTIL IT HAS GONE", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      const hold = await stuckHandover();
      assert.equal(workers().length, 0);
      await store.remove(TENANT);
      for (let i = 0; i < 2; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      await settle();
      assert.equal(spawned.length, 1, `nothing started for a revoked tenant:\n${said.join("\n")}`);
      assert.equal(existsSync(childHome(TENANT)), false, "its home wiped, as for any stand-down");
      assert.equal(said.filter((l) => l.includes(`${TENANT} grant removed — standing its hold down`)).length, 1, "stood down once, not every pass");
      assert.ok(isHeldForTest(TENANT), "and still counted until its process is seen to go");
      // Signed again before the old process has gone: still nothing beside it.
      await store.put(TENANT, grant());
      for (let i = 0; i < 2; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      await settle();
      assert.equal(spawned.length, 1, `nothing starts beside a process that may still poll the bot:\n${said.join("\n")}`);
      hold.die(null, "SIGKILL");
      assert.ok(!isHeldForTest(TENANT), "a stood-down hold leaves with its process");
      assert.ok(!said.some((l) => /hold process exited \(|keeps dying/.test(l)), said.join("\n"));
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `then the grant signed again starts one worker:\n${said.join("\n")}`);
      assert.equal(holds().length, 1);
    });
  });

  it("A HOLD PROCESS STILL THERE AN HOUR ON IS SAID AGAIN, HOURLY, AND NOT EVERY PASS", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      const hold = await stuckHandover();
      const stuck = () => said.filter((l) => l.includes("[alert]") && l.includes(`pid ${hold.pid}`));
      assert.equal(stuck().length, 1);
      mock.timers.tick(59 * 60_000);
      await reconcile();
      assert.equal(stuck().length, 1, "not before the hour");
      mock.timers.tick(60_000);
      await reconcile();
      assert.equal(stuck().length, 2, `said again an hour after the first:\n${said.join("\n")}`);
      assert.match(stuck()[1]!, /still has not exited, 60m after SIGTERM — trading stays held until it has/);
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(stuck().length, 2, "and then not every pass");
      assert.equal(workers().length, 0);
    });
  });

  it("PRACTICE SWITCHED OFF WITH A HOLD PROCESS THAT WILL NOT EXIT: NO WORKER UNTIL IT HAS, AND THE GATE SAYS SO ONCE", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      hold.deaf = true;
      // The restore still fails; the gate no longer holds a live owner for it.
      await getSettingsStore().put(TENANT, { ...paperWithBot, paperTradingEnabled: false } as never);
      mock.timers.tick(15_000);
      const pass = reconcile();
      await waitFor(() => hold.signals.includes("SIGTERM"), "the pass asks the hold process to stop");
      mock.timers.tick(3_000);
      assert.ok(hold.signals.includes("SIGKILL"), "and kills it three seconds later");
      mock.timers.tick(7_000);
      await pass;
      await settle();
      const released = () => said.filter((l) => l.includes(`${TENANT}: practice mode is off`));
      const stuck = () => said.filter((l) => l.includes("[alert]") && l.includes(`pid ${hold.pid}`));
      assert.equal(workers().length, 0, `no worker beside a process that may still poll the bot:\n${said.join("\n")}`);
      assert.ok(isHeldForTest(TENANT));
      assert.equal(stuck().length, 1, said.join("\n"));
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      await settle();
      assert.equal(workers().length, 0);
      assert.equal(holds().length, 1, "no second hold process either");
      assert.equal(stuck().length, 1, "the alert said once");
      assert.equal(released().length, 1, "and the gate's release said once, not every pass it waits");
      hold.die(null, "SIGKILL");
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `then exactly one worker:\n${said.join("\n")}`);
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"]);
      assert.ok(!isHeldForTest(TENANT));
      assert.equal(released().length, 1);
      assert.equal(readSettings(TENANT).telegramBotToken, "111:a", "the worker keeps the bot its hold answered");
    });
  });

  it("A LEASE LOST WHILE A HANDOVER WAITS ON A STUCK HOLD PROCESS STARTS NOTHING UNTIL IT HAS GONE, THEN ONE WORKER", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      const hold = await stuckHandover();
      loseLeaseForTest(TENANT);
      for (let i = 0; i < 2; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      await settle();
      assert.ok(said.some((l) => l.includes(`${TENANT}: lease lost`)), said.join("\n"));
      assert.equal(spawned.length, 1, `the spawn loop does not take the lease again beside it:\n${said.join("\n")}`);
      assert.ok(isHeldForTest(TENANT));
      hold.die(null, "SIGKILL");
      assert.ok(!isHeldForTest(TENANT), "stood down, it leaves with its process");
      assert.ok(!said.some((l) => /hold process exited \(|keeps dying/.test(l)), said.join("\n"));
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `the lease taken again, and one worker:\n${said.join("\n")}`);
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"]);
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

  /**
   * A STAND-DOWN WAITS FOR THE HOLD PROCESS'S EXIT TOO, not only a handover.
   * Forgotten on SIGTERM, as it was, a process that outlives SIGKILL (stopped
   * and resumed, or stuck in the kernel) went on polling the bot while the
   * next spawn started beside it: once the grant was signed again, or, for a
   * lost lease, in the very same pass.
   */
  const stoodDownAlerts = (hold: FakeProc) => said.filter((l) => l.includes("[alert]") && l.includes(`pid ${hold.pid}`));

  it("A GRANT REMOVED UNDER A HOLD PROCESS THAT WILL NOT EXIT, THEN SIGNED AGAIN, STARTS NOTHING UNTIL IT HAS GONE", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      hold.deaf = true;
      await store.remove(TENANT);
      mock.timers.tick(15_000);
      await reconcile();
      assert.equal(hold.signals[0], "SIGTERM");
      assert.equal(existsSync(childHome(TENANT)), false, "its home wiped, as for any stand-down");
      assert.ok(isHeldForTest(TENANT), "still counted until its process is seen to go");
      assert.ok(hasLeaseForTest(TENANT), "and its lease kept, so no other replica starts one beside it either");
      // Signed again, with a book that restores now: still nothing beside it.
      await store.put(TENANT, grant());
      restoreSays = { ok: true, line: "paper cash, holdings and basis restored" };
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      await settle();
      assert.equal(spawned.length, 1, `no worker and no second hold process beside it:\n${said.join("\n")}`);
      assert.equal(stoodDownAlerts(hold).length, 1, `one alert, naming the process:\n${said.join("\n")}`);
      assert.ok(hold.signals.filter((s) => s === "SIGKILL").length >= 3, "SIGKILL at three seconds, and again each pass");
      assert.equal(said.filter((l) => l.includes(`${TENANT} grant removed — standing its hold down`)).length, 1, "stood down once, not every pass");
      assert.ok(hasLeaseForTest(TENANT));
      assert.ok(stoodDownAlerts(hold)[0]!.includes("its lease is kept"), "and the alert says the lease is kept");
      // It goes at last: a stand-down's end, not a crash.
      hold.die(null, "SIGKILL");
      assert.ok(!isHeldForTest(TENANT), "a stood-down hold leaves with its process");
      await waitFor(() => !hasLeaseForTest(TENANT), "the lease it kept is let go with it");
      assert.ok(!said.some((l) => /hold process exited \(|keeps dying/.test(l)), said.join("\n"));
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `then the grant signed again starts exactly one worker:\n${said.join("\n")}`);
      assert.equal(holds().length, 1);
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"], "and only after the exit was seen");
    });
  });

  it("A LEASE LOST UNDER A HOLD PROCESS THAT WILL NOT EXIT IS NOT TAKEN AGAIN BESIDE IT, IN THAT PASS OR ANY OTHER", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      hold.deaf = true;
      loseLeaseForTest(TENANT);
      mock.timers.tick(15_000);
      await reconcile();
      assert.ok(said.some((l) => l.includes(`${TENANT}: lease lost`)), said.join("\n"));
      assert.equal(hold.signals[0], "SIGTERM");
      // The spawn loop runs in the same pass, straight after the stand-down.
      assert.equal(spawned.length, 1, `the lease is not taken again and a second process started in the same pass:\n${said.join("\n")}`);
      assert.ok(isHeldForTest(TENANT));
      restoreSays = { ok: true, line: "paper cash, holdings and basis restored" };
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      await settle();
      assert.equal(spawned.length, 1, `nor on any pass after it:\n${said.join("\n")}`);
      assert.equal(stoodDownAlerts(hold).length, 1, said.join("\n"));
      assert.ok(stoodDownAlerts(hold)[0]!.includes("its lease is gone"), "the alert says another replica may take the tenant meanwhile");
      hold.die(null, "SIGKILL");
      assert.ok(!isHeldForTest(TENANT));
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `the lease taken again once it has gone, and one worker:\n${said.join("\n")}`);
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"]);
    });
  });

  it("FLEET_HALT STANDS A HOLD PROCESS DOWN ONCE AND SAYS SO ONCE, AND ONE THAT WILL NOT EXIT KEEPS THE TENANT DARK AFTER THE HALT", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      hold.deaf = true;
      writeFileSync(fleetHaltFile(), "halt\n");
      for (let i = 0; i < 4; i++) {
        await honourFleetHalt();
        mock.timers.tick(15_000);
      }
      const halted = said.filter((l) => l.includes("FLEET_HALT present"));
      assert.equal(halted.length, 1, `said once, not every loop the process lives:\n${said.join("\n")}`);
      assert.equal(hold.signals.filter((s) => s === "SIGTERM").length, 1, "stood down once");
      assert.ok(hold.signals.filter((s) => s === "SIGKILL").length >= 3, "and killed again each loop, as a pass would");
      assert.equal(stoodDownAlerts(hold).length, 1, said.join("\n"));
      assert.ok(isHeldForTest(TENANT));
      assert.ok(hasLeaseForTest(TENANT), "its lease kept while the process lives: another replica would start beside it");
      assert.ok(stoodDownAlerts(hold)[0]!.includes("its lease is kept"), said.join("\n"));
      // The halt lifted before the process has gone: still nothing beside it.
      rmSync(fleetHaltFile(), { force: true });
      restoreSays = { ok: true, line: "paper cash, holdings and basis restored" };
      for (let i = 0; i < 2; i++) {
        await reconcile();
        mock.timers.tick(15_000);
      }
      await settle();
      assert.equal(spawned.length, 1, `nothing starts beside it:\n${said.join("\n")}`);
      hold.die(null, "SIGKILL");
      await reconcile();
      await settle();
      assert.equal(workers().length, 1, `then exactly one worker:\n${said.join("\n")}`);
      assert.equal(said.filter((l) => l.includes("FLEET_HALT present")).length, 1);
    });
  });

  it("A STOOD-DOWN HOLD PROCESS THAT WILL NOT EXIT STILL COUNTS FOR ITS BOT: ANOTHER LOGIN ON THE SAME TOKEN IS NOT HANDED IT MEANWHILE", async () => {
    // The incident's shape: the same bot under a second, trading login. No
    // claims can be read here, so the pass's own record is the only guard.
    await getSettingsStore().put(OTHER, { paperTradingEnabled: false, telegramEnabled: true, telegramBotToken: "111:a" } as never);
    await store.put(TENANT, grant());
    await store.put(OTHER, { ...grant(), smartAccount: "0x00000000000000000000000000000000000000c9" } as never);
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      assert.equal(readSettings(OTHER).telegramBotToken, undefined, "premise: the held tenant's bot, so the other login is refused it");
      hold.deaf = true;
      // Revoked: its process is told to stop at the end of this pass, and
      // may poll on after it. The other login is not handed the bot beside it,
      // not in this pass and not while it lives, signed again or not.
      await store.remove(TENANT);
      mock.timers.tick(15_000);
      await reconcile();
      assert.equal(readSettings(OTHER).telegramBotToken, undefined, `not in the pass that stands it down:\n${said.join("\n")}`);
      mock.timers.tick(15_000);
      await reconcile();
      await store.put(TENANT, grant());
      for (let i = 0; i < 2; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(readSettings(OTHER).telegramBotToken, undefined, `nor while it lives, its grant signed again:\n${said.join("\n")}`);
      assert.equal(spawned.length, 2, "the other login's worker and the stuck hold process, and nothing else");
      // Gone: one poller again, whichever login the pass hands it to.
      hold.die(null, "SIGKILL");
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      const pollers = [TENANT, OTHER].filter((t) => readSettings(t).telegramBotToken === "111:a");
      assert.equal(pollers.length, 1, `exactly one login is handed the bot:\n${said.join("\n")}`);
    });
  });

  it("UNDER FLEET_HALT THE LEASE A STUCK HOLD PROCESS KEPT IS LET GO WHEN IT EXITS, WITHOUT A SECOND WORD", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      hold.deaf = true;
      writeFileSync(fleetHaltFile(), "halt\n");
      await honourFleetHalt();
      mock.timers.tick(15_000);
      await honourFleetHalt();
      assert.ok(hasLeaseForTest(TENANT), "kept while it lives");
      hold.die(null, "SIGKILL");
      await waitFor(() => !hasLeaseForTest(TENANT), "released on its exit");
      assert.ok(!isHeldForTest(TENANT));
      mock.timers.tick(15_000);
      await honourFleetHalt();
      assert.equal(said.filter((l) => l.includes("FLEET_HALT present")).length, 1, `not said again for the lease it kept:\n${said.join("\n")}`);
      assert.equal(spawned.length, 1, "and nothing started under the halt");
    });
  });

  it("A HOLD PROCESS THAT GOES WHEN IT IS TOLD IS STOOD DOWN AS BEFORE: NO ALERT, AND THE TENANT FREE A PASS LATER", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      const hold = holds()[0]!;
      loseLeaseForTest(TENANT);
      mock.timers.tick(15_000);
      await reconcile();
      await waitFor(() => !isHeldForTest(TENANT), "its exit is seen");
      assert.equal(hold.signals[0], "SIGTERM");
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(holds().length, 2, `the next pass takes the lease again and holds it afresh:\n${said.join("\n")}`);
      assert.ok(!said.some((l) => l.includes("[alert]") && l.includes(`pid ${hold.pid}`)), said.join("\n"));
    });
  });
});

/**
 * A PRACTICE RESET ITS OWNER ASKS FOR WHILE THE BOOK IS HELD (plan §3.4).
 *
 * Here the restore is the real one, over a sqlite ledger holding 0x542978's
 * condition (a paper fill newer than the last valuation), and so are the
 * claim and the reset (held-reset.ts, through setHeldResetDbForTest). Only the
 * processes are fakes.
 */
describe("a practice reset its owner asks for while held", () => {
  let shared: { raw: DatabaseSync; db: Db } | null = null;
  after(() => shared?.raw.close());
  async function useLedger(): Promise<Db> {
    shared?.raw.close();
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    await db.exec(PAPER_CHECKPOINT_SCHEMA);
    await db.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch, mode)
      VALUES (?, '0xowner', '0xsession', 4663, '{}', 1, 2, 1, 'paper')`).run(ACCOUNT);
    await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at)
      VALUES (?, '0', 900, 0, 110, 1010, 1, 'paper', 10)`).run(ACCOUNT);
    await db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, epoch, created_at)
      VALUES (?, 'swap', 'NVDA', 100, 'paper', 1, 11)`).run(ACCOUNT);
    shared = { raw, db };
    ledger = db;
    setHeldResetDbForTest(db);
    return db;
  }
  const ask = (db: Db, id: string, at: number) =>
    db.prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, 'paper-reset', ?)").run(id, ACCOUNT, at);
  const commandRow = async (db: Db, id: string) =>
    ({ ...((await db.prepare("SELECT claimed_at, done_at, result FROM agent_commands WHERE id = ?").get(id)) as object) }) as {
      claimed_at: number | null;
      done_at: number | null;
      result: string | null;
    };
  const epochOf = async (db: Db) => Number(((await db.prepare("SELECT epoch FROM agents").get()) as { epoch: number }).epoch);
  const startedOver = () => said.filter((l) => l.includes("practice book started over at its owner's request"));

  it("HELD, THEN THE OWNER PRESSES RESTART: THE NEXT PASS STARTS THE BOOK OVER, STOPS THE HOLD PROCESS, AND STARTS ONE WORKER", async () => {
    const db = await useLedger();
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.ok(isHeldForTest(TENANT), `premise: the real restore refuses this book:\n${said.join("\n")}`);
      assert.equal(readRestoreBlocked(childHome(TENANT))?.class, NEWER_CLASS);
      mock.timers.tick(15_000);
      await reconcile();
      assert.equal(restores, 1, "premise: nothing asked, so the two-minute backoff stands");

      // The owner presses Restart the practice book, well inside the backoff.
      await ask(db, "r1", Date.now());
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.deepEqual(events, ["hold-spawn", "hold-exit", "worker-spawn"], `the hold process was gone before the worker started:\n${said.join("\n")}`);
      // Failed, started over, restored to nothing; then the spawn restores once more.
      assert.equal(restores, 4);
      assert.ok(!isHeldForTest(TENANT));
      assert.equal(readRestoreBlocked(childHome(TENANT)), null);
      assert.equal(await epochOf(db), 2, "the book opens a new epoch");
      const r = await commandRow(db, "r1");
      assert.ok(r.claimed_at && r.done_at, "claimed and answered, so no ferry hands it to the worker");
      assert.equal(r.result, HELD_RESET_DONE);
      assert.equal(startedOver().length, 1, said.join("\n"));
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(workers().length, 1, "exactly one worker");
      assert.equal(await epochOf(db), 2, "and started over exactly once");
    });
  });

  it("A RESET ALREADY WAITING AT SPAWN IS HONOURED THERE: NO HOLD, NO NOTICE, ONE WORKER", async () => {
    // The web's Start over: the reset is queued and the grant discarded, and
    // this spawn is the one the owner's new signature brings.
    const db = await useLedger();
    await ask(db, "r1", Date.now() - 60 * 60_000);
    await store.put(TENANT, grant());
    await reconcile();
    await settle();
    assert.equal(workers().length, 1, said.join("\n"));
    assert.equal(holds().length, 0, "never held");
    assert.deepEqual(notices, [], "and the owner is not told their book is broken");
    assert.ok(!isHeldForTest(TENANT));
    assert.equal(restores, 2, "refused, then nothing to restore");
    assert.equal(await epochOf(db), 2);
    assert.equal((await commandRow(db, "r1")).result, HELD_RESET_DONE);
  });

  it("A LIVE OWNER'S RESET IS NOT HONOURED, AND ONE PRESS BRINGS ONE RETRY FORWARD, NOT ONE EVERY PASS", async () => {
    const db = await useLedger();
    await getSettingsStore().put(TENANT, { ...paperWithBot, liveTradingEnabled: true } as never);
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.ok(isHeldForTest(TENANT));
      await ask(db, "r1", Date.now());
      mock.timers.tick(15_000);
      await reconcile();
      assert.equal(restores, 2, "the press brought a retry forward");
      for (let i = 0; i < 4; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(restores, 2, "once, not on every pass while the row waits");
      assert.ok(isHeldForTest(TENANT), "still held");
      assert.equal(workers().length, 0);
      assert.equal(await epochOf(db), 1, "the book is not touched");
      assert.deepEqual(await commandRow(db, "r1"), { claimed_at: null, done_at: null, result: null });
      assert.equal(said.filter((l) => l.includes("not honoured while held — live trading is switched on")).length, 1, said.join("\n"));
    });
  });

  it("A RESET OLDER THAN SEVEN DAYS IS NOT ACTED ON, AND IS CLOSED THERE, SO NOTHING RUNS IT LATER", async () => {
    const db = await useLedger();
    await store.put(TENANT, grant());
    await withClock(async () => {
      // The owner's Sep 21 press, still unclaimed a week and more later.
      await ask(db, "r1", Date.now() - 8 * 24 * 60 * 60_000);
      await reconcile();
      assert.ok(isHeldForTest(TENANT), "held, not reset");
      assert.equal(await epochOf(db), 1);
      const r = await commandRow(db, "r1");
      assert.ok(r.claimed_at && r.done_at, "closed, so no worker a later restore hands the tenant to is ferried it");
      assert.equal(r.result, HELD_RESET_EXPIRED);
      for (let i = 0; i < 4; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(restores, 1, "nothing brought forward");
      mock.timers.tick(2 * 60_000);
      await reconcile();
      assert.equal(restores, 2, "the backoff's own retry");
      assert.ok(isHeldForTest(TENANT));
      assert.equal(said.filter((l) => /not honoured while held — .*seven days.*closed unrun/.test(l)).length, 1, said.join("\n"));
    });
  });

  it("A LIVE OWNER'S RESET WAITING AT SPAWN IS LOOKED AT THERE, AND NOT AGAIN LATER IN THE SAME PASS", async () => {
    const db = await useLedger();
    await getSettingsStore().put(TENANT, { ...paperWithBot, liveTradingEnabled: true } as never);
    await ask(db, "r1", Date.now() - 60 * 60_000);
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.ok(isHeldForTest(TENANT));
      assert.equal(restores, 1, "the spawn's restore, and no early retry for a reset the spawn had just refused");
      for (let i = 0; i < 4; i++) {
        mock.timers.tick(15_000);
        await reconcile();
      }
      assert.equal(restores, 1, "nor on any pass after it");
      assert.equal(said.filter((l) => l.includes("not honoured while held — live trading is switched on")).length, 1, said.join("\n"));
    });
  });

  it("A PRESS WHILE THE HOLD MAY NOT LEAVE (FLEET_HALT) IS STILL OWED ITS EARLY LOOK WHEN IT MAY", async () => {
    const db = await useLedger();
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.ok(isHeldForTest(TENANT));
      writeFileSync(fleetHaltFile(), "");
      await ask(db, "r1", Date.now());
      mock.timers.tick(15_000);
      await reconcile();
      assert.equal(restores, 1, "nothing tried while the fleet is halted");
      assert.equal(await epochOf(db), 1);
      rmSync(fleetHaltFile(), { force: true });
      mock.timers.tick(15_000);
      await reconcile();
      await settle();
      assert.equal(await epochOf(db), 2, `started over on the first pass it could be, not at the end of the backoff:\n${said.join("\n")}`);
      assert.equal((await commandRow(db, "r1")).result, HELD_RESET_DONE);
      assert.equal(workers().length, 1);
    });
  });

  it("THE RESET IS OFFERED ONLY WHERE IT WOULD BE HONOURED, AND THE OFFER FOLLOWS THE SETTINGS", async () => {
    await useLedger();
    await getSettingsStore().put(TENANT, { ...paperWithBot, liveTradingEnabled: true } as never);
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.ok(isHeldForTest(TENANT));
      assert.equal(readRestoreBlocked(childHome(TENANT))?.resettable, false, "live switched on beside practice: it would be refused");
      assert.deepEqual(offered, [false], "and the notice does not send them round the loop either");
      await getSettingsStore().put(TENANT, paperWithBot as never);
      mock.timers.tick(15_000);
      await reconcile();
      assert.equal(readRestoreBlocked(childHome(TENANT))?.resettable, true, "switched off: the hold process offers it from the next reply");
      assert.equal(readRestoreBlocked(childHome(TENANT))?.class, NEWER_CLASS, "and the rest of the record is as it was");
    });
  });
});
