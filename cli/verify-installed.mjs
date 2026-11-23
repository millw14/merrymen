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
      // GHSA-mrhx-c7xc-m3w5. No zod 3 is patched, so any zod 3 copy fails here.
      case "zod": safe = atLeast([4, 6, 6]); break;
      default: continue;
    }
    seen.add(pkg.name);
    assert.ok(safe, `Unpatched installed dependency: ${location}@${pkg.version}`);
  }
  for (const name of ["postcss", "ws", "bn.js", "uuid", "@walletconnect/utils", "zod"]) {
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
 * npm audit's report, judged: any finding fails the audit, naming every
 * vulnerable package. There is no exception.
 *
 * The time-boxed zod 3 exception for GHSA-mrhx-c7xc-m3w5 (PRs #360 and #379,
 * last day 2026-11-22) is gone. Its four copies came in through
 * @privy-io/react-auth under x402, @coinbase/cdp-sdk and @reown/appkit-wallet
 * (also nested under @wagmi/connectors); no zod 3 release is patched. The
 * package.json overrides now give those three packages Merrymen's own patched
 * zod 4 (Milla's decision of 2026-11-24, docs/perps-paper-launch.md), and
 * assertPatched above rejects any zod older than 4.6.6. With those copies
 * gone, the abitype copies under @coinbase/cdp-sdk (1.0.6) and
 * @wagmi/connectors (1.0.8) also resolve the root zod 4, against their
 * optional peer "^3 >=3.22.0"; only cdp-sdk's policy schemas import
 * abitype/zod. web/src/lib/dependency-compatibility.test.ts checks that these
 * SDKs accept and reject sample payloads on zod 4, and fails once any of them
 * stops declaring zod 3. Drop an override when: Privy 3.52.x drops x402; a
 * Reown appkit-wallet on zod 4 (appkit PRs #5830/#5844) is what WalletConnect
 * and Privy pin; cdp-sdk accepts zod 4 (cdp-sdk PR #867).
 */
export function evaluateAudit(audit) {
  if (audit.error) throw new Error(`npm audit failed: ${JSON.stringify(audit.error)}`);
  const remaining = Object.entries(audit.vulnerabilities ?? {});
  if (remaining.length > 0) {
    const named = remaining.map(([name, finding]) => `${name} (${finding.severity}: ${finding.via.map((via) => typeof via === "string" ? `via ${via}` : via.url ?? via.title).join(", ")})`).join("; ");
    throw new Error(`Installed dependency audit failed: ${remaining.length} vulnerable packages: ${named}.`);
  }
}

export function auditPhysicalLock(snapshot) {
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
    // npm exits 1 whenever it reports anything; a failure with no report is
    // still a failure.
    if (result.status !== 0 && !audit.error && Object.keys(audit.vulnerabilities ?? {}).length === 0) {
      throw new Error(`npm audit exited ${result.status} without a report: ${result.stderr}`);
    }
    evaluateAudit(audit);
    return { metadata: audit.metadata };
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
    // Proving libraries retain worker threads. Run the offline compiled-bundle
    // check in its bounded process so installation verification always terminates.
    const proofCheck = spawnSync(process.execPath, [fileURLToPath(new URL("./gloam-bundle-smoke.mjs", import.meta.url)), root], {
      encoding: "utf8", timeout: 75_000, maxBuffer: 1024 * 1024,
    });
    if (proofCheck.error || proofCheck.status !== 0) throw new Error("Prebuilt Gloam bundle verification failed.");
    const { metadata } = auditPhysicalLock(snapshot);
    console.log(`[merrymen] Verified ${Object.keys(snapshot.lock.packages).length - 1} installed packages; native sharp, esbuild and Next SWC plus bundled Gloam proof/encryption modules work; audit: ${metadata.vulnerabilities.total} vulnerabilities.`);
  } catch (error) {
    console.error(`[merrymen] Installed package verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
