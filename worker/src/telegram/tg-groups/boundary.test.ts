/**
 * THE TELEGRAM GROUPS BOUNDARY — rule 1 of docs/tg-groups.md, pinned where one
 * reasonable-looking line would break it.
 *
 *   - Nothing under telegram/tg-groups/ reaches a trading module: not by a
 *     direct import (tests included), and not through anything its production
 *     code imports in turn. Trading is reached only through `TgCoinsPort`,
 *     which index.ts builds from tg-coin-look.ts. The production code imports
 *     only an allowlist, and from the shared modules on it only the named
 *     helpers it uses, so a new edge has to be argued for here, in a diff.
 *   - No group text is written where a trading decision could read it: no file
 *     here names the `posts` table, holds any SQL, or names a function that
 *     writes a post, an event, a decision, a trade, a chat turn, peers or
 *     research files, or places an order; only store.ts writes a file (its
 *     own), and only model.ts reaches the model client.
 *   - What crosses into trading is an address and where it came from, never
 *     the message: trencher-nominate.ts and tg-coin-look.ts import nothing
 *     from telegram/ but the plain types, never name a message-bearing field,
 *     and their exported entry points take only addresses, ids, timestamps,
 *     settings, chain reads and Brain output. Those signatures are read with
 *     the TypeScript parser and pinned exactly, because this directory may not
 *     import the trading side, not even its types. At run time the coin flow
 *     hands the port an address and four numbers and nothing else; that the
 *     book strips anything smuggled on a nomination is pinned beside the book
 *     (trencher-nominate.test.ts), where importing it is allowed.
 *
 * WHAT IS CHECKED IS CODE, NOT PROSE: comments are stripped first by a small
 * lexer (copied from the web room's boundary test, which telegram/ may not
 * import), because every module here explains in comments what it will not
 * touch, by name.
 *
 * NAMING: never write the web room's name (group + chat, joined or separated)
 * in code here. The room's directory is spelled in halves below for that reason.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CoinFlow } from "./coins";
import { extractCas } from "./detect";
import { TgGroupsStore } from "./store";
import type { CoinLook, NominateResult, TgCoinsPort, TrencherReadiness } from "./types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = path.join(HERE, "..", "..");
const REPO = path.join(WORKER_SRC, "..", "..");
const SELF = path.join(HERE, "boundary.test.ts");
/** The web room's directory, spelled in halves (see NAMING above). */
const ROOM_DIR = `worker/src/${["group", "chat"].join("")}/`;

const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

// ── a small TypeScript lexer ────────────────────────────────────────────────

const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)$/;

/** Source with every comment replaced by a space, plus every string, template and regex literal it contains. */
function lex(src: string): { code: string; strings: string[] } {
  let code = "";
  const strings: string[] = [];
  let i = 0;
  let prev = "";
  const n = src.length;
  while (i < n) {
    const ch = src[i] ?? "";
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      code += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      code += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const c = src[j] ?? "";
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (ch === "`" && c === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (ch === "`" && depth > 0 && c === "}") {
          depth--;
          j++;
          continue;
        }
        if (c === ch && depth === 0) break;
        if (ch !== "`" && c === "\n") break;
        j++;
      }
      const lit = src.slice(i, j + 1);
      strings.push(lit.slice(1, -1));
      code += lit;
      i = j + 1;
      prev = "a";
      continue;
    }
    if (ch === "/" && (prev === "" || REGEX_AFTER.has(prev) || REGEX_KEYWORDS.test(code.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const c = src[j] ?? "";
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j] ?? "")) j++;
      const lit = src.slice(i, j);
      strings.push(lit);
      code += lit;
      i = j;
      prev = "a";
      continue;
    }
    code += ch;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return { code, strings };
}

/** One import or re-export: its specifier, whether it can only bring types, and the names it brings. */
interface ImportEdge {
  spec: string;
  typeOnly: boolean;
  /** Imported names (before any `as`). Null for a namespace, default, side-effect or dynamic import: "everything". */
  names: string[] | null;
}

