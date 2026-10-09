/**
 * THE IMAGE SHIPS WHAT OPERATORS ARE TOLD TO RUN IN IT.
 *
 * Railway runs the image this Dockerfile builds, and an operator reaches the
 * gateway's volume through that image (`railway ssh`). .env.example tells them
 * to run `node billing-cli.mjs` there to comp a partner or correct credit, and
 * `node partners-cli.mjs` to revoke a key. A file left off a COPY line breaks
 * no build and no test that runs from the source tree: it is a "Cannot find
 * module" on the day somebody needs it. So this stages exactly the files the
 * Dockerfile copies, with the dependencies `npm ci` would install, and runs
 * each entry point from there.
 *
 * `node --test image.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

const dirs = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); });

/** Every COPY in the Dockerfile as {sources, dest}. Flags (--chown=…) are not paths. */
async function copies() {
  const lines = (await readFile(path.join(here, "Dockerfile"), "utf8")).split("\n").map((l) => l.trim());
  return lines.filter((l) => /^COPY\s/i.test(l)).map((l) => {
    // A continued COPY would be read here as half its sources.
    assert.ok(!l.endsWith("\\"), `a COPY split over lines is not understood here: ${l}`);
    const words = l.split(/\s+/).slice(1).filter((w) => !w.startsWith("--"));
    return { sources: words.slice(0, -1), dest: words.at(-1) };
  });
}

test("every entry point at the top of gateway/ is copied into the image", async () => {
  const shipped = new Set((await copies()).flatMap((c) => c.sources));
  const entries = (await readdir(here)).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  assert.ok(entries.includes("billing-cli.mjs") && entries.includes("server.mjs"), "this test reads the gateway's own directory");
  for (const f of entries) assert.ok(shipped.has(f), `${f} is not on a COPY line of gateway/Dockerfile`);
  assert.ok(shipped.has("lib"), "lib/ is not copied");
});

test("the operator CLIs start from exactly the files the image has", async () => {
  const stage = await mkdtemp(path.join(tmpdir(), "merrymen-image-"));
  dirs.push(stage);
  for (const { sources, dest } of await copies()) {
    for (const src of sources) {
      // `COPY a b ./` puts each into the directory; `COPY lib ./lib` names the target.
      const target = path.join(stage, dest.endsWith("/") ? path.join(dest, path.basename(src)) : dest);
      await cp(path.join(here, src), target, { recursive: true, filter: (s) => path.basename(s) !== "node_modules" });
    }
  }
  // What `RUN npm ci --omit=dev` provides.
  await symlink(path.join(here, "node_modules"), path.join(stage, "node_modules"), "dir");
  const data = await mkdtemp(path.join(tmpdir(), "merrymen-image-data-"));
  dirs.push(data);
  const env = { PATH: process.env.PATH, MERRYMEN_DATA_DIR: data, NODE_OPTIONS: "--max-old-space-size=128" };
  for (const [cli, usage] of [["billing-cli.mjs", /usage: billing-cli\.mjs list/], ["partners-cli.mjs", /usage: partners-cli\.mjs issue/]]) {
    // With no command each prints its usage and exits 0, having loaded every module it imports.
    const r = await run(process.execPath, [cli], { cwd: stage, env, timeout: 20_000, killSignal: "SIGKILL" });
    assert.match(r.stdout, usage, cli);
  }
});
