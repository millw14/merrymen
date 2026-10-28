/** Verify a fresh global install, independently of any shipped lockfile. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function physicalLock(installedRoot) {
  const root = realpathSync(installedRoot);
  const installed = readJson(path.join(root, "package.json"));
  assert.equal(installed.name, "merrymen", "Expected an installed Merrymen package");
  const manifest = { name: "merrymen-installed-verification", version: "1.0.0", private: true, dependencies: { merrymen: installed.version } };
  const packages = { "": manifest };
  const fields = ["name", "version", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "os", "cpu"];
  function visit(directory, location) {
    // npm can leave an empty nested placeholder after hoisting its package.
    // Only a truly empty directory is ignorable; dependency resolution below
    // must still find every required package elsewhere inside this install.
    if (!existsSync(path.join(directory, "package.json")) && readdirSync(directory).length === 0) return;
    const pkg = readJson(path.join(directory, "package.json"));
    assert.ok(pkg.name && pkg.version, `Invalid installed package at ${location}`);
    // Deliberately omit bundled/dev/override flags: audit the physical tree,
    // including nested duplicate versions, rather than a publisher's lock.
    packages[location] = Object.fromEntries(fields.filter((key) => pkg[key] !== undefined).map((key) => [key, pkg[key]]));
    const modules = path.join(directory, "node_modules");
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      assert.ok(!entry.isSymbolicLink(), `Expected copied global package, found symlink: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        for (const child of readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
          assert.ok(!child.isSymbolicLink(), `Expected copied scoped package: ${entry.name}/${child.name}`);
          if (child.isDirectory()) visit(path.join(modules, entry.name, child.name), `${location}/node_modules/${entry.name}/${child.name}`);
        }
      } else visit(path.join(modules, entry.name), `${location}/node_modules/${entry.name}`);
    }
  }
  visit(root, "node_modules/merrymen");
  function resolves(from, name) {
    for (let ancestor = from; ; ) {
      if (packages[`${ancestor}/node_modules/${name}`]) return true;
      if (ancestor === "node_modules/merrymen") return false;
      const index = ancestor.lastIndexOf("/node_modules/");
      if (index < 0) return false;
      ancestor = ancestor.slice(0, index);
    }
  }
  for (const [location, pkg] of Object.entries(packages)) {
    if (!location) continue;
    const required = new Set([
      ...Object.keys(pkg.dependencies ?? {}).filter(name => !pkg.optionalDependencies?.[name]),
      ...Object.keys(pkg.peerDependencies ?? {}).filter(name => !pkg.peerDependenciesMeta?.[name]?.optional),
    ]);
    for (const name of required) {
      assert.ok(resolves(location, name), `Required runtime dependency missing from isolated install: ${name} (required by ${location})`);
    }
  }
  return { manifest, lock: { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages } };
}

export function assertPatched(packages) {
  const seen = new Set();
  for (const [location, pkg] of Object.entries(packages)) {
    if (!location) continue;
    const parts = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(pkg.version);
    assert.ok(parts, `Invalid installed version at ${location}: ${pkg.version}`);
    const version = parts.slice(1).map(Number);
    const atLeast = ([a, b, c]) => version[0] > a || version[0] === a && (version[1] > b || version[1] === b && version[2] >= c);
    let safe = true;
    switch (pkg.name) {
      case "postcss": safe = atLeast([8, 5, 28]); break;
      case "ws": safe = version[0] === 7 ? atLeast([7, 5, 13]) : atLeast([8, 22, 0]); break;
      case "bn.js": safe = version[0] === 4 ? atLeast([4, 12, 5]) : atLeast([5, 2, 4]); break;
      case "uuid": safe = atLeast([11, 1, 1]); break;
      case "@walletconnect/utils": safe = atLeast([2, 21, 9]); break;
      default: continue;
    }
    seen.add(pkg.name);
    assert.ok(safe, `Unpatched installed dependency: ${location}@${pkg.version}`);
  }
  for (const name of ["postcss", "ws", "bn.js", "uuid", "@walletconnect/utils"]) {
    assert.ok(seen.has(name), `Expected runtime dependency missing from physical install: ${name}`);
  }
}

export async function verifyNativeModules(installedRoot) {
  const root = realpathSync(installedRoot);
  const requireRoot = createRequire(path.join(root, "package.json"));
  function ownedRequire(requireFrom, spec) {
    const resolved = realpathSync(requireFrom.resolve(spec));
    const relative = path.relative(root, resolved);
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `${spec} resolved outside isolated install`);
    return requireFrom(spec);
  }
  const sharp = ownedRequire(requireRoot, "sharp");
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "red" } }).png().toBuffer();
  assert.ok(png.length > 0, "sharp native image encoding failed");
  const requireTsx = createRequire(requireRoot.resolve("tsx/package.json"));
  const esbuild = ownedRequire(requireTsx, "esbuild");
  assert.match(esbuild.transformSync("const answer: number = 42", { loader: "ts" }).code, /answer = 42/);
  const abi = process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "-gnu" : "-musl") : process.platform === "win32" ? "-msvc" : "";
  const requireNext = createRequire(requireRoot.resolve("next/package.json"));
  const swc = ownedRequire(requireNext, `@next/swc-${process.platform}-${process.arch}${abi}`);
  // Load/execute the native binary directly; Next's fallback loader may download
  // a missing binary, which would hide a broken package in this smoke check.
  const transformed = swc.transformSync("const answer = 42", false, Buffer.from(JSON.stringify({ jsc: { parser: { syntax: "ecmascript" } } })));
  assert.match(transformed.code, /answer = 42/);
}

/**
 * ONE TIME-BOXED EXCEPTION, for one advisory in five packages, in force
 * through `lastDay` (UTC) and never after.
 *
 * GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6, high: memory exhaustion while validating
 * oversized constrained collections) was widened on 2026-10-23 to every zod 3
 * release, and no zod 3 release is patched. Five wallet and payment SDKs pin
 * zod 3 in their latest releases, so no upgrade removes these copies: Coinbase
 * CDP, Privy (api-base), Reown (appkit-wallet), wagmi (connectors) and x402.
 * Merrymen's own zod is patched.
 *
 * Excused: the zod finding, when that advisory is all it reports and every
 * flagged copy is a zod 3 whose direct parent is one of the five; then any
 * package flagged only because it depends on something excused. Anything else
 * fails as before: another advisory, a zod copy anywhere else, a zod 4 copy,
 * or any day after `lastDay`.
 */
