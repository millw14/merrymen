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
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { purposeHome } from "@merrymen/home";
import { resetSettingsStoreForTest } from "@merrymen/settings-store";
import { houseConfigFor } from "@/lib/order-ceiling";
import { PERPS_WALLET_EXITS_ONLY, SPOT_WALLET_HOLDS_NO_PERPS } from "@/lib/order-state";
import { claimCommandFile, commandDir, openCommands, runTickCommand, writeCommandResult, type CommandOutcome, type FileCommand } from "../../../../../worker/src/command-files";
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
    assert.notEqual(paperId, allId, "the book is part of an exit's id");
    assert.equal(claimCommandFile(purposeHome("perps"))?.args?.book, "paper");
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
        assert.match(out.error ?? "", /No Perps order was queued\. Practice perpetuals are not running here, so your Perps wallet's practice positions stay exactly as they are until they do\./);
      }
      assert.equal((await GET(req("orders?wallet=perps&id=x"))).status, 403, String(lever));
      assert.deepEqual(filesIn(purposeHome("perps")), [], `${lever}: the Perps home's queue was never made`);
      // Spot's orders are Spot's, whatever the lever.
      assert.equal((await POST(req("orders", { side: "buy", symbol: "TSLA", usdgAmount: 5 }))).status, 200, String(lever));
      claimCommandFile(home);
    }
  });
});
