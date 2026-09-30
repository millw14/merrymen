/**
 * THE ONE ROUTE IN THIS APP THAT CAN SPEND MONEY.
 *
 * Everything else the chat can reach writes a setting or moves the page. This
 * writes a row that a process holding a key will read as an instruction to
 * trade, so the properties below are not style — they are the difference
 * between "one click, at most one trade" and an account draining over an hour.
 *
 * EXECUTED, WHERE IT CAN BE. This file used to read the route's source for all
 * of it, on the reasoning that standing up a Postgres, a session and a grant
 * store would test the harness. But the behaviour that matters — which rows
 * hold the one-at-a-time slot, which error is a duplicate, which order GET
 * answers about, what POST hands back — is SQL and arithmetic, and a grep
 * cannot tell a working predicate from a broken one: dropping `AND id = ?` or
 * the deadline from POST's reply kept every assertion green. So that logic now
 * lives in lib/order-state.ts, and these tests run it against an in-memory
 * sqlite through the ledger's own driver, and against real command files.
 *
 * What is still read from the source is what is still only in the route: who
 * the caller is, the id's hash, the tick lookup, and the words the route must
 * never contain. The ceiling's own rules run here (chatOrderCeiling); POST
 * refusing at it, and GET /api/orders/ceiling reporting it, run end to end
 * through the real handlers in ceiling/route.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import {
  ORDER_IN_FLIGHT_MS,
  ORDER_STALE_GRACE_MS,
  chatOrderCeiling,
  isDuplicateKey,
  orderTtlMs,
  placedResponse,
  placeHostedOrder,
  placeSelfHostedOrder,
  readHostedOrder,
  readOrder,
  selfHostedOrderReply,
} from "@/lib/order-state";
import { wrapSqlite } from "../../../../../worker/src/db";
import {
  claimCommandFile,
  markRunning,
  openCommands,
  readCommandState,
  writeCommand,
  writeCommandResult,
} from "../../../../../worker/src/command-files";

const ROUTE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

/** The file with its comments removed — this repo documents what it does NOT do. */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const CODE = codeOf(ROUTE);

const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORDER = { side: "buy", symbol: "TSLA", usdgAmount: 25 } as const;
const MIN = 60_000;
const T = 1_800_000_000_000;
/** The hosted tick's window: two 240 s ticks and a ferry pass. */
const WINDOW_MS = orderTtlMs(240);

