/**
 * The notification pass against an in-memory ledger: dedupe that survives a
 * lost cursor and a second replica, retry with backoff and a dead letter,
 * Telegram's 429 retry_after, the owner's own switches (never overridden),
 * authority resolved from the identity tables rather than the row, paper and
 * live kept apart, and price alerts only where a Chainlink feed exists.
 *
 * Every send goes to a recording fake and global fetch is replaced with one
 * that fails the test, so nothing here can reach Telegram or a chain.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getAddress, type PublicClient } from "viem";
import { wrapSqlite, type Db } from "../db";
import { applyLedgerSchema } from "../store";
import { TELEGRAM_STATE_DDL } from "../telegram-store";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";
import { ensureMcpSchema } from "./schema";
import {
  ALERT_WINDOW_SEC, MAX_ATTEMPTS, QUEUE_MAX_AGE_SEC, RETRY_BACKOFF_SEC, canonicalParams, chainlinkPriceReader, hostedRecipient, normalizeNotifyParams,
  plain, runNotifyPass, sendErrorCode, staleAfterSec, summaryPeriod, telegramSend, vouchedSells, type FeedClient, type NotifyDeps, type NotifyParams,
  type NotifyRecipient, type PriceReading, type SendResult,
} from "./notify";

const NOW = 1_800_000_000; // 2027-01-15 08:00 UTC, a Friday
const OWNER_A = "0x00000000000000000000000000000000000000aa";
const OWNER_B = "0x00000000000000000000000000000000000000bb";
const ACCOUNT_A = "0x000000000000000000000000000000000000a001";
const ACCOUNT_B = "0x000000000000000000000000000000000000b001";
const SLUG_A = "aaaaaaaaaaaaaaaa";
const SLUG_B = "bbbbbbbbbbbbbbbb";
const TOKEN = "123456:SECRET-BOT-TOKEN";
const CHAT = 777_000_111;
const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!;
const NO_FEED = STOCK_TOKENS.find((t) => t.chainlinkFeed === null)!;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

// ── no network, ever ───────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];
before(() => {
  globalThis.fetch = (async (url: unknown) => {
    fetchCalls.push(String(url).replace(/bot[^/]+/, "bot<redacted>"));
    throw new Error("network is not allowed in these tests");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(fetchCalls, [], "a test reached the network");
});

// ── fixtures ───────────────────────────────────────────────────────────────

interface Fixture {
  raw: DatabaseSync;
  db: Db;
  clock: { t: number };
  calls: Array<{ token: string; chatId: number; text: string }>;
  logs: string[];
  deps: NotifyDeps;
  sub(kind: string, params?: NotifyParams, o?: { tenant?: string; slug?: string | null; createdAt?: number; status?: string }): string;
  deliveries(): Array<{ id: string; subscription_id: string; status: string; attempts: number; next_attempt_at: number; last_error_code: string | null; payload_json: string; dedupe_key: string; sent_at: number | null }>;
  pass(over?: Partial<NotifyDeps>): ReturnType<typeof runNotifyPass>;
  advance(sec: number): void;
}

let subSeq = 0;
let connSeq = 0;

function connect(raw: DatabaseSync, tenant: string, o: { scopes?: string; status?: string } = {}): string {
  const id = `mcpcon_${++connSeq}`;
  raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, client_name, client_host, kind, scopes, agent_slugs, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Test', 'test', 'oauth', ?, '[]', ?, 1, 1)`)
    .run(id, tenant, `client_${connSeq}`, o.scopes ?? "agents:read notifications:manage", o.status ?? "active");
  return id;
}

async function setup(o: {
  recipients?: Record<string, NotifyRecipient | null>;
  send?: (n: number, text: string) => SendResult;
  price?: (token: `0x${string}`) => Promise<PriceReading | null>;
} = {}): Promise<Fixture> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await ensureMcpSchema(db, "sqlite");
  await db.exec(TELEGRAM_STATE_DDL);
  raw.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json TEXT NOT NULL, sealed_session_key TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  raw.exec("CREATE TABLE agent_identity (tenant TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, accounts TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  for (const [tenant, slug, account, name] of [[OWNER_A, SLUG_A, ACCOUNT_A, "Shogun"], [OWNER_B, SLUG_B, ACCOUNT_B, "SirSendIt"]] as const) {
    raw.prepare("INSERT INTO agent_identity (tenant, slug, accounts, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(tenant, slug, JSON.stringify([account]));
    // The grant stores the account checksummed, as the web does.
    raw.prepare("INSERT INTO grants (tenant, chain_id, grant_json, sealed_session_key, updated_at) VALUES (?, 4663, ?, 'sealed', 1)")
      .run(tenant, JSON.stringify({ smartAccount: getAddress(account), sessionKey: "never-read" }));
    raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
      VALUES (?, ?, ?, '0x1', 4663, '{}', 1700000000, 4102444800, 'armed', 'live', ?, 1)`).run(account, name, tenant, NOW - 30);
    // A connected app allowed to manage alerts: without one nothing is evaluated.
    connect(raw, tenant);
  }
  const clock = { t: NOW };
  const calls: Fixture["calls"] = [];
  const logs: string[] = [];
  const recipients = o.recipients ?? {
    [OWNER_A]: { botToken: TOKEN, chatId: CHAT, enabled: true },
    [OWNER_B]: { botToken: TOKEN, chatId: CHAT + 1, enabled: true },
  };
  const deps: NotifyDeps = {
    now: () => clock.t,
    async send(token, chatId, text) {
      calls.push({ token, chatId, text });
      return o.send ? o.send(calls.length, text) : { ok: true };
    },
    async recipient(tenant) {
      return recipients[tenant] ?? null;
    },
    tickSeconds: async () => 60,
    ...(o.price ? { price: o.price } : {}),
    log: (line) => logs.push(line),
  };
  return {
    raw, db, clock, calls, logs, deps,
    sub(kind, params = {}, s = {}) {
      const id = `nsub_${(++subSeq).toString(16).padStart(32, "0")}`;
      raw.prepare(`INSERT INTO notify_subscriptions (id, tenant, agent_slug, channel, kind, params_json, status, connection_id, cursor_json, created_at, updated_at, last_evaluated_at)
        VALUES (?, ?, ?, 'telegram', ?, ?, ?, 'conn', NULL, ?, ?, NULL)`)
        .run(id, s.tenant ?? OWNER_A, s.slug === undefined ? SLUG_A : s.slug, kind, canonicalParams(params), s.status ?? "active", s.createdAt ?? NOW - 3600, s.createdAt ?? NOW - 3600);
      return id;
    },
    deliveries() {
      return raw.prepare("SELECT * FROM notify_deliveries ORDER BY created_at, id").all() as ReturnType<Fixture["deliveries"]>;
    },
    pass(over = {}) {
      return runNotifyPass(db, { ...deps, ...over });
    },
    advance(sec) {
      clock.t += sec;
    },
  };
}

function trade(f: Fixture, o: {
  account?: string; status?: string; tx?: string | null; at?: number; side?: string | null; symbol?: string; cash?: number;
  op?: string | null; kind?: string;
  /** The order size; defaults to `cash`. */
  amount?: number;
  /** fill_cash_usdg; null for a row with no filled amount. Defaults to `cash`. */
  fill?: number | null;
  /** basis_source; defaults to 'receipt' ('paper' for a paper fill). */
  basis?: string | null;
  qty?: string | null; buyToken?: string | null; sellToken?: string | null; pnl?: number | null; decision?: string | null;
}): number {
  const status = o.status ?? "landed";
  const r = f.raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, fill_side, fill_symbol, fill_cash_usdg,
      basis_source, fill_qty_raw, buy_token, sell_token, realized_pnl_usdg, decision_id, created_at)
    VALUES (?, ?, '0x1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.account ?? ACCOUNT_A, o.kind ?? "swap", o.amount ?? o.cash ?? 10, o.op ?? null, o.tx ?? null, status, o.side === undefined ? "buy" : o.side,
      o.symbol ?? "NVDA", o.fill === undefined ? o.cash ?? 10 : o.fill, o.basis === undefined ? (status === "paper" ? "paper" : "receipt") : o.basis,
      o.qty ?? null, o.buyToken ?? null, o.sellToken ?? null, o.pnl ?? null, o.decision ?? null, o.at ?? NOW - 60);
  return Number(r.lastInsertRowid);
}

