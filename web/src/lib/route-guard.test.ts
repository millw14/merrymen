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
 * refusal is the handler's own first statement, and on a wallet-aware route
 * the wallet's read and its refusal are — and not a string that happens to
 * appear, in a comment or anywhere else.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import ts from "typescript";
import { NO_STORE_HEADERS, perRouteLimiter, walletNotSupported, walletUnknown } from "./route-guard";

const ORIGIN = "https://app.merrymen.dev";
const at = (query: string) => ({ url: `${ORIGIN}/api/pnl${query}` });

describe("walletNotSupported", () => {
  it("absent or spot reach the route exactly as before", () => {
    for (const q of ["", "?wallet=spot", "?id=7", "?purpose=perps"]) assert.equal(walletNotSupported(at(q)), null, q);
  });

  it("perps, an unreadable value, or two wallets are refused 400 wallet-not-supported, never stored", async () => {
    for (const q of ["?wallet=perps", "?wallet=", "?wallet=Perps", "?wallet=solana", "?wallet=spot&wallet=perps", "?wallet=spot&wallet=spot", "?Wallet=perps", "?WALLET=perps", "?wallet=spot&Wallet=perps"]) {
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

describe("walletUnknown, a wallet-aware route's refusal of a wallet it cannot read", () => {
  it("is a 400 wallet-unknown that names both wallets and says what was not done, never stored", async () => {
    const refused = walletUnknown("Nothing was queued.");
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get("cache-control"), "private, no-store");
    const body = (await refused.json()) as { code?: string; error?: string };
    assert.equal(body.code, "wallet-unknown");
    assert.match(body.error ?? "", /wallet=spot or wallet=perps\)\. Nothing was queued\.$/);
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
/**
 * Routes that read `?wallet=` themselves (readWalletParam) and answer for each
 * wallet they name: the grants (5b), and the Perps wallet's settings, exits
 * and practice reset (5c).
 */
const WALLET_AWARE = new Set(["grants/route.ts", "settings/route.ts", "orders/route.ts", "paper-reset/route.ts", "perps/offered/route.ts", "perps/pilot/route.ts", "perps/pilot/redeem/route.ts", "perps/pilot/admin/route.ts", "perps/account/route.ts", "perps/activity/route.ts", "perps/chart/route.ts", "perps/market/route.ts", "recover/route.ts", "recover/ticket/route.ts", "bundler/[chainId]/route.ts"]);
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
const isConst = (s: ts.VariableStatement) => (s.declarationList.flags & ts.NodeFlags.Const) !== 0;

/**
 * Every name the file ASSIGNS anywhere: `POST = …`, `POST ||= …`, `[POST] = …`,
 * `({ POST } = …)`, `POST++`, `for (POST of …)`.
 *
 * AN EXPORT IS A LIVE BINDING. Next serves whatever the exported name holds
 * once the module has run, not the function the walk read, so a guarded
 * handler reassigned later in the file is an unguarded one. In a .ts file tsc
 * refuses most of these, but a route.js is not typechecked (allowJs, no
 * checkJs), and a `let` or `var` may be reassigned anywhere. Scope is not
 * resolved: an inner variable that shares a handler's name is reported too,
 * which is the safe direction for a check whose only failure is a refusal.
 */
function assignedNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const targets = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text);
    else if (ts.isParenthesizedExpression(n)) targets(n.expression);
    else if (ts.isArrayLiteralExpression(n)) n.elements.forEach(targets);
    else if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) targets(n.expression);
    else if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isShorthandPropertyAssignment(p)) out.add(p.name.text);
        else if (ts.isPropertyAssignment(p)) targets(p.initializer);
        else if (ts.isSpreadAssignment(p)) targets(p.expression);
      }
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) targets(n.left); // a default: `[POST = x] = …`
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) targets(n.left);
    else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) targets(n.operand);
    else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) targets(n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

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
 *
 * AND ONLY A BINDING THAT CANNOT CHANGE UNDER IT. An export is a live binding:
 * Next serves what the name holds after the module has run. So an exported
 * `let` or `var` is reported whatever it starts as (it can be reassigned after
 * the walk has read it, which is why `locals` never held one either), and so
 * is any handler — or the local function it names — that the file assigns to
 * anywhere (assignedNames): `export function POST` followed by `POST = …` is
 * legal in a route.js, which nothing typechecks.
 */
function handlersOf(sf: ts.SourceFile): { name: string; fn: Handler | null; why?: string }[] {
  const locals = new Map<string, Handler>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) locals.set(s.name.text, s);
    // A `const` bound to a function, never a `let` or `var`: those can be
    // reassigned after the walk has read them. A function declaration can be
    // too (in a route.js nothing typechecks), so `resolved` below refuses any
    // local the file assigns to, whatever declared it.
    if (ts.isVariableStatement(s) && isConst(s)) {
      for (const d of s.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) locals.set(d.name.text, init);
      }
    }
  }
  const assigned = assignedNames(sf);
  const out: { name: string; fn: Handler | null; why?: string }[] = [];
  /** A handler the walk resolved, unless its exported name or the local it names is assigned to in this file. */
  const resolved = (name: string, fn: Handler | null, local: string = name) => {
    if (fn && (assigned.has(name) || assigned.has(local))) {
      out.push({ name, fn: null, why: `it is reassigned in this file (${assigned.has(name) ? name : local} = …), and Next serves what the export holds after that` });
    } else out.push({ name, fn });
  };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && exported(s) && METHODS.has(s.name.text)) resolved(s.name.text, s);
    if (ts.isVariableStatement(s) && exported(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          // `export const { POST } = make()`: a value pulled out of something else, not a function this walk can read.
          for (const name of boundNames(d.name)) if (METHODS.has(name)) out.push({ name, fn: null });
          continue;
        }
        if (!METHODS.has(d.name.text)) continue;
        // `export let POST = <guarded>` then `POST = <anything>`: the walk would
        // check the first and Next would serve the second.
        if (!isConst(s)) {
          out.push({ name: d.name.text, fn: null, why: "it is a `let` or `var`, which can be reassigned after this walk has read it; export a `const` or a function" });
          continue;
        }
        const init = d.initializer;
        const fn = !init ? null
          : ts.isIdentifier(init) ? locals.get(init.text) ?? null
          : ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init
          : null;
        resolved(d.name.text, fn, init && ts.isIdentifier(init) ? init.text : d.name.text);
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
          const local = (e.propertyName ?? e.name).text;
          if (s.moduleSpecifier) out.push({ name: e.name.text, fn: null });
          else resolved(e.name.text, locals.get(local) ?? null, local);
        }
      }
    }
    if (ts.isExportAssignment(s) && s.isExportEquals) out.push({ name: "export =", fn: null });
    // `export import POST = H.POST` (a namespace's member) or `= Other.POST`
    // (an import's): TypeScript's alias export. It typechecks under
    // isolatedModules and Next's SWC emits it as `export const POST = H.POST`,
    // which Next serves — and the function it names is not this statement.
    if (ts.isImportEqualsDeclaration(s) && exported(s) && METHODS.has(s.name.text)) {
      out.push({ name: s.name.text, fn: null, why: "it is an `export import` alias of something else, not a function this walk can read" });
    }
  }
  // A route is an ES module. CommonJS exports (a route.js) are a second way to
  // hand Next a handler, and not one this walk reads.
  if (usesCommonJsExports(sf)) out.push({ name: "module.exports", fn: null });
  return out;
}

