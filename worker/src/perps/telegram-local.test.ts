import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createLocalPerpsPort, LOCAL_PERPS_BOT_CLAIMS } from "./telegram-local";
import { claimCommandFile, commandDir, markRunning, openCommands, writeCommand, writeCommandResult } from "../command-files";
import { withLocalStateLock } from "../local-state-lock";
import { tokenTagOf } from "../telegram/state";
const ACCOUNT = "0x1111111111111111111111111111111111111111", OWNER = "0x2222222222222222222222222222222222222222", OTHER = "0x3333333333333333333333333333333333333333";
const report = { v: 1, mode: "paper", blocker: null, venueReadAt: Date.now(), protectAt: Date.now(), accountIndex: null, positions: [], openNotionalMicro: "0", collateralMicro: "100000000", inTransitMicro: "0", minLiqDistanceBps: null, stopsMissing: 0, incident: false };
function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(path.join(tmpdir(), "mm-local-bot-")), perpsHome = path.join(home, "accounts", "perps"), saved = process.env.MERRYMEN_PERPS;
  process.env.MERRYMEN_PERPS = "paper";
  t.after(() => { if (saved === undefined) delete process.env.MERRYMEN_PERPS; else process.env.MERRYMEN_PERPS = saved; rmSync(home, { recursive: true, force: true }); });
  mkdirSync(perpsHome, { recursive: true });
  const grant = { purpose: "perps", smartAccount: ACCOUNT, owner: OWNER, chainId: 4663, expiresAt: Math.floor(Date.now() / 1000) + 1000 };
  writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify(grant));
  writeFileSync(path.join(perpsHome, "settings.json"), JSON.stringify({ tickSeconds: 300 }));
  const token = "123:local-test-secret";
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramEnabled: true, telegramBotToken: token, telegramAllowlist: [42] }));
  writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ botId: "123", tokenTag: tokenTagOf(token), ownerId: 42, linkedChatAt: { "42": Math.floor(Date.now() / 1000) - 20 } }));
  const raw = new DatabaseSync(path.join(perpsHome, "merrymen.db"));
  raw.exec("CREATE TABLE agents(smart_account TEXT PRIMARY KEY,owner_address TEXT,chain_id INTEGER,mode TEXT,perps TEXT)");
  raw.prepare("INSERT INTO agents VALUES(?,?,?,'paper',?)").run(ACCOUNT, OWNER, 4663, JSON.stringify(report)); raw.close();
  const port = createLocalPerpsPort(home);
  const input = { action: "close" as const, market: "BTC-PERP" as const, expectedAccount: ACCOUNT as `0x${string}`, requestId: "tg-perps-123-1", askedAtSec: Math.floor(Date.now() / 1000) };
  return { home, perpsHome, port, input, grant };
}

test("reads the dedicated Perps ledger and validates its owner, never the Spot ledger", async t => {
  const { home, perpsHome, port } = setup(t); writeFileSync(path.join(home, "merrymen.db"), "not a database");
  const view = await port.read(); assert.equal(view.state, "ready"); if (view.state === "ready") { assert.equal(view.account, ACCOUNT); assert.equal(view.report?.collateralMicro, "100000000"); }
  const raw = new DatabaseSync(path.join(perpsHome, "merrymen.db")); raw.prepare("UPDATE agents SET owner_address=?").run(OTHER); raw.close();
  assert.deepEqual(await port.read(), { state: "unread" });
  rmSync(path.join(perpsHome, "grant.json")); assert.deepEqual(await port.read(), { state: "absent" });
  writeFileSync(path.join(perpsHome, "grant.json"), "{bad"); assert.deepEqual(await port.read(), { state: "unread" });
});

