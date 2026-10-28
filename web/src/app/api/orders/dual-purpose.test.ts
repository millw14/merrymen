/**
 * ONE LOGIN, TWO WALLETS, TWO ORDER QUEUES — and an exit only on the Perps one.
 *
 * `POST /api/orders?wallet=perps` queues the owner's perpetual exits (close
 * one position, close all; worker/src/perps/owner-order.ts) for the Perps
 * wallet's own worker, and nothing else; no `?wallet=` is Spot, exactly as
 * before, and the Spot wallet refuses an exit. Driven self-hosted, through the
 * real handlers and the real command files each wallet's worker drains:
 *   - a Perps exit lands only in the Perps home, exactly the parser's shape,
 *     and a lookup in one wallet never reads the other's;
 *   - it is bound to the account the owner reviewed (`expectedAccount`,
 *     required), and nothing the body carries beside the exit is queued;
 *   - anything but an exit is refused on Perps, an exit is refused on Spot;
 *   - each wallet has its own one-at-a-time slot and its own ceiling;
 *   - WHERE NO PERPS WORKER RUNS (MERRYMEN_PERPS not paper), nothing is queued
 *     or read for the Perps wallet (D1).
 * And HOSTED, as far as one shared ledger read-only lets it go: the account is
 * resolved in the wallet the request names (hostedAgentFor(req, "perps")), so
 * each wallet's GET and one-at-a-time slot see only its own account's rows in
 * the table both wallets share. The hosted write itself — the row's agent_id,
 * its args, the Perps order window — is hosted-wallets.postgres.test.ts's.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { DatabaseSync } from "node:sqlite";
import type { StoredGrant } from "@merrymen/core";
import { purposeHome } from "@merrymen/home";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { resetSettingsStoreForTest } from "@merrymen/settings-store";
import { mintSession } from "@/lib/auth";
import { wrapSqlite } from "../../../../../worker/src/db";
import { applyLedgerSchema } from "../../../../../worker/src/store";
import { houseConfigFor } from "@/lib/order-ceiling";
import { PERPS_WALLET_EXITS_ONLY, SPOT_WALLET_HOLDS_NO_PERPS } from "@/lib/order-state";
import { claimCommandFile, commandDir, openCommands, runTickCommand, writeCommandResult, type CommandOutcome, type FileCommand } from "../../../../../worker/src/command-files";
import { recordFleetRecoveryHold } from "../../../../../worker/src/fleet-recovery";
import { queueRecoveryCheckedCommand } from "@/lib/recovery-commands";
import { placeRecoveryCheckedOrder } from "@/lib/recovery-orders";
import { PERPS_EXIT_NOT_REPORTED } from "@/lib/perps-book-reported";
import { GET, POST } from "./route";
import { GET as ceiling } from "./ceiling/route";

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SETTINGS_FILE", "DATABASE_URL", "MERRYMEN_SESSION_SECRET", "MERRYMEN_PERPS", "MERRYMEN_TICK_SECONDS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const SPOT = `0x${"11".repeat(20)}`;
const PERPS = `0x${"22".repeat(20)}`;
const homes: string[] = [];
let home: string;

const req = (route: string, body?: unknown) =>
  new Request(`https://app.example.test/api/${route}`, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const CLOSE = { purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper" } as const;
const FLATTEN = { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0 } as const;
const reviewed = (o: object) => ({ ...o, expectedAccount: PERPS });
const queued = (h: string) => openCommands(h).length;
/** Every file in a home's command directory, or none when it was never made. */
const filesIn = (h: string) => (existsSync(commandDir(h)) ? readdirSync(commandDir(h)) : []);

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mm-dual-wallet-orders-"));
  homes.push(home);
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_PERPS = "paper";
  process.env.MERRYMEN_SETTINGS_FILE = path.join(home, "settings.json");
  process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_TICK_SECONDS;
  resetSettingsStoreForTest();
  mkdirSync(purposeHome("perps"), { recursive: true });
  writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: SPOT, demoOwnerPrivateKey: `0x${"33".repeat(32)}` }));
  writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramMaxActionUsdg: 71 }));
  writeFileSync(path.join(purposeHome("perps"), "settings.json"), JSON.stringify({ telegramMaxActionUsdg: 9, tickSeconds: 240 }));
});
afterEach(() => resetSettingsStoreForTest());
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a Perps exit reaches only the Perps wallet's queue", () => {
  it("A CLOSE LANDS IN THE PERPS HOME ONLY, AS THE PARSER'S OBJECT — and a lookup cannot cross to Spot", async () => {
    const result = await POST(req("orders?wallet=perps", { ...reviewed(CLOSE), owner: "0xabc", note: "anything else" }));
    assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
    const { id, expiresInMs } = (await result.json()) as { id: string; expiresInMs: number };
    assert.equal(queued(home), 0, "nothing in the Spot home");
    assert.equal(queued(purposeHome("perps")), 1);
    // THE PERPS WORKER'S TICK, not Spot's (60 s, the five-minute floor): two of its 240 s ticks and a ferry pass.
    assert.equal(expiresInMs, (2 * 240 + 15) * 1000);
    assert.equal(((await (await GET(req(`orders?wallet=perps&id=${id}`))).json()) as { state: string }).state, "queued");
    const spotLookup = (await (await GET(req(`orders?id=${id}`))).json()) as { state: string };
    assert.notEqual(spotLookup.state, "queued", "the Spot wallet's lookup does not see the Perps queue");
    const command = claimCommandFile(purposeHome("perps"));
    // Exactly the exit — the review's account, the owner and anything else the body carried are checked or dropped, never queued.
    assert.deepEqual(command?.args, { ...CLOSE });
    assert.equal(command?.kind, "trade");
    writeCommandResult(purposeHome("perps"), { id, ok: true, line: "perps-only-receipt", at: Date.now() });
    assert.match(JSON.stringify(await (await GET(req(`orders?wallet=perps&id=${id}`))).json()), /perps-only-receipt/);
    assert.doesNotMatch(JSON.stringify(await (await GET(req(`orders?id=${id}`))).json()), /perps-only-receipt/);
    // And the Spot wallet's own orders still go where they always went.
    const spot = await POST(req("orders", { side: "buy", symbol: "TSLA", usdgAmount: 5 }));
    assert.equal(spot.status, 200);
    assert.equal(claimCommandFile(home)?.args?.symbol, "TSLA");
    assert.equal(claimCommandFile(purposeHome("perps")), null);
  });

  it("CLOSE ALL WITH AN UNREAD BOOK OMITS IT (every book, D11); naming the practice book keeps it, as a different order", async () => {
    const all = await POST(req("orders?wallet=perps", reviewed(FLATTEN)));
    assert.equal(all.status, 200);
    const allId = ((await all.json()) as { id: string }).id;
    const onDisk = JSON.parse(readFileSync(path.join(commandDir(purposeHome("perps")), `${allId}.json`), "utf8")) as FileCommand;
    assert.deepEqual(onDisk.args, { ...FLATTEN });
    assert.equal(Object.hasOwn(onDisk.args ?? {}, "book"), false);
    writeCommandResult(purposeHome("perps"), { id: allId, ok: true, line: "done", at: Date.now() });
    claimCommandFile(purposeHome("perps"));
    const paper = await POST(req("orders?wallet=perps", reviewed({ ...FLATTEN, book: "paper" })));
    assert.equal(paper.status, 200);
    const paperId = ((await paper.json()) as { id: string }).id;
    assert.notEqual(paperId, allId, "every exit has an id of its own");
    assert.equal(claimCommandFile(purposeHome("perps"))?.args?.book, "paper");
  });
});

