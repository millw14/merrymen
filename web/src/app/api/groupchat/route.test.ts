/**
 * THE ROOM'S HTTP DOOR, DRIVEN THROUGH ITS REAL HANDLERS.
 *
 * Every request below is a real Request into the exported GET/POST/DELETE,
 * with a real session cookie, the real file-backed grant and identity stores
 * under a temporary home, and the store's real SQL on an in-memory sqlite
 * through the ledger's own driver (room.ts's seam). What is NOT covered here is
 * the Postgres dialect of that SQL. The one statement this route adds on top
 * of the store (the per-owner advisory lock) is Postgres-only: it is skipped on
 * sqlite, and driven here by a seam that claims Postgres and answers that one
 * statement itself.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { agentNameForSlug, type StoredGrant } from "@merrymen/core";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { wrapSqlite, type Db } from "../../../../../worker/src/db";
import { getGrantStore, resetGrantStoreForTest } from "../../../../../worker/src/grant-store";
import { getIdentityStore, resetIdentityStoreForTest } from "../../../../../worker/src/identity-store";
import { appendMessage, ensureGroupchatSchema } from "../../../../../worker/src/groupchat/store";
import type { NewMessage, PublicMessage } from "../../../../../worker/src/groupchat/types";
import { GET as getMe } from "./me/route";
import { DELETE, GET, POST } from "./route";
import { setRoomForTest } from "./room";

const ORIGIN = "https://app.merrymen.dev";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
/** Signed in, no grant: not an owner. */
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
/** Smart accounts, written mixed-case where the ledger might hold them so. */
const SA_A = "0x00000000000000000000000000000000000000a1" as const;
const SA_B = "0x00000000000000000000000000000000000000b2" as const;
/** Noon UTC: the day count resets twelve hours from here. */
const NOON = Date.UTC(2026, 8, 23, 12, 0, 0);

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK", "MERRYMEN_GROUPCHAT"].map((k) => [
    k,
    process.env[k],
  ]),
);
let home: string;
let slugA: string;
let slugB: string;

/** A grant as the store keeps it: session key only, never an owner key. */
function grantFor(smartAccount: `0x${string}`): StoredGrant {
  return {
    smartAccount,
    owner: "0x0000000000000000000000000000000000000fee",
    sessionKeyAddress: "0x0000000000000000000000000000000000000abc",
    serialized: "not-a-permission-account",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 },
    grantedAt: 1,
    expiresAt: 4_000_000_000,
    chainId: 4663,
    demoSessionPrivateKey: `0x${"1".repeat(64)}`,
  } as unknown as StoredGrant;
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-groupchat-route-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "groupchat-route-test-secret-at-least-32-chars";
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_STORE_DEK;
  resetGrantStoreForTest();
  resetIdentityStoreForTest();
  await getGrantStore().put(A, grantFor(SA_A));
  await getGrantStore().put(B, grantFor(SA_B));
  slugA = (await getIdentityStore().ensure(A, SA_A)).slug;
  slugB = (await getIdentityStore().ensure(B, SA_B)).slug;
});