/** Every module a file names: static imports and re-exports, side-effect imports, dynamic import() and require(). */
function imports(code: string): ImportEdge[] {
  const out: ImportEdge[] = [];
  // NO WHITESPACE IN A SPECIFIER, as in the room's test: prose followed by a
  // quote on the next line must not read as an import.
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?([\w$*{}\s,]*?)\s*\bfrom\s*["'`]([^"'`\s]+)["'`]/g)) {
    const clause = (m[3] ?? "").trim();
    const spec = m[4] ?? "";
    const whole = m[2] !== undefined;
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (!braces) {
      out.push({ spec, typeOnly: whole, names: null });
      continue;
    }
    const items = (braces[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const typeOnly = whole || items.every((s) => /^type\s/.test(s));
    out.push({ spec, typeOnly, names: items.map((s) => s.replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? s) });
  }
  for (const re of [/\bimport\s*["'`]([^"'`\s]+)["'`]/g, /\bimport\s*\(\s*["'`]([^"'`\s]+)["'`]/g, /\brequire\s*\(\s*["'`]([^"'`\s]+)["'`]/g]) {
    for (const m of code.matchAll(re)) out.push({ spec: m[1] ?? "", typeOnly: false, names: null });
  }
  return out;
}

/** A relative specifier, resolved to a repo path without its extension. Package and node: specifiers are null. */
function resolved(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return rel(path.resolve(path.dirname(file), spec)).replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "");
}

