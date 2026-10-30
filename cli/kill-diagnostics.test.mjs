import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const key = "Fk7qZ2mXw9Lr4TbN0cVyH3sJ8dPaQe6U";
const keyed = `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
const lighterKey = `0x${"9f".repeat(40)}`;

function fixture(t, source) {
  const dir = mkdtempSync(path.join(tmpdir(), "merrymen kill diagnostics "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["cli", "worker/src", "node_modules", "home/accounts/perps"]) {
    mkdirSync(path.join(dir, folder), { recursive: true });
  }
  for (const file of ["cli/bin.mjs", "cli/atomic-write.mjs", "cli/service.mjs", "cli/ui.mjs", "worker/package.json", "worker/src/perps-kill-cli.ts", "worker/src/redact-urls.ts", "worker/src/redact-stdio.ts"]) {
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  symlinkSync(path.join(root, "node_modules/tsx"), path.join(dir, "node_modules/tsx"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(path.join(dir, "worker/src/perps-kill.ts"), source);
  writeFileSync(path.join(dir, "home/.welcomed"), "1");
  writeFileSync(path.join(dir, "home/accounts/perps/grant.json"), "{}");
  const env = { ...process.env, MERRYMEN_HOME: path.join(dir, "home"), MERRYMEN_HOSTED: "", DATABASE_URL: "", MERRYMEN_NO_ANIM: "1", NO_COLOR: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [path.join(dir, "cli/bin.mjs"), "kill"], {
    cwd: dir, env, input: "y\n", encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stdout + child.stderr);
  return child.stdout + child.stderr;
}

for (const paper of [false, true]) {
  test(`kill preserves the redacted ${paper ? "paper" : "grant"} failure reason through runtime warnings`, (t) => {
    const output = fixture(t, `
      export class PerpsKillIncomplete extends Error {}
      export class PerpsPaperNotStopped extends PerpsKillIncomplete {}
      export async function stopLocalPerpsWallet() {
        process.emitWarning('warning before result ${key}');
        process.once('beforeExit', () => process.stderr.write('warning after result ${key}\\n'));
        throw new ${paper ? "PerpsPaperNotStopped" : "PerpsKillIncomplete"}(${JSON.stringify(`Actionable failure: ${keyed}; private venue key ${lighterKey}`)});
      }
    `);
    assert.match(output, paper
      ? /Kill incomplete: your Perps wallet's practice perpetuals could not be switched off\. Actionable failure:/
      : /Kill incomplete: your Perps wallet's grant could not be revoked and it may still sign\. Actionable failure:/);
    assert.ok(output.includes("https://robinhood-mainnet.g.alchemy.com/[redacted]"), output);
    assert.ok(output.includes("private venue key [redacted]"), output);
    assert.ok(!output.includes(key) && !output.includes(lighterKey), output);
    assert.doesNotMatch(output, /warning before result|warning after result|trace-warnings/);
    if (paper) assert.doesNotMatch(output, /may still sign/);
  });
}

for (const status of [1, 2]) {
  test(`kill cannot use an import-time crash's stderr or exit ${status} as proof the grant was revoked`, (t) => {
    const output = fixture(t, `
      export class PerpsKillIncomplete extends Error {}
      export class PerpsPaperNotStopped extends PerpsKillIncomplete {}
      export async function stopLocalPerpsWallet() {}
      // Import-time failures occur before the helper installs its stdio guard.
      process.stderr.write(${JSON.stringify(`native failure at ${keyed}\n`)});
      process.exit(${status});
    `);
    assert.match(output, /Kill incomplete: your Perps wallet's grant could not be revoked and it may still sign\. Rerun: merrymen kill/);
    assert.doesNotMatch(output, /native failure at/);
    assert.ok(!output.includes(key), output);
  });
}

for (const [name, status, raw] of [
  ["malformed at exit 1", 1, "{not json"],
  ["malformed at exit 2", 2, "{not json"],
  ["status 2 result at exit 1", 1, JSON.stringify({ v: 1, kind: "perps-kill-error", status: 2, why: "Unverified reason: its grant was revoked" })],
  ["status 1 result at exit 2", 2, JSON.stringify({ v: 1, kind: "perps-kill-error", status: 1, why: "Unverified reason: its grant was not revoked" })],
]) {
  test(`kill ignores a ${name} response and still reports the incomplete kill`, (t) => {
    const output = fixture(t, `
      export class PerpsKillIncomplete extends Error {}
      export class PerpsPaperNotStopped extends PerpsKillIncomplete {}
      export async function stopLocalPerpsWallet() {
        process.stdout.write(${JSON.stringify(raw)});
        process.stderr.write('Unverified stderr reason\\n');
        process.exit(${status});
      }
    `);
    assert.match(output, /Kill incomplete: your Perps wallet's grant could not be revoked and it may still sign\. Rerun: merrymen kill/);
    assert.doesNotMatch(output, /Unverified|its grant was revoked/);
  });
}
