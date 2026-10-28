/**
 * CI BUILDS AND TESTS THE SOLANA VAULT PROGRAM, ON A TOOLCHAIN IT CHECKED.
 *
 * The 2026-10-18 audit (GAP4-1) found no workflow ran cargo or cargo-build-sbf:
 * the vault's native tests, SBF build and custody runtime tests ran only by
 * hand. These tests pin the CI jobs that now do (their steps, order, cache and
 * place in the required `app` check) and the scripts they call: downloads kept
 * only on a size and SHA-256 match, no unverified toolchain fetched later, the
 * rebuild done from tracked source elsewhere, and the artifact tied to the
 * program ID its source declares. No test here uses the network: curl and
 * cargo-build-sbf are replaced by stubs on PATH.
 *
 * Part of `npm test`, so CI's app · tests shards run it on every pull request;
 * `solana · test` also runs it first: node --test scripts/ci/solana-ci.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  anchorProgramIds, base58Decode, CANDIDATE_LABEL, candidateArtifactName, declaredProgramId, declaresLocalTestId, LOCAL_TEST_SOURCE,
  localTestProgramId, programRecord, provenance, readLocalTestProgramId, readToolchain, releaseLine, releaseStatus, RELEASE_RULE,
  RUNNER_IMAGE_NOTE, runnerImage, runnerImageLine, runnerImageSection,
} from "./solana-program-record.mjs";
import { releaseArtifactName, releaseRecord, releaseSource } from "./solana-release.mjs";
import { checkRuntimeTests, countTests, OPTIONAL_TARGETS, parseResults, runtimeTargets, skippedTargets } from "./solana-runtime-tests.mjs";
import { decide, solanaPaths } from "./solana-paths.mjs";
import {
  ARTIFACT, assess, compareCommitted, differences, LINUX_HOST, LINUX_MANIFEST, MANIFEST_TRAILER, manifestTrailer, verifyRecorded,
} from "./solana-linux-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
const pinsText = readFileSync(join(here, "solana-toolchain.env"), "utf8");
const pins = Object.fromEntries(
  pinsText.split("\n").map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]),
);

/** A job's body: the lines indented under `  <name>:` up to the next top-level key. */
function job(name) {
  return new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n|\\n)*)`, "m").exec(ci)?.[1] ?? "";
}
/** Every job id in ci.yml. */
function jobIds() {
  const jobs = /^jobs:\n([\s\S]*)$/m.exec(ci)?.[1] ?? "";
  return [...jobs.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(m => m[1]);
}
/** A job's steps, each the text from its `      - ` line to the next. */
function steps(body) {
  const at = body.indexOf("    steps:\n");
  if (at < 0) return [];
  return body.slice(at + "    steps:\n".length).split(/^(?= {6}- )/m)
    .map(t => t.replace(/^(?: {6}#.*\n|\n)+/, "").replace(/(?:\n {6}#.*|\n)+$/, ""))
    .filter(t => t.startsWith("      - "));
}
/** The app job's aggregation script, as bash will run it once Actions fills in the needs results. */
function appScript(results) {
  const body = job("app");
  const block = /run: \|\n((?: {10}.*\n|\n)*)/.exec(body)?.[1] ?? "";
  return block.split("\n").map(l => l.slice(10)).join("\n")
    .replace(/\$\{\{ needs\.([a-z0-9-]+)\.result \}\}/g, (_, id) => {
      assert.ok(Object.hasOwn(results, id), `no result given for ${id}`);
      return results[id];
    });
}

/** The quoted file globs of a test command. */
const quoted = text => [...text.matchAll(/"([^"]+)"/g)].map(m => m[1]);
/** app · tests' sharded tsx --test command. */
function appTestCommand() {
  const shards = steps(job("app-test")).find(s => s.includes("--test-shard=")) ?? "";
  return /^ {8}run: (npx tsx --test --test-shard=\$\{\{ matrix\.shard \}\}\/4 .*)$/m.exec(shards)?.[1] ?? "";
}

const scratch = mkdtempSync(join(tmpdir(), "merrymen-solana-ci-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = label => {
  const dir = join(scratch, `${label}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
};

/**
 * The environment for a script under test: none of the real job's GITHUB_*
 * variables (its output files, event, ref or commit), only what a test passes.
 */
function env(extra = {}) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_")));
  return { ...e, ...extra };
}
function run(cmd, args, extra = {}, cwd = repo) {
  return spawnSync(cmd, args, { cwd, env: env(extra), encoding: "utf8" });
}
function stub(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return dir;
}
const sha256 = buf => createHash("sha256").update(buf).digest("hex");
/** SOLANA_VAULT_LOCAL_TEST_PROGRAM, as the scripts read it from packages/core/src/solana-live.ts. */
const LOCAL = readLocalTestProgramId();
/** Another program ID (SPL Token's), standing in for a production declare_id. */
const PRODUCTION = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** packages/core/src/solana-live.ts as the scripts parse it, declaring `id` as the local test program. */
const solanaLive = id => `/** Local test identity only. */\nexport const SOLANA_VAULT_LOCAL_TEST_PROGRAM =\n  "${id}";\nexport const SOLANA_VAULT_RELEASES = [];\n`;

