/**
 * ONE LOGIN, TWO WORKERS, AND EACH GETS ONLY ITS OWN WALLET'S ORDERS.
 *
 * An owner's Close and Close all on the Perps wallet are agent_commands rows
 * bound to the PERPS smart account (perps/owner-order.ts), and the ferry joins
 * every row to a running child on its smart account (orchestrator.ts
 * ferryForChild, ferryOrders). A login's Perps worker is a child of its own —
 * key `0x<owner>:perps`, home `children-perps/<owner>` (worker-key.ts) — whose
 * account is the Perps grant's. So a Perps row reaches the Perps child and
 * never the Spot one, and a Spot row the reverse: not by a rule about perps,
 * but by the same account join every order already crosses on.
 *
 * And a Perps worker the operator has stood down (MERRYMEN_PERPS not paper,
 * D19) is not a child at all: its rows wait, unclaimed and unclosed, and are
 * answered — never run late — when it is started again.
 *
 * The targets are built exactly as ferryOrdersNow builds them from `children`:
 * childHome(key), the child's smart account, the key as the tag.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { commandDir, readCommandState, runTickCommand, writeCommand, type CommandOutcome, type FileCommand } from "./command-files";
import { wrapSqlite } from "./db";
import { expiredOrderReceipt } from "./order-receipt";
import { purposeHome } from "./home";
import { COMMAND_RECEIPT_DDL, childHome, ferryForChild, ferryOrders } from "./orchestrator";
import { workerKey } from "./worker-key";

const fleet = mkdtempSync(path.join(tmpdir(), "merry-perps-ferry-"));
process.env.MERRYMEN_HOME = fleet;
after(() => rmSync(fleet, { recursive: true, force: true }));

const OWNER = "0x1111111111111111111111111111111111111111";
// The two accounts are DIFFERENT addresses, and neither is the owner: the join is on the account.
const SPOT = "0x2222222222222222222222222222222222222222";
const PERPS = "0x3333333333333333333333333333333333333333";
const SPOT_KEY = workerKey(OWNER, "spot");
const PERPS_KEY = workerKey(OWNER, "perps");

function newDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
    created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT)`);
  raw.exec(COMMAND_RECEIPT_DDL);
  return { raw, db: wrapSqlite(raw) };
}

const CLOSE = { side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp", book: "paper" };
const FLATTEN = { side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, purpose: "flatten-perps" };
const BUY = { side: "buy", symbol: "TSLA", usdgAmount: 5 };

const insert = (raw: DatabaseSync, r: { id: string; agent_id: string; kind?: string; args?: object; created_at?: number }) =>
  raw
    .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(r.id, r.agent_id, r.kind ?? "trade", r.args ? JSON.stringify(r.args) : null, r.created_at ?? Date.now());

const row = (raw: DatabaseSync, id: string) => raw.prepare("SELECT * FROM agent_commands WHERE id = ?").get(id) as Record<string, unknown>;

const files = (home: string) => {
  try {
    return readdirSync(commandDir(home)).sort();
  } catch {
    return [];
  }
};

/** ferryOrdersNow's targets, from a `children` map as the orchestrator keeps it. */
const targetsOf = (children: ReadonlyMap<string, { smartAccount: string }>) =>
  [...children.entries()].map(([tenant, child]) => ({ home: childHome(tenant), smartAccount: child.smartAccount, tag: tenant }));

