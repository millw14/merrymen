#!/usr/bin/env node
// Proves every vault runtime test ran, from the log of contracts/solana/test.sh.
//
//   node scripts/ci/solana-runtime-tests.mjs <test.sh log> <contracts/solana/runtime-tests dir>
//
// The runtime tests need the compiled SBF program, so each is marked #[ignore]
// and plain `cargo test` skips them. A run that silently executes none of them
// still prints "test result: ok", which is the silent green the audit's GAP4-1
// was about: a dropped #[ignore] under `-- --ignored`, a new test file test.sh
// does not name, a filter, or a test that no longer compiles as a test.
//
// So, for every runtime test target (each [[test]] in runtime-tests/Cargo.toml
// and each runtime-tests/tests/*.rs that cargo discovers), the log must show the
// target ran exactly once, and its result line must count as passed exactly the
// test functions in its source (#[test] or #[tokio::test]), with none failed,
// ignored, measured or filtered out. Exits 1 with a ::error:: line otherwise.
//
// One exception, named in OPTIONAL_TARGETS: jupiter_fork needs copies of third-party
// programs this public repository does not publish, so test.sh skips it when they
// are not supplied and prints exactly one line instead. That line is accepted in
// place of the target's run (a ::warning:: says so); custody, recovery and every
// other target must still run in full. The fork test is a release gate.
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime test targets as cargo prints them in "Running <path> (...)": paths relative to the package. */
export function runtimeTargets(cargoToml, testFiles) {
  const targets = new Map();
  for (const block of cargoToml.split(/^\[/m).slice(1)) {
    if (!block.startsWith("[test]]")) continue;
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const path = /^path\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? (name ? `tests/${name}.rs` : undefined);
    if (!name || !path) throw new Error("a [[test]] target in runtime-tests/Cargo.toml has no name");
    targets.set(path, name);
  }
  if (!/^autotests\s*=\s*false\b/m.test(cargoToml)) {
    for (const file of testFiles) {
      const path = `tests/${file}`;
      if (!targets.has(path)) targets.set(path, file.replace(/\.rs$/, ""));
    }
  }
  return [...targets].map(([path, name]) => ({ name, path }));
}

/** Test functions in a Rust source: lines that are a #[test] or #[tokio::test(...)] attribute. */
export function countTests(source) {
  return (source.match(/^[ \t]*#\[(?:tokio::)?test(?:\([^\]]*\))?\][ \t]*$/gm) ?? []).length;
}

/**
 * Runtime targets test.sh may skip, each with the exact line it prints instead of
 * running it. jupiter_fork reads the Jupiter v6 and Whirlpool program copies from
 * MERRYMEN_JUPITER_FORK_PROGRAMS (runtime-tests/fixtures/jupiter/NOTICE.md).
 */
export const OPTIONAL_TARGETS = Object.freeze({
  jupiter_fork: "jupiter_fork: skipped, set MERRYMEN_JUPITER_FORK_PROGRAMS (release gate)",
});

/** The optional targets whose skip line appears in the log, on a line of its own. */
export function skippedTargets(log) {
  const lines = new Set(log.split(/\r?\n/));
  return new Set(Object.entries(OPTIONAL_TARGETS).filter(([, line]) => lines.has(line)).map(([name]) => name));
}

/** Each "Running <path> (...)" in a cargo test log, with the result line that follows it. */
export function parseResults(log) {
  const results = new Map();
  let current = null;
  for (const line of log.split(/\r?\n/)) {
    const running = /^\s*Running (.+) \([^()]*\)\s*$/.exec(line);
    if (running) {
      current = running[1];
      if (results.has(current)) throw new Error(`${current} ran more than once`);
      results.set(current, null);
      continue;
    }
    const result = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/.exec(line);
    if (result && current !== null) {
      const [, status, passed, failed, ignored, measured, filtered] = result;
      results.set(current, { status, passed: +passed, failed: +failed, ignored: +ignored, measured: +measured, filtered: +filtered });
      current = null;
    }
  }
  return results;
}

/**
 * @returns {{ name: string, path: string, expected: number, passed: number, skipped: boolean }[]} or throws on any gap.
 * `skipped` only for an OPTIONAL_TARGETS target whose skip line test.sh printed and that did not run.
 */
export function checkRuntimeTests({ log, targets, sources }) {
  if (targets.length === 0) throw new Error("runtime-tests has no test targets");
  const results = parseResults(log), skipped = skippedTargets(log);
  return targets.map(({ name, path }) => {
    const expected = countTests(sources[path] ?? "");
    if (expected === 0) throw new Error(`${path} has no #[test] or #[tokio::test] functions`);
    if (skipped.has(name)) {
      if (results.has(path)) throw new Error(`runtime test target ${name} (${path}) both ran and printed its skip line`);
      return { name, path, expected, passed: 0, skipped: true };
    }
    if (!results.has(path)) throw new Error(`runtime test target ${name} (${path}) never ran; test.sh must pass --test ${name}`);
    const r = results.get(path);
    if (!r) throw new Error(`runtime test target ${name} (${path}) printed no test result`);
    if (r.status !== "ok" || r.failed !== 0) throw new Error(`runtime test target ${name}: ${r.failed} failed`);
    if (r.ignored !== 0 || r.filtered !== 0 || r.measured !== 0) {
      throw new Error(`runtime test target ${name}: ${r.ignored} ignored, ${r.filtered} filtered out, ${r.measured} measured; every test must run (test.sh passes -- --include-ignored)`);
    }
    if (r.passed !== expected) throw new Error(`runtime test target ${name}: ${r.passed} passed, but ${path} has ${expected} test functions`);
    return { name, path, expected, passed: r.passed, skipped: false };
  });
}

function main(argv) {
  if (argv.length !== 2) {
    console.error("usage: solana-runtime-tests.mjs <test.sh log> <contracts/solana/runtime-tests dir>");
    process.exit(2);
  }
  const [logPath, dir] = argv;
  const testsDir = join(dir, "tests");
  const testFiles = existsSync(testsDir) ? readdirSync(testsDir).filter(f => f.endsWith(".rs")).sort() : [];
  const targets = runtimeTargets(readFileSync(join(dir, "Cargo.toml"), "utf8"), testFiles);
  const sources = Object.fromEntries(targets.map(({ path }) => [path, existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : ""]));
  const checked = checkRuntimeTests({ log: readFileSync(logPath, "utf8"), targets, sources });
  for (const c of checked) {
    console.log(c.skipped ? `::warning::${c.name}: not run here, its ${c.expected} runtime tests in ${c.path} are a release gate (${OPTIONAL_TARGETS[c.name]})`
      : `${c.name}: all ${c.passed} runtime tests in ${c.path} ran and passed`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
