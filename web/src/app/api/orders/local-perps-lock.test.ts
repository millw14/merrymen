import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { withLocalStateLock } from "../../../../../worker/src/local-state-lock";
import { openCommands } from "../../../../../worker/src/command-files";
import { createLocalPerpsPort } from "../../../../../worker/src/perps/telegram-local";
import { tokenTagOf } from "../../../../../worker/src/telegram/state";
const ACCOUNT = "0x1111111111111111111111111111111111111111", OWNER = "0x2222222222222222222222222222222222222222", OTHER = "0x3333333333333333333333333333333333333333";
const env = { ...process.env }, home = mkdtempSync(path.join(tmpdir(), "mm-http-bot-lock-")), perpsHome = path.join(home, "accounts", "perps");
let POST: typeof import("./route").POST;
const grant = { purpose: "perps", smartAccount: ACCOUNT, owner: OWNER, chainId: 4663, expiresAt: Math.floor(Date.now() / 1000) + 1000 };
const post = () => POST(new Request("http://localhost/api/orders?wallet=perps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedAccount: ACCOUNT, purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper" }) }));
before(async () => {
  process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_PERPS = "paper"; delete process.env.MERRYMEN_HOSTED; delete process.env.DATABASE_URL; delete process.env.MERRYMEN_GRANT_FILE; delete process.env.MERRYMEN_SETTINGS_FILE;
  mkdirSync(perpsHome, { recursive: true }); writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify(grant));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramEnabled: true, telegramBotToken: "123:test-secret", telegramAllowlist: [42] }));
  writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ botId: "123", tokenTag: tokenTagOf("123:test-secret"), ownerId: 42, linkedChatAt: { "42": Math.floor(Date.now() / 1000) - 10 } }));
  const raw = new DatabaseSync(path.join(perpsHome, "merrymen.db")); raw.exec("CREATE TABLE agents(smart_account TEXT PRIMARY KEY,owner_address TEXT,chain_id INTEGER,mode TEXT,perps TEXT)"); raw.prepare("INSERT INTO agents VALUES(?,?,?,'paper',NULL)").run(ACCOUNT, OWNER, 4663); raw.close();
  ({ POST } = await import("./route"));
});
after(() => { for (const key of ["MERRYMEN_HOME", "MERRYMEN_PERPS", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_GRANT_FILE", "MERRYMEN_SETTINGS_FILE"]) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } rmSync(home, { recursive: true, force: true }); });

test("HTTP re-resolves Perps identity after waiting for the shared writer lock", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writer = withLocalStateLock(home, async () => { entered(); await gate; writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify({ ...grant, smartAccount: OTHER })); });
  await ready; let finished = false;
  const posting = post().then(response => { finished = true; return response; });
  try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(finished, false); }
  finally { release(); await writer; }
  const response = await posting; assert.equal(response.status, 409); assert.equal((await response.json()).code, "account-changed"); assert.equal(openCommands(perpsHome).length, 0);
});

test("HTTP and Telegram racing for the same Perps book admit exactly one command", async () => {
  writeFileSync(path.join(perpsHome, "grant.json"), JSON.stringify(grant));
  const [http, bot] = await Promise.all([post(), createLocalPerpsPort(home).exit({ action: "flatten", expectedAccount: ACCOUNT, requestId: "tg-perps-123-1", askedAtSec: Math.floor(Date.now() / 1000) })]);
  assert.equal(Number(http.status === 200) + Number(/^Your paper Perps exit was queued/.test(bot)), 1);
  assert.equal(openCommands(perpsHome).length, 1);
});
