#!/usr/bin/env node
// Decides whether this CI run needs the Solana vault jobs (`solana · test`,
// `solana · rebuild`): the 1.6 GB toolchain download, the SBF build and the
// custody runtime tests.
//
//   node scripts/ci/solana-paths.mjs
//
// Writes run=true or run=false to $GITHUB_OUTPUT (and prints it). Only a
// pull_request run can get run=false, and only when none of the paths it would
// land is one the vault build, its tests or its CI read (SOLANA_PATHS below).
// Pushes to main, manual runs and any other event always build. Anything
// unexpected about the checkout also builds: being wrong in that direction
// costs a few minutes, being wrong in the other merges an untested vault.
//
// On a pull_request run actions/checkout checks out GitHub's test merge commit.
// Its first parent is the base branch, so the diff between the two is exactly
// what the pull request would land. The job checks out with fetch-depth: 2 so
// both parents are present. Renames count on both sides (--no-renames), so a
// file moved out of contracts/solana counts as a vault change.
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What the Solana jobs read. contracts/solana is the program, its build recipe,
 * manifests and runtime tests (the TypeScript ABI and recovery fixtures they
 * execute are committed there too). scripts/ci and ci.yml are the toolchain
 * pins, the scripts and the jobs themselves. The Solana worker and core sources
 * produce those fixtures and the instructions the vault executes.
 *
 * Cargo and rustup configuration above contracts/solana: cargo-build-sbf runs
 * cargo in the program's directory, and cargo reads .cargo/config.toml (or the
 * legacy .cargo/config) there and in every parent directory, so a
 * [profile.release] or [build] table at the repository root or in contracts/
 * changes the vault binary. build.sh refuses such a file, and listing it here
 * makes the pull request that adds one run that refusal instead of skipping
 * the build. rust-toolchain(.toml) picks the host toolchain test.sh's native
 * and runtime tests run on (the SBF build itself always uses +solana).
 *
 * Git attributes above contracts/solana: git applies the root .gitattributes
 * and contracts/.gitattributes (contracts/solana's own are under the first
 * pattern) both when actions/checkout writes the tree solana · test builds and
 * when solana-rebuild.sh runs `git archive HEAD contracts/solana`. An eol,
 * ident or filter attribute changes the bytes a build reads (the root file
 * already sets `*.sh text eol=lf`, and build.sh is a source-digest input), and
 * export-ignore or export-subst changes what the archive holds, so the rebuild
 * would build other source than the tests did. Listing them makes a pull
 * request that changes only attributes build both copies and compare them,
 * instead of skipping to a main run that fails after the merge.
 *
 * Not listed: .github/kaka/gate.cjs and package.json, which the CI script
 * tests (scripts/ci/*.test.mjs) read but the vault build does not. Those tests
 * are in npm test, so app · tests runs them on every pull request, a change to
 * either file included, without building the vault. solana-ci.test.mjs fails
 * if the tests leave app · tests while reading a file outside this list.
 */
export const SOLANA_PATHS = [
  /^contracts\/solana\//,
  /^scripts\/ci\//,
  /^\.github\/workflows\/ci\.yml$/,
  /^packages\/core\/src\/solana/,
  /^worker\/src\/solana/,
  /^(?:contracts\/)?\.cargo\//,
  /^(?:contracts\/)?rust-toolchain(?:\.toml)?$/,
  /^(?:contracts\/)?\.gitattributes$/,
];

export function solanaPaths(paths) {
  return paths.filter(p => SOLANA_PATHS.some(re => re.test(p)));
}

/**
 * @param {{ event: string | undefined, git: (args: string[]) => string }} input
 * @returns {{ run: boolean, reason: string, matched: string[], changed: number | null }}
 */
export function decide({ event, git }) {
  if (event !== "pull_request") {
    return { run: true, reason: `a ${event || "unknown"} run always builds the vault`, matched: [], changed: null };
  }
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/).slice(1);
  if (parents.length !== 2) {
    return { run: true, reason: `HEAD is not a test merge commit (${parents.length} parent(s)), so the change cannot be bounded`, matched: [], changed: null };
  }
  const changed = git(["diff", "--name-only", "--no-renames", "-z", parents[0], "HEAD"]).split("\0").filter(Boolean);
  const matched = solanaPaths(changed);
  return matched.length > 0
    ? { run: true, reason: `${matched.length} of ${changed.length} changed path(s) are Solana-relevant`, matched, changed: changed.length }
    : { run: false, reason: `none of the ${changed.length} changed path(s) is Solana-relevant`, matched, changed: changed.length };
}

function main() {
  const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const result = decide({ event: process.env.GITHUB_EVENT_NAME, git });
  const line = `run=${result.run}`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const shown = result.matched.slice(0, 20).map(p => `- \`${p}\``);
    if (result.matched.length > shown.length) shown.push(`- and ${result.matched.length - shown.length} more`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "### Solana vault jobs",
      "",
      result.run
        ? `Build and test the vault: ${result.reason}.`
        : `Not needed: ${result.reason}. \`solana · test\` and \`solana · rebuild\` report success without building, and \`app\` accepts that only on this decision.`,
      "",
      ...shown,
      "",
    ].join("\n"));
  }
  console.log(`${line} (${result.reason})`);
  for (const p of result.matched.slice(0, 20)) console.log(`  ${p}`);
}

// Real paths on both sides, as in solana-program-record.mjs: run through a
// symlink, a plain comparison would skip main and decide nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