function event(f: Fixture, level: string, message: string, at: number, account = ACCOUNT_A): void {
  f.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, ?, ?, ?)").run(account, level, message, at);
}

function equity(f: Fixture, mode: string, value: number, at: number, account = ACCOUNT_A): void {
  f.raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, mode, epoch) VALUES (?, '0', ?, 0, ?, ?, ?, 1)").run(account, value, value, at, mode);
}

const texts = (f: Fixture) => f.deliveries().map((d) => (JSON.parse(d.payload_json) as { text: string }).text);
const utcOf = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// ── dedupe ─────────────────────────────────────────────────────────────────

test("trade_confirmed: evaluating twice queues one message, and a lost cursor cannot queue it again", async () => {
  const f = await setup();
  f.sub("trade_confirmed");
  // Stored checksummed: the pass must find the account however the ledger spelled it.
  trade(f, { account: getAddress(ACCOUNT_A), tx: tx(1), side: "buy", symbol: "NVDA", cash: 12.5 });
  trade(f, { status: "paper", tx: null });
  const first = await f.pass();
  assert.equal(first.queued, 1);
  assert.equal(first.sent, 1);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.text, /LIVE/);
  assert.match(f.calls[0]!.text, /Bought NVDA for 12\.50 USDG/);
  assert.ok(f.calls[0]!.text.includes(tx(1)));

  f.advance(61);
  assert.equal((await f.pass()).queued, 0);
  // A redeploy that lost the cursor re-reads the same ledger rows: the dedupe key holds.
  f.raw.prepare("UPDATE notify_subscriptions SET cursor_json = NULL").run();
  f.advance(61);
  assert.equal((await f.pass()).queued, 0);
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.calls.length, 1);
});

test("two replicas running the same pass at once evaluate each subscription once and send once", async () => {
  const f = await setup();
  f.sub("trade_confirmed");
  trade(f, { tx: tx(2) });
  const [a, b] = await Promise.all([f.pass(), f.pass()]);
  assert.equal(a.evaluated + b.evaluated, 1);
  assert.equal(a.queued + b.queued, 1);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(f.calls.length, 1);
});

test("a trade still in flight is re-checked and sent once it lands, exactly once", async () => {
  const f = await setup();
  f.sub("trade_confirmed");
  const id = trade(f, { status: "submitted", tx: null });
  await f.pass();
  assert.equal(f.deliveries().length, 0);
  const cursor = JSON.parse(String((f.raw.prepare("SELECT cursor_json FROM notify_subscriptions").get() as { cursor_json: string }).cursor_json)) as { p: number[] };
  assert.deepEqual(cursor.p, [id]);
  f.raw.prepare("UPDATE trades SET status = 'landed', tx_hash = ? WHERE id = ?").run(tx(3), id);
  f.advance(61);
  await f.pass();
  f.advance(61);
  await f.pass();
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.calls.length, 1);
});

// ── retry, backoff, dead letter, 429 ───────────────────────────────────────

test("a failing sender is retried after 60 s, 5 min, 30 min, 2 h, then dead-lettered after 5 attempts", async () => {
  const f = await setup({ send: () => ({ ok: false, reason: "HTTP 502" }) });
  f.sub("trade_confirmed");
  trade(f, { tx: tx(4) });
  await f.pass();
  let d = f.deliveries()[0]!;
  assert.equal(d.status, "retry");
  assert.equal(d.attempts, 1);
  assert.equal(d.next_attempt_at, f.clock.t + RETRY_BACKOFF_SEC[0]);
  assert.equal(d.last_error_code, "network");

  // Not before it is due.
  f.advance(RETRY_BACKOFF_SEC[0] - 1);
  await f.pass();
  assert.equal(f.calls.length, 1);

  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    f.clock.t = f.deliveries()[0]!.next_attempt_at;
    await f.pass();
    d = f.deliveries()[0]!;
    assert.equal(d.attempts, attempt);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(d.status, "retry");
      assert.equal(d.next_attempt_at, f.clock.t + RETRY_BACKOFF_SEC[attempt - 1]!);
    }
  }
  assert.equal(d.status, "dead");
  assert.equal(d.last_error_code, "network");
  assert.equal(f.calls.length, MAX_ATTEMPTS);
  f.advance(86_400);
  await f.pass();
  assert.equal(f.calls.length, MAX_ATTEMPTS, "a dead letter is never sent again");
});

test("429: retry_after is honoured for that message and pauses the owner's other queued messages", async () => {
  const f = await setup({ send: (n) => (n === 1 ? { ok: false, reason: "Too Many Requests: retry after 900", retryAfterSec: 900 } : { ok: true }) });
  f.sub("trade_confirmed");
  trade(f, { tx: tx(5) });
  trade(f, { tx: tx(6) });
  const out = await f.pass();
  assert.equal(f.calls.length, 1, "the second message waits in the same pass");
  assert.ok(out.deferred >= 1);
  // Both were queued in the same second: tell them apart by which one was tried.
  const a = f.deliveries().find((d) => d.attempts === 1);
  const b = f.deliveries().find((d) => d.attempts === 0);
  assert.equal(a!.status, "retry");
  assert.equal(a!.last_error_code, "rate_limited");
  assert.equal(a!.next_attempt_at, NOW + 900);
  assert.equal(b!.status, "pending");
  assert.equal(b!.next_attempt_at, NOW + 900, "the whole queue waits out the bot's limit");

  f.advance(300);
  await f.pass();
  assert.equal(f.calls.length, 1, "nothing is sent inside retry_after");
  f.clock.t = NOW + 900;
  await f.pass();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.deliveries().map((d) => d.status), ["sent", "sent"]);
});

// ── the owner's switches ───────────────────────────────────────────────────