describe("a login's two workers each get their own wallet's orders", () => {
  it("the homes are the two the worker keys name — children/<owner> and children-perps/<owner>", () => {
    assert.equal(childHome(SPOT_KEY), path.join(fleet, "children", OWNER));
    assert.equal(childHome(PERPS_KEY), path.join(fleet, "children-perps", OWNER));
  });

  it("A PERPS EXIT ROW REACHES THE PERPS CHILD ONLY, AND A SPOT ROW THE SPOT CHILD ONLY — on the short loop and the reconcile pass alike", async () => {
    const { raw, db } = newDb();
    const both = targetsOf(new Map([[SPOT_KEY, { smartAccount: SPOT }], [PERPS_KEY, { smartAccount: PERPS }]]));
    const expiresAt = Date.now() + 5 * 60_000;
    insert(raw, { id: "perp-close", agent_id: PERPS, args: { ...CLOSE, expiresAt } });
    insert(raw, { id: "perp-all", agent_id: PERPS, args: { ...FLATTEN, expiresAt } });
    insert(raw, { id: "spot-buy", agent_id: SPOT, args: { ...BUY, expiresAt } });
    // A Perps reset rides the reconcile pass, as every non-trade row does.
    insert(raw, { id: "perp-reset", agent_id: PERPS, kind: "paper-reset" });
    await ferryOrders(db, both);
    for (const t of both) await ferryForChild(db, t);
    const spotHome = childHome(SPOT_KEY);
    const perpsHome = childHome(PERPS_KEY);
    assert.deepEqual(files(perpsHome), ["perp-all.json", "perp-close.json", "perp-reset.json"]);
    assert.deepEqual(files(spotHome), ["spot-buy.json"]);
    // The exit crosses whole: its marker, its book and its zero, with the deadline lifted out for the claim to judge.
    const onDisk = JSON.parse(readFileSync(path.join(commandDir(perpsHome), "perp-close.json"), "utf8")) as FileCommand;
    assert.deepEqual(onDisk.args, CLOSE);
    assert.equal(onDisk.expiresAt, expiresAt);
    assert.equal(onDisk.kind, "trade");
    const all = JSON.parse(readFileSync(path.join(commandDir(perpsHome), "perp-all.json"), "utf8")) as FileCommand;
    assert.equal(Object.hasOwn(all.args ?? {}, "book"), false, "an unread book stays absent: every book (D11)");
    for (const id of ["perp-close", "perp-all", "spot-buy", "perp-reset"]) assert.ok(row(raw, id).claimed_at, `${id} claimed once`);
  });

  it("a row under the OWNER address — neither wallet's account — reaches neither child", async () => {
    const { raw, db } = newDb();
    const both = targetsOf(new Map([[SPOT_KEY, { smartAccount: SPOT }], [PERPS_KEY, { smartAccount: PERPS }]]));
    insert(raw, { id: "under-owner", agent_id: OWNER, args: CLOSE });
    await ferryOrders(db, both);
    for (const t of both) await ferryForChild(db, t);
    assert.equal(row(raw, "under-owner").claimed_at, null);
    assert.equal(existsSync(path.join(commandDir(childHome(PERPS_KEY)), "under-owner.json")), false);
  });

  it("A STOOD-DOWN PERPS WORKER IS NO CHILD: its exit waits unclaimed and unclosed, the Spot child's sweep never touches it, and it is answered — never run late — when perps return", async () => {
    const { raw, db } = newDb();
    rmSync(commandDir(childHome(PERPS_KEY)), { recursive: true, force: true }); // only this case's files
    // Queued an hour ago with a window that closed half an hour ago.
    const created = Date.now() - 60 * 60_000;
    insert(raw, { id: "frozen-close", agent_id: PERPS, args: { ...CLOSE, expiresAt: created + 30 * 60_000 }, created_at: created });
    insert(raw, { id: "spot-buy-beside", agent_id: SPOT, args: BUY });
    // MERRYMEN_PERPS is not paper: the orchestrator never starts the Perps child (perpsSpawnable).
    const spotOnly = targetsOf(new Map([[SPOT_KEY, { smartAccount: SPOT }]]));
    await ferryOrders(db, spotOnly);
    for (const t of spotOnly) await ferryForChild(db, t);
    const frozen = row(raw, "frozen-close");
    assert.equal(frozen.claimed_at, null, "nobody took it");
    assert.equal(frozen.done_at, null, "and the Spot child's stale sweep did not close it: it is not that account's row");
    assert.ok(files(childHome(SPOT_KEY)).includes("spot-buy-beside.json"), "the Spot worker's orders still cross");
    assert.ok(!files(childHome(SPOT_KEY)).includes("frozen-close.json"));
    assert.ok(!files(childHome(PERPS_KEY)).includes("frozen-close.json"), "nothing written into the stood-down home");
    // Perps back on paper: the Perps child runs again, the row is delivered once
    // and closed as never ran — and the child refuses the file at its claim as
    // expired (command-files.ts isExpired), so nothing is sent either way.
    const perps = targetsOf(new Map([[PERPS_KEY, { smartAccount: PERPS }]]));
    for (const t of perps) await ferryForChild(db, t);
    const answered = row(raw, "frozen-close");
    assert.ok(answered.claimed_at);
    assert.ok(answered.done_at);
    assert.match(String(answered.result), /^never ran — .*nothing was sent/);
    // ITS SENTENCE ALONE: a Close is no Spot sell, so it carries no receipt
    // here, as it carries none when it runs (index.ts orderOutcome).
    assert.equal(answered.receipt, null);
    assert.ok(files(childHome(PERPS_KEY)).includes("frozen-close.json"));
    assert.ok(!files(childHome(SPOT_KEY)).includes("frozen-close.json"));
    // And the child, reaching the file at its claim, answers it expired with
    // no receipt either: the drain's hook is index.ts runQueuedCommand's.
    const ran: string[] = [];
    const told: CommandOutcome[] = [];
    await runTickCommand(childHome(PERPS_KEY), {
      now: Date.now,
      run: async (cmd) => (ran.push(cmd.id), { ok: true, line: "ran" }),
      told: async (_cmd, outcome) => void told.push(outcome),
      expiredReceipt: (cmd) => (cmd.kind === "trade" ? expiredOrderReceipt(cmd.args) : undefined),
    });
    assert.deepEqual(ran, [], "never run");
    assert.equal(told.length, 1);
    assert.match(told[0]!.line, /^expired — /);
    assert.equal(told[0]!.receipt, undefined);
    assert.equal(readCommandState(childHome(PERPS_KEY), "frozen-close")?.result?.receipt, undefined);
  });

  it("A PERPS PRACTICE RESET CARRIES ITS DEADLINE ACROSS THE FERRY: queued at paper, waited out a stand-down, and is answered expired — never run — when perps return", async () => {
    const { raw, db } = newDb();
    rmSync(commandDir(childHome(PERPS_KEY)), { recursive: true, force: true }); // only this case's files
    const created = Date.now() - 24 * 60 * 60_000;
    // As queueRecoveryCheckedCommand writes a Perps reset: its deadline in args.
    insert(raw, { id: "frozen-reset", agent_id: PERPS, kind: "paper-reset", args: { expiresAt: created + 5 * 60_000 }, created_at: created });
    // Stood down: no Perps child, so nothing is delivered.
    for (const t of targetsOf(new Map([[SPOT_KEY, { smartAccount: SPOT }]]))) await ferryForChild(db, t);
    assert.equal(row(raw, "frozen-reset").claimed_at, null);
    // A day later, back on paper: delivered, its deadline lifted onto the file.
    for (const t of targetsOf(new Map([[PERPS_KEY, { smartAccount: PERPS }]]))) await ferryForChild(db, t);
    const onDisk = JSON.parse(readFileSync(path.join(commandDir(childHome(PERPS_KEY)), "frozen-reset.json"), "utf8")) as FileCommand;
    assert.equal(onDisk.kind, "paper-reset");
    assert.equal(onDisk.expiresAt, created + 5 * 60_000);
    assert.equal(onDisk.args, undefined, "the deadline is not an argument");
    const ran: string[] = [];
    const told: CommandOutcome[] = [];
    await runTickCommand(childHome(PERPS_KEY), {
      now: Date.now,
      run: async (cmd) => (ran.push(cmd.kind), { ok: true, line: "paper book restarted" }),
      told: async (_cmd, outcome) => void told.push(outcome),
    });
    assert.deepEqual(ran, [], "the practice book is not wiped a day after it was asked for");
    assert.match(told[0]?.line ?? "", /^expired — I picked up this practice reset .* so the practice book was not reset/);
  });
});

