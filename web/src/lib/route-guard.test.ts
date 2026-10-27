/**
 * NO API ROUTE ANSWERS ONE WALLET'S REQUEST WITH THE OTHER WALLET'S MONEY.
 *
 * A login has two wallets, and a client names one with `?wallet=` (absent is
 * Spot). A route that serves Spot alone must refuse `?wallet=perps`, or it
 * answers a Perps request with the Spot wallet's P&L, resets the Spot book, or
 * stops the Spot grant. So every handler under app/api either starts with
 * walletNotSupported (route-guard.ts), before it reads or writes anything, or
 * reads the wallet itself through readWalletParam (the wallet-aware routes).
 *
 * The sweep below walks EVERY route file (route.ts, and the .tsx/.js/.jsx Next
 * also serves) and every way a module can export a handler, so a route added
 * later is held to it the day it lands; a self-test feeds it the shapes that
 * would otherwise slip past. It reads the handlers through the TypeScript
 * parser rather than by regex, so what it pins is the call structure — the
 * refusal is the handler's own first statement — and not a string that
 * happens to appear.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import ts from "typescript";
import { NO_STORE_HEADERS, perRouteLimiter, walletNotSupported } from "./route-guard";

const ORIGIN = "https://app.merrymen.dev";
const at = (query: string) => ({ url: `${ORIGIN}/api/pnl${query}` });

describe("walletNotSupported", () => {
  it("absent or spot reach the route exactly as before", () => {
    for (const q of ["", "?wallet=spot", "?id=7", "?purpose=perps"]) assert.equal(walletNotSupported(at(q)), null, q);
  });

  it("perps, an unreadable value, or two wallets are refused 400 wallet-not-supported, never stored", async () => {
    for (const q of ["?wallet=perps", "?wallet=", "?wallet=Perps", "?wallet=solana", "?wallet=spot&wallet=perps", "?wallet=spot&wallet=spot"]) {
      const refused = walletNotSupported(at(q));
      assert.ok(refused, q);
      assert.equal(refused.status, 400, q);
      assert.equal(refused.headers.get("cache-control"), "private, no-store", q);
      const body = (await refused.json()) as { code?: string; error?: string };
      assert.equal(body.code, "wallet-not-supported", q);
      assert.match(body.error ?? "", /Spot wallet only.*Nothing was read or changed/, q);
    }
  });
});

describe("NO_STORE_HEADERS and perRouteLimiter", () => {
  it("the header is private, no-store, and cannot be edited by a caller", () => {
    assert.deepEqual({ ...NO_STORE_HEADERS }, { "Cache-Control": "private, no-store" });
    assert.ok(Object.isFrozen(NO_STORE_HEADERS));
  });

  it("allows perMinute calls per caller in a rolling minute, then says when to come back", () => {
    let t = 1_000_000;
    const take = perRouteLimiter(2, () => t);
    assert.deepEqual(take("a"), { ok: true });
    t += 10_000;
    assert.deepEqual(take("a"), { ok: true });
    assert.deepEqual(take("b"), { ok: true }, "each caller has its own budget");
    t += 10_000;
    assert.deepEqual(take("a"), { ok: false, retryAfterSec: 40 });
    t += 40_001;
    assert.deepEqual(take("a"), { ok: true }, "the first call has left the window");
  });
});

// ── the sweep ───────────────────────────────────────────────────────────────

const API = path.join(process.cwd(), "web", "src", "app", "api");
/** Routes that read `?wallet=` themselves (readWalletParam) and answer for each wallet they name. */
const WALLET_AWARE = new Set(["grants/route.ts"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/**
 * EVERY FILE NEXT SERVES AS A ROUTE, not only the `.ts` ones. Next makes a
 * route of `route.` plus any of its default pageExtensions (tsx, ts, jsx, js;
 * next.config.mjs sets none, and the sweep holds that), so a walk that matched
 * `route.ts` by name would never see a `route.js` that Next serves. `.mjs`
 * too: stricter than Next costs nothing. Each is parsed as what it is.
 */
const ROUTE_FILE = /^route\.(?:tsx?|jsx?|mjs)$/;
const SCRIPT_KIND: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".js": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".mjs": ts.ScriptKind.JS,
};

function routeFiles(dir = API, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (ROUTE_FILE.test(entry)) out.push(full);
  }
  return out;
}

