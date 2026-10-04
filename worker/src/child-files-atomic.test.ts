/**
 * EVERY OTHER FILE A CHILD READS IS REPLACED WHOLE TOO — grant.json,
 * telegram.json and bootstrap.json. (settings.json is settings-atomic.test.ts.)
 *
 * What a half-written file cost, per file:
 *
 *   grant.json      loadGrantFile returns null for a file that does not parse,
 *                   and syncGrant cannot tell that from a deleted grant: an
 *                   armed agent logged "KILL SWITCH", was marked killed, and
 *                   re-armed a tick later. Written under a running child by
 *                   refreshGrantForChild on every re-sign, and self-hosted by
 *                   POST /api/grants.
 *   telegram.json   the only record of who the owner is. loadTelegramState
 *                   reads a broken file as a fresh default, so a child that died
 *                   mid-save came back unlinked and saved the default over it —
 *                   and the orchestrator restores a link only when the file is
 *                   missing, so it never repaired one that was merely broken.
 *   bootstrap.json  written before spawn and read once, so never raced — but a
 *                   FAILED write must not leave the previous spawn's anchor.
 *
 * Pinned at the source, and executed: a reader thread running the child's REAL
 * loaders (loadGrantFile, loadTelegramState) while the writers write, with the
 * old plain writeFileSync as the control that proves the race can see a tear.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { writeFileAtomicSync } from "./atomic-write";
import { BOOTSTRAP_FILE, readAnchor } from "./bootstrap-state";
import { homePaths } from "./home";
import { childHome, writeBootstrapForChild } from "./orchestrator";
import { loadTelegramState, saveTelegramState, type TelegramState } from "./telegram/state";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const source = (rel: string) => codeOf(readFileSync(new URL(rel, import.meta.url), "utf8"));

const ORCH = source("./orchestrator.ts");
const TG_STATE = source("./telegram/state.ts");
const GRANTS_ROUTE = source("../../web/src/app/api/grants/route.ts");

function body(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone — re-point this test at the writer that replaced it`);
  return src.slice(at, src.indexOf("\n}\n", at));
}

const IN_PLACE_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile)\s*\(/;
/** Descriptor reads cannot truncate child files. No guessed or indirect flags qualify. */
function assertReadOnlyDescriptorOpens(raw: string): void {
  const filename = "/atomic-child-source.ts";
  const tree = ts.createSourceFile(filename, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Resolve local bindings in memory: a same-named parameter/object must not
  // masquerade as the actual node:fs imports. No dependencies are loaded.
  const program = ts.createProgram([filename], { noLib: true, noResolve: true, types: [] }, {
    getSourceFile: file => file === filename ? tree : undefined,
    getDefaultLibFileName: () => "", writeFile() {}, getCurrentDirectory: () => "/",
    getDirectories: () => [], fileExists: file => file === filename,
    readFile: file => file === filename ? raw : undefined,
    getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  });
  assert.equal(program.getSyntacticDiagnostics(tree).length, 0, "descriptor source must parse without ambiguity");
  const checker = program.getTypeChecker();
  let openBinding: ts.Symbol | undefined, constantsBinding: ts.Symbol | undefined;
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !["node:fs", "fs"].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    assert.ok(!statement.importClause?.name && bindings && ts.isNamedImports(bindings), "filesystem descriptors must use explicit named imports");
    for (const item of bindings.elements) {
      const imported = item.propertyName?.text ?? item.name.text;
      if (imported !== "openSync" && imported !== "constants") continue;
      assert.ok(!statement.importClause!.isTypeOnly && !item.isTypeOnly, "descriptor imports must be runtime value bindings");
      assert.equal(item.name.text, imported, "descriptor imports must not be aliased");
      const symbol = checker.getSymbolAtLocation(item.name);
      assert.ok(symbol && symbol.declarations?.length === 1, "descriptor imports must have one unambiguous binding");
      if (imported === "openSync") { assert.equal(openBinding, undefined); openBinding = symbol; }
      else { assert.equal(constantsBinding, undefined); constantsBinding = symbol; }
    }
  }
  const imported = (node: ts.Identifier, symbol: ts.Symbol | undefined) => symbol !== undefined && checker.getSymbolAtLocation(node) === symbol;
  const allowed = new Set(["O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK", "O_DIRECTORY"]);
  function flags(node: ts.Expression): string[] {
    if (ts.isParenthesizedExpression(node)) return flags(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarToken) return [...flags(node.left), ...flags(node.right)];
    assert.ok(ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "constants" && imported(node.expression, constantsBinding)
      && allowed.has(node.name.text), "openSync flags must contain only explicit nonwriting node:fs constants");
    return [node.name.text];
  }
  function importTarget(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) return imported(node, openBinding) || imported(node, constantsBinding);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node))
      return importTarget(node.expression);
    return ts.forEachChild(node, child => importTarget(child) || undefined) === true;
  }
  function visit(node: ts.Node): void {
    // The former blanket regex also caught openSync inside literal eval/VM
    // scripts. Such embedded calls cannot receive the AST readonly exception.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      assert.doesNotMatch(node.text, /\bopenSync\b/, "embedded descriptor code must not bypass source inspection");
    if (ts.isIdentifier(node) && node.text === "openSync") {
      assert.ok(imported(node, openBinding), "openSync must resolve to its real node:fs import");
      assert.ok((ts.isImportSpecifier(node.parent) && node.parent.name === node)
        || (ts.isCallExpression(node.parent) && node.parent.expression === node), "openSync references must not be disguised or aliased");
    }
    if (ts.isIdentifier(node) && imported(node, constantsBinding)) {
      assert.ok((ts.isImportSpecifier(node.parent) && node.parent.name === node)
        || (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node), "filesystem constants must not be aliased or passed to a mutator");
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "openSync")
      assert.fail("computed openSync calls cannot qualify as explicit descriptor reads");
    if (ts.isStringLiteral(node) && ["node:fs", "fs"].includes(node.text)
        && !(ts.isImportDeclaration(node.parent) && node.parent.moduleSpecifier === node)) {
      // Existing diagnostics dynamically destructure these three read helpers.
      // No module object, descriptor, alias, rest/default binding or writer can
      // hide inside that bounded exception.
      const call = node.parent, awaited = call.parent, declaration = awaited.parent;
      assert.ok(ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword && call.arguments.length === 1
        && ts.isAwaitExpression(awaited) && ts.isVariableDeclaration(declaration) && declaration.initializer === awaited
        && ts.isObjectBindingPattern(declaration.name) && declaration.name.elements.length > 0
        && declaration.name.elements.every(element => !element.dotDotDotToken && !element.propertyName && !element.initializer
          && ts.isIdentifier(element.name) && ["readFileSync", "existsSync", "readdirSync"].includes(element.name.text)),
      "indirect filesystem loading cannot bypass descriptor inspection");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && importTarget(node.left)) assert.fail("descriptor imports must not be rebound or mutated");
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && importTarget(node.operand))
      assert.fail("descriptor imports must not be mutated");
    if (ts.isDeleteExpression(node) && importTarget(node.expression)) assert.fail("descriptor imports must not be mutated");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imported(node.expression, openBinding)) {
      assert.equal(node.arguments.length, 2, "descriptor reads require exactly two explicit arguments");
      assert.ok(!node.arguments.some(ts.isSpreadElement), "descriptor arguments must not be spread");
      assert.ok(flags(node.arguments[1]!).includes("O_RDONLY"), "descriptor reads must explicitly require O_RDONLY");
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
const posix = process.platform !== "win32";
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "merrymen-child-files-"));
const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".tmp"));

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("the orchestrator writes nothing in a child's home in place", () => {
  it("orchestrator.ts holds no truncating writer at all", () => {
    // Every file it writes is one a child reads. A new one gets the helper too.
    assert.doesNotMatch(ORCH, IN_PLACE_WRITE);
    assert.doesNotMatch(ORCH, /\bwriteFileSync\b/, "not even imported");
    assertReadOnlyDescriptorOpens(readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8"));
  });

  it("only explicit readonly flags from the real imports pass the descriptor exception", () => {
    const header = 'import { openSync, constants } from "node:fs";\n';
    for (const expression of [
      "constants.O_RDONLY", "constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK",
      "(constants.O_DIRECTORY | (constants.O_RDONLY | constants.O_NOFOLLOW))",
    ]) assert.doesNotThrow(() => assertReadOnlyDescriptorOpens(`${header}openSync(file, ${expression});`));
  });

  it("write-capable, unknown and indirect descriptor opens remain rejected", () => {
    const header = 'import { openSync, constants } from "node:fs";\n';
    for (const expression of [
      "constants.O_WRONLY", "constants.O_RDWR", "constants.O_RDONLY | constants.O_CREAT",
      "constants.O_RDONLY | constants.O_TRUNC", "constants.O_RDONLY | constants.O_APPEND",
      "constants.O_NOFOLLOW | constants.O_NONBLOCK", "constants.O_RDONLY | constants.UNKNOWN",
      "'r'", "'w'", "0", "flags", "constants.O_RDONLY | flags", "constants.O_RDONLY || constants.O_NOFOLLOW",
      "constants['O_RDONLY']", "fake.O_RDONLY", "constants.O_RDONLY & constants.O_NOFOLLOW", "readFlags()",
    ]) assert.throws(() => assertReadOnlyDescriptorOpens(`${header}openSync(file, ${expression});`), expression);
    for (const source of [
      `${header}openSync(...args);`, `${header}openSync(file);`, `${header}openSync(file, constants.O_RDONLY, mode);`,
      `${header}const alias=openSync; alias(file, 'w');`, 'import {openSync as alias,constants} from "node:fs"; alias(file,constants.O_RDONLY);',
      `${header}openSync.call(null,file,constants.O_RDONLY);`, `${header}function f(openSync){ openSync(file,constants.O_RDONLY); }`,
      `${header}function f(constants){ openSync(file,constants.O_RDONLY); }`,
      `${header}constants.O_RDONLY=constants.O_WRONLY; openSync(file,constants.O_RDONLY);`,
      `${header}constants=fake; openSync(file,constants.O_RDONLY);`, `${header}Object.assign(constants,fake); openSync(file,constants.O_RDONLY);`,
      `${header}delete constants.O_RDONLY; openSync(file,constants.O_RDONLY);`,
      `${header}({x:constants.O_RDONLY}=fake); openSync(file,constants.O_RDONLY);`,
      'import type {openSync,constants} from "node:fs"; openSync(file,constants.O_RDONLY);',
      'const constants={O_RDONLY:2}; function openSync(){}; openSync(file,constants.O_RDONLY);',
      'import * as fs from "node:fs"; fs.openSync(file,0);', 'const fs=require("node:fs"); fs["openSync"](file,0);',
      'const {openSync:alias}=await import("node:fs"); alias(file,0);',
      'const fs=await import("node:fs"); fs[method](file,0);',
      `${header}eval("openSync(file,constants.O_RDWR | constants.O_TRUNC)");`,
      `${header}new Function(\`openSync(file,constants.O_WRONLY)\`)();`,
      `${header}eval("openSync/* comment */(file,constants.O_RDWR | constants.O_TRUNC)");`,
      `${header}new Function(\`openSync/* comment */(file,constants.O_WRONLY)\`)();`,
    ]) assert.throws(() => assertReadOnlyDescriptorOpens(source), source);
  });

  it("the blanket file-write bans still reject every direct truncating writer", () => {
    for (const name of ["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream", "copyFileSync", "copyFile"])
      assert.match(`${name}(file, data);`, IN_PLACE_WRITE);
  });

  it("grant.json, at spawn and on a re-sign under a running child", () => {
    assert.match(
      body(ORCH, "async function writeGrantForChild("),
      /writeFileAtomicSync\(path\.join\(home, "grant\.json"\), JSON\.stringify\(grant, null, 2\), 0o600\);/,
    );
    const refresh = body(ORCH, "async function refreshGrantForChild(");
    assert.match(refresh, /writeFileAtomicSync\(file, next, 0o600\);/);
    assert.ok(
      refresh.indexOf('if (readFileSync(file, "utf8") === next) return;') < refresh.indexOf("writeFileAtomicSync("),
      "unchanged is still not rewritten — the fsync is paid on a re-sign only",
    );
  });

  it("telegram.json, restored only when missing, and whole", () => {
    const fn = body(ORCH, "async function writeTelegramForChild(");
    assert.match(fn, /if \(existsSync\(file\)\) return;/, "a running child is the authority on its own link");
    assert.match(fn, /writeFileAtomicSync\(\s*file,[\s\S]*?0o600,\s*\);/);
  });

  it("bootstrap.json, and a failed write removes the previous spawn's anchor", () => {
    const fn = body(ORCH, "export async function writeBootstrapForChild(");
    assert.match(fn, /writeFileAtomicSync\(file, JSON\.stringify\(state, null, 2\), 0o600\);/);
    const handler = fn.slice(fn.indexOf("} catch (e) {", fn.indexOf("writeFileAtomicSync(")));
    assert.match(handler, /rmSync\(file, \{ force: true \}\);/);
  });
});

describe("the other writers of those files", () => {
  it("the child's saveTelegramState replaces telegram.json whole", () => {
    assert.match(body(TG_STATE, "export function saveTelegramState("), /writeFileAtomicSync\(homePaths\.telegram\(\), JSON\.stringify\(state, null, 2\), 0o600\);/);
    assert.doesNotMatch(TG_STATE, /\bwriteFileSync\b/);
  });

  it("self-hosted, POST /api/grants replaces grant.json whole", () => {
    const post = body(GRANTS_ROUTE, "export async function POST(");
    assert.match(post, /await writeFileAtomic\(GRANT_FILE, JSON\.stringify\(grant, null, 2\), 0o600\);/);
    assert.doesNotMatch(GRANTS_ROUTE, /\b(?:writeFile|chmod)\(GRANT_FILE\b/);
  });
});

describe("saveTelegramState", () => {
  const saved = { MERRYMEN_HOME: process.env.MERRYMEN_HOME };
  let home = "";
  before(() => {
    home = tmpDir();
    process.env.MERRYMEN_HOME = home;
  });
  after(() => {
    restoreEnv(saved);
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips, 0600 over a looser file, no temp file left", () => {
    writeFileSync(homePaths.telegram(), "{}");
    if (posix) chmodSync(homePaths.telegram(), 0o644);
    saveTelegramState({ ...loadTelegramState(), ownerId: 42, linkCode: "ABC234", offset: 7 });
    const back = loadTelegramState();
    assert.equal(back.ownerId, 42);
    assert.equal(back.linkCode, "ABC234");
    assert.equal(back.offset, 7);
    if (posix) assert.equal(statSync(homePaths.telegram()).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(home), []);
  });
});

describe("writeBootstrapForChild", () => {
  const saved = { MERRYMEN_HOME: process.env.MERRYMEN_HOME, DATABASE_URL: process.env.DATABASE_URL };
  const tenant = "0x00000000000000000000000000000000000000b1" as const;
  const account = "0x00000000000000000000000000000000000000c2" as const;
  let root = "";
  before(() => {
    root = tmpDir();
    process.env.MERRYMEN_HOME = root;
    // No shared database: the anchor is `unknown`, which is still a whole,
    // valid file — what matters here is how it lands.
    delete process.env.DATABASE_URL;
  });
  after(() => {
    restoreEnv(saved);
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a whole anchor the child reads as valid, 0600, no temp file", async () => {
    await writeBootstrapForChild(tenant, account);
    const home = childHome(tenant);
    const v = readAnchor(home, { tenantId: account });
    assert.equal(v.kind, "valid", JSON.stringify(v));
    if (posix) assert.equal(statSync(path.join(home, BOOTSTRAP_FILE)).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(home), []);
  });

  it(
    "a write that fails leaves NO anchor — not the previous spawn's",
    // Needs a directory it cannot write, which root can.
    { skip: !posix || process.getuid?.() === 0 },
    async () => {
      // Make the replace fail while the name stays removable: the anchor is a
      // link into a directory that refuses new files, so the temp file cannot
      // be created there. (In production: ENOSPC, EIO, a quota.)
      const home = childHome(tenant);
      const locked = path.join(root, "locked");
      mkdirSync(locked, { recursive: true });
      const previous = path.join(locked, BOOTSTRAP_FILE);
      writeFileSync(previous, readFileSync(path.join(home, BOOTSTRAP_FILE)));
      rmSync(path.join(home, BOOTSTRAP_FILE));
      symlinkSync(previous, path.join(home, BOOTSTRAP_FILE));
      assert.equal(readAnchor(home, { tenantId: account }).kind, "valid", "the previous anchor is readable before");
      chmodSync(locked, 0o500);
      try {
        await writeBootstrapForChild(tenant, account);
        assert.equal(readAnchor(home, { tenantId: account }).kind, "absent", "an absent anchor fails closed; a stale-but-fresh one does not");
        assert.deepEqual(leftovers(locked), []);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it("refuses the spawn if a failed replacement also cannot remove the previous anchor", { skip: !posix || process.getuid?.() === 0 }, async () => {
    const home = childHome(tenant);
    const file = path.join(home, BOOTSTRAP_FILE);
    await writeBootstrapForChild(tenant, account);
    const previous = readFileSync(file, "utf8");
    chmodSync(home, 0o500);
    try {
      await assert.rejects(writeBootstrapForChild(tenant, account), /unsafe bootstrap anchor remains/);
      assert.equal(readFileSync(file, "utf8"), previous, "the old file survives, so starting a child must be refused");
      assert.deepEqual(leftovers(home), []);
    } finally {
      chmodSync(home, 0o700);
    }
  });
});

// ── the races, against the child's real loaders ─────────────────────────────

/**
 * Loads a real loader through tsx on its own thread and calls it in a loop.
 * flags[0] = stop, flags[1] = reads that came back torn, flags[2] = reads.
 * Torn means what the child would act on: a null grant, or telegram state that
 * no longer knows its owner.
 */
const READER = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { tsImport } = await import("tsx/esm/api");
  const mod = await tsImport(workerData.mod, workerData.mod);
  const read = mod[workerData.fn];
  const flags = new Int32Array(workerData.ctl);
  const versions = new Set();
  let lastError = "";
  parentPort.postMessage("ready");
  while (Atomics.load(flags, 0) === 0) {
    const v = read();
    Atomics.add(flags, 2, 1);
    const version = workerData.kind === "grant" ? (v ? v.grantedAt : null) : (v.ownerId === 42 ? v.offset : null);
    if (typeof version === "number") versions.add(version);
    else {
      Atomics.add(flags, 1, 1);
      lastError = workerData.kind === "grant" ? "loadGrantFile returned null" : "loadTelegramState forgot the owner";
    }
  }
  parentPort.postMessage({ versions: versions.size, lastError });
})().catch((e) => parentPort.postMessage({ versions: 0, lastError: "reader failed: " + (e && e.message) }));
`;

interface RaceResult {
  writes: number;
  reads: number;
  torn: number;
  versions: number;
  lastError: string;
}

/** Sizes alternate so a half-written file can never pass for a whole one. */
const pad = (version: number) => "x".repeat(version % 2 === 0 ? 2 * 1024 * 1024 : 512 * 1024);

async function race(opts: {
  kind: "grant" | "telegram";
  mod: string;
  fn: string;
  env: Record<string, string>;
  write: (version: number) => void;
  iterations: number;
  stopOnTear?: boolean;
}): Promise<RaceResult> {
  opts.write(0);
  const ctl = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const flags = new Int32Array(ctl);
  const reader = new Worker(READER, {
    eval: true,
    env: { ...process.env, ...opts.env },
    workerData: { ctl, kind: opts.kind, fn: opts.fn, mod: new URL(opts.mod, import.meta.url).href },
  });
  try {
    const finished = new Promise<{ versions: number; lastError: string }>((resolve, reject) => {
      reader.on("message", (m) => m !== "ready" && resolve(m));
      reader.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      reader.once("message", () => resolve());
      reader.once("error", reject);
    });
    // Do not start writing until the reader is actually reading.
    const deadline = Date.now() + 10_000;
    while (Atomics.load(flags, 2) === 0 && Date.now() < deadline) {
      /* spin — the reader is another thread */
    }
    let writes = 0;
    for (let v = 1; v <= opts.iterations; v++) {
      opts.write(v);
      writes++;
      if (opts.stopOnTear && Atomics.load(flags, 1) > 0) break;
    }
    Atomics.store(flags, 0, 1);
    const { versions, lastError } = await finished;
    return { writes, reads: Atomics.load(flags, 2), torn: Atomics.load(flags, 1), versions, lastError };
  } finally {
    await reader.terminate();
  }
}

describe("a running child reading grant.json during a re-sign never sees a null grant", () => {
  const grant = (v: number) =>
    JSON.stringify({ smartAccount: "0x00000000000000000000000000000000000000c2", grantedAt: v, serialized: pad(v) }, null, 2);

  const run = async (write: (file: string, data: string) => void, iterations: number, stopOnTear = false) => {
    const dir = tmpDir();
    const file = path.join(dir, "grant.json");
    try {
      return await race({
        kind: "grant",
        mod: "./grant.ts",
        fn: "loadGrantFile",
        env: { MERRYMEN_GRANT_FILE: file, MERRYMEN_HOME: dir },
        write: (v) => write(file, grant(v)),
        iterations,
        stopOnTear,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("CONTROL: refreshGrantForChild's old writeFileSync hands the child a null grant — a kill", async () => {
    const r = await run((file, data) => writeFileSync(file, data, { encoding: "utf8", mode: 0o600 }), 5_000, true);
    assert.ok(r.torn > 0, `no torn read in ${r.writes} plain writes / ${r.reads} reads — the harness cannot see the bug`);
  });

  it("writeFileAtomicSync, as refreshGrantForChild and writeGrantForChild now write it: never", async () => {
    const r = await run((file, data) => writeFileAtomicSync(file, data, 0o600), 150);
    assert.equal(r.torn, 0, `${r.torn} of ${r.reads} reads failed — last: ${r.lastError}`);
    assert.ok(r.versions >= 3, `the reader saw ${r.versions} grant(s) in ${r.reads} reads — it never raced the writes`);
  });
});

describe("a reader of telegram.json never gets state that has forgotten the owner", () => {
  const saved = { MERRYMEN_HOME: process.env.MERRYMEN_HOME };
  let home = "";
  before(() => {
    home = tmpDir();
    process.env.MERRYMEN_HOME = home;
  });
  after(() => {
    restoreEnv(saved);
    rmSync(home, { recursive: true, force: true });
  });

  const state = (v: number): TelegramState => ({ ...loadTelegramState(), ownerId: 42, linkedAt: 1, offset: v, lastRemedyRule: pad(v) });

  it("CONTROL: the old saveTelegramState (writeFileSync) is caught tearing", async () => {
    const r = await race({
      kind: "telegram",
      mod: "./telegram/state.ts",
      fn: "loadTelegramState",
      env: { MERRYMEN_HOME: home },
      write: (v) => writeFileSync(homePaths.telegram(), JSON.stringify(state(v), null, 2), "utf8"),
      iterations: 5_000,
      stopOnTear: true,
    });
    assert.ok(r.torn > 0, `no torn read in ${r.writes} plain writes / ${r.reads} reads — the harness cannot see the bug`);
  });

  it("saveTelegramState itself: every read still knows the owner", async () => {
    const r = await race({
      kind: "telegram",
      mod: "./telegram/state.ts",
      fn: "loadTelegramState",
      env: { MERRYMEN_HOME: home },
      write: (v) => saveTelegramState(state(v)),
      iterations: 150,
    });
    assert.equal(r.torn, 0, `${r.torn} of ${r.reads} reads failed — last: ${r.lastError}`);
    assert.ok(r.versions >= 3, `the reader saw ${r.versions} version(s) in ${r.reads} reads — it never raced the writes`);
    assert.deepEqual(leftovers(home), []);
  });
});