/** The shared table, as the web writes it and the ferry reads it. */
function ledger() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
    created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT)`);
  return { raw, db: wrapSqlite(raw) };
}

const place = (db: ReturnType<typeof wrapSqlite>, id: string, now: number, agent = AGENT, ttl = WINDOW_MS) =>
  placeHostedOrder(db, { agent, id, args: { ...ORDER }, expiresAt: now + ttl, now });

/** What GET would say about one order at `now` — a read that must succeed. */
async function stateAt(db: ReturnType<typeof wrapSqlite>, id: string, now: number) {
  const r = await readHostedOrder(db, AGENT, id, now);
  assert.equal(r.status, 200);
  return r.body.state;
}

const rowCount = (raw: DatabaseSync) => (raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n;

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function home() {
  const h = mkdtempSync(path.join(tmpdir(), "merry-orders-"));
  homes.push(h);
  return h;
}
/** The self-hosted rail, exactly as the route wires it. */
const filesOf = (h: string) => ({ open: () => openCommands(h), write: (cmd: Parameters<typeof writeCommand>[1]) => writeCommand(h, cmd) });

describe("who may place an order", () => {
  it("A SIGNED-OUT CALLER PLACES NOTHING", () => {
    // Hosted, `tenantOf` is a server-verified wallet and the account is resolved
    // through the grant store — so a caller can never name somebody else's
    // agent. Self-hosted there is no auth and the localhost middleware is the
    // perimeter, which is the same split /api/selftest already draws.
    assert.match(CODE, /const agent = await agentFor\(req\);\s*\n\s*if \(!agent\) return NextResponse\.json\(\{ error: "not signed in" \}, \{ status: 401 \}\);/);
    assert.equal((CODE.match(/if \(!agent\) return/g) ?? []).length, 2, "both POST and GET");
  });

  it("and the agent is never read from the body", () => {
    // The one shape that would turn an authenticated session into a way to
    // trade from somebody else's account.
    assert.ok(!/body\.(agent|agentId|account|tenant)/.test(CODE));
    assert.ok(!/searchParams\.get\("agent/.test(CODE));
  });
});

describe("one click is at most one trade", () => {
  it("THE ID IS A HASH OF THE ORDER, so a retry collides instead of filling twice", () => {
    // A double-click, a component that mounts twice, or a retry after a lost
    // response are all the same order — and with a random uuid each would have
    // been a second position at a second price with a second gas bill. The
    // minute bucket is what keeps a genuinely-repeated order possible.
    assert.match(CODE, /createHash\("sha256"\)/);
    assert.match(CODE, /Math\.floor\(nowMs \/ 60_000\)/);
    assert.match(CODE, /\$\{agent\.toLowerCase\(\)\}\|\$\{o\.side\}\|\$\{o\.symbol\}\|\$\{o\.usdgAmount\}\|\$\{bucket\}/);
    // A HASH, never a concatenation: the id becomes a filename under a child's
    // home in the process that can see every tenant's home. command-files.ts
    // validates the shape again, and this is why it has to.
    assert.match(CODE, /\.digest\("hex"\)/);
  });

  it("and a duplicate is reported as QUEUED, not as an error — and is still one row", async () => {
    // Telling somebody their order failed when it is queued invites exactly the
    // retry this exists to absorb. The first copy has answered here, so the slot
    // is free and only the primary key stands between the two.
    const { raw, db } = ledger();
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, done_at) VALUES (?, ?, 'trade', ?, ?, ?)")
      .run("same", AGENT, JSON.stringify({ ...ORDER, expiresAt: T + WINDOW_MS }), T, T + 30_000);
    const r = await place(db, "same", T + 40_000);
    assert.deepEqual(r, { ok: true, duplicate: true });
    const reply = placedResponse(r, { id: "same", expiresAt: T + 40_000 + WINDOW_MS, now: T + 40_000 });
    assert.equal(reply.status, 200);
    assert.equal((reply.body as { duplicate?: boolean }).duplicate, true);
    assert.equal(rowCount(raw), 1);
  });

  it("ONE ORDER IN FLIGHT AT A TIME, checked before the insert", async () => {
    // Two DIFFERENT orders a second apart are two different ids, so the key
    // collision above would not catch them. Without this, a queue can be filled
    // faster than a worker drains it.
    const { raw, db } = ledger();
    assert.deepEqual(await place(db, "first", T), { ok: true });
    const second = await place(db, "second", T + 1_000);
    assert.deepEqual(second, { ok: false, why: "in-flight" });
    const reply = placedResponse(second, { id: "second", expiresAt: T + 1_000 + WINDOW_MS, now: T + 1_000 });
    assert.equal(reply.status, 409);
    assert.match((reply.body as { error: string }).error, /already have an order waiting/);
    assert.equal(rowCount(raw), 1, "the second was never written");
    // Per agent: somebody else's open order is not this owner's slot.
    assert.deepEqual(await place(db, "theirs", T + 2_000, OTHER), { ok: true });
  });

  it("SELF-HOSTED, the files are the same rule — and a claimed order is still waiting", () => {
    const h = home();
    const now = Date.now();
    const at = (id: string, t = now) => placeSelfHostedOrder(filesOf(h), { id, args: { ...ORDER }, expiresAt: t + WINDOW_MS, now: t });
    assert.deepEqual(at("first"), { ok: true });
    assert.deepEqual(at("second"), { ok: false, why: "in-flight" }, "queued");
    claimCommandFile(h);
    markRunning(h, "first");
    assert.deepEqual(at("second"), { ok: false, why: "in-flight" }, "claimed and unanswered");
    writeCommandResult(h, { id: "first", ok: true, line: "bought 25.00 USDG of TSLA", at: now });
    assert.deepEqual(at("second"), { ok: true }, "answered, so the next may go");
  });

  it("and an order EXPIRES, because a settings write is timeless and this is not", async () => {
    // The child returns early from its drain when it is unarmed, restarting or
    // when the market was unreadable, and the command file survives a restart.
    // Without this, a click during a wobble fills hours later at a price the
    // owner never saw.
    // ONE deadline, computed once, stamped on both rails and handed back to the
    // card that waits for it — so the card cannot run on a clock of its own.
    assert.equal((CODE.match(/now \+ ttlMs/g) ?? []).length, 1);
    const { raw, db } = ledger();
    await place(db, "stamped", T);
    const args = JSON.parse((raw.prepare("SELECT args FROM agent_commands WHERE id = 'stamped'").get() as { args: string }).args);
    assert.deepEqual(args, { ...ORDER, expiresAt: T + WINDOW_MS }, "hosted stamps it, beside the order");
    const h = home();
    placeSelfHostedOrder(filesOf(h), { id: "stamped", args: { ...ORDER }, expiresAt: T + WINDOW_MS, now: T });
    assert.deepEqual(readCommandState(h, "stamped"), { state: "queued", expiresAt: T + WINDOW_MS }, "self-hosted stamps it");
    // And it is the CALLER's tick, not this container's — the same lesson the
    // ceiling below had to learn.
    assert.match(CODE, /\(await getSettingsStore\(\)\.get\(tenant\)\)\?\.tickSeconds/);
  });
});

describe("what a size is allowed to be", () => {
  it("NOT NaN, NOT INFINITE, NOT ZERO, NOT NEGATIVE", () => {
    // A negative size passes every cap in the wall, because every cap is an
    // UPPER bound — and it REDUCES the day's spend on its way past, so the
    // accounting is what gets fooled. It is refused here and again at the wall:
    // two gates, neither relying on the other.
    for (const usdgAmount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, "abc", null]) {
      assert.deepEqual(readOrder({ side: "buy", symbol: "TSLA", usdgAmount }), { error: "that is not an amount I can trade" }, String(usdgAmount));
    }
  });

  it("and it is rounded before it is hashed, so a retry is the same order", () => {
    assert.deepEqual(readOrder({ side: "buy", symbol: "TSLA", usdgAmount: 25.000000001 }), { order: { ...ORDER } });
    assert.deepEqual(readOrder({ side: "buy", symbol: "TSLA", usdgAmount: "25" }), { order: { ...ORDER } });
  });

  it("THE OWNER'S OWN CEILING IS APPLIED, not silently inherited as nothing", async () => {
    // The setting predates this surface and is named for the other one; it
    // means the same thing in both. Applying it is the point — a new surface
    // that bounded nothing would claim more than the owner's configured limit.
    // The rule runs here; POST applying it, and the chips' GET reporting the
    // same figure, run end to end against one fixture in
    // ceiling/route.test.ts — no longer read off this route's source.
    assert.equal(await chatOrderCeiling({ hosted: false, tenant: null, fallback: 10, stored: async () => ({ telegramMaxActionUsdg: 99 }) }), 10);
  });

  it("and a symbol is a ticker, not a sentence", () => {
    assert.deepEqual(readOrder({ side: "buy", symbol: "  tsla ", usdgAmount: 25 }), { order: { ...ORDER } });
    for (const symbol of ["buy me some tesla", "TSLA;DROP", "", "ABCDEFGHIJKLM", 42]) {
      assert.deepEqual(readOrder({ side: "buy", symbol, usdgAmount: 25 }), { error: "that is not a symbol I can look up" }, String(symbol));
    }
  });

  it("a side is buy or sell and nothing else", () => {
    for (const side of ["short", "BUY", "", undefined]) {
      assert.deepEqual(readOrder({ side, symbol: "TSLA", usdgAmount: 25 }), { error: "that is neither a buy nor a sell" }, String(side));
    }
    assert.deepEqual(readOrder({ side: "sell", symbol: "TSLA", usdgAmount: 25 }), { order: { ...ORDER, side: "sell" } });
  });
});

/**
 * THE ENERGY MARKER — the only thing that routes an order to the energy buy.
 *
 * The worker used to route on the symbol, so a plain buy, a snipe or an MCP
 * proposal naming MERRYMEN bought the reserve. It routes on `purpose` now
 * (worker/src/order-gate.ts orderRoute), which makes this route the place the
 * marker is either carried exactly or not at all.
 */
describe("the energy marker", () => {
  const ENERGY = { side: "buy", symbol: "MERRYMEN", usdgAmount: 30 } as const;

  it("IS KEPT ONLY WHEN IT IS EXACTLY 'energy' — every other value is dropped, never passed on", () => {
    assert.deepEqual(readOrder({ ...ENERGY, purpose: "energy" }), { order: { ...ENERGY, purpose: "energy" } });
    for (const purpose of ["Energy", "ENERGY", " energy", "trade", "", 1, true, null, undefined, { energy: true }]) {
      assert.deepEqual(readOrder({ ...ENERGY, purpose }), { order: { ...ENERGY } }, String(purpose));
    }
  });

  it("an ordinary order never gains one — a buy of MERRYMEN is just a buy", () => {
    const read = readOrder({ side: "buy", symbol: "merrymen", usdgAmount: 50 });
    assert.ok("order" in read);
    assert.equal("purpose" in read.order, false);
  });

  it("A MARKED ORDER THAT IS NOT A BUY OF $MERRYMEN IS REFUSED — the energy route buys the reserve whatever the symbol says", () => {
    for (const bad of [
      { side: "sell", symbol: "MERRYMEN", usdgAmount: 30 },
      { side: "buy", symbol: "TSLA", usdgAmount: 30 },
      { side: "buy", symbol: "MERRYMENX", usdgAmount: 30 },
    ]) {
      assert.deepEqual(readOrder({ ...bad, purpose: "energy" }), { error: "an energy order is a buy of $MERRYMEN and nothing else" }, JSON.stringify(bad));
    }
  });

  it("IT IS PART OF THE ORDER'S ID, appended only when present so every other id is unchanged", () => {
    assert.match(CODE, /const purpose = o\.purpose \? `\|\$\{o\.purpose\}` : "";/);
    assert.match(CODE, /\|\$\{bucket\}\$\{purpose\}`\)/);
  });

  it("AND IT IS WRITTEN WITH THE ORDER — the shared table's args carry it to the ferry", async () => {
    const { raw, db } = ledger();
    const read = readOrder({ ...ENERGY, purpose: "energy" });
    assert.ok("order" in read);
    assert.deepEqual(await placeHostedOrder(db, { agent: AGENT, id: "e1", args: { ...read.order }, expiresAt: T + WINDOW_MS, now: T }), { ok: true });
    const row = raw.prepare("SELECT args FROM agent_commands WHERE id = 'e1'").get() as { args: string };
    assert.equal((JSON.parse(row.args) as { purpose?: unknown }).purpose, "energy");
  });
});

