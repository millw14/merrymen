import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { KILL_PAUSE_NOTE } from "@merrymen/home";

/**
 * SELF-HOSTED, THE OUTGOING GRANT IS KEPT — ON DISK, BYTE FOR BYTE — BEFORE
 * grant.json CHANGES; AND THE KILL SWITCH DOES NOT DELETE WHAT IT COULD NOT KEEP.
 *
 * grant.json holds the owner key, and POST replaces it and DELETE removes it.
 * Both copy it to ~/.merrymen/grants/<account>.json first; the copy used to be
 * a plain writeFile that nothing synced, and a copy that failed outright was
 * ignored — so the kill switch deleted the only key on a full or read-only disk.
 * Driven through the real handlers against a real home. The durability steps
 * themselves (fsync, rename, directory sync) are pinned and run in
 * worker/src/grant-archive-durable.test.ts.
 */
const A = "0xbC78E8b5d209Bf1D4706faEd06e155B5774275D7";
const B = "0x1111111111111111111111111111111111111111";
const posix = process.platform !== "win32";
const canLock = posix && process.getuid?.() !== 0;

let home = "";
let POST: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, grant: process.env.MERRYMEN_GRANT_FILE };

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-archive-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_GRANT_FILE;
  // After the env: the route resolves its paths when it loads.
  ({ POST, DELETE } = await import("./route"));
});
after(() => {
  for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["MERRYMEN_GRANT_FILE", saved.grant]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (existsSync(archiveDir())) chmodSync(archiveDir(), 0o700);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const grantFile = () => path.join(home, "grant.json");
const archiveDir = () => path.join(home, "grants");
const archiveOf = (account: string) => path.join(archiveDir(), `${account.toLowerCase()}.json`);
const pausedFile = () => path.join(home, "paused");
/** Not what JSON.stringify would write — so a copy that re-serialized would show. */
const rawGrant = (account: string, key: string) =>
  `{\n    "smartAccount": "${account}",\n    "serialized": "0xserialized",\n    "demoOwnerPrivateKey": "${key}",\n    "chainId": 4663\n}\n`;

beforeEach(() => {
  if (existsSync(archiveDir())) chmodSync(archiveDir(), 0o700);
  rmSync(archiveDir(), { recursive: true, force: true });
  rmSync(pausedFile(), { force: true });
});

const post = (grant: unknown) =>
  POST(new Request("http://localhost/api/grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(grant) }));
const del = () => DELETE(new Request("http://localhost/api/grants", { method: "DELETE" }));

describe("POST /api/grants, self-hosted, replacing a grant", () => {
  it("the outgoing grant is archived byte for byte, 0600, and only then replaced", async () => {
    const outgoing = rawGrant(A, "0xowner-key-A");
    writeFileSync(grantFile(), outgoing);
    const res = await post({ smartAccount: B, serialized: "0xserialized", demoOwnerPrivateKey: "0xowner-key-B", chainId: 4663 });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(readFileSync(archiveOf(A), "utf8"), outgoing, "the copy is the file, not a re-serialization of it");
    if (posix) assert.equal(statSync(archiveOf(A)).mode & 0o777, 0o600);
    assert.equal((JSON.parse(readFileSync(grantFile(), "utf8")) as { smartAccount: string }).smartAccount, B);
    assert.deepEqual(readdirSync(archiveDir()).filter((n) => n.endsWith(".tmp")), []);
  });

  it("an archive that cannot be written does not block arming — by design — and is said out loud", { skip: !canLock }, async () => {
    writeFileSync(grantFile(), rawGrant(A, "0xowner-key-A"));
    mkdirSync(archiveDir());
    chmodSync(archiveDir(), 0o500);
    const logged: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      const res = await post({ smartAccount: B, serialized: "0xserialized", chainId: 4663 });
      assert.equal(res.status, 200);
      assert.match(logged.join("\n"), /the outgoing grant was NOT archived \(the archive could not be written \(EACCES\)\)/);
    } finally {
      console.error = error;
      chmodSync(archiveDir(), 0o700);
    }
  });
});

describe("DELETE /api/grants, self-hosted — the kill switch", () => {
  it("archives byte for byte, 0600, then removes grant.json", async () => {
    const live = rawGrant(A, "0xowner-key-A");
    writeFileSync(grantFile(), live);
    const res = await del();
    assert.equal(res.status, 200);
    assert.equal(existsSync(grantFile()), false);
    assert.equal(readFileSync(archiveOf(A), "utf8"), live);
    if (posix) assert.equal(statSync(archiveOf(A)).mode & 0o777, 0o600);
  });

  it("an archive it cannot write: 409, grant.json KEPT byte for byte, and trading paused instead", { skip: !canLock }, async () => {
    const live = rawGrant(A, "0xowner-key-A");
    writeFileSync(grantFile(), live);
    mkdirSync(archiveDir());
    chmodSync(archiveDir(), 0o500);
    try {
      const res = await del();
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error?: string; paused?: boolean };
      assert.match(body.error ?? "", /^The grant was NOT deleted: the archive could not be written \(EACCES\)/);
      assert.equal(body.paused, true);
      assert.equal(readFileSync(grantFile(), "utf8"), live, "the only copy of the owner key is still there");
      assert.equal(readFileSync(pausedFile(), "utf8"), KILL_PAUSE_NOTE, "the marker the worker honours, saying a kill set it");
    } finally {
      chmodSync(archiveDir(), 0o700);
    }
    // Fixed, and killed again: it goes through, and the stand-in pause is lifted,
    // or the next grant would arm paused with nothing saying why.
    const again = await del();
    assert.equal(again.status, 200);
    assert.equal(existsSync(grantFile()), false);
    assert.equal(readFileSync(archiveOf(A), "utf8"), live);
    assert.equal(existsSync(pausedFile()), false);
  });

  it("a pause the owner set survives a kill that went through", async () => {
    writeFileSync(grantFile(), rawGrant(A, "0xowner-key-A"));
    writeFileSync(pausedFile(), "paused");
    assert.equal((await del()).status, 200);
    assert.equal(readFileSync(pausedFile(), "utf8"), "paused");
  });

  it("nothing to archive is not a refusal: no grant, or one naming no account, is simply removed", async () => {
    rmSync(grantFile(), { force: true });
    assert.equal((await del()).status, 200);
    writeFileSync(grantFile(), JSON.stringify({ serialized: "0x" }));
    assert.equal((await del()).status, 200);
    assert.equal(existsSync(grantFile()), false);
  });
});
