import { TOUR_VERSION } from "@/lib/tour-version";
import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { GET, POST } from "./route";
import { mintSession } from "@/lib/auth";
import { resetTourStoreForTest } from "@/lib/tour-store";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const original = { home: process.env.MERRYMEN_HOME, database: process.env.DATABASE_URL, secret: process.env.MERRYMEN_SESSION_SECRET };
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "merrymen-tour-route-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetTourStoreForTest();
});
after(async () => {
  for (const [key, value] of Object.entries({ MERRYMEN_HOME: original.home, DATABASE_URL: original.database, MERRYMEN_SESSION_SECRET: original.secret })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetTourStoreForTest();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function request(tenant: typeof A | typeof B | null, method = "GET", body?: unknown) {
  return new Request("https://app.example.test/api/tour", {
    method, headers: tenant ? { cookie: `mm_session=${mintSession(tenant)}`, "content-type": "application/json" } : {},
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
it("signed-out requests return an ordinary response without recording another person's dismissal", async () => {
  assert.deepEqual(await (await GET(request(null))).json(), { done: false, signedIn: false });
  assert.deepEqual(await (await POST(request(null, "POST", { tenant: A, version: TOUR_VERSION }))).json(), { done: false, signedIn: false });
  assert.equal((await (await GET(request(A))).json()).done, false);
});
it("persists a signed-in dismissal across fresh store instances and isolates the next account", async () => {
  const saved = await POST(request(A, "POST", { tenant: A, version: TOUR_VERSION }));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { done: true, signedIn: true, tenant: A, version: TOUR_VERSION });
  resetTourStoreForTest();
  assert.equal((await (await GET(request(A))).json()).done, true);
  assert.equal((await (await GET(request(B))).json()).done, false);
});
it("rejects stale identity/version writes rather than dismissing a different account's tour", async () => {
  assert.equal((await POST(request(B, "POST", { tenant: A, version: TOUR_VERSION }))).status, 409);
  assert.equal((await POST(request(B, "POST", { tenant: B, version: 1 }))).status, 409);
  assert.equal((await (await GET(request(B))).json()).done, false);
});
it("returns a retryable failure when a dismissal cannot be persisted", async () => {
  const blocked = path.join(dir, "blocked"); await mkdir(blocked);
  await writeFile(path.join(blocked, "tour"), "not a directory");
  process.env.MERRYMEN_HOME = blocked; resetTourStoreForTest();
  const response = await POST(request(B, "POST", { tenant: B, version: TOUR_VERSION }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).done, undefined);
});