describe("the CI jobs", () => {
  const test = job("solana-test");
  const rebuild = job("solana-rebuild");
  const app = job("app");

  it("pins every action in ci.yml to a full commit SHA", () => {
    const uses = [...ci.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map(m => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
  });

  it("solana · test installs the checked toolchain, runs test.sh, records the Linux manifest, then proves nothing unchecked was fetched", () => {
    assert.ok(test, "ci.yml has no solana-test job");
    const order = [
      "uses: actions/checkout@",
      // Before anything is built, so a run that fails in the Test step names its image.
      "run: node scripts/ci/solana-program-record.mjs --runner-image\n",
      "run: node --test scripts/ci/solana-ci.test.mjs",
      "run: scripts/ci/solana-toolchain.sh install ",
      "uses: actions/cache@",
      "contracts/solana/test.sh 2>&1 | tee \"$RUNNER_TEMP/solana-test.log\"",
      "run: node scripts/ci/solana-runtime-tests.mjs \"$RUNNER_TEMP/solana-test.log\" contracts/solana/runtime-tests",
      "node scripts/ci/solana-program-record.mjs contracts/solana contracts/solana/target/deploy/merrymen_vault.so ",
      "contracts/solana/build.sh --record\n",
      "node scripts/ci/solana-linux-manifest.mjs verify contracts/solana ",
      // After every cargo-build-sbf run, --record's second build included.
      "run: scripts/ci/solana-toolchain.sh check",
      // The outcome names the artifact, so it comes before the upload.
      "release=$(node scripts/ci/solana-linux-manifest.mjs report contracts/solana contracts/solana/target/deploy/merrymen_vault.build.json)",
      "uses: actions/upload-artifact@",
      // Last: a manifest that differs from the committed one is uploaded first.
      "run: node scripts/ci/solana-linux-manifest.mjs compare contracts/solana",
    ].map(s => [s, test.indexOf(s)]);
    for (const [s, at] of order) assert.ok(at >= 0, `solana-test lacks ${s}`);
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} must come before ${order[i][0]}`);
    assert.match(test, /^ {4}outputs:\n {6}sha256: \$\{\{ steps\.record\.outputs\.sha256 \}\}$/m);
    // HEAD and its first parent: the comparison fails when HEAD deleted a
    // Linux manifest its parent had, and refuses a checkout without the parent.
    const checkout = steps(test).find(s => s.includes("uses: actions/checkout@")) ?? "";
    assert.match(checkout, /uses: actions\/checkout@\S+.*\n {8}if: needs\.solana-paths\.outputs\.run == 'true'\n {8}with:\n {10}fetch-depth: 2$/);
    assert.doesNotMatch(checkout, /ref:/);
    assert.match(test, /CARGO_HOME=\$\(realpath /);
    // Without pipefail the step would take tee's status, and a failing test.sh would pass.
    assert.match(test, /run: \|\n {10}set -o pipefail\n {10}contracts\/solana\/test\.sh 2>&1 \| tee "\$RUNNER_TEMP\/solana-test\.log"\n/);
  });

  it("gives test.sh no environment override that build.sh refuses", () => {
    // build.sh stops on RUSTFLAGS, CARGO_ENCODED_RUSTFLAGS, CARGO_BUILD_RUSTFLAGS,
    // CARGO_BUILD_TARGET_DIR and any CARGO_PROFILE_* or CARGO_TARGET_* variable:
    // set anywhere in the job, the vault build fails before it starts.
    const build = readFileSync(join(repo, "contracts/solana/build.sh"), "utf8");
    assert.match(build, /for name in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET_DIR; do/);
    assert.match(build, /\^CARGO_\(PROFILE\|TARGET\)_\[A-Z0-9_\]\+=/);
    const refused = /^\s+(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_TARGET_DIR|CARGO_PROFILE_[A-Z0-9_]+|CARGO_TARGET_[A-Z0-9_]+):/m;
    assert.doesNotMatch(test, refused);
    assert.doesNotMatch(test, /(RUSTFLAGS|CARGO_BUILD_TARGET_DIR|CARGO_PROFILE_[A-Z0-9_]+|CARGO_TARGET_[A-Z0-9_]+)=/);
    const top = /^env:\n((?: {2}.*\n)*)/m.exec(ci)?.[1] ?? "";
    assert.doesNotMatch(top, refused);
  });

  it("names the artifact for its commit and run, and at most candidate-unconfirmed, never release", () => {
    // The release rule says CI never runs on a tag push. Pushes run on main only.
    const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(ci)?.[1] ?? "";
    assert.match(on, /^ {2}push:\n {4}branches: \[main\]\n(?! {4})/m);
    assert.doesNotMatch(on, /tags/);
    const upload = /uses: actions\/upload-artifact@\S+.*\n((?: {8}.*\n)*)/.exec(test)?.[1] ?? "";
    assert.match(upload, /^ {10}name: \$\{\{ steps\.linux-manifest\.outputs\.artifact \}\}$/m);
    // The label comes from the Linux manifest comparison, which decides it
    // from the run and the outcome (solana-linux-manifest.mjs report), and
    // nothing but its two values reaches the name, which also carries the
    // commit and the run. Neither value says release: this upload comes
    // before app has checked the rebuild's hash, so only solana · release,
    // after app, does. The record step, which cannot know the outcome, gives no label.
    const label = steps(test).find(s => s.includes("id: linux-manifest")) ?? "";
    assert.match(label, /^ {10}release=\$\(node scripts\/ci\/solana-linux-manifest\.mjs report contracts\/solana contracts\/solana\/target\/deploy\/merrymen_vault\.build\.json\)\n {10}case "\$release" in candidate-unconfirmed\|not-a-release\) ;; \*\) echo "::error::[^"]*"; exit 1 ;; esac\n {10}echo "release=\$release" >> "\$GITHUB_OUTPUT"\n {10}echo "artifact=merrymen-vault-sbf-\$release-\$GITHUB_SHA-run\$GITHUB_RUN_ID\.\$GITHUB_RUN_ATTEMPT" >> "\$GITHUB_OUTPUT"$/m);
    assert.equal(candidateArtifactName(CANDIDATE_LABEL, { commit: "c", runId: "7", runAttempt: "2" }), "merrymen-vault-sbf-candidate-unconfirmed-c-run7.2",
      "solana-release.mjs expects the name this step writes");
    assert.match(test, /^ {4}outputs:\n {6}sha256: \$\{\{ steps\.record\.outputs\.sha256 \}\}\n(?: {6}#.*\n)* {6}release: \$\{\{ steps\.linux-manifest\.outputs\.release \}\}\n {6}artifact: \$\{\{ steps\.linux-manifest\.outputs\.artifact \}\}$/m);
    const record = steps(test).find(s => s.includes("id: record")) ?? "";
    assert.doesNotMatch(record, /release/);
    assert.doesNotMatch(test, /steps\.record\.outputs\.release/);
  });

  it("uploads only the artifact, its record and the Linux manifest, never the throwaway keypair beside them", () => {
    const upload = /uses: actions\/upload-artifact@\S+.*\n((?: {8}.*\n)*)/.exec(test)?.[1] ?? "";
    assert.match(upload, /if-no-files-found: error/);
    const files = [...upload.matchAll(/^ {12}(\S+)$/gm)].map(m => m[1]);
    assert.deepEqual(files, [
      "contracts/solana/target/deploy/merrymen_vault.so",
      "contracts/solana/target/deploy/merrymen_vault.build.json",
      "contracts/solana/build-manifests/Linux-x86_64.json",
    ]);
  });

  it("records the Linux build manifest for the tested artifact, uploads it, then compares it with the committed one", () => {
    const all = steps(test);
    const manifest = all.find(s => s.includes("- name: Linux build manifest")) ?? "";
    assert.equal(manifest, [
      "      - name: Linux build manifest",
      "        if: needs.solana-paths.outputs.run == 'true'",
      "        run: |",
      "          contracts/solana/build.sh --record",
      "          node scripts/ci/solana-linux-manifest.mjs verify contracts/solana \"$VAULT_TESTED_SHA256\"",
      "        env:",
      "          CARGO_INCREMENTAL: \"0\"",
      "          VAULT_TESTED_SHA256: ${{ steps.record.outputs.sha256 }}",
    ].join("\n"));
    // The comparison runs twice: before the upload, where its outcome names
    // the artifact and nothing fails on it, and as the last step, which fails
    // on it. So a run that fails it has still handed the owner the manifest
    // to review and commit, under a name that is never a candidate's.
    assert.equal(all.at(-1), [
      "      - name: Linux manifest matches the committed one",
      "        if: needs.solana-paths.outputs.run == 'true'",
      "        run: node scripts/ci/solana-linux-manifest.mjs compare contracts/solana",
    ].join("\n"));
    assert.match(all.at(-2), /uses: actions\/upload-artifact@/);
    assert.equal(all.at(-3), [
      "      - name: Linux manifest and release label",
      "        id: linux-manifest",
      "        if: needs.solana-paths.outputs.run == 'true'",
      "        run: |",
      "          release=$(node scripts/ci/solana-linux-manifest.mjs report contracts/solana contracts/solana/target/deploy/merrymen_vault.build.json)",
      "          case \"$release\" in candidate-unconfirmed|not-a-release) ;; *) echo \"::error::the comparison gave no release label\"; exit 1 ;; esac",
      "          echo \"release=$release\" >> \"$GITHUB_OUTPUT\"",
      "          echo \"artifact=merrymen-vault-sbf-$release-$GITHUB_SHA-run$GITHUB_RUN_ID.$GITHUB_RUN_ATTEMPT\" >> \"$GITHUB_OUTPUT\"",
    ].join("\n"));
    // The same environment as the Test step, so --record's in-place build is
    // the build test.sh made, not a rebuild with other settings.
    const testStep = steps(test).find(s => s.includes("contracts/solana/test.sh 2>&1")) ?? "";
    assert.match(testStep, /^ {8}env:\n {10}CARGO_INCREMENTAL: "0"$/m);
    // The manifest is written where the upload takes it from, for this runner's host.
    const build = readFileSync(join(repo, "contracts/solana/build.sh"), "utf8");
    assert.match(build, /^host="\$\(uname -s\)-\$\(uname -m\)"$/m);
    assert.match(build, /^manifest="\$script_dir\/build-manifests\/\$host\.json"$/m);
    assert.match(test, /^ {4}runs-on: ubuntu-24\.04$/m);
  });

  it("both vault jobs name the runner image before anything is built, so a run that fails in the Test step still records it", () => {
    // build.sh fails test.sh on a committed manifest with this source digest
    // but another artifact, before the build record and its summary exist; an
    // image update is one cause, so the image must already be named by then.
    const step = [
      "      - name: Runner image",
      "        if: needs.solana-paths.outputs.run == 'true'",
      "        run: node scripts/ci/solana-program-record.mjs --runner-image",
    ].join("\n");
    for (const [id, builds] of [["solana-test", "contracts/solana/test.sh 2>&1"], ["solana-rebuild", "so=$(scripts/ci/solana-rebuild.sh "]]) {
      const all = steps(job(id));
      const at = all.indexOf(step);
      assert.ok(at >= 0, `${id} has no Runner image step`);
      assert.equal(all.filter(st => st.includes("--runner-image")).length, 1, id);
      // Right after checkout and setup-node: nothing before it can fail on the toolchain.
      assert.deepEqual(all.slice(1, at).map(st => /uses: (actions\/[a-z-]+)@/.exec(st)?.[1] ?? st), ["actions/checkout", "actions/setup-node"], id);
      assert.ok(at < all.findIndex(st => st.includes(builds)), `${id}: the image must be named before the build`);
      assert.ok(at < all.findIndex(st => st.includes("solana-toolchain.sh install ")), `${id}: the image must be named before the toolchain install`);
    }
  });

  it("caches crates and the host test build, never the SBF build or its output", () => {
    const cache = /uses: actions\/cache@\S+.*\n((?: {8}.*\n)*)/.exec(test)?.[1] ?? "";
    const paths = [...cache.matchAll(/^ {12}(\S+)$/gm)].map(m => m[1]);
    assert.ok(paths.includes("contracts/solana/target/debug"), paths.join(" "));
    for (const p of paths) assert.match(p, /^(\$\{\{ env\.CARGO_HOME \}\}\/(registry\/index|registry\/cache|git\/db)|contracts\/solana\/target\/debug)$/, p);
    assert.match(cache, /key: .*hashFiles\('scripts\/ci\/solana-toolchain\.env'\).*hashFiles\('contracts\/solana\/Cargo\.lock', 'contracts\/solana\/runtime-tests\/Cargo\.lock'\)/);
  });

  it("solana · rebuild builds again from tracked source elsewhere and reports its hash", () => {
    assert.ok(rebuild, "ci.yml has no solana-rebuild job");
    const image = rebuild.indexOf("run: node scripts/ci/solana-program-record.mjs --runner-image\n");
    const install = rebuild.indexOf("run: scripts/ci/solana-toolchain.sh install ");
    const build = rebuild.indexOf("so=$(scripts/ci/solana-rebuild.sh ");
    const record = rebuild.indexOf("sha=$(node scripts/ci/solana-program-record.mjs ");
    const check = rebuild.indexOf("run: scripts/ci/solana-toolchain.sh check");
    assert.ok(image >= 0 && image < install && install < build && build < record && record < check);
    assert.match(rebuild, /^ {4}outputs:\n {6}sha256: \$\{\{ steps\.record\.outputs\.sha256 \}\}$/m);
    assert.doesNotMatch(rebuild, /actions\/cache@/, "the rebuild must not reuse anything cached");
  });

  it("neither job can be skipped, softened or filtered away: only their steps wait on solana · paths", () => {
    for (const body of [test, rebuild]) {
      assert.doesNotMatch(body, /continue-on-error/);
      // No job-level `if:`: a skipped job never concludes success (see the Kaka test below).
      assert.doesNotMatch(body, /^ {4}if:/m);
      assert.match(body, /^ {4}runs-on: ubuntu-24\.04$/m);
      assert.match(body, /^ {4}needs: \[solana-paths\]$/m);
      const [notice, ...rest] = steps(body);
      // First, a notice that does nothing but say why nothing else ran.
      assert.match(notice, /^ {6}- name: Not needed for this change\n {8}if: needs\.solana-paths\.outputs\.run != 'true'\n {8}run: echo "[^"$`]*"$/, notice);
      assert.ok(rest.length >= 4);
      // Every other step runs exactly when solana · paths said "true", under no other condition.
      for (const step of rest) {
        const conditions = [...step.matchAll(/^ {8}if: (.*)$/gm)].map(m => m[1]);
        assert.deepEqual(conditions, ["needs.solana-paths.outputs.run == 'true'"], step);
      }
    }
    const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(ci)?.[1] ?? "";
    assert.match(on, /^ {2}pull_request:/m);
    // A workflow-level paths filter would skip the whole run, `app` included.
    assert.doesNotMatch(on, /paths/);
  });

  it("solana · paths decides from the test merge commit and both its parents", () => {
    const paths = job("solana-paths");
    assert.ok(paths, "ci.yml has no solana-paths job");
    assert.doesNotMatch(paths, /^ {4}(if|needs|continue-on-error):/m);
    assert.match(paths, /^ {4}outputs:\n {6}run: \$\{\{ steps\.paths\.outputs\.run \}\}$/m);
    const [checkout, , decide] = steps(paths);
    assert.match(checkout, /uses: actions\/checkout@\S+.*\n {8}with:\n {10}fetch-depth: 2$/);
    assert.doesNotMatch(checkout, /ref:/, "the default ref of a pull_request run is the test merge commit");
    assert.match(decide, /^ {8}id: paths\n {8}run: node scripts\/ci\/solana-paths\.mjs$/m);
  });

  it("app, the required check, needs all three Solana jobs, and equal hashes whenever the vault was built", () => {
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(app)?.[1].split(",").map(s => s.trim()) ?? [];
    for (const id of ["solana-paths", "solana-test", "solana-rebuild"]) assert.ok(needs.includes(id), needs.join(","));
    assert.match(app, /^ {4}if: always\(\)$/m);
    for (const id of ["solana-paths", "solana-test", "solana-rebuild"]) {
      assert.match(app, new RegExp(`test "\\$\\{\\{ needs\\.${id}\\.result \\}\\}" = success`));
    }
    assert.match(app, /SOLANA_BUILD: \$\{\{ needs\.solana-paths\.outputs\.run \}\}/);
    assert.match(app, /VAULT_TESTED_SHA256: \$\{\{ needs\.solana-test\.outputs\.sha256 \}\}/);
    assert.match(app, /VAULT_REBUILT_SHA256: \$\{\{ needs\.solana-rebuild\.outputs\.sha256 \}\}/);
    // Explicit exits: bash 3.2 does not apply errexit to a failing [[ ]].
    assert.match(app, /\[\[ "\$VAULT_TESTED_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\] \|\| \{ .*exit 1; \}$/m);
    assert.match(app, /test "\$VAULT_TESTED_SHA256" = "\$VAULT_REBUILT_SHA256" \|\| \{ .*exit 1; \}$/m);
    // Job outputs reach the script through env, never pasted into its text.
    const at = app.indexOf("run: |");
    assert.ok(at >= 0);
    const script = app.slice(at);
    assert.doesNotMatch(script, /\$\{\{ needs\.[a-z-]+\.outputs/);
  });

  it("app's script passes exactly the runs it should", () => {
    const success = { "app-typecheck": "success", "app-build": "success", "app-test": "success", "app-postgres": "success", "solana-paths": "success", "solana-test": "success", "solana-rebuild": "success", brain: "success" };
    const a = "a".repeat(64), b = "b".repeat(64);
    const cases = [
      ["the vault built, tested and rebuilt to the same bytes", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: a }, 0],
      ["no Solana-relevant change, and no hashes", {}, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 0],
      ["the vault built but no hash came out", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["the rebuild differs", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: b }, 1],
      ["a short hash", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: "abc", VAULT_REBUILT_SHA256: "abc" }, 1],
      ["hashes from a run said to need no build", {}, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: a }, 1],
      ["no decision from solana · paths", {}, { SOLANA_BUILD: "", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["solana · paths failed", { "solana-paths": "failure" }, { SOLANA_BUILD: "", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["solana · test skipped", { "solana-test": "skipped" }, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["solana · rebuild cancelled", { "solana-rebuild": "cancelled" }, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: a }, 1],
      ["an app part failed on a docs-only run", { "app-test": "failure" }, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      // Brain's Python suite (the Python half of the shared on-chain id cases) is a required part too.
      ["brain failed", { brain: "failure" }, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      // A program change before its new Linux manifest is committed: the
      // TypeScript manifest test and solana · test's comparison both fail.
      ["a program change with its manifest not yet committed", { "app-test": "failure", "solana-test": "failure" }, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: a }, 1],
    ];
    const dir = fresh("app");
    for (const [label, results, vars, status] of cases) {
      const file = join(dir, "app.sh");
      writeFileSync(file, appScript({ ...success, ...results }));
      // The shell Actions uses for a `run:` with no `shell:` key.
      const r = run("bash", ["--noprofile", "--norc", "-e", file], vars);
      assert.equal(r.status, status, `${label}: ${r.stdout}${r.stderr}`);
      // The hashes are in the log whatever failed: the owner checks a new
      // Linux manifest against them on exactly the runs that fail.
      const shown = `vault artifact: tested ${vars.VAULT_TESTED_SHA256 || "(none)"}, rebuilt ${vars.VAULT_REBUILT_SHA256 || "(none)"}`;
      assert.ok(r.stdout.split("\n").includes(shown), `${label}: ${r.stdout}`);
    }
  });

  it("solana · release, after app, is the only job that uploads a release name, and only for solana · test's candidate", () => {
    const release = job("solana-release");
    assert.ok(release, "ci.yml has no solana-release job");
    assert.match(release, /^ {4}name: solana · release$/m);
    /** Each job's needs, and everything it waits on through them. */
    const needsOf = id => /^ {4}needs: \[([^\]]*)\]$/m.exec(job(id))?.[1].split(",").map(x => x.trim()).filter(Boolean) ?? [];
    const upstream = id => {
      const seen = new Set();
      const walk = j => { for (const n of needsOf(j)) if (!seen.has(n)) { seen.add(n); walk(n); } };
      walk(id);
      return seen;
    };
    assert.deepEqual(needsOf("solana-release"), ["app", "solana-test", "solana-rebuild"]);
    // No job-level if: it runs only when app (and so every part) succeeded,
    // and a run whose app passed never sees it skipped (the Kaka test below).
    assert.doesNotMatch(release, /^ {4}(if|continue-on-error):/m);
    assert.doesNotMatch(release, /continue-on-error/);
    // Every upload in ci.yml, by job: solana · test's name is its label's,
    // which says at most candidate-unconfirmed; any other name that could say
    // release must be uploaded by a job downstream of app.
    const uploads = jobIds().flatMap(id => steps(job(id)).filter(st => st.includes("uses: actions/upload-artifact@"))
      .map(st => ({ id, name: /^ {10}name: (.*)$/m.exec(st)?.[1] ?? "" })));
    assert.deepEqual(uploads, [
      { id: "solana-test", name: "${{ steps.linux-manifest.outputs.artifact }}" },
      { id: "solana-release", name: "merrymen-vault-release-${{ github.sha }}-run${{ github.run_id }}.${{ github.run_attempt }}" },
    ]);
    for (const { id, name } of uploads) {
      if (id === "solana-test") continue;
      assert.match(name, /release/);
      assert.ok(upstream(id).has("app"), `${id} uploads ${name} without waiting for app`);
    }
    assert.equal(upstream("solana-test").has("app"), false);
    assert.equal(releaseArtifactName({ commit: "c", runId: "7", runAttempt: "2" }), "merrymen-vault-release-c-run7.2", "the name the summary prints is the one uploaded");
    const [notice, ...rest] = steps(release);
    assert.match(notice, /^ {6}- name: Not a release\n {8}if: needs\.solana-test\.outputs\.release != 'candidate-unconfirmed'\n {8}run: echo "[^"$`]*"$/, notice);
    assert.equal(rest.length, 4);
    for (const step of rest) {
      const conditions = [...step.matchAll(/^ {8}if: (.*)$/gm)].map(m => m[1]);
      assert.deepEqual(conditions, ["needs.solana-test.outputs.release == 'candidate-unconfirmed'"], step);
    }
    const record = rest.find(st => st.includes("- name: Release record")) ?? "";
    assert.match(record, /^ {8}run: node scripts\/ci\/solana-release\.mjs "\$RUNNER_TEMP\/merrymen_vault\.release\.json"$/m);
    for (const [k, v] of [
      ["VAULT_RELEASE_LABEL", "needs.solana-test.outputs.release"], ["VAULT_ARTIFACT", "needs.solana-test.outputs.artifact"],
      ["VAULT_TESTED_SHA256", "needs.solana-test.outputs.sha256"], ["VAULT_REBUILT_SHA256", "needs.solana-rebuild.outputs.sha256"],
    ]) assert.ok(record.includes(`          ${k}: \${{ ${v} }}`), `${k} from ${v}`);
    // The record is what is uploaded, and it is required to exist.
    const upload = rest.at(-1);
    assert.match(upload, /^ {10}path: \$\{\{ runner\.temp \}\}\/merrymen_vault\.release\.json\n {10}if-no-files-found: error$/m);
    assert.ok(rest.indexOf(record) < rest.length - 1);
  });

  it("keeps the Kaka docs-only lane open: no job of the run can conclude skipped", async () => {
    // gate.cjs merges only when every job of the PR's CI run concluded success.
    const { createRequire } = await import("node:module");
    const { greenJobs } = createRequire(import.meta.url)(join(repo, ".github/kaka/gate.cjs"));
    const ids = jobIds();
    assert.ok(ids.includes("solana-paths") && ids.includes("app"));
    for (const id of ids) {
      const conditions = [...job(id).matchAll(/^ {4}if: (.*)$/gm)].map(m => m[1]);
      assert.deepEqual(conditions, id === "app" ? ["always()"] : [], `${id} has a job-level if`);
    }
    const names = ids.map(id => /^ {4}name: (.*)$/m.exec(job(id))?.[1] ?? id);
    const docsOnly = names.map(name => ({ name, status: "completed", conclusion: "success" }));
    assert.equal(greenJobs(docsOnly), true);
    const skipped = docsOnly.map(j => (j.name.startsWith("solana ·") && j.name !== "solana · paths" ? { ...j, conclusion: "skipped" } : j));
    assert.equal(greenJobs(skipped), false, "why the Solana jobs skip their steps, not themselves");
  });

  it("app · tests runs exactly npm test's file set, these CI script tests included", () => {
    const npmTest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts.test;
    assert.match(npmTest, /^tsx --test "/);
    const command = appTestCommand();
    assert.ok(command, "app-test has no sharded tsx --test step");
    assert.deepEqual(quoted(command), quoted(npmTest), "the comment promises the same file set as npm test");
    assert.ok(quoted(npmTest).includes("scripts/ci/*.test.mjs"), "npm test must run scripts/ci/*.test.mjs");
  });

  it("the scripts CI runs directly are executable", () => {
    for (const f of ["contracts/solana/test.sh", "scripts/ci/solana-toolchain.sh", "scripts/ci/fetch-verified.sh", "scripts/ci/solana-rebuild.sh"]) {
      assert.ok(statSync(join(repo, f)).mode & 0o100, `${f} is not executable`);
    }
  });
});

describe("the toolchain pins", () => {
  it("name agave v2.3.13 and platform-tools v1.48 by size and SHA-256, building for SBF v0", () => {
    assert.equal(pins.AGAVE_VERSION, "v2.3.13");
    assert.equal(pins.AGAVE_ASSET, "solana-release-x86_64-unknown-linux-gnu.tar.bz2");
    assert.equal(pins.PLATFORM_TOOLS_VERSION, "v1.48");
    assert.equal(pins.PLATFORM_TOOLS_ASSET, "platform-tools-linux-x86_64.tar.bz2");
    assert.equal(pins.PLATFORM_TOOLS_RUSTC, "1.84.1");
    assert.equal(pins.SBF_ARCH, "v0");
    assert.equal(pins.CRITERION_VERSION, "v2.3.3");
    assert.equal(pins.CRITERION_ASSET, `criterion-${pins.CRITERION_VERSION}-linux-x86_64.tar.bz2`);
    for (const k of ["AGAVE_SHA256", "PLATFORM_TOOLS_SHA256", "CRITERION_SHA256"]) assert.match(pins[k], /^[0-9a-f]{64}$/, k);
    for (const k of ["AGAVE_BYTES", "PLATFORM_TOOLS_BYTES"]) assert.match(pins[k], /^[1-9][0-9]{6,}$/, k);
    assert.match(pins.CRITERION_BYTES, /^[1-9][0-9]{5,}$/);
    assert.match(pins.HOST_RUST, /^1\.\d+\.\d+$/);
  });

  it("are plain KEY=value lines, safe for bash to source", () => {
    for (const line of pinsText.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      assert.match(line, /^[A-Z0-9_]+=[A-Za-z0-9._-]+$/, line);
    }
  });

  it("are what the build record names", () => {
    assert.deepEqual(readToolchain(pinsText), { agave: "v2.3.13", platformTools: "v1.48", platformToolsRustc: "1.84.1", arch: "v0", hostRust: pins.HOST_RUST });
  });
});

describe("solana-paths.mjs", () => {
  const script = join(here, "solana-paths.mjs");

  it("counts the vault, its CI and the Solana worker and core sources, nothing else", () => {
    const relevant = [
      "contracts/solana/programs/merrymen-vault/src/risk.rs",
      "contracts/solana/runtime-tests/fixtures/ts-instructions.json",
      "contracts/solana/build-manifests/Linux-x86_64.json",
      "scripts/ci/solana-toolchain.env",
      "scripts/ci/fetch-verified.sh",
      ".github/workflows/ci.yml",
      "packages/core/src/solana-live.ts",
      "packages/core/src/solana.ts",
      "worker/src/solana-executor.ts",
      "worker/src/solana-recover.ts",
      // Cargo reads these from every directory above the program, and a
      // [profile.release] table there changes the vault binary.
      ".cargo/config.toml",
      ".cargo/config",
      "contracts/.cargo/config.toml",
      "rust-toolchain.toml",
      "rust-toolchain",
      "contracts/rust-toolchain.toml",
      // Git applies these when it checks out contracts/solana and when
      // solana-rebuild.sh archives it (eol, export-ignore, export-subst).
      ".gitattributes",
      "contracts/.gitattributes",
      "contracts/solana/.gitattributes",
      "contracts/solana/programs/merrymen-vault/src/.gitattributes",
    ];
    const unrelated = [
      "README.md",
      "docs/solana-integration.md",
      "docs/hosted-deploy.md",
      "web/src/app/globals.css",
      "web/src/terminal/SolanaScreen.tsx",
      "contracts/src/TrencherVault.sol",
      "contracts/solanaish.txt",
      "worker/src/trading.ts",
      "packages/core/src/ids.ts",
      ".github/workflows/android.yml",
      ".github/kaka/gate.cjs",
      "package.json",
      "xcontracts/solana/a.rs",
      "web/.cargo/config.toml",
      "tools/rust-toolchain.toml",
      "rust-toolchain.toml.bak",
      ".cargo-config.toml",
      "web/.gitattributes",
      "contracts/src/.gitattributes",
      ".gitattributes.bak",
      "x.gitattributes",
    ];
    assert.deepEqual(solanaPaths([...relevant, ...unrelated]), relevant);
  });

  it("leaves out a file this suite reads only because app · tests runs the suite on every pull request", () => {
    // A pull request that changes only a file solana · paths does not list
    // starts no vault job, so this suite would not run in solana · test. It
    // reads two such files: .github/kaka/gate.cjs (the docs-only lane test)
    // and package.json (the npm test file set). It still runs on that pull
    // request because it is in npm test, which app · tests runs on every one.
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const reads = [...new Set([...self.matchAll(/join\(repo, "([^"]+)"\)/g)].map(m => m[1]))];
    for (const p of [".github/kaka/gate.cjs", ".github/workflows/ci.yml", "contracts/solana/build.sh"]) assert.ok(reads.includes(p), `the scan missed ${p}`);
    const outside = reads.filter(p => solanaPaths([p, `${p}/x`]).length === 0).sort();
    assert.deepEqual(outside, [".github/kaka/gate.cjs", "package.json"]);
    assert.ok(quoted(appTestCommand()).includes("scripts/ci/*.test.mjs"),
      `app · tests must run scripts/ci/*.test.mjs, or solana · paths must list ${outside.join(" and ")}`);
  });

  it("builds on every run that is not a pull request, and on any pull request it cannot bound", () => {
    const never = () => assert.fail("no git call expected");
    for (const event of ["push", "workflow_dispatch", "schedule", undefined, ""]) {
      assert.equal(decide({ event, git: never }).run, true, String(event));
    }
    const git = (parents, diff) => args => (args[0] === "rev-list" ? ["head", ...parents].join(" ") + "\n" : diff);
    assert.equal(decide({ event: "pull_request", git: git(["base"], "") }).run, true, "not a merge commit");
    assert.equal(decide({ event: "pull_request", git: git(["a", "b", "c"], "") }).run, true, "an octopus");
    const docs = decide({ event: "pull_request", git: git(["base", "head"], "docs/a.md\0README.md\0") });
    assert.deepEqual([docs.run, docs.changed, docs.matched], [false, 2, []]);
    const vault = decide({ event: "pull_request", git: git(["base", "head"], "docs/a.md\0contracts/solana/build.sh\0") });
    assert.deepEqual([vault.run, vault.matched], [true, ["contracts/solana/build.sh"]]);
    // The diff is taken against the first parent, the base branch.
    const calls = [];
    decide({ event: "pull_request", git: args => (calls.push(args), args[0] === "rev-list" ? "m base head\n" : "") });
    assert.deepEqual(calls[1], ["diff", "--name-only", "--no-renames", "-z", "base", "HEAD"]);
  });

  it("as a command, on a depth-2 clone of a test merge commit: false only for a change the vault cannot see", () => {
    const origin = fresh("origin");
    const gitIn = (cwd, ...args) => {
      const r = run("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      }, cwd);
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    const put = (path, text) => {
      mkdirSync(dirname(join(origin, path)), { recursive: true });
      writeFileSync(join(origin, path), text);
    };
    gitIn(origin, "init", "-q");
    put("README.md", "readme\n");
    put("docs/guide.md", "guide\n");
    put("contracts/solana/programs/merrymen-vault/src/lib.rs", "// vault\n");
    put("contracts/solana/Cargo.toml", "[workspace]\n");
    gitIn(origin, "add", "-A");
    gitIn(origin, "commit", "-q", "-m", "base");
    let prs = 0;
    /** A pull request branch off main, merged into main as GitHub's test merge commit would be. */
    const decideFor = change => {
      const branch = `pr-${++prs}`;
      gitIn(origin, "checkout", "-q", "-b", branch, "main");
      change();
      gitIn(origin, "add", "-A");
      gitIn(origin, "commit", "-q", "-m", branch);
      gitIn(origin, "checkout", "-q", "main");
      // main moves on meanwhile, so the merge commit differs from the PR head.
      put(`main-${prs}.txt`, "main\n");
      gitIn(origin, "add", "-A");
      gitIn(origin, "commit", "-q", "-m", `main ${prs}`);
      gitIn(origin, "checkout", "-q", "-b", `merge-${prs}`, "main");
      gitIn(origin, "merge", "-q", "--no-ff", "-m", "test merge", branch);
      const clone = fresh("clone");
      gitIn(clone, "clone", "-q", "--depth", "2", "--branch", `merge-${prs}`, `file://${origin}`, ".");
      gitIn(origin, "checkout", "-q", "main");
      const out = join(clone, "github-output");
      const r = run(process.execPath, [script], { GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: out }, clone);
      assert.equal(r.status, 0, r.stderr);
      return { output: readFileSync(out, "utf8"), stdout: r.stdout };
    };
    const docs = decideFor(() => put("docs/guide.md", "better guide\n"));
    assert.equal(docs.output, "run=false\n");
    assert.match(docs.stdout, /^run=false \(none of the 1 changed path\(s\) is Solana-relevant\)$/m);
    const vault = decideFor(() => put("contracts/solana/programs/merrymen-vault/src/lib.rs", "// changed\n"));
    assert.equal(vault.output, "run=true\n");
    assert.match(vault.stdout, /contracts\/solana\/programs\/merrymen-vault\/src\/lib\.rs/);
    // A file moved out of contracts/solana is a vault change, so renames count on both sides.
    const moved = decideFor(() => gitIn(origin, "mv", "contracts/solana/programs/merrymen-vault/src/lib.rs", "docs/lib.rs"));
    assert.equal(moved.output, "run=true\n");
    // A pull request that changes only the attributes git applies to the
    // vault: export-ignore drops a source file from solana-rebuild.sh's
    // `git archive HEAD contracts/solana`, so the rebuild would build other
    // source than the tested checkout. Both must build, on the pull request.
    const lib = "contracts/solana/programs/merrymen-vault/src/lib.rs";
    /** The files `git archive <ref> contracts/solana` holds, in a fresh clone of that branch. */
    const archived = branch => {
      const clone = fresh("archive");
      gitIn(clone, "clone", "-q", "--depth", "1", "--branch", branch, `file://${origin}`, ".");
      const tar = spawnSync("git", ["archive", "--format=tar", "HEAD", "contracts/solana"], { cwd: clone, env: env() });
      assert.equal(tar.status, 0, String(tar.stderr));
      const names = spawnSync("tar", ["-tf", "-"], { input: tar.stdout, encoding: "utf8" });
      assert.equal(names.status, 0, names.stderr);
      return names.stdout.split("\n").filter(Boolean);
    };
    assert.ok(archived("main").includes(lib), "the base archive holds lib.rs");
    for (const [file, pattern] of [[".gitattributes", lib], ["contracts/.gitattributes", lib.slice("contracts/".length)]]) {
      const attributes = decideFor(() => put(file, `${pattern} export-ignore\n`));
      assert.equal(attributes.output, "run=true\n", file);
      assert.ok(attributes.stdout.split("\n").includes(`  ${file}`), attributes.stdout);
      assert.equal(archived(`merge-${prs}`).includes(lib), false, `${file}: git archive still holds ${lib}`);
    }
    // Not a merge commit (the job checked out something else): build.
    const plain = fresh("plain");
    gitIn(plain, "clone", "-q", "--depth", "2", `file://${origin}`, ".");
    const out = join(plain, "github-output");
    const r = run(process.execPath, [script], { GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: out }, plain);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), "run=true\n");
    // Outside a git checkout it fails rather than guessing.
    const bare = fresh("not-git");
    const failed = run(process.execPath, [script], { GITHUB_EVENT_NAME: "pull_request", GIT_CEILING_DIRECTORIES: dirname(bare) }, bare);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /::error::/);
  });
});

describe("test.sh, the one vault test recipe", () => {
  const testSh = readFileSync(join(repo, "contracts/solana/test.sh"), "utf8");
  const buildSh = readFileSync(join(repo, "contracts/solana/build.sh"), "utf8");
  const rebuildSh = readFileSync(join(here, "solana-rebuild.sh"), "utf8");
  const commands = testSh.split("\n").filter(l => l && !l.startsWith("#"));

  it("runs the native tests, then build.sh, then every runtime target against that artifact, ignored or not", () => {
    const lib = commands.findIndex(l => /^cargo test --locked .*--manifest-path "\$script_dir\/Cargo\.toml" --lib$/.test(l));
    const build = commands.indexOf('"$script_dir/build.sh" "$@"');
    const runtime = commands.findIndex(l => l.includes('--manifest-path "$script_dir/runtime-tests/Cargo.toml"'));
    assert.ok(lib >= 0 && lib < build && build < runtime, commands.join("\n"));
    const line = commands[runtime];
    assert.ok(line.startsWith('BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked '), line);
    // custody and the owner recovery transactions, and --include-ignored rather
    // than --ignored: a test whose #[ignore] is dropped still runs.
    assert.match(line, / --test custody --test recovery -- --include-ignored$/);
    // The Jupiter fork test runs on its own line after them, against the same artifact,
    // when its third-party program copies are supplied; otherwise test.sh prints the one
    // skip line solana-runtime-tests.mjs accepts in its place (the run below checks when).
    const fork = commands.findIndex(l => l.includes('--manifest-path "$script_dir/runtime-tests/Cargo.toml"') && / --test jupiter_fork -- --include-ignored$/.test(l));
    assert.ok(fork > runtime, commands.join("\n"));
    assert.ok(commands[fork].trim().startsWith('BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked '), commands[fork]);
    assert.equal(commands[fork + 1], "else");
    assert.equal(commands[fork + 2].trim(), `echo "${OPTIONAL_TARGETS.jupiter_fork}"`);
    assert.doesNotMatch(testSh, /-- --ignored\b/);
    assert.match(testSh, /^set -euo pipefail$/m);
  });

  it("builds with exactly the toolchain and flags scripts/ci/solana-toolchain.env pins, as the rebuild does", () => {
    const pin = name => new RegExp(`^${name}="([^"]+)"$`, "m").exec(buildSh)?.[1];
    assert.equal(`v${pin("AGAVE_VERSION")}`, pins.AGAVE_VERSION);
    assert.equal(pin("PLATFORM_TOOLS_VERSION"), pins.PLATFORM_TOOLS_VERSION);
    assert.equal(pin("SBF_ARCH"), pins.SBF_ARCH);
    assert.equal(pin("RUSTC_VERSION"), `rustc ${pins.PLATFORM_TOOLS_RUSTC}-dev`);
    // The cargo-build-sbf arguments, in order, with build.sh's extra arguments
    // (none in CI) removed: the same as solana-rebuild.sh's.
    const flags = text => (/cargo-build-sbf"? \\\n([\s\S]*?-- --locked)/.exec(text)?.[1] ?? "")
      .replace(/\\\n/g, " ").replace(/\$\{extra_args\[@\]\+"\$\{extra_args\[@\]\}"\}/, "").split(/\s+/).filter(Boolean);
    const built = flags(buildSh.replaceAll('"$build_sbf"', "cargo-build-sbf"));
    const rebuilt = flags(rebuildSh);
    assert.deepEqual(built.filter(f => !f.startsWith('"$')), ["--tools-version", "--arch", "--manifest-path", "--sbf-out-dir", "--", "--locked"]);
    assert.deepEqual(built.slice(0, 4), ['--tools-version', '"$PLATFORM_TOOLS_VERSION"', "--arch", '"$SBF_ARCH"']);
    assert.deepEqual(rebuilt.filter(f => !f.startsWith('"$')), built.filter(f => !f.startsWith('"$')));
    assert.deepEqual(rebuilt.slice(0, 4), built.slice(0, 4));
    assert.doesNotMatch(buildSh + rebuildSh + testSh, /--force-tools-install|cargo-test-sbf/);
  });

  it("runs the Jupiter fork target only with its program copies, and otherwise says so in one line and still runs every other target", () => {
    // A scratch contracts/solana with this test.sh, a build.sh that builds nothing and a
    // cargo that only records how it was called.
    const root = fresh("test-sh"), dir = join(root, "contracts/solana"), fixtures = join(dir, "runtime-tests/fixtures/jupiter");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(dir, "test.sh"), testSh); chmodSync(join(dir, "test.sh"), 0o755);
    stub(dir, "build.sh", "exit 0");
    const calls = join(root, "cargo-calls"), bin = stub(join(root, "bin"), "cargo",
      `printf '%s | %s\\n' "$*" "\${MERRYMEN_JUPITER_FORK_PROGRAMS-unset}" >> "${calls}"`);
    const testShRun = (extra = {}) => {
      rmSync(calls, { force: true });
      const base = Object.fromEntries(Object.entries(env()).filter(([k]) => k !== "MERRYMEN_JUPITER_FORK_PROGRAMS"));
      const r = spawnSync(join(dir, "test.sh"), [], { cwd: root, encoding: "utf8",
        env: { ...base, PATH: `${bin}:${process.env.PATH}`, CARGO_HOME: join(root, "cargo-home"), ...extra } });
      const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
      return { ...r, calls: lines, skips: r.stdout.split("\n").filter(l => l === OPTIONAL_TARGETS.jupiter_fork).length };
    };
    const forkCall = c => / --test jupiter_fork -- --include-ignored \|/.test(c);
    const skippedRun = (r, label) => {
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.equal(r.skips, 1, `${label}: ${r.stdout}`);
      assert.equal(r.calls.length, 2, `${label}: ${r.calls.join("\n")}`);
      assert.match(r.calls[1], / --test custody --test recovery -- --include-ignored \|/, label);
      assert.ok(!r.calls.some(forkCall), label);
    };
    skippedRun(testShRun(), "nothing supplied");
    skippedRun(testShRun({ MERRYMEN_JUPITER_FORK_PROGRAMS: "" }), "an empty setting");
    writeFileSync(join(fixtures, "jupiter_v6.so"), "elf");
    skippedRun(testShRun(), "only one of the two copies here");
    // The setting: made absolute (the test runs from runtime-tests/) and passed to cargo.
    const supplied = join(root, "programs"); mkdirSync(supplied);
    const viaSetting = testShRun({ MERRYMEN_JUPITER_FORK_PROGRAMS: "programs" });
    assert.equal(viaSetting.status, 0, viaSetting.stderr); assert.equal(viaSetting.skips, 0);
    assert.equal(viaSetting.calls.length, 3); assert.ok(forkCall(viaSetting.calls[2]), viaSetting.calls[2]);
    assert.ok(viaSetting.calls[2].endsWith(` | ${supplied}`), viaSetting.calls[2]);
    // A setting that names no directory fails; it never turns into a skip.
    const missing = testShRun({ MERRYMEN_JUPITER_FORK_PROGRAMS: join(root, "nowhere") });
    assert.notEqual(missing.status, 0); assert.equal(missing.skips, 0); assert.ok(!missing.calls.some(forkCall));
    // Both copies in the fixture directory: it runs from there, with no setting.
    writeFileSync(join(fixtures, "whirlpool.so"), "elf");
    const local = testShRun();
    assert.equal(local.status, 0, local.stderr); assert.equal(local.skips, 0);
    assert.equal(local.calls.length, 3); assert.ok(forkCall(local.calls[2]) && local.calls[2].endsWith(" | unset"), local.calls[2]);
  });
});

describe("build.sh, run against a stub toolchain", () => {
  // No real toolchain: cargo-build-sbf and rustc are stubs on PATH that answer
  // build.sh's version checks, and the "build" writes fixed bytes. Every run
  // happens inside a scratch tree, so no cargo configuration of the machine
  // running these tests is above it.
  const declared = "EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU";
  const host = `${spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim()}-${spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim()}`;
  /** <root>/repo/contracts/solana with build.sh and minimal reviewed inputs, a stub toolchain and an empty CARGO_HOME. */
  function workspace() {
    const root = fresh("build");
    const dir = join(root, "repo/contracts/solana");
    mkdirSync(join(dir, "programs/merrymen-vault/src"), { recursive: true });
    writeFileSync(join(dir, "build.sh"), readFileSync(join(repo, "contracts/solana/build.sh")));
    chmodSync(join(dir, "build.sh"), 0o755);
    writeFileSync(join(dir, "Cargo.toml"), "[workspace]\nmembers = [\"programs/*\"]\n");
    writeFileSync(join(dir, "Cargo.lock"), "version = 4\n");
    writeFileSync(join(dir, "programs/merrymen-vault/Cargo.toml"), "[package]\nname = \"merrymen-vault\"\n");
    writeFileSync(join(dir, "programs/merrymen-vault/src/lib.rs"), `declare_id!("${declared}");\n`);
    const tools = join(root, "platform-tools");
    mkdirSync(join(tools, "rust"), { recursive: true });
    writeFileSync(join(tools, "version.md"), "293a1b6c60a0b8d92593843c373539e21e3ba087  https://github.com/anza-xyz/rust.git\n");
    const bin = join(root, "bin");
    stub(bin, "rustc", `case "$2" in -vV) printf 'rustc 1.84.1-dev (built)\\nLLVM version: 19.1.7\\n' ;; --print) echo "${tools}/rust" ;; *) exit 1 ;; esac`);
    stub(bin, "cargo-build-sbf", [
      `if [ "$1" = --version ]; then echo "solana-cargo-build-sbf 2.3.13"; exit 0; fi`,
      `echo "$*" >> "${root}/builds"`,
      `while [ $# -gt 0 ]; do if [ "$1" = --sbf-out-dir ]; then out="$2"; fi; shift; done`,
      `mkdir -p "$out" && printf '\\177ELF stub vault' > "$out/merrymen_vault.so"`,
    ].join("\n"));
    const cargoHome = join(root, "cargo-home");
    mkdirSync(cargoHome);
    return { root, dir, bin, cargoHome };
  }
  /** Runs build.sh with only the stub toolchain's settings: nothing build.sh refuses comes from this process. */
  function build(w, args = [], { cwd = w.root, cargoHome = w.cargoHome } = {}) {
    const base = Object.fromEntries(Object.entries(env()).filter(([k]) => !/^(RUSTFLAGS|CARGO_.*|RUSTUP_TOOLCHAIN)$/.test(k)));
    const r = spawnSync(join(w.dir, "build.sh"), args, {
      cwd, encoding: "utf8", env: { ...base, PATH: `${w.bin}:${process.env.PATH}`, CARGO_HOME: cargoHome, CARGO_BUILD_SBF: join(w.bin, "cargo-build-sbf") },
    });
    return { ...r, builds: existsSync(join(w.root, "builds")) ? readFileSync(join(w.root, "builds"), "utf8").trim().split("\n").length : 0 };
  }

  it("builds, records a manifest from two identical builds, then finds the next build matches it", () => {
    const w = workspace();
    const first = build(w);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.builds, 1);
    assert.match(first.stderr, new RegExp(`note: no ${host} build manifest for this source`));
    const recorded = build(w, ["--record"]);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(recorded.builds, 3, "--record builds in place and once more from a copy");
    const manifest = JSON.parse(readFileSync(join(w.dir, `build-manifests/${host}.json`), "utf8"));
    assert.equal(manifest.artifact.sha256, sha256(Buffer.from("\x7fELF stub vault", "latin1")));
    assert.equal(manifest.program.declaredId, declared);
    const again = build(w);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`^matches build-manifests/${host}\\.json$`, "m"));
  });

  it("fails on the same source with a different artifact: in CI that is the Test step, before anything is uploaded", () => {
    const w = workspace();
    assert.equal(build(w, ["--record"]).status, 0);
    const path = join(w.dir, `build-manifests/${host}.json`);
    const m = JSON.parse(readFileSync(path, "utf8"));
    m.artifact.sha256 = "e".repeat(64);
    writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
    const r = build(w);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^error: same source, different artifact: manifest e{64}, built [0-9a-f]{64}$/m);
  });

  it("refuses a cargo config in the program's directory or any directory above it, or above where it runs, before building", () => {
    const profile = "[profile.release]\noverflow-checks = false\n";
    const w = workspace();
    const places = [
      join(w.dir, "programs/merrymen-vault/.cargo/config.toml"),
      join(w.dir, ".cargo/config.toml"),
      join(w.dir, ".cargo/config"),
      join(w.root, "repo/contracts/.cargo/config.toml"),
      join(w.root, "repo/.cargo/config.toml"),
      join(w.root, ".cargo/config"),
    ];
    for (const place of places) {
      mkdirSync(dirname(place), { recursive: true });
      writeFileSync(place, profile);
      for (const args of [[], ["--record"]]) {
        const r = build(w, args);
        assert.equal(r.status, 1, `${place} ${args}: ${r.stderr}`);
        assert.ok(r.stderr.includes(`error: remove ${place} for a reproducible build`), r.stderr);
        assert.equal(r.builds, 0, "refused before cargo-build-sbf ran");
      }
      rmSync(dirname(place), { recursive: true, force: true });
    }
    // Where build.sh is run from counts too: cargo-build-sbf inherits it.
    const elsewhere = join(w.root, "elsewhere");
    mkdirSync(join(elsewhere, ".cargo"), { recursive: true });
    mkdirSync(join(elsewhere, "sub"));
    writeFileSync(join(elsewhere, ".cargo/config.toml"), profile);
    const fromThere = build(w, [], { cwd: join(elsewhere, "sub") });
    assert.equal(fromThere.status, 1, fromThere.stderr);
    assert.ok(fromThere.stderr.includes(`error: remove ${join(elsewhere, ".cargo/config.toml")}`), fromThere.stderr);
    rmSync(elsewhere, { recursive: true, force: true });
    // A dangling symlink is refused as well.
    mkdirSync(join(w.dir, ".cargo"));
    symlinkSync(join(w.root, "missing.toml"), join(w.dir, ".cargo/config.toml"));
    assert.equal(build(w).status, 1);
    rmSync(join(w.dir, ".cargo"), { recursive: true, force: true });
    assert.equal(build(w).status, 0);
  });

  it("allows CARGO_HOME's own config, even when CARGO_HOME is a .cargo directory above the program", () => {
    const w = workspace();
    const home = join(w.root, "repo/.cargo");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), "[net]\nretry = 3\n");
    const r = build(w, [], { cargoHome: home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(build(w).status, 1, "under any other CARGO_HOME the same file is refused");
  });
});