describe("an exit asked again in the same minute, after its answer, is a new attempt (route.ts exitId)", () => {
  // The lane answers a failed exit with "ask again", within seconds. Under the
  // minute-bucket id every ask in one minute was the same key, so the second
  // ask was written beside the first one's answer and GET read the old answer
  // as the new one's. The clock is held still here so both asks are certainly
  // in one minute, which is the case that went wrong.
  /** The Perps worker's drain, answering with `line`. */
  const drain = async (ok: boolean, line: string) => {
    const ran: string[] = [];
    await runTickCommand(purposeHome("perps"), {
      now: Date.now,
      run: async (cmd) => (ran.push(cmd.id), { ok, line }),
      told: async () => {},
      account: () => PERPS,
    });
    return ran;
  };
  const look = async (id: string) =>
    (await (await GET(req(`orders?wallet=perps&id=${id}`))).json()) as { state: string; ok: boolean | null; result: string | null };

  for (const [what, exit, failure] of [
    ["a Close", CLOSE, "BTC-PERP: the close could not be recorded, so nothing was sent. Its stop stays in place; ask again."],
    ["a Close all", FLATTEN, "1 practice position remains open after the close attempts, with its stop. New practice positions are paused until you reset the practice book."],
  ] as const) {
    it(`${what}: queued under a new id, read as queued, and run — never answered with the first attempt's failure`, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const first = await POST(req("orders?wallet=perps", reviewed(exit)));
      assert.equal(first.status, 200);
      const firstId = ((await first.json()) as { id: string }).id;
      assert.deepEqual(await drain(false, failure), [firstId]);
      const answered = await look(firstId);
      assert.deepEqual([answered.state, answered.ok, answered.result], ["done", false, failure]);

      const again = await POST(req("orders?wallet=perps", reviewed(exit)));
      assert.equal(again.status, 200);
      const body = (await again.json()) as { id: string; duplicate?: true };
      assert.notEqual(body.id, firstId, "a second ask is a second exit, not the first one's key");
      assert.equal(body.duplicate, undefined, "and it is never answered 'already queued'");
      assert.equal((await look(body.id)).state, "queued", "GET reads the new attempt, not the old answer");
      assert.equal(queued(purposeHome("perps")), 1);
      // One click is still one exit: while this one is open, a third ask is refused.
      assert.equal((await POST(req("orders?wallet=perps", reviewed(exit)))).status, 409);
      assert.equal(queued(purposeHome("perps")), 1);

      assert.deepEqual(await drain(true, "ran again"), [body.id], "the retry runs");
      const retried = await look(body.id);
      assert.deepEqual([retried.state, retried.ok, retried.result], ["done", true, "ran again"]);
      assert.equal((await look(firstId)).result, failure, "and the first attempt keeps its own answer");
    });
  }

  it("A SPOT ORDER KEEPS ITS MINUTE-BUCKET ID: the same buy in the same minute is the same key, as it always was", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const buy = { side: "buy", symbol: "TSLA", usdgAmount: 5 };
    const first = ((await (await POST(req("orders", buy))).json()) as { id: string }).id;
    claimCommandFile(home);
    writeCommandResult(home, { id: first, ok: true, line: "bought", at: Date.now() });
    const again = ((await (await POST(req("orders", buy))).json()) as { id: string }).id;
    assert.equal(again, first);
    assert.match(first, /^[0-9a-f]{32}$/);
  });
});