describe("what this route deliberately does NOT decide", () => {
  it("IT NEVER JUDGES WHETHER THE TRADE IS ALLOWED", () => {
    // The watch set, the grant's sellable assets, the venue and every cap live
    // in the worker, and only the worker can answer without guessing. A second,
    // weaker copy of the wall in the web tier is the exact shape of the bug the
    // wall exists to prevent — and a wrong "yes" from here would be worse than
    // no check at all.
    for (const forbidden of ["sellableAssets", "allowedAssets", "perTradeUsdg", "checkPolicy", "knownCurves", "grantTokens"]) {
      assert.ok(!CODE.includes(forbidden), `${forbidden} is the worker's to decide, not this route's`);
    }
  });

  it("and it never signs, sends or touches a key", () => {
    for (const forbidden of ["privateKey", "signUserOperation", "sendUserOperation", "mnemonic", "sessionKey", "viem"]) {
      assert.ok(!CODE.includes(forbidden), `${forbidden} has no business in a web route`);
    }
  });
});

describe("what the caller is told", () => {
  it("BY ID: the card hears about ITS order, not the latest one", async () => {
    // There can be two rows — the slot is released at a deadline even when
    // nothing answered — and "what happened to MY order" answered with the
    // newest row reports a different order's result.
    const { raw, db } = ledger();
    await place(db, "mine", T);
    raw.prepare("UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ? WHERE id = 'mine'").run(T + 5_000, T + 60_000, "bought 25.00 USDG of TSLA");
    await place(db, "later", T + 2 * MIN);
    const mine = await readHostedOrder(db, AGENT, "mine", T + 3 * MIN);
    assert.equal(mine.status, 200);
    assert.deepEqual(
      { id: (mine.body as { id: string }).id, state: mine.body.state, result: (mine.body as { result: string | null }).result },
      { id: "mine", state: "done", result: "bought 25.00 USDG of TSLA" },
    );
    const latest = await readHostedOrder(db, AGENT, "", T + 3 * MIN);
    assert.equal((latest.body as { id: string }).id, "later", "with no id, the newest");
  });

  it("and never another agent's, whatever id it names", async () => {
    const { db } = ledger();
    await place(db, "theirs", T, OTHER);
    assert.deepEqual(await readHostedOrder(db, AGENT, "theirs", T), { status: 200, body: { state: "none" } });
  });

  it("AN UNREADABLE LEDGER IS A 503, NOT 'NONE'", async () => {
    // A read that failed is not a record of nothing — "none" is the body for an
    // order that was never placed.
    for (const db of [null, wrapSqlite(new DatabaseSync(":memory:"))]) {
      const r = await readHostedOrder(db, AGENT, "any", T);
      assert.equal(r.status, 503);
      assert.equal("state" in r.body, false);
    }
  });

  it("POST HANDS BACK THE DEADLINE AND THE TIME LEFT, so the card waits on its own clock", async () => {
    // Without the duration the card fell back to a guess; holding the epoch
    // against a browser clock minutes off gave up before it had asked once.
    const { db } = ledger();
    const r = await place(db, "fresh", T);
    const reply = placedResponse(r, { id: "fresh", expiresAt: T + WINDOW_MS, now: T });
    assert.deepEqual(reply, { status: 200, body: { id: "fresh", queued: true, expiresAt: T + WINDOW_MS, expiresInMs: WINDOW_MS } });
  });

  it("and SELF-HOSTED reads the files, because no table ever gets the result there", () => {
    // There is no orchestrator self-hosted, so nothing ferries a result into a
    // row — reading the table would answer "none" for an order that had already
    // filled, which is the same body as one that was never placed.
    const h = home();
    const now = Date.now();
    const exp = now + WINDOW_MS;
    placeSelfHostedOrder(filesOf(h), { id: "o", args: { ...ORDER }, expiresAt: exp, now });
    const reply = (at: number) => selfHostedOrderReply("o", readCommandState(h, "o"), at);
    assert.equal(reply(now).state, "queued");
    assert.equal(reply(now).expiresAt, exp);
    assert.equal(reply(exp + ORDER_STALE_GRACE_MS + 1).state, "expired", "unclaimed past deadline and grace");
    claimCommandFile(h);
    markRunning(h, "o");
    assert.equal(reply(exp + ORDER_STALE_GRACE_MS + 1).state, "running", "claimed: the worker's to answer, however late");
    writeCommandResult(h, { id: "o", ok: true, line: "bought 25.00 USDG of TSLA", at: now });
    assert.deepEqual(reply(now), { id: "o", state: "done", result: "bought 25.00 USDG of TSLA", ok: true, at: now, expiresAt: null });
    assert.deepEqual(selfHostedOrderReply("", null, now), { state: "none" });
    assert.deepEqual(selfHostedOrderReply("../x", readCommandState(h, "../x"), now), { state: "none" });
  });

  it("and the queued response never claims a trade happened", () => {
    // A 200 here means one thing: a row exists. Not ferried, not claimed, not
    // put to the wall, not signed.
    assert.ok(!/bought|sold|filled|executed/i.test(CODE.replace(/'trade'|"trade"/g, "")));
  });
});