/** A resolved repo path (no extension) to the file on disk, or null. */
function onDisk(target: string): string | null {
  for (const c of [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`]) {
    const full = path.join(REPO, c);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

/** The tables a piece of SQL writes, in any case; prose ("could not update the room") is not a statement. */
function sqlWrites(sql: string): string[] {
  const out = new Set<string>();
  for (const re of [
    /\b(?:INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /(?<!\bDO\s+)\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+SET\b/gi,
    /(?<!DO\s)\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)/g,
  ]) {
    for (const m of sql.matchAll(re)) out.add(m[1] ?? "");
  }
  return [...out];
}

/** Any SQL that names the `posts` table, reading or writing, in any case. */
const NAMES_POSTS = /\b(?:FROM|INTO|UPDATE|JOIN|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+["`]?posts\b/i;

const lexed = new Map<string, ReturnType<typeof lex>>();
function lexFile(f: string): ReturnType<typeof lex> {
  let l = lexed.get(f);
  if (!l) {
    l = lex(readFileSync(f, "utf8"));
    lexed.set(f, l);
  }
  return l;
}

// ── what counts as trading ──────────────────────────────────────────────────

/**
 * THE TRADING MACHINERY, by path under worker/src: the child's tick
 * (index.ts), the wall and its batteries, the executor, intents, proposals,
 * simulation, every Brain and trencher module, peers, the strategist and the
 * strategies, discovery and the venues (what verifies a pool and reads its
 * price for the tick), and tg-coin-look.ts — the trading side of the port,
 * which imports the trencher strategy itself. The orchestrator, the web room
 * and X are not trading, but the dependency runs the other way for all three,
 * and telegram/ may import none of them.
 */
const TRADING_EXACT = new Set(
  ["index", "policy", "executor", "simulate", "wall", "intents", "proposals", "strategy", "tg-coin-look", "discovery"].map((m) => `worker/src/${m}`),
);
const TRADING_PREFIX = [
  "worker/src/brain-",
  "worker/src/trencher-",
  "worker/src/wall-",
  "worker/src/executor-",
  "worker/src/peer-",
  "worker/src/strategist/",
  "worker/src/strategies/",
  "worker/src/venues/",
  "worker/src/orchestrator",
  "worker/src/xpost/",
  ROOM_DIR,
];
/** The ledger's writers: posts, events, decisions, trades and chat turns all live there. */
const LEDGER_WRITERS = new Set(["worker/src/store", "worker/src/ledger-mirror"]);

const isTrading = (target: string): boolean => TRADING_EXACT.has(target) || TRADING_PREFIX.some((p) => target.startsWith(p));

/**
 * Functions that write a trading input, remember group text where the owner's
 * DMs or the fleet read it, or place an order. Named, never called, never
 * passed around. (`addEvent` included: the event feed reaches the owner's DM
 * prompt and the fleet's tables; the handler's `note` carries counts only.)
 */
const FORBIDDEN_NAMES = [
  "addPost",
  "addEvent",
  "addDecision",
  "addTrade",
  "appendChatTurn",
  "appendJournal",
  "submitChatTrade",
  "writePeersForChild",
  "writeResearchForChild",
  "writeSettingsForChild",
];

// ── the files ───────────────────────────────────────────────────────────────

const TG_FILES = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(HERE, f));
const TG_SOURCES = TG_FILES.filter((f) => !f.endsWith(".test.ts"));
/** Everything but this file, which has to spell the forbidden names to look for them. */
const TG_FILES_BUT_SELF = TG_FILES.filter((f) => f !== SELF);

describe("the checks themselves", () => {
  it("the lexer strips comments and keeps strings, regexes and import specifiers", () => {
    const src = 'const a = /x[/\\\\]y/g; // addPost\nconst b = "https://t.me/x"; /* addEvent */ const c = `q ${1} posts`;\n';
    const { code, strings } = lex(src);
    assert.match(code, /\/x\[\/\\\\\]y\/g/);
    assert.match(code, /https:\/\/t\.me\/x/);
    assert.doesNotMatch(code, /addPost|addEvent/);
    assert.ok(strings.some((s) => s.includes("posts")));
    // Spelled in halves so this file's own import check does not read the sample as an import.
    const sample =
      "imp" + 'ort { a, type B, c as d } fr' + 'om "../policy";\n' +
      "imp" + 'ort type { E } fr' + 'om "./types";\n' +
      "exp" + 'ort { F } fr' + 'om "./x";\n' +
      "const y = await imp" + 'ort("./store");\n' +
      "imp" + 'ort * as g fr' + 'om "./g";\n';
    assert.deepEqual(imports(lex(sample).code), [
      { spec: "../policy", typeOnly: false, names: ["a", "B", "c"] },
      { spec: "./types", typeOnly: true, names: ["E"] },
      { spec: "./x", typeOnly: false, names: ["F"] },
      { spec: "./g", typeOnly: false, names: null },
      { spec: "./store", typeOnly: false, names: null },
    ]);
  });

  it("the SQL checks read a statement in any case, and not prose", () => {
    assert.deepEqual(sqlWrites("insert or ignore into posts (a) values (?)"), ["posts"]);
    assert.deepEqual(sqlWrites("update tenant_settings set x = 1"), ["tenant_settings"]);
    assert.deepEqual(sqlWrites("could not update the room, will retry"), []);
    assert.match("SELECT body FROM posts WHERE id = ?", NAMES_POSTS);
    assert.match("insert into posts (a) values (?)", NAMES_POSTS);
    assert.doesNotMatch("always posts frogs", NAMES_POSTS);
    assert.doesNotMatch("posts coins, loud", NAMES_POSTS);
  });

  it("the trading predicate knows the machinery, and not the chat's own modules", () => {
    for (const t of ["worker/src/index", "worker/src/policy", "worker/src/trencher-nominate", "worker/src/tg-coin-look", "worker/src/brain-live", "worker/src/strategies/trencher", "worker/src/peer-theses", `${ROOM_DIR}voice`, "worker/src/xpost/writer"]) {
      assert.ok(isTrading(t), `${t} should count as out of bounds`);
    }
    for (const t of ["worker/src/telegram/api", "worker/src/llm", "worker/src/social-post", "worker/src/telegram/tg-groups/store"]) {
      assert.ok(!isTrading(t), `${t} is not trading`);
    }
  });

  it("found the files", () => {
    for (const f of ["types.ts", "store.ts", "detect.ts", "pacing.ts", "gate.ts", "voice.ts", "model.ts", "memory.ts", "coins.ts", "handler.ts"]) {
      assert.ok(TG_SOURCES.some((x) => path.basename(x) === f), `${f} is missing — the checks below would be vacuous`);
    }
    assert.ok(TG_FILES.length > TG_SOURCES.length, "the tests were found too");
  });
});

// ── (a) nothing here reaches trading ────────────────────────────────────────

describe("tg-groups reaches nothing that trades", () => {
  for (const f of TG_FILES) {
    const name = path.basename(f);
    it(`${name} imports nothing that trades, types included`, () => {
      for (const { spec } of imports(lexFile(f).code)) {
        const target = resolved(f, spec);
        if (target === null) continue;
        assert.ok(!isTrading(target), `${name} imports ${spec} (${target}) — trading is reached only through TgCoinsPort`);
        // A test may borrow the ledger to build a fixture; the code that runs may not hold its writer.
        if (!name.endsWith(".test.ts")) {
          assert.ok(!LEDGER_WRITERS.has(target), `${name} imports ${spec} — tg-groups never holds the ledger's writer`);
        }
      }
    });
  }

  /**
   * THE PRODUCTION CODE'S IMPORTS, AS AN ALLOWLIST. The deny-list above knows
   * the trading machinery by name; a new module that moves money is not on it
   * until somebody remembers to add it. For the shared modules, only the named
   * helpers are allowed: telegram/agent.ts is the owner's PC agent and
   * interpreter.ts the DM pipeline, and the one thing each lends a group is a
   * pure function. social-post.ts is the post writer's rulebook; a group line
   * borrows its similarity measure, never its writer prompt or its gate.
   */
  const MAY_IMPORT: ReadonlyArray<{ target: RegExp; names?: readonly string[] }> = [
    { target: /^worker\/src\/telegram\/tg-groups\/[^/]+$/ },
    { target: /^worker\/src\/telegram\/(?:api|state)$/ },
    { target: /^worker\/src\/telegram\/agent$/, names: ["containsSecret", "redactSecrets"] },
    { target: /^worker\/src\/telegram\/interpreter$/, names: ["stripThinkingBlock"] },
    { target: /^worker\/src\/social-post$/, names: ["REPEAT_LIMIT", "similarity"] },
    { target: /^worker\/src\/(?:llm|llm-failure|settings)$/ },
    { target: /^worker\/src\/memory\/tokens$/ },
    { target: /^packages\/core\/src\/[^/]+$/ },
  ];
  for (const f of TG_SOURCES) {
    const name = path.basename(f);
    it(`${name} imports only what tg-groups may import`, () => {
      for (const edge of imports(lexFile(f).code)) {
        const target = resolved(f, edge.spec);
        if (target === null) {
          assert.match(edge.spec, /^node:/, `${name} imports the package ${edge.spec} — tg-groups imports no packages`);
          continue;
        }
        const rule = MAY_IMPORT.find((r) => r.target.test(target));
        assert.ok(rule, `${name} imports ${edge.spec} (${target}), which is not on the tg-groups allowlist`);
        if (rule?.names) {
          assert.ok(edge.names !== null, `${name} imports all of ${target}; only ${rule.names.join(", ")} may be borrowed`);
          for (const n of edge.names ?? []) {
            assert.ok(rule.names.includes(n), `${name} imports ${n} from ${target}; only ${rule.names.join(", ")} may be borrowed`);
          }
        }
      }
    });
  }

  it("nothing its code imports, however indirectly, is a trading module", () => {
    // FOLLOWED THROUGH VALUE IMPORTS, the ones that run: an allowed module that
    // one day imports the wall would put the wall in this process's group
    // path, and the direct checks above would not see it.
    const reached = new Map<string, string>(); // file → who brought it in
    const queue = TG_SOURCES.map((f) => ({ file: f, from: "" }));
    // The queue grows while it is walked; an index, not shift(), reads it.
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i];
      if (!next) continue;
      const { file, from } = next;
      if (reached.has(file)) continue;
      reached.set(file, from);
      for (const edge of imports(lexFile(file).code)) {
        if (edge.typeOnly) continue;
        const target = resolved(file, edge.spec);
        if (target === null) continue;
        const full = onDisk(target);
        if (full && !reached.has(full)) queue.push({ file: full, from: rel(file) });
      }
    }
    const targets = [...reached.keys()].map(rel);
    assert.ok(targets.some((t) => t === "worker/src/telegram/api.ts"), "the walk followed the imports at all");
    const guilty = targets
      .filter((t) => {
        const bare = t.replace(/\.(?:ts|tsx)$/, "");
        return isTrading(bare) || LEDGER_WRITERS.has(bare);
      })
      .map((t) => `${t} (via ${reached.get(path.join(REPO, t)) ?? "?"})`);
    assert.deepEqual(guilty, [], "tg-groups' production code reaches a trading module");
  });

  it("only coins.ts hands anything to the port's look or nominate", () => {
    // THE ONE DOOR. The coin flow builds the nomination from the claimed
    // address and ids; a second caller is a second place message text could
    // be put on the wire into trading.
    const callers = TG_SOURCES.filter((f) => /\.\s*(?:look|nominate)\s*\(/.test(lexFile(f).code)).map((f) => path.basename(f));
    assert.deepEqual(callers, ["coins.ts"]);
  });
});