/**
 * THE NAMES THE MODULE REALLY EXPORTS, as TypeScript's own checker binds them:
 * the backstop behind handlersOf, which can only report the export forms it
 * was written to recognise.
 *
 * "Every way a module can export a name" was a promise that list kept by
 * hand, and it broke once already: `export import POST = H.POST` was no form
 * handlersOf looked at, so a route with a guarded GET and that alias passed
 * the sweep while Next served the aliased POST. The checker is the compiler's
 * answer to what this file exports, whatever the syntax, so a METHOD name it
 * lists and the walk did not resolve fails the route (checkRoute) — a form
 * nobody has thought of yet included.
 *
 * ONE FILE, NOTHING RESOLVED (noResolve, noLib): what another module exports
 * is not this file's to vouch for, and `export *` / `export { … } from` are
 * reported by the walk already. Types are not code: an exported interface or
 * type alias, or a type-only export, is never served, so it is not counted.
 */
function exportedNames(rel: string, src: string): string[] {
  const fileName = `/sweep/${rel}`;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, SCRIPT_KIND[path.extname(rel)] ?? ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === fileName ? sf : undefined),
    getDefaultLibFileName: () => "/sweep/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/sweep",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === fileName,
    readFile: (f) => (f === fileName ? src : undefined),
  };
  const program = ts.createProgram({
    rootNames: [fileName],
    options: { noLib: true, noResolve: true, allowJs: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    host,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(fileName)!);
  if (!mod) return [];
  const typeOnly = (d: ts.Declaration) =>
    ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) ||
    (ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly));
  return checker
    .getExportsOfModule(mod)
    .filter((s) => (s.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) !== 0 && !(s.declarations ?? []).every(typeOnly))
    .map((s) => s.name);
}

/**
 * Whether the handler's PARAMETER LIST runs code before its body does: a
 * default (`ctx = queue()`), a default inside a destructuring (`{ params: { id
 * = queue() } }`, which runs, because Next's `params` is a promise with no
 * `id`), or a computed key (`{ [queue()]: x }`, which always runs). Any of
 * them is a read or a write ahead of the refusal the first statement makes,
 * so a handler whose parameters do any of it fails, guarded body or not.
 * Types are not code: `{ params }: { params: Promise<…> }` passes.
 */
function parametersRunCode(fn: Handler): boolean {
  const runs = (name: ts.BindingName): boolean =>
    !ts.isIdentifier(name) &&
    name.elements.some((el) =>
      !ts.isOmittedExpression(el) &&
      (!!el.initializer || (!!el.propertyName && ts.isComputedPropertyName(el.propertyName)) || runs(el.name)));
  return fn.parameters.some((p) => !!p.initializer || runs(p.name));
}

