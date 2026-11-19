/**
 * A REMOVED AGENT'S HOME IS SAID WHEN IT IS CLEARED, NOT ON EVERY PASS.
 *
 * reconcile reaches a home whose grant is gone on every pass, for as long as
 * the home keeps its book (or its pending Telegram kill). The cleanup is
 * idempotent, so after the first pass nothing changes; on 2026-11-18 six such
 * homes still said "grant removed — … cleared" every ~17 s for ten hours and
 * filled the log window. Driven through the real reconcile(): the file-backed
 * grant store with no grant in it, and the worker replaced by a fake that is
 * never called.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, it } from "node:test";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-removed-home-log-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
delete process.env.MERRYMEN_ROLLOUT_NEW_TENANTS;
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 93).toString("base64");

const { childHome, reconcile, setKillConfirmForTest, setSpawnForTest } = await import("./orchestrator");

const spawns: string[] = [];
setSpawnForTest(() => { spawns.push("spawn"); throw new Error("no grant is stored, so nothing may spawn"); });
setKillConfirmForTest(async () => {});

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
after(() => {
  console.log = realLog;
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => { said.length = 0; });

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const COPIES = ["settings.json", "telegram.json", "telegram-held-groups.json", "heartbeat.json"];
const saying = (needle: string) => said.filter((l) => l.includes(needle));

/** A removed agent's home as a crash or a refused spawn leaves it: copies of its access beside whatever else it kept. */
function home(tenant: `0x${string}`): string {
  const dir = childHome(tenant);
  mkdirSync(path.join(dir, "soul"), { recursive: true });
  for (const name of COPIES) writeFileSync(path.join(dir, name), JSON.stringify({ fixture: name }));
  writeFileSync(path.join(dir, "soul", "OWNER.md"), "owner notes");
  return dir;
}

it("a retained book's home is said once when cleared, then not again until a pass clears something new", async () => {
  const tenant = address(0x5a1);
  const dir = home(tenant);
  const book = new DatabaseSync(path.join(dir, "merrymen.db"));
  book.exec("CREATE TABLE trades (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  book.prepare("INSERT INTO trades (id, note) VALUES (1, 'original accounting')").run();
  book.close();
  const line = `${tenant} grant removed — personal memory and cached access cleared; original accounting retained`;

  await reconcile();
  await reconcile();
  assert.equal(saying(line).length, 1, said.join("\n"));
  for (const name of COPIES) assert.equal(existsSync(path.join(dir, name)), false, `${name} is cleared`);
  assert.equal(existsSync(path.join(dir, "soul", "OWNER.md")), false, "personal memory is cleared");
  const kept = new DatabaseSync(path.join(dir, "merrymen.db"), { readOnly: true });
  try {
    assert.deepEqual(kept.prepare("SELECT id, note FROM trades").all().map((r) => ({ ...r })), [{ id: 1, note: "original accounting" }], "the book is retained untouched");
  } finally { kept.close(); }

  // The cleanup still runs every pass: a copy written since goes, and is said.
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ fixture: "written again" }));
  await reconcile();
  assert.equal(existsSync(path.join(dir, "settings.json")), false, "a copy written since is cleared on the next pass");
  assert.equal(saying(line).length, 2, said.join("\n"));
  await reconcile();
  assert.equal(saying(line).length, 2, said.join("\n"));
  assert.deepEqual(spawns, []);
});

it("a home kept for a pending Telegram kill is said once when cleared; the kill itself is still said every pass", async () => {
  const tenant = address(0x5a2);
  const dir = home(tenant);
  // Kill state that cannot be read: the latch fails closed, the kill stays
  // pending, and the home must stay for the pass that can read it.
  mkdirSync(path.join(dir, "kill-request-unreadable.superseded.json"));
  const line = `${tenant} grant removed — personal memory and cached access cleared; the home is kept while its Telegram kill is pending`;

  await reconcile();
  await reconcile();
  assert.equal(saying(line).length, 1, said.join("\n"));
  assert.equal(saying(`${tenant}: Telegram kill pending, not carried out yet`).length >= 2, true, said.join("\n"));
  assert.equal(existsSync(dir), true, "the home and its pending request stay");
  for (const name of COPIES) assert.equal(existsSync(path.join(dir, name)), false, `${name} is cleared`);
  assert.deepEqual(spawns, []);
});