after(() => {
  setRoomForTest(null);
  mock.restoreAll();
  resetGrantStoreForTest();
  resetIdentityStoreForTest();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let raw: DatabaseSync;
let db: Db;
let clock = NOON;

/** A fresh room per test, with the ledger's `agents` rows the name is read from. */
beforeEach(async () => {
  process.env.MERRYMEN_HOSTED = "1";
  delete process.env.MERRYMEN_GROUPCHAT;
  clock = NOON;
  raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT)");
  raw.prepare("INSERT INTO agents (smart_account, name) VALUES (?, ?)").run(SA_A.toUpperCase().replace("0X", "0x"), "Kestrel");
  raw.prepare("INSERT INTO agents (smart_account, name) VALUES (?, ?)").run(SA_B, "Robin");
  db = wrapSqlite(raw);
  await ensureGroupchatSchema(db, "sqlite");
  setRoomForTest({ db, now: () => clock });
});

afterEach(() => {
  setRoomForTest(null);
  mock.restoreAll();
  try {
    raw.close();
  } catch {
    /* already closed by the test */
  }
});

const cookie = (tenant: string) => `${SESSION_COOKIE}=${mintSession(tenant as `0x${string}`)}`;

function get(query = "", tenant?: string) {
  return GET(new Request(`${ORIGIN}/api/groupchat${query}`, { headers: tenant ? { cookie: cookie(tenant) } : {} }));
}

function post(tenant: string | null, body: unknown, raw = false) {
  return POST(
    new Request(`${ORIGIN}/api/groupchat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(tenant ? { cookie: cookie(tenant) } : {}) },
      body: raw ? String(body) : JSON.stringify(body),
    }),
  );
}

function del(tenant: string | null, id: string | number) {
  return DELETE(
    new Request(`${ORIGIN}/api/groupchat?id=${encodeURIComponent(String(id))}`, {
      method: "DELETE",
      headers: tenant ? { cookie: cookie(tenant) } : {},
    }),
  );
}

/** An agent line as the orchestrator writes it, with every internal field set. */
function agentLine(over: Partial<NewMessage> = {}): NewMessage {
  return {
    createdAtMs: clock - 5_000,
    authorKind: "agent",
    tenant: B,
    agentId: SA_B,
    speakerSlug: slugB,
    speakerName: "Amber Heron",
    body: "just picked up a bag",
    replyTo: null,
    kind: "call",
    call: { side: "buy", symbol: "FROG", name: "Frog", token: null, paper: true },
    callDecisionId: "decision-secret-id",
    dedupeKey: `call:${Math.random()}`,
    ...over,
  };
}

/** The same database, with every statement's answer delayed a few milliseconds. */
function slow(inner: Db): Db {
  const late = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 3));
  return {
    prepare(sql) {
      const s = inner.prepare(sql);
      return {
        run: async (...p) => late(await s.run(...p)),
        get: async (...p) => late(await s.get(...p)),
        all: async (...p) => late(await s.all(...p)),
      };
    },
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx((scoped) => fn(slow(scoped))),
  };
}

/** The same database, counting the transactions opened on it. */
function counted(inner: Db, seen: { tx: number }): Db {
  return {
    prepare: (sql) => inner.prepare(sql),
    exec: (sql) => inner.exec(sql),
    tx: (fn) => {
      seen.tx += 1;
      return inner.tx(fn);
    },
  };
}

/**
 * The same sqlite, answering the route's Postgres-only lock statement itself:
 * `free()` says whether the lock was there to take. Every other statement is
 * the store's real SQL on the real engine.
 */
function pgLock(inner: Db, free: () => boolean, seen: string[]): Db {
  const wrap = (d: Db): Db => ({
    prepare(sql) {
      if (!/\bpg_\w*advisory/.test(sql)) return d.prepare(sql);
      seen.push(sql);
      const answer = async () => ({ ok: free() });
      return {
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
        get: answer,
        all: async () => [await answer()],
      };
    },
    exec: (sql) => d.exec(sql),
    tx: (fn) => d.tx((scoped) => fn(wrap(scoped))),
  });
  return wrap(inner);
}

type Page = { source: string; messages: PublicMessage[]; cursor: number; start?: boolean; gone?: number[] };

async function posted(res: Response): Promise<PublicMessage> {
  const body = (await res.json()) as { message?: PublicMessage; error?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.message);
  return body.message;
}

/** The route's source without comments, which name what the code must never do. */
const CODE = readFileSync(new URL("./route.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("hosted only", () => {
  it("answers 404 to every verb on a self-hosted install", async () => {
    delete process.env.MERRYMEN_HOSTED;
    assert.equal((await get()).status, 404);
    assert.equal((await post(A, { body: "hello" })).status, 404);
    assert.equal((await del(A, 1)).status, 404);
  });

  it("MERRYMEN_GROUPCHAT=0 on the web answers every verb exactly like self-hosted, and writes nothing", async () => {
    const line = await posted(await post(A, { body: "said before the switch" }));
    const verbs = [() => get(), () => get("?since=0", A), () => post(A, { body: "anyone here?" }), () => del(A, line.id)];
    const answer = async (res: Response) => [res.status, res.headers.get("cache-control"), await res.text()];
    delete process.env.MERRYMEN_HOSTED;
    const selfHosted: unknown[][] = [];
    for (const verb of verbs) selfHosted.push(await answer(await verb()));
    assert.deepEqual(selfHosted.map((a) => a[0]), [404, 404, 404, 404]);
    process.env.MERRYMEN_HOSTED = "1";
    for (const off of ["0", " 0 ", "0\n"]) {
      process.env.MERRYMEN_GROUPCHAT = off;
      for (const [i, verb] of verbs.entries()) {
        assert.deepEqual(await answer(await verb()), selfHosted[i], `${JSON.stringify(off)}, verb #${i}`);
      }
    }
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM groupchat_messages").get() as { n: number }).n, 1, "no line was stored");
    assert.equal((raw.prepare("SELECT hidden FROM groupchat_messages").get() as { hidden: number }).hidden, 0, "none was taken back");
    // Anything but a 0 leaves the room open: the orchestrator reads it the same way.
    for (const on of ["", "1", "off", "false"]) {
      process.env.MERRYMEN_GROUPCHAT = on;
      assert.equal((await get()).status, 200, JSON.stringify(on));
    }
  });
});

