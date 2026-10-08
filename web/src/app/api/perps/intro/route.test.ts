import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { mintSession } from "@/lib/auth";
import { resetPerpsIntroStoreForTest } from "@/lib/perps-intro-store";
import { POST } from "./route";
import { GET as session } from "../../auth/session/route";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const keys = ["MERRYMEN_HOME", "DATABASE_URL", "MERRYMEN_SESSION_SECRET", "MERRYMEN_HOSTED", "MERRYMEN_PUBLIC_ORIGIN"] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let home: string;
before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "mm-intro-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.MERRYMEN_HOSTED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  resetPerpsIntroStoreForTest();
});
after(async () => {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  resetPerpsIntroStoreForTest();
  await rm(home, { recursive: true, force: true });
});
function req(tenant: typeof A | typeof B | null, owner: string, origin = "https://app.test") {
  return new Request("https://app.test/api/perps/intro", { method: "POST", headers: { origin, "content-type": "application/json", ...(tenant ? { cookie: `mm_session=${mintSession(tenant)}` } : {}) }, body: JSON.stringify({ owner }) });
}
it("authenticates and rejects cross-origin or stale-identity claims before persistence", async () => {
  assert.equal((await POST(req(null, A))).status, 401);
  assert.equal((await POST(req(A, A, "https://other.test"))).status, 403);
  assert.equal((await POST(req(A, B))).status, 409);
  const malformed = req(A, A); malformed.headers.set("cookie", "mm_session=%E0%A4%A");
  assert.equal((await POST(malformed)).status, 401);
});
it("only one concurrent request plays and fresh server instances retain the claim", async () => {
  const responses = await Promise.all(Array.from({ length: 12 }, () => POST(req(A, A))));
  const bodies = await Promise.all(responses.map(res => res.json()));
  assert.equal(bodies.filter(body => body.play).length, 1);
  assert.ok(bodies.every(body => body.owner === A));
  assert.ok(responses.every(res => res.headers.get("Cache-Control") === "private, no-store"));
  resetPerpsIntroStoreForTest();
  assert.deepEqual(await (await POST(req(A, A))).json(), { owner: A, play: false });
  assert.deepEqual(await (await POST(req(B, B))).json(), { owner: B, play: true });
});
it("local operator has a persistent separate identity without a grant", async () => {
  delete process.env.MERRYMEN_HOSTED;
  assert.equal((await POST(req(null, A))).status, 409);
  assert.deepEqual(await (await POST(req(null, "local"))).json(), { owner: "local", play: true });
  resetPerpsIntroStoreForTest();
  assert.deepEqual(await (await POST(req(null, "local"))).json(), { owner: "local", play: false });
  process.env.MERRYMEN_HOSTED = "1";
});
it("does not claim playback when storage is unavailable", async () => {
  const broken = path.join(home, "broken"); await mkdir(broken);
  await writeFile(path.join(broken, "perps-intro"), "not a directory");
  process.env.MERRYMEN_HOME = broken; resetPerpsIntroStoreForTest();
  assert.equal((await POST(req(B, B))).status, 503);
  process.env.MERRYMEN_HOME = home; resetPerpsIntroStoreForTest();
});
it("session identity is stable, private and no-store, including malformed cookies", async () => {
  const response = await session(req(A, A));
  assert.deepEqual(await response.json(), { hosted: true, address: A });
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const bad = req(A, A); bad.headers.set("cookie", "mm_session=%");
  assert.deepEqual(await (await session(bad)).json(), { hosted: true, address: null });
});

it("uses the actual local Host when Next normalizes loopback URLs, without accepting another origin", async () => {
  delete process.env.MERRYMEN_HOSTED;
  process.env.MERRYMEN_PUBLIC_ORIGIN = "https://configured.example";
  const request = (origin: string, host = "127.0.0.1:3100", site = "same-origin") => new Request("http://localhost:3100/api/perps/intro", {
    method: "POST", headers: { origin, host, "sec-fetch-site": site }, body: JSON.stringify({ owner: "local" }),
  });
  assert.equal((await POST(request("http://127.0.0.1:3100"))).status, 200);
  assert.equal((await POST(request("http://localhost:3100", "localhost:3100"))).status, 200);
  assert.equal((await POST(request("http://localhost:3100"))).status, 403);
  assert.equal((await POST(request("http://127.0.0.1:3101"))).status, 403);
  assert.equal((await POST(request("http://127.0.0.1:3100", "127.0.0.1:3100", "same-site"))).status, 403);
  assert.equal((await POST(request("http://127.0.0.1:3100", "evil.test@127.0.0.1:3100"))).status, 403);
  process.env.MERRYMEN_HOSTED = "1";
  const hosted = request("http://127.0.0.1:3100"); hosted.headers.set("cookie", `mm_session=${mintSession(A)}`);
  assert.equal((await POST(hosted)).status, 403, "hosted claims still require the configured canonical origin");
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
});