type Handler = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const exported = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Every name a destructuring binds: `{ POST }`, `{ reset: POST }`, `{ handlers: { POST } }`, `[, POST]`. */
const boundNames = (name: ts.BindingName): string[] =>
  ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : boundNames(e.name)));

/** `module.exports`, or `exports` used as the CommonJS export object (`exports.POST = …`, `Object.assign(exports, …)`). */
function usesCommonJsExports(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "module" && n.name.text === "exports") found = true;
    else if (ts.isIdentifier(n) && n.text === "exports" && (
      (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n ||
      ts.isCallExpression(n.parent) && n.parent.arguments.includes(n) ||
      ts.isBinaryExpression(n.parent) && n.parent.left === n
    )) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Every exported HTTP handler, resolved to the function that runs — or a name
 * the sweep could not resolve (fn null), which fails.
 *
 * EVERY WAY A MODULE CAN EXPORT A NAME, because Next serves a handler however
 * it was exported: `export function GET`, `export const GET = …`, an export
 * list (`export { reset as POST }`), a re-export (`export { POST } from "./x"`,
 * `export * from "./x"`), a destructured export (`export const { GET, POST } =
 * handlers`, the Auth.js shape) and, in a route.js, CommonJS. A form this walk
 * skipped would be a handler it never checks, in a file it still passes
 * because another handler there is guarded. So what cannot be read here as a
 * function in this file — a re-export, a destructured value, a call's result,
 * an import — is REPORTED, not skipped: the sweep can only vouch for a first
 * statement it can see.
 */
function handlersOf(sf: ts.SourceFile): { name: string; fn: Handler | null }[] {
  const locals = new Map<string, Handler>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) locals.set(s.name.text, s);
    // A `const` bound to a function, never a `let` or `var`: those can be reassigned after the walk has read them.
    if (ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const) {
      for (const d of s.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) locals.set(d.name.text, init);
      }
    }
  }
  const out: { name: string; fn: Handler | null }[] = [];
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && exported(s) && METHODS.has(s.name.text)) out.push({ name: s.name.text, fn: s });
    if (ts.isVariableStatement(s) && exported(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          // `export const { POST } = make()`: a value pulled out of something else, not a function this walk can read.
          for (const name of boundNames(d.name)) if (METHODS.has(name)) out.push({ name, fn: null });
          continue;
        }
        if (!METHODS.has(d.name.text)) continue;
        const init = d.initializer;
        const fn = !init ? null
          : ts.isIdentifier(init) ? locals.get(init.text) ?? null
          : ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init
          : null;
        out.push({ name: d.name.text, fn });
      }
    }
    if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      const from = s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : "?";
      // `export * from "./x"`: whatever handlers that module has, none of them in this file to read.
      if (!s.exportClause) out.push({ name: `* from "${from}"`, fn: null });
      else if (ts.isNamespaceExport(s.exportClause)) {
        if (METHODS.has(s.exportClause.name.text)) out.push({ name: s.exportClause.name.text, fn: null });
      } else {
        for (const e of s.exportClause.elements) {
          if (e.isTypeOnly || !METHODS.has(e.name.text)) continue;
          // From another module (`export { POST } from "./x"`), the function is not in this file to read.
          out.push({ name: e.name.text, fn: s.moduleSpecifier ? null : locals.get((e.propertyName ?? e.name).text) ?? null });
        }
      }
    }
    if (ts.isExportAssignment(s) && s.isExportEquals) out.push({ name: "export =", fn: null });
  }
  // A route is an ES module. CommonJS exports (a route.js) are a second way to
  // hand Next a handler, and not one this walk reads.
  if (usesCommonJsExports(sf)) out.push({ name: "module.exports", fn: null });
  return out;
}