test("hosted recipient: unlinked or switched-off owners are skipped and the pass never calls send for them", async () => {
  const OWNER_C = "0x00000000000000000000000000000000000000cc";
  const OWNER_D = "0x00000000000000000000000000000000000000dd";
  const OWNER_E = "0x00000000000000000000000000000000000000ee";
  const f = await setup();
  // A: linked, Telegram on, alerts off. B: never linked. C: linked once, then unlinked.
  // D: linked, Telegram never switched on (it defaults off). E: linked, on, but no bot token.
  f.raw.prepare("INSERT INTO tenant_telegram (tenant, link_code, owner_id, linked_at, updated_at) VALUES (?, 'code', ?, 1, 1)").run(OWNER_A, CHAT);
  f.raw.prepare("INSERT INTO tenant_telegram (tenant, link_code, owner_id, linked_at, updated_at) VALUES (?, 'code', NULL, 1, 1)").run(OWNER_C);
  f.raw.prepare("INSERT INTO tenant_telegram (tenant, link_code, owner_id, linked_at, updated_at) VALUES (?, 'code', ?, 1, 1)").run(OWNER_D, CHAT + 3);
  f.raw.prepare("INSERT INTO tenant_telegram (tenant, link_code, owner_id, linked_at, updated_at) VALUES (?, 'code', ?, 1, 1)").run(OWNER_E, CHAT + 4);
  const settings: Record<string, Record<string, unknown>> = {
    [OWNER_A]: { telegramEnabled: true, telegramNotifyEnabled: false, telegramBotToken: TOKEN },
    [OWNER_B]: { telegramEnabled: true, telegramBotToken: TOKEN },
    [OWNER_C]: { telegramEnabled: true, telegramBotToken: TOKEN },
    [OWNER_D]: { telegramBotToken: TOKEN },
    [OWNER_E]: { telegramEnabled: true },
  };
  const recipient = hostedRecipient(f.db, { async get(t) { return settings[t] ?? null; } });
  const subs: Record<string, string> = {};
  for (const owner of [OWNER_A, OWNER_B, OWNER_C, OWNER_D, OWNER_E]) {
    subs[owner] = f.sub("provider_failure", {}, { tenant: owner });
    f.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, payload_json, created_at)
      VALUES (?, ?, ?, ?, 'provider_failure', 'telegram', 'pending', 0, ?, ?, ?)`).run(`ndl_${owner}`, subs[owner], owner, `k:${owner}`, NOW, JSON.stringify({ v: 1, text: "hello" }), NOW);
  }
  const out = await f.pass({ recipient });
  assert.equal(f.calls.length, 0, "no send for an owner who is unlinked or switched off");
  assert.equal(out.skipped, 5);
  const by = Object.fromEntries(f.deliveries().map((d) => [d.subscription_id, d]));
  assert.equal(by[subs[OWNER_A]!]!.last_error_code, "owner_disabled");
  assert.equal(by[subs[OWNER_B]!]!.last_error_code, "no_linked_telegram");
  assert.equal(by[subs[OWNER_C]!]!.last_error_code, "no_linked_telegram");
  assert.equal(by[subs[OWNER_D]!]!.last_error_code, "owner_disabled");
  assert.equal(by[subs[OWNER_E]!]!.last_error_code, "no_linked_telegram");
  for (const d of f.deliveries()) assert.equal(d.status, "skipped");
});

test("a recipient lookup that fails is an outage: the message waits, it is not skipped or sent", async () => {
  const f = await setup();
  f.sub("trade_confirmed");
  trade(f, { tx: tx(7) });
  const out = await f.pass({ recipient: async () => { throw new Error("settings store down"); } });
  assert.equal(out.deferred, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.deliveries()[0]!.status, "pending");
  assert.ok(out.warnings.includes("recipient_unavailable"));
});

test("a queued message of a removed subscription is skipped, never sent", async () => {
  const f = await setup();
  const id = f.sub("trade_confirmed", {}, { status: "deleted" });
  f.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, payload_json, created_at)
    VALUES ('ndl_x', ?, ?, 'k1', 'trade_confirmed', 'telegram', 'pending', 0, ?, '{"text":"x"}', ?)`).run(id, OWNER_A, NOW, NOW);
  await f.pass();
  assert.equal(f.calls.length, 0);
  assert.equal(f.deliveries()[0]!.last_error_code, "unsubscribed");
});

test("a message claimed by a sender that died is written off as interrupted, never sent twice", async () => {
  const f = await setup();
  const id = f.sub("trade_confirmed");
  f.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, payload_json, created_at)
    VALUES ('ndl_y', ?, ?, 'k2', 'trade_confirmed', 'telegram', 'sending', 1, ?, '{"text":"x"}', ?)`).run(id, OWNER_A, NOW - 1, NOW - 700);
  const out = await f.pass();
  assert.equal(out.interrupted, 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual([f.deliveries()[0]!.status, f.deliveries()[0]!.last_error_code], ["dead", "interrupted"]);
});

// ── authority ──────────────────────────────────────────────────────────────

test("authority comes from the identity tables: a row naming another owner's agent, or tampered params, sends nothing", async () => {
  const f = await setup();
  f.sub("trade_confirmed", {}, { tenant: OWNER_A, slug: SLUG_B });
  f.sub("inactivity", { hours: 1 }, { tenant: OWNER_A });
  f.sub("trade_confirmed", {}, { tenant: OWNER_A, slug: null });
  trade(f, { account: ACCOUNT_B, tx: tx(8) });
  const out = await f.pass();
  assert.equal(out.unresolved, 1);
  assert.equal(out.invalid, 2);
  assert.equal(f.deliveries().length, 0);
  assert.equal(f.calls.length, 0);
});

test("no token or chat id reaches a log line, a stored row or an error code", async () => {
  const f = await setup({ send: () => ({ ok: false, reason: `request failed: https://api.telegram.org/bot${TOKEN}/sendMessage chat ${CHAT}` }) });
  f.sub("trade_confirmed");
  trade(f, { tx: tx(9) });
  await f.pass();
  assert.equal(f.calls[0]!.token, TOKEN, "the token reaches the sender and nothing else");
  const stored = JSON.stringify([
    f.raw.prepare("SELECT * FROM notify_deliveries").all(),
    f.raw.prepare("SELECT * FROM notify_subscriptions").all(),
  ]);
  for (const secret of [TOKEN, "SECRET", String(CHAT)]) {
    assert.ok(!stored.includes(secret), `stored rows contain ${secret}`);
    assert.ok(!f.logs.join("\n").includes(secret), `logs contain ${secret}`);
  }
  assert.equal(f.deliveries()[0]!.last_error_code, "network");
});

// ── kinds ──────────────────────────────────────────────────────────────────