describe("solana-runtime-tests.mjs", () => {
  const script = join(here, "solana-runtime-tests.mjs");
  const runtimeDir = join(repo, "contracts/solana/runtime-tests");
  const result = (n, { failed = 0, ignored = 0, filtered = 0, status = failed ? "FAILED" : "ok" } = {}) =>
    `test result: ${status}. ${n} passed; ${failed} failed; ${ignored} ignored; 0 measured; ${filtered} filtered out; finished in 1.00s`;
  const target = (path, body) => [`     Running ${path} (contracts/solana/target/debug/deps/x-0123456789abcdef)`, "", "[INFO solana_program_test] noise on stderr", body, ""].join("\n");
  const lib = [target("unittests src/lib.rs", "running 14 tests\n" + result(14))];
  const sources = { "custody.rs": "#[tokio::test]\n#[ignore = \"x\"]\nasync fn a() {}\n#[tokio::test]\nasync fn b() {}\n", "tests/recovery.rs": "#[tokio::test]\nasync fn c() {}\n" };
  const targets = [{ name: "custody", path: "custody.rs" }, { name: "recovery", path: "tests/recovery.rs" }];
  const good = [...lib, target("custody.rs", "running 2 tests\n" + result(2)), target("tests/recovery.rs", "running 1 test\n" + result(1))].join("\n");

  it("finds the committed runtime targets: custody.rs and every tests/*.rs", () => {
    const testFiles = readdirSync(join(runtimeDir, "tests")).filter(f => f.endsWith(".rs")).sort();
    const found = runtimeTargets(readFileSync(join(runtimeDir, "Cargo.toml"), "utf8"), testFiles);
    // custody.rs, then every tests/*.rs in name order: a new test file adds a target
    // without moving the others, and the known ones are each present.
    assert.deepEqual(found, [targets[0], ...testFiles.map(f => ({ name: f.replace(/\.rs$/, ""), path: `tests/${f}` }))]);
    for (const t of [...targets, { name: "jupiter_fork", path: "tests/jupiter_fork.rs" }]) {
      assert.ok(found.some(f => f.name === t.name && f.path === t.path), t.path);
    }
    assert.equal(found.length, 1 + testFiles.length);
    assert.deepEqual(runtimeTargets("[package]\nautotests = false\n", ["x.rs"]), []);
    assert.ok(countTests(readFileSync(join(runtimeDir, "custody.rs"), "utf8")) >= 25);
    assert.ok(countTests(readFileSync(join(runtimeDir, "tests/recovery.rs"), "utf8")) >= 1);
    assert.ok(countTests(readFileSync(join(runtimeDir, "tests/jupiter_fork.rs"), "utf8")) >= 4);
    assert.equal(countTests("#[test]\nfn a() {}\n#[tokio::test(flavor = \"multi_thread\")]\nasync fn b() {}\n// #[test] in a comment\n"), 2);
  });

  it("passes only when each target ran once and passed exactly its test functions", () => {
    assert.deepEqual(checkRuntimeTests({ log: good, targets, sources }).map(c => [c.name, c.passed]), [["custody", 2], ["recovery", 1]]);
    assert.equal(parseResults(good).get("unittests src/lib.rs").passed, 14);
  });

  it("fails a run that skipped, filtered, ignored or failed any runtime test", () => {
    const cases = {
      // `-- --ignored` after a test lost its #[ignore]: it is filtered out, not run.
      "a dropped #[ignore] under --ignored": [[...lib, target("custody.rs", result(1, { filtered: 1 })), target("tests/recovery.rs", result(1))], /1 filtered out/],
      "an ignored test": [[...lib, target("custody.rs", result(1, { ignored: 1 })), target("tests/recovery.rs", result(1))], /1 ignored/],
      "fewer tests than the source has": [[...lib, target("custody.rs", result(1)), target("tests/recovery.rs", result(1))], /1 passed, but custody\.rs has 2/],
      "a target test.sh does not name": [[...lib, target("custody.rs", result(2))], /recovery \(tests\/recovery\.rs\) never ran/],
      "a failure": [[...lib, target("custody.rs", result(1, { failed: 1 })), target("tests/recovery.rs", result(1))], /1 failed/],
      "no result line": [[...lib, target("custody.rs", "running 2 tests\nerror: test failed, to rerun pass `--test custody`"), target("tests/recovery.rs", result(1))], /printed no test result/],
      "a target run twice": [[...lib, target("custody.rs", result(2)), target("custody.rs", result(2)), target("tests/recovery.rs", result(1))], /ran more than once/],
    };
    for (const [label, [parts, error]] of Object.entries(cases)) {
      assert.throws(() => checkRuntimeTests({ log: parts.join("\n"), targets, sources }), error, label);
    }
    assert.throws(() => checkRuntimeTests({ log: good, targets: [], sources }), /no test targets/);
    assert.throws(() => checkRuntimeTests({ log: good, targets, sources: { ...sources, "tests/recovery.rs": "fn c() {}\n" } }), /no #\[test\]/);
  });

  it("accepts test.sh's skip line in place of the Jupiter fork target alone, and still counts every other target", () => {
    const fork = { name: "jupiter_fork", path: "tests/jupiter_fork.rs" }, all = [...targets, fork];
    const withFork = { ...sources, "tests/jupiter_fork.rs": "#[test]\nfn e() {}\n#[tokio::test]\nasync fn f() {}\n" };
    const skip = OPTIONAL_TARGETS.jupiter_fork;
    assert.equal(skip, "jupiter_fork: skipped, set MERRYMEN_JUPITER_FORK_PROGRAMS (release gate)");
    assert.deepEqual(Object.keys(OPTIONAL_TARGETS), ["jupiter_fork"], "custody and recovery are never optional");
    const skipped = checkRuntimeTests({ log: `${good}\n${skip}\n`, targets: all, sources: withFork });
    assert.deepEqual(skipped.map(c => [c.name, c.passed, c.skipped]), [["custody", 2, false], ["recovery", 1, false], ["jupiter_fork", 0, true]]);
    // Run, it is counted like any other target.
    const ran = `${good}\n${target("tests/jupiter_fork.rs", "running 2 tests\n" + result(2))}`;
    assert.deepEqual(checkRuntimeTests({ log: ran, targets: all, sources: withFork }).map(c => [c.name, c.passed, c.skipped]),
      [["custody", 2, false], ["recovery", 1, false], ["jupiter_fork", 2, false]]);
    const cases = {
      "neither run nor skipped": [good, /jupiter_fork \(tests\/jupiter_fork\.rs\) never ran/],
      "run short of its tests": [`${good}\n${target("tests/jupiter_fork.rs", result(1))}`, /jupiter_fork: 1 passed, but tests\/jupiter_fork\.rs has 2/],
      "both run and skipped": [`${ran}\n${skip}`, /both ran and printed its skip line/],
      "the skip line inside another line": [`${good}\nnote: ${skip}`, /jupiter_fork \(tests\/jupiter_fork\.rs\) never ran/],
      "custody missing, the fork skipped": [[...lib, target("tests/recovery.rs", result(1)), skip].join("\n"), /custody \(custody\.rs\) never ran/],
      "recovery short, the fork skipped": [[...lib, target("custody.rs", result(2)), target("tests/recovery.rs", result(0, { filtered: 1 })), skip].join("\n"), /1 filtered out/],
      "a skip line for custody": [[...lib, "custody: skipped, set MERRYMEN_JUPITER_FORK_PROGRAMS (release gate)", target("tests/recovery.rs", result(1)), skip].join("\n"),
        /custody \(custody\.rs\) never ran/],
    };
    for (const [label, [log, error]] of Object.entries(cases)) {
      assert.throws(() => checkRuntimeTests({ log, targets: all, sources: withFork }), error, label);
    }
    assert.deepEqual([...skippedTargets(`${skip}\r\n`)], ["jupiter_fork"]);
    assert.deepEqual([...skippedTargets(` ${skip}`)], []);
  });

  it("as a command: reads the log and the runtime-tests directory, exit 1 on a gap", () => {
    const dir = fresh("runtime");
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"t\"\n\n[[test]]\nname = \"custody\"\npath = \"custody.rs\"\n");
    writeFileSync(join(dir, "custody.rs"), sources["custody.rs"]);
    writeFileSync(join(dir, "tests/recovery.rs"), sources["tests/recovery.rs"]);
    const log = join(dir, "test.log");
    writeFileSync(log, good);
    const ok = run(process.execPath, [script, log, dir]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^custody: all 2 runtime tests in custody\.rs ran and passed$/m);
    assert.match(ok.stdout, /^recovery: all 1 runtime tests in tests\/recovery\.rs ran and passed$/m);
    writeFileSync(join(dir, "tests/withdrawals.rs"), "#[tokio::test]\nasync fn d() {}\n");
    const missing = run(process.execPath, [script, log, dir]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /::error::runtime test target withdrawals \(tests\/withdrawals\.rs\) never ran; test\.sh must pass --test withdrawals/);
    assert.equal(run(process.execPath, [script, log]).status, 2);
    // The Jupiter fork target: its skip line passes, with a ::warning::, beside custody's and recovery's full counts.
    rmSync(join(dir, "tests/withdrawals.rs"));
    writeFileSync(join(dir, "tests/jupiter_fork.rs"), "#[test]\nfn e() {}\n");
    assert.equal(run(process.execPath, [script, log, dir]).status, 1);
    writeFileSync(log, `${good}\n${OPTIONAL_TARGETS.jupiter_fork}\n`);
    const skipped = run(process.execPath, [script, log, dir]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /^custody: all 2 runtime tests in custody\.rs ran and passed$/m);
    assert.match(skipped.stdout, /^recovery: all 1 runtime tests in tests\/recovery\.rs ran and passed$/m);
    assert.match(skipped.stdout, /^::warning::jupiter_fork: not run here, its 1 runtime tests in tests\/jupiter_fork\.rs are a release gate \(jupiter_fork: skipped, set MERRYMEN_JUPITER_FORK_PROGRAMS \(release gate\)\)$/m);
  });
});

