/**
 * THE GRANT ARCHIVE IS ON DISK BEFORE grant.json IS REPLACED OR DELETED — AND A
 * KILL THAT COULD NOT MAKE ONE DOES NOT DELETE.
 *
 * grant.json is a single slot, and self-hosted it holds the OWNER key — the key
 * `merrymen recover` needs to sweep funds. Three writers copy it to
 * ~/.merrymen/grants/<smartAccount>.json first: the web route (POST replaces
 * grant.json, DELETE removes it), the worker's Telegram kill switch, and
 * `merrymen kill`. None of them synced the copy: a plain write sits in the page
 * cache, grant.json changed a moment later, and on a power loss a filesystem
 * with delayed allocation can keep that change and lose the copy's data. A
 * same-account copy was also rewritten in place (O_TRUNC), so a crash mid-write
 * truncated it.
 *
 * And a copy that could not be made at all read as "nothing to keep", so every
 * kill path deleted grant.json anyway.
 *
 * Pinned at the source for all three writers, run for the helper they share and
 * the CLI's copy of it, and run end to end for `merrymen kill` in a temp home.
 * The worker archiver itself is run by grant-archive.integration.test.ts; the
 * web route's POST and DELETE by web/src/app/api/grants/archive.test.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as cliAtomic from "../../cli/atomic-write.mjs";
import { fsyncDir, fsyncDirSync, writeFileAtomic, writeFileAtomicSync } from "./atomic-write";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const source = (rel: string) => codeOf(readFileSync(new URL(rel, import.meta.url), "utf8"));

const HELPER = source("./atomic-write.ts");
const CLI_HELPER = source("../../cli/atomic-write.mjs");
const GRANT = source("./grant.ts");
const INDEX = source("./index.ts");
const ROUTE = source("../../web/src/app/api/grants/route.ts");
const CLI = source("../../cli/bin.mjs");

/** From `head` to the end of its top-level function. */
function body(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone — re-point this test at what replaced it`);
  return src.slice(at, src.indexOf("\n}\n", at));
}
/** `a` appears, and before `b`. */
function before_(src: string, a: string, b: string, why: string): void {
  const ia = src.indexOf(a);
  const ib = src.indexOf(b);
  assert.ok(ia >= 0, `missing: ${a}`);
  assert.ok(ib >= 0, `missing: ${b}`);
  assert.ok(ia < ib, why);
}

const IN_PLACE_WRITE = /\b(?:writeFileSync|writeFile|writeSecret|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile)\s*\(/;
const posix = process.platform !== "win32";
const canLock = posix && process.getuid?.() !== 0;

describe("the helper: durable means synced, renamed, and the directory synced", () => {
  it("both spellings sync the directory after the rename, and only when asked", () => {
    for (const [name, fn] of [
      ["writeFileAtomicSync", body(HELPER, "export function writeFileAtomicSync(")],
      ["writeFileAtomic", body(HELPER, "export async function writeFileAtomic(")],
    ] as const) {
      const rename = fn.search(/\brename(?:Sync)?\(tmp, target\)/);
      const dirSync = fn.search(/if \(opts\.durable\) (?:await )?fsyncDir(?:Sync)?\(path\.dirname\(target\)\);/);
      assert.ok(rename > 0 && dirSync > rename, `${name}: the directory is synced after the rename that put the entry in it`);
      assert.match(fn, /if \(opts\.durable && !fsyncUnsupported\(e\)\) throw e;/, `${name}: a real fsync failure is an error when durable`);
    }
  });

  it("the CLI's copy does the same, and imports nothing from the worker", () => {
    const fn = body(CLI_HELPER, "export function writeFileAtomicSync(");
    assert.ok(fn.search(/if \(opts\.durable\) fsyncDirSync\(path\.dirname\(target\)\);/) > fn.search(/renameSync\(tmp, target\)/));
    assert.match(fn, /if \(opts\.durable && !fsyncUnsupported\(e\)\) throw e;/);
    assert.doesNotMatch(CLI_HELPER, /from "\.\.\/worker/);
  });

  const DURABLE_WRITERS: ReadonlyArray<{ name: string; write: (f: string, d: string) => void | Promise<void> }> = [
    { name: "writeFileAtomicSync", write: (f, d) => writeFileAtomicSync(f, d, 0o600, { durable: true }) },
    { name: "writeFileAtomic", write: (f, d) => writeFileAtomic(f, d, 0o600, { durable: true }) },
    { name: "the CLI's writeFileAtomicSync", write: (f, d) => cliAtomic.writeFileAtomicSync(f, d, 0o600, { durable: true }) },
  ];
  for (const { name, write } of DURABLE_WRITERS) {
    it(`${name} { durable }: byte for byte, 0600 over a looser file, a new inode, no temp file`, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-durable-"));
      try {
        const file = path.join(dir, "0xabc.json");
        writeFileSync(file, "old");
        if (posix) chmodSync(file, 0o644);
        const ino = statSync(file).ino;
        const data = "﻿{\n    \"demoOwnerPrivateKey\": \"0xkey\"\n}\n";
        await write(file, data);
        assert.deepEqual(readFileSync(file), Buffer.from(data, "utf8"));
        if (posix) {
          assert.equal(statSync(file).mode & 0o777, 0o600);
          assert.notEqual(statSync(file).ino, ino, "replaced, not truncated in place");
        }
        assert.deepEqual(readdirSync(dir), ["0xabc.json"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${name} { durable }: a directory that refuses the file throws, and leaves nothing`, { skip: !canLock }, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-durable-"));
      try {
        chmodSync(dir, 0o500);
        await assert.rejects(async () => write(path.join(dir, "0xabc.json"), "{}"), /EACCES/);
        chmodSync(dir, 0o700);
        assert.deepEqual(readdirSync(dir), []);
      } finally {
        chmodSync(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("fsyncDir, all three: a real directory syncs; a missing one is an error, not a silent pass", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-durable-"));
    try {
      fsyncDirSync(dir);
      await fsyncDir(dir);
      cliAtomic.fsyncDirSync(dir);
      if (posix) {
        const gone = path.join(dir, "nope");
        assert.throws(() => fsyncDirSync(gone), /ENOENT/);
        await assert.rejects(fsyncDir(gone), /ENOENT/);
        assert.throws(() => cliAtomic.fsyncDirSync(gone), /ENOENT/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("every archiver writes through the durable helper", () => {
  it("the worker's archiveCurrentGrant", () => {
    const fn = body(GRANT, "export function archiveCurrentGrant(");
    assert.doesNotMatch(fn, IN_PLACE_WRITE);
    assert.match(fn, /writeFileAtomicSync\(path\.join\(dir, `\$\{account\.toLowerCase\(\)\}\.json`\), raw, 0o600, \{ durable: true \}\);/);
    assert.match(fn, /if \(mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\) !== undefined\) fsyncDirSync\(path\.dirname\(dir\)\);/, "a new archive directory's own entry is synced too");
    assert.doesNotMatch(GRANT, /\bwriteFileSync\b/);
  });

  it("the web route's archiveCurrentGrant", () => {
    const fn = body(ROUTE, "async function archiveCurrentGrant(");
    assert.doesNotMatch(fn, IN_PLACE_WRITE);
    assert.match(fn, /await writeFileAtomic\(path\.join\(ARCHIVE_DIR, `\$\{account\.toLowerCase\(\)\}\.json`\), raw, 0o600, \{ durable: true \}\);/);
    assert.match(fn, /await fsyncDir\(path\.dirname\(ARCHIVE_DIR\)\)/);
    assert.doesNotMatch(ROUTE, /\bchmod\(/, "the mode is set on the temp file before it is visible");
  });

  it("the CLI's archiveCurrentGrant — no longer writeSecret, which writes in place", () => {
    const fn = body(CLI, "function archiveCurrentGrant(");
    assert.doesNotMatch(fn, IN_PLACE_WRITE);
    assert.match(fn, /writeFileAtomicSync\(path\.join\(GRANTS_ARCHIVE, `\$\{account\.toLowerCase\(\)\}\.json`\), raw, 0o600, \{ durable: true \}\);/);
    assert.match(CLI, /import \{ fsyncDirSync, writeFileAtomicSync \} from "\.\/atomic-write\.mjs";/);
  });
});

describe("grant.json changes only after the archive — and a kill without one does not delete", () => {
  it("web POST: archive, then replace; a failed archive is logged and arming goes on (best-effort, by design)", () => {
    const post = body(ROUTE, "export async function POST(");
    before_(post, "const kept = await archiveCurrentGrant();", "await writeFileAtomic(GRANT_FILE,", "the copy is made before grant.json is replaced");
    assert.match(post, /if \(kept\.kind === "failed"\) \{\s*console\.error\(/);
  });

  it("web DELETE: archive, then remove; a failed archive pauses, answers 409, and removes nothing", () => {
    const del = body(ROUTE, "export async function DELETE(");
    const refusal = del.slice(del.indexOf('if (kept.kind === "failed") {'));
    before_(del, "const kept = await archiveCurrentGrant();", "await rm(GRANT_FILE, { force: true });", "archive first");
    before_(refusal, "return NextResponse.json(", "await rm(GRANT_FILE", "the refusal returns before the delete");
    assert.match(refusal, /writeFile\(homePaths\.paused\(\), "paused", "utf8"\)/);
    assert.match(refusal, /\{ status: 409 \}/);
  });

  it("the worker's Telegram /kill: archive, then remove; a failed archive pauses and returns first", () => {
    const kill = INDEX.slice(INDEX.indexOf("const archive = archiveCurrentGrant();"), INDEX.indexOf("return { ok: true, archived };"));
    assert.ok(kill.length > 0, "the self-hosted kill is gone — re-point this test");
    const refusal = kill.slice(kill.indexOf('if (archive.kind === "failed") {'));
    before_(refusal, "setPaused(true);", "rmSync(homePaths.grant()", "paused before anything else");
    before_(refusal, "return { ok: false, reason: archive.why, archiveFailed: { why: archive.why, paused } };", "rmSync(homePaths.grant()", "returns before the delete");
  });

  it("merrymen kill: archive, then remove; a failed archive pauses and returns first", () => {
    const kill = body(CLI, "async function kill(");
    const refusal = kill.slice(kill.indexOf('if (archive.kind === "failed") {'));
    before_(kill, "const archive = archiveCurrentGrant();", "rmSync(GRANT, { force: true });", "archive first");
    before_(refusal, 'writeFileSync(path.join(HOME, "paused"), "paused", "utf8");', "rmSync(GRANT", "paused first");
    before_(refusal, "return;", "rmSync(GRANT", "returns before the delete");
  });
});

/**
 * `merrymen kill` itself, in a temp home: MERRYMEN_HOME is always set on the
 * child, so this can never reach the real ~/.merrymen.
 */
describe("merrymen kill, end to end", () => {
  const BIN = fileURLToPath(new URL("../../cli/bin.mjs", import.meta.url));
  const ACCOUNT = "0xbC78E8b5d209Bf1D4706faEd06e155B5774275D7";
  let home = "";
  before(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "merrymen-cli-kill-"));
    writeFileSync(path.join(home, ".welcomed"), "test"); // skip the first-run greeting
  });
  after(() => {
    if (existsSync(path.join(home, "grants"))) chmodSync(path.join(home, "grants"), 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  const grantFile = () => path.join(home, "grant.json");
  const archiveFile = () => path.join(home, "grants", `${ACCOUNT.toLowerCase()}.json`);
  const kill = () =>
    spawnSync(process.execPath, [BIN, "kill"], {
      input: "y\n",
      env: { ...process.env, MERRYMEN_HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });

  it("keeps a byte-for-byte 0600 copy, then removes grant.json", () => {
    const raw = JSON.stringify({ smartAccount: ACCOUNT, serialized: "0xs", demoOwnerPrivateKey: "0xkey-one" }, null, 2);
    writeFileSync(grantFile(), raw);
    const r = kill();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /grant destroyed/);
    assert.equal(existsSync(grantFile()), false);
    assert.equal(readFileSync(archiveFile(), "utf8"), raw);
    if (posix) assert.equal(statSync(archiveFile()).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(path.join(home, "grants")).filter((n) => n.endsWith(".tmp")), []);
  });

  it("an archive it cannot write: grant.json is KEPT byte for byte, trading paused, exit 1", { skip: !canLock }, () => {
    const raw = JSON.stringify({ smartAccount: ACCOUNT, serialized: "0xs", demoOwnerPrivateKey: "0xkey-two" });
    writeFileSync(grantFile(), raw);
    rmSync(path.join(home, "paused"), { force: true });
    mkdirSync(path.join(home, "grants"), { recursive: true });
    chmodSync(path.join(home, "grants"), 0o500);
    try {
      const r = kill();
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /grant NOT destroyed — the archive could not be written \(EACCES\)/);
      assert.match(r.stdout, /Trading is paused instead/);
      assert.equal(readFileSync(grantFile(), "utf8"), raw, "the only copy of the owner key is still there");
      assert.ok(existsSync(path.join(home, "paused")), "and the worker's pause marker is set");
    } finally {
      chmodSync(path.join(home, "grants"), 0o700);
    }
  });
});