test("risk_halt and provider_failure: a kill per event, a breaker or provider failure at most once per 6 h, event text never forwarded", async () => {
  const f = await setup();
  const windowStart = Math.floor(NOW / ALERT_WINDOW_SEC) * ALERT_WINDOW_SEC;
  f.sub("risk_halt", {}, { createdAt: windowStart - 100 });
  f.sub("provider_failure", {}, { createdAt: windowStart - 100 });
  event(f, "warn", "KILL SWITCH — grant discarded, session key destroyed; trading halted", windowStart + 10);
  for (const dt of [20, 260, 500]) event(f, "err", "on-chain drawdown breaker TRIPPED — trading halted at the wall", windowStart + dt);
  event(f, "warn", "the market could not be read this tick (3 read(s) failed) — nothing was traded.", windowStart + 30);
  event(f, "err", "brain unreachable: fetch https://brain.internal/?key=hunter2 failed", windowStart + 40);
  event(f, "err", "on-chain drawdown breaker TRIPPED — trading halted at the wall", windowStart + 50, ACCOUNT_B);
  event(f, "warn", "a warn that is neither", windowStart + 60);
  await f.pass();
  const t = texts(f);
  assert.equal(t.filter((x) => /Kill switch/.test(x)).length, 1);
  assert.equal(t.filter((x) => /Drawdown breaker tripped/.test(x)).length, 1);
  assert.equal(t.filter((x) => /could not be read|decision service/.test(x)).length, 1);
  assert.equal(t.length, 3);
  assert.ok(t.every((x) => /LIVE/.test(x)), "the book is labelled");
  assert.ok(!t.join("\n").includes("hunter2"), "raw event text is never forwarded");

  // Still tripped just past the clock window's edge, but under 6 h since the
  // last alert: quiet. A fixed window alone would have alerted again here.
  f.clock.t = windowStart + ALERT_WINDOW_SEC + 15;
  event(f, "err", "on-chain drawdown breaker TRIPPED — trading halted at the wall", windowStart + ALERT_WINDOW_SEC + 5);
  event(f, "warn", "the market could not be read this tick (1 read(s) failed) — nothing was traded.", windowStart + ALERT_WINDOW_SEC + 6);
  await f.pass();
  assert.equal(texts(f).filter((x) => /Drawdown breaker tripped/.test(x)).length, 1, "at most one breaker alert in 6 h");
  assert.equal(texts(f).filter((x) => /could not be read/.test(x)).length, 1, "at most one provider alert in 6 h");

  // Six hours after the last one: one more message, not one per tick.
  f.clock.t = windowStart + ALERT_WINDOW_SEC + 90;
  event(f, "err", "on-chain drawdown breaker TRIPPED — trading halted at the wall", windowStart + ALERT_WINDOW_SEC + 30);
  event(f, "err", "on-chain drawdown breaker TRIPPED — trading halted at the wall", windowStart + ALERT_WINDOW_SEC + 40);
  event(f, "warn", "the market could not be read this tick (1 read(s) failed) — nothing was traded.", windowStart + ALERT_WINDOW_SEC + 50);
  await f.pass();
  assert.equal(texts(f).filter((x) => /Drawdown breaker tripped/.test(x)).length, 2);
  assert.equal(texts(f).filter((x) => /could not be read/.test(x)).length, 2);
});

test("stale_data: a running agent with an old heartbeat alerts once per 6 h; killed or expired agents never do", async () => {
  const f = await setup();
  f.sub("stale_data");
  f.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW - staleAfterSec(60) - 1, ACCOUNT_A);
  await f.pass();
  assert.equal(f.deliveries().length, 1);
  assert.match(texts(f)[0]!, /No heartbeat for \d+ minutes/);
  f.advance(61);
  await f.pass();
  assert.equal(f.deliveries().length, 1, "once per window");

  f.raw.prepare("UPDATE agents SET status = 'killed' WHERE smart_account = ?").run(ACCOUNT_A);
  f.advance(ALERT_WINDOW_SEC);
  await f.pass();
  assert.equal(f.deliveries().length, 1, "a killed agent is silent by design");

  f.raw.prepare("UPDATE agents SET status = 'armed', expires_at = ? WHERE smart_account = ?").run(f.clock.t - 1, ACCOUNT_A);
  f.advance(ALERT_WINDOW_SEC);
  await f.pass();
  assert.equal(f.deliveries().length, 1, "an expired permission is silent by design");
});

test("stale_data: fresh heartbeats are quiet, and a missing tick reader is a warning, not an alert", async () => {
  const f = await setup();
  f.sub("stale_data");
  await f.pass();
  assert.equal(f.deliveries().length, 0);
  f.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW - 5000, ACCOUNT_A);
  f.advance(61);
  const out = await f.pass({ tickSeconds: undefined });
  assert.equal(f.deliveries().length, 0);
  assert.ok(out.warnings.includes("stale_data_not_evaluated:no_tick_reader"));
});

test("inactivity: one message per window of the requested hours without a live or paper fill", async () => {
  const f = await setup();
  f.sub("inactivity", { hours: 6 }, { createdAt: NOW - 7 * 3600 });
  await f.pass();
  assert.equal(f.deliveries().length, 1);
  assert.match(texts(f)[0]!, /No live or paper fill for 7 hours/);
  f.advance(3600);
  await f.pass();
  assert.equal(f.deliveries().length, 1);
  f.advance(6 * 3600);
  await f.pass();
  assert.equal(f.deliveries().length, 2);
  // A paper fill counts as activity.
  trade(f, { status: "paper", at: f.clock.t - 60 });
  f.advance(61);
  await f.pass();
  assert.equal(f.deliveries().length, 2);
});

test("summary: live and paper books are separate lines, each labelled, never summed", async () => {
  const f = await setup();
  const { start, end } = summaryPeriod("day", 0, NOW);
  f.sub("summary", { period: "day", hour_utc: 0 }, { createdAt: start - 3600 });
  equity(f, "live", 1000, start - 100);
  equity(f, "live", 1100, end - 100);
  equity(f, "paper", 5000, start - 50);
  equity(f, "paper", 4900, end - 50);
  trade(f, { tx: tx(10), op: "0xop1", at: start + 10 });
  trade(f, { tx: tx(11), op: "0xop2", at: start + 20 });
  for (const dt of [30, 40, 50]) trade(f, { status: "paper", at: start + dt });
  await f.pass();
  const [text] = texts(f);
  assert.ok(text, "one summary queued");
  assert.match(text!, /daily summary/);
  const lines = text!.split("\n");
  assert.ok(lines.includes(`LIVE: equity 1100.00 USDG as of ${utcOf(end - 100)} (1000.00 at the start, +100.00). 2 trades landed.`), text);
  assert.ok(lines.includes(`PAPER (practice, no real money): equity 4900.00 USDG as of ${utcOf(end - 50)} (5000.00 at the start, −100.00). 3 paper fills.`), text);
  assert.ok(!/6000/.test(text!), "the two books are never added together");
  assert.equal((JSON.parse(f.deliveries()[0]!.payload_json) as { book: string }).book, "separate");
  f.advance(61);
  await f.pass();
  assert.equal(f.deliveries().length, 1, "once per period");
});

test("summary: a paper-only agent gets no LIVE line, and the first summary waits for a whole period", async () => {
  const f = await setup();
  const { start, end } = summaryPeriod("day", 0, NOW);
  f.sub("summary", { period: "day", hour_utc: 0 }, { createdAt: end + 60 });
  equity(f, "paper", 1000, start + 10);
  equity(f, "paper", 1010, end - 10);
  await f.pass();
  assert.equal(f.deliveries().length, 0, "subscribed after the period ended: nothing until the next one");
  f.sub("summary", { period: "day", hour_utc: 0 }, { createdAt: start - 60 });
  f.advance(61);
  await f.pass();
  const [text] = texts(f);
  assert.match(text!, /^PAPER \(practice, no real money\): equity 1010\.00 USDG/m);
  assert.ok(!/LIVE/.test(text!));
});

