/**
 * The owner key must survive the kill switch.
 *
 * `grant.json` is a single slot. For a grant that has never been replaced it is
 * the ONLY on-disk copy of the owner key — the key `merrymen recover` needs to
 * sweep funds out of the smart account. The CLI and the web API have archived
 * before deleting for months; the worker's own kill switch, reachable from a
 * Telegram message, did not, because the worker package had no archive path.
 *
 * These run against a real temp home rather than a mock: the thing being tested
 * is that a file exists on disk afterwards.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-archive-"));
process.env.MERRYMEN_HOME = HOME;
// loadGrantFile/archiveCurrentGrant prefer this when set; keep them on HOME.
delete process.env.MERRYMEN_GRANT_FILE;

const { archiveCurrentGrant, loadGrantFile } = await import("./grant");
const { homePaths } = await import("./home");

const ACCOUNT = "0xbC78E8b5d209Bf1D4706faEd06e155B5774275D7";
const OWNER_KEY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function writeGrant(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    homePaths.grant(),
    JSON.stringify({
      smartAccount: ACCOUNT,
      serialized: "0xserialized",
      demoOwnerPrivateKey: OWNER_KEY,
      chainId: 4663,
      ...extra,
    }),
    "utf8",
  );
}

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const kept = () => path.join(homePaths.grantsArchive(), `${ACCOUNT.toLowerCase()}.json`);

describe("archiveCurrentGrant", () => {
  it("keeps the owner key before anything deletes the grant", () => {
    writeGrant();
    const archived = archiveCurrentGrant();
    assert.deepEqual(archived, { kind: "archived", account: ACCOUNT });

    const kept = path.join(homePaths.grantsArchive(), `${ACCOUNT.toLowerCase()}.json`);
    assert.ok(existsSync(kept), "archive file should exist");
    // The point of the whole exercise: the key is still recoverable.
    assert.match(readFileSync(kept, "utf8"), new RegExp(OWNER_KEY));
  });

  it("survives the grant being deleted afterwards — the kill-switch sequence", () => {
    writeGrant();
    archiveCurrentGrant();
    rmSync(homePaths.grant(), { force: true });

    assert.equal(loadGrantFile(), null); // the agent is gone…
    const kept = path.join(homePaths.grantsArchive(), `${ACCOUNT.toLowerCase()}.json`);
    assert.ok(existsSync(kept)); // …and the funds are not stranded
  });

  it("writes owner-only, because the file holds a plaintext private key", () => {
    writeGrant();
    archiveCurrentGrant();
    const kept = path.join(homePaths.grantsArchive(), `${ACCOUNT.toLowerCase()}.json`);
    const mode = statSync(kept).mode & 0o777;
    // Windows does not honour POSIX bits; assert only where it means something.
    if (process.platform !== "win32") assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`);
  });

  it("the copy is grant.json BYTE FOR BYTE — BOM, whitespace and all — and no temp file is left", () => {
    // Not re-serialized: a copy that parses the same is not the file the
    // recover tooling and the owner were told is kept.
    const raw = "\ufeff" + JSON.stringify({ smartAccount: ACCOUNT, serialized: "0xs", demoOwnerPrivateKey: OWNER_KEY }, null, 4) + "\n";
    writeFileSync(homePaths.grant(), raw, "utf8");
    assert.equal(archiveCurrentGrant().kind, "archived");
    assert.deepEqual(readFileSync(kept()), readFileSync(homePaths.grant()));
    assert.deepEqual(readdirSync(homePaths.grantsArchive()).filter((n) => n.endsWith(".tmp")), []);
  });

  it("a same-account copy is REPLACED whole — a new file, 0600 even over a looser one, never truncated in place", () => {
    writeGrant({ note: "first" });
    archiveCurrentGrant();
    if (process.platform !== "win32") chmodSync(kept(), 0o644);
    const before = statSync(kept()).ino;
    writeGrant({ note: "second, and longer than the first so a truncate-and-write would show" });
    archiveCurrentGrant();
    assert.match(readFileSync(kept(), "utf8"), /second, and longer/);
    if (process.platform !== "win32") {
      // writeFileSync keeps the inode it truncates; only a rename installs a new one.
      assert.notEqual(statSync(kept()).ino, before, "rewritten in place");
      assert.equal(statSync(kept()).mode & 0o777, 0o600);
    }
  });

  it("NOTHING to keep: no grant.json, one that does not parse, one naming no account", () => {
    rmSync(homePaths.grant(), { force: true });
    assert.deepEqual(archiveCurrentGrant(), { kind: "nothing" });
    writeFileSync(homePaths.grant(), "{not json", "utf8");
    assert.deepEqual(archiveCurrentGrant(), { kind: "nothing" });
    // …and no file under a bogus name.
    writeFileSync(homePaths.grant(), JSON.stringify({ serialized: "0x", demoOwnerPrivateKey: OWNER_KEY }), "utf8");
    assert.deepEqual(archiveCurrentGrant(), { kind: "nothing" });
  });

  it("FAILED, not nothing, when there is a grant it cannot keep — and grant.json is left alone", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    // The two used to be the same `null`, and the kill switch deleted the
    // grant either way — on a full or read-only disk, the only owner key.
    writeGrant({ note: "must survive" });
    const before = readFileSync(homePaths.grant());
    mkdirSync(homePaths.grantsArchive(), { recursive: true });
    chmodSync(homePaths.grantsArchive(), 0o500);
    try {
      const r = archiveCurrentGrant();
      assert.equal(r.kind, "failed");
      assert.match(r.kind === "failed" ? r.why : "", /could not be written \(EACCES\)/);
      assert.deepEqual(readFileSync(homePaths.grant()), before, "archiving never touches grant.json");
    } finally {
      chmodSync(homePaths.grantsArchive(), 0o700);
    }
  });

  it("FAILED for a grant whose smartAccount is not an address — it holds a key, and ../ is not a file name", () => {
    writeFileSync(homePaths.grant(), JSON.stringify({ smartAccount: "../../escape", demoOwnerPrivateKey: OWNER_KEY }), "utf8");
    const r = archiveCurrentGrant();
    assert.equal(r.kind, "failed");
    assert.ok(!existsSync(path.join(HOME, "escape.json")) && !existsSync(path.join(path.dirname(HOME), "escape.json")));
  });
});