/**
 * The handler's first two statements are `const x = walletNotSupported(<its
 * request>); if (x) return x;`, AND NOTHING ELSE RUNS BEFORE THE `if`: the
 * first statement declares that one name and no other, as a `const`, and the
 * parameter list runs nothing (parametersRunCode).
 *
 * ONE DECLARATOR, because every declarator of a statement runs before the next
 * statement does: `const walletRefused = walletNotSupported(req), queued =
 * await queuePaperReset(…); if (walletRefused) return walletRefused;` queued
 * a Spot reset for a request that named the Perps wallet and then refused it,
 * and this check, which read only the first declarator, passed it.
 */
function startsWithRefusal(fn: Handler): boolean {
  const req = fn.parameters[0]?.name;
  if (!req || !ts.isIdentifier(req)) return false;
  if (parametersRunCode(fn)) return false;
  if (!fn.body || !ts.isBlock(fn.body)) return false;
  const [first, second] = fn.body.statements;
  if (!first || !ts.isVariableStatement(first) || !second || !ts.isIfStatement(second)) return false;
  // A plain `const`: not `let` or `var`, nor `using` / `await using` (whose disposal is code of its own).
  if ((first.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return false;
  if (first.declarationList.declarations.length !== 1) return false;
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

/**
 * The calls a wallet-aware handler may make BEFORE it reads the wallet, by
 * handler. None, for every handler but one: the grants POST reads and checks
 * the grant's body first (its size, its JSON, a wall that could never be
 * installed, its chain, its feature list — the duplicate-permission check is
 * the one defect that must answer before anything else, see its comment), and
 * every one of those is pure: it reads the request it was sent and nothing
 * else, and writes nothing. Listed by name, so a call added in front of the
 * wallet's read — a store read, a write, anything — fails here until someone
 * has looked at it.
 */
const BEFORE_WALLET_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  "grants/route.ts POST": new Set([
    "readGrantBody", "NextResponse.json", "tooLarge", "JSON.parse", "isAddr", "duplicateWallPermissions",
    "isRobinhoodChainId", "JSON.stringify", "JSON.stringify(grant.chainId).slice", "Array.isArray", "grant.grantFeatures.some",
  ]),
};

/**
 * Why a wallet-aware handler does not read the wallet first, or null when it
 * does: `const w = readWalletParam(<its request>); if (w === null) return
 * walletUnknown(…);` as two statements of the handler's own body.
 *
 * THE CALL ITSELF, NOT ITS NAME IN THE TEXT. A mention in a comment or a
 * string, a call whose answer is dropped, one that is never compared with
 * null, one in a nested function, or one that comes after the handler has
 * already read or queued something is not a wallet refused before anything is
 * touched, and each used to pass a regex over the handler's text.
 *
 * FIRST, unless BEFORE_WALLET_READ names the handler: then the statements in
 * front may call only what it lists, may not `new` anything it does not, and
 * may assign only to the locals they declare themselves.
 */
function walletReadRefusal(fn: Handler, sf: ts.SourceFile, key: string): string | null {
  const req = fn.parameters[0]?.name;
  if (!req || !ts.isIdentifier(req)) return "it takes no request to read the wallet from";
  if (parametersRunCode(fn)) return "its parameters run code (a default, or a computed key) before the wallet is read";
  if (!fn.body || !ts.isBlock(fn.body)) return "it has no body to read the wallet in";
  const body = fn.body.statements;
  const at = body.findIndex((s, i) => {
    if (!ts.isVariableStatement(s) || !isConst(s) || s.declarationList.declarations.length !== 1) return false;
    const [d] = s.declarationList.declarations;
    const call = d!.initializer;
    if (!ts.isIdentifier(d!.name) || !call || !ts.isCallExpression(call)) return false;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "readWalletParam") return false;
    if (call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]!) || call.arguments[0].text !== req.text) return false;
    // …and answered at once: `if (w === null) return walletUnknown(…);`.
    const w = d!.name.text;
    const next = body[i + 1];
    if (!next || !ts.isIfStatement(next) || next.elseStatement) return false;
    const cond = next.expression;
    const isW = (e: ts.Expression) => ts.isIdentifier(e) && e.text === w;
    const isNull = (e: ts.Expression) => e.kind === ts.SyntaxKind.NullKeyword;
    if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      !(isW(cond.left) && isNull(cond.right) || isNull(cond.left) && isW(cond.right))) return false;
    const then = next.thenStatement;
    const ret = ts.isReturnStatement(then) ? then
      : ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0]!) ? then.statements[0] : null;
    const refusal = ret?.expression;
    return !!refusal && ts.isCallExpression(refusal) && ts.isIdentifier(refusal.expression) && refusal.expression.text === "walletUnknown";
  });
  if (at < 0) return "it must read the wallet as `const wallet = readWalletParam(req); if (wallet === null) return walletUnknown(…);`";
  if (at === 0) return null;
  const allowed = BEFORE_WALLET_READ[key];
  if (!allowed) return "the wallet's read must be its FIRST statement, before anything is read or written";
  const declared = new Set<string>();
  for (const s of body.slice(0, at)) {
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) boundNames(d.name).forEach((n) => declared.add(n));
  }
  let why: string | null = null;
  const visit = (n: ts.Node): void => {
    if (why) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = `${ts.isNewExpression(n) ? "new " : ""}${n.expression.getText(sf).replace(/\s+/g, "")}`;
      if (!allowed.has(callee)) why = `it calls ${callee} before it reads the wallet; only ${[...allowed].join(", ")} may come first`;
    }
    // A tag is a call by another syntax (`` store.remove`0x` ``), held to the same list.
    if (ts.isTaggedTemplateExpression(n)) {
      const tag = n.tag.getText(sf).replace(/\s+/g, "");
      if (!allowed.has(tag)) why = `it calls ${tag} (a tagged template) before it reads the wallet; only ${[...allowed].join(", ")} may come first`;
    }
    const local = (e: ts.Node) => ts.isIdentifier(e) && declared.has(e.text);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      !local(n.left)) {
      why = `it assigns ${n.left.getText(sf)} before it reads the wallet`;
    }
    // …and every other way to write, as assignedNames counts them: `++`/`--`, a for-in/of head, `delete`.
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && !local(n.operand)) {
      why = `it assigns ${n.operand.getText(sf)} before it reads the wallet`;
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer) && !local(n.initializer)) {
      why = `it assigns ${n.initializer.getText(sf)} before it reads the wallet`;
    }
    if (ts.isDeleteExpression(n)) why = `it deletes ${n.expression.getText(sf)} before it reads the wallet`;
    // Into callbacks too (`.some((f) => …)`): a call they make runs before the wallet's read as well.
    ts.forEachChild(n, visit);
  };
  for (const s of body.slice(0, at)) visit(s);
  return why;
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
  for (const { name, fn, why } of handlers) {
    assert.ok(fn, `${rel} ${name}: export it from this file with \`export\`, as a function or a const (or a local function or const by name), so its first statement can be checked${why ? `: ${why}` : ""}`);
    if (WALLET_AWARE.has(rel)) {
      assert.ok(importsFrom(sf, "readWalletParam", "wallet-param"), `${rel} must read the wallet through readWalletParam`);
      assert.ok(importsFrom(sf, "walletUnknown", "route-guard"), `${rel} must refuse an unreadable wallet with walletUnknown from @/lib/route-guard`);
      const refused = walletReadRefusal(fn, sf, `${rel} ${name}`);
      assert.equal(refused, null, `${rel} ${name} must read ?wallet= and refuse one it cannot read before anything is read or written: ${refused}`);
    } else {
      assert.ok(importsFrom(sf, "walletNotSupported", "route-guard"), `${rel} must import walletNotSupported from @/lib/route-guard`);
      assert.ok(startsWithRefusal(fn), `${rel} ${name} must START with \`const walletRefused = walletNotSupported(req); if (walletRefused) return walletRefused;\`, before anything is read or written`);
    }
  }
  // AND NOTHING THE WALK DID NOT SEE: every handler name the module really
  // exports (exportedNames, the checker's list) is one handlersOf resolved and
  // the loop above checked. A form it does not know fails here, by name.
  const walked = new Set(handlers.map((h) => h.name));
  for (const name of exportedNames(rel, src)) {
    if (!METHODS.has(name)) continue;
    assert.ok(walked.has(name), `${rel} exports ${name} in a form the sweep does not read, so its first statement was never checked; export it as a function or a const`);
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
  /** A handler whose first two statements are the refusal, under `head`. */
  const guarded = (head: string) => `${head} {\n  ${GUARD}  return new Response("reset");\n}`;

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
    const shapes: Record<string, [rel: string, src: string]> = {
      "a function declaration": ["probe/route.ts", route("")],
      "an export list": ["probe/route.ts", route(`${guarded("async function reset(req: Request)")}\nexport { reset as POST };`)],
      "an export list naming a const arrow": ["probe/route.ts", route(`const reset = async (req: Request) => ${guarded("")};\nexport { reset as POST };`)],
      "a const naming a const arrow": ["probe/route.ts", route(`const reset = async (req: Request) => ${guarded("")};\nexport const POST = reset;`)],
      "an exported const arrow": ["probe/route.ts", route(`export const POST = async (req: Request) => ${guarded("")};`)],
      "a route.js": ["probe/route.js", route(`${guarded("export async function POST(req)")}`, { js: true })],
      "a route.tsx": ["probe/route.tsx", route(`${guarded("export async function POST(req: Request)")}`)],
      // A destructured, typed context, as the dynamic routes on disk take it: a type is not code.
      "a destructured context": ["probe/route.ts", route(`${guarded("export async function POST(req: Request, { params }: { params: Promise<{ id: string }> })")}`)],
      // Nor is a type that shares a handler's name: the checker's backstop counts values only.
      "a type and an interface named like handlers": ["probe/route.ts", route(`export type POST = { body: string };\nexport interface PUT { body: string }\ntype D = number;\nexport type { D as DELETE };`)],
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
      // TYPESCRIPT'S ALIAS EXPORT. Both typecheck under isolatedModules, and
      // Next's SWC emits each as `export const POST = H.POST` / `= Other.POST`,
      // so Next serves the aliased POST — which no walk of this file can read.
      "an `export import` alias of a namespace's member": ["probe/route.ts", route(`namespace H {\n  export async function POST(req: Request) { return new Response("reset"); }\n}\nexport import POST = H.POST;`), / POST: export it.*`export import` alias/],
      "an `export import` alias of an import's member": ["probe/route.ts", route(`import * as Other from "../paper-reset/route";\nexport import POST = Other.POST;`), / POST: export it.*`export import` alias/],
      // A FORM THE WALK HAS NO BRANCH FOR is caught by the checker's list
      // (exportedNames), not passed: a class here, whatever comes next.
      "a form the walk does not know (an exported class)": ["probe/route.ts", route(`export class POST {\n  constructor(req: Request) { void req; }\n}`), /probe\/route\.ts exports POST in a form the sweep does not read/],
      "CommonJS, by name": ["probe/route.js", route(`exports.POST = async function (req) { return new Response("reset"); };`, { js: true }), / module\.exports: export it/],
      "CommonJS, the whole object": ["probe/route.js", route(`module.exports = { POST: async (req) => new Response("reset") };`, { js: true }), / module\.exports: export it/],
      "CommonJS, merged in": ["probe/route.js", route(`Object.assign(exports, { POST: async (req) => new Response("reset") });`, { js: true }), / module\.exports: export it/],
      "a route.tsx": ["probe/route.tsx", route(`export async function POST(req: Request) { return new Response("reset"); }`), / POST must START/],
      // CODE THAT RUNS BEFORE THE `if`, though the guard's own words come first.
      // Every declarator of a statement runs before the next statement: this
      // one queued a Spot reset for a request naming the Perps wallet, then refused it.
      "a second declarator in the guard's own statement": ["probe/route.ts", route(`export async function POST(req: Request) {\n  const walletRefused = walletNotSupported(req), queued = await queuePaperReset(false, "0xabc", "spot");\n  if (walletRefused) return walletRefused;\n  return new Response(String(queued));\n}`), / POST must START/],
      "the second declarator first": ["probe/route.ts", route(`export async function POST(req: Request) {\n  const queued = await queuePaperReset(false, "0xabc", "spot"), walletRefused = walletNotSupported(req);\n  if (walletRefused) return walletRefused;\n  return new Response(String(queued));\n}`), / POST must START/],
      "the guard as a let": ["probe/route.ts", route(`export async function POST(req: Request) {\n  let walletRefused = walletNotSupported(req);\n  if (walletRefused) return walletRefused;\n  return new Response("reset");\n}`), / POST must START/],
      "a default parameter": ["probe/route.ts", route(guarded(`export async function POST(req: Request, ctx = queuePaperReset(false, "0xabc", "spot"))`)), / POST must START/],
      // Next calls a handler with two arguments (the request, its context), so
      // a third parameter is always undefined and its default runs on EVERY
      // request — `?wallet=perps` included, before the refusal answers it.
      "a third parameter's default, which every request runs": ["probe/route.ts", route(guarded(`export async function POST(req: Request, _ctx: unknown, done = resetSpotBook(req))`)), / POST must START/],
      "a default inside a destructured context (Next's params has no id, so it runs)": ["probe/route.ts", route(guarded(`export async function POST(req: Request, { params: { id = queuePaperReset(false, "0xabc", "spot") } }: { params: any })`)), / POST must START/],
      "a computed key in a destructured context (it always runs)": ["probe/route.ts", route(guarded(`export async function POST(req: Request, { [queuePaperReset(false, "0xabc", "spot") as never]: x }: any)`)), / POST must START/],
      // A LIVE BINDING: the walk would read the guarded first value, and Next would serve the second.
      "an exported let, reassigned": ["probe/route.ts", route(`export let POST = async (req: Request) => ${guarded("")};\nPOST = async (req: Request) => new Response("reset");`), / POST: export it.*`let` or `var`/],
      "an exported var, reassigned": ["probe/route.js", route(`export var POST = async function (req) ${guarded("")};\nPOST = async (req) => new Response("reset");`, { js: true }), / POST: export it.*`let` or `var`/],
      "an exported let, reassigned inside a function that runs": ["probe/route.ts", route(`export let POST = async (req: Request) => ${guarded("")};\n(() => { POST = async (req: Request) => new Response("reset"); })();`), / POST: export it.*`let` or `var`/],
      "an exported let, never reassigned": ["probe/route.ts", route(`export let POST = async (req: Request) => ${guarded("")};`), / POST: export it.*`let` or `var`/],
      "an exported function, reassigned (a route.js, which nothing typechecks)": ["probe/route.js", route(`${guarded("export async function POST(req)")}\nPOST = async (req) => new Response("reset");`, { js: true }), / POST: export it.*reassigned in this file \(POST = …\)/],
      "an exported function, reassigned by destructuring": ["probe/route.js", route(`${guarded("export async function POST(req)")}\n[POST] = [async (req) => new Response("reset")];`, { js: true }), / POST: export it.*reassigned/],
      "an exported function, reassigned through an object pattern": ["probe/route.js", route(`${guarded("export async function POST(req)")}\n({ POST } = { POST: async (req) => new Response("reset") });`, { js: true }), / POST: export it.*reassigned/],
      "a local function an export list names, reassigned": ["probe/route.js", route(`${guarded("async function reset(req)")}\nexport { reset as POST };\nreset = async (req) => new Response("reset");`, { js: true }), / POST: export it.*reassigned in this file \(reset = …\)/],
      "a local function an exported const names, reassigned": ["probe/route.js", route(`${guarded("async function reset(req)")}\nexport const POST = reset;\nreset = async (req) => new Response("reset");`, { js: true }), / POST: export it.*reassigned in this file \(reset = …\)/],
      // Order does not matter: the export reads the binding when Next imports
      // the module, after every top-level statement has run.
      "a local function reassigned BEFORE the exported const that names it": ["probe/route.js", route(`${guarded("async function reset(req)")}\nreset = async (req) => new Response("reset");\nexport const POST = reset;`, { js: true }), / POST: export it.*reassigned in this file \(reset = …\)/],
      "a local function reassigned before the export list that names it": ["probe/route.js", route(`${guarded("async function reset(req)")}\nreset = async (req) => new Response("reset");\nexport { reset as POST };`, { js: true }), / POST: export it.*reassigned in this file \(reset = …\)/],
      "an exported function, reassigned by a compound assignment": ["probe/route.js", route(`${guarded("export async function POST(req)")}\nPOST &&= async (req) => new Response("reset");`, { js: true }), / POST: export it.*reassigned in this file \(POST = …\)/],
      "an exported function, reassigned as a for-of head": ["probe/route.js", route(`${guarded("export async function POST(req)")}\nfor (POST of [async (req) => new Response("reset")]);`, { js: true }), / POST: export it.*reassigned in this file \(POST = …\)/],
      "an exported function in a route.jsx, reassigned": ["probe/route.jsx", route(`${guarded("export async function POST(req)")}\nPOST = async (req) => new Response("reset");`, { js: true }), / POST: export it.*reassigned in this file \(POST = …\)/],
    };
    for (const [shape, [rel, src, blames]] of Object.entries(shapes)) {
      assert.throws(() => checkRoute(rel, src), (err: unknown) => {
        assert.ok(err instanceof assert.AssertionError, `${shape}: ${String(err)}`);
        assert.match(err.message, blames, shape);
        return true;
      }, shape);
    }
  });

  /**
   * THE BACKSTOP ON ITS OWN, so the shapes above are not the only thing that
   * says it works: the checker lists what the file exports as a value, aliases
   * included, and leaves out what Next could never serve.
   */
  it("the checker's list names every value the module exports — an `export import` alias included — and no type", () => {
    const names = (rel: string, src: string) => exportedNames(rel, src).sort();
    assert.deepEqual(names("probe/route.ts", route(`namespace H {\n  export async function POST(req: Request) { return new Response("reset"); }\n}\nexport import POST = H.POST;`)), ["GET", "POST"]);
    assert.deepEqual(names("probe/route.ts", route(`import * as Other from "./elsewhere";\nexport import POST = Other.POST;`)), ["GET", "POST"]);
    assert.deepEqual(names("probe/route.ts", route(`export class PUT {}\nexport const dynamic = "force-dynamic";`)), ["GET", "PUT", "dynamic"]);
    assert.deepEqual(names("probe/route.ts", route(`export type POST = { body: string };\nexport interface PUT { body: string }\ntype D = number;\nexport type { D as DELETE };`)), ["GET"]);
    assert.deepEqual(names("probe/route.js", route(`export async function POST(req) { return new Response("reset"); }`, { js: true })), ["GET", "POST"]);
  });

  /**
   * A WALLET-AWARE ROUTE IS HELD TO THE CALL, NOT TO ITS NAME. The sweep used
   * to pass such a handler when `readWalletParam(req)` appeared anywhere in its
   * text: in a comment, in a string, with its answer dropped, or after the
   * handler had already queued a Spot reset — `POST /api/paper-reset?wallet=perps`
   * resetting the Spot book with this file green.
   */
  describe("a wallet-aware handler reads the wallet, and refuses one it cannot read, before anything else", () => {
    const AWARE = "paper-reset/route.ts";
    const READ = `  const wallet = readWalletParam(req);\n  if (wallet === null) return walletUnknown("Nothing was queued.");\n`;
    const QUEUE = `  await queuePaperReset(true, "0x", "spot", {});\n`;
    /** A wallet-aware route file whose POST runs `body`, and then `rest`. */
    const aware = (body: string, rest = "") => [
      `import { readWalletParam } from "@/lib/wallet-param";`,
      `import { walletUnknown } from "@/lib/route-guard";`,
      `import { queuePaperReset } from "@/lib/start-over";`,
      `export async function POST(req: Request) {\n${body}  return new Response("queued");\n}`,
      rest,
    ].join("\n");
    const blamed = (rel: string, src: string, blames: RegExp, shape: string) =>
      assert.throws(() => checkRoute(rel, src), (err: unknown) => {
        assert.ok(err instanceof assert.AssertionError, `${shape}: ${String(err)}`);
        assert.match(err.message, blames, shape);
        return true;
      }, shape);

    it("the read and its refusal as the handler's first two statements pass, however the refusal is spelled", () => {
      for (const src of [
        aware(`${READ}${QUEUE}`),
        aware(`  const w = readWalletParam(req);\n  if (null === w) { return walletUnknown("Nothing was queued."); }\n${QUEUE}`),
        aware(READ, `export const GET = async (request: Request) => {\n  const wallet = readWalletParam(request);\n  if (wallet === null) return walletUnknown("Nothing was read.");\n  return new Response(wallet);\n};`),
      ]) assert.doesNotThrow(() => checkRoute(AWARE, src));
    });

    it("anything else fails, naming the handler", () => {
      const NOT_READ = / POST must read \?wallet=.*const wallet = readWalletParam\(req\); if \(wallet === null\) return walletUnknown/;
      const shapes: Record<string, [src: string, blames: RegExp]> = {
        "named only in a comment": [aware(`  // const wallet = readWalletParam(req); if (wallet === null) return walletUnknown("x");\n${QUEUE}`), NOT_READ],
        "named only in a string": [aware(`  const note = "const wallet = readWalletParam(req);";\n${QUEUE}`), NOT_READ],
        "called, its answer dropped": [aware(`  readWalletParam(req);\n${QUEUE}`), NOT_READ],
        "read, never compared with null": [aware(`  const wallet = readWalletParam(req);\n  await queuePaperReset(true, "0x", wallet ?? "spot", {});\n`), NOT_READ],
        "compared, not refused": [aware(`  const wallet = readWalletParam(req);\n  if (wallet === null) console.log("odd");\n${QUEUE}`), NOT_READ],
        "refused with something else": [aware(`  const wallet = readWalletParam(req);\n  if (wallet === null) return new Response("?");\n${QUEUE}`), NOT_READ],
        "a request it was not sent": [aware(`  const wallet = readWalletParam(new Request("https://x.test/?wallet=spot"));\n  if (wallet === null) return walletUnknown("x");\n${QUEUE}`), NOT_READ],
        "read in a nested function": [aware(`  const read = () => { const wallet = readWalletParam(req); if (wallet === null) return walletUnknown("x"); };\n${QUEUE}`), NOT_READ],
        "read after the Spot book was queued": [aware(`${QUEUE}${READ}`), / POST must read \?wallet=.*FIRST statement/],
        "read after a pure call: the grants POST's allowance is the grants POST's alone": [aware(`  const n = JSON.parse("1");\n${READ}`), / POST must read \?wallet=.*FIRST statement/],
        "a second handler that never reads it": [aware(READ, `export async function PATCH(req: Request) {\n${QUEUE}  return new Response("queued");\n}`), / PATCH must read \?wallet=/],
        "a parameter default that queues before the read": [
          aware(READ).replace("export async function POST(req: Request)", `export async function POST(req: Request, ctx = queuePaperReset(true, "0x", "spot", {}))`),
          / POST must read \?wallet=.*its parameters run code/,
        ],
        "a second declarator beside the read": [aware(`  const wallet = readWalletParam(req), queued = await queuePaperReset(true, "0x", "spot", {});\n  if (wallet === null) return walletUnknown("x");\n`), NOT_READ],
        "an exported let, whatever it starts as": [aware(READ, `export let PATCH = async (req: Request) => {\n${READ}  return new Response("queued");\n};`), / PATCH: export it.*`let` or `var`/],
        "a refusal of its own, not route-guard's": [
          aware(READ).replace(`import { walletUnknown } from "@/lib/route-guard";`, `const walletUnknown = (s: string) => new Response(s, { status: 400 });`),
          /must refuse an unreadable wallet with walletUnknown from @\/lib\/route-guard/,
        ],
      };
      for (const [shape, [src, blames]] of Object.entries(shapes)) blamed(AWARE, src, blames, shape);
    });

    it("THE GRANTS POST MAY CHECK ITS OWN BODY FIRST, AND NOTHING ELSE: a call or a write added in front of the read fails", () => {
      const rel = "grants/route.ts";
      const real = readFileSync(path.join(API, rel), "utf8");
      assert.doesNotThrow(() => checkRoute(rel, real), "the route as it is");
      const head = "export async function POST(req: Request) {\n";
      assert.ok(real.includes(head));
      for (const [added, blames] of [
        [`  await getGrantStore("spot").remove("0x");\n`, /it calls getGrantStore\("spot"\)\.remove before it reads the wallet/],
        [`  revoked.count = 1;\n`, /it assigns revoked\.count before it reads the wallet/],
        [`  const store = new Map();\n`, /it calls new Map before it reads the wallet/],
        [`  revoked.count++;\n`, /it assigns revoked\.count before it reads the wallet/],
        [`  --revoked.count;\n`, /it assigns revoked\.count before it reads the wallet/],
        [`  delete revoked.count;\n`, /it deletes revoked\.count before it reads the wallet/],
        ["  void store.remove`0xabc`;\n", /it calls store\.remove \(a tagged template\) before it reads the wallet/],
        [`  for (revoked.count of [1]);\n`, /it assigns revoked\.count before it reads the wallet/],
      ] as const) {
        blamed(rel, real.replace(head, `${head}${added}`), blames, added.trim());
      }
    });
  });
});

