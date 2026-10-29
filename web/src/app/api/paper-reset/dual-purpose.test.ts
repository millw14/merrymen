/**
 * A PRACTICE RESET IS QUEUED FOR THE WALLET IT NAMES, AND NEVER THE OTHER (D12).
 *
 * `POST /api/paper-reset?wallet=perps` queues a reset of the Perps wallet's
 * practice book for its own worker, with the account resolved in the SAME
 * wallet (agent-for.ts, start-over.ts queuePaperReset); no `?wallet=` is the
 * Spot book, exactly as the phones send it. A Perps reset is refused where no
 * Perps worker runs (MERRYMEN_PERPS not paper): hosted its practice book is
 * frozen, and self-hosted a worker started by hand still keeps its stops, which
 * is what each refusal says.
 * And a Perps reset carries a deadline, the Perps worker's order window, so
 * one asked for at paper and still waiting when perps are stood down is
 * answered expired when they return — never run days late — and, self-hosted,
 * the account it was asked for, so a Perps wallet made again in the same home
 * never has it run on its book.
 *
 * Self-hosted runs to the files each worker drains. Hosted runs as far as the
 * account: the queue is the shared table, which needs Postgres here
 * (recovery-commands.test.ts runs its statements against sqlite, and
 * worker/src/perps-order-ferry.test.ts shows a Perps reset row reaches only
 * the Perps worker).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";

import type { StoredGrant } from "@merrymen/core";
import { purposeHome } from "@merrymen/home";
import { mintSession } from "@/lib/auth";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { claimCommandFile, commandDir, runTickCommand, type CommandOutcome, type FileCommand } from "../../../../../worker/src/command-files";
import { mergeSettings, perpsWorkerStoodDown } from "../../../../../worker/src/settings";
import { orderTtlMs } from "@/lib/order-state";
import { PERPS_RESET_NOT_REPORTED } from "@/lib/perps-book-reported";
import { POST } from "./route";

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_SESSION_SECRET", "MERRYMEN_PERPS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const SPOT = `0x${"11".repeat(20)}`;
const PERPS = `0x${"22".repeat(20)}`;
const homes: string[] = [];
let home: string;

const reset = (query: string, tenant?: `0x${string}`) =>
  POST(new Request(`https://app.example.test/api/paper-reset${query}`, {
    method: "POST",
    ...(tenant ? { headers: { cookie: `mm_session=${mintSession(tenant)}` } } : {}),
  }));
const filesIn = (h: string) => (existsSync(commandDir(h)) ? readdirSync(commandDir(h)) : []);

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mm-dual-wallet-reset-"));
  homes.push(home);
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_PERPS = "paper";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.DATABASE_URL;
  resetGrantStoreForTest();
  writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: SPOT, demoOwnerPrivateKey: `0x${"33".repeat(32)}` }));
});
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGrantStoreForTest();
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("self-hosted: each wallet's reset lands in its own home", () => {
  it("A PERPS RESET IS QUEUED ONLY IN THE PERPS HOME, and Spot's only in Spot's", async () => {
    mkdirSync(purposeHome("perps"), { recursive: true });
    writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
    const perps = await reset("?wallet=perps");
    assert.equal(perps.status, 200, JSON.stringify(await perps.clone().json()));
    assert.equal(((await perps.json()) as { queued?: boolean }).queued, true);
    assert.deepEqual(filesIn(home), [], "nothing for the Spot book");
    const claimed = claimCommandFile(purposeHome("perps"));
    assert.equal(claimed?.kind, "paper-reset");
    assert.equal(claimCommandFile(home), null);
    // Spot, named or not, is the reset it always was.
    for (const q of ["", "?wallet=spot"]) {
      assert.equal((await reset(q)).status, 200, q);
      assert.equal(claimCommandFile(home)?.kind, "paper-reset", q);
    }
    assert.equal(claimCommandFile(purposeHome("perps")), null);
  });

  it("no Perps wallet is no reset — the Spot grant is never borrowed for it", async () => {
    const res = await reset("?wallet=perps");
    assert.equal(res.status, 401);
    assert.deepEqual(filesIn(home), []);
    assert.deepEqual(filesIn(purposeHome("perps")), []);
    // A grant in the Perps home that names the Spot wallet is not a Perps wallet either.
    mkdirSync(purposeHome("perps"), { recursive: true });
    writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS }));
    assert.equal((await reset("?wallet=perps")).status, 401);
    assert.deepEqual(filesIn(purposeHome("perps")), []);
  });

  it("WHERE NO PERPS WORKER RUNS, A PERPS RESET IS REFUSED 403 and nothing is queued; Spot's is unchanged", async () => {
    mkdirSync(purposeHome("perps"), { recursive: true });
    writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
    for (const lever of [undefined, "off", "live"]) {
      if (lever === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = lever;
      const res = await reset("?wallet=perps");
      assert.equal(res.status, 403, String(lever));
      const out = (await res.json()) as { code?: string; error?: string };
      assert.equal(out.code, "perps-wallet-not-offered");
      // Self-hosted the book is NOT said to be frozen: a Perps worker started
      // by hand still keeps its stops (perps/lane.test.ts pins it).
      assert.match(out.error ?? "", /No practice reset was queued\. Practice perpetuals are not running here, so your Perps wallet takes no orders or resets until they do\. A Perps worker still running on this machine goes on managing the practice positions it holds by their own rules/);
      assert.doesNotMatch(out.error ?? "", /exactly as|frozen/i);
      assert.deepEqual(filesIn(purposeHome("perps")), [], `${lever}: nothing queued`);
      assert.equal((await reset("")).status, 200, `${lever}: Spot's reset is Spot's`);
      assert.equal(claimCommandFile(home)?.kind, "paper-reset");
    }
  });

  it("A PERPS RESET CARRIES THE PERPS WORKER'S ORDER WINDOW AND ITS ACCOUNT; Spot's is written as it always was", async () => {
    mkdirSync(purposeHome("perps"), { recursive: true });
    writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
    writeFileSync(path.join(purposeHome("perps"), "settings.json"), JSON.stringify({ tickSeconds: 240 }));
    const before = Date.now();
    const res = await reset("?wallet=perps");
    assert.equal(res.status, 200);
    const { id, expiresAt } = (await res.json()) as { id: string; expiresAt: number };
    const onDisk = JSON.parse(readFileSync(path.join(commandDir(purposeHome("perps")), `${id}.json`), "utf8")) as FileCommand;
    assert.equal(onDisk.kind, "paper-reset");
    assert.equal(onDisk.account, PERPS);
    assert.equal(onDisk.expiresAt, expiresAt, "the deadline the answer gave is the one on the file");
    // Two of the Perps worker's 240 s ticks and a ferry pass, never Spot's 60 s.
    assert.ok(expiresAt >= before + orderTtlMs(240) && expiresAt <= Date.now() + orderTtlMs(240), String(expiresAt - before));
    const spot = await reset("");
    const spotId = ((await spot.json()) as { id: string; expiresAt?: number }).id;
    const spotFile = JSON.parse(readFileSync(path.join(commandDir(home), `${spotId}.json`), "utf8")) as FileCommand;
    assert.equal(Object.hasOwn(spotFile, "expiresAt"), false);
    assert.equal(Object.hasOwn(spotFile, "account"), false);
  });

  it("A PERPS RESET QUEUED AT PAPER THAT WAITS OUT A STAND-DOWN IS ANSWERED EXPIRED WHEN PERPS RETURN, and the book is never wiped late", async () => {
    mkdirSync(purposeHome("perps"), { recursive: true });
    writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
    assert.equal((await reset("?wallet=perps")).status, 200);
    const ran: string[] = [];
    const told: CommandOutcome[] = [];
    /** The Perps worker's drain as index.ts runQueuedCommand runs it, under `lever`, at `now`. */
    const drain = (lever: string | undefined, now: number) =>
      runTickCommand(purposeHome("perps"), {
        now: () => now,
        mayRun: () => !perpsWorkerStoodDown(mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", ...(lever ? { MERRYMEN_PERPS: lever } : {}) })),
        run: async (cmd) => (ran.push(cmd.kind), { ok: true, line: "paper book restarted" }),
        told: async (_cmd, outcome) => void told.push(outcome),
        account: () => PERPS,
      });
    // The operator stands perps down before the worker gets to it: it waits, unclaimed.
    await drain(undefined, Date.now());
    assert.deepEqual(ran, []);
    assert.equal(filesIn(purposeHome("perps")).filter((n) => n.endsWith(".json") && !n.endsWith(".done.json")).length, 1);
    // A day later perps are back on paper: answered, never run.
    await drain("paper", Date.now() + 24 * 60 * 60_000);
    assert.deepEqual(ran, [], "the practice book the owner has kept since is not wiped");
    assert.match(told[0]?.line ?? "", /^expired — I picked up this practice reset .* so the practice book was not reset/);
  });

  it("a Perps reset asked for one account never runs on another made since in the same home", async () => {
    mkdirSync(purposeHome("perps"), { recursive: true });
    writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
    assert.equal((await reset("?wallet=perps")).status, 200);
    const ran: string[] = [];
    const told: CommandOutcome[] = [];
    await runTickCommand(purposeHome("perps"), {
      now: Date.now,
      run: async (cmd) => (ran.push(cmd.kind), { ok: true, line: "paper book restarted" }),
      told: async (_cmd, outcome) => void told.push(outcome),
      account: () => `0x${"44".repeat(20)}`,
    });
    assert.deepEqual(ran, []);
    assert.match(told[0]?.line ?? "", /^not run — this was asked for the account 0x2222…2222/);
  });

  it("an unreadable ?wallet= is refused before anything is read or queued", async () => {
    for (const q of ["?wallet=", "?wallet=other", "?wallet=spot&wallet=perps"]) {
      const res = await reset(q);
      assert.equal(res.status, 400, q);
      assert.equal(((await res.json()) as { code?: string }).code, "wallet-unknown", q);
    }
    assert.deepEqual(filesIn(home), []);
  });
});

