/**
 * Server env vars do not exist in the browser bundle.
 *
 * This pins the defect that made hosted onboarding fail for every tester, in a
 * way that cannot come back. `isHostedMode()` reads `process.env.MERRYMEN_HOSTED`
 * (packages/core/src/hosted.ts). Next inlines only `NEXT_PUBLIC_*` into the
 * client bundle, and web/next.config.mjs declares no `env` block — so in any
 * `"use client"` module that call evaluates to `false` no matter how the server
 * is configured.
 *
 * It did exactly that in web/src/lib/session.ts, which used it to decide whether
 * to strip the owner key before POSTing a grant. It never stripped it, the
 * server refused every hosted grant with a 422, and nothing surfaced the
 * refusal. The bug is invisible by construction: no type error, no runtime
 * throw, just a constant that is quietly always false.
 *
 * The client's only trustworthy signal is GET /api/auth/session, which returns
 * {hosted, address} at runtime.
 *
 * Route handlers under app/api are server-side (node runtime) and may use it
 * freely — that is where it belongs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(process.cwd(), "web", "src");

// Explicit server entry helpers only. The import-graph test below prevents
// this exception list from admitting these modules into a client subtree.
const knownServerModules = new Set([
  // Signed partner routes; session crypto, SQLite and Postgres dependencies.
  path.join(SRC, "lib", "partner-runtime.ts"),
  path.join(SRC, "lib", "partner-store.ts"),
  // Read by server routes (/mcp, /oauth/*, /.well-known/*, /api/mcp/*), with
  // node:crypto-backed dependencies. It is not browser MCP configuration.
  path.join(SRC, "mcp", "config.ts"),
  // Private pilot routes; imports the Node-backed pilot/settings stores and
  // session authentication. Browser views use its HTTP responses instead.
  path.join(SRC, "lib", "perps-pilot-api.ts"),
  // Async server-page wrapper: next/headers cookies and the hosted gate are
  // evaluated on the server before rendering the separate client children.
  path.join(SRC, "pilot", "PilotPage.tsx"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Load-bearing: the files that explain this bug NAME it, and a naive scan would
 * flag the very comments warning people off it. Only real code counts.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no client module imports isHostedMode — it is always false in the browser", () => {
  const apiDir = path.join(SRC, "app", "api");
  const offenders = walk(SRC)
    .filter((f) => !f.startsWith(apiDir)) // route handlers are server-side
    .filter((f) => !knownServerModules.has(f))
    .filter((f) => /\bisHostedMode\b/.test(code(f)))
    .map((f) => path.relative(process.cwd(), f));

  assert.deepEqual(
    offenders,
    [],
    `These files reference isHostedMode() outside app/api. It reads process.env, which Next does ` +
      `not inline into the browser bundle, so it is ALWAYS false there — the exact bug that made ` +
      `every hosted grant get refused with nobody able to see why. Use GET /api/auth/session ` +
      `({hosted,address}) instead.\n  ${offenders.join("\n  ")}`,
  );
});

/** Same TypeScript resolution as the Perps gate guard: aliases, barrels and
 * literal import()/require() calls cannot hide a server helper from a client.
 * Type-only edges vanish from the browser bundle and do not count. */
function clientServerPaths(sources: ReadonlyMap<string, string>): string[][] {
  const config = ts.readConfigFile(path.join(ROOT, "web", "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(ROOT, "web"));
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    fileExists: file => sources.has(file) || ts.sys.fileExists(file),
    readFile: file => sources.get(file) ?? ts.sys.readFile(file),
    directoryExists: dir => [...sources.keys()].some(file => file.startsWith(`${dir}${path.sep}`)) || ts.sys.directoryExists(dir),
  };
  const cache = ts.createModuleResolutionCache(ROOT, file => file, parsed.options);
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
    for (const statement of source(file).statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      if (statement.expression.text === "use client") return true;
    }
    return false;
  };
  const edges = new Map<string, string[]>();
  const imports = (file: string): string[] => {
    const cached = edges.get(file);
    if (cached) return cached;
    const specifiers: string[] = [];
    const add = (node: ts.Node | undefined) => { if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text); };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause, named = clause?.namedBindings;
        const typesOnly = named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
        if (!clause?.isTypeOnly && !(typesOnly && !clause?.name)) add(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node)) {
        const named = node.exportClause;
        const typesOnly = named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
        if (!node.isTypeOnly && !typesOnly) add(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        add(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source(file));
    const resolved = specifiers.flatMap(specifier => {
      const target = ts.resolveModuleName(specifier, file, parsed.options, host, cache).resolvedModule?.resolvedFileName;
      return target && target.startsWith(`${ROOT}${path.sep}`) && !target.includes(`${path.sep}node_modules${path.sep}`) ? [target] : [];
    });
    edges.set(file, resolved);
    return resolved;
  };
  const find = (file: string, visited: Set<string>): string[] | null => {
    if (knownServerModules.has(file)) return [file];
    if (visited.has(file)) return null;
    visited.add(file);
    for (const dependency of imports(file)) {
      const chain = find(dependency, visited);
      if (chain) return [file, ...chain];
    }
    return null;
  };
  return [...sources.keys()].filter(client).flatMap(file => {
    const chain = find(file, new Set());
    return chain ? [chain] : [];
  });
}

test("known server exceptions remain unreachable from every client import subtree", () => {
  const sources = new Map(walk(SRC).map(file => [file, readFileSync(file, "utf8")]));
  const paths = clientServerPaths(sources).map(chain => chain.map(file => path.relative(ROOT, file)).join(" -> "));
  assert.deepEqual(paths, [], `A server-only environment helper reached a client bundle:\n${paths.join("\n")}`);
});

test("server-exception guard catches an aliased barrel and a literal dynamic import, but permits type-only imports", () => {
  const client = path.join(SRC, "__client_env_probe__", "client.tsx");
  const barrel = path.join(SRC, "__client_env_probe__", "barrel.ts");
  const page = path.join(SRC, "pilot", "PilotPage.tsx");
  const api = path.join(SRC, "lib", "perps-pilot-api.ts");
  assert.deepEqual(clientServerPaths(new Map([
    [client, '"use client"; import { PilotPage } from "@/__client_env_probe__/barrel"; export const Page = PilotPage;'],
    [barrel, 'export { PilotPage } from "../pilot/PilotPage";'],
  ])), [[client, barrel, page]]);
  assert.deepEqual(clientServerPaths(new Map([
    [client, '"use client"; export const load = () => import("@/lib/perps-pilot-api");'],
  ])), [[client, api]]);
  assert.deepEqual(clientServerPaths(new Map([
    [client, '"use client"; import type { PilotPage } from "@/pilot/PilotPage"; export type Page = typeof PilotPage;'],
  ])), []);
});