describe("the program's session cap", () => {
  // web-auth F4: the server grants at most 168 hours (plus clock skew) and the
  // program refuses a create_session ending later than 7 days plus its clock
  // allowance. If the two drifted, either the program would accept longer
  // sessions than the server means to, or refuse ones the server prepared.
  const risk = readFileSync(join(repo, "contracts/solana/programs/merrymen-vault/src/risk.rs"), "utf8");
  const core = readFileSync(join(repo, "packages/core/src/solana.ts"), "utf8");
  /** A product of integer literals and constants already read, as these files write them. */
  const product = (text, known) => text.split("*").map(t => t.trim()).reduce((n, t) => {
    if (/^\d[\d_]*$/.test(t)) return n * Number(t.replaceAll("_", ""));
    assert.ok(Object.hasOwn(known, t), `unknown term ${t}`);
    return n * known[t];
  }, 1);
  const rustConst = (name, known) => {
    const m = new RegExp(`^pub const ${name}: i64 = ([^;]+);$`, "m").exec(risk);
    assert.ok(m, `risk.rs has no i64 ${name}`);
    return product(m[1], known);
  };
  const tsConst = name => {
    const m = new RegExp(`^export const ${name} = ([^;]+);$`, "m").exec(core);
    assert.ok(m, `solana.ts has no ${name}`);
    return product(m[1], {});
  };

  it("is the server's 168 hours, with an allowance wider than the server's clock skew", () => {
    const DAY = rustConst("DAY", {});
    assert.equal(DAY, 86_400);
    const maxSession = rustConst("MAX_SESSION", { DAY });
    const allowance = rustConst("SESSION_CLOCK_ALLOWANCE", { DAY });
    assert.equal(maxSession * 1000, tsConst("SOLANA_MAX_PERMISSION_MS"));
    assert.equal(maxSession, 7 * 86_400);
    const skewMs = tsConst("SOLANA_PERMISSION_CLOCK_SKEW_MS");
    assert.ok(allowance * 1000 > skewMs, "a session the server accepts at its skew limit must still fit on-chain");
    assert.ok(allowance <= 3_600, "the allowance stays small");
  });

  it("is applied by create_session, not by every trade", () => {
    const lib = readFileSync(join(repo, "contracts/solana/programs/merrymen-vault/src/lib.rs"), "utf8");
    const create = /pub fn create_session\([\s\S]*?\n {4}\}\n/.exec(lib)?.[0] ?? "";
    assert.match(create, /require!\(risk::session\(&limits, now\)\.is_ok\(\), VaultError::RiskLimit\);/);
    assert.equal((lib.match(/risk::session\(/g) ?? []).length, 1);
  });
});

describe("fetch-verified.sh", () => {
  const script = join(here, "fetch-verified.sh");
  // A curl that logs its arguments and "downloads" $PAYLOAD to --output.
  const bin = stub(fresh("bin"), "curl", [
    'printf "%s\\n" "$*" >> "$CURL_LOG"',
    'out=""',
    'while [ $# -gt 0 ]; do case $1 in --output) out=$2; shift 2 ;; *) shift ;; esac; done',
    'cp "$PAYLOAD" "$out"',
  ].join("\n"));
  const payload = join(fresh("payload"), "asset.tar.bz2");
  writeFileSync(payload, "pretend toolchain bytes\n");
  const size = String(statSync(payload).size);
  const digest = sha256(readFileSync(payload));
  const call = (args, dir) => {
    const log = join(dir, "curl.log");
    const r = run("bash", [script, ...args], { PATH: `${bin}:${process.env.PATH}`, PAYLOAD: payload, CURL_LOG: log });
    return { ...r, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };

  it("keeps a download whose size and SHA-256 match, fetched over HTTPS only", () => {
    const dir = fresh("ok");
    const out = join(dir, "asset.tar.bz2");
    const r = call(["https://example.invalid/asset.tar.bz2", size, digest, out], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), "pretend toolchain bytes\n");
    assert.match(r.log, /--proto =https /);
    assert.deepEqual(readdirSync(dir).sort(), ["asset.tar.bz2", "curl.log"]);
  });

  it("deletes a download whose SHA-256 or size differs, leaving nothing to unpack", () => {
    for (const [bytes, hash] of [[size, "0".repeat(64)], [String(Number(size) + 1), digest]]) {
      const dir = fresh("bad");
      const out = join(dir, "asset.tar.bz2");
      writeFileSync(out, "stale file from an earlier run");
      const r = call(["https://example.invalid/asset.tar.bz2", bytes, hash, out], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /does not match its pin/);
      assert.deepEqual(readdirSync(dir), ["curl.log"]);
    }
  });

  it("refuses a non-HTTPS URL or a malformed pin before downloading anything", () => {
    for (const args of [
      ["http://example.invalid/asset.tar.bz2", size, digest],
      ["https://example.invalid/asset.tar.bz2", "0", digest],
      ["https://example.invalid/asset.tar.bz2", size, digest.toUpperCase()],
    ]) {
      const dir = fresh("refused");
      const r = call([...args, join(dir, "asset.tar.bz2")], dir);
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.log, "");
      assert.deepEqual(readdirSync(dir), []);
    }
  });
});