// ── and it holds at run time, before anything is touched ────────────────────

describe("a refused request reads and changes nothing", () => {
  const ENV = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL", "MERRYMEN_PERPS"] as const;
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const SPOT_GRANT = JSON.stringify({ smartAccount: `0x${"22".repeat(20)}`, demoOwnerPrivateKey: `0x${"01".repeat(32)}` });
  let home = "";
  before(() => {
    home = mkdtempSync(path.join(tmpdir(), "mm-route-guard-"));
    process.env.MERRYMEN_HOME = home;
    for (const k of ["MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL", "MERRYMEN_PERPS"] as const) delete process.env[k];
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
    // Wallet-aware since 5c: an unreadable wallet is refused 400, and a Perps
    // reset where no Perps worker runs (MERRYMEN_PERPS unset here) 403. Neither
    // is ever served as the Spot wallet's reset.
    for (const [q, status] of [["?wallet=perps", 403], ["?wallet=nope", 400], ["?wallet=spot&wallet=perps", 400]] as const) {
      const res = await POST(new Request(`${ORIGIN}/api/paper-reset${q}`, { method: "POST" }));
      assert.equal(res.status, status, q);
      assert.equal(existsSync(path.join(home, "commands")), false, `${q}: nothing queued for Spot`);
      assert.equal(existsSync(path.join(home, "accounts")), false, `${q}: nor for Perps`);
    }
    // And Spot, named or not, is the reset it always was.
    const spot = await POST(new Request(`${ORIGIN}/api/paper-reset?wallet=spot`, { method: "POST" }));
    assert.equal(spot.status, 200);
    assert.equal(readdirSync(path.join(home, "commands")).filter((n) => n.endsWith(".json")).length, 1);
  });

  /**
   * ONE REFUSAL, ONE SHAPE, on every wallet-aware route. A client reads the
   * code: `wallet-unknown` for a `?wallet=` no route can read, and
   * `perps-wallet-not-offered` where Perps are not on (MERRYMEN_PERPS is unset
   * here). The grants route kept copies of its own and answered the first
   * with no code at all and the second without `private, no-store`, so a
   * client handled three routes right and the one the desk asks first wrong.
   */
  it("every wallet-aware route answers an unreadable wallet, and Perps not offered, with the same code and headers", async () => {
    const routes = {
      grants: await import("../app/api/grants/route"),
      settings: await import("../app/api/settings/route"),
      orders: await import("../app/api/orders/route"),
      "paper-reset": await import("../app/api/paper-reset/route"),
    } as unknown as Record<string, Record<string, (req: Request) => Promise<Response>>>;
    const call = (route: string, method: string, query: string, body?: unknown) =>
      routes[route]![method]!(new Request(`${ORIGIN}/api/${route}${query}`, {
        method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }));
    /** A grant body that passes every check the grants POST makes before it reads the wallet. */
    const grant = { smartAccount: `0x${"a1".repeat(20)}`, serialized: "0xserialized", chainId: 4663, grantFeatures: ["tradeable-v2"] };
    const shape = async (res: Response) => ({
      status: res.status,
      code: ((await res.json()) as { code?: string }).code,
      cache: res.headers.get("cache-control"),
    });
    const handlers = [["grants", "GET"], ["grants", "POST"], ["grants", "DELETE"], ["settings", "GET"], ["settings", "PUT"], ["orders", "GET"], ["orders", "POST"], ["paper-reset", "POST"], ["paper-reset", "GET"]] as const;
    for (const query of ["?wallet=Perps", "?wallet=", "?wallet=spot&wallet=perps"]) {
      for (const [route, method] of handlers) {
        const body = method === "GET" ? undefined : route === "grants" && method === "POST" ? grant : {};
        assert.deepEqual(await shape(await call(route, method, query, body)), { status: 400, code: "wallet-unknown", cache: "private, no-store" }, `${method} /api/${route}${query}`);
      }
    }
    for (const [route, method, body] of [
      ["grants", "POST", { ...grant, purpose: "perps" }],
      ["grants", "DELETE", { purpose: "permission-replacement" }],
      ["orders", "POST", {}],
      ["paper-reset", "POST", undefined],
    ] as const) {
      assert.deepEqual(await shape(await call(route, method, "?wallet=perps", body)), { status: 403, code: "perps-wallet-not-offered", cache: "private, no-store" }, `${method} /api/${route}?wallet=perps`);
    }
    assert.equal(existsSync(path.join(home, "accounts")), false, "nothing was made for the Perps wallet");
  });

  it("a public read answers Spot's question only", async () => {
    const { GET } = await import("../app/api/version/route");
    assert.equal((await GET(new Request(`${ORIGIN}/api/version?wallet=perps`))).status, 400);
    assert.equal((await GET(new Request(`${ORIGIN}/api/version?wallet=spot`))).status, 200);
    assert.equal((await GET(new Request(`${ORIGIN}/api/version`))).status, 200);
  });
});