export const ZOD3_EXCEPTION = Object.freeze({
  advisory: "GHSA-mrhx-c7xc-m3w5",
  lastDay: "2026-11-08",
  parents: Object.freeze(["@coinbase/cdp-sdk", "@privy-io/api-base", "@reown/appkit-wallet", "@wagmi/connectors", "x402"]),
});

/** The package directly above a node: `…/node_modules/@a/b/node_modules/zod` → `@a/b`. */
function parentOf(node) {
  const owner = node.slice(0, node.lastIndexOf("/node_modules/"));
  return owner.slice(owner.lastIndexOf("node_modules/") + "node_modules/".length);
}

/**
 * npm audit's report, judged: every finding must be excused by the exception
 * above or the audit fails, naming what is left. Returns the excused zod nodes.
 */
export function evaluateAudit(audit, packages, now = new Date(), exception = ZOD3_EXCEPTION) {
  if (audit.error) throw new Error(`npm audit failed: ${JSON.stringify(audit.error)}`);
  const vulnerabilities = audit.vulnerabilities ?? {};
  const inForce = now.toISOString().slice(0, 10) <= exception.lastDay;
  const zod = vulnerabilities.zod;
  const excused = new Set();
  if (inForce && zod &&
      zod.via.length > 0 && zod.via.every((via) => typeof via === "object" && via.url?.endsWith(`/${exception.advisory}`)) &&
      zod.nodes.length > 0 && zod.nodes.every((node) => exception.parents.includes(parentOf(node)) && /^3\./.test(packages[node]?.version ?? ""))) {
    excused.add("zod");
  }
  for (let grew = excused.size > 0; grew; ) {
    grew = false;
    for (const [name, finding] of Object.entries(vulnerabilities)) {
      if (excused.has(name) || finding.via.length === 0 || !finding.via.every((via) => typeof via === "string" && excused.has(via))) continue;
      excused.add(name);
      grew = true;
    }
  }
  const remaining = Object.entries(vulnerabilities).filter(([name]) => !excused.has(name));
  if (remaining.length > 0) {
    const named = remaining.map(([name, finding]) => `${name} (${finding.severity}: ${finding.via.map((via) => typeof via === "string" ? `via ${via}` : via.url ?? via.title).join(", ")})`).join("; ");
    const ended = zod && !inForce ? ` The zod 3 exception for ${exception.advisory} ended after ${exception.lastDay}.` : "";
    throw new Error(`Installed dependency audit failed: ${remaining.length} vulnerable packages: ${named}.${ended}`);
  }
  return excused.size > 0 ? [...zod.nodes] : [];
}

export function auditPhysicalLock(snapshot, now = new Date()) {
  const directory = mkdtempSync(path.join(tmpdir(), "merrymen-installed-audit-"));
  try {
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(snapshot.manifest));
    writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify(snapshot.lock));
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["audit", "--omit=dev", "--ignore-scripts", "--json"], {
      cwd: directory, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    let audit;
    try { audit = JSON.parse(result.stdout); } catch { throw new Error(`npm audit returned invalid output: ${result.stderr}`); }
    // npm exits 1 whenever it reports anything, excused or not; a failure
    // with no report is still a failure.
    if (result.status !== 0 && !audit.error && Object.keys(audit.vulnerabilities ?? {}).length === 0) {
      throw new Error(`npm audit exited ${result.status} without a report: ${result.stderr}`);
    }
    const excused = evaluateAudit(audit, snapshot.lock.packages, now);
    return { metadata: audit.metadata, excused };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, "Usage: node cli/verify-installed.mjs <installed-package-directory>");
    const root = path.resolve(process.argv[2]);
    const snapshot = physicalLock(root);
    assertPatched(snapshot.lock.packages);
    await verifyNativeModules(root);
    const { metadata, excused } = auditPhysicalLock(snapshot);
    const exception = excused.length === 0 ? "" :
      `, all excused through ${ZOD3_EXCEPTION.lastDay} for ${ZOD3_EXCEPTION.advisory} (zod 3 at ${excused.join(", ")})`;
    if (exception && process.env.GITHUB_ACTIONS) {
      console.log(`::warning title=Audit exception::${ZOD3_EXCEPTION.advisory} is excused for ${excused.length} zod 3 copies until ${ZOD3_EXCEPTION.lastDay}; after that this check fails again.`);
    }
    console.log(`[merrymen] Verified ${Object.keys(snapshot.lock.packages).length - 1} installed packages; native sharp, esbuild and Next SWC work; audit: ${metadata.vulnerabilities.total} vulnerabilities${exception}.`);
  } catch (error) {
    console.error(`[merrymen] Installed package verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