// ── price alerts ───────────────────────────────────────────────────────────

test("watchlist_price is only for stock tokens with a Chainlink feed; everything else is unsupported at subscribe time", () => {
  const random = normalizeNotifyParams("watchlist_price", { token: "0x000000000000000000000000000000000000dead", above: 10 });
  assert.equal(random.ok, false);
  assert.equal(!random.ok && random.code, "unsupported");
  const noFeed = normalizeNotifyParams("watchlist_price", { token: NO_FEED.address, above: 10 });
  assert.equal(!noFeed.ok && noFeed.code, "unsupported");
  const ok = normalizeNotifyParams("watchlist_price", { token: NVDA.address, below: 90, above: 110 });
  assert.deepEqual(ok, { ok: true, params: { token: NVDA.address.toLowerCase(), above: 110, below: 90 } });
  assert.equal(normalizeNotifyParams("watchlist_price", { token: NVDA.address }).ok, false);
  assert.equal(normalizeNotifyParams("watchlist_price", { token: NVDA.address, above: 100, below: 100 }).ok, false);
  assert.equal(normalizeNotifyParams("watchlist_price", { token: NVDA.address, above: 100, hours: 6 }).ok, false);
  assert.equal(normalizeNotifyParams("inactivity", { hours: 5 }).ok, false);
  assert.equal(normalizeNotifyParams("inactivity", { hours: 169 }).ok, false);
  assert.equal(normalizeNotifyParams("summary", { period: "month", hour_utc: 1 }).ok, false);
  assert.equal(normalizeNotifyParams("trade_confirmed", { anything: 1 }).ok, false);
  assert.equal(normalizeNotifyParams("nope", {}).ok, false);
});

test("watchlist_price: a crossing alerts once, a price sitting on the line does not flap, and a failed read is never a crossing", async () => {
  let price: number | null = 90;
  let updatedAt = NOW;
  const f = await setup({ price: async () => (price === null ? null : { priceUsd: price, updatedAt }) });
  f.sub("watchlist_price", { token: NVDA.address.toLowerCase(), above: 100 }, { slug: null });
  const step = async (p: number | null, advance = 61) => {
    price = p;
    f.advance(advance);
    updatedAt = f.clock.t;
    await f.pass();
    return f.deliveries().length;
  };
  assert.equal(await step(90, 0), 0);
  assert.equal(await step(101), 1);
  assert.match(texts(f)[0]!, /NVDA is at or above 100 USD: now 101\.00 USD/);
  assert.equal(await step(102), 1);
  assert.equal(await step(99.8), 1, "inside the hysteresis band: still above");
  assert.equal(await step(null), 1, "no price, no alert");
  assert.equal(await step(95), 1);
  assert.equal(await step(101), 1, "re-crossing inside the cooldown is quiet");
  assert.equal(await step(95), 1);
  assert.equal(await step(101, 3700), 2);
  // A dead feed is not a price.
  assert.equal(await step(90), 2);
  updatedAt = 0;
  price = 150;
  f.advance(3700);
  await f.pass();
  assert.equal(f.deliveries().length, 2);
});

test("watchlist_price: one Chainlink read per token per pass, and a read that hangs is cut off rather than waited on", async () => {
  let reads = 0;
  const f = await setup({ price: async () => { reads += 1; return { priceUsd: 50, updatedAt: NOW }; } });
  f.sub("watchlist_price", { token: NVDA.address.toLowerCase(), above: 100 }, { slug: null });
  f.sub("watchlist_price", { token: NVDA.address.toLowerCase(), below: 10 }, { slug: null });
  await f.pass();
  assert.equal(reads, 1, "two subscriptions on one token share a read");

  f.advance(61);
  const started = Date.now();
  const out = await f.pass({ price: () => new Promise<never>(() => {}), priceTimeoutMs: 50 });
  assert.ok(Date.now() - started < 2000, "the pass did not wait on the hung read");
  assert.equal(out.error, null);
  assert.equal(out.evaluated, 2);
  assert.equal(f.deliveries().length, 0, "no price is never a crossing");
});

// ── more failure modes ─────────────────────────────────────────────────────

test("stale_data: a heartbeat still missing just after a 6-hour clock boundary does not alert twice", async () => {
  const f = await setup();
  const boundary = (Math.floor(NOW / ALERT_WINDOW_SEC) + 1) * ALERT_WINDOW_SEC;
  f.clock.t = boundary - 60;
  f.sub("stale_data", {}, { createdAt: boundary - 7200 });
  f.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(boundary - 3600, ACCOUNT_A);
  await f.pass();
  assert.equal(f.deliveries().length, 1);
  f.clock.t = boundary + 60;
  await f.pass();
  assert.equal(f.deliveries().length, 1, "two minutes later, across the boundary: still one");
  f.clock.t = boundary - 60 + ALERT_WINDOW_SEC;
  await f.pass();
  assert.equal(f.deliveries().length, 2, "six hours after the last one: the next");
});

test("nothing new is queued once the owner has no connected app allowed to manage alerts; reconnecting resumes them", async () => {
  const f = await setup();
  const id = f.sub("trade_confirmed");
  f.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, payload_json, created_at)
    VALUES ('ndl_q', ?, ?, 'k:q', 'trade_confirmed', 'telegram', 'pending', 0, ?, '{"text":"queued before"}', ?)`).run(id, OWNER_A, NOW, NOW);
  f.raw.prepare("UPDATE mcp_connections SET status = 'revoked' WHERE tenant = ?").run(OWNER_A);
  // Still connected, but not allowed to manage alerts — and a scope that merely contains the name.
  connect(f.raw, OWNER_A, { scopes: "agents:read portfolio:read" });
  connect(f.raw, OWNER_A, { scopes: "agents:read xnotifications:manage" });
  trade(f, { tx: tx(30) });
  const out = await f.pass();
  assert.equal(out.evaluated, 0, "not evaluated without a connection holding notifications:manage");
  assert.deepEqual(f.calls.map((c) => c.text), ["queued before"], "a message queued while connected still goes out");

  connect(f.raw, OWNER_A);
  f.advance(61);
  const back = await f.pass();
  assert.equal(back.queued, 1);
  assert.equal(f.calls.length, 2);
});

test("an owner whose chat cannot be read does not starve other owners' alerts", async () => {
  const f = await setup();
  const subA = f.sub("provider_failure", {}, { tenant: OWNER_A });
  const subB = f.sub("provider_failure", {}, { tenant: OWNER_B, slug: SLUG_B });
  const insert = f.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, payload_json, created_at)
    VALUES (?, ?, ?, ?, 'provider_failure', 'telegram', 'pending', 0, ?, '{"text":"x"}', ?)`);
  for (let i = 0; i < 60; i += 1) insert.run(`ndl_a${i}`, subA, OWNER_A, `k:a${i}`, NOW - 1000 + i, NOW - 1000 + i);
  insert.run("ndl_b", subB, OWNER_B, "k:b", NOW - 10, NOW - 10);
  const recipient = async (t: string): Promise<NotifyRecipient> => {
    if (t === OWNER_A) throw new Error("settings could not be unsealed");
    return { botToken: TOKEN, chatId: CHAT + 1, enabled: true };
  };
  await f.pass({ recipient });
  f.advance(15);
  await f.pass({ recipient });
  assert.deepEqual(f.calls.map((c) => c.chatId), [CHAT + 1], "B's alert went out while A's queue waits");
  const a = f.deliveries().filter((d) => d.subscription_id === subA);
  assert.equal(a.length, 60);
  assert.ok(a.every((d) => d.status === "pending" && d.attempts === 0), "A's messages wait, uncounted");
});

