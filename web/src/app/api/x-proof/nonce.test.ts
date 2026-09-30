import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueChallengeNonce, mintSession, SESSION_COOKIE } from "@/lib/auth";
import { POST } from "./route";

const home = mkdtempSync(join(tmpdir(), "merrymen-x-proof-nonce-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_PUBLIC_ORIGIN;
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

test("X proof refuses invalid, expired, and unrecordable challenges before fetching a post", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network access"); });
  const origin = "https://example.invalid";
  try {
    for (const nonce of ["invalid", issueChallengeNonce(origin, Date.now() - 6 * 60_000), issueChallengeNonce(origin)]) {
      const response = await POST(new Request(`${origin}/api/x-proof`, {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${mintSession("0x0000000000000000000000000000000000000001")}` },
        body: JSON.stringify({ handle: "test_user", tweet: "123456789", nonce }),
      }));
      assert.equal(response.status, 401);
    }
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    fetch.mock.restore();
  }
});