describe("self-hosted, a Perps exit is bound to the account the owner reviewed (command-files.ts FileCommand.account)", () => {
  const OTHER = `0x${"44".repeat(20)}`;
  /** The Perps worker's drain, armed on `armed` (index.ts runQueuedCommand passes the armed grant's account). */
  const drain = async (armed: string) => {
    const ran: string[] = [];
    const told: CommandOutcome[] = [];
    await runTickCommand(purposeHome("perps"), {
      now: Date.now,
      run: async (cmd) => (ran.push(cmd.id), { ok: true, line: "closed" }),
      told: async (_cmd, outcome) => void told.push(outcome),
      account: () => armed,
    });
    return { ran, told };
  };

  it("THE FILE NAMES THE ACCOUNT; a Perps wallet made again in the same home on another account answers it without running it", async () => {
    const res = await POST(req("orders?wallet=perps", reviewed(CLOSE)));
    assert.equal(res.status, 200);
    const { id } = (await res.json()) as { id: string };
    const onDisk = JSON.parse(readFileSync(path.join(commandDir(purposeHome("perps")), `${id}.json`), "utf8")) as FileCommand;
    assert.equal(onDisk.account, PERPS, "beside the deadline, never in the args");
    assert.equal(Object.hasOwn(onDisk.args ?? {}, "expectedAccount"), false);
    // Re-created under another owner key: the same home, another account.
    writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: OTHER, purpose: "perps" }));
    const { ran, told } = await drain(OTHER);
    assert.deepEqual(ran, [], "nothing closed on an account nobody reviewed");
    assert.match(told[0]?.line ?? "", /^not run — this was asked for the account 0x2222…2222, and this wallet's account is now 0x4444…4444\. Nothing was sent/);
    const answer = (await (await GET(req(`orders?wallet=perps&id=${id}`))).json()) as { state: string; ok: boolean; result: string };
    assert.equal(answer.state, "done");
    assert.equal(answer.ok, false);
    assert.match(answer.result, /^not run — /);
  });

  it("on the account it was asked for it runs, and a Spot order is written as it always was, with no account", async () => {
    const res = await POST(req("orders?wallet=perps", reviewed(CLOSE)));
    const { id } = (await res.json()) as { id: string };
    const { ran } = await drain(PERPS.toUpperCase().replace(/^0X/, "0x"));
    assert.deepEqual(ran, [id], "case aside, the same account");
    const spot = await POST(req("orders", { side: "buy", symbol: "TSLA", usdgAmount: 5 }));
    const spotId = ((await spot.json()) as { id: string }).id;
    const spotFile = JSON.parse(readFileSync(path.join(commandDir(home), `${spotId}.json`), "utf8")) as FileCommand;
    assert.equal(Object.hasOwn(spotFile, "account"), false);
  });
});