// ── (b) no group text lands where trading, the owner's DMs or the fleet read ─

describe("tg-groups writes nothing a trading decision reads", () => {
  for (const f of TG_FILES_BUT_SELF) {
    const name = path.basename(f);
    it(`${name} names no function that writes a trading input, the feed, the soul or a turn, or places an order`, () => {
      const { code } = lexFile(f);
      for (const fn of FORBIDDEN_NAMES) assert.doesNotMatch(code, new RegExp(`\\b${fn}\\b`), `${name} names ${fn}`);
    });

    it(`${name} names neither the posts table nor any other in SQL`, () => {
      const { code, strings } = lexFile(f);
      for (const s of strings) assert.doesNotMatch(s, NAMES_POSTS, `${name} names the posts table: ${s.slice(0, 80)}`);
      if (name.endsWith(".test.ts")) return;
      assert.deepEqual(sqlWrites(strings.join("\n")), [], `${name} writes SQL — tg-groups keeps its memory in its own file only`);
      assert.doesNotMatch(code, /\b(?:chat_turns|discovered_pools|peers\.json|research\.json)\b/, `${name} names a store a trading decision or the owner's DMs read`);
    });
  }

  it("only store.ts and forget-file.ts write a file (their own), and only model.ts reaches the model client", () => {
    // forget-file.ts is the forget requests' file, apart from the store so the
    // hold process can write a /forgetme down without holding any memory.
    const writers = TG_SOURCES.filter((f) =>
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|renameSync|createWriteStream|copyFileSync|unlinkSync|rmSync)\b/.test(lexFile(f).code),
    ).map((f) => path.basename(f));
    assert.deepEqual(writers.sort(), ["forget-file.ts", "store.ts"]);
    const llmUsers = TG_SOURCES.filter((f) => imports(lexFile(f).code).some((e) => resolved(f, e.spec) === "worker/src/llm")).map((f) =>
      path.basename(f),
    );
    assert.deepEqual(llmUsers, ["model.ts"], "one door to the model: the allowance, the pause and the time box live in model.ts");
  });
});

