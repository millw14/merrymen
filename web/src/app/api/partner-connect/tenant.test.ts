import assert from "node:assert/strict";
import { after, it } from "node:test";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { POST } from "./route";

const A = `0x${"a".repeat(40)}` as `0x${string}`;
const B = `0x${"b".repeat(40)}` as `0x${string}`;
const saved = Object.fromEntries(
  ["MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"].map(key => [key, process.env[key]]),
);
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_SESSION_SECRET = "partner-connect-tenant-test-secret-32-chars";
delete process.env.DATABASE_URL;

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function connect(session: `0x${string}` | null, expectedTenant?: unknown): Promise<Response> {
  return POST(new Request("https://app.merrymen.dev/api/partner-connect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { cookie: `${SESSION_COOKIE}=${mintSession(session)}` } : {}),
    },
    body: JSON.stringify({
      action: "connect",
      token: "opaque-test-token",
      ...(expectedTenant === undefined ? {} : { expectedTenant }),
    }),
  }));
}

it("refuses stale, missing, or malformed account claims before touching the partner store", async () => {
  for (const claimed of [A, undefined, null, "not-an-address"]) {
    const response = await connect(B, claimed);
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "session_changed");
  }
});

it("keeps signed-out connection attempts unauthorized", async () => {
  const response = await connect(null, A);
  assert.equal(response.status, 401);
});

it("accepts a case-insensitive matching tenant claim past the guard", async () => {
  const response = await connect(A, A.toUpperCase().replace("0X", "0x"));
  assert.equal(response.status, 503, "the absent test database is reached only after tenant validation");
});
