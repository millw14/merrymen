/**
 * GET /api/fomo/status: hosted, a session is required and decides whose state
 * is read; the answer is the owner's own research status (through the
 * registered tool) and the service's health. Hosted, the session must also
 * own an agent (a grant). Self-hosted, the answer says monitoring and
 * following do not run on this install. Offline: in-memory SQLite, no key.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, it } from "node:test";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { createWebFomoRuntime, FOMO_NEEDS_AGENT, setFomoOwnerReaderForTest, setFomoRuntimeForTest, type FomoRuntime } from "@/lib/fomo-runtime";
import { projectSettings, setSettingsReaderForTest } from "@/lib/services/settings-view";
import { wrapSqlite } from "../../../../../../worker/src/db";
import { FOMO_ATTRIBUTION } from "../../../../../../worker/src/fomo/render";
import { GET } from "./route";

const A = `0x${"a".repeat(40)}` as `0x${string}`;
const B = `0x${"b".repeat(40)}` as `0x${string}`;
const PONS = "0x39dbed3a00000000000000000000000000000c0d";
const ENV_KEYS = ["MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET"] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const C = `0x${"c".repeat(40)}` as `0x${string}`;
const settings: Record<string, Record<string, unknown> | null> = {};
/** Hosted wallets that own an agent (a grant). */
const agents = new Set<string>([A, B]);
let rt: FomoRuntime;
let raw: DatabaseSync;

before(() => {
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-fomo-status-secret-at-least-32-characters";
  setSettingsReaderForTest({ async settingsFor(t) { return projectSettings(settings[t.toLowerCase()] ?? null); } });
  setFomoOwnerReaderForTest({ async hasAgent(t) { return agents.has(t); } });
});

beforeEach(async () => {
  for (const k of Object.keys(settings)) delete settings[k];
  raw = new DatabaseSync(":memory:");
  // No key: every upstream read would answer "not configured"; status reads only Merrymen's own store.
  rt = await createWebFomoRuntime({ hosted: true, db: wrapSqlite(raw), dialect: "sqlite", apiKey: null, log: () => {} });
  setFomoRuntimeForTest(rt);
});

afterEach(() => {
  setFomoRuntimeForTest(null);
  setFomoOwnerReaderForTest({ async hasAgent(t) { return agents.has(t); } });
  process.env.MERRYMEN_HOSTED = "1";
});

after(() => {
  setSettingsReaderForTest(null);
  setFomoOwnerReaderForTest(null);
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const get = (session: `0x${string}` | null, query = "") =>
  GET(new Request(`https://app.merrymen.dev/api/fomo/status${query}`, {
    headers: session ? { cookie: `${SESSION_COOKIE}=${mintSession(session)}` } : {},
  }));

it("requires a session when hosted, and reads nothing without one", async () => {
  const res = await get(null);
  assert.equal(res.status, 401);
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM fomo_requests").get() as { n: number }).n), 0);
  const forged = await GET(new Request("https://app.merrymen.dev/api/fomo/status", { headers: { cookie: `${SESSION_COOKIE}=not-a-session` } }));
  assert.equal(forged.status, 401);
});

it("returns the signed-in owner's own research status and the service's health — never another owner's", async () => {
  await rt.service.invoke(
    { tenant: A, surface: "app-chat", audience: "owner", conversationKey: null, requestId: "watch-a", now: Date.now(), priority: "interactive" },
    "fomo_watch_coin",
    { token: PONS, chain: "robinhood" },
  );
  const resA = await get(A, `?tenant=${B}`);
  assert.equal(resA.status, 200);
  assert.equal(resA.headers.get("cache-control"), "no-store");
  const a = (await resA.json()) as { status: { tool: string; status: string; data: { watches: unknown[] } }; health: { state: string; configured: boolean }; text: string; attribution: string };
  assert.equal(a.status.tool, "fomo_get_research_status");
  assert.equal(a.status.data.watches.length, 1, "a query string names nobody: the session does");
  assert.equal(a.health.state, "not-configured");
  assert.equal(a.health.configured, false);
  assert.equal(typeof a.text, "string");
  assert.equal(a.attribution, FOMO_ATTRIBUTION);

  const b = (await (await get(B)).json()) as { status: { data: { watches: unknown[] } } };
  assert.equal(b.status.data.watches.length, 0, "B never sees A's watches");
  const rows = raw.prepare("SELECT tenant, tool FROM fomo_requests WHERE tool = 'fomo_get_research_status' ORDER BY created_at_ms, rowid").all() as { tenant: string }[];
  assert.deepEqual(rows.map((r) => r.tenant), [A, B]);
});

it("an owner with Fomo data access off is told so, with health still reported", async () => {
  settings[B] = { fomoDataAccess: false };
  const body = (await (await get(B)).json()) as { status: { status: string; reason: string }; health: { state: string } };
  assert.equal(body.status.status, "not-authorized");
  assert.equal(body.status.reason, "data-access-off");
  assert.equal(body.health.state, "not-configured");
});

it("a store that cannot be reached is a 503, not an empty status", async () => {
  setFomoRuntimeForTest(Promise.reject(new Error("db down")) as never);
  const res = await get(A);
  assert.equal(res.status, 503);
});

it("hosted: a signed-in wallet that owns no agent is told so (403), and nothing is read or logged", async () => {
  const res = await get(C);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { error: FOMO_NEEDS_AGENT });
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM fomo_requests").get() as { n: number }).n), 0);
});

it("hosted: an unreadable grant store is a 503, never 'no agent'", async () => {
  setFomoOwnerReaderForTest({ async hasAgent() { throw new Error("grants down"); } });
  const res = await get(A);
  assert.equal(res.status, 503);
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM fomo_requests").get() as { n: number }).n), 0);
});

it("says plainly where cohort monitoring and following can run: hosted yes, self-hosted no", async () => {
  const hosted = (await (await get(A)).json()) as { monitoring: { available: boolean; note: string | null } };
  assert.deepEqual(hosted.monitoring, { available: true, note: null });
  delete process.env.MERRYMEN_HOSTED;
  // Self-hosted asks no grant question: the install's own tenant is its owner.
  setFomoOwnerReaderForTest({ async hasAgent() { throw new Error("must not be asked self-hosted"); } });
  const res = await get(null);
  assert.equal(res.status, 200);
  const self = (await res.json()) as { monitoring: { available: boolean; note: string } };
  assert.equal(self.monitoring.available, false);
  assert.match(self.monitoring.note, /only on the hosted service/);
});
