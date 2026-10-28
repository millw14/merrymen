/**
 * GET /api/version, through the real handler: the package version as before,
 * plus the commit and branch Railway deployed — read per request, never
 * cached, and null rather than echoed when they are not what they claim.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { GET } from "./route";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const KEYS = ["RAILWAY_GIT_COMMIT_SHA", "RAILWAY_GIT_BRANCH"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const WEB = path.join(import.meta.dirname, "..", "..", "..", "..");
const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(WEB, "..", "package.json"), "utf8")) as { version: string }).version;

async function version(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const res = await GET();
  return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/version", () => {
  // The route reads ../package.json from its cwd, which is web/ at runtime.
  const cwd = process.cwd();
  before(() => process.chdir(WEB));
  after(() => process.chdir(cwd));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("names the package version, the commit and the branch, and is never cached", async () => {
    const r = await version({ RAILWAY_GIT_COMMIT_SHA: SHA, RAILWAY_GIT_BRANCH: "main" });
    assert.equal(r.status, 200);
    assert.equal(r.cache, "no-store");
    assert.deepEqual(r.body, { version: PACKAGE_VERSION, commit: SHA, branch: "main" });
  });

  it("reads the deployment per request, not once", async () => {
    assert.deepEqual((await version({ RAILWAY_GIT_COMMIT_SHA: SHA, RAILWAY_GIT_BRANCH: "main" })).body.commit, SHA);
    const next = "f".repeat(40);
    assert.deepEqual((await version({ RAILWAY_GIT_COMMIT_SHA: next, RAILWAY_GIT_BRANCH: "codex/recovery-replies" })).body,
      { version: PACKAGE_VERSION, commit: next, branch: "codex/recovery-replies" });
  });

  it("is null for both off a git deploy", async () => {
    assert.deepEqual((await version({})).body, { version: PACKAGE_VERSION, commit: null, branch: null });
  });

  it("reports a full hex commit, in lower case, and nothing else", async () => {
    assert.equal((await version({ RAILWAY_GIT_COMMIT_SHA: SHA.toUpperCase() })).body.commit, SHA);
    for (const sha of ["", SHA.slice(0, 12), `${SHA}0`, `${SHA.slice(0, 39)}g`, ` ${SHA}`, `${SHA}\n`, "not a sha; rm -rf"]) {
      assert.equal((await version({ RAILWAY_GIT_COMMIT_SHA: sha })).body.commit, null, JSON.stringify(sha));
    }
  });

  it("reports a plain branch name, and nothing else", async () => {
    for (const branch of ["main", "claude/deploy-guard", "codex/recovery-casual-replies", "release-1.2_x"]) {
      assert.equal((await version({ RAILWAY_GIT_BRANCH: branch })).body.branch, branch);
    }
    for (const branch of ["", "-main", "/main", "a..b", "main\n", "main branch", "<script>", "x".repeat(201), "main;id"]) {
      assert.equal((await version({ RAILWAY_GIT_BRANCH: branch })).body.branch, null, JSON.stringify(branch));
    }
  });
});