describe("GET is the same bytes for everybody", () => {
  it("never reads a session: no tenantOf, no cookie, in the handler", () => {
    const start = CODE.indexOf("export async function GET");
    const end = CODE.indexOf("\nexport async function", start + 1);
    const body = CODE.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.doesNotMatch(body, /tenantOf|cookie|headers\.get/);
  });

  it("answers a signed-in and a signed-out reader identically, sets no cookie, and carries nothing internal", async () => {
    await posted(await post(A, { body: "morning all, my agent is up early", clientId: "leak-check-0001" }));
    await appendMessage(db, agentLine());
    const anon = await get("?limit=60");
    const signed = await get("?limit=60", A);
    const anonText = await anon.text();
    assert.equal(anonText, await signed.text());
    assert.equal(anon.headers.get("set-cookie"), null);
    assert.equal(signed.headers.get("set-cookie"), null);
    assert.equal(anon.headers.get("cache-control"), "public, max-age=2, s-maxage=2");
    for (const secret of [A, B, SA_A, SA_B, "decision-secret-id", "call:", "leak-check-0001", "tenant", "agentId", "agent_id", "dedupe", "hidden"]) {
      assert.ok(!anonText.toLowerCase().includes(secret.toLowerCase()), `the public GET leaked ${secret}`);
    }
    const page = JSON.parse(anonText) as { source: string; messages: PublicMessage[] };
    assert.equal(page.source, "db");
    assert.equal(page.messages.length, 2);
    assert.deepEqual(Object.keys(page.messages[1]!).sort(), ["at", "author", "body", "call", "id", "kind", "name", "replyTo", "slug"]);
  });

  it("is dynamic and never prerendered", () => {
    assert.match(CODE, /export const dynamic = "force-dynamic"/);
    assert.doesNotMatch(CODE, /export const revalidate/);
  });
});

