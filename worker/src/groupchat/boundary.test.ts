/**
 * THE TRADING BOUNDARY — rule 1 of docs/groupchat.md: chat is never an input to
 * trading, and the room can never move money.
 *
 * Pinned from both sides, because either side can break it with one
 * reasonable-looking line. The room must not reach the machinery that trades,
 * and nothing that feeds a trading decision may know the room exists: not
 * Brain's material, not the strategist, not peers.json, not the Telegram
 * interpreter, not the child's tick. The social `posts` table is the cautionary
 * tale — it IS a trading input (peer-theses.ts → peers.json → Brain's social
 * lens) — which is exactly why the room has its own tables and why this file
 * checks that nobody quietly joins the two.
 *
 * WHAT IS CHECKED IS CODE, NOT PROSE. Both sides explain in comments what they
 * will not do, using the names of the things they will not do, and the first
 * version of brain-disconnected.test.ts failed on its own documentation. So
 * comments are stripped first — by a small lexer rather than a regex, because
 * groupchat/policy.ts is dense with regex literals like `[/\\]` that a regex
 * stripper would read as the start of a comment and silently cut the rest of
 * the line.
 *
 * ADDING AN IMPORT IS HOW THIS BREAKS, and the failure message says which one.
 * A new edge across the boundary has to be argued for here, in a diff, rather
 * than slipped in beside a helper.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = path.join(HERE, "..");
const REPO = path.join(WORKER_SRC, "..", "..");
const SELF = path.join(HERE, "boundary.test.ts");

const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

function walk(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "__pycache__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

// ── a small TypeScript lexer ────────────────────────────────────────────────

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)$/;

/**
 * Source with every comment replaced by a space, plus every string, template
 * and regex literal it contains. Strings and regexes stay in `code`: a table
 * name in a SQL string is code, and so is an import specifier.
 */