test("queues one account-bound paper exit with its original TTL and a permanent public claim", async t => {
  const { home, perpsHome, port, input } = setup(t);
  assert.match(await port.exit(input), /^Your paper Perps exit was queued/);
  assert.equal(existsSync(commandDir(home)), false, "Spot's command directory is untouched");
  const command = claimCommandFile(perpsHome)!; assert.equal(command.account, ACCOUNT); assert.equal(command.at, input.askedAtSec * 1000);
  assert.equal(command.expiresAt, input.askedAtSec * 1000 + 615_000); assert.deepEqual(command.args, { purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper" });
  assert.equal(markRunning(perpsHome, command.id, "trade", ACCOUNT), true); writeCommandResult(perpsHome, { id: command.id, ok: true, line: "closed", at: Date.now() });
  rmSync(path.join(commandDir(perpsHome), `${command.id}.done.json`));
  assert.match(await createLocalPerpsPort(home).exit({ ...input, action: "flatten", market: undefined }), /already recorded/);
  assert.equal(openCommands(perpsHome).length, 0);
  const claims = new DatabaseSync(path.join(perpsHome, LOCAL_PERPS_BOT_CLAIMS), { readOnly: true });
  try { assert.equal(claims.prepare("SELECT COUNT(*) AS n FROM requests").get()?.n, 1); assert.doesNotMatch(JSON.stringify(claims.prepare("SELECT * FROM requests").all()), /secret|PrivateKey|serialized/); }
  finally { claims.close(); }
});

test("a failed durable command write consumes the update and cannot replay after restart", async t => {
  const { home, perpsHome, port, input } = setup(t), actual = fs.fsyncSync;
  fs.fsyncSync = ((fd: number) => { if (fs.fstatSync(fd).isFile()) throw Error("disk cannot sync queue"); actual(fd); }) as typeof fs.fsyncSync; syncBuiltinESMExports();
  try { assert.match(await port.exit(input), /No execution was confirmed/); }
  finally { fs.fsyncSync = actual; syncBuiltinESMExports(); }
  assert.equal(openCommands(perpsHome).length, 0);
  assert.match(await createLocalPerpsPort(home).exit(input), /already recorded/); assert.equal(openCommands(perpsHome).length, 0);
});

test("local file queue shares HTTP's pending slot and serializes concurrent bot exits", async t => {
  const { perpsHome, port, input } = setup(t);
  const replies = await Promise.all([port.exit(input), port.exit({ ...input, requestId: "tg-perps-123-2" })]);
  assert.equal(replies.filter(r => /^Your paper Perps exit was queued/.test(r)).length, 1); assert.equal(openCommands(perpsHome).length, 1);
  assert.ok(replies.some(r => /still pending/.test(r)));
});

test("a waiting exit rechecks a revoked Telegram owner or replaced grant under the install lock", async t => {
  const { home, perpsHome, port, input, grant } = setup(t);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writer = withLocalStateLock(home, async () => { entered(); await gate; writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify({ ...grant, smartAccount: OTHER })); });
  await ready; const waiting = port.exit(input); release(); await writer;
  assert.match(await waiting, /permission changed/); assert.equal(openCommands(perpsHome).length, 0);
  const cfg = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")); cfg.telegramAllowlist = []; writeFileSync(path.join(home, "settings.json"), JSON.stringify(cfg));
  assert.match(await port.exit(input), /could not be verified/); assert.equal(openCommands(perpsHome).length, 0);
});

test("off, expired, stale, held, malformed and wrong-account requests never queue", async t => {
  const { perpsHome, port, input, grant } = setup(t);
  process.env.MERRYMEN_PERPS = "off"; assert.match(await port.exit(input), /not running/); process.env.MERRYMEN_PERPS = "paper";
  for (const bad of [{ ...input, expectedAccount: OTHER as `0x${string}` }, { ...input, askedAtSec: input.askedAtSec - 1000 }, { ...input, market: "BAD-PERP<script>" as "BTC-PERP" }]) assert.doesNotMatch(await port.exit(bad), /^Your paper Perps exit was queued/);
  writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify({ ...grant, expiresAt: input.askedAtSec })); assert.match(await port.exit(input), /expired/);
  writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify(grant));
  const raw = new DatabaseSync(path.join(perpsHome, "merrymen.db")); raw.exec("CREATE TABLE paper_recovery_health(agent_id TEXT,blocked INTEGER)"); raw.prepare("INSERT INTO paper_recovery_health VALUES(?,1)").run(ACCOUNT); raw.close();
  assert.match(await port.exit(input), /held/); assert.equal(openCommands(perpsHome).length, 0);
});