describe("solana-toolchain.sh", () => {
  const script = join(here, "solana-toolchain.sh");
  const verifiedHome = () => {
    const home = fresh("home");
    const tools = join(home, ".cache/solana/v1.48/platform-tools");
    mkdirSync(join(tools, "rust/bin"), { recursive: true });
    writeFileSync(join(tools, ".merrymen-ci-verified-sha256"), `${pins.PLATFORM_TOOLS_SHA256}\n`);
    const criterion = join(home, `.cache/solana/${pins.CRITERION_VERSION}/criterion`);
    mkdirSync(join(criterion, "include"), { recursive: true });
    writeFileSync(join(criterion, ".merrymen-ci-verified-sha256"), `${pins.CRITERION_SHA256}\n`);
    return home;
  };

  it("check passes when only the verified platform-tools and Criterion are present", () => {
    const r = run("bash", [script, "check"], { HOME: verifiedHome() });
    assert.equal(r.status, 0, r.stderr);
  });

  it("check fails when a build fetched or reinstalled a toolchain the job did not verify", () => {
    const cases = {
      "another platform-tools version": h => mkdirSync(join(h, ".cache/solana/v1.51/platform-tools"), { recursive: true }),
      "a criterion download": h => mkdirSync(join(h, ".cache/solana/v1.48/criterion"), { recursive: true }),
      "another Criterion version": h => mkdirSync(join(h, ".cache/solana/v2.3.2/criterion"), { recursive: true }),
      "Criterion reinstalled without the marker": h => rmSync(join(h, `.cache/solana/${pins.CRITERION_VERSION}/criterion/.merrymen-ci-verified-sha256`)),
      "a Criterion marker for other bytes": h => writeFileSync(join(h, `.cache/solana/${pins.CRITERION_VERSION}/criterion/.merrymen-ci-verified-sha256`), `${"2".repeat(64)}\n`),
      "a reinstall that dropped the marker": h => rmSync(join(h, ".cache/solana/v1.48/platform-tools/.merrymen-ci-verified-sha256")),
      "a marker for other bytes": h => writeFileSync(join(h, ".cache/solana/v1.48/platform-tools/.merrymen-ci-verified-sha256"), `${"1".repeat(64)}\n`),
    };
    for (const [label, spoil] of Object.entries(cases)) {
      const home = verifiedHome();
      spoil(home);
      const r = run("bash", [script, "check"], { HOME: home });
      assert.equal(r.status, 1, label);
      assert.match(r.stderr, /::error::/, label);
    }
  });

  it("install refuses a machine where ~/.cache/solana already exists", () => {
    const home = fresh("home");
    mkdirSync(join(home, ".cache/solana"), { recursive: true });
    const dest = fresh("dest");
    const r = run("bash", [script, "install", dest], { HOME: home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists; refusing to trust/);
    assert.deepEqual(readdirSync(dest), []);
  });

  it("install unpacks nothing when a download fails its check", () => {
    // On Linux x86_64 the stub curl's bytes fail the pin; elsewhere the
    // platform check refuses first. Either way nothing is installed.
    const bin = stub(fresh("bin"), "curl", 'out=""; while [ $# -gt 0 ]; do case $1 in --output) out=$2; shift 2 ;; *) shift ;; esac; done; echo tampered > "$out"');
    const home = fresh("home");
    const dest = fresh("dest");
    const r = run("bash", [script, "install", dest], { HOME: home, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 1);
    assert.equal(existsSync(join(home, ".cache")), false);
    assert.equal(existsSync(join(dest, "solana-release")), false);
    assert.ok(!existsSync(join(dest, "downloads")) || readdirSync(join(dest, "downloads")).length === 0);
  });

  it("rejects an unknown command", () => {
    assert.equal(run("bash", [script, "uninstall"]).status, 1);
  });
});

describe("solana-rebuild.sh", () => {
  const script = join(here, "solana-rebuild.sh");
  // A cargo-build-sbf that logs what it was given and writes a fake .so.
  const bin = stub(fresh("bin"), "cargo-build-sbf", [
    'printf "CARGO_HOME=%s\\nARGS=%s\\n" "$CARGO_HOME" "$*" >> "$SBF_LOG"',
    'out=""; manifest=""',
    'while [ $# -gt 0 ]; do case $1 in --sbf-out-dir) out=$2; shift 2 ;; --manifest-path) manifest=$2; shift 2 ;; *) shift ;; esac; done',
    'test -f "$manifest" || { echo "no manifest at $manifest" >&2; exit 3; }',
    'echo "compiling (stdout of the build)"',
    'mkdir -p "$out" && printf "\\177ELFfake" > "$out/merrymen_vault.so"',
  ].join("\n"));

  it("builds HEAD's tracked source at another path with a fresh canonical CARGO_HOME and the pinned flags", () => {
    const work = fresh("work");
    const log = join(fresh("log"), "sbf.log");
    const r = run("bash", [script, work], { PATH: `${bin}:${process.env.PATH}`, SBF_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    const src = join(work, "src/contracts/solana");
    assert.equal(r.stdout, `${src}/target/deploy/merrymen_vault.so\n`, "stdout carries only the artifact path");
    const logged = readFileSync(log, "utf8");
    assert.match(logged, new RegExp(`^CARGO_HOME=${work}/cargo-home$`, "m"));
    assert.ok(logged.includes(`ARGS=--tools-version ${pins.PLATFORM_TOOLS_VERSION} --arch ${pins.SBF_ARCH} --manifest-path ${src}/programs/merrymen-vault/Cargo.toml --sbf-out-dir ${src}/target/deploy -- --locked\n`), logged);
    assert.ok(!src.startsWith(realpathSync(repo)), "the rebuild must not run in the checkout");

    const tracked = run("git", ["ls-tree", "-r", "--name-only", "HEAD", "contracts/solana"]).stdout.trim().split("\n").sort();
    const copied = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), p);
        else copied.push(p);
      }
    };
    walk(join(work, "src"), "");
    const built = "contracts/solana/target/deploy/merrymen_vault.so";
    assert.deepEqual(copied.filter(p => p !== built).sort(), tracked, "exactly the tracked files, nothing untracked or ignored");
  });

  it("refuses a work directory that is not empty", () => {
    const work = fresh("work");
    writeFileSync(join(work, "left-over"), "");
    const r = run("bash", [script, work], { PATH: `${bin}:${process.env.PATH}`, SBF_LOG: join(work, "log") });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not empty/);
  });
});