// ── (c) the address crosses, never the message ──────────────────────────────

const NOMINATE_FILE = path.join(WORKER_SRC, "trencher-nominate.ts");
const COIN_LOOK_FILE = path.join(WORKER_SRC, "tg-coin-look.ts");

/** The names trading may take from the chat's types. None of them carries a message, a name or a title. */
const PLAIN_TYPES = [
  "CoinKind",
  "CoinLook",
  "CoinOutcome",
  "NominateRefusal",
  "NominateResult",
  "Nomination",
  "TgCoinsPort",
  "TrencherReadiness",
  "TrencherReadinessKind",
];

/** Identifiers that carry what somebody said, who said it or where: never named on the trading side of the door. */
const MESSAGE_BEARING = /\b(?:TgMessage|TgLine|TgRoom|TgPerson|TgCoinMemo|TgGroupsStore|TgGroupsState|senderName|byName|fromFirstName|fromUsername|chatTitle|caption)\b|\.\s*text\b/;

/** The same, for a type written in a signature: a field or type that carries a line, a name or a title. */
const MESSAGE_BEARING_TYPE = /\b(?:TgMessage|TgLine|TgRoom|TgPerson|TgCoinMemo|TgGroupsStore|TgGroupsState|text|caption|senderName|byName|fromFirstName|fromUsername|chatTitle|title)\b/;