describe("hosted: the account is resolved in the Perps wallet, never the Spot one", () => {
  const A = `0x${"aa".repeat(20)}` as const;
  const B = `0x${"bb".repeat(20)}` as const;
  const grantOf = (smartAccount: string, extra: object = {}) =>
    ({ smartAccount, chainId: 4663, serialized: "not-a-permission-account", demoSessionPrivateKey: "0x" + "11".repeat(32), ...extra }) as unknown as StoredGrant;

  it("a login with only a Spot grant has no Perps reset to queue (401); one with a Perps grant reaches the queue", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    await getGrantStore("spot").put(B, grantOf(SPOT));
    await getGrantStore("perps").put(A, grantOf(PERPS, { purpose: "perps", owner: A }));
    assert.equal((await reset("?wallet=perps", B)).status, 401, "B's Spot account is not a Perps one");
    assert.equal((await reset("?wallet=perps")).status, 401, "signed out");
    // Past the account, to the shared table — which this run has no Postgres for.
    const a = await reset("?wallet=perps", A);
    assert.equal(a.status, 503);
    assert.match(((await a.json()) as { error: string }).error, /the ledger is unreachable/);
    // And where no Perps worker runs, refused before the store is read, with
    // the book said to stay as it is: hosted, no Perps child runs to move it.
    delete process.env.MERRYMEN_PERPS;
    const off = await reset("?wallet=perps", A);
    assert.equal(off.status, 403);
    const said = ((await off.json()) as { error?: string }).error ?? "";
    assert.match(said, /No practice reset was queued\. Practice perpetuals are not running here, so your Perps wallet's practice positions stay exactly as they are until they do\./);
    assert.doesNotMatch(said, /on this machine/);
  });

  /**
   * A HELD PERPS BOOK IS NOT RESET, AND THE OWNER IS TOLD SO (start-over.ts
   * queuePaperReset). A Perps book that will not restore starts no worker and
   * no hold process, and the orchestrator honours no Perps reset; the route
   * used to answer 200 "queued" and leave the row waiting for a worker that
   * could not start. The orchestrator records the hold for the account
   * (paper_recovery_health); here it is a ledger file of its own, which the
   * route opens read-only, so a reset the look lets through, onto a book
   * that has reported (its agents row, perps-book-reported.ts), stops at the
   * insert (503) — hosted.postgres.test.ts drives the write.
   */
  it("A PERPS BOOK HELD BECAUSE IT COULD NOT BE RESTORED IS NOT RESET: 409, nothing queued; an unreadable record is a 503; Spot's held book is not looked at", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    await getGrantStore("spot").put(A, grantOf(SPOT, { owner: A }));
    await getGrantStore("perps").put(A, grantOf(PERPS, { purpose: "perps", owner: A }));
    /**
     * The wallet's ledger, as the orchestrator leaves it: `health` is `blocked` per account, or a table that cannot be read;
     * `reported` the accounts whose worker has written its agents row (the Perps one unless a step says otherwise).
     */
    const ledger = (dir: string, health: Record<string, 0 | 1> | "unreadable", reported: readonly string[] = [PERPS]) => {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "merrymen.db");
      rmSync(file, { force: true });
      const raw = new DatabaseSync(file);
      try {
        raw.exec("CREATE TABLE agent_commands (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, args TEXT, created_at INTEGER, claimed_at INTEGER, done_at INTEGER, result TEXT)");
        raw.exec("CREATE TABLE agents (smart_account TEXT PRIMARY KEY)");
        for (const account of reported) raw.prepare("INSERT INTO agents VALUES (?)").run(account);
        if (health === "unreadable") raw.exec("CREATE TABLE paper_recovery_health (agent_id TEXT PRIMARY KEY)");
        else {
          raw.exec("CREATE TABLE paper_recovery_health (agent_id TEXT PRIMARY KEY, blocked INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
          for (const [account, blocked] of Object.entries(health)) {
            raw.prepare("INSERT INTO paper_recovery_health VALUES (?, ?, 1)").run(account.toLowerCase(), blocked);
          }
        }
      } finally {
        raw.close();
      }
      return () => new DatabaseSync(file, { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM agent_commands").get()!.n;
    };

    const rows = ledger(purposeHome("perps"), { [PERPS]: 1 });
    const held = await reset("?wallet=perps", A);
    assert.equal(held.status, 409);
    assert.match(((await held.json()) as { error: string }).error, /^Your Perps wallet's practice book could not be restored, so it is being held and no Perps worker is running to reset it\. No practice reset was queued/);
    assert.equal(rows(), 0);

    // Another account's hold is not this one's: past the look, to the queue.
    ledger(purposeHome("perps"), { [SPOT]: 1, [PERPS]: 0 });
    const clear = await reset("?wallet=perps", A);
    assert.equal(clear.status, 503, "a clear record lets it through, to an insert this read-only file refuses");
    assert.match(((await clear.json()) as { error: string }).error, /the ledger is unreachable/);

    // A clear record, but a Perps worker that has not reported its book: refused before the queue, in its own words.
    const unreported = ledger(purposeHome("perps"), { [PERPS]: 0 }, []);
    const early = await reset("?wallet=perps", A);
    assert.equal(early.status, 409);
    assert.equal(((await early.json()) as { error: string }).error, PERPS_RESET_NOT_REPORTED);
    assert.equal(unreported(), 0);

    const unread = ledger(purposeHome("perps"), "unreadable");
    const unknown = await reset("?wallet=perps", A);
    assert.equal(unknown.status, 503);
    assert.match(((await unknown.json()) as { error: string }).error, /whether your Perps wallet's practice book is being held could not be read\. No practice reset was queued/);
    assert.equal(unread(), 0);

    // SPOT IS NOT LOOKED AT: a held Spot book's reset is its owner's way out (held-reset.ts).
    ledger(home, { [SPOT]: 1 });
    const spot = await reset("", A);
    assert.equal(spot.status, 503, "past any look, to the queue");
    assert.match(((await spot.json()) as { error: string }).error, /the ledger is unreachable/);
  });
});