describe("solana-program-record.mjs", () => {
  const script = join(here, "solana-program-record.mjs");
  const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const TOKEN_BYTES = Buffer.from("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9", "hex");
  const libRs = id => `use anchor_lang::prelude::*;\n\ndeclare_id!("${id}");\n\n#[program]\npub mod merrymen_vault {}\n`;
  const anchorToml = id => `[toolchain]\nanchor_version = "0.32.1"\n\n[programs.localnet]\nmerrymen_vault = "${id}"\n`;
  const elf = (...parts) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60), ...parts, Buffer.alloc(16)]);

  it("decodes base58 keys", () => {
    assert.deepEqual(base58Decode("11111111111111111111111111111111"), Buffer.alloc(32));
    assert.deepEqual(base58Decode(TOKEN_PROGRAM), TOKEN_BYTES);
    assert.throws(() => base58Decode("0OIl"), /not base58/);
  });

  it("records an artifact that carries the declared program ID", () => {
    const so = elf(TOKEN_BYTES);
    const r = programRecord({ libRs: libRs(TOKEN_PROGRAM), anchorToml: anchorToml(TOKEN_PROGRAM), so, toolchain: readToolchain(pinsText), commit: "c0ffee" });
    assert.equal(r.programId, TOKEN_PROGRAM);
    assert.equal(r.programIdOccurrences, 1);
    assert.equal(r.bytes, so.length);
    assert.equal(r.sha256, sha256(so));
    assert.equal(r.commit, "c0ffee");
    assert.equal(r.toolchain.platformTools, "v1.48");
    // No local test ID given: the record says it was not compared, and is never a candidate.
    assert.deepEqual([r.localTestId, r.declaresLocalTestId], [null, null]);
    const main = { repository: "millw14/merrymen", event: "push", ref: "refs/heads/main" };
    const named = programRecord({ libRs: libRs(TOKEN_PROGRAM), anchorToml: anchorToml(TOKEN_PROGRAM), so, localTestId: LOCAL, run: main });
    assert.deepEqual([named.localTestId, named.declaresLocalTestId], [LOCAL, false]);
    assert.equal(named.release.reason, "its Linux build manifest has not been compared yet");
    // A build of the local test ID says so, and its release reason does too, whatever the manifest.
    const test = programRecord({ libRs: libRs(LOCAL), anchorToml: anchorToml(LOCAL), so: elf(base58Decode(LOCAL)), localTestId: LOCAL, run: main });
    assert.deepEqual([test.programId, test.declaresLocalTestId], [LOCAL, true]);
    assert.deepEqual([test.release.candidate, test.release.reason], [false, "it declares the local test program id, which the live runtime refuses"]);
  });

  it("reads the local test program ID from packages/core/src/solana-live.ts, and nothing ambiguous", () => {
    assert.equal(LOCAL_TEST_SOURCE, "packages/core/src/solana-live.ts");
    assert.equal(base58Decode(LOCAL).length, 32);
    assert.ok(readFileSync(join(repo, LOCAL_TEST_SOURCE), "utf8").includes(`export const SOLANA_VAULT_LOCAL_TEST_PROGRAM =\n  "${LOCAL}";`));
    assert.equal(localTestProgramId(solanaLive(TOKEN_PROGRAM)), TOKEN_PROGRAM);
    const refused = {
      "assigned twice": `${solanaLive(TOKEN_PROGRAM)}SOLANA_VAULT_LOCAL_TEST_PROGRAM = "${LOCAL}";\n`,
      "not a string": "export const SOLANA_VAULT_LOCAL_TEST_PROGRAM = other;\n",
      "commented out only": `// export const SOLANA_VAULT_LOCAL_TEST_PROGRAM = "${LOCAL}";\n`,
      "absent": "export const SOLANA_VAULT_RELEASES = [];\n",
    };
    for (const [label, text] of Object.entries(refused)) assert.throws(() => localTestProgramId(text), /must assign SOLANA_VAULT_LOCAL_TEST_PROGRAM exactly once/, label);
    // Code that only reads the id (a comparison on either side, an arrow) is not a second assignment.
    const reads = [
      "export const isLocal = (id: string) => SOLANA_VAULT_LOCAL_TEST_PROGRAM === id;",
      "export const isLocal = (id: string) => id === SOLANA_VAULT_LOCAL_TEST_PROGRAM;",
      "if (SOLANA_VAULT_LOCAL_TEST_PROGRAM == id || SOLANA_VAULT_LOCAL_TEST_PROGRAM != id || SOLANA_VAULT_LOCAL_TEST_PROGRAM !== id) {}",
      "const ordered = SOLANA_VAULT_LOCAL_TEST_PROGRAM <= id || SOLANA_VAULT_LOCAL_TEST_PROGRAM >= id;",
      "const same = SOLANA_VAULT_LOCAL_TEST_PROGRAM => SOLANA_VAULT_LOCAL_TEST_PROGRAM;",
    ];
    for (const line of reads) assert.equal(localTestProgramId(`${solanaLive(TOKEN_PROGRAM)}${line}\n`), TOKEN_PROGRAM, line);
    // A compound assignment is still a second assignment.
    for (const op of ["+=", "??=", "||=", ">>="]) {
      assert.throws(() => localTestProgramId(`${solanaLive(TOKEN_PROGRAM)}SOLANA_VAULT_LOCAL_TEST_PROGRAM ${op} "x";\n`), /found 2 assignment/, op);
    }
    assert.throws(() => localTestProgramId(solanaLive("1111")), /not a 32-byte key/);
    assert.deepEqual([undefined, null, {}, { programId: LOCAL }, { localTestId: LOCAL }, { programId: "", localTestId: "" }].map(declaresLocalTestId),
      [null, null, null, null, null, null]);
    assert.equal(declaresLocalTestId({ programId: LOCAL, localTestId: LOCAL }), true);
    assert.equal(declaresLocalTestId({ programId: PRODUCTION, localTestId: LOCAL }), false);
  });

  it("refuses an artifact or source that does not agree on one program ID", () => {
    const ok = { libRs: libRs(TOKEN_PROGRAM), anchorToml: anchorToml(TOKEN_PROGRAM), so: elf(TOKEN_BYTES) };
    const refused = {
      "built for another ID": [{ ...ok, so: elf(Buffer.alloc(32, 7)) }, /does not contain the declared program ID/],
      "not an ELF file": [{ ...ok, so: Buffer.concat([Buffer.from("MZ"), TOKEN_BYTES]) }, /not an ELF file/],
      "Anchor.toml names another ID": [{ ...ok, anchorToml: anchorToml("11111111111111111111111111111111") }, /Anchor.toml \[programs.localnet\] names/],
      "a second cluster names another ID": [{ ...ok, anchorToml: `${anchorToml(TOKEN_PROGRAM)}\n[programs.mainnet]\nmerrymen_vault = "11111111111111111111111111111111"\n` }, /\[programs.mainnet\]/],
      "Anchor.toml names none": [{ ...ok, anchorToml: "[toolchain]\n" }, /names no merrymen_vault/],
      "two declarations": [{ ...ok, libRs: `${libRs(TOKEN_PROGRAM)}declare_id!("${TOKEN_PROGRAM}");\n` }, /exactly one program ID/],
      "a commented-out declaration only": [{ ...ok, libRs: `// declare_id!("${TOKEN_PROGRAM}");\n` }, /exactly one program ID/],
      "a short key": [{ ...ok, libRs: libRs("1111"), anchorToml: anchorToml("1111") }, /not 32/],
      "a malformed local test ID": [{ ...ok, localTestId: "1111" }, /local test program ID "1111" is not a 32-byte key/],
    };
    for (const [label, [input, error]] of Object.entries(refused)) assert.throws(() => programRecord(input), error, label);
  });

  it("finds the committed source consistent: lib.rs and Anchor.toml declare the same 32-byte ID", () => {
    const id = declaredProgramId(readFileSync(join(repo, "contracts/solana/programs/merrymen-vault/src/lib.rs"), "utf8"));
    assert.equal(base58Decode(id).length, 32);
    const named = anchorProgramIds(readFileSync(join(repo, "contracts/solana/Anchor.toml"), "utf8"), "merrymen_vault");
    assert.ok(named.length > 0);
    for (const { id: other } of named) assert.equal(other, id);
  });

  it("marks a release candidate only for a push or manual run on refs/heads/main of millw14/merrymen whose Linux build matched the committed manifest", () => {
    const main = { repository: "millw14/merrymen", event: "push", ref: "refs/heads/main" };
    const candidates = [main, { ...main, event: "workflow_dispatch" }];
    // The build record's program: another ID than the local test program.
    const program = { programId: PRODUCTION, localTestId: LOCAL };
    for (const p of candidates) {
      assert.deepEqual(releaseStatus(p, "matches", program), {
        candidate: true, label: "candidate-unconfirmed", reason: "a run on main whose pinned Linux build matched the committed manifest", rule: RELEASE_RULE,
      }, JSON.stringify(p));
      // Any other outcome, or none yet, is not a release: the artifact's name
      // follows this, so bytes that fail the comparison never carry a
      // candidate's name.
      const outcomes = {
        null: "its Linux build manifest has not been compared yet",
        uncommitted: "no Linux build manifest is committed yet",
        differs: "its pinned Linux build differs from the committed manifest",
        removed: "the committed Linux build manifest was deleted",
        matched: "an unknown Linux manifest outcome \"matched\"",
      };
      for (const [outcome, reason] of Object.entries(outcomes)) {
        assert.deepEqual(releaseStatus(p, outcome === "null" ? null : outcome, program), { candidate: false, label: "not-a-release", reason, rule: RELEASE_RULE }, outcome);
      }
      assert.equal(releaseStatus(p).label, "not-a-release", "the record step's own call, before any comparison");
      // A build of the local test program ID is never a candidate, whatever its manifest
      // says: the live runtime refuses that ID (its manifest is a reproducibility baseline).
      for (const outcome of [null, "matches", "uncommitted", "differs", "removed"]) {
        assert.deepEqual(releaseStatus(p, outcome, { programId: LOCAL, localTestId: LOCAL }), {
          candidate: false, label: "not-a-release", reason: "it declares the local test program id, which the live runtime refuses", rule: RELEASE_RULE,
        }, String(outcome));
      }
      // Nor is one whose record does not name both IDs.
      for (const unchecked of [undefined, null, {}, { programId: PRODUCTION }, { localTestId: LOCAL }, { programId: "", localTestId: LOCAL }]) {
        assert.deepEqual(releaseStatus(p, "matches", unchecked), {
          candidate: false, label: "not-a-release", reason: "its program id was not compared with the local test program id", rule: RELEASE_RULE,
        }, JSON.stringify(unchecked));
      }
    }
    const others = [
      { ...main, event: "pull_request", ref: "refs/pull/7/merge" },
      { ...main, event: "pull_request", ref: "refs/heads/main" },
      { ...main, repository: "someone/merrymen" },
      { ...main, ref: "refs/heads/feature" },
      { ...main, ref: "refs/heads/main-old" },
      { ...main, event: "workflow_dispatch", ref: "refs/heads/release" },
      // CI never runs on a tag push, and a manual run can be dispatched on a
      // tag whose commit was never merged: neither is a release.
      { ...main, ref: "refs/tags/vault-v1" },
      { ...main, event: "workflow_dispatch", ref: "refs/tags/vault-v1" },
      { ...main, ref: "refs/tags/" },
      { ...main, event: "schedule" },
      {},
      null,
    ];
    for (const p of others) {
      for (const named of [undefined, program]) {
        assert.deepEqual(releaseStatus(p, "matches", named), {
          candidate: false, label: "not-a-release", reason: "not a push or manual run on refs/heads/main of millw14/merrymen", rule: RELEASE_RULE,
        }, JSON.stringify(p));
      }
    }
    assert.match(RELEASE_RULE, /^A release artifact comes only from a CI run on refs\/heads\/main of millw14\/merrymen: a push to main, or a manual \(workflow_dispatch\) run on main, whose pinned Linux build matched the committed contracts\/solana\/build-manifests\/Linux-x86_64\.json and whose app check passed/);
    assert.match(RELEASE_RULE, /CI never runs on a tag push, and a manual run on a tag or another branch is not a release candidate\./);
    assert.doesNotMatch(RELEASE_RULE, /or a tag of/);
    assert.match(RELEASE_RULE, /A build whose lib\.rs declares the local test program id \(SOLANA_VAULT_LOCAL_TEST_PROGRAM in packages\/core\/src\/solana-live\.ts\) is never a release: the live runtime refuses that id, so its Linux manifest is a reproducibility baseline only\./);
    // The verdict comes after app: solana · test's name is unconfirmed, the release record is solana · release's.
    assert.match(RELEASE_RULE, /solana · test uploads such a run's bytes as merrymen-vault-sbf-candidate-unconfirmed-<commit>-run<id>\.<attempt>, before app has decided; solana · release, which runs only after app passed, confirms them with merrymen-vault-release-<commit>-run<id>\.<attempt>/);
    assert.equal(CANDIDATE_LABEL, "candidate-unconfirmed");
    // No label releaseStatus can give says release on its own.
    for (const outcome of [null, "matches", "uncommitted", "differs", "removed"]) {
      for (const p of [...candidates, ...others]) {
        for (const named of [undefined, program, { programId: LOCAL, localTestId: LOCAL }]) {
          assert.match(releaseStatus(p, outcome, named).label, /^(candidate-unconfirmed|not-a-release)$/);
        }
      }
    }
    assert.match(releaseLine(releaseStatus(main, "matches", program)), /^- release: \*\*release candidate, unconfirmed until app passes\*\* \(/);
  });

  it("records the runner image by name and version, and says it is not digest-pinned", () => {
    const image = { ImageOS: "ubuntu24", ImageVersion: "20251012.1.0" };
    assert.deepEqual(runnerImage(image), { os: "ubuntu24", version: "20251012.1.0", digestPinned: false, note: RUNNER_IMAGE_NOTE });
    for (const env of [{}, null, { ImageOS: "", ImageVersion: "" }, { ImageOS: "ubuntu 24", ImageVersion: "1\n2" }, { ImageOS: "-x", ImageVersion: "x".repeat(65) }]) {
      const r = runnerImage(env);
      assert.deepEqual([r.os, r.version, r.digestPinned], [null, null, false], JSON.stringify(env));
    }
    assert.match(RUNNER_IMAGE_NOTE, /^GitHub-hosted runner image, named by release \(ubuntu-24\.04\) but not digest-pinned: GitHub updates it in place\./);
    assert.match(RUNNER_IMAGE_NOTE, /never commit a new manifest just to make the comparison pass\.$/);
    // The baseline image is the one the committed manifest's own commit names, which outlives the run's artifact.
    assert.ok(RUNNER_IMAGE_NOTE.includes(`the ${MANIFEST_TRAILER} line of the commit that added the committed manifest (git log -1 -- contracts/solana/${LINUX_MANIFEST};`), RUNNER_IMAGE_NOTE);
    assert.equal(runnerImageLine(runnerImage(image)), `- runner image: \`ubuntu24\` version \`20251012.1.0\`, not digest-pinned. ${RUNNER_IMAGE_NOTE}`);
    assert.equal(runnerImageLine(runnerImage({})), `- runner image: unknown (no ImageOS or ImageVersion: not a GitHub-hosted runner), not digest-pinned. ${RUNNER_IMAGE_NOTE}`);
    const so = elf(TOKEN_BYTES);
    const r = programRecord({ libRs: libRs(TOKEN_PROGRAM), anchorToml: anchorToml(TOKEN_PROGRAM), so, image: runnerImage(image) });
    assert.deepEqual(r.runnerImage, runnerImage(image));
    assert.equal(programRecord({ libRs: libRs(TOKEN_PROGRAM), anchorToml: anchorToml(TOKEN_PROGRAM), so }).runnerImage, null);
    // Both vault builds run on that named image release, never on a floating label.
    for (const id of ["solana-test", "solana-rebuild"]) assert.match(job(id), /^ {4}runs-on: ubuntu-24\.04$/m, id);
  });

  it("--runner-image names the image on stdout and in the step summary, and never fails on what it finds", () => {
    const dir = fresh("runner-image");
    const summary = join(dir, "summary.md");
    const image = { ImageOS: "ubuntu24", ImageVersion: "20251012.1.0" };
    const named = run(process.execPath, [script, "--runner-image"], { ...image, GITHUB_STEP_SUMMARY: summary });
    assert.equal(named.status, 0, named.stderr);
    assert.equal(named.stdout, `${runnerImageLine(runnerImage(image))}\n`);
    assert.equal(readFileSync(summary, "utf8"), runnerImageSection(image));
    assert.equal(runnerImageSection(image), `### Runner image\n\n${runnerImageLine(runnerImage(image))}\n`);
    // Appends: the job's later summaries (the build record's) follow it.
    const again = run(process.execPath, [script, "--runner-image"], { ImageOS: "", ImageVersion: "", GITHUB_STEP_SUMMARY: summary });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(summary, "utf8"), runnerImageSection(image) + runnerImageSection({}));
    assert.match(again.stdout, /^- runner image: unknown \(no ImageOS or ImageVersion: not a GitHub-hosted runner\), not digest-pinned\./);
    // Without a step summary (a local run), stdout only.
    const local = run(process.execPath, [script, "--runner-image"], { ...image, GITHUB_STEP_SUMMARY: "" });
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout, named.stdout);
    for (const args of [["--runner-image", "extra"], ["--runner-images"]]) {
      assert.equal(run(process.execPath, [script, ...args], image).status, 2, args.join(" "));
    }
  });

  it("records the run: event, ref, commit, the pull request head, workflow and run", () => {
    const event = join(fresh("event"), "event.json");
    const head = "1".repeat(40);
    writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: head } } }));
    const p = provenance({
      GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge", GITHUB_SHA: "2".repeat(40),
      GITHUB_EVENT_PATH: event, GITHUB_WORKFLOW_SHA: "3".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
    });
    assert.deepEqual(p, {
      repository: "millw14/merrymen", event: "pull_request", ref: "refs/pull/7/merge", commit: "2".repeat(40), pullRequestHead: head,
      workflowSha: "3".repeat(40), runId: "123", runAttempt: "2",
    });
    assert.equal(provenance({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event }).pullRequestHead, null);
    assert.deepEqual(Object.values(provenance({})), [null, null, null, null, null, null, null, null]);
  });

  it("as a command: writes the record, prints the SHA-256, and fails with exit 1 on a mismatch", () => {
    const root = fresh("program");
    mkdirSync(join(root, "programs/merrymen-vault/src"), { recursive: true });
    writeFileSync(join(root, "programs/merrymen-vault/src/lib.rs"), libRs(TOKEN_PROGRAM));
    writeFileSync(join(root, "Anchor.toml"), anchorToml(TOKEN_PROGRAM));
    const so = join(root, "merrymen_vault.so");
    writeFileSync(so, elf(TOKEN_BYTES));
    const out = join(root, "record.json");
    // Through a symlink: a main-module check that compared unresolved paths
    // would skip main, print nothing and exit 0.
    const link = join(fresh("link"), "record.mjs");
    symlinkSync(script, link);
    for (const entry of [script, link]) {
      rmSync(out, { force: true });
      const r = run(process.execPath, [entry, root, so, out], { GITHUB_SHA: "c0ffee" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${sha256(readFileSync(so))}\n`);
      const record = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(record.programId, TOKEN_PROGRAM);
      assert.equal(record.commit, "c0ffee");
      // The local test ID comes from this script's own checkout, not from the program root.
      assert.deepEqual([record.localTestId, record.declaresLocalTestId], [LOCAL, false]);
    }
    // A pull request run: its record and summary say it is not a release artifact.
    const summary = join(root, "summary.md");
    rmSync(out, { force: true });
    const pr = run(process.execPath, [script, root, so, out], {
      GITHUB_SHA: "c0ffee", GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge",
      GITHUB_RUN_ID: "99", GITHUB_RUN_ATTEMPT: "1", GITHUB_STEP_SUMMARY: summary, ImageOS: "ubuntu24", ImageVersion: "20251012.1.0",
    });
    assert.equal(pr.status, 0, pr.stderr);
    const prRecord = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual([prRecord.release.candidate, prRecord.release.label], [false, "not-a-release"]);
    assert.deepEqual([prRecord.provenance.event, prRecord.provenance.runId], ["pull_request", "99"]);
    assert.deepEqual(prRecord.runnerImage, { os: "ubuntu24", version: "20251012.1.0", digestPinned: false, note: RUNNER_IMAGE_NOTE });
    const text = readFileSync(summary, "utf8");
    assert.match(text, /- run: 99 attempt 1, pull_request on refs\/pull\/7\/merge of millw14\/merrymen/);
    assert.ok(text.includes(`- not the local test program ID \`${LOCAL}\`\n`), text);
    assert.ok(text.includes(`${runnerImageLine(runnerImage({ ImageOS: "ubuntu24", ImageVersion: "20251012.1.0" }))}\n`), text);
    assert.match(text, /- release: \*\*not a release artifact\*\* \(not a push or manual run on refs\/heads\/main of millw14\/merrymen\)\. A release artifact comes only from a CI run on refs\/heads\/main of millw14\/merrymen: a push to main, or a manual \(workflow_dispatch\) run on main/);
    // A run on main: still not a release here. Only the Linux manifest
    // comparison (solana-linux-manifest.mjs report) can make it one.
    const mainSummary = join(root, "main-summary.md");
    const mainRun = run(process.execPath, [script, root, so, out], {
      GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_STEP_SUMMARY: mainSummary, ImageOS: "", ImageVersion: "",
    });
    assert.equal(mainRun.status, 0, mainRun.stderr);
    // Off a GitHub-hosted runner there is no image to name, and the record says so.
    assert.deepEqual([JSON.parse(readFileSync(out, "utf8")).runnerImage.os, JSON.parse(readFileSync(out, "utf8")).runnerImage.version], [null, null]);
    assert.match(readFileSync(mainSummary, "utf8"), /^- runner image: unknown \(no ImageOS or ImageVersion: not a GitHub-hosted runner\), not digest-pinned\./m);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).release,
      releaseStatus({ repository: "millw14/merrymen", event: "push", ref: "refs/heads/main" }, null, { programId: TOKEN_PROGRAM, localTestId: LOCAL }));
    assert.equal(JSON.parse(readFileSync(out, "utf8")).release.label, "not-a-release");
    assert.match(readFileSync(mainSummary, "utf8"), /- release: \*\*not a release artifact\*\* \(its Linux build manifest has not been compared yet\)\./);
    assert.doesNotMatch(readFileSync(mainSummary, "utf8"), /\*\*release candidate/);
    // A manual run on a tag: the record says it is not a release.
    const tagRun = run(process.execPath, [script, root, so, out], { GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/vault-v1" });
    assert.equal(tagRun.status, 0, tagRun.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).release, {
      candidate: false, label: "not-a-release", reason: "not a push or manual run on refs/heads/main of millw14/merrymen", rule: RELEASE_RULE,
    });

    // A build of the local test program ID: the record and the summary say it is never a release.
    const testRoot = fresh("program-local");
    mkdirSync(join(testRoot, "programs/merrymen-vault/src"), { recursive: true });
    writeFileSync(join(testRoot, "programs/merrymen-vault/src/lib.rs"), libRs(LOCAL));
    writeFileSync(join(testRoot, "Anchor.toml"), anchorToml(LOCAL));
    const testSo = join(testRoot, "merrymen_vault.so");
    writeFileSync(testSo, elf(base58Decode(LOCAL)));
    const testSummary = join(testRoot, "summary.md");
    const testRun = run(process.execPath, [script, testRoot, testSo, out], {
      GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_STEP_SUMMARY: testSummary,
    });
    assert.equal(testRun.status, 0, testRun.stderr);
    const testRecord = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual([testRecord.programId, testRecord.localTestId, testRecord.declaresLocalTestId], [LOCAL, LOCAL, true]);
    assert.equal(testRecord.release.reason, "it declares the local test program id, which the live runtime refuses");
    assert.match(readFileSync(testSummary, "utf8"), /^- \*\*the local test program ID\*\* \(SOLANA_VAULT_LOCAL_TEST_PROGRAM\), which the live runtime refuses: never a release; its Linux manifest is a reproducibility baseline only$/m);

    writeFileSync(so, elf(Buffer.alloc(32, 7)));
    const bad = run(process.execPath, [script, root, so, out]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /::error::the artifact does not contain the declared program ID/);
    assert.equal(bad.stdout, "");
  });
});