test("an evaluation overtaken by an unsubscribe, or by another pass that re-claimed the row, writes nothing", async () => {
  const f = await setup();
  f.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW - 5000, ACCOUNT_A);
  const id = f.sub("stale_data");
  // The owner unsubscribes while the pass is mid-evaluation (the tick read happens inside it).
  const out = await f.pass({
    tickSeconds: async () => { f.raw.prepare("UPDATE notify_subscriptions SET status = 'deleted' WHERE id = ?").run(id); return 60; },
  });
  assert.equal(f.deliveries().length, 0, "no message for a removed alert");
  assert.ok(out.warnings.includes("evaluation_superseded"));

  const id2 = f.sub("stale_data");
  f.advance(61);
  const out2 = await f.pass({
    tickSeconds: async () => { f.raw.prepare("UPDATE notify_subscriptions SET last_evaluated_at = ? WHERE id = ?").run(f.clock.t + 1, id2); return 60; },
  });
  assert.equal(f.deliveries().length, 0);
  assert.ok(out2.warnings.includes("evaluation_superseded"));
  const row = f.raw.prepare("SELECT cursor_json FROM notify_subscriptions WHERE id = ?").get(id2) as { cursor_json: string | null };
  assert.equal(row.cursor_json, null, "the overtaken pass did not write its cursor");
});