/** The handler's first two statements are `const x = walletNotSupported(<its request>); if (x) return x;`. */
function startsWithRefusal(fn: Handler): boolean {
  const req = fn.parameters[0]?.name;
  if (!req || !ts.isIdentifier(req)) return false;
  if (!fn.body || !ts.isBlock(fn.body)) return false;
  const [first, second] = fn.body.statements;
  if (!first || !ts.isVariableStatement(first) || !second || !ts.isIfStatement(second)) return false;
  const [decl] = first.declarationList.declarations;
  if (!decl || !ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) return false;
  const call = decl.initializer;
  const calls = ts.isIdentifier(call.expression) && call.expression.text === "walletNotSupported" &&
    call.arguments.length === 1 && ts.isIdentifier(call.arguments[0]!) && call.arguments[0].text === req.text;
  const x = decl.name.text;
  const ret = ts.isReturnStatement(second.thenStatement) ? second.thenStatement
    : ts.isBlock(second.thenStatement) && second.thenStatement.statements.length === 1 && ts.isReturnStatement(second.thenStatement.statements[0]!)
      ? second.thenStatement.statements[0] : null;
  const guards = ts.isIdentifier(second.expression) && second.expression.text === x && !second.elseStatement &&
    !!ret?.expression && ts.isIdentifier(ret.expression) && ret.expression.text === x;
  return calls && guards;
}

/** `name` imported from `@/lib/<module>`, or by a relative path to it (a route the worker's tsconfig reaches). */
const importsFrom = (sf: ts.SourceFile, name: string, module: string) =>
  sf.statements.some((s) =>
    ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) &&
    (s.moduleSpecifier.text === `@/lib/${module}` || /^(?:\.\.\/)+lib\//.test(s.moduleSpecifier.text) && s.moduleSpecifier.text.endsWith(`/lib/${module}`)) &&
    !!s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) &&
    s.importClause.namedBindings.elements.some((e) => e.name.text === name && !e.propertyName));

/**
 * The rule, for one route file (`rel` under app/api, and its source). The
 * sweep runs it on every route on disk, and the self-test below on sources
 * shaped to slip past it, so both exercise the same check.
 */
