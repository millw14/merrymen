import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { drainPerpsBotRequests, parsePerpsBotRequest, perpsBotRequestKey, PERPS_BOT_OUTBOX, PERPS_BOT_SNAPSHOT, readPerpsBotSnapshot, writePerpsBotRequest, writePerpsBotSnapshot, readPerpsBotAuthority, queuePerpsBotKill, fileTelegramPerpsPort, askPerpsBotControl, type PerpsBotRequest } from "./telegram-bridge";
import { tokenTagOf } from "../telegram/state";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const request = (extra: Partial<PerpsBotRequest> = {}): PerpsBotRequest => ({ kind: "flatten", expectedAccount: ACCOUNT, requestId: "tg-perps-123-1", askedAtSec: Math.floor(Date.now() / 1000), ...extra });
const homeFor = (t: { after(fn: () => void): void }) => { const home = mkdtempSync(path.join(tmpdir(), "mm-bot-bridge-")); t.after(() => rmSync(home, { recursive: true, force: true })); return home; };
const pending = (home: string, r: PerpsBotRequest) => path.join(home, PERPS_BOT_OUTBOX, `${perpsBotRequestKey(r)}.json`);
const result = (home: string, r: PerpsBotRequest) => path.join(home, PERPS_BOT_OUTBOX, `${perpsBotRequestKey(r)}.result.json`);

test("old kills remain actionable, but stale exits and resumes cannot change a later book", async t => {
  const home = homeFor(t), old = Math.floor(Date.now() / 1000) - 172_800;
  const kill = request({ kind: "kill", askedAtSec: old });
  assert.ok(parsePerpsBotRequest(kill));
  for (const kind of ["close", "flatten", "pause", "resume"] as const) assert.equal(parsePerpsBotRequest(request({ kind, askedAtSec: old, ...(kind === "close" ? { market: "BTC-PERP" } : {}) })), null);
  writePerpsBotRequest(home, kill);
  const applied: string[] = [];
  await drainPerpsBotRequests(home, () => true, async r => { applied.push(r.kind); return "stopped"; });
  assert.deepEqual(applied, ["kill"]); assert.equal(existsSync(pending(home, kill)), false);
  const past = new Date(Date.now() - 172_800_000); utimesSync(result(home, kill), past, past);
  await drainPerpsBotRequests(home, () => true, async () => { throw Error("already done"); });
  assert.equal(existsSync(result(home, kill)), true, "kill replay fence never ages out");
  writePerpsBotRequest(home, kill); assert.equal(existsSync(pending(home, kill)), false);
});

test("requests drain by owner request time, then numeric Telegram update order", async t => {
  const home = homeFor(t), now = Math.floor(Date.now() / 1000), seen: string[] = [];
  const inputs = [request({ requestId: "tg-perps-123-10", kind: "resume", askedAtSec: now }), request({ requestId: "tg-perps-123-9", kind: "pause", askedAtSec: now }), request({ requestId: "tg-perps-123-8", askedAtSec: now - 1 })];
  for (const r of inputs) writePerpsBotRequest(home, r);
  await drainPerpsBotRequests(home, () => true, async r => { seen.push(r.requestId); return "recorded"; });
  assert.deepEqual(seen, ["tg-perps-123-8", "tg-perps-123-9", "tg-perps-123-10"]);
});

test("a durable receipt wins over a leftover request and malformed receipts fail closed", async t => {
  const home = homeFor(t), r = request(); writePerpsBotRequest(home, r);
  let calls = 0;
  await drainPerpsBotRequests(home, () => true, async () => { calls++; return "queued"; });
  writeFileSync(pending(home, r), JSON.stringify(r));
  await drainPerpsBotRequests(home, () => true, async () => { calls++; return "must not replay"; });
  assert.equal(calls, 1); assert.equal(existsSync(pending(home, r)), false);
  writeFileSync(pending(home, r), JSON.stringify(r)); writeFileSync(result(home, r), "{broken");
  await drainPerpsBotRequests(home, () => true, async () => { calls++; return "must not replay"; });
  assert.equal(calls, 1); assert.equal(existsSync(pending(home, r)), true, "an unreadable receipt cannot silently discard the request");
});

test("strict requests reject extra authority, traversal, unsafe clocks and forged market shape", () => {
  for (const bad of [{ tenant: ACCOUNT }, { home: "/elsewhere" }, { requestId: "../escape" }, { expectedAccount: "0x1" }, { askedAtSec: 0 }, { askedAtSec: Number.MAX_SAFE_INTEGER }, { kind: "close", market: "BTC-PERP<script>" }, { kind: "flatten", market: "BTC-PERP" }]) assert.equal(parsePerpsBotRequest({ ...request(), ...bad }), null);
});

