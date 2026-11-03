import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, test } from "node:test";
import { purposeHome } from "@merrymen/home";
import { readHostedOrder } from "@/lib/order-state";
import { writeCommand, writeCommandResult, runTickCommand, markRunning } from "../../../../../worker/src/command-files";
import { GET } from "./route";

const ACCOUNT = `0x${"b".repeat(40)}`, OTHER = `0x${"c".repeat(40)}`;
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_PERPS"];
const saved = new Map(keys.map(key => [key, process.env[key]]));
const homes: string[] = [];
let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "merrymen-reset-status-")); homes.push(home);
  process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_PERPS = "paper";
  delete process.env.MERRYMEN_HOSTED; delete process.env.DATABASE_URL;
  mkdirSync(purposeHome("perps"), { recursive: true });
  writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ purpose: "perps", smartAccount: ACCOUNT }));
});
after(() => { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const read = (id: string, extra = "") => GET(new Request(`http://localhost/api/paper-reset?wallet=perps&id=${id}&expectedAccount=${ACCOUNT}${extra}`));

test("reset status follows its bound queue, running marker and worker answer", async () => {
  const h = purposeHome("perps");
  writeCommand(h, { id: "reset", kind: "paper-reset", account: ACCOUNT, at: Date.now(), expiresAt: Date.now() + 300_000 });
  const queued = await read("reset"); assert.equal(queued.headers.get("cache-control"), "private, no-store"); assert.equal((await queued.json()).state, "queued");
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const drain = runTickCommand(h, { now: Date.now, account: () => ACCOUNT, told: async () => {}, run: async () => { await pending; return { ok: true, line: "Practice book reset." }; } });
  assert.equal((await (await read("reset")).json()).state, "running");
  finish(); await drain;
  const answer = await (await read("reset")).json();
  assert.equal(answer.state, "done"); assert.equal(answer.result, "Practice book reset.");
});

test("reset lookup never borrows a trade, another account, a legacy answer or a missing file", async () => {
  const h = purposeHome("perps");
  writeCommand(h, { id: "trade", kind: "trade", account: ACCOUNT, at: Date.now() });
  writeCommand(h, { id: "other", kind: "paper-reset", account: OTHER, at: Date.now() });
  writeCommandResult(h, { id: "legacy", ok: true, at: Date.now(), line: "unbound" });
  writeCommandResult(h, { id: "foreign-result", kind: "paper-reset", account: OTHER, ok: true, at: Date.now(), line: "private" });
  markRunning(h, "foreign-running", "paper-reset", OTHER);
  markRunning(h, "legacy-running", "paper-reset");
  for (const id of ["trade", "other", "legacy", "foreign-result", "foreign-running", "legacy-running", "missing"]) assert.deepEqual(await (await read(id)).json(), { state: "none" }, id);
  assert.equal((await read("../outside")).status, 400);
  assert.equal((await read("reset", "&id=other")).status, 400);
  assert.equal((await read("reset", `&expectedAccount=${OTHER}`)).status, 409);
});

test("expired reset carries its own bound refusal, with no practice work run", async () => {
  const h = purposeHome("perps");
  writeCommand(h, { id: "late", kind: "paper-reset", account: ACCOUNT, at: 1, expiresAt: 2 });
  await runTickCommand(h, { now: Date.now, account: () => ACCOUNT, told: async () => {}, run: async () => { throw new Error("late reset must not run"); } });
  const answer = await (await read("late")).json(); assert.equal(answer.state, "done"); assert.equal(answer.ok, false); assert.match(answer.result, /expired/i);
});

test("reset status is Perps-only and unavailable when the paper offering is off", async () => {
  for (const query of ["", "?wallet=spot"]) assert.equal((await GET(new Request(`http://localhost/api/paper-reset${query}`))).status, 404);
  for (const mode of ["off", "live", ""]) { process.env.MERRYMEN_PERPS = mode; assert.equal((await read("reset")).status, 404); }
});

test("hosted reset SELECT binds both account and command kind and reports an unread database", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE agent_commands (id TEXT, agent_id TEXT, kind TEXT, created_at INTEGER, claimed_at INTEGER, done_at INTEGER, args TEXT, result TEXT)");
    const insert = db.prepare("INSERT INTO agent_commands VALUES (?, ?, ?, 1, NULL, 2, NULL, ?)");
    insert.run("reset", ACCOUNT, "paper-reset", "reset complete"); insert.run("trade", ACCOUNT, "trade", "private trade"); insert.run("other", OTHER, "paper-reset", "other book");
    const store = db as unknown as Parameters<typeof readHostedOrder>[0];
    for (const id of ["trade", "other", "absent"]) assert.deepEqual(await readHostedOrder(store, ACCOUNT, id, Date.now(), "paper-reset"), { status: 200, body: { state: "none" } });
    const result = await readHostedOrder(store, ACCOUNT, "reset", Date.now(), "paper-reset"); assert.equal(result.status, 200); assert.equal((result.body as { result: string }).result, "reset complete");
    assert.deepEqual(await readHostedOrder(store, ACCOUNT, "reset", Date.now()), { status: 200, body: { state: "none" } }, "ordinary orders cannot see resets");
    assert.equal((await readHostedOrder(null, ACCOUNT, "reset", Date.now(), "paper-reset")).status, 503);
  } finally { db.close(); }
});
