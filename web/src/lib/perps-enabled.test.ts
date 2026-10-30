/**
 * THE WEB'S PERPS GATE IS THE WORKER'S, READ THE SAME WAY.
 *
 * perpsOffered, perpsCreationAllowed and perpsWorkersRun answer from
 * MERRYMEN_PERPS through the one core parser, so the web cannot offer a wallet
 * the deployment's workers would stand down, or queue for a worker that is not
 * running. Unset is off (rule 1), `live` is off in this build, and a typo is off.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import { perpsCreationAllowed, perpsOffered, perpsWalletRefused, perpsWorkersRun } from "./perps-enabled";
import { perpsCeilingOf as workerCeilingOf } from "../../../worker/src/settings";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "web", "src");
const GATE = path.join(SRC, "lib", "perps-enabled.ts");

function clientGatePaths(sources: ReadonlyMap<string, string>): string[][] {
  // Use the same paths and resolution rules as the web build. An alias,
  // re-export or shared helper must not hide a server-only gate from this
  // check. Fixtures override files in memory; they never enter the app tree.
  const config = ts.readConfigFile(path.join(ROOT, "web", "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(ROOT, "web"));
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    fileExists: (file) => sources.has(file) || ts.sys.fileExists(file),
    readFile: (file) => sources.get(file) ?? ts.sys.readFile(file),
    directoryExists: (dir) => [...sources.keys()].some((file) => file.startsWith(`${dir}${path.sep}`)) || ts.sys.directoryExists(dir),
  };
  const cache = ts.createModuleResolutionCache(ROOT, (file) => file, parsed.options);
  const syntax = new Map<string, ts.SourceFile>();
  const source = (file: string): ts.SourceFile => {
    let tree = syntax.get(file);
    if (!tree) {
      tree = ts.createSourceFile(file, host.readFile(file) ?? "", ts.ScriptTarget.Latest, true);
      syntax.set(file, tree);
    }
    return tree;
  };
  const client = (file: string): boolean => {
    for (const stmt of source(file).statements) {
      if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
      if (stmt.expression.text === "use client") return true;
    }
    return false;
  };
  const edges = new Map<string, string[]>();
  const imports = (file: string): string[] => {
    const known = edges.get(file);
    if (known) return known;
    const specifiers: string[] = [];
    const add = (value: ts.Node | undefined) => {
      if (value && ts.isStringLiteralLike(value)) specifiers.push(value.text);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typesOnly = named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
        if (!clause?.isTypeOnly && !(typesOnly && !clause?.name)) add(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node)) {
        const named = node.exportClause;
        const typesOnly = named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
        if (!node.isTypeOnly && !typesOnly) add(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        add(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source(file));
    const resolved = specifiers.flatMap((specifier) => {
      const target = ts.resolveModuleName(specifier, file, parsed.options, host, cache).resolvedModule?.resolvedFileName;
      return target && target.startsWith(`${ROOT}${path.sep}`) && !target.includes(`${path.sep}node_modules${path.sep}`) ? [target] : [];
    });
    edges.set(file, resolved);
    return resolved;
  };
  const find = (file: string, visited: Set<string>): string[] | null => {
    if (file === GATE) return [file];
    if (visited.has(file)) return null;
    visited.add(file);
    for (const dependency of imports(file)) {
      const chain = find(dependency, visited);
      if (chain) return [file, ...chain];
    }
    return null;
  };
  return [...sources.keys()].filter(client).flatMap((file) => {
    const chain = find(file, new Set());
    return chain ? [chain] : [];
  });
}

describe("the client gate guard", () => {
  const client = path.join(SRC, "__perps_gate_probe__", "client.tsx");
  const helper = path.join(SRC, "__perps_gate_probe__", "helper.ts");
  const barrel = path.join(SRC, "__perps_gate_probe__", "barrel.ts");

  it("follows an alias through a helper and barrel to the server gate", () => {
    const sources = new Map([
      [client, '"use client"; import { offered } from "@/__perps_gate_probe__/helper"; export const visible = offered();'],
      [helper, 'import { perpsOffered } from "./barrel"; export const offered = perpsOffered;'],
      [barrel, 'export { perpsOffered } from "../lib/perps-enabled";'],
    ]);
    assert.deepEqual(clientGatePaths(sources), [[client, helper, barrel, GATE]]);
  });

  it("follows a literal dynamic import, and does not loop on a circular helper", () => {
    const sources = new Map([
      [client, '"use client"; export const load = () => import("./helper");'],
      [helper, 'import "./client"; export { perpsOffered } from "../lib/perps-enabled";'],
    ]);
    assert.deepEqual(clientGatePaths(sources), [[client, helper, GATE]]);
  });

  it("does not treat comments, server-only modules or type-only edges as client imports", () => {
    const sources = new Map([
      [client, '"use client"; import type { Example } from "./helper"; export type View = Example; // perps-enabled is server-only'],
      [helper, 'import { perpsOffered } from "../lib/perps-enabled"; export type Example = typeof perpsOffered;'],
      [barrel, '// "use client"\nexport { perpsOffered } from "../lib/perps-enabled";'],
    ]);
    assert.deepEqual(clientGatePaths(sources), []);
  });
});

describe("the web's perps gate", () => {
  it("unset is off: nothing offered, nothing made, no worker runs", () => {
    assert.equal(perpsOffered({}), false);
    assert.equal(perpsCreationAllowed({}), false);
    assert.equal(perpsWorkersRun({}), false);
  });

  it("paper offers Perps, allows a paper wallet to be made, and runs its worker", () => {
    for (const v of ["paper", " Paper "]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), true, v);
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), true, v);
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), true, v);
    }
  });

  it("off, live (not in this build) and anything unrecognised are off for all three", () => {
    for (const v of ["off", "", "live", "LIVE", "lvie", "1", "true", "on", "paper,live"]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), false, v);
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), false, v);
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), false, v);
    }
  });

  // The lever values both checks below ask: the ones an operator means, and the
  // spellings a hand-rolled parse would read differently from the core one
  // (case, padding, a near-miss, a list). A rule that agreed only on "paper"
  // would still part from the web on " Paper ".
  const LEVERS = [undefined, "", "paper", " Paper ", "PAPER", "\tpaper\n", "live", "LIVE", "off", "x", "papers", "paper,live", "1"];

  it("perpsWorkersRun is the orchestrator's spawn rule, asked the orchestrator's own function", async () => {
    // The web refuses a Perps exit or reset when this says no worker runs, so
    // it must answer exactly as the orchestrator decides whether to start one
    // (D1, D18): otherwise an owner is refused a Close on a server whose
    // orchestrator runs their worker, or told "queued" for one that never
    // starts. Asked of the real export, not a copy of its rule.
    // Loaded by a computed specifier so the web typecheck does not take in the whole orchestrator.
    const orchestrator = "../../../worker/src/orchestrator";
    const { perpsSpawnable } = (await import(orchestrator)) as { perpsSpawnable(env: Record<string, string | undefined>): boolean };
    assert.equal(typeof perpsSpawnable, "function", "the orchestrator exports its spawn rule");
    for (const v of LEVERS) {
      const env = v === undefined ? {} : { MERRYMEN_PERPS: v };
      assert.equal(perpsWorkersRun(env), perpsSpawnable(env), `MERRYMEN_PERPS=${JSON.stringify(v)}`);
    }
    // And it reads the env it is handed, not this process's: with the process
    // saying paper, an env saying off is still off (and the reverse).
    const saved = process.env.MERRYMEN_PERPS;
    try {
      process.env.MERRYMEN_PERPS = "paper";
      assert.equal(perpsSpawnable({ MERRYMEN_PERPS: "off" }), false);
      delete process.env.MERRYMEN_PERPS;
      assert.equal(perpsSpawnable({ MERRYMEN_PERPS: "paper" }), true);
    } finally {
      if (saved === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = saved;
    }
  });

  it("perpsWorkersRun is a self-hosted Perps worker's stand-down, read the same way (D19)", async () => {
    const { mergeSettings, perpsWorkerStoodDown } = await import("../../../worker/src/settings");
    for (const v of LEVERS) {
      const perpsWorker = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", ...(v === undefined ? {} : { MERRYMEN_PERPS: v }) });
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), !perpsWorkerStoodDown(perpsWorker), `MERRYMEN_PERPS=${JSON.stringify(v)}`);
    }
  });

  it("perpsWalletRefused: 403 perps-wallet-not-offered, the grants route's code, in the owner's words, never stored", async () => {
    const res = perpsWalletRefused("No Perps order was queued.");
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await res.json(), {
      error: "Perps wallets are not offered on this server yet. No Perps order was queued.",
      code: "perps-wallet-not-offered",
      ownerFacing: true,
    });
  });

  it("reads the process's own environment when none is passed", () => {
    const saved = process.env.MERRYMEN_PERPS;
    try {
      delete process.env.MERRYMEN_PERPS;
      assert.equal(perpsOffered(), false);
      assert.equal(perpsCreationAllowed(), false);
      assert.equal(perpsWorkersRun(), false);
      process.env.MERRYMEN_PERPS = "paper";
      assert.equal(perpsOffered(), true);
      assert.equal(perpsCreationAllowed(), true);
      assert.equal(perpsWorkersRun(), true);
    } finally {
      if (saved === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = saved;
    }
  });

  it("is the worker's parser, not a second one that can drift", () => {
    // worker/src/settings.ts re-exports the core parser; the web imports the same file.
    for (const v of [undefined, "paper", "live", "off", "x"]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), workerCeilingOf(v) !== "off", String(v));
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), workerCeilingOf(v) === "paper", String(v));
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), workerCeilingOf(v) === "paper", String(v));
    }
  });

  it("no client module imports it: in a browser bundle process.env is empty, so it would always say off", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.[cm]?[jt]sx?$/.test(entry) && !/\.test\.[cm]?[jt]sx?$/.test(entry) && !/\.d\.[cm]?ts$/.test(entry)) out.push(full);
      }
      return out;
    };
    const offenders = clientGatePaths(new Map(walk(SRC).map((f) => [f, readFileSync(f, "utf8")])))
      .map((chain) => chain.map((f) => path.relative(ROOT, f)).join(" -> "));
    assert.deepEqual(offenders, []);
  });
});