/**
 * Every exported function, public class member and interface member of a
 * file, as `name(param: type, …)` or `Iface.field: type`, whitespace folded.
 * Read with the TypeScript parser rather than imported: this directory may not
 * import the trading side, not even for its types.
 */
function exportedSignatures(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const fold = (n: ts.Node | undefined): string => (n ? n.getText(sf).replace(/\s+/g, " ").trim() : "");
  const has = (n: ts.Node, kind: ts.SyntaxKind): boolean => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
  const params = (ps: ts.NodeArray<ts.ParameterDeclaration>): string =>
    ps
      .map((p) => {
        const head = `${p.dotDotDotToken ? "..." : ""}${fold(p.name)}${p.questionToken ? "?" : ""}`;
        if (p.type) return `${head}: ${fold(p.type)}${p.initializer ? ` = ${fold(p.initializer)}` : ""}`;
        return p.initializer ? `${head} = ${fold(p.initializer)}` : `${head}: (untyped)`;
      })
      .join(", ");
  const out: string[] = [];
  for (const s of sf.statements) {
    if (!has(s, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(s) && s.name) {
      out.push(`${s.name.text}(${params(s.parameters)})`);
    } else if (ts.isClassDeclaration(s) && s.name) {
      for (const m of s.members) {
        if (has(m, ts.SyntaxKind.PrivateKeyword) || has(m, ts.SyntaxKind.ProtectedKeyword)) continue;
        if (ts.isConstructorDeclaration(m)) out.push(`new ${s.name.text}(${params(m.parameters)})`);
        else if (ts.isMethodDeclaration(m) && !ts.isPrivateIdentifier(m.name)) out.push(`${s.name.text}.${fold(m.name)}(${params(m.parameters)})`);
        else if (ts.isPropertyDeclaration(m) && !ts.isPrivateIdentifier(m.name)) out.push(`${s.name.text}.${fold(m.name)}: ${fold(m.type)}`);
      }
    } else if (ts.isInterfaceDeclaration(s)) {
      for (const m of s.members) {
        if (ts.isPropertySignature(m)) out.push(`${s.name.text}.${fold(m.name)}${m.questionToken ? "?" : ""}: ${fold(m.type)}`);
        else if (ts.isMethodSignature(m)) out.push(`${s.name.text}.${fold(m.name)}${m.questionToken ? "?" : ""}(${params(m.parameters)})`);
      }
    }
  }
  return out;
}

describe("trading never receives message text", () => {
  for (const f of [NOMINATE_FILE, COIN_LOOK_FILE]) {
    const name = path.basename(f);
    it(`${name} takes only the plain types from telegram/, and only as types`, () => {
      for (const edge of imports(lexFile(f).code)) {
        const target = resolved(f, edge.spec);
        if (target === null || !target.startsWith("worker/src/telegram/")) continue;
        assert.equal(target, "worker/src/telegram/tg-groups/types", `${name} imports ${target} — the chat side is reached only through its types`);
        assert.ok(edge.typeOnly, `${name} imports values from ${target}`);
        for (const n of edge.names ?? ["*"]) assert.ok(PLAIN_TYPES.includes(n), `${name} imports ${n} from the chat's types`);
      }
    });

    it(`${name} never names a field that carries a message, a name or a title`, () => {
      const m = MESSAGE_BEARING.exec(lexFile(f).code);
      assert.equal(m, null, `${name} names ${m?.[0]}`);
    });
  }

  /**
   * EVERY EXPORTED ENTRY POINT OF THE TRADING SIDE OF THE DOOR, as written.
   * What each takes is an address, an id, a timestamp, a setting, a chain or
   * index read, or the Brain's own output — never a line, a sender's name or
   * a chat title. The list is exact on purpose: a new parameter, a new field
   * on an input, or a widened type fails here, and has to be argued for in a
   * diff. (`safeNotes` takes text, and it is the Brain's: its thesis, bull and
   * bear case, the way the book reduces them to figure-free notes.)
   */
  const EXPECTED_SIGNATURES: Record<string, readonly string[]> = {
    "trencher-nominate.ts": [
      "isCaAddress(s: string)",
      "ReadinessInput.strategy: string",
      "ReadinessInput.assetMode: string",
      "ReadinessInput.trencherFastEnabled: boolean",
      "ReadinessInput.brainUrl?: string | null",
      "ReadinessInput.brainToken?: string | null",
      "ReadinessInput.paper: boolean",
      "ReadinessInput.hasTrencherGrant: boolean",
      "ReadinessInput.trencherLiveEnabled: boolean",
      "trencherReadiness(i: ReadinessInput)",
      "safeNotes(texts: ReadonlyArray<string | null | undefined>, maxChars = 400)",
      "NominationCounters.takeNomination(day: string, limit: number)",
      "NominationCounters.takeGroupEntry(day: string, limit: number)",
      "NominationCounters.refundGroupEntry(day: string)",
      'ReviewedDecision.action: "buy" | "sell" | "hold"',
      "ReviewedDecision.decisionId: string",
      "ReviewedDecision.holdKind?: string | null",
      "ReviewedDecision.thesis?: string | null",
      "ReviewedDecision.bullCase?: string | null",
      "ReviewedDecision.bearCase?: string | null",
      "ReviewedDecision.risks?: ReadonlyArray<string> | null",
      "new NominationBook(counters: NominationCounters, now: () => number = Date.now)",
      "NominationBook.nominate(n: Nomination, readiness: TrencherReadinessKind)",
      "NominationBook.active()",
      "NominationBook.priority()",
      "NominationBook.nominated(address: string)",
      "NominationBook.onReviewed(address: string, d: ReviewedDecision)",
      "NominationBook.onFill(decisionId: string, status: string, paper: boolean)",
      "NominationBook.claimEntry(address: string)",
      "NominationBook.refundEntry(address: string)",
      "NominationBook.expire()",
      "NominationBook.onExit(address: string, notes?: string[])",
      "NominationBook.reset()",
    ],
    "tg-coin-look.ts": [
      "TokenProbe.pons: boolean",
      "TokenProbe.erc20: boolean",
      "TokenProbe.pool?: { token0: string; token1: string; canonical: string | null }",
      "CoinLookReaders.own: () => readonly string[]",
      "CoinLookReaders.held: (address: string) => { name?: string | null } | null",
      "CoinLookReaders.tokenPools: (address: string) => Promise<GeckoPool[] | null>",
      "CoinLookReaders.getCode: (address: `0x${string}`) => Promise<string | undefined>",
      "CoinLookReaders.probe: (address: `0x${string}`) => Promise<TokenProbe | null>",
      "CoinLookReaders.curveFor?: (address: string) => Promise<unknown>",
      "CoinLookReaders.now?: () => number",
      "createCoinLook(d: CoinLookReaders)",
      "chainTokenProbe(client: PublicClient)",
      "TgCoinsPortDeps.readiness: () => TrencherReadiness",
      "TgCoinsPortDeps.look: (address: string) => Promise<CoinLook>",
      'TgCoinsPortDeps.book: Pick<NominationBook, "nominate">',
      "TgCoinsPortDeps.onNominated?: (address: string) => void",
      "TgCoinsPortDeps.heldNames: () => readonly string[]",
      "TgCoinsPortDeps.paper: () => boolean",
      "TgCoinsPortDeps.log?: (line: string) => void",
      "TgCoinsHub.emit(outcomes: CoinOutcome | readonly CoinOutcome[] | null | undefined)",
      "createTgCoinsPort(d: TgCoinsPortDeps)",
      'reviewedDecisionOf(d: Pick<BrainDecision, "action" | "decision_id" | "thesis" | "bull_case" | "bear_case" | "risks" | "hold_kind" | "gate_verdict">)',
      'claimGroupEntry(book: Pick<NominationBook, "nominated" | "claimEntry">, intent: { kind: string; buyToken?: string; decisionId?: string }, reviewedFor: (decisionId: string) => string | undefined)',
      "groupExitOf(intent: { kind: string; sellToken?: string; buyToken?: string; sellAmountRaw?: bigint }, why: { code: string; cause?: unknown } | null | undefined, heldRaw: bigint | null | undefined)",
    ],
  };

  for (const f of [NOMINATE_FILE, COIN_LOOK_FILE]) {
    const name = path.basename(f);
    it(`${name}'s exported entry points take only addresses, ids, timestamps, settings and Brain output`, () => {
      const got = exportedSignatures(f);
      assert.deepEqual(got, EXPECTED_SIGNATURES[name]);
      for (const sig of got) assert.doesNotMatch(sig, MESSAGE_BEARING_TYPE, `${name}: ${sig}`);
    });
  }

  it("the door itself: a Nomination is an address and four numbers, and the port takes nothing else", () => {
    const got = exportedSignatures(path.join(HERE, "types.ts")).filter((s) => /^(?:Nomination|TgCoinsPort)\./.test(s));
    assert.deepEqual(got, [
      "Nomination.address: string",
      "Nomination.chatId: number",
      "Nomination.messageId: number",
      "Nomination.senderId: number",
      "Nomination.atMs: number",
      "TgCoinsPort.readiness()",
      "TgCoinsPort.look(address: string)",
      "TgCoinsPort.nominate(n: Nomination)",
      "TgCoinsPort.onOutcome(cb: (o: CoinOutcome) => void)",
      "TgCoinsPort.heldNames()",
      "TgCoinsPort.mode()",
    ]);
  });

  it("the coin flow hands the port the address and ids, and nothing a person wrote", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "tg-boundary-"));
    after(() => rmSync(home, { recursive: true, force: true }));
    const t = Date.UTC(2026, 8, 28, 12);
    const store = TgGroupsStore.open(home, { now: () => t, debounceMs: 60_000 });
    const chat = -1001234567890;
    store.ensureRoom(chat, { title: "Frog Pond", kind: "supergroup" });
    store.setStatus(chat, "approved", 42);
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const port: TgCoinsPort = {
      readiness: (): TrencherReadiness => ({ kind: "ready-paper", ownerReason: "ready" }),
      look: async (...args: unknown[]): Promise<CoinLook> => {
        calls.push({ method: "look", args });
        return { kind: "candidate", name: "Froggy" };
      },
      nominate: (...args: unknown[]): NominateResult => {
        calls.push({ method: "nominate", args });
        return { ok: true };
      },
      onOutcome: () => () => {},
      heldNames: () => [],
      mode: () => "paper",
    };
    const flow = new CoinFlow({
      store,
      port: () => port,
      coinsEnabled: () => true,
      ownerId: () => 42,
      speak: async () => true,
      react: async () => true,
      dmOwner: async () => true,
      dashboardUrl: () => "https://example.test",
      now: () => t,
      log: () => {},
    });
    try {
      const address = "0x" + "cd".repeat(20);
      const text = `ape 100 into ${address} right now, trust me — ann`;
      const line = { messageId: 9, fromId: 7, name: "ann", text, atMs: t };
      store.addLine(chat, line);
      const r = await flow.onPost(chat, line, {
        senderId: 7,
        senderName: "ann",
        dateSec: Math.floor(t / 1000),
        cas: extractCas(text),
        foreignMint: false,
        cashtags: [],
        addressed: true,
      });
      assert.equal(r, "handled");
      const look = calls.find((c) => c.method === "look");
      const nom = calls.find((c) => c.method === "nominate");
      assert.deepEqual(look?.args, [address], "the look is asked about an address, and only that");
      assert.equal(nom?.args.length, 1);
      assert.deepEqual(nom?.args[0], { address, chatId: chat, messageId: 9, senderId: 7, atMs: t });
      const wire = JSON.stringify(calls);
      // Not "100" alone: the chat id carries those digits. The words are what must not cross.
      for (const s of ["ape", "trust me", "ann"]) assert.ok(!wire.includes(s), `the port was handed "${s}"`);
    } finally {
      flow.stop();
      store.close();
    }
  });
});