/**
 * SELF-HOSTED THERE IS NO FERRY: the web writes the file into the wallet's own
 * home, and each worker drains only its own (`MERRYMEN_HOME` is
 * `accounts/perps` for the Perps worker, as `merrymen recover` already runs it).
 */
describe("self-hosted, each wallet's worker drains its own home", () => {
  it("an exit filed in accounts/perps/commands is never seen by the Spot worker's drain", async () => {
    const spotHome = purposeHome("spot");
    const perpsHome = purposeHome("perps");
    assert.equal(commandDir(perpsHome), path.join(fleet, "accounts", "perps", "commands"));
    assert.notEqual(commandDir(perpsHome), commandDir(spotHome));
    writeCommand(perpsHome, { id: "self-close", kind: "trade", at: Date.now(), args: CLOSE, expiresAt: Date.now() + 60_000 });
    const seen: string[] = [];
    const drain = (home: string) =>
      runTickCommand(home, { now: Date.now, run: async (cmd) => (seen.push(`${home}:${cmd.id}`), { ok: true, line: "ran" }), told: async () => {} });
    await drain(spotHome);
    assert.deepEqual(seen, [], "the Spot home's queue does not hold it");
    await drain(perpsHome);
    assert.deepEqual(seen, [`${perpsHome}:self-close`]);
  });
});