describe("solana-release.mjs", () => {
  const script = join(here, "solana-release.mjs");
  const commit = "c".repeat(40);
  const hash = "a".repeat(64);
  const main = {
    GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: commit,
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  };
  const candidate = {
    ...main,
    VAULT_RELEASE_LABEL: "candidate-unconfirmed",
    VAULT_ARTIFACT: `merrymen-vault-sbf-candidate-unconfirmed-${commit}-run123.1`,
    VAULT_TESTED_SHA256: hash,
    VAULT_REBUILT_SHA256: hash,
  };
  /** The checked-out commit's program: another ID than the local test program. */
  const source = { programId: PRODUCTION, localTestId: LOCAL };
  /** A repository root holding just what releaseSource reads: lib.rs and solana-live.ts. */
  const checkout = declared => {
    const root = fresh("release-source");
    mkdirSync(join(root, "contracts/solana/programs/merrymen-vault/src"), { recursive: true });
    mkdirSync(join(root, "packages/core/src"), { recursive: true });
    writeFileSync(join(root, "contracts/solana/programs/merrymen-vault/src/lib.rs"), `use anchor_lang::prelude::*;\ndeclare_id!("${declared}");\n`);
    writeFileSync(join(root, "packages/core/src/solana-live.ts"), solanaLive(LOCAL));
    return root;
  };

  it("confirms solana · test's candidate on main once the tested and rebuilt hashes agree", () => {
    for (const env of [candidate, { ...candidate, GITHUB_EVENT_NAME: "workflow_dispatch" }]) {
      const r = releaseRecord(env, source);
      assert.equal(r.programId, PRODUCTION);
      assert.equal(r.sha256, hash);
      assert.equal(r.artifact, candidate.VAULT_ARTIFACT);
      assert.equal(r.commit, commit);
      assert.deepEqual([r.provenance.runId, r.provenance.runAttempt], ["123", "1"]);
      assert.deepEqual([r.release.candidate, r.release.confirmed, r.release.label, r.release.rule], [true, true, "release", RELEASE_RULE]);
      assert.match(releaseLine(r.release), /^- release: \*\*release\*\* \(a run on main whose pinned Linux build matched the committed manifest and whose app check passed/);
    }
    // A re-run of app (attempt 2) keeps solana · test's upload from attempt 1.
    assert.equal(releaseRecord({ ...candidate, GITHUB_RUN_ATTEMPT: "2" }, source).artifact, candidate.VAULT_ARTIFACT);
  });

  it("refuses every run that is not a confirmed candidate on main", () => {
    const refused = {
      "a pull request": [{ ...candidate, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" }, /not a push or manual run on refs\/heads\/main/],
      "a branch": [{ ...candidate, GITHUB_REF: "refs/heads/feature" }, /not a push or manual run/],
      "a tag": [{ ...candidate, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/vault-v1" }, /not a push or manual run/],
      "a fork": [{ ...candidate, GITHUB_REPOSITORY: "someone/merrymen" }, /not a push or manual run/],
      "a schedule": [{ ...candidate, GITHUB_EVENT_NAME: "schedule" }, /not a push or manual run/],
      "no commit": [{ ...candidate, GITHUB_SHA: "" }, /no commit, run id or attempt/],
      "no attempt": [{ ...candidate, GITHUB_RUN_ATTEMPT: "" }, /no commit, run id or attempt/],
      "not a candidate": [{ ...candidate, VAULT_RELEASE_LABEL: "not-a-release" }, /labelled this run's artifact "not-a-release", not candidate-unconfirmed/],
      "the old label": [{ ...candidate, VAULT_RELEASE_LABEL: "release-candidate" }, /not candidate-unconfirmed/],
      "no vault build": [{ ...candidate, VAULT_RELEASE_LABEL: "", VAULT_ARTIFACT: "", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, /not candidate-unconfirmed/],
      "another commit's artifact": [{ ...candidate, VAULT_ARTIFACT: `merrymen-vault-sbf-candidate-unconfirmed-${"d".repeat(40)}-run123.1` }, /is not merrymen-vault-sbf-candidate-unconfirmed-c{40}-run123\.<attempt> of this run/],
      "another run's artifact": [{ ...candidate, VAULT_ARTIFACT: `merrymen-vault-sbf-candidate-unconfirmed-${commit}-run124.1` }, /of this run/],
      "a later attempt's artifact": [{ ...candidate, VAULT_ARTIFACT: `merrymen-vault-sbf-candidate-unconfirmed-${commit}-run123.2` }, /of this run/],
      "a not-a-release artifact": [{ ...candidate, VAULT_ARTIFACT: `merrymen-vault-sbf-not-a-release-${commit}-run123.1` }, /of this run/],
      "no artifact": [{ ...candidate, VAULT_ARTIFACT: "" }, /of this run/],
      "no tested hash": [{ ...candidate, VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, /no vault artifact hash from solana · test/],
      "a short hash": [{ ...candidate, VAULT_TESTED_SHA256: "abc", VAULT_REBUILT_SHA256: "abc" }, /no vault artifact hash/],
      "a rebuild that differs": [{ ...candidate, VAULT_REBUILT_SHA256: "b".repeat(64) }, /the rebuilt vault artifact "b{64}" differs from the tested one a{64}/],
      "no rebuild hash": [{ ...candidate, VAULT_REBUILT_SHA256: "" }, /differs from the tested one/],
      // A candidate on main whose source declares the local test program ID: the live
      // runtime refuses that ID, so its bytes are never a release.
      "the local test program": [candidate, /lib\.rs declares the local test program ID \S+ \(SOLANA_VAULT_LOCAL_TEST_PROGRAM\), which the live runtime refuses: its build is never a release/,
        { programId: LOCAL, localTestId: LOCAL }],
      "no source": [candidate, /the program ID was not compared with the local test program ID/, null],
      "no local test ID": [candidate, /was not compared/, { programId: PRODUCTION }],
      "no program ID": [candidate, /was not compared/, { programId: "", localTestId: LOCAL }],
    };
    for (const [label, [env, error, src = source]] of Object.entries(refused)) assert.throws(() => releaseRecord(env, src), error, label);
  });

  it("as a command: writes the record and the summary, or exits 1 having written nothing", () => {
    const dir = fresh("release");
    const out = join(dir, "merrymen_vault.release.json");
    const summary = join(dir, "summary.md");
    const released = checkout(PRODUCTION);
    assert.deepEqual(releaseSource(released), source);
    const ok = run(process.execPath, [script, out, released], { ...candidate, GITHUB_STEP_SUMMARY: summary });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), releaseRecord(candidate, source));
    assert.equal(ok.stdout, `merrymen-vault-release-${commit}-run123.1: ${candidate.VAULT_ARTIFACT} holds the release, SHA-256 ${hash}\n`);
    const text = readFileSync(summary, "utf8");
    assert.match(text, /^### merrymen_vault release\n\n- record: `merrymen-vault-release-c{40}-run123\.1`\n- program ID: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` \(not the local test program ID\)\n- bytes: `merrymen-vault-sbf-candidate-unconfirmed-c{40}-run123\.1` \(target\/deploy\/merrymen_vault\.so\)\n- SHA-256: `a{64}` \(tested and rebuilt\)\n- release: \*\*release\*\* /);
    rmSync(out);
    // A source that declares the local test program ID: exit 1, nothing written.
    const local = run(process.execPath, [script, out, checkout(LOCAL)], candidate);
    assert.equal(local.status, 1);
    assert.match(local.stderr, /^::error::lib\.rs declares the local test program ID /m);
    assert.equal(existsSync(out), false);
    // By default it reads this checkout: refused exactly while lib.rs declares the local test ID.
    const own = releaseSource();
    assert.deepEqual(own, { programId: declaredProgramId(readFileSync(join(repo, "contracts/solana/programs/merrymen-vault/src/lib.rs"), "utf8")), localTestId: LOCAL });
    const here = run(process.execPath, [script, out], candidate);
    assert.equal(here.status, own.programId === LOCAL ? 1 : 0, here.stderr);
    rmSync(out, { force: true });
    const pr = run(process.execPath, [script, out, released], { ...candidate, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" });
    assert.equal(pr.status, 1);
    assert.match(pr.stderr, /^::error::not a push or manual run on refs\/heads\/main of millw14\/merrymen/m);
    assert.equal(existsSync(out), false);
    const differs = run(process.execPath, [script, out, released], { ...candidate, VAULT_REBUILT_SHA256: "b".repeat(64) });
    assert.equal(differs.status, 1);
    assert.equal(existsSync(out), false);
    assert.equal(run(process.execPath, [script], candidate).status, 2);
    assert.equal(run(process.execPath, [script, out, released, "extra"], candidate).status, 2);
  });
});

describe("solana-linux-manifest.mjs", () => {
  const script = join(here, "solana-linux-manifest.mjs");
  const so = Buffer.from("\x7fELF pretend vault bytes");
  const soSha = sha256(so);
  /** A Linux manifest in build.sh --record's own format: the committed Darwin one, rehosted. */
  const darwin = JSON.parse(readFileSync(join(repo, "contracts/solana/build-manifests/Darwin-arm64.json"), "utf8"));
  const linux = (over = {}) => {
    const m = structuredClone(darwin);
    m.toolchain.host = LINUX_HOST;
    m.artifact.bytes = so.length;
    m.artifact.sha256 = soSha;
    for (const [path, value] of Object.entries(over)) {
      const keys = path.split(".");
      const last = keys.pop();
      keys.reduce((o, k) => o[k], m)[last] = value;
    }
    return m;
  };
  const text = m => `${JSON.stringify(m, null, 2)}\n`;

  it("reads build.sh's manifest format: host, artifact file, digest", () => {
    assert.equal(darwin.toolchain.host, "Darwin-arm64");
    assert.equal(darwin.artifact.file, ARTIFACT);
    assert.equal(LINUX_MANIFEST, "build-manifests/Linux-x86_64.json");
    const build = readFileSync(join(repo, "contracts/solana/build.sh"), "utf8");
    assert.ok(build.includes(`printf '    "file": "${ARTIFACT}",\\n'`), "build.sh writes another artifact path");
    assert.equal(verifyRecorded({ recorded: text(linux()), testedSha256: soSha, artifact: so }).source.digest, darwin.source.digest);
  });

  it("verify: refuses a recorded manifest that is not for the tested artifact", () => {
    const cases = {
      "another host": [{ recorded: text(linux({ "toolchain.host": "Darwin-arm64" })) }, /host "Darwin-arm64", not Linux-x86_64/],
      "not the tested artifact": [{ recorded: text(linux({ "artifact.sha256": "a".repeat(64) })) }, /is for artifact a{64}, not the tested/],
      "the .so changed after the tests": [{ artifact: Buffer.concat([so, Buffer.from("x")]) }, /changed after the tests ran/],
      "no tested hash": [{ testedSha256: "" }, /no tested artifact SHA-256/],
      "no source digest": [{ recorded: text(linux({ "source.digest": "" })) }, /no source digest/],
      "no artifact size": [{ recorded: text(linux({ "artifact.bytes": 0 })) }, /no artifact SHA-256 and size/],
      "another artifact file": [{ recorded: text(linux({ "artifact.file": "../elsewhere.so" })) }, /names "\.\.\/elsewhere\.so"/],
      "not JSON": [{ recorded: "nope" }, /recorded build-manifests\/Linux-x86_64\.json is not JSON/],
    };
    for (const [label, [over, error]] of Object.entries(cases)) {
      assert.throws(() => verifyRecorded({ recorded: text(linux()), testedSha256: soSha, artifact: so, ...over }), error, label);
    }
  });

  it("compare: passes with no committed Linux manifest, and when the committed one is the same", () => {
    const recorded = text(linux());
    assert.equal(compareCommitted({ recorded, committed: null }).status, "uncommitted");
    assert.equal(compareCommitted({ recorded, committed: recorded }).status, "matches");
    // Same content, other formatting: still the same manifest.
    assert.equal(compareCommitted({ recorded, committed: JSON.stringify(linux()) }).status, "matches");
    assert.throws(() => compareCommitted({ recorded: text(linux({ "toolchain.host": "Darwin-arm64" })), committed: null }), /not Linux-x86_64/);
  });

  it("compare: fails when a committed Linux manifest exists and differs in any field", () => {
    const recorded = text(linux());
    const cases = {
      "another artifact": [linux({ "artifact.sha256": "e".repeat(64) }), /artifact\.sha256: committed "e{64}", recorded "[0-9a-f]{64}"/],
      "another size": [linux({ "artifact.bytes": so.length + 1 }), /artifact\.bytes: committed \d+, recorded \d+/],
      "stale: other source": [linux({ "source.digest": "d".repeat(64) }), /source\.digest: committed "d{64}"/],
      "another toolchain": [linux({ "toolchain.cargoBuildSbf": "solana-cargo-build-sbf 2.3.14" }), /toolchain\.cargoBuildSbf/],
      "another program ID": [linux({ "program.declaredId": "11111111111111111111111111111111" }), /program\.declaredId/],
      "a field missing": [(() => { const m = linux(); delete m.artifact.reproduced; return m; })(), /artifact\.reproduced: committed \(absent\)/],
    };
    for (const [label, [committed, error]] of Object.entries(cases)) {
      assert.throws(() => compareCommitted({ recorded, committed: text(committed) }), error, label);
      assert.throws(() => compareCommitted({ recorded, committed: text(committed) }), /differs from the committed build-manifests\/Linux-x86_64\.json/, label);
    }
    assert.throws(() => compareCommitted({ recorded, committed: "{ not json" }), /committed build-manifests\/Linux-x86_64\.json is not JSON/);
    assert.deepEqual(differences({ a: { b: 1 } }, { a: { b: 1 } }), []);
  });

  it("as a command: verify checks the tested artifact; compare uses the manifest committed at HEAD, never the one --record just overwrote", () => {
    const origin = fresh("manifest-repo");
    const gitIn = (...args) => {
      const r = run("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      }, origin);
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    };
    const dir = join(origin, "contracts/solana");
    mkdirSync(join(dir, "build-manifests"), { recursive: true });
    mkdirSync(join(dir, "target/deploy"), { recursive: true });
    writeFileSync(join(dir, ARTIFACT), so);
    writeFileSync(join(dir, "build-manifests/Darwin-arm64.json"), text(darwin));
    gitIn("init", "-q");
    gitIn("add", "contracts/solana/build-manifests");
    gitIn("commit", "-q", "-m", "no Linux manifest yet");
    const manifest = join(dir, LINUX_MANIFEST);
    const call = (args, extra = {}) => run(process.execPath, [script, ...args], extra);

    writeFileSync(manifest, text(linux()));
    const verified = call(["verify", dir, soSha]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /is for the tested artifact/);
    const wrong = call(["verify", dir, "f".repeat(64)]);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /^::error::the recorded manifest is for artifact [0-9a-f]{64}, not the tested f{64}/m);

    // None committed: compare passes and says so (report, before it, has
    // annotated the run and written the summary).
    const summary = join(origin, "summary.md");
    const first = call(["compare", dir], { GITHUB_STEP_SUMMARY: summary });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^No build-manifests\/Linux-x86_64\.json is committed, so nothing was compared\..*Review it and commit it from a run whose app check passed/m);
    assert.equal(existsSync(summary), false, "the summary is report's");

    // Committed and the same: passes.
    gitIn("add", "contracts/solana/build-manifests/Linux-x86_64.json");
    gitIn("commit", "-q", "-m", "commit the Linux manifest");
    const same = call(["compare", dir]);
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /matches the committed build-manifests\/Linux-x86_64\.json/);

    // --record wrote another build over the committed file: HEAD's copy is what counts.
    const other = Buffer.from("\x7fELF other vault bytes");
    writeFileSync(join(dir, ARTIFACT), other);
    writeFileSync(manifest, text(linux({ "artifact.sha256": sha256(other), "artifact.bytes": other.length })));
    assert.equal(call(["verify", dir, sha256(other)]).status, 0);
    const differs = call(["compare", dir]);
    assert.equal(differs.status, 1);
    assert.match(differs.stderr, /^::error::this pinned Linux build differs from the committed build-manifests\/Linux-x86_64\.json: artifact\.bytes: .*artifact\.sha256: committed "[0-9a-f]{64}", recorded "[0-9a-f]{64}"/m);
    assert.match(differs.stderr, /review the manifest this run uploaded and commit it unchanged; the next run must then reproduce it\.$/m);

    // Nothing recorded, outside a checkout, or a bad call: exit 1 or 2, never a quiet pass.
    rmSync(manifest);
    for (const args of [["verify", dir, sha256(other)], ["compare", dir]]) {
      const missing = call(args);
      assert.equal(missing.status, 1, args[0]);
      assert.match(missing.stderr, /::error::no build-manifests\/Linux-x86_64\.json: build\.sh --record did not write one/);
    }
    const loose = fresh("not-git");
    mkdirSync(join(loose, "build-manifests"), { recursive: true });
    writeFileSync(join(loose, LINUX_MANIFEST), text(linux()));
    const outside = run(process.execPath, [script, "compare", loose], { GIT_CEILING_DIRECTORIES: dirname(loose) });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /::error::/);
    for (const args of [[], ["verify", dir], ["compare"], ["compare", dir, soSha], ["check", dir, soSha], ["report", dir], ["report", dir, "a", "b"]]) {
      assert.equal(call(args).status, 2, args.join(" "));
    }
  });

  it("as a command: report names the artifact candidate-unconfirmed only for a run on main whose build matches the committed manifest, and never fails on the outcome", () => {
    const origin = fresh("report-repo");
    const gitIn = (...args) => {
      const r = run("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      }, origin);
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    };
    const dir = join(origin, "contracts/solana");
    mkdirSync(join(dir, "build-manifests"), { recursive: true });
    mkdirSync(join(dir, "target/deploy"), { recursive: true });
    writeFileSync(join(dir, "build-manifests/Darwin-arm64.json"), text(darwin));
    gitIn("init", "-q");
    gitIn("add", "contracts/solana/build-manifests");
    gitIn("commit", "-q", "-m", "no Linux manifest yet");
    const manifest = join(dir, LINUX_MANIFEST);
    const recordPath = join(dir, "target/deploy/merrymen_vault.build.json");
    const mainRun = { GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "c".repeat(40) };
    const prRun = { GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" };
    /** What the job holds after build.sh --record: this build's manifest, and the record step's record (its release not yet decided). */
    const build = (bytes, programId = PRODUCTION) => {
      writeFileSync(join(dir, ARTIFACT), bytes);
      writeFileSync(manifest, text(linux({ "artifact.sha256": sha256(bytes), "artifact.bytes": bytes.length })));
      writeFileSync(recordPath, `${JSON.stringify({ program: "merrymen_vault", programId, localTestId: LOCAL, sha256: sha256(bytes), release: releaseStatus({}) }, null, 2)}\n`);
    };
    const report = (extra, summary = join(fresh("summary"), "summary.md")) => {
      const r = run(process.execPath, [script, "report", dir, recordPath], { ...extra, GITHUB_STEP_SUMMARY: summary });
      return { ...r, record: JSON.parse(readFileSync(recordPath, "utf8")), summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
    };

    // None committed: a run on main is not a release; the owner commits the manifest first.
    build(so);
    const none = report(mainRun);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, "not-a-release\n");
    assert.match(none.stderr, /^::notice title=Linux build manifest::No build-manifests\/Linux-x86_64\.json is committed.*The artifact is uploaded as not-a-release \(no Linux build manifest is committed yet\)\.$/m);
    // The line to end the manifest's commit message with: the run and image that built it, which the artifact's expiry would lose.
    const noneTrailer = manifestTrailer({ manifest: JSON.parse(readFileSync(manifest, "utf8")), run: provenance(mainRun), image: null });
    assert.equal(noneTrailer, `${MANIFEST_TRAILER}: run unknown.unknown of millw14/merrymen (push on refs/heads/main at ${"c".repeat(40)}), `
      + `runner image unknown unknown, artifact ${soSha} (${so.length} bytes), source digest ${darwin.source.digest}`);
    assert.deepEqual(none.record.linuxManifest, { file: LINUX_MANIFEST, status: "uncommitted", problem: null, commitTrailer: noneTrailer });
    assert.match(none.stderr, new RegExp(`^If this manifest is committed \\(after review, never just to make the comparison pass\\), end that commit's message with this line, .*: ${MANIFEST_TRAILER}: run unknown`, "m"));
    assert.ok(none.summary.includes(`\n\n    ${noneTrailer}\n`), none.summary);
    assert.equal(none.record.release.label, "not-a-release");
    assert.equal(none.record.program, "merrymen_vault", "the rest of the record is kept");

    // Committed and matching: candidate-unconfirmed on main, not-a-release on a pull request.
    gitIn("add", "contracts/solana/build-manifests/Linux-x86_64.json");
    gitIn("commit", "-q", "-m", "commit the Linux manifest");
    build(so);
    const matches = report(mainRun);
    assert.equal(matches.status, 0, matches.stderr);
    assert.equal(matches.stdout, "candidate-unconfirmed\n");
    assert.deepEqual(matches.record.release, releaseStatus({ repository: "millw14/merrymen", event: "push", ref: "refs/heads/main" }, "matches", { programId: PRODUCTION, localTestId: LOCAL }));
    assert.equal(matches.record.release.candidate, true);
    assert.match(matches.summary, /^### Linux build manifest\n\nThe pinned Linux build matches the committed build-manifests\/Linux-x86_64\.json: /);
    assert.match(matches.summary, /^- release: \*\*release candidate, unconfirmed until app passes\*\* \(a run on main whose pinned Linux build matched the committed manifest\)\. A release artifact comes only/m);
    assert.match(matches.stderr, /The artifact is uploaded as candidate-unconfirmed \(a run on main whose pinned Linux build matched the committed manifest\)\.$/m);
    // Nothing to commit when it matches.
    assert.equal(matches.record.linuxManifest.commitTrailer, null);
    for (const out of [matches.stderr, matches.summary]) assert.ok(!out.includes(MANIFEST_TRAILER), out);
    build(so);
    const pr = report(prRun);
    assert.equal(pr.status, 0, pr.stderr);
    assert.equal(pr.stdout, "not-a-release\n");
    assert.equal(pr.record.linuxManifest.status, "matches");

    // The same matching build on main, but of the local test program ID: not-a-release,
    // so solana · release never runs for it. Its committed manifest is a baseline only.
    build(so, LOCAL);
    const local = report(mainRun);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout, "not-a-release\n");
    assert.equal(local.record.linuxManifest.status, "matches");
    assert.deepEqual([local.record.release.candidate, local.record.release.reason], [false, "it declares the local test program id, which the live runtime refuses"]);
    assert.match(local.stderr, /The artifact is uploaded as not-a-release \(it declares the local test program id, which the live runtime refuses\)\.$/m);
    // A record that does not name both IDs (an older record script) is never a candidate either.
    build(so);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    delete record.localTestId;
    writeFileSync(recordPath, JSON.stringify(record));
    const unchecked = report(mainRun);
    assert.equal(unchecked.status, 0, unchecked.stderr);
    assert.equal(unchecked.stdout, "not-a-release\n");
    assert.equal(unchecked.record.release.reason, "its program id was not compared with the local test program id");

    // A main run whose build differs from the committed manifest: uploaded as
    // not-a-release, the step passes, and compare (the last step) fails.
    const other = Buffer.from("\x7fELF other vault bytes");
    build(other);
    const differs = report(mainRun);
    assert.equal(differs.status, 0, differs.stderr);
    assert.equal(differs.stdout, "not-a-release\n");
    assert.match(differs.stderr, /^::warning title=Linux build manifest::this pinned Linux build differs from the committed build-manifests\/Linux-x86_64\.json: .*The artifact is uploaded as not-a-release \(its pinned Linux build differs from the committed manifest\)\. The job's last step fails on this\.$/m);
    assert.equal(differs.record.linuxManifest.status, "differs");
    assert.match(differs.record.linuxManifest.problem, /artifact\.sha256: committed/);
    assert.deepEqual([differs.record.release.candidate, differs.record.release.label], [false, "not-a-release"]);
    assert.match(differs.summary, /^- release: \*\*not a release artifact\*\* \(its pinned Linux build differs from the committed manifest\)/m);
    assert.equal(run(process.execPath, [script, "compare", dir]).status, 1);
    // The warning names the runner image the record holds: it is not digest-pinned and may be what changed.
    build(other);
    const withImage = JSON.parse(readFileSync(recordPath, "utf8"));
    withImage.runnerImage = runnerImage({ ImageOS: "ubuntu24", ImageVersion: "20251012.1.0" });
    writeFileSync(recordPath, JSON.stringify(withImage));
    const imaged = report(mainRun);
    assert.equal(imaged.status, 0, imaged.stderr);
    assert.match(imaged.stderr, /\(its pinned Linux build differs from the committed manifest\)\. This run's runner image: ubuntu24 20251012\.1\.0 \(not digest-pinned\); if the program source and toolchain pins did not change, the image may have: investigate before committing anything\. The job's last step fails on this\.$/m);
    assert.deepEqual(imaged.record.runnerImage, withImage.runnerImage, "report keeps the record's image");
    // A manifest that differs may be committed on purpose: its commit line names this run's image.
    assert.equal(imaged.record.linuxManifest.commitTrailer,
      manifestTrailer({ manifest: JSON.parse(readFileSync(manifest, "utf8")), run: provenance(mainRun), image: withImage.runnerImage }));
    assert.match(imaged.record.linuxManifest.commitTrailer, /, runner image ubuntu24 20251012\.1\.0, artifact [0-9a-f]{64} \(/);
    assert.ok(imaged.summary.includes(`\n\n    ${imaged.record.linuxManifest.commitTrailer}\n`), imaged.summary);

    // A main run that deleted the committed manifest: not-a-release too.
    gitIn("rm", "-q", "-f", "contracts/solana/build-manifests/Linux-x86_64.json");
    gitIn("commit", "-q", "-m", "drop it");
    build(so);
    const removed = report(mainRun);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout, "not-a-release\n");
    assert.equal(removed.record.linuxManifest.status, "removed");
    assert.equal(removed.record.release.reason, "the committed Linux build manifest was deleted");
    assert.equal(removed.record.linuxManifest.commitTrailer, null, "restored, not committed anew");

    // Errors fail the step, so nothing is uploaded: a record for another
    // artifact, a missing record, no recorded manifest.
    build(so);
    writeFileSync(recordPath, JSON.stringify({ sha256: "f".repeat(64) }));
    const mismatched = run(process.execPath, [script, "report", dir, recordPath], mainRun);
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /^::error::the build record .* is for artifact "f{64}", the Linux manifest for [0-9a-f]{64}$/m);
    assert.equal(mismatched.stdout, "");
    const missing = run(process.execPath, [script, "report", dir, join(dir, "nope.json")], mainRun);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^::error::cannot read the build record/m);
    rmSync(manifest);
    assert.equal(run(process.execPath, [script, "report", dir, recordPath], mainRun).status, 1);
  });

  it("manifestTrailer names the run, runner image and artifact on one line, unknown parts as unknown", () => {
    const m = linux({ "artifact.sha256": soSha, "artifact.bytes": so.length });
    const run = { repository: "millw14/merrymen", event: "push", ref: "refs/heads/main", commit: "d".repeat(40), runId: "123", runAttempt: "2" };
    assert.equal(manifestTrailer({ manifest: m, run, image: runnerImage({ ImageOS: "ubuntu24", ImageVersion: "20251012.1.0" }) }),
      `Vault-Linux-Manifest: run 123.2 of millw14/merrymen (push on refs/heads/main at ${"d".repeat(40)}), runner image ubuntu24 20251012.1.0, `
      + `artifact ${soSha} (${so.length} bytes), source digest ${m.source.digest}`);
    assert.equal(manifestTrailer({ manifest: m }),
      `Vault-Linux-Manifest: run unknown.unknown of unknown (unknown on unknown at unknown), runner image unknown unknown, `
      + `artifact ${soSha} (${so.length} bytes), source digest ${m.source.digest}`);
    // A git trailer: one line, "token: value".
    assert.match(manifestTrailer({ manifest: m, run }), /^Vault-Linux-Manifest: [^\n]+$/);
  });

  it("assess: a manifest HEAD deleted while its first parent has one is removed, and fails the comparison", () => {
    const recorded = text(linux());
    assert.equal(assess({ recorded, committed: null, parent: recorded }).status, "removed");
    assert.equal(assess({ recorded, committed: null, parent: null }).status, "uncommitted");
    assert.equal(assess({ recorded, committed: null }).status, "uncommitted");
    assert.throws(() => compareCommitted({ recorded, committed: null, parent: recorded }),
      /^Error: HEAD has no build-manifests\/Linux-x86_64\.json, but its first parent \(a pull request's base, or the commit before a push\) has one\./);
    // What counts is that one was committed, whatever it said.
    assert.equal(assess({ recorded, committed: null, parent: "{ not json" }).status, "removed");
    // Kept, replaced or added: compared as before.
    assert.equal(assess({ recorded, committed: recorded, parent: recorded }).status, "matches");
    assert.equal(assess({ recorded, committed: recorded, parent: null }).status, "matches");
    assert.equal(assess({ recorded, committed: text(linux({ "artifact.sha256": "e".repeat(64) })), parent: recorded }).status, "differs");
    // Outcomes come back, not as exceptions: only a recorded manifest that is not this build's throws.
    assert.deepEqual(assess({ recorded, committed: "{ not json" }).status, "differs");
    assert.equal(assess({ recorded, committed: recorded }).problem, null);
    assert.throws(() => assess({ recorded: text(linux({ "toolchain.host": "Darwin-arm64" })), committed: null, parent: recorded }), /not Linux-x86_64/);
  });

  it("as a command: compare fails when HEAD deleted the Linux manifest its first parent had, and on a checkout without that parent", () => {
    const origin = fresh("deleted-manifest");
    const gitIn = (cwd, ...args) => {
      const r = run("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      }, cwd);
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    };
    const recordInto = root => {
      // build.sh --record writes this build's manifest into the working tree.
      mkdirSync(join(root, "contracts/solana/build-manifests"), { recursive: true });
      writeFileSync(join(root, "contracts/solana", LINUX_MANIFEST), text(linux()));
      return join(root, "contracts/solana");
    };
    const compare = dir => run(process.execPath, [script, "compare", dir]);
    recordInto(origin);
    gitIn(origin, "init", "-q");
    gitIn(origin, "add", "-A");
    gitIn(origin, "commit", "-q", "-m", "the reviewed Linux manifest");
    assert.equal(compare(join(origin, "contracts/solana")).status, 0);
    gitIn(origin, "rm", "-q", `contracts/solana/${LINUX_MANIFEST}`);
    gitIn(origin, "commit", "-q", "-m", "a change that drops it");
    const dropped = compare(recordInto(origin));
    assert.equal(dropped.status, 1, dropped.stdout);
    assert.match(dropped.stderr, /^::error::HEAD has no build-manifests\/Linux-x86_64\.json, but its first parent .* has one\. .*restore it, or review the manifest this run uploaded and commit it unchanged\.$/m);
    // As the job checks it out, at depth 2: the same answer.
    const two = fresh("depth-2");
    gitIn(two, "clone", "-q", "--depth", "2", `file://${origin}`, ".");
    assert.equal(compare(recordInto(two)).status, 1);
    // At depth 1 the parent is missing: fail, rather than pass on "none committed".
    const one = fresh("depth-1");
    gitIn(one, "clone", "-q", "--depth", "1", `file://${origin}`, ".");
    const shallow = compare(recordInto(one));
    assert.equal(shallow.status, 1, shallow.stdout);
    assert.match(shallow.stderr, /^::error::HEAD's first parent [0-9a-f]{40} is not in this checkout, so a deleted build-manifests\/Linux-x86_64\.json would go unseen; check out with fetch-depth: 2$/m);
    // Restored in a later commit: compared as before.
    gitIn(origin, "add", "-A");
    gitIn(origin, "commit", "-q", "-m", "restore it");
    assert.equal(compare(join(origin, "contracts/solana")).status, 0);
  });
});
