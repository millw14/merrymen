import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";

const A = `0x${"a".repeat(40)}` as `0x${string}`;
const B = `0x${"b".repeat(40)}` as `0x${string}`;
const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"].map((key) => [key, process.env[key]]));
let home: string;
let GET: (req: Request) => Promise<Response>;
let auth: typeof import("@/lib/auth");

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-feed-tenant-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  delete process.env.DATABASE_URL;
  auth = await import("@/lib/auth");
  ({ GET } = await import("./route"));
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

it("marks each hosted empty feed with the authenticated tenant", async () => {
  for (const tenant of [A, B]) {
    const response = await GET(new Request("https://app.merrymen.dev/api/feed", {
      headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}` },
    }));
    assert.equal(response.status, 200);
    const feed = await response.json() as { source: string; tenant?: string | null };
    assert.equal(feed.source, "none");
    assert.equal(feed.tenant, tenant);
  }
});

it("marks a signed-out hosted feed as unowned", async () => {
  const response = await GET(new Request("https://app.merrymen.dev/api/feed"));
  const feed = await response.json() as { tenant?: string | null };
  assert.equal(feed.tenant, null);
});