describe("what the Perps wallet's queue refuses, with nothing queued in either home", () => {
  it("an account other than the one reviewed (409), an unreadable or missing one (400)", async () => {
    for (const [body, status] of [
      [{ ...CLOSE, expectedAccount: SPOT }, 409],
      [{ ...CLOSE, expectedAccount: "invalid" }, 400],
      [{ ...CLOSE, expectedAccount: 7 }, 400],
      [{ ...CLOSE }, 400],
    ] as const) {
      const res = await POST(req("orders?wallet=perps", body));
      assert.equal(res.status, status, JSON.stringify(body));
      if (status === 409) assert.equal(((await res.json()) as { code?: string }).code, "account-changed");
    }
    assert.equal(queued(home), 0);
    assert.equal(queued(purposeHome("perps")), 0);
  });

  it("anything but an exit: a Spot buy or sell, an energy buy, a live book, a buy-side or sized exit, a body that is not an object", async () => {
    for (const body of [
      reviewed({ side: "buy", symbol: "TSLA", usdgAmount: 1 }),
      reviewed({ side: "sell", symbol: "TSLA", usdgAmount: 1 }),
      reviewed({ side: "buy", symbol: "MERRYMEN", usdgAmount: 30, purpose: "energy" }),
      reviewed({ side: "sell", symbol: "BTC-PERP", usdgAmount: 0 }),
      reviewed({ ...CLOSE, book: "live" }),
      reviewed({ ...CLOSE, book: undefined }),
      reviewed({ ...CLOSE, side: "buy" }),
      reviewed({ ...CLOSE, usdgAmount: 5 }),
      reviewed({ ...CLOSE, symbol: "BTC" }),
      reviewed({ ...FLATTEN, symbol: "BTC-PERP" }),
    ]) {
      const res = await POST(req("orders?wallet=perps", body));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const plain = await POST(req("orders?wallet=perps", reviewed({ side: "buy", symbol: "TSLA", usdgAmount: 1 })));
    assert.equal(((await plain.json()) as { error: string }).error, PERPS_WALLET_EXITS_ONLY);
    for (const raw of ["null", "[1]", "\"close\""]) {
      const res = await POST(new Request("https://app.example.test/api/orders?wallet=perps", { method: "POST", body: raw }));
      assert.equal(res.status, 400, raw);
    }
    assert.equal(queued(home), 0);
    assert.equal(queued(purposeHome("perps")), 0);
  });

  it("THE SPOT WALLET REFUSES AN EXIT: it holds no perpetual position, and an exit there is never a sell of something else", async () => {
    for (const body of [CLOSE, FLATTEN, reviewed(CLOSE), { ...CLOSE, symbol: "TSLA", usdgAmount: 5 }]) {
      for (const query of ["", "?wallet=spot"]) {
        const res = await POST(req(`orders${query}`, body));
        assert.equal(res.status, 400, `${query} ${JSON.stringify(body)}`);
        assert.equal(((await res.json()) as { error: string }).error, SPOT_WALLET_HOLDS_NO_PERPS);
      }
    }
    assert.equal(queued(home), 0);
    assert.equal(queued(purposeHome("perps")), 0);
  });

  it("an unreadable ?wallet= is refused before anything is read or queued", async () => {
    for (const selector of ["wallet=other", "wallet=perps&wallet=spot", "wallet=", "wallet=Perps"]) {
      for (const [handler, body] of [[POST, reviewed(CLOSE)], [GET, undefined]] as const) {
        const res = await handler(req(`orders?${selector}`, body));
        assert.equal(res.status, 400, selector);
        assert.equal(((await res.json()) as { code?: string }).code, "wallet-unknown", selector);
      }
    }
    assert.equal(queued(home), 0);
    assert.equal(queued(purposeHome("perps")), 0);
  });
});

describe("each wallet's slot and ceiling are its own", () => {
  it("one order at a time PER WALLET: a Spot order waiting does not hold back a Perps exit, and a Perps exit waiting holds back the next", async () => {
    assert.equal((await POST(req("orders", { side: "buy", symbol: "TSLA", usdgAmount: 5 }))).status, 200);
    assert.equal((await POST(req("orders?wallet=perps", reviewed(CLOSE)))).status, 200, "Spot's open order is not the Perps wallet's");
    const second = await POST(req("orders?wallet=perps", reviewed(FLATTEN)));
    assert.equal(second.status, 409, "the Perps wallet's own slot is held");
    assert.equal(queued(purposeHome("perps")), 1);
    assert.equal(queued(home), 1);
  });

  it("the Perps wallet's ceiling and tick are read from its own home; the ceiling route stays Spot's", async () => {
    assert.equal(houseConfigFor("spot").telegramMaxActionUsdg, 71);
    assert.equal(houseConfigFor("perps").telegramMaxActionUsdg, 9);
    assert.equal(houseConfigFor("perps").tickSeconds, 240);
    assert.equal(houseConfigFor("spot").tickSeconds, 60);
    assert.equal(houseConfigFor("perps").strategy, "perps-only", "merged as a Perps worker merges it");
    // An exit carries no amount, so even the smallest ceiling never refuses one.
    writeFileSync(path.join(purposeHome("perps"), "settings.json"), JSON.stringify({ telegramMaxActionUsdg: 1 }));
    assert.equal((await POST(req("orders?wallet=perps", reviewed(CLOSE)))).status, 200);
    assert.equal(((await (await ceiling(req("orders/ceiling"))).json()) as { ceilingUsdg: number }).ceilingUsdg, 71);
    const perpsCeiling = await ceiling(req("orders/ceiling?wallet=perps"));
    assert.equal(perpsCeiling.status, 400, "a Perps exit has no amount to offer chips for");
    assert.equal(((await perpsCeiling.json()) as { code?: string }).code, "wallet-not-supported");
  });
});

describe("where no Perps worker runs, nothing is queued or read for the Perps wallet (D1)", () => {
  it("an exit is refused 403 perps-wallet-not-offered, nothing is queued, and its orders are not read", async () => {
    for (const lever of [undefined, "off", "live", "lvie"]) {
      if (lever === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = lever;
      for (const body of [reviewed(CLOSE), reviewed(FLATTEN)]) {
        const res = await POST(req("orders?wallet=perps", body));
        assert.equal(res.status, 403, `${lever} ${JSON.stringify(body)}`);
        const out = (await res.json()) as { code?: string; error?: string };
        assert.equal(out.code, "perps-wallet-not-offered");
        // SELF-HOSTED, NOT "FROZEN": a Perps worker started by hand still
        // keeps what it holds on its stops (perps/lane.test.ts pins it), so
        // the refusal never tells this owner the positions cannot move.
        assert.match(out.error ?? "", /No Perps order was queued\. Practice perpetuals are not running here, so your Perps wallet takes no orders or resets until they do\. A Perps worker still running on this machine goes on managing the practice positions it holds by their own rules: their stops, take-profits, liquidation and funding\. Kill all agents still stops it\./);
        assert.doesNotMatch(out.error ?? "", /exactly as|frozen/i);
      }
      assert.equal((await GET(req("orders?wallet=perps&id=x"))).status, 403, String(lever));
      assert.deepEqual(filesIn(purposeHome("perps")), [], `${lever}: the Perps home's queue was never made`);
      // Spot's orders are Spot's, whatever the lever.
      assert.equal((await POST(req("orders", { side: "buy", symbol: "TSLA", usdgAmount: 5 }))).status, 200, String(lever));
      claimCommandFile(home);
    }
  });

  it("HOSTED, THE POSITIONS ARE SAID TO STAY EXACTLY AS THEY ARE: no Perps child runs there to move them (D18 keeps the orchestrator's lever the web's)", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    for (const lever of [undefined, "off", "live"]) {
      if (lever === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = lever;
      for (const res of [await POST(req("orders?wallet=perps", reviewed(CLOSE))), await GET(req("orders?wallet=perps&id=x"))]) {
        assert.equal(res.status, 403, String(lever));
        const out = (await res.json()) as { code?: string; error?: string };
        assert.equal(out.code, "perps-wallet-not-offered");
        assert.match(out.error ?? "", /Practice perpetuals are not running here, so your Perps wallet's practice positions stay exactly as they are until they do\. Kill all agents still stops it\./);
        assert.doesNotMatch(out.error ?? "", /on this machine/);
      }
    }
  });
});

/**
 * HOSTED, THE ACCOUNT IS THE PERPS WALLET'S, AND SO IS EVERYTHING READ FOR IT.
 *
 * Hosted, both wallets' orders are rows in ONE table (agent_commands, in the
 * shared Postgres), told apart only by the agent_id the route resolves
 * (hostedAgentFor(req, wallet)) and every query names. Nothing else stands
 * between a Perps request and the Spot wallet's rows: a route that resolved
 * the Spot account for `?wallet=perps` would answer the desk's poll with the
 * Spot wallet's latest order, and every self-hosted test above would stay
 * green, since self-hosted each wallet has a home of its own.
 *
 * So the ledger here is one table for both wallets, as hosted it is: the
 * route opens each wallet's file (ledger.ts, no DATABASE_URL), and the Perps
 * one is the Spot one. It opens read-only, so this goes as far as the reads
 * and the one-at-a-time slot; the write is hosted-wallets.postgres.test.ts's.
 */
describe("hosted: each wallet's orders are read for its own account, in the table both share", () => {
  const A = `0x${"aa".repeat(20)}` as const;
  const B = `0x${"bb".repeat(20)}` as const;
  const B_SPOT = `0x${"55".repeat(20)}`;
  const grantOf = (smartAccount: string, owner: string, extra: object = {}) =>
    ({ smartAccount, owner, chainId: 4663, serialized: "not-a-permission-account", demoSessionPrivateKey: `0x${"11".repeat(32)}`, ...extra }) as unknown as StoredGrant;
  const as = (tenant: `0x${string}`, route: string, body?: unknown) =>
    new Request(`https://app.example.test/api/${route}`, {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      headers: { "content-type": "application/json", cookie: `mm_session=${mintSession(tenant)}` },
    });
  const look = async (tenant: `0x${string}`, query: string) => {
    const res = await GET(as(tenant, `orders${query}`));
    return { status: res.status, body: (await res.json()) as { id?: string; state: string } };
  };

  /**
   * One ledger for both wallets, as the shared Postgres is, with `rows` in it:
   * `[id, account, createdAt]`, each open. `reported` are the accounts whose
   * worker has written its agents row (perps-book-reported.ts): the Perps one
   * unless a test says otherwise.
   */
  const sharedLedger = async (rows: readonly (readonly [string, string, number])[], reported: readonly string[] = [PERPS]) => {
    const file = path.join(home, "merrymen.db");
    const raw = new DatabaseSync(file);
    try {
      await applyLedgerSchema(wrapSqlite(raw));
      for (const account of reported) {
        raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, ?, ?, 4663, '{}', 0, 0)")
          .run(account, A, A);
      }
      for (const [id, account, at] of rows) {
        raw.prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)")
          .run(id, account, JSON.stringify({ side: "sell", symbol: "X", usdgAmount: 0, expiresAt: Date.now() + 3_600_000 }), at);
      }
    } finally {
      raw.close();
    }
    symlinkSync(file, path.join(purposeHome("perps"), "merrymen.db"));
  };

  beforeEach(async () => {
    process.env.MERRYMEN_HOSTED = "1";
    resetGrantStoreForTest();
    // A: both wallets, one owner key. B: a Spot wallet only.
    await getGrantStore("spot").put(A, grantOf(SPOT, A));
    await getGrantStore("perps").put(A, grantOf(PERPS, A, { purpose: "perps" }));
    await getGrantStore("spot").put(B, grantOf(B_SPOT, B));
  });
  after(() => resetGrantStoreForTest());

  it("A LOGIN WITH ONLY A SPOT WALLET HAS NO PERPS ORDERS: 401 for its read and its exit, never the Spot account's rows", async () => {
    const now = Date.now();
    await sharedLedger([["b-spot-order", B_SPOT, now]]);
    assert.equal((await look(B, "")).body.id, "b-spot-order", "its own Spot order is there to be read");
    for (const query of ["?wallet=perps", "?wallet=perps&id=b-spot-order"]) {
      assert.equal((await look(B, query)).status, 401, query);
    }
    const exit = await POST(as(B, "orders?wallet=perps", { ...CLOSE, expectedAccount: B_SPOT, owner: B }));
    assert.equal(exit.status, 401, "no Perps wallet, so no account to bind an exit to");
  });

  it("ONE LOGIN, BOTH WALLETS: a GET answers its own wallet's rows only, by latest and by id, whichever is newer", async () => {
    const now = Date.now();
    // The Spot order is the newer row, so "the latest" for the wrong account would be it.
    await sharedLedger([["perps-exit", PERPS, now - 2_000], ["spot-order", SPOT, now - 1_000]]);
    assert.equal((await look(A, "?wallet=perps")).body.id, "perps-exit");
    assert.deepEqual((await look(A, "?wallet=perps&id=spot-order")).body, { state: "none" }, "an id is never a way into the other wallet");
    assert.equal((await look(A, "?wallet=perps&id=perps-exit")).body.state, "queued");
    for (const query of ["", "?wallet=spot"]) {
      assert.equal((await look(A, query)).body.id, "spot-order", query);
      assert.deepEqual((await look(A, `${query}${query ? "&" : "?"}id=perps-exit`)).body, { state: "none" }, query);
    }
  });

  it("A PERPS EXIT IS JUDGED AGAINST THE PERPS ACCOUNT'S OWN SLOT: refused while its own exit is open, for that reason and no other", async () => {
    const now = Date.now();
    await sharedLedger([["perps-exit", PERPS, now - 1_000]]);
    const again = await POST(as(A, "orders?wallet=perps", { ...FLATTEN, expectedAccount: PERPS, owner: A }));
    assert.equal(again.status, 409);
    const out = (await again.json()) as { code?: string; error?: string };
    // Past the review check (the route resolved the Perps account) and held by the Perps row.
    assert.notEqual(out.code, "account-changed", JSON.stringify(out));
    assert.match(out.error ?? "", /already|waiting/i, JSON.stringify(out));
    // Reviewed for the Spot account, it is the account check that refuses it: the bound account is the Perps one.
    const wrong = await POST(as(A, "orders?wallet=perps", { ...CLOSE, expectedAccount: SPOT, owner: A }));
    assert.equal(wrong.status, 409);
    assert.equal(((await wrong.json()) as { code?: string }).code, "account-changed");
  });

  it("A PERPS EXIT FOR A BOOK THAT HAS NOT REPORTED IS REFUSED 409, in its own words: queued before the Perps worker's first start, it would stop that start (perps-book-reported.ts)", async () => {
    await sharedLedger([], []);
    for (const exit of [CLOSE, FLATTEN]) {
      const out = await POST(as(A, "orders?wallet=perps", { ...exit, expectedAccount: PERPS, owner: A }));
      assert.equal(out.status, 409, exit.purpose);
      assert.equal(((await out.json()) as { error?: string }).error, PERPS_EXIT_NOT_REPORTED, exit.purpose);
    }
  });
});

/**
 * THE FLEET RECOVERY HOLD IS PER ACCOUNT, AND THIS BUILD RECORDS NONE FOR A
 * PERPS ACCOUNT (D11: main's check, kept with no rule-8a bypass).
 *
 * The route sends a Perps exit through placeRecoveryCheckedOrder and the
 * practice reset through queueRecoveryCheckedCommand, as every hosted order
 * and reset goes, and both read fleet_recovery_health for the account the row
 * is bound to: the Perps account. The orchestrator records a login's hold for
 * its SPOT account only (reportFleetSource returns before writing for a Perps
 * worker), so the login's hold refuses the Spot buy and lets the Perps exit
 * and reset through. The route's header and docs/perps.md used to say the
 * hold "refuses a Perps exit as it refuses any order" — a protection, or a
 * restriction, that never fired. What they say now is pinned here beside the
 * behaviour it describes, so the two cannot drift apart again.
 */
describe("a fleet recovery hold is the account's own: the login's Spot hold refuses neither a Perps exit nor a Perps reset (D11)", () => {
  const LOGIN = `0x${"aa".repeat(20)}`;
  const at = 1_800_000_000;
  const now = (at + 5) * 1000;
  const ttl = { now, expiresAt: now + 300_000 };

  it("held for its Spot account, the login's Spot buy is refused; its Perps exit and Perps practice reset are queued — and a hold on the Perps account itself would refuse both", async () => {
    for (const heldAccount of [SPOT, PERPS]) {
      const raw = new DatabaseSync(":memory:");
      try {
        const db = wrapSqlite(raw);
        await applyLedgerSchema(db);
        // The scope reportFleetSource records for the login: its Spot grant's account.
        await recordFleetRecoveryHold(db, { tenant: LOGIN, smartAccount: heldAccount, chainId: 4663 }, "source-continuity", at, () => true);
        const buy = await placeRecoveryCheckedOrder(db, { id: "spot-buy", agent: SPOT, args: { side: "buy", symbol: "TSLA", usdgAmount: 1 }, ...ttl });
        const exit = await placeRecoveryCheckedOrder(db, { id: "perps-close", agent: PERPS, args: { ...CLOSE }, ...ttl });
        const reset = await queueRecoveryCheckedCommand(db, { id: "perps-reset", agent: PERPS, kind: "paper-reset", at: now, expiresAt: ttl.expiresAt });
        const refused = { ok: false, why: "recovery" };
        if (heldAccount === SPOT) {
          assert.deepEqual(buy, refused, "the Spot account's own hold refuses its buy");
          assert.deepEqual(exit, { ok: true }, "the login's Spot hold does not reach the Perps exit");
          assert.deepEqual(reset, { ok: true }, "nor the Perps practice reset");
          const rows = raw.prepare("SELECT id, LOWER(agent_id) AS agent FROM agent_commands ORDER BY id").all();
          assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: "perps-close", agent: PERPS }, { id: "perps-reset", agent: PERPS }]);
        } else {
          // The check itself works, per account: only no writer ever records this row.
          assert.deepEqual(buy, { ok: true });
          assert.deepEqual(exit, refused);
          assert.deepEqual(reset, refused);
        }
      } finally {
        raw.close();
      }
    }
  });

  it("NO HOLD IS RECORDED FOR A PERPS ACCOUNT: the orchestrator's writer returns for a Perps worker before it writes — and the route and docs say what this describe pins", () => {
    const orchestrator = readFileSync(path.join(process.cwd(), "worker", "src", "orchestrator.ts"), "utf8");
    const start = orchestrator.indexOf("async function reportFleetSource(");
    assert.ok(start >= 0, "reportFleetSource is the writer the copy names");
    const body = orchestrator.slice(start, orchestrator.indexOf("\n}\n", start));
    const perpsReturn = body.indexOf("if (isPerpsWorkerKey(tenant)) return");
    assert.ok(perpsReturn >= 0 && perpsReturn < body.indexOf("recordFleetRecoveryHold("), "a Perps worker returns before the hold is written");

    // Comment leaders and line breaks out, so a sentence reads as one line.
    const prose = (text: string) => text.replace(/\n[ \t]*\*[ \t]?/g, " ").replace(/\s+/g, " ");
    const route = prose(readFileSync(path.join(import.meta.dirname, "route.ts"), "utf8"));
    const docs = prose(readFileSync(path.join(process.cwd(), "docs", "perps.md"), "utf8"));
    for (const [where, text] of [["orders/route.ts", route], ["docs/perps.md", docs]] as const) {
      // assert.ok, not doesNotMatch: a failure names the file, not the whole of it.
      assert.ok(!/refuses (?:a Perps|an) exit as it refuses any order/.test(text), `${where} must not claim the hold refuses a Perps exit`);
    }
    assert.ok(/the login's Spot hold does NOT refuse a Perps exit, nor a Perps practice reset/.test(route), "orders/route.ts says the Spot hold does not reach a Perps exit or reset");
    assert.ok(/the login's Spot hold refuses neither a Perps exit nor a Perps practice reset/.test(docs), "docs/perps.md says the Spot hold does not reach a Perps exit or reset");
  });
});