function checkRoute(rel: string, src: string): void {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, SCRIPT_KIND[path.extname(rel)] ?? ts.ScriptKind.TS);
  const handlers = handlersOf(sf);
  assert.ok(handlers.length > 0, `${rel} exports no handler the sweep can see`);
  // Through the helper, never by hand: a hand-read `wallet` is a second
  // parser that can disagree about what absent, empty or repeated means.
  assert.doesNotMatch(src, /searchParams\s*\.\s*(?:get|getAll|has)\(\s*["'`]wallet["'`]/, `${rel} reads ?wallet= by hand; use readWalletParam`);
  for (const { name, fn } of handlers) {
    assert.ok(fn, `${rel} ${name}: export it from this file with \`export\`, as a function (or a local function by name), so its first statement can be checked`);
    if (WALLET_AWARE.has(rel)) {
      assert.ok(importsFrom(sf, "readWalletParam", "wallet-param"), `${rel} must read the wallet through readWalletParam`);
      assert.match(fn.body?.getText(sf) ?? "", /\breadWalletParam\(req\)/, `${rel} ${name} must read ?wallet= (readWalletParam) and answer for the wallet it names`);
    } else {
      assert.ok(importsFrom(sf, "walletNotSupported", "route-guard"), `${rel} must import walletNotSupported from @/lib/route-guard`);
      assert.ok(startsWithRefusal(fn), `${rel} ${name} must START with \`const walletRefused = walletNotSupported(req); if (walletRefused) return walletRefused;\`, before anything is read or written`);
    }
  }
}

describe("every API route refuses a wallet it does not serve", () => {
  const files = routeFiles();

  it("finds the routes (a sweep that walks nothing passes everything)", () => {
    assert.ok(files.length >= 70, `only ${files.length} route files found under ${API}`);
    for (const w of WALLET_AWARE) assert.ok(existsSync(path.join(API, w)), `${w} is listed as wallet-aware and is gone`);
    // ROUTE_FILE is Next's default set. A pageExtensions setting changes which
    // files are routes (`route.api.ts`, say), and the walk would match none.
    const config = readFileSync(path.join(process.cwd(), "web", "next.config.mjs"), "utf8");
    assert.doesNotMatch(config, /pageExtensions/, "next.config.mjs sets pageExtensions: make ROUTE_FILE match every file it makes a route");
  });

  for (const file of files) {
    const rel = path.relative(API, file).split(path.sep).join("/");
    it(rel, () => checkRoute(rel, readFileSync(file, "utf8")));
  }
});

// ── the sweep, held to its own promise ──────────────────────────────────────

describe("the sweep sees a handler however a route exports it", () => {
  const GUARD = "const walletRefused = walletNotSupported(req);\n  if (walletRefused) return walletRefused;\n";
  /** A route file with one guarded GET, the way every route on disk writes it, and then `rest`. */
  const route = (rest: string, { js = false } = {}) => [
    `import { walletNotSupported } from "@/lib/route-guard";`,
    `export async function GET(req${js ? "" : ": Request"}) {\n  ${GUARD}  return new Response("ok");\n}`,
    rest,
  ].join("\n");

  it("walks route.js, route.tsx, route.jsx and route.mjs as well as route.ts, and nothing else", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-route-files-"));
    try {
      const made = ["a/route.ts", "b/route.js", "c/route.tsx", "d/route.jsx", "e/[id]/route.mjs", "f/route.test.ts", "g/not-route.ts", "h/route.d.ts", "i/page.tsx"];
      for (const rel of made) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), "");
      }
      const found = routeFiles(dir).map((f) => path.relative(dir, f).split(path.sep).join("/")).sort();
      assert.deepEqual(found, ["a/route.ts", "b/route.js", "c/route.tsx", "d/route.jsx", "e/[id]/route.mjs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a guarded handler passes however it is exported", () => {
    const guarded = (head: string) => `${head} {\n  ${GUARD}  return new Response("reset");\n}`;
    const shapes: Record<string, [rel: string, src: string]> = {
      "a function declaration": ["probe/route.ts", route("")],
      "an export list": ["probe/route.ts", route(`${guarded("async function reset(req: Request)")}\nexport { reset as POST };`)],
      "an export list naming a const arrow": ["probe/route.ts", route(`const reset = async (req: Request) => ${guarded("")};\nexport { reset as POST };`)],
      "a const naming a const arrow": ["probe/route.ts", route(`const reset = async (req: Request) => ${guarded("")};\nexport const POST = reset;`)],
      "a route.js": ["probe/route.js", route(`${guarded("export async function POST(req)")}`, { js: true })],
      "a route.tsx": ["probe/route.tsx", route(`${guarded("export async function POST(req: Request)")}`)],
    };
    for (const [shape, [rel, src]] of Object.entries(shapes)) assert.doesNotThrow(() => checkRoute(rel, src), shape);
  });

  it("an unguarded handler fails however it is exported, a guarded GET beside it notwithstanding", () => {
    const make = `const make = () => ({ POST: async (req: Request) => new Response("reset"), reset: async (req: Request) => new Response("reset") });`;
    const shapes: Record<string, [rel: string, src: string, blames: RegExp]> = {
      // The control: the form the sweep always walked.
      "a function declaration": ["probe/route.ts", route(`export async function POST(req: Request) { return new Response("reset"); }`), / POST must START/],
      "an export list": ["probe/route.ts", route(`async function reset(req: Request) { return new Response("reset"); }\nexport { reset as POST };`), / POST must START/],
      "an export list naming a const arrow": ["probe/route.ts", route(`const reset = async (req: Request) => new Response("reset");\nexport { reset as POST };`), / POST must START/],
      "an export list naming an import": ["probe/route.ts", route(`import { reset } from "./elsewhere";\nexport { reset as POST };`), / POST: export it/],
      "an export list naming a let": ["probe/route.ts", route(`let reset = async (req: Request) => new Response("reset");\nexport { reset as POST };`), / POST: export it/],
      "a destructured export (the Auth.js shape)": ["probe/route.ts", route(`${make}\nexport const { POST } = make();`), / POST: export it/],
      "a renamed destructured export": ["probe/route.ts", route(`${make}\nexport const { reset: POST } = make();`), / POST: export it/],
      "a nested destructured export": ["probe/route.ts", route(`export const { handlers: { POST } } = { handlers: { POST: () => new Response("reset") } };`), / POST: export it/],
      "an array destructured export": ["probe/route.ts", route(`export const [, POST] = [null, () => new Response("reset")];`), / POST: export it/],
      "a re-export": ["probe/route.ts", route(`export { POST } from "./elsewhere";`), / POST: export it/],
      "a renamed re-export": ["probe/route.ts", route(`export { reset as POST } from "./elsewhere";`), / POST: export it/],
      "a re-export of everything": ["probe/route.ts", route(`export * from "./elsewhere";`), / \* from "\.\/elsewhere": export it/],
      "a namespace re-export": ["probe/route.ts", route(`export * as POST from "./elsewhere";`), / POST: export it/],
      "`export =`": ["probe/route.ts", route(`export = { POST: async (req: Request) => new Response("reset") };`), / export =: export it/],
      "CommonJS, by name": ["probe/route.js", route(`exports.POST = async function (req) { return new Response("reset"); };`, { js: true }), / module\.exports: export it/],
      "CommonJS, the whole object": ["probe/route.js", route(`module.exports = { POST: async (req) => new Response("reset") };`, { js: true }), / module\.exports: export it/],
      "CommonJS, merged in": ["probe/route.js", route(`Object.assign(exports, { POST: async (req) => new Response("reset") });`, { js: true }), / module\.exports: export it/],
      "a route.tsx": ["probe/route.tsx", route(`export async function POST(req: Request) { return new Response("reset"); }`), / POST must START/],
    };
    for (const [shape, [rel, src, blames]] of Object.entries(shapes)) {
      assert.throws(() => checkRoute(rel, src), (err: unknown) => {
        assert.ok(err instanceof assert.AssertionError, `${shape}: ${String(err)}`);
        assert.match(err.message, blames, shape);
        return true;
      }, shape);
    }
  });
});

// ── and it holds at run time, before anything is touched ────────────────────

describe("a refused request reads and changes nothing", () => {
  const ENV = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL"] as const;
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const SPOT_GRANT = JSON.stringify({ smartAccount: `0x${"22".repeat(20)}`, demoOwnerPrivateKey: `0x${"01".repeat(32)}` });
  let home = "";
  before(() => {
    home = mkdtempSync(path.join(tmpdir(), "mm-route-guard-"));
    process.env.MERRYMEN_HOME = home;
    for (const k of ["MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL"] as const) delete process.env[k];
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("Start over for ?wallet=perps does not discard the Spot grant (self-hosted)", async () => {
    writeFileSync(path.join(home, "grant.json"), SPOT_GRANT);
    const { POST } = await import("../app/api/grants/discard/route");
    for (const q of ["?wallet=perps", "?wallet=nope"]) {
      const res = await POST(new Request(`${ORIGIN}/api/grants/discard${q}`, { method: "POST", body: "{}" }));
      assert.equal(res.status, 400, q);
      assert.equal(((await res.json()) as { code?: string }).code, "wallet-not-supported", q);
      assert.equal(readFileSync(path.join(home, "grant.json"), "utf8"), SPOT_GRANT, `${q}: the Spot grant is untouched`);
      assert.equal(existsSync(path.join(home, "grants")), false, `${q}: nothing was archived`);
    }
  });

  it("a practice reset for ?wallet=perps queues nothing for the Spot book", async () => {
    writeFileSync(path.join(home, "grant.json"), SPOT_GRANT);
    const { POST } = await import("../app/api/paper-reset/route");
    const res = await POST(new Request(`${ORIGIN}/api/paper-reset?wallet=perps`, { method: "POST" }));
    assert.equal(res.status, 400);
    assert.equal(existsSync(path.join(home, "commands")), false);
    // And Spot, named or not, is the reset it always was.
    const spot = await POST(new Request(`${ORIGIN}/api/paper-reset?wallet=spot`, { method: "POST" }));
    assert.equal(spot.status, 200);
    assert.equal(readdirSync(path.join(home, "commands")).filter((n) => n.endsWith(".json")).length, 1);
  });

  it("a public read answers Spot's question only", async () => {
    const { GET } = await import("../app/api/version/route");
    assert.equal((await GET(new Request(`${ORIGIN}/api/version?wallet=perps`))).status, 400);
    assert.equal((await GET(new Request(`${ORIGIN}/api/version?wallet=spot`))).status, 200);
    assert.equal((await GET(new Request(`${ORIGIN}/api/version`))).status, 200);
  });
});
