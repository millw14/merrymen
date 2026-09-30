import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, it } from "node:test";
import { wrapSqlite } from "../../../../../worker/src/db";
import { writeHostedPerpsRecovery } from "../../../../../worker/src/hosted-perps-recovery";

const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_SESSION_SECRET"].map((key) => [key, process.env[key]]));
const home = mkdtempSync(path.join(tmpdir(), "mm-recovery-status-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_SESSION_SECRET = "test-session-secret-for-recovery-status-only";
delete process.env.DATABASE_URL;
const raw = new DatabaseSync(path.join(home, "merrymen.db"));
const db = wrapSqlite(raw);
const A = `0x${"a1".repeat(20)}` as `0x${string}`;
const B = `0x${"b2".repeat(20)}` as `0x${string}`;
let GET: typeof import("./route").GET;
let mintSession: typeof import("@/lib/auth").mintSession;
let SESSION_COOKIE: string;
before(async () => {
  await writeHostedPerpsRecovery(db, { tenant: A, account: `0x${"c3".repeat(20)}`, ok: false });
  ({ GET } = await import("./route"));
  ({ mintSession, SESSION_COOKIE } = await import("@/lib/auth"));
});
after(() => {
  raw.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

it("the real hosted status route only returns the authenticated owner's recovery notice, even without a grant", async () => {
  const request = (owner?: `0x${string}`) => new Request("http://localhost/api/grants", owner ? { headers: { cookie: `${SESSION_COOKIE}=${mintSession(owner)}` } } : {});
  const anonymous = await GET(request());
  assert.deepEqual(await anonymous.json(), { exists: false });
  const mine = await GET(request(A));
  assert.match(mine.headers.get("cache-control") ?? "", /no-store/);
  const status = await mine.json();
  assert.equal(status.exists, false);
  assert.equal(status.perpsRecovery.state, "paused");
  assert.deepEqual(await (await GET(request(B))).json(), { exists: false });
});
