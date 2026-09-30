import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * THE OWNER SEES THEIR OWN DOLLARS ON THEIR OWN PROFILE, AND NOBODY ELSE DOES.
 *
 * The spec's rule for a profile's money is "the book is public OR it is the
 * owner's own view". The public route takes no session, so it withheld a
 * private book's sizes from everyone, the owner included. This route is the
 * owner's view: hosted only, keyed on the session's tenant and never on
 * anything the request says, and the public route stays exactly as private as
 * it was. Driven end to end against a real ledger, a real identity store and a
 * real session cookie.
 */
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123" as const;
const saved = {
  home: process.env.MERRYMEN_HOME,
  hosted: process.env.MERRYMEN_HOSTED,
  secret: process.env.MERRYMEN_SESSION_SECRET,
  database: process.env.DATABASE_URL,
};
let dir: string;
let slug: string;
let OWN: (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
let PUBLIC: (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
let mintSession: (a: `0x${string}`) => string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mm-own-book-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  const identity = await import("@merrymen/identity-store");
  identity.resetIdentityStoreForTest();
  (await import("@merrymen/settings-store")).resetSettingsStoreForTest();
  slug = (await identity.getIdentityStore().ensure(A, ACCOUNT)).slug;
  ({ mintSession } = await import("@/lib/auth"));
  ({ GET: OWN } = await import("./route"));
  ({ GET: PUBLIC } = await import("../route"));

  // The ledger the worker writes, with one private round trip on it.
  const { wrapSqlite } = await import("../../../../../../../worker/src/db");
  const { applyLedgerSchema } = await import("../../../../../../../worker/src/store");
  const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
  try {
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    await db.prepare(
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch)
       VALUES (?, 'Shogun', '0x1', '0x2', 4663, '{}', 0, 0, 'live', 1)`,
    ).run(ACCOUNT);
    const fill = db.prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, realized_pnl_usdg, basis_source)
       VALUES (?, 'swap', 'x', ?, ?, ?, ?, 'landed', ?, 1, ?, 'CASH', '1', ?, ?, 'receipt')`,
    );
    // The executor writes both token legs on every fill.
    await fill.run(ACCOUNT, "0xusdg", "0xcash", 10, "0xop1", 1_000, "buy", 10, null);
    await fill.run(ACCOUNT, "0xcash", "0xusdg", 13, "0xop2", 2_000, "sell", 13, 3);
  } finally {
    raw.close();
  }
});
after(async () => {
  for (const [key, value] of [
    ["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted],
    ["MERRYMEN_SESSION_SECRET", saved.secret], ["DATABASE_URL", saved.database],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  (await import("@merrymen/identity-store")).resetIdentityStoreForTest();
  (await import("@merrymen/settings-store")).resetSettingsStoreForTest();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const request = (tenant: `0x${string}` | null, url = `https://app.example.test/api/agents/${slug}/own`) =>
  new Request(url, { headers: tenant ? { cookie: `mm_session=${mintSession(tenant)}` } : {} });
const ctx = (s = slug) => ({ params: Promise.resolve({ slug: s }) });

it("the owner's session gets its own sizes and dollars, never cached for anyone else", async () => {
  const res = await OWN(request(A), ctx());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") ?? "", /private/);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  const body = (await res.json()) as { recentTrades: { action: string; sizeUsdg: number | null; realizedPnlUsdg: number | null }[]; topTrades: { realizedPnlUsdg: number | null }[] };
  assert.deepEqual(body.recentTrades.map((t) => [t.action, t.sizeUsdg, t.realizedPnlUsdg]), [["sell", 13, 3], ["buy", 10, null]]);
  assert.deepEqual(body.topTrades.map((t) => t.realizedPnlUsdg), [3]);
});

it("no session, or somebody else's, gets the same 404 as no agent at all — and the ledger is not what decides", async () => {
  // Anyone but the owner is told nothing, not even that an owner's view exists
  // here: signed out, a stranger, a forged tenant and an unknown slug all get
  // one answer, private and uncached, so none can be told from the others.
  const answers = [
    await OWN(request(null), ctx()),
    await OWN(request(B), ctx()),
    // A query string naming the owner changes nothing: only the cookie is read.
    await OWN(request(B, `https://app.example.test/api/agents/${slug}/own?tenant=${A}`), ctx()),
    await OWN(request(A), ctx("no-such-agent")),
    await OWN(request(null), ctx("no-such-agent")),
  ];
  const seen = [];
  for (const res of answers) {
    assert.match(res.headers.get("cache-control") ?? "", /private/);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    seen.push([res.status, await res.text()]);
  }
  assert.deepEqual(seen.map(([status]) => status), [404, 404, 404, 404, 404]);
  assert.equal(new Set(seen.map(([, body]) => body)).size, 1, "one body for all of them");
  assert.doesNotMatch(String(seen[1]![1]), /recentTrades|topTrades/);
  assert.equal((await OWN(request(A), ctx("../etc"))).status, 400);
});

it("the public route is not widened: the owner's own cookie gets the private view there", async () => {
  const res = await PUBLIC(request(A, `https://app.example.test/api/agents/${slug}`), ctx());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { publicBook: boolean; recentTrades: { sizeUsdg: number | null; realizedPnlUsdg: number | null }[] };
  assert.equal(body.publicBook, false);
  assert.equal(body.recentTrades.length, 2);
  assert.ok(body.recentTrades.every((t) => t.sizeUsdg === null && t.realizedPnlUsdg === null));
});

it("self-hosted has no sessions to check, so there is no owner's view to serve", async () => {
  delete process.env.MERRYMEN_HOSTED;
  try {
    const res = await OWN(request(null), ctx());
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { recentTrades?: unknown }).recentTrades, undefined);
  } finally {
    process.env.MERRYMEN_HOSTED = "1";
  }
});