describe("GET pages by cursor", () => {
  it("since returns only newer lines; the cursor is the newest id, or the since sent when nothing is new", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await appendMessage(db, agentLine({ body: `line ${i}`, dedupeKey: null })))!);
    const after2 = (await (await get(`?since=${ids[1]}&limit=100`)).json()) as { messages: PublicMessage[]; cursor: number; start: boolean };
    assert.deepEqual(after2.messages.map((m) => m.id), ids.slice(2));
    assert.equal(after2.cursor, ids[4]);
    const quiet = (await (await get(`?since=${ids[4]}&limit=100`)).json()) as { messages: PublicMessage[]; cursor: number };
    assert.deepEqual(quiet.messages, []);
    assert.equal(quiet.cursor, ids[4]);
  });

  it("before returns the older page and says when it reached the start", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await appendMessage(db, agentLine({ body: `line ${i}`, dedupeKey: null })))!);
    const older = (await (await get(`?before=${ids[3]}&limit=2`)).json()) as { messages: PublicMessage[]; start: boolean };
    assert.deepEqual(older.messages.map((m) => m.id), [ids[1], ids[2]]);
    assert.equal(older.start, false);
    const first = (await (await get(`?before=${ids[1]}&limit=2`)).json()) as { messages: PublicMessage[]; start: boolean };
    assert.deepEqual(first.messages.map((m) => m.id), [ids[0]]);
    assert.equal(first.start, true);
    const newest = (await (await get(`?limit=2`)).json()) as { messages: PublicMessage[]; cursor: number };
    assert.deepEqual(newest.messages.map((m) => m.id), [ids[3], ids[4]]);
    assert.equal(newest.cursor, ids[4]);
  });

  it("leaves hidden lines out", async () => {
    const mine = await posted(await post(A, { body: "oops" }));
    assert.equal(((await (await del(A, mine.id)).json()) as { hidden: boolean }).hidden, true);
    const page = (await (await get()).json()) as { messages: PublicMessage[] };
    assert.ok(!page.messages.some((m) => m.id === mine.id));
  });

  it("refuses a cursor that is not a whole number, without caching the refusal", async () => {
    for (const q of ["?since=1e3", "?since=-1", "?since=2.5", "?before=abc", "?limit=ten", `?since=${"9".repeat(17)}`]) {
      const res = await get(q);
      assert.equal(res.status, 400, q);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  it("serves the room summary the orchestrator wrote", async () => {
    raw.prepare("INSERT INTO groupchat_room (k, v, updated_at_ms) VALUES ('room', ?, ?)").run(
      JSON.stringify({ members: 2, awake: 1, asleep: 1, presence: [{ slug: slugB, name: "Amber Heron", state: "awake" }], updatedAtMs: clock }),
      clock,
    );
    const page = (await (await get()).json()) as { room: { awake: number; asleep: number } | null };
    assert.equal(page.room?.awake, 1);
    assert.equal(page.room?.asleep, 1);
  });
});

describe("GET: a line taken back leaves the screens that already hold it", () => {
  it("a poll lists the ids of lines hidden behind its cursor, the same for every reader, naming nobody", async () => {
    const mine = await posted(await post(A, { body: "my city is lisbon, come say hi" }));
    const kept = await posted(await post(B, { body: "hello all" }));
    // A reader loads the room and now holds the line.
    const first = (await (await get("?since=0&limit=100")).json()) as Page;
    assert.ok(first.messages.some((m) => m.id === mine.id));
    assert.deepEqual(first.gone, [], "nothing taken back yet");
    // The room moves on, then the owner takes their line back.
    for (let i = 0; i < 30; i++) await appendMessage(db, agentLine({ body: `line ${i}`, dedupeKey: null }));
    assert.equal(((await (await del(A, mine.id)).json()) as { hidden: boolean }).hidden, true);
    const top = ((await (await get("?limit=1")).json()) as Page).cursor;
    // The reader's next poll asks from a little behind its cursor, as the client does.
    const query = `?since=${top - 16}&limit=100`;
    const anon = await get(query);
    const anonText = await anon.text();
    const next = JSON.parse(anonText) as Page;
    assert.deepEqual(next.gone, [mine.id], "the taken-back line is named, and only it");
    assert.ok(!next.gone?.includes(kept.id));
    assert.equal(anonText, await (await get(query, B)).text(), "the same bytes signed in or out");
    assert.equal(anon.headers.get("cache-control"), "public, max-age=2, s-maxage=2");
    for (const secret of [A, B, SA_A, SA_B, "tenant", "hidden", "lisbon"]) {
      assert.ok(!anonText.toLowerCase().includes(secret.toLowerCase()), `the public GET leaked ${secret}`);
    }
  });

  it("only a poll carries the list, and only for a bounded stretch behind it", async () => {
    const mine = await posted(await post(A, { body: "take this back" }));
    await del(A, mine.id);
    assert.equal(((await (await get()).json()) as Page).gone, undefined, "a first load never held the line");
    assert.equal(((await (await get(`?before=${mine.id + 1}`)).json()) as Page).gone, undefined, "nor an older page");
    assert.deepEqual(((await (await get(`?since=${mine.id}`)).json()) as Page).gone, [mine.id]);
    assert.deepEqual(((await (await get(`?since=${mine.id + 5_000}`)).json()) as Page).gone, [], "far behind the poll is not scanned");
  });
});

describe("GET says when it could not read", () => {
  it("source none, the client's cursor back, no-store — never an empty room", async () => {
    raw.close();
    const res = await get("?since=41&limit=100");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { source: "none", messages: [], cursor: 41, room: null });
  });

  it("source none when this deploy has no shared database at all", async () => {
    setRoomForTest(null);
    const res = await get("?limit=10");
    assert.deepEqual(await res.json(), { source: "none", messages: [], cursor: 0, room: null });
  });

  it("source none when the shared Postgres cannot be reached", async () => {
    setRoomForTest(null);
    process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
    try {
      const res = await get("?since=7");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { source: "none", messages: [], cursor: 7, room: null });
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});

describe("POST: who may post", () => {
  it("401 signed out, 403 signed in without a Merryman", async () => {
    const out = await post(null, { body: "hi" });
    assert.equal(out.status, 401);
    const stranger = await post(C, { body: "hi" });
    assert.equal(stranger.status, 403);
    assert.equal(((await stranger.json()) as { error: string }).error, "Only owners with a Merryman can post.");
  });

  it("503, not 403, when the grant store cannot be read", async () => {
    mock.method(getGrantStore(), "get", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    const res = await post(A, { body: "hi" });
    assert.equal(res.status, 503);
    assert.doesNotMatch(await res.text(), /Connection terminated/);
  });

  it("413 over four kilobytes, before anything is parsed", async () => {
    const res = await post(A, JSON.stringify({ body: "x".repeat(5000) }), true);
    assert.equal(res.status, 413);
  });

  it("400 for a body that is not JSON or has no text", async () => {
    assert.equal((await post(A, "not json", true)).status, 400);
    assert.equal((await post(A, [1, 2])).status, 400);
    assert.equal((await post(A, { text: "hi" })).status, 400);
  });

  it("400 with an owner-facing sentence for each thing the gate refuses", async () => {
    const cases: [string, RegExp][] = [
      ["   ", /Write something/],
      ["x".repeat(501), /under 500 characters/],
      ["send it to 0x1234567890abcdef1234567890abcdef12345678", /Addresses can't be posted/],
      ["check https://evil.example/x", /Links can't be posted/],
      [`my key is 0x${"ab".repeat(32)}`, /private key, a recovery phrase or another secret/],
    ];
    for (const [body, words] of cases) {
      const res = await post(A, { body });
      assert.equal(res.status, 400, body);
      assert.match(((await res.json()) as { error: string }).error, words);
    }
    assert.equal(((await (await get()).json()) as { messages: unknown[] }).messages.length, 0, "nothing refused was stored");
  });
});

describe("POST: the line as the room shows it", () => {
  it("is the owner's, under their agent's name and slug, with the tenant kept internal", async () => {
    const m = await posted(await post(A, { body: "  up late with my agent\nagain  ", clientId: "c1" }));
    assert.equal(m.author, "owner");
    assert.equal(m.name, "Kestrel's owner");
    assert.equal(m.slug, slugA);
    assert.equal(m.body, "up late with my agent again");
    assert.equal(m.kind, "chat");
    assert.equal(m.call, null);
    const row = raw.prepare("SELECT tenant, agent_id, author_kind, dedupe_key FROM groupchat_messages WHERE id = ?").get(m.id) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { tenant: A, agent_id: SA_A, author_kind: "owner", dedupe_key: null });
  });

  it("the stock Robin becomes the slug's generated name, the same one the conductor uses", async () => {
    const m = await posted(await post(B, { body: "hello room" }));
    assert.equal(m.name, `${agentNameForSlug(slugB)}'s owner`);
  });

  it("an address-shaped or missing agent name is never shown", async () => {
    raw.prepare("UPDATE agents SET name = ? WHERE smart_account = ?").run("0xdeadbeef00", SA_B);
    assert.equal((await posted(await post(B, { body: "one" }))).name, `${agentNameForSlug(slugB)}'s owner`);
    raw.prepare("DELETE FROM agents WHERE smart_account = ?").run(SA_B);
    assert.equal((await posted(await post(B, { body: "two" }))).name, `${agentNameForSlug(slugB)}'s owner`);
  });

  it("two agents named 'Pine Stoat' and 'Pine Stoatㅤ': the first minted keeps the label, the other owner posts under their slug's name", async () => {
    raw.prepare("UPDATE agents SET name = ? WHERE LOWER(smart_account) = ?").run("Pine Stoat", SA_A);
    raw.prepare("UPDATE agents SET name = ? WHERE LOWER(smart_account) = ?").run("Pine Stoatㅤ", SA_B);
    // Mint order decides, not who asks first: set it, then flip it.
    const files = [A, B].map((t) => path.join(home, "agent-identity", `${t}.json`));
    const originals = files.map((f) => readFileSync(f, "utf8"));
    const mint = (aAt: number, bAt: number) =>
      files.forEach((f, i) => writeFileSync(f, JSON.stringify({ ...JSON.parse(originals[i]!), createdAt: i === 0 ? aAt : bAt })));
    try {
      mint(1_700_000_000, 1_700_000_500);
      assert.equal((await posted(await post(B, { body: "hi" }))).name, `${agentNameForSlug(slugB)}'s owner`);
      assert.equal((await posted(await post(A, { body: "hi" }))).name, "Pine Stoat's owner");
      // The chat screen's own view of the name agrees with the label.
      const meB = (await (await getMe(new Request(`${ORIGIN}/api/groupchat/me`, { headers: { cookie: cookie(B) } }))).json()) as { name: string };
      assert.equal(meB.name, agentNameForSlug(slugB));
      mint(1_700_000_900, 1_700_000_500);
      assert.equal((await posted(await post(A, { body: "again" }))).name, `${agentNameForSlug(slugA)}'s owner`);
      assert.equal((await posted(await post(B, { body: "again" }))).name, "Pine Stoatㅤ's owner");
    } finally {
      files.forEach((f, i) => writeFileSync(f, originals[i]!));
    }
  });

  it("a line that is only a greeting is a gm; a greeting with a question is chat", async () => {
    for (const body of ["gm", "GM all!", "good morning everyone ☀️", "gm gm frens"]) {
      assert.equal((await posted(await post(A, { body }))).kind, "gm", body);
      clock += 11_000;
    }
    assert.equal((await posted(await post(A, { body: "gm, how is everyone doing" }))).kind, "chat");
  });

  it("owner lines may carry digits — it is their speech", async () => {
    assert.equal((await posted(await post(A, { body: "up 40% today, 3 trades" }))).body, "up 40% today, 3 trades");
  });
});

describe("POST: replies", () => {
  it("replyTo must be a positive whole number naming a line the room still shows", async () => {
    const target = (await appendMessage(db, agentLine({ dedupeKey: null })))!;
    for (const replyTo of ["5", 0, -1, 1.5, 999_999, true]) {
      const res = await post(A, { body: "agreed", replyTo });
      assert.equal(res.status, 400, JSON.stringify(replyTo));
    }
    const hidden = await posted(await post(B, { body: "take this back" }));
    await del(B, hidden.id);
    assert.equal((await post(A, { body: "what did you say?", replyTo: hidden.id })).status, 400);
    const ok = await posted(await post(A, { body: "agreed", replyTo: target }));
    assert.equal(ok.replyTo, target);
    assert.equal((await posted(await post(A, { body: "no reply", replyTo: null }))).replyTo, null);
  });
});

describe("POST: a resend is stored once", () => {
  const keyed = () =>
    (raw.prepare("SELECT id, dedupe_key FROM groupchat_messages WHERE dedupe_key IS NOT NULL ORDER BY id").all() as Record<string, unknown>[]).map(
      (r) => ({ ...r }),
    );

  it("the same client id again is answered with the original line; another owner's same id, or a new id, is a new line", async () => {
    const id = "3f2b9c1e-8a7d-4e6f-9b0a-1c2d3e4f5a6b";
    const first = await posted(await post(A, { body: "is this thing on", clientId: id }));
    clock += 2_000;
    const again = await post(A, { body: "is this thing on", clientId: id });
    assert.equal(again.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await posted(again), first);
    assert.deepEqual(keyed(), [{ id: first.id, dedupe_key: `owner:${A}:${id}` }]);
    const theirs = await posted(await post(B, { body: "is this thing on", clientId: id }));
    assert.notEqual(theirs.id, first.id);
    const saidAgain = await posted(await post(A, { body: "is this thing on", clientId: "a-new-line-0001" }));
    assert.notEqual(saidAgain.id, first.id);
    assert.equal(keyed().length, 3);
  });

  it("a resend costs nothing against the limits: not a post token, and not refused at the minute's limit", async () => {
    const line = await posted(await post(A, { body: "only once", clientId: "only-once-0001" }));
    // Far more resends than the bucket holds, at one instant.
    for (let i = 0; i < 20; i++) assert.deepEqual(await posted(await post(A, { body: "only once", clientId: "only-once-0001" })), line, `resend ${i}`);
    assert.equal((await post(A, { body: "a new line, same instant" })).status, 200, "the bucket was not drained");
    // An owner whose sixth line of the minute landed but whose answer was lost.
    for (let i = 0; i < 5; i++) await posted(await post(B, { body: `line ${i}` }));
    const sixth = await posted(await post(B, { body: "the sixth", clientId: "the-sixth-0001" }));
    assert.equal((await post(B, { body: "a seventh" })).status, 429);
    assert.deepEqual(await posted(await post(B, { body: "the sixth", clientId: "the-sixth-0001" })), sixth);
  });

  it("a resend racing its original is still one line, and both are answered with it", async () => {
    // Every statement answers late, so both copies look for the key before either has stored it.
    setRoomForTest({ db: slow(db), now: () => clock });
    for (let i = 0; i < 5; i++) await posted(await post(A, { body: `line ${i}` }));
    // B has room to spare, so the loser meets the key; A is one short of the
    // limit, so the loser meets the limit its own original just used up.
    for (const [tenant, clientId] of [
      [B, "raced-line-0001"],
      [A, "raced-line-0002"],
    ] as const) {
      const [one, two] = await Promise.all([post(tenant, { body: "twice?", clientId }), post(tenant, { body: "twice?", clientId })]);
      assert.deepEqual(await posted(two), await posted(one), tenant);
    }
    assert.equal(keyed().length, 2);
  });

  it("an id that is not 8-64 of [A-Za-z0-9_-] is ignored, never refused: the line posts as free chat each time", async () => {
    for (const clientId of ["short12", "x".repeat(65), "has space1", "semi;colon", "ünïcödé-id", "", 12345678, true, null, { id: "abcdefgh" }]) {
      const one = await posted(await post(A, { body: "free chat", clientId }));
      const two = await posted(await post(A, { body: "free chat", clientId }));
      assert.notEqual(one.id, two.id, JSON.stringify(clientId));
      clock += 61_000;
    }
    assert.deepEqual(keyed(), []);
    for (const clientId of ["abcdefgh", "A_-9".repeat(16)]) await posted(await post(A, { body: "at the edges", clientId }));
    assert.equal(keyed().length, 2, "eight and sixty-four characters are keys");
  });
});

describe("POST: the rate limit", () => {
  it("six a minute, then 429 with Retry-After, and the next minute opens again", async () => {
    for (let i = 0; i < 6; i++) await posted(await post(A, { body: `line ${i}` }));
    const seventh = await post(A, { body: "one more" });
    assert.equal(seventh.status, 429);
    assert.equal(seventh.headers.get("retry-after"), "60");
    assert.match(((await seventh.json()) as { error: string }).error, /Wait a minute/);
    assert.equal((await post(B, { body: "another owner is unaffected" })).status, 200);
    clock += 61_000;
    assert.equal((await post(A, { body: "later" })).status, 200);
  });

  it("hiding a line does not give it back", async () => {
    for (let i = 0; i < 6; i++) {
      const m = await posted(await post(A, { body: `line ${i}` }));
      await del(A, m.id);
    }
    assert.equal((await post(A, { body: "again" })).status, 429);
  });

  it("two hundred a UTC day, then 429 until midnight; yesterday's lines do not count", async () => {
    const owner = (at: number): NewMessage => ({
      ...agentLine(),
      authorKind: "owner",
      tenant: A,
      agentId: SA_A,
      kind: "chat",
      call: null,
      callDecisionId: null,
      dedupeKey: null,
      createdAtMs: at,
    });
    for (let i = 0; i < 40; i++) await appendMessage(db, owner(NOON - 13 * 3600_000)); // yesterday, UTC
    for (let i = 0; i < 199; i++) await appendMessage(db, owner(NOON - 3 * 3600_000));
    assert.equal((await post(A, { body: "the two hundredth" })).status, 200);
    clock += 61_000;
    const over = await post(A, { body: "the two hundred and first" });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), String(12 * 3600 - 61));
  });

  it("holds under concurrent posts: a burst cannot count the same lines twice", async () => {
    // Every statement answers late, so ten requests that were NOT serialised
    // would all count zero before any of them inserted.
    setRoomForTest({ db: slow(db), now: () => clock });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post(A, { body: `burst ${i}` })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429, 429, 429, 429]);
  });

  it("an owner already at the limit is refused without a transaction being opened", async () => {
    for (let i = 0; i < 6; i++) await posted(await post(A, { body: `line ${i}` }));
    const seen = { tx: 0 };
    setRoomForTest({ db: counted(db, seen), now: () => clock });
    const over = await post(A, { body: "one more" });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), "60");
    assert.equal(seen.tx, 0, "the refusal came from a plain read, not a pooled transaction");
    assert.equal((await post(B, { body: "under the limit" })).status, 200);
    assert.equal(seen.tx, 1, "a post that may go ahead still counts and writes under the lock");
  });
});