describe("what the review found, pinned so it cannot come back", () => {
  it("A DATABASE ERROR IS NOT A DUPLICATE", async () => {
    // The INSERT catch used to swallow EVERY error and answer {queued:true} —
    // so a missing column, a dropped connection or a full disk all told the
    // owner their order was placed when no row existed. Exactly one error means
    // "already queued", and it is the only one reported as success.
    const noTable = wrapSqlite(new DatabaseSync(":memory:"));
    const r = await placeHostedOrder(noTable, { agent: AGENT, id: "x", args: { ...ORDER }, expiresAt: T + WINDOW_MS, now: T });
    assert.deepEqual(r, { ok: false, why: "unreachable" });
    assert.equal(placedResponse(r, { id: "x", expiresAt: T, now: T }).status, 503);
    assert.deepEqual(await placeHostedOrder(null, { agent: AGENT, id: "x", args: { ...ORDER }, expiresAt: T, now: T }), { ok: false, why: "unreachable" });
    // The case the catch was written for: the slot read works and the WRITE
    // fails. Nothing was queued, so nothing may say it was.
    const { raw, db } = ledger();
    raw.exec(`CREATE TRIGGER full_disk BEFORE INSERT ON agent_commands BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    const failedWrite = await place(db, "never-written", T);
    assert.deepEqual(failedWrite, { ok: false, why: "unreachable" });
    assert.equal(placedResponse(failedWrite, { id: "never-written", expiresAt: T, now: T }).status, 503);
    assert.equal(rowCount(raw), 0);
    assert.equal(isDuplicateKey({ code: "23505" }), true, "postgres unique violation");
    assert.equal(isDuplicateKey(new Error("UNIQUE constraint failed: agent_commands.id")), true, "and the sqlite spelling");
    assert.equal(isDuplicateKey(new Error("Connection terminated unexpectedly")), false);
    assert.equal(isDuplicateKey(new Error("no such column: args")), false);
  });

  it("A SELF-HOSTED QUEUE THAT CANNOT BE READ IS A 503, never 'nothing waiting'", () => {
    const r = placeSelfHostedOrder(
      { open: () => { throw new Error("EACCES: permission denied"); }, write: () => assert.fail("nothing may be written") },
      { id: "x", args: { ...ORDER }, expiresAt: T + WINDOW_MS, now: T },
    );
    const reply = placedResponse(r, { id: "x", expiresAt: T + WINDOW_MS, now: T });
    assert.equal(reply.status, 503);
  });

  it("THE IN-FLIGHT GUARD HAS AN AGE BOUND, or one dead order locks the owner out forever", async () => {
    // `done_at` is written only by the ferry, which answers only when the child
    // produced a result. A child SIGKILLed mid-trade — the watchdog does that in
    // bulk on this fleet — left a row nothing could ever finish, and every
    // future order from that tenant was refused.
    const { raw, db } = ledger();
    await place(db, "dead", T);
    raw.prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = 'dead'").run(T + 5_000);
    const past = T + WINDOW_MS + ORDER_STALE_GRACE_MS + ORDER_IN_FLIGHT_MS;
    assert.deepEqual(await place(db, "next", past), { ok: false, why: "in-flight" }, "until it cannot still be trading");
    assert.deepEqual(await place(db, "next", past + 1), { ok: true }, "and not a moment longer");
  });

  it("THE SLOT READS THE ROW'S OWN DEADLINE, not this request's window", async () => {
    // It used to compare created_at with `now - ttlMs` for the CURRENT request.
    // A tenant that shortened its tick shortened every open order's hold with
    // it: at 7m30s the slot let a second order in while GET — reading the
    // row's own deadline — still called the first one queued and claimable.
    const { db } = ledger();
    await place(db, "at-240s", T);
    const shortTick = orderTtlMs(60);
    const at = T + 7 * MIN + 30_000;
    assert.ok(at > T + shortTick + ORDER_STALE_GRACE_MS, "past what the new tick's window would have held");
    assert.equal(await stateAt(db, "at-240s", at), "queued");
    assert.deepEqual(await place(db, "at-60s", at, AGENT, shortTick), { ok: false, why: "in-flight" });
    const released = T + WINDOW_MS + ORDER_STALE_GRACE_MS + 1;
    assert.equal(await stateAt(db, "at-240s", released), "expired");
    assert.deepEqual(await place(db, "at-60s", released, AGENT, shortTick), { ok: true }, "released the instant GET says expired");
  });

  it("SELF-HOSTED: A FILE GET CALLS EXPIRED NO LONGER HOLDS THE SLOT", () => {
    // GET said "nothing was sent. Ask again", and asking again was refused
    // "you already have an order waiting" — for as long as the worker stayed
    // unarmed, because the old check counted filenames with no deadline.
    const h = home();
    const placedAt = Date.now() - WINDOW_MS - ORDER_STALE_GRACE_MS - MIN;
    placeSelfHostedOrder(filesOf(h), { id: "stale", args: { ...ORDER }, expiresAt: placedAt + WINDOW_MS, now: placedAt });
    const now = Date.now();
    assert.equal(selfHostedOrderReply("stale", readCommandState(h, "stale"), now).state, "expired");
    assert.deepEqual(
      placeSelfHostedOrder(filesOf(h), { id: "again", args: { ...ORDER }, expiresAt: now + WINDOW_MS, now }),
      { ok: true },
    );
    // The stale file stays: the worker drops it as expired at the claim and
    // writes the receipt that says so.
    assert.equal(readCommandState(h, "stale")?.state, "queued");
  });

  it("THE CEILING IS THE CALLER'S, not this container's", async () => {
    // `resolveConfig()` reads the WEB process's own ~/.merrymen/settings.json —
    // hosted, the house's file, which has nothing to do with this tenant, whose
    // settings live in the per-tenant store /api/settings reads. Every hosted
    // tenant was held to the house default whatever they had configured.
    const asked: string[] = [];
    const stored = async (tenant: string) => {
      asked.push(tenant);
      return { telegramMaxActionUsdg: 7 };
    };
    assert.equal(await chatOrderCeiling({ hosted: true, tenant: "0xabc", fallback: 10, stored }), 7, "the tenant's own");
    assert.deepEqual(asked, ["0xabc"]);
    // Nothing stored, or nothing usable: the house's.
    for (const own of [undefined, null, -1, Number.NaN, "7"]) {
      assert.equal(await chatOrderCeiling({ hosted: true, tenant: "0xabc", fallback: 10, stored: async () => ({ telegramMaxActionUsdg: own }) }), 10, String(own));
    }
    assert.equal(await chatOrderCeiling({ hosted: true, tenant: "0xabc", fallback: 10, stored: async () => null }), 10);
    // Zero is the owner's own "no chat ceiling", and is theirs to set.
    assert.equal(await chatOrderCeiling({ hosted: true, tenant: "0xabc", fallback: 10, stored: async () => ({ telegramMaxActionUsdg: 0 }) }), 0);
    // No tenant: nobody's store is read.
    assert.equal(await chatOrderCeiling({ hosted: true, tenant: null, fallback: 10, stored }), 10);
    assert.equal(asked.length, 1);
    // Self-hosted the web process and the worker genuinely share one home, so
    // the bare resolve is correct there and no store is read.
    assert.equal(await chatOrderCeiling({ hosted: false, tenant: "0xabc", fallback: 10, stored }), 10);
    assert.equal(asked.length, 1);
  });

  it("and an unreadable settings store falls back to the SMALLER number", async () => {
    // Fail-safe: the default is the tighter ceiling, and the sealed per-trade
    // cap is the real wall underneath either way. A store that throws before
    // it even returns a promise is unreadable too.
    const rejects = async () => {
      throw new Error("store down");
    };
    const throws = (): Promise<null> => {
      throw new Error("no DEK");
    };
    assert.equal(await chatOrderCeiling({ hosted: true, tenant: "0xabc", fallback: 10, stored: rejects }), 10);
    assert.equal(await chatOrderCeiling({ hosted: true, tenant: "0xabc", fallback: 10, stored: throws }), 10);
  });
});