test("bounded regular files and key binding prevent symlink or oversized queue input", async t => {
  const home = homeFor(t), r = request(); writePerpsBotRequest(home, r);
  const original = pending(home, r); rmSync(original);
  const outside = path.join(home, "outside.json"); writeFileSync(outside, JSON.stringify(r)); symlinkSync(outside, original);
  let applied = 0;
  await drainPerpsBotRequests(home, () => true, async () => { applied++; return "never"; });
  assert.equal(applied, 0); assert.equal(readFileSync(outside, "utf8"), JSON.stringify(r));
  const wrong = request({ requestId: "tg-perps-123-2" }); writePerpsBotRequest(home, wrong); writeFileSync(pending(home, wrong), JSON.stringify(r));
  const huge = request({ requestId: "tg-perps-123-3" }); writePerpsBotRequest(home, huge); writeFileSync(pending(home, huge), " ".repeat(2049));
  await drainPerpsBotRequests(home, () => true, async () => { applied++; return "never"; }); assert.equal(applied, 0);
});

test("queue capacity is bounded and writer loss preserves requests without a false receipt", async t => {
  const home = homeFor(t);
  for (let i = 0; i < 16; i++) writePerpsBotRequest(home, request({ requestId: `tg-perps-123-${i}` }));
  assert.throws(() => writePerpsBotRequest(home, request({ requestId: "tg-perps-123-16" })), /busy/);
  let owned = true, calls = 0;
  await drainPerpsBotRequests(home, () => owned, async () => { calls++; owned = false; return "not acknowledged"; });
  assert.equal(calls, 1);
  assert.equal(fs.readdirSync(path.join(home, PERPS_BOT_OUTBOX)).filter(n => n.endsWith(".result.json")).length, 0);
});

test("the new outbox's parent is synced before acknowledging a durable request", t => {
  const home = homeFor(t), parent = path.join(home, "new", "tenant");
  const actual = fs.fsyncSync; let syncedDirectories = 0;
  fs.fsyncSync = ((fd: number) => { if (fs.fstatSync(fd).isDirectory()) syncedDirectories++; actual(fd); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { const r = request(); writePerpsBotRequest(parent, r); assert.ok(syncedDirectories >= 4, "all three created directory entries and the request entry must be synced"); assert.equal(statSync(pending(parent, r)).mode & 0o777, 0o600); }
  finally { fs.fsyncSync = actual; syncBuiltinESMExports(); }
});

test("snapshots reject stale, malformed, live, oversized and symlinked reports", t => {
  const home = homeFor(t), now = Date.now(), file = path.join(home, PERPS_BOT_SNAPSHOT);
  writePerpsBotSnapshot(home, { state: "ready", account: ACCOUNT, report: null, grantExpiresAt: Math.floor(now / 1000) + 100 });
  assert.equal(readPerpsBotSnapshot(home).state, "ready"); assert.equal(readPerpsBotSnapshot(home, now + 120_000).state, "unread");
  for (const snapshot of [{ state: "ready", account: "wrong", report: null, grantExpiresAt: null }, { state: "ready", account: ACCOUNT, report: { mode: "live" }, grantExpiresAt: null }]) { writeFileSync(file, JSON.stringify({ v: 1, at: now, snapshot })); assert.equal(readPerpsBotSnapshot(home, now).state, "unread"); }
  writeFileSync(file, " ".repeat(256_001)); assert.equal(readPerpsBotSnapshot(home).state, "unread");
  rmSync(file); const outside = path.join(home, "snapshot-outside.json"); writeFileSync(outside, JSON.stringify({ v: 1, at: now, snapshot: { state: "absent" } })); symlinkSync(outside, file);
  assert.equal(readPerpsBotSnapshot(home, now).state, "unread");
});

function authorize(home: string, extra: Record<string, unknown> = {}) {
  const token = "123:local-test-secret", linkedAtSec = Math.floor(Date.now() / 1000) - 10;
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramEnabled: true, telegramControlEnabled: true, telegramBotToken: token, telegramAllowlist: [42], ...extra }));
  writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ ownerId: 42, botId: "123", tokenTag: tokenTagOf(token), linkedChatAt: { "42": linkedAtSec } }));
  return { botId: "123", tokenTag: tokenTagOf(token), ownerId: 42, linkedAtSec };
}
test("authority binds enabled controls, owner allowlist, token generation and last link without storing a token", t => {
  const home = homeFor(t), expected = authorize(home);
  assert.deepEqual(readPerpsBotAuthority(home), expected);
  authorize(home, { telegramControlEnabled: undefined }); assert.deepEqual(readPerpsBotAuthority(home), expected, "omitted control setting follows the true default");
  assert.doesNotMatch(JSON.stringify(readPerpsBotAuthority(home)), /local-test-secret/);
  for (const changes of [{ telegramEnabled: false }, { telegramControlEnabled: false }, { telegramControlEnabled: "true" }, { telegramAllowlist: [] }, { telegramBotToken: "123:rotated-secret" }]) {
    authorize(home, changes); assert.equal(readPerpsBotAuthority(home), null);
  }
  authorize(home); const state = JSON.parse(readFileSync(path.join(home, "telegram.json"), "utf8"));
  state.linkedChatAt["42"]++; writeFileSync(path.join(home, "telegram.json"), JSON.stringify(state));
  assert.equal(readPerpsBotAuthority(home)?.linkedAtSec, expected.linkedAtSec + 1);
  delete state.linkedChatAt; writeFileSync(path.join(home, "telegram.json"), JSON.stringify(state)); assert.equal(readPerpsBotAuthority(home), null);
  assert.equal(parsePerpsBotRequest({ ...request(), authority: { ...expected, token: "must-not-cross" } }), null);
  assert.equal(parsePerpsBotRequest({ ...request(), authority: { ...expected, botId: "999" } }), null);
  for (const requestId of ["tg-perps-123-invented", "tg-perps-123-9999999999999999"]) assert.equal(parsePerpsBotRequest({ ...request(), requestId, authority: expected }), null);
});

