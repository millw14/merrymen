/**
 * THE INCIDENT, THROUGH THE REAL ROUTE: the house's key resolved the way
 * production resolves it, Groq's real answer for an account held over an
 * unpaid bill, and only the model transport stubbed.
 *
 * 2026-10-09: every house-key call failed with organization_delinquent, a new
 * hosted agent told its tester "its setup needs a look", and /api/chat logged
 * nothing. The route must say "billing", say it is the house's key — the
 * boolean, never the key — and log one line an operator can find.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, mock, test } from "node:test";
import { resetGrantStoreForTest } from "@merrymen/grant-store";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { readReplyStream } from "@/lib/chat-stream";
import { POST } from "./route";

const TENANT = `0x${"a".repeat(40)}` as `0x${string}`;
const HOUSE = "gsk_house_fleet_key_route_0123456789abcdef";
const FILE_KEY = "gsk_house_file_key_route_fedcba9876543210";
const HOLDER = "mm_holder_claim_token_route_0123456789";
const HELD_MESSAGE =
  "Organization has been restricted because of overdue payment(s). Please update the payment method at https://console.groq.com/settings/billing/manage and then contact support.";
const HELD_LINE = `groq 400 — organization_delinquent: ${HELD_MESSAGE}`;

const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-chat-house-"));
const settingsFile = path.join(home, "settings.json");
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_SETTINGS_FILE",
  "MERRYMEN_LLM_PROVIDER", "MERRYMEN_LLM_API_KEY", "MERRYMEN_LLM_PROVIDER_MODEL", "ANTHROPIC_API_KEY", "GROQ_API_KEY",
  "MERRYMEN_FOMO_ENABLED", "MERRYMEN_FOMO_API_KEY", "FOMO_API_KEY"] as const;
const saved = new Map(keys.map((key) => [key, process.env[key]]));
/** The key each model request was sent with — to know which one the route resolved. */
let sentWith: string[] = [];
let warned: string[] = [];

before(() => {
  for (const key of keys) delete process.env[key];
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-chat-house-session-secret-at-least-32-chars";
  process.env.MERRYMEN_SETTINGS_FILE = settingsFile;
  process.env.MERRYMEN_FOMO_ENABLED = "0";
  // The house key, where the deployment keeps it.
  process.env.GROQ_API_KEY = HOUSE;
  resetGrantStoreForTest();
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.match(String(input), /chat\/completions$/, "nothing but the model is called");
    sentWith.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, ""));
    // Groq's own body for a held account, byte for byte the shape providerError reads.
    return new Response(JSON.stringify({ error: { message: HELD_MESSAGE, type: "invalid_request_error", code: "organization_delinquent" } }),
      { status: 400, headers: { "content-type": "application/json" } });
  });
  mock.method(console, "warn", (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  });
});
beforeEach(() => {
  sentWith = [];
  warned = [];
  rmSync(settingsFile, { force: true });
});
after(() => {
  mock.restoreAll();
  resetGrantStoreForTest();
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function ask(stream = false, signedIn = true): Promise<Response> {
  return POST(new Request("https://app.merrymen.dev/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(stream ? { accept: "text/event-stream" } : {}),
      ...(signedIn ? { cookie: `${SESSION_COOKIE}=${mintSession(TENANT)}` } : {}),
    },
    body: JSON.stringify({ message: "hello there", ...(signedIn ? { expectedTenant: TENANT } : {}) }),
  }));
}

type Failed = { reply: null; why?: string; kind?: string; house?: unknown; provider?: string; detail?: string };

test("HOSTED, ON THE HOUSE'S GROQ KEY: the held account is 'billing', and the house's — the boolean, never the key", async () => {
  const res = await ask();
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw) as Failed;
  assert.equal(body.why, "llm-error");
  assert.equal(body.kind, "billing", "not 'a reason I don't recognise'");
  assert.equal(body.house, true);
  assert.equal(body.provider, "Groq");
  assert.equal(sentWith.at(-1), HOUSE, "fixture: the route resolved the env's house key");
  assert.ok(!raw.includes(HOUSE.slice(0, 12)), raw);
  assert.deepEqual(warned, [`[chat] model call failed (billing, house): ${HELD_LINE}`]);
  assert.ok(!warned.some((l) => l.includes(HOUSE.slice(0, 12))), "never the key in the log");

  // The same, streamed, as the web chat asks for it.
  warned = [];
  const streamed = await ask(true);
  assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
  const out = await readReplyStream(streamed.body!, () => {});
  assert.equal(out.kind, "billing");
  assert.equal(out.house, true);
  assert.equal(warned.length, 1);
});

test("HOSTED, A KEY IN THE WEB'S OWN SETTINGS FILE IS THE HOUSE'S TOO — no tenant writes that file", async () => {
  // File first, env second (settings.ts str), so this key wins over the env's.
  // Hosted, a tenant's Settings go to the per-tenant store (api/settings), and
  // /api/chat never reads it: the file resolveConfig reads is the operator's.
  // Matched by value against the env, it was said as a tenant's own — sent to
  // a Settings screen that cannot reach it, and logged as "own".
  writeFileSync(settingsFile, JSON.stringify({ groqApiKey: FILE_KEY }), "utf8");
  const body = (await (await ask()).json()) as Failed;
  assert.equal(sentWith.at(-1), FILE_KEY, "fixture: the route resolved the file's key, not the env's");
  assert.equal(body.kind, "billing");
  assert.equal(body.house, true);
  assert.match(warned[0] ?? "", /^\[chat\] model call failed \(billing, house\): groq 400 — organization_delinquent/);
  assert.ok(!warned.some((l) => l.includes(FILE_KEY.slice(0, 12))), "never the key in the log");
});

test("SELF-HOSTED, THE ENV IS THE OWNER'S OWN MACHINE: its key is theirs", async () => {
  process.env.MERRYMEN_HOSTED = "0";
  try {
    const body = (await (await ask(false, false)).json()) as Failed;
    assert.equal(sentWith.at(-1), HOUSE, "fixture: the same env key");
    assert.equal(body.kind, "billing");
    assert.equal(body.house, false);
    assert.match(warned[0] ?? "", /\(billing, own\)/);
  } finally {
    process.env.MERRYMEN_HOSTED = "1";
  }
});

test("THE HOLDER GATEWAY'S UPSTREAM IS THE HOUSE'S, self-hosted too — a holder has no bill to settle", async () => {
  // gateway/lib/core.mjs relays the upstream's 400 and body untouched, so the
  // house Groq account's hold reaches a holder's agent as Merrymen AI's own.
  // The holder token is no env key; by value it was the holder's to settle.
  process.env.MERRYMEN_HOSTED = "0";
  writeFileSync(settingsFile, JSON.stringify({ llmProvider: "merrymen", llmApiKey: HOLDER }), "utf8");
  try {
    const raw = await (await ask(false, false)).text();
    const body = JSON.parse(raw) as Failed;
    assert.equal(sentWith.at(-1), HOLDER, "fixture: the route resolved the holder token");
    assert.equal(body.kind, "billing");
    assert.equal(body.house, true);
    assert.equal(body.provider, "Merrymen AI");
    assert.ok(!raw.includes(HOLDER.slice(0, 12)), raw);
    assert.match(warned[0] ?? "", /^\[chat\] model call failed \(billing, house\): merrymen 400 — organization_delinquent/);
  } finally {
    process.env.MERRYMEN_HOSTED = "1";
  }
});