describe("POST: the per-owner lock on Postgres is tried, never waited for", () => {
  it("takes the lock with pg_try_advisory_xact_lock and posts when it is free", async () => {
    const seen: string[] = [];
    setRoomForTest({ db: pgLock(db, () => true, seen), now: () => clock, dialect: "postgres" });
    assert.equal((await posted(await post(A, { body: "hello" }))).body, "hello");
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /pg_try_advisory_xact_lock\(\?, \?\)/);
  });

  it("a post that finds the lock held is told to try again at once, and writes nothing", async () => {
    const seen: string[] = [];
    setRoomForTest({ db: pgLock(db, () => false, seen), now: () => clock, dialect: "postgres" });
    const busy = await post(A, { body: "hello" });
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get("retry-after"), "1");
    assert.match(((await busy.json()) as { error: string }).error, /One message at a time/);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM groupchat_messages").get() as { n: number }).n, 0);
    assert.ok(!seen.some((sql) => /pg_advisory_xact_lock/.test(sql)), "never the waiting form");
  });
});

describe("POST: every post is metered before the gate runs", () => {
  it("a burst of lines the gate refuses meets 429 instead of the gate, and a token comes back every five seconds", async () => {
    const address = `CA 0x${"ab".repeat(20)}`;
    for (let i = 0; i < 12; i++) assert.equal((await post(A, { body: address })).status, 400, `refusal ${i}`);
    // The gate would answer 400 again; a 429 means it never ran.
    const over = await post(A, { body: address });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), "5");
    assert.match(((await over.json()) as { error: string }).error, /Wait a few seconds/);
    assert.equal((await post(A, { body: "a fine line" })).status, 429, "a good line waits its turn too");
    assert.equal((await post(B, { body: "another owner is unaffected" })).status, 200);
    clock += 5_000;
    assert.equal((await post(A, { body: "a fine line" })).status, 200);
    assert.equal((await post(A, { body: "and another" })).status, 429);
  });

  it("a person posting at the room's own limit never meets it", async () => {
    for (let minute = 0; minute < 3; minute++) {
      for (let i = 0; i < 6; i++) await posted(await post(A, { body: `minute ${minute} line ${i}` }));
      assert.equal((await post(A, { body: "x".repeat(501) })).status, 400, "a refused line is still answered by the gate");
      clock += 61_000;
    }
  });
});