function lex(src: string): { code: string; strings: string[] } {
  let code = "";
  const strings: string[] = [];
  let i = 0;
  let prev = ""; // the last significant code character (or word), for the regex heuristic
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
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
        const c = src[j]!;
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
        const c = src[j]!;
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
      while (j < n && /[a-z]/i.test(src[j]!)) j++;
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

/** Python with `#` comments and docstrings (triple-quoted strings standing alone on their line) removed. */
function pythonCode(src: string): string {
  return src
    .replace(/^[ \t]*[rRbBuU]{0,2}("""|''')[\s\S]*?\1[ \t]*$/gm, " ")
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let k = 0; k < line.length; k++) {
        const c = line[k]!;
        if (quote) {
          if (c === "\\") k++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#") return line.slice(0, k);
      }
      return line;
    })
    .join("\n");
}

/** Every module specifier a file names: static imports and re-exports, side-effect imports, dynamic import() and require(). */
function specifiers(code: string): string[] {
  const out: string[] = [];
  // NO WHITESPACE IN A SPECIFIER: a phrasebook line ending "… comes from",
  // followed by the next line's quote, read as importing the package ",\n    ".
  for (const re of [
    /\bfrom\s*["'`]([^"'`\s]+)["'`]/g,
    /\bimport\s*["'`]([^"'`\s]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`\s]+)["'`]/g,
    /\brequire\s*\(\s*["'`]([^"'`\s]+)["'`]/g,
  ]) {
    for (const m of code.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

/** A relative specifier, resolved to a repo path without its extension. Package and node: specifiers are null. */
function resolved(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return rel(path.resolve(path.dirname(file), spec)).replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "");
}

// ── the files ───────────────────────────────────────────────────────────────

const ROOM_FILES = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(HERE, f));
const ROOM_SOURCES = ROOM_FILES.filter((f) => !f.endsWith(".test.ts"));
/**
 * THIS FILE IS EXEMPT FROM THE NAME CHECKS, and only from those: it has to
 * spell every forbidden name in a string to look for it. Its imports are
 * checked like everyone else's.
 */
const ROOM_FILES_BUT_SELF = ROOM_FILES.filter((f) => f !== SELF);

const lexed = new Map<string, ReturnType<typeof lex>>();
function lexFile(f: string): ReturnType<typeof lex> {
  let l = lexed.get(f);
  if (!l) {
    l = lex(readFileSync(f, "utf8"));
    lexed.set(f, l);
  }
  return l;
}

/**
 * THE TABLES A PIECE OF SQL WRITES, HOWEVER IT IS CASED. Upper case is how
 * this codebase spells SQL, but `update tenant_settings set …` runs just the
 * same in lower case, so case is not what is trusted. An INSERT INTO or a
 * DELETE FROM counts in any case; an UPDATE counts in any case when a SET
 * follows its table — prose ("update the …") never has one, and neither does
 * policy.ts's seed-phrase wordlist, which says "update upgrade" — and in upper
 * case on its own, as before. `DO UPDATE SET` is an upsert's tail, not a
 * statement of its own.
 */
function sqlWrites(sql: string): string[] {
  const out = new Set<string>();
  for (const re of [
    /\b(?:INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /(?<!\bDO\s+)\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+SET\b/gi,
    /(?<!DO\s)\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)/g,
  ]) {
    for (const m of sql.matchAll(re)) out.add(m[1]!);
  }
  return [...out];
}

// ── (a) the room reaches nothing that trades ────────────────────────────────

/**
 * The trading machinery, by path under worker/src. The names are the ones
 * brain-disconnected.test.ts forbids the shadow path, widened to the modules
 * that carry them today (the proposal and strategy code lives under
 * strategist/), plus the child's own tick. `./policy` here is worker/src/policy.ts
 * — THE WALL — and not groupchat/policy.ts, which is the room's own gate; the
 * check is on resolved paths precisely so the two can never be confused.
 */
const TRADING_EXACT = new Set(
  ["proposals", "policy", "executor", "simulate", "wall", "intents", "strategy", "peer-files", "peer-theses", "index"].map(
    (m) => `worker/src/${m}`,
  ),
);
const TRADING_PREFIX = ["worker/src/brain-", "worker/src/executor-", "worker/src/wall-", "worker/src/strategist/", "worker/src/strategies/"];

function isTrading(target: string): boolean {
  return TRADING_EXACT.has(target) || TRADING_PREFIX.some((p) => target.startsWith(p));
}

/**
 * The ledger's writers. A test may borrow the ledger schema to build a fixture
 * (facts.test.ts does); the room's own code must never hold a handle on the
 * module that writes trades, posts and decisions — the functions below are
 * how it would write one.
 */
const LEDGER_WRITERS = new Set(["worker/src/store", "worker/src/ledger-mirror"]);

/** Functions that write a trading input or place an order. Named, never called, never passed around. */
const FORBIDDEN_NAMES = ["addPost", "addEvent", "addDecision", "writePeersForChild", "writeSettingsForChild", "submitChatTrade"];

describe("the room reaches nothing that trades", () => {
  it("the lexer is what the rest of this file trusts", () => {
    // A regex literal holding `[/\\]` and a URL in a string are code; the
    // comments around them are not.
    const src = 'const a = /x[/\\\\]y/g; // bye\nconst b = "https://t.me/x"; /* gone */ const c = `q ${1} addPost`;\n';
    const { code, strings } = lex(src);
    assert.match(code, /\/x\[\/\\\\\]y\/g/);
    assert.match(code, /https:\/\/t\.me\/x/);
    assert.doesNotMatch(code, /bye|gone/);
    assert.ok(strings.some((s) => s.includes("addPost")));
    // Spelled in halves so this file's own import check does not read the
    // sample as an import of the wall.
    const sample = "import x fr" + 'om "../policy";\nconst y = await imp' + 'ort("./store");\n';
    assert.deepEqual(specifiers(lex(sample).code), ["../policy", "./store"]);
    assert.equal(pythonCode('"""groupchat doc"""\nx = 1  # groupchat\ny = "#groupchat"\n').includes("groupchat doc"), false);
  });

  it("the SQL detector reads a write in any case, and not prose", () => {
    assert.deepEqual(sqlWrites("UPDATE groupchat_messages SET body = ?"), ["groupchat_messages"]);
    assert.deepEqual(sqlWrites("update tenant_settings set x = 1"), ["tenant_settings"]);
    assert.deepEqual(sqlWrites("insert or ignore into posts (a) values (?)"), ["posts"]);
    assert.deepEqual(sqlWrites("delete from decisions where id = ?"), ["decisions"]);
    assert.deepEqual(sqlWrites("INSERT INTO groupchat_messages (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = excluded.a"), ["groupchat_messages"]);
    assert.deepEqual(sqlWrites("unusual unveil update upgrade uphold upon"), [], "the wordlist is not a statement");
    assert.deepEqual(sqlWrites("could not update the room, will retry"), [], "a log line is not a statement");
  });

  it("found the room's files", () => {
    for (const f of ["conductor.ts", "store.ts", "policy.ts", "clock.ts", "facts.ts", "voice.ts", "types.ts"]) {
      assert.ok(ROOM_FILES.some((x) => path.basename(x) === f), `${f} is missing — the checks below would be vacuous`);
    }
  });

  for (const f of ROOM_FILES) {
    const name = path.basename(f);
    it(`${name} imports nothing that trades`, () => {
      const targets = specifiers(lexFile(f).code)
        .map((s) => [s, resolved(f, s)] as const)
        .filter((x): x is readonly [string, string] => x[1] !== null);
      for (const [spec, target] of targets) {
        assert.ok(!isTrading(target), `${name} imports ${spec} (${target}) — the room must not reach trading`);
        assert.ok(!target.startsWith("worker/src/orchestrator"), `${name} imports the orchestrator — the dependency runs the other way`);
        if (!name.endsWith(".test.ts")) {
          assert.ok(!LEDGER_WRITERS.has(target), `${name} imports ${spec} — the room never holds the ledger's writer`);
        }
      }
    });
  }

  /**
   * THE ROOM'S IMPORTS, AS AN ALLOWLIST. The deny-list above knows the trading
   * machinery by name, and a new module that moves money — a session key, a
   * grant, a venue, a swap fill — is not on it until somebody remembers to add
   * it. So the room's own code may import only these, and any new edge fails
   * here until it is argued for in a diff. Tests may borrow more (a ledger
   * fixture); the code that runs in production may not.
   */
  const ROOM_MAY_IMPORT: readonly RegExp[] = [
    /^worker\/src\/groupchat\/[^/]+$/,
    /^worker\/src\/(?:db|llm|llm-failure|coin-name|class-evidence|identity-store|social-post|thesis-policy)$/,
    /^worker\/src\/memory\/tokens$/,
    /^packages\/core\/src\/[^/]+$/,
  ];
  for (const f of ROOM_SOURCES) {
    const name = path.basename(f);
    it(`${name} imports only what the room may import`, () => {
      for (const spec of specifiers(lexFile(f).code)) {
        const target = resolved(f, spec);
        if (target === null) {
          // A package can move money as well as a module can: builtins only.
          assert.match(spec, /^node:/, `${name} imports the package ${spec} — the room's code imports no packages`);
          continue;
        }
        assert.ok(ROOM_MAY_IMPORT.some((re) => re.test(target)), `${name} imports ${spec} (${target}), which is not on the room's allowlist`);
      }
    });
  }

  it("the phrasebook is data: templates.ts imports nothing at all", () => {
    // Every sentence an agent can publish is in that one file, so a reviewer
    // can read the whole room there. An import is the first step to a sentence
    // built from somewhere a reviewer is not looking — a ledger value, a
    // setting, a model's words.
    const f = ROOM_SOURCES.find((x) => path.basename(x) === "templates.ts");
    assert.ok(f, "templates.ts is missing — the check would be vacuous");
    assert.deepEqual(specifiers(lexFile(f!).code), []);
  });

  it("only voice.ts reaches the model client", () => {
    // ONE DOOR TO THE MODEL. llm.ts is the fleet's client (resolveLlm would
    // hand the room an owner's key), and voice.ts is where the room's own-key
    // rule and the time box live; a second importer is a second place a line
    // could be written on somebody else's allowance. Types included, so the
    // edge cannot creep back in as `import type` and later lose the `type`.
    const importers = ROOM_SOURCES.filter((f) =>
      specifiers(lexFile(f).code).some((s) => resolved(f, s) === "worker/src/llm"),
    ).map((f) => path.basename(f));
    assert.deepEqual(importers, ["voice.ts"]);
  });

  for (const f of ROOM_FILES_BUT_SELF) {
    const name = path.basename(f);
    it(`${name} names no function that writes a trading input or places an order`, () => {
      const { code } = lexFile(f);
      for (const fn of FORBIDDEN_NAMES) assert.doesNotMatch(code, new RegExp(`\\b${fn}\\b`), `${name} names ${fn}`);
    });
  }

  for (const f of ROOM_SOURCES) {
    const name = path.basename(f);
    it(`${name} writes only the room's own tables, and no file at all`, () => {
      const { code, strings } = lexFile(f);
      // In any case (sqlWrites): a lower-case statement runs just the same.
      for (const table of sqlWrites(strings.join("\n"))) {
        assert.match(table, /^groupchat_/, `${name} writes ${table} — the room writes only groupchat_* tables`);
      }
      // THE FILES A CHILD READS (peers.json, research.json, its settings) are
      // how anything reaches a trading decision; the room writes none.
      assert.doesNotMatch(code, /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|renameSync|createWriteStream)\b/, `${name} writes a file`);
    });
  }
});

// ── (b) nothing that trades knows the room exists ───────────────────────────

const MENTION = /groupchat|group_chat|group-chat/i;

/**
 * EVERY WORKER FILE BUT THE ROOM AND ITS ONE WRITER, not a curated list of
 * trading paths. A list misses the module nobody thought of — research-pass.ts
 * feeds research.json and so Brain, social-post.ts writes the `posts` table
 * the doc calls a trading input, trencher-*, builder-pass, class-* — and one
 * `SELECT body FROM groupchat_messages` added to any of them would have
 * passed. brain-*.ts, peer-*, research-files.ts, strategist/, strategies/,
 * telegram/ and index.ts are named below so the walk is known to reach them.
 */
function tradingFiles(): string[] {
  return walk(WORKER_SRC, (f) => f.endsWith(".ts")).filter((f) => !f.startsWith(HERE + path.sep) && !/^orchestrator[^/\\]*\.ts$/.test(path.basename(f)));
}

/**
 * THE WEB PATHS THAT LET AN OWNER'S AGENT ACT: the chat that can propose
 * orders, and the orders route itself. They are the web's side of trading, and
 * the room is no input to them either.
 */
function webTradingFiles(): string[] {
  const lib = path.join(REPO, "web", "src", "lib");
  const api = path.join(REPO, "web", "src", "app", "api");
  const libFiles = readdirSync(lib)
    .filter((f) => /\.tsx?$/.test(f) && (f === "agent-chat.ts" || f.startsWith("chat-")))
    .map((f) => path.join(lib, f));
  const routes = ["chat", "orders"].flatMap((d) => walk(path.join(api, d), (f) => /\.tsx?$/.test(f)));
  return [...libFiles, ...routes];
}

describe("nothing that trades knows the room exists", () => {
  it("no worker TypeScript outside the room and the orchestrator mentions it in code", () => {
    const files = tradingFiles();
    for (const must of ["brain-material.ts", "peer-theses.ts", "peer-files.ts", "research-files.ts", "index.ts", "desk.ts", "agent.ts", "social-post.ts", "store.ts"]) {
      assert.ok(files.some((f) => path.basename(f) === must), `${must} was not found — the walk is looking in the wrong place`);
    }
    assert.ok(files.length > 100, `only ${files.length} worker files found`);
    assert.ok(!files.some((f) => f.startsWith(HERE + path.sep)), "the room's own files are not its readers");
    const guilty = files.filter((f) => MENTION.test(lex(readFileSync(f, "utf8")).code)).map(rel);
    assert.deepEqual(guilty, [], "a worker module other than the orchestrator mentions the group chat");
  });

  it("the web's agent chat and orders never mention the room, nor import it", () => {
    const files = webTradingFiles();
    for (const must of ["agent-chat.ts", "chat-commands.ts"]) {
      assert.ok(files.some((f) => path.basename(f) === must), `${must} was not found — the walk is looking in the wrong place`);
    }
    assert.ok(files.some((f) => rel(f).startsWith("web/src/app/api/chat/")) && files.some((f) => rel(f).startsWith("web/src/app/api/orders/")), "the chat and orders routes were not found");
    const guilty = files
      .filter((f) => {
        const { code } = lex(readFileSync(f, "utf8"));
        return MENTION.test(code) || specifiers(code).some((s) => MENTION.test(s) || resolved(f, s)?.startsWith("worker/src/groupchat/"));
      })
      .map(rel);
    assert.deepEqual(guilty, [], "a web path that can place an order knows the group chat");
  });

  it("no file of the Brain service mentions it in code", () => {
    const files = walk(path.join(REPO, "services", "brain"), (f) => f.endsWith(".py"));
    assert.ok(files.length > 10, "the walk found the service at all");
    const guilty = files.filter((f) => MENTION.test(pythonCode(readFileSync(f, "utf8")))).map(rel);
    assert.deepEqual(guilty, []);
  });

  it("only the orchestrator imports the room from the rest of the worker", () => {
    // The orchestrator is the room's one writer and the one process that sees
    // the fleet; a second importer is a second place the room could be read
    // from, and the one most likely to sit on a trading path.
    const files = walk(WORKER_SRC, (f) => f.endsWith(".ts")).filter((f) => !f.startsWith(HERE + path.sep));
    const importers: string[] = [];
    for (const f of files) {
      const targets = specifiers(lex(readFileSync(f, "utf8")).code).map((s) => resolved(f, s));
      if (targets.some((t) => t !== null && t.startsWith("worker/src/groupchat/"))) importers.push(rel(f));
    }
    const strangers = importers.filter((f) => !/^worker\/src\/orchestrator[^/]*\.ts$/.test(f));
    assert.deepEqual(strangers, [], "a worker module other than the orchestrator imports the group chat");
  });
});

// ── (c) the room never reads the owner's balance sheet ──────────────────────

describe("no room source selects signals_json", () => {
  for (const f of ROOM_FILES_BUT_SELF) {
    const name = path.basename(f);
    it(`${name} selects no signals_json and no star`, () => {
      const { code, strings } = lexFile(f);
      for (const s of strings) {
        if (!/\bSELECT\b/i.test(s)) continue;
        assert.doesNotMatch(s, /signals_json/i, `${name} selects signals_json`);
      }
      if (name.endsWith(".test.ts")) return;
      // THE ROOM'S OWN CODE DOES NOT EVEN SAY IT. facts.ts explains in a
      // comment why it never selects the column; code has no reason to name it.
      assert.doesNotMatch(code, /signals_json/i, `${name} names signals_json in code`);
      // A star from a ledger table selects it without naming it.
      for (const s of strings) {
        if (!/\bSELECT\b/.test(s)) continue;
        assert.doesNotMatch(s, /\bSELECT\s+(?:DISTINCT\s+)?(?:[A-Za-z_]\w*\.)?\*/i, `${name} selects *`);
        assert.doesNotMatch(s, /,\s*(?:[A-Za-z_]\w*\.)\*/, `${name} selects t.*`);
      }
    });
  }
});
