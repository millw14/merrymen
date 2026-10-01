import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { POST } from "./route";

const A = `0x${"a".repeat(40)}` as `0x${string}`;
const B = `0x${"b".repeat(40)}` as `0x${string}`;
const priorHosted = process.env.MERRYMEN_HOSTED;
const priorSecret = process.env.MERRYMEN_SESSION_SECRET;
const priorHome = process.env.MERRYMEN_HOME;
const priorDatabase = process.env.DATABASE_URL;
const testHome = mkdtempSync(path.join(os.tmpdir(), "merrymen-chat-tenant-"));

process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_SESSION_SECRET = "test-chat-tenant-secret-at-least-32-chars";
process.env.MERRYMEN_HOME = testHome;
delete process.env.DATABASE_URL;

after(() => {
  if (priorHosted === undefined) delete process.env.MERRYMEN_HOSTED;
  else process.env.MERRYMEN_HOSTED = priorHosted;
  if (priorSecret === undefined) delete process.env.MERRYMEN_SESSION_SECRET;
  else process.env.MERRYMEN_SESSION_SECRET = priorSecret;
  if (priorHome === undefined) delete process.env.MERRYMEN_HOME;
  else process.env.MERRYMEN_HOME = priorHome;
  if (priorDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabase;
  rmSync(testHome, { recursive: true, force: true });
});

function post(session: `0x${string}` | null, expectedTenant?: unknown): Promise<Response> {
  return POST(new Request("https://app.merrymen.dev/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { cookie: `${SESSION_COOKIE}=${mintSession(session)}` } : {}),
    },
    body: JSON.stringify({
      message: "What should my agent do?",
      state: JSON.stringify({ name: "A's private account" }),
      history: [{ role: "user", content: "A's private conversation" }],
      ...(expectedTenant === undefined ? {} : { expectedTenant }),
    }),
  }));
}

it("refuses a chat whose confirmed account differs from the authenticated cookie", async () => {
  const response = await post(B, A);
  assert.equal(response.status, 409);
  const body = await response.json() as { why?: string; reply?: unknown };
  assert.equal(body.why, "session-changed");
  assert.equal(body.reply, null);
});

it("refuses missing or malformed expected tenants before using chat state", async () => {
  for (const expected of [undefined, null, "not-an-address"]) {
    const response = await post(A, expected);
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { why?: string }).why, "session-changed");
  }
});

it("keeps signed-out hosted chat unauthorized", async () => {
  const response = await post(null, A);
  assert.equal(response.status, 401);
});

it("lets the confirmed tenant reach normal chat validation", async () => {
  const response = await POST(new Request("https://app.merrymen.dev/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${mintSession(A)}` },
    body: JSON.stringify({ message: "", expectedTenant: A.toUpperCase().replace("0X", "0x") }),
  }));
  assert.equal(response.status, 400, "empty message is rejected by chat validation, past the tenant guard");
  assert.equal((await response.json() as { why?: string }).why, "empty");
});