describe("DELETE hides only the caller's own owner lines", () => {
  it("an owner can take back their line; nobody else can, and no agent line can be hidden", async () => {
    const mine = await posted(await post(A, { body: "hello" }));
    const theirs = await posted(await post(B, { body: "hi" }));
    const agent = (await appendMessage(db, agentLine({ dedupeKey: null })))!;
    assert.equal((await del(null, mine.id)).status, 401);
    assert.equal(((await (await del(B, mine.id)).json()) as { hidden: boolean }).hidden, false);
    assert.equal(((await (await del(A, agent)).json()) as { hidden: boolean }).hidden, false);
    assert.equal(((await (await del(A, theirs.id)).json()) as { hidden: boolean }).hidden, false);
    const res = await del(A, mine.id);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(((await res.json()) as { hidden: boolean }).hidden, true);
    const ids = ((await (await get()).json()) as { messages: PublicMessage[] }).messages.map((m) => m.id);
    assert.deepEqual(ids.sort((x, y) => x - y), [theirs.id, agent].sort((x, y) => x - y));
  });

  it("400 for an id that is not one", async () => {
    for (const id of ["", "abc", "0", "-3", "1.5"]) assert.equal((await del(A, id)).status, 400, id);
  });
});

describe("no model is ever called from here", () => {
  it("imports nothing that can reach one", () => {
    assert.doesNotMatch(CODE, /\bllm\b|llmText|llmLine|groupchat\/voice|groupchat\/conductor|\bfetch\(/);
  });
});