test("file exit and controls stamp fresh authority at the synchronous write boundary", async t => {
  const home = homeFor(t), authority = authorize(home), r = request();
  writePerpsBotSnapshot(home, { state: "ready", account: ACCOUNT, report: null, grantExpiresAt: Math.floor(Date.now() / 1000) + 100 });
  const exiting = fileTelegramPerpsPort(home).exit({ action: "flatten", expectedAccount: ACCOUNT, requestId: r.requestId, askedAtSec: r.askedAtSec });
  assert.deepEqual(JSON.parse(readFileSync(pending(home, r), "utf8")).authority, authority);
  await drainPerpsBotRequests(home, () => true, async () => "queued"); assert.equal(await exiting, "queued");
  const control = request({ kind: "pause", requestId: "tg-perps-123-2" });
  const pausing = askPerpsBotControl(home, "pause", control);
  assert.deepEqual(JSON.parse(readFileSync(pending(home, control), "utf8")).authority, authority);
  await drainPerpsBotRequests(home, () => true, async () => "paused"); assert.equal(await pausing, "paused");
});

test("kill records a durable restrictive pause even when queue admission fails", t => {
  const home = homeFor(t); authorize(home);
  writePerpsBotSnapshot(home, { state: "ready", account: ACCOUNT, report: null, grantExpiresAt: Math.floor(Date.now() / 1000) + 100 });
  const queued = queuePerpsBotKill(home); assert.deepEqual(queued, { ok: true, revocation: "queued", archived: null });
  assert.equal(statSync(path.join(home, "paused")).mode & 0o777, 0o600);
  const names = fs.readdirSync(path.join(home, PERPS_BOT_OUTBOX));
  const body = JSON.parse(readFileSync(path.join(home, PERPS_BOT_OUTBOX, names[0]!), "utf8")); assert.equal(body.kind, "kill"); assert.deepEqual(body.authority, readPerpsBotAuthority(home)); assert.doesNotMatch(JSON.stringify(body), /local-test-secret/);
  for (let i = 0; i < 15; i++) writePerpsBotRequest(home, request({ requestId: `tg-perps-123-${i}` }));
  assert.equal(queuePerpsBotKill(home).ok, false); assert.ok(existsSync(path.join(home, "paused")), "failed queue write never unpauses the login");
});

test("one Telegram update cannot become another action or account after a durable answer", async t => {
  const home = homeFor(t), original = request({ kind: "close", market: "BTC-PERP" });
  writePerpsBotRequest(home, original); let calls = 0;
  await drainPerpsBotRequests(home, () => true, async () => { calls++; return "recorded"; });
  for (const replay of [request(), request({ expectedAccount: "0x2222222222222222222222222222222222222222" })]) {
    assert.equal(writePerpsBotRequest(home, replay), perpsBotRequestKey(original));
    assert.equal(existsSync(pending(home, replay)), false);
  }
  await drainPerpsBotRequests(home, () => true, async () => { calls++; return "never"; }); assert.equal(calls, 1);
});