test("a message that could not be sent within a day is dropped as expired, never delivered late", async () => {
  const f = await setup();
  const id = f.sub("trade_confirmed");
  const insert = f.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, payload_json, created_at)
    VALUES (?, ?, ?, ?, 'trade_confirmed', 'telegram', ?, ?, ?, ?, ?)`);
  insert.run("ndl_old", id, OWNER_A, "k:old", "retry", 2, NOW - 10, '{"text":"old"}', NOW - QUEUE_MAX_AGE_SEC - 1);
  insert.run("ndl_new", id, OWNER_A, "k:new", "pending", 0, NOW - 10, '{"text":"new"}', NOW - 60);
  const out = await f.pass();
  assert.equal(out.expired, 1);
  assert.deepEqual(f.calls.map((c) => c.text), ["new"]);
  const old = f.deliveries().find((d) => d.id === "ndl_old")!;
  assert.deepEqual([old.status, old.last_error_code], ["dead", "expired"]);
});

test("trade_confirmed: a landed trade first seen more than a week late is history, not news", async () => {
  const f = await setup();
  f.sub("trade_confirmed", {}, { createdAt: NOW - 30 * 86_400 });
  trade(f, { tx: tx(20), at: NOW - 8 * 86_400 });
  trade(f, { tx: tx(21), at: NOW - 60 });
  await f.pass();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0]!.text.includes(tx(21)));
});

test("summary: only money moved between the two readings is said to be inside the change, and an epoch carry never is", async () => {
  const f = await setup();
  const { start, end } = summaryPeriod("day", 0, NOW);
  f.sub("summary", { period: "day", hour_utc: 0 }, { createdAt: start - 3600 });
  equity(f, "live", 1000, start - 100);
  equity(f, "live", 1300, end - 100);
  const flow = f.raw.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, source, at, epoch) VALUES (?, ?, ?, NULL, ?, ?, 1)");
  flow.run(ACCOUNT_A, "in", 999, "chain-log", start - 500); // before the opening reading: already inside it
  flow.run(ACCOUNT_A, "in", 777, "epoch-carry", start + 50); // an opening balance, not a deposit
  flow.run(ACCOUNT_A, "in", 200, "chain-log", start + 100);
  flow.run(ACCOUNT_A, "out", 50, "transfer-intent", start + 200);
  await f.pass();
  const [text] = texts(f);
  assert.ok(text!.split("\n").some((l) => l.startsWith(`LIVE: equity 1300.00 USDG as of ${utcOf(end - 100)} (1000.00 at the start, +300.00). Deposits 200.00 USDG and withdrawals 50.00 USDG are inside that change.`)), text);
});

// ── honest numbers ─────────────────────────────────────────────────────────

const CHUMP = "0x00000000000000000000000000000000000c0001";
const GOOD = "0x00000000000000000000000000000000000c0002";
const QUOTED = "0x00000000000000000000000000000000000c0003";

test("trade_confirmed: a realised P&L is stated only when its cost and proceeds were both read from receipts", async () => {
  const f = await setup();
  f.sub("trade_confirmed", {}, { createdAt: NOW - 3600 });
  // Before the subscription, so not announced — but in the cost the sells below realised against.
  trade(f, { side: "buy", symbol: "CHUMP", buyToken: CHUMP, qty: "10", cash: 10, basis: "quote", tx: tx(40), op: "0xb1", at: NOW - 7200 });
  trade(f, { side: "buy", symbol: "GOOD", buyToken: GOOD, qty: "10", cash: 10, tx: tx(41), op: "0xb2", at: NOW - 7100 });
  trade(f, { side: "buy", symbol: "QUOTED", buyToken: QUOTED, qty: "5", cash: 6, tx: tx(42), op: "0xb3", at: NOW - 7000 });
  // Receipt-read proceeds against a cost the quote booked: the P&L is an estimate.
  trade(f, { side: "sell", symbol: "CHUMP", sellToken: CHUMP, qty: "10", cash: 14, pnl: 4, tx: tx(43), op: "0xs1", at: NOW - 300 });
  // Both sides read from receipts: a measurement.
  trade(f, { side: "sell", symbol: "GOOD", sellToken: GOOD, qty: "10", cash: 13, pnl: 3, tx: tx(44), op: "0xs2", at: NOW - 290 });
  // Proceeds booked from the quote: an estimated cash leg and no P&L.
  trade(f, { side: "sell", symbol: "QUOTED", sellToken: QUOTED, qty: "5", cash: 7, pnl: 1, basis: "quote", tx: tx(45), op: "0xs3", at: NOW - 280 });
  // No filled amount at all: the order size, said to be one.
  trade(f, { side: "buy", symbol: "NVDA", fill: null, amount: 25, basis: null, tx: tx(46), op: "0xb4", at: NOW - 270 });
  // CHUMP went flat above, so the quote-booked cost is gone: a new receipt round trip is measured.
  trade(f, { side: "buy", symbol: "CHUMP", buyToken: CHUMP, qty: "10", cash: 10, tx: tx(47), op: "0xb5", at: NOW - 260 });
  trade(f, { side: "sell", symbol: "CHUMP", sellToken: CHUMP, qty: "10", cash: 12, pnl: 2, tx: tx(48), op: "0xs4", at: NOW - 250 });
  await f.pass();
  const byTx = (n: number) => f.calls.map((c) => c.text).find((t) => t.includes(tx(n)))!;
  assert.equal(f.calls.length, 6);

  assert.match(byTx(43), /Sold CHUMP for 14\.00 USDG\./);
  assert.doesNotMatch(byTx(43), /Realised P&L [+−]/, "a P&L against a quote-booked cost is not stated as a result");
  assert.match(byTx(43), /Realised P&L is not stated/);

  assert.match(byTx(44), /Sold GOOD for 13\.00 USDG\. Realised P&L \+3\.00 USDG\./);

  assert.match(byTx(45), /Sold QUOTED for about 7\.00 USDG \(estimated from the quote: the receipt could not be read\)\./);
  assert.doesNotMatch(byTx(45), /Realised P&L [+−]/);

  assert.match(byTx(46), /Bought NVDA \(order size 25\.00 USDG; the filled amount is not recorded\)\./);
  assert.doesNotMatch(byTx(46), /for 25\.00/, "an order size is never printed as what was paid");

  assert.match(byTx(48), /Sold CHUMP for 12\.00 USDG\. Realised P&L \+2\.00 USDG\./);
});

test("trade_confirmed: an account the ledger spells two ways vouches for no P&L (the replay would see half the tape)", async () => {
  const f = await setup();
  // An account whose checksummed spelling differs from its lowercase one.
  const MIXED = "0x000000000000000000000000000000000000abcd";
  assert.notEqual(getAddress(MIXED), MIXED);
  f.raw.prepare("UPDATE agent_identity SET accounts = ? WHERE tenant = ?").run(JSON.stringify([MIXED]), OWNER_A);
  f.raw.prepare("UPDATE grants SET grant_json = ? WHERE tenant = ?").run(JSON.stringify({ smartAccount: getAddress(MIXED), sessionKey: "never-read" }), OWNER_A);
  f.raw.prepare("UPDATE agents SET smart_account = ? WHERE smart_account = ?").run(MIXED, ACCOUNT_A);
  f.sub("trade_confirmed", {}, { createdAt: NOW - 3600 });
  trade(f, { account: MIXED, side: "buy", symbol: "GOOD", buyToken: GOOD, qty: "10", cash: 10, tx: tx(50), op: "0xb6", at: NOW - 7200 });
  trade(f, { account: MIXED, side: "sell", symbol: "GOOD", sellToken: GOOD, qty: "10", cash: 13, pnl: 3, tx: tx(51), op: "0xs5", at: NOW - 300 });
  await f.pass();
  assert.match(f.calls[0]!.text, /Sold GOOD for 13\.00 USDG\. Realised P&L \+3\.00 USDG\./, "one spelling: the replay reads the whole tape");

  // The same account's rows now also carry its checksummed spelling.
  trade(f, { account: getAddress(MIXED), side: "buy", symbol: "CHUMP", buyToken: CHUMP, qty: "10", cash: 10, tx: tx(52), op: "0xb7", at: NOW - 200 });
  trade(f, { account: MIXED, side: "sell", symbol: "CHUMP", sellToken: CHUMP, qty: "10", cash: 11, pnl: 1, tx: tx(53), op: "0xs6", at: NOW - 100 });
  f.advance(61);
  await f.pass();
  const sell = f.calls.map((c) => c.text).find((t) => t.includes(tx(53)))!;
  assert.match(sell, /Sold CHUMP for 11\.00 USDG\. Realised P&L is not stated/);
});

test("vouchedSells mirrors the web replay: it vouches for nothing it could not read whole", () => {
  // The same cases as web/src/lib/profile-trades.test.ts, against this copy of the rule.
  const fills = [
    { op: "b", side: "buy" as const, token: "0xm", qty: "10", source: "receipt" },
    { op: "s", side: "sell" as const, token: "0xm", qty: "10", source: "receipt" },
  ];
  assert.deepEqual([...vouchedSells(fills, true)], ["s"]);
  assert.deepEqual([...vouchedSells(fills, false)], [], "a truncated read cannot know what came before its first row");
  assert.deepEqual([...vouchedSells([{ ...fills[0]!, source: null }, fills[1]!], true)], [], "a cost of unknown provenance is not evidence");
  assert.deepEqual([...vouchedSells([{ ...fills[0]!, source: "paper" }, { ...fills[1]!, source: "paper" }], true)], ["s"], "a paper fill is exact");
  assert.deepEqual([...vouchedSells([{ op: "r", side: null, token: "0xm", qty: null, source: "quote" }, fills[1]!], true)], []);
  assert.deepEqual(
    [...vouchedSells([fills[0]!, { op: "s1", side: "sell", token: "0xm", qty: null, source: "quote" }, { ...fills[1]!, op: "s2", qty: "5" }], true)],
    ["s1", "s2"],
  );
  // Flat resets the basis: an estimate bought and fully sold is not under the next round trip.
  assert.deepEqual(
    [...vouchedSells([{ ...fills[0]!, op: "q", source: "quote" }, { ...fills[1]!, op: "s1" }, { ...fills[0]!, op: "b2" }, { ...fills[1]!, op: "s2" }], true)],
    ["s2"],
  );
});

test("inactivity: a transfer or vault move is not a fill, and a redeploy's copy of an old fill is that old fill", async () => {
  const f = await setup();
  f.sub("inactivity", { hours: 6 }, { createdAt: NOW - 30 * 3600 });
  const lastFill = NOW - 10 * 3600;
  trade(f, { side: "buy", op: "0xf1", decision: "d1", tx: tx(60), at: lastFill });
  // The owner moved money out an hour ago, and parked cash in the vault before that.
  trade(f, { kind: "transfer", side: null, fill: null, basis: null, tx: tx(61), at: NOW - 3600 });
  trade(f, { kind: "vault-deposit", side: null, fill: null, basis: null, op: "0xv1", decision: "d2", tx: tx(62), at: NOW - 2 * 3600 });
  // A redeploy re-recorded both as bare swaps stamped at the restart (the hash spelled differently).
  trade(f, { side: null, fill: null, basis: null, op: "0xV1", tx: tx(62), at: NOW - 1800 });
  trade(f, { side: null, fill: null, basis: null, op: "0xF1", tx: tx(60), at: NOW - 1200 });
  await f.pass();
  assert.equal(f.deliveries().length, 1, "ten hours without a fill is past the six asked for");
  assert.ok(texts(f)[0]!.includes(`No live or paper fill for 10 hours (you asked to hear after 6). The last fill was at ${utcOf(lastFill)}.`), texts(f)[0]);
});

test("summary: only fills are counted as trades, one per operation", async () => {
  const f = await setup();
  const { start, end } = summaryPeriod("day", 0, NOW);
  f.sub("summary", { period: "day", hour_utc: 0 }, { createdAt: start - 3600 });
  equity(f, "live", 1000, start - 100);
  equity(f, "live", 1000, end - 100);
  trade(f, { op: "0xa1", decision: "d1", tx: tx(70), at: start + 10 });
  trade(f, { op: "0xb1", decision: "d2", tx: tx(71), at: start + 20 });
  // A redeploy's copies: of a fill in the period, and of one from the day before.
  trade(f, { side: null, fill: null, basis: null, op: "0xA1", tx: tx(70), at: start + 500 });
  trade(f, { op: "0xc1", decision: "d3", tx: tx(72), at: start - 3600 });
  trade(f, { side: null, fill: null, basis: null, op: "0xC1", tx: tx(72), at: start + 510 });
  // Money moves, not trades.
  trade(f, { kind: "transfer", side: null, fill: null, basis: null, tx: tx(73), at: start + 40 });
  trade(f, { kind: "vault-deposit", side: null, fill: null, basis: null, op: "0xd1", tx: tx(74), at: start + 50 });
  await f.pass();
  assert.match(texts(f)[0]!, /^LIVE: .* 2 trades landed\.$/m);
});

test("summary: a valuation taken hours before the period ended is stated with its time, never as the close", async () => {
  const f = await setup();
  const { start, end } = summaryPeriod("day", 0, NOW);
  f.sub("summary", { period: "day", hour_utc: 0 }, { createdAt: start - 3600 });
  equity(f, "live", 100, start - 60);
  equity(f, "live", 120, start + 3600); // then the worker stopped valuing
  await f.pass();
  const [text] = texts(f);
  assert.ok(text!.split("\n").includes(
    `LIVE: last valued at ${utcOf(start + 3600)}, 23 hours before the period ended, and not since: equity then 120.00 USDG (100.00 at the start, +20.00 by then). 0 trades landed.`,
  ), text);
  assert.doesNotMatch(text!, /LIVE: equity 120\.00/);
  assert.equal(end - (start + 3600), 23 * 3600);
});

test("plain(): control, format and separator characters a stranger wrote never reach a message", async () => {
  const C = (...cps: number[]) => String.fromCodePoint(...cps);
  // C1 CSI and NEL, the Arabic letter mark, line and paragraph separators, a
  // bidi override and isolate, zero-width space, BOM, soft hyphen, DEL, ESC, tab, newline.
  const dirty = `abc${C(0x9b)}31mX${C(0x85)}Y${C(0x61c)}Z${C(0x2028)}W${C(0x2029)}V${C(0x202e)}U${C(0x2066)}T${C(0x200b)}S${C(0xfeff)}R${C(0xad)}Q${C(0x7f)}P${C(0x1b)}[0m${C(0x9)}O${C(0xa)}N`;
  assert.equal(plain(dirty, 100), "abc31mXYZ W VUTSRQP[0m O N");
  assert.equal(plain(C(0x200e, 0x2067), 10), null, "nothing printable is nothing");
  const cut = plain(C(0x1f600).repeat(20), 16)!;
  assert.equal(Array.from(cut).length, 17, "sixteen code points and the ellipsis");
  assert.doesNotMatch(cut, /\p{Cs}/u, "no half of a surrogate pair at the cut");

  const f = await setup();
  f.raw.prepare("UPDATE agents SET name = ? WHERE smart_account = ?").run(`Sho${C(0x202e)}gun${C(0x9b)}`, ACCOUNT_A);
  f.sub("trade_confirmed");
  trade(f, { symbol: `NV${C(0x85)}DA${C(0x2028)}`, tx: tx(80) });
  await f.pass();
  const text = f.calls[0]!.text;
  assert.match(text, /^Shogun · LIVE\nBought NVDA for 10\.00 USDG\./);
  assert.doesNotMatch(text.replace(/\n/g, ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

// ── adapters ───────────────────────────────────────────────────────────────

test("telegramSend: 429 retry_after is read from Telegram's description, and the plain text is HTML-escaped", async () => {
  const bodies: string[] = [];
  const reply = (status: number, body: unknown) => ({ ok: status === 200, status, async json() { return body; } });
  let next = reply(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 17", parameters: { retry_after: 17 } });
  const send = telegramSend({ fetchFn: async (_url, init) => { bodies.push(String(init?.body)); return next; } });
  assert.deepEqual(await send(TOKEN, CHAT, "x"), { ok: false, reason: "Too Many Requests: retry after 17", retryAfterSec: 17 });
  next = reply(200, { ok: true, result: { message_id: 1 } });
  assert.deepEqual(await send(TOKEN, CHAT, "a <b> & c"), { ok: true });
  assert.equal((JSON.parse(bodies[1]!) as { text: string }).text, "a &lt;b&gt; &amp; c");
});

// Compile-time only: the orchestrator's viem client can be handed to the reader as it is.
export function publicClientIsAFeedClient(c: PublicClient): FeedClient {
  return c;
}

test("chainlinkPriceReader: scales by the feed's decimals, and a failed or non-positive read is null, never a price", async () => {
  const fake = (answer: bigint, o: { throws?: boolean } = {}): FeedClient => ({
    async readContract({ address, functionName }) {
      assert.equal(address, NVDA.chainlinkFeed, "reads the token's own feed");
      if (o.throws) throw new Error("rpc down");
      return functionName === "decimals" ? 8 : [1n, answer, 0n, BigInt(NOW - 60), 1n];
    },
  });
  assert.deepEqual(await chainlinkPriceReader(fake(123_45000000n))(NVDA.address), { priceUsd: 123.45, updatedAt: NOW - 60 });
  assert.equal(await chainlinkPriceReader(fake(0n))(NVDA.address), null);
  assert.equal(await chainlinkPriceReader(fake(-5n))(NVDA.address), null);
  assert.equal(await chainlinkPriceReader(fake(1n, { throws: true }))(NVDA.address), null);
  assert.equal(await chainlinkPriceReader(fake(1n))(NO_FEED.address), null, "no feed, no read");
});

test("send errors map to stable codes; the raw reason is never stored", () => {
  assert.equal(sendErrorCode({ reason: "Too Many Requests: retry after 3" }), "rate_limited");
  assert.equal(sendErrorCode({ reason: "x", retryAfterSec: 3 }), "rate_limited");
  assert.equal(sendErrorCode({ reason: "Forbidden: bot was blocked by the user" }), "bot_blocked");
  assert.equal(sendErrorCode({ reason: "Bad Request: chat not found" }), "chat_not_found");
  assert.equal(sendErrorCode({ reason: "Unauthorized" }), "bot_token_rejected");
  assert.equal(sendErrorCode({ reason: "request failed: fetch failed" }), "network");
  assert.equal(sendErrorCode({ reason: "Bad Request: message is too long" }), "send_failed");
});

test("an exhausted time budget stops the pass with a warning, never an exception", async () => {
  const f = await setup();
  f.sub("trade_confirmed");
  trade(f, { tx: tx(12) });
  const out = await f.pass({ maxMs: -1 });
  assert.equal(out.error, null);
  assert.equal(out.evaluated, 0);
  assert.ok(out.warnings.includes("time_budget_reached:evaluate"));
  assert.equal(f.calls.length, 0);
});
