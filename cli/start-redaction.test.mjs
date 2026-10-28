import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const key = "Fk7qZ2mXw9Lr4TbN0cVyH3sJ8dPaQe6U";
const host = "robinhood-mainnet.g.alchemy.com";
const keyed = `https://${host}/v2/${key}`;
const safe = `https://${host}/[redacted]`;

test("start redacts both child pipes, split URL chunks and native fatal errors", { timeout: 15_000 }, async (t) => {
  // Exercise the installed plain-Node entry point. The child tools are small
  // local fixtures, so no dashboard, network, wallet or real worker is needed.
  const fixture = mkdtempSync(path.join(tmpdir(), "merrymen start redaction "));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const dir of ["cli", "worker/src", "web/.next", "node_modules/.bin"]) {
    mkdirSync(path.join(fixture, dir), { recursive: true });
  }
  // Keep the shipped ESM marker: Node 22 otherwise treats the copied worker
  // files as CommonJS and cannot resolve their extensionless TypeScript imports.
  for (const file of ["cli/bin.mjs", "cli/atomic-write.mjs", "cli/service.mjs", "cli/ui.mjs", "worker/package.json", "worker/src/redact-urls.ts", "worker/src/redact-stdio.ts"]) {
    copyFileSync(path.join(root, file), path.join(fixture, file));
  }
  symlinkSync(path.join(root, "node_modules/tsx"), path.join(fixture, "node_modules/tsx"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(path.join(fixture, "web/.next/BUILD_ID"), "fixture");

  function tool(name, source) {
    const script = path.join(fixture, "node_modules/.bin", name);
    writeFileSync(script, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    if (process.platform === "win32") {
      writeFileSync(`${script}.cmd`, `@"${process.execPath}" "${script}" %*\r\n`);
    }
  }

  const cut = keyed.indexOf(key) + 7;
  tool("next", `
    process.stdout.write(${JSON.stringify(`Ready URL: ${keyed.slice(0, cut)}`)});
    process.stderr.write(${JSON.stringify(`web tail ${keyed.slice(0, cut)}`)});
    setTimeout(() => {
      process.stdout.write(${JSON.stringify(`${keyed.slice(cut)}\n\nplain web line\n`)});
      process.stderr.write(${JSON.stringify(keyed.slice(cut))});
    }, 75);
  `);
  tool("tsx", `
    const endpoint = ${JSON.stringify(keyed)};
    process.stdout.write('band tail ' + endpoint);
    setTimeout(() => { throw new Error('fatal worker URL: ' + endpoint); }, 100);
  `);

  const env = { ...process.env, MERRYMEN_HOME: path.join(fixture, "home"), MERRYMEN_NO_ANIM: "1", NO_COLOR: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [path.join(fixture, "cli/bin.mjs"), "start", "--no-open"], { cwd: fixture, env });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  let stdout = "";
  let stderr = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI output missing:\n${stdout}\n${stderr}`)), 10_000);
    const check = () => {
      if (stdout.includes(`[tavern] Ready URL: ${safe}\n`) &&
          stdout.includes(`[band  ] band tail ${safe}\n`) &&
          stderr.includes(`[tavern] web tail ${safe}\n`) &&
          stderr.includes(`[band  ] Error: fatal worker URL: ${safe}\n`) &&
          stdout.includes("[band  ] rode off (1)")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; check(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; check(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(`CLI ended before diagnostics:\n${stdout}\n${stderr}`)); });
  });
  child.kill("SIGINT");
  await closed;
  for (const output of [stdout, stderr]) {
    assert.ok(!output.includes(key.slice(0, 7)) && !output.includes(key.slice(7)), output);
  }
  assert.ok(stdout.includes("[tavern] plain web line\n"), stdout);
  assert.ok(!stdout.includes("[tavern] \n"), stdout);
  assert.ok(!stdout.includes("fatal worker URL:"), "fatal stderr must stay on stderr");
  assert.ok(!stderr.includes("band tail"), "worker stdout must stay on stdout");
});
