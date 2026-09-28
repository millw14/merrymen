/**
 * THE X BOUNDARY — rules 5 and 6 of docs/x-posting.md, pinned where one
 * reasonable-looking line would break them.
 *
 *   - xpost/ reaches nothing that trades. Its production code imports only an
 *     allowlist: node builtins, the Db, the model client, the sealing
 *     helpers, the bounded reader, the similarity measure, the coin-name
 *     rule, core's pure modules, and its own siblings. A new edge has to be
 *     argued for here, in a diff. (That list also leaves out the group room:
 *     its pieces reach X only through orchestrator-xpost.ts, and the room's
 *     own boundary test pins that nothing else imports it.)
 *   - xpost/ writes only xpost_* tables, and no file: a child's files
 *     (settings, peers, research) are how anything reaches a trading decision.
 *   - Nothing but xpost/ and the orchestrator imports xpost/, and nothing
 *     outside them even names an xpost_* table: X state is never a trading
 *     input, and `posts` — the social table — is one, which is why X posts
 *     are not stored there.
 *   - The X client secret is READ in exactly one file (xpost/client.ts),
 *     across the worker and the web. Listing its name — the orchestrator's
 *     CHILD_SECRET_STRIP, a boot line saying it is missing — is not reading it.
 *
 * WHAT IS CHECKED IS CODE, NOT PROSE: comments are stripped by a small lexer
 * first (copied from the room's boundary test, which this directory may not
 * import), because every module here explains in comments what it will not
 * touch, by name.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = path.join(HERE, "..");
const REPO = path.join(WORKER_SRC, "..", "..");

const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

function walk(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".next" || entry === "__pycache__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

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

/** Every module specifier a file names: static imports and re-exports, side-effect imports, dynamic import() and require(). */
function specifiers(code: string): string[] {
  const out: string[] = [];
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

/**
 * THE TABLES A PIECE OF SQL WRITES OR CREATES, HOWEVER IT IS CASED. Upper case
 * is how this codebase spells SQL, but `update tenant_settings set …` runs
 * just the same in lower case, so case is not what is trusted. An UPDATE in
 * any case counts when a SET follows its table — prose never has one, and
 * neither does the seed-phrase wordlist's "update upgrade" the room carries —
 * and an upper-case UPDATE counts on its own, as before. `DO UPDATE SET` is an
 * upsert's tail, not a statement of its own.
 */
function sqlTargets(sql: string): { writes: string[]; creates: string[] } {
  const writes: string[] = [];
  for (const re of [
    /\b(?:INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /(?<!\bDO\s+)\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+SET\b/gi,
    /(?<!DO\s)\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)/g,
  ]) {
    for (const m of sql.matchAll(re)) writes.push(m[1]!);
  }
  const creates = [...sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]!);
  return { writes: [...new Set(writes)], creates: [...new Set(creates)] };
}

const lexed = new Map<string, ReturnType<typeof lex>>();
function lexFile(f: string): ReturnType<typeof lex> {
  let l = lexed.get(f);
  if (!l) {
    l = lex(readFileSync(f, "utf8"));
    lexed.set(f, l);
  }
  return l;
}

// ── the files ───────────────────────────────────────────────────────────────

const XPOST_FILES = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(HERE, f));
const XPOST_SOURCES = XPOST_FILES.filter((f) => !f.endsWith(".test.ts"));

describe("xpost reaches nothing that trades", () => {
  it("the lexer is what the rest of this file trusts", () => {
    const src = 'const a = /x[/\\\\]y/g; // bye\nconst b = "https://x.com/i"; /* gone */ const c = `q ${1} xpost_posts`;\n';
    const { code, strings } = lex(src);
    assert.match(code, /https:\/\/x\.com\/i/);
    assert.doesNotMatch(code, /bye|gone/);
    assert.ok(strings.some((s) => s.includes("xpost_posts")));
    const sample = "import x fr" + 'om "../policy";\nconst y = await imp' + 'ort("./store");\n';
    assert.deepEqual(specifiers(lex(sample).code), ["../policy", "./store"]);
  });

  it("the SQL detector reads a write in any case, and not prose", () => {
    assert.deepEqual(sqlTargets("UPDATE xpost_posts SET status = ?").writes, ["xpost_posts"]);
    assert.deepEqual(sqlTargets("UPDATE xpost_posts").writes, ["xpost_posts"], "upper case needs no SET, as before");
    assert.deepEqual(sqlTargets("update tenant_settings set x = 1").writes, ["tenant_settings"]);
    assert.deepEqual(sqlTargets("insert or replace into peers (a) values (?)").writes, ["peers"]);
    assert.deepEqual(sqlTargets("delete from posts where id = ?").writes, ["posts"]);
    assert.deepEqual(sqlTargets("create table if not exists settings (a)").creates, ["settings"]);
    assert.deepEqual(sqlTargets("INSERT INTO xpost_posts (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = excluded.a").writes, ["xpost_posts"]);
    assert.deepEqual(sqlTargets("do update set a = excluded.a").writes, []);
    assert.deepEqual(sqlTargets("unusual unveil update upgrade uphold").writes, [], "a wordlist is not a statement");
    assert.deepEqual(sqlTargets("could not update the post, will retry").writes, [], "a log line is not a statement");
  });

  it("found the production files", () => {
    for (const f of ["client.ts", "store.ts", "gate.ts", "writer.ts", "planner.ts", "sender.ts"]) {
      assert.ok(XPOST_SOURCES.some((x) => path.basename(x) === f), `${f} is missing — the checks below would be vacuous`);
    }
  });

  /**
   * THE ALLOWLIST. A module that moves money — a session key, a grant, a
   * venue, the wall — is not on it, and neither is anything a trading
   * decision reads. Types count: an `import type` is one edit from a value.
   */
  const MAY_IMPORT: readonly RegExp[] = [
    /^worker\/src\/xpost\/[^/]+$/,
    /^worker\/src\/(?:db|llm|store-crypto|bounded-read|social-post|coin-name)$/,
    /^packages\/core\/src\/[^/]+$/,
  ];
  for (const f of XPOST_SOURCES) {
    const name = path.basename(f);
    it(`${name} imports only what xpost may import`, () => {
      for (const spec of specifiers(lexFile(f).code)) {
        const target = resolved(f, spec);
        if (target === null) {
          assert.match(spec, /^node:/, `${name} imports the package ${spec} — xpost imports no packages (package-lock.json is hash-pinned)`);
          continue;
        }
        assert.ok(MAY_IMPORT.some((re) => re.test(target)), `${name} imports ${spec} (${target}), which is not on xpost's allowlist`);
      }
    });
  }

  it("only writer.ts reaches the model client", () => {
    // ONE DOOR TO THE MODEL: the own-key rule and the time box live there.
    const importers = XPOST_SOURCES.filter((f) => specifiers(lexFile(f).code).some((s) => resolved(f, s) === "worker/src/llm")).map((f) => path.basename(f));
    assert.deepEqual(importers, ["writer.ts"]);
  });

  it("only client.ts reads the process environment", () => {
    // Everything else is handed what it needs: the DEK, the app, the knobs.
    const readers = XPOST_SOURCES.filter((f) => /\bprocess\.env\b/.test(lexFile(f).code)).map((f) => path.basename(f));
    assert.deepEqual(readers, ["client.ts"]);
  });

  for (const f of XPOST_SOURCES) {
    const name = path.basename(f);
    it(`${name} writes only xpost_* tables, and no file at all`, () => {
      const { code, strings } = lexFile(f);
      const { writes, creates } = sqlTargets(strings.join("\n"));
      for (const table of writes) assert.match(table, /^xpost_/, `${name} writes ${table} — xpost writes only xpost_* tables`);
      for (const table of creates) assert.match(table, /^xpost_/, `${name} creates ${table}`);
      assert.doesNotMatch(code, /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|renameSync|createWriteStream|mkdirSync|rmSync|unlinkSync)\b/, `${name} touches a file`);
    });
  }
});

describe("nothing that trades knows X exists", () => {
  const outside = () =>
    walk(WORKER_SRC, (f) => f.endsWith(".ts")).filter((f) => !f.startsWith(HERE + path.sep) && !/^orchestrator[^/\\]*\.ts$/.test(path.basename(f)));

  it("the walk reaches the trading paths", () => {
    const files = outside();
    for (const must of ["brain-material.ts", "peer-theses.ts", "index.ts", "social-post.ts", "store.ts", "settings.ts"]) {
      assert.ok(files.some((f) => path.basename(f) === must), `${must} was not found — the walk is looking in the wrong place`);
    }
    assert.ok(files.length > 100, `only ${files.length} worker files found`);
  });

  it("only xpost/ and the orchestrator import xpost/", () => {
    const strangers = outside()
      .filter((f) => specifiers(lexFile(f).code).some((s) => resolved(f, s)?.startsWith("worker/src/xpost/")))
      .map(rel);
    assert.deepEqual(strangers, [], "a worker module outside the orchestrator imports xpost/");
  });

  it("no other worker module names an xpost_* table in code", () => {
    const readers = outside()
      .filter((f) => /\bxpost_[a-z]/.test(lexFile(f).code))
      .map(rel);
    assert.deepEqual(readers, [], "X state must never be read on a trading path");
  });

  /**
   * THE WEB'S SIDE OF TRADING, the same paths the room's boundary test holds
   * (webTradingFiles there): the agent chat that can propose orders, the
   * orders route, and the MCP server and its routes, which put tools that
   * act in an assistant's hands. The web DOES import xpost — the X connect
   * and account routes, through lib/x-connect.ts — so "the worker never
   * imports it" is not enough on its own; none of these may reach it.
   */
  function webTradingFiles(): string[] {
    const lib = path.join(REPO, "web", "src", "lib");
    const api = path.join(REPO, "web", "src", "app", "api");
    const ts = (f: string) => /\.tsx?$/.test(f);
    const libFiles = readdirSync(lib)
      .filter((f) => ts(f) && (f === "agent-chat.ts" || f.startsWith("chat-")))
      .map((f) => path.join(lib, f));
    const routes = ["chat", "orders", "mcp"].flatMap((d) => walk(path.join(api, d), ts));
    return [...libFiles, ...routes, ...walk(path.join(REPO, "web", "src", "mcp"), ts)];
  }

  it("the web walk reaches the agent chat, the orders route and MCP", () => {
    const files = webTradingFiles().map(rel);
    for (const must of ["web/src/lib/agent-chat.ts", "web/src/lib/chat-commands.ts", "web/src/mcp/server.ts"]) {
      assert.ok(files.includes(must), `${must} was not found — the walk is looking in the wrong place`);
    }
    for (const dir of ["web/src/app/api/chat/", "web/src/app/api/orders/", "web/src/app/api/mcp/", "web/src/mcp/tools/"]) {
      assert.ok(files.some((f) => f.startsWith(dir)), `nothing under ${dir} was found`);
    }
  });

  it("the web's agent chat, orders and MCP never import xpost/ or the X connect glue, nor name an xpost_* table", () => {
    const guilty = webTradingFiles()
      .filter((f) => {
        const { code } = lexFile(f);
        if (/\bxpost_[a-z]/.test(code)) return true;
        return specifiers(code).some((s) => /(?:^|\/)x-connect(?:\.tsx?)?$/.test(s) || resolved(f, s)?.startsWith("worker/src/xpost/"));
      })
      .map(rel);
    assert.deepEqual(guilty, [], "a web path that can act for an owner knows X posting exists");
  });

  it("the web check would catch the edge it is for", () => {
    // Run on a fake agent-chat.ts, so a regex that no longer matches is a failure, not silence.
    const f = path.join(REPO, "web", "src", "lib", "agent-chat.ts");
    const imp = "import { getAccount } fr" + 'om "../../../worker/src/xpost/store";\n';
    assert.ok(specifiers(lex(imp).code).some((s) => resolved(f, s)?.startsWith("worker/src/xpost/")));
    const glue = "import { xConnect } fr" + 'om "./x-connect";\n';
    assert.ok(specifiers(lex(glue).code).some((s) => /(?:^|\/)x-connect(?:\.tsx?)?$/.test(s)));
  });
});

describe("the X client secret is read in exactly one file", () => {
  const SECRET = "MERRYMEN_X_CLIENT_SECRET";
  /**
   * A READ: `env.X` or `process.env.X` (not an assignment to it), `env["X"]`,
   * or `{ X } = env`. A string that merely lists the name — the strip list, a
   * boot line — is not a read. Production files only: a test may set it.
   */
  function reads(code: string): boolean {
    return (
      new RegExp(`\\.\\s*${SECRET}\\b(?!\\s*=[^=])`).test(code) ||
      new RegExp(`\\[\\s*["'\`]${SECRET}["'\`]\\s*\\]`).test(code) ||
      new RegExp(`\\{[^{}]*\\b${SECRET}\\b[^{}]*\\}\\s*=\\s*(?:process\\.)?env\\b`).test(code)
    );
  }

  it("the detector tells reading from listing", () => {
    assert.ok(reads(lex(`const s = env.${SECRET}?.trim();`).code));
    assert.ok(reads(lex(`const s = process.env["${SECRET}"];`).code));
    assert.ok(reads(lex(`const { ${SECRET}: s } = process.env;`).code));
    assert.ok(!reads(lex(`const STRIP = ["${SECRET}", "OTHER"];`).code));
    assert.ok(!reads(lex(`// env.${SECRET} is read elsewhere\nlog("${SECRET} is not set");`).code));
    assert.ok(!reads(lex(`process.env.${SECRET} = "test";`).code));
  });

  it("worker/src/xpost/client.ts, and nowhere else in the worker or the web", () => {
    const files = [
      ...walk(WORKER_SRC, (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)),
      ...walk(path.join(REPO, "web", "src"), (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)),
    ];
    assert.ok(files.some((f) => rel(f) === "worker/src/orchestrator.ts"), "the walk reaches the orchestrator");
    const readers = files.filter((f) => reads(lexFile(f).code)).map(rel);
    assert.deepEqual(readers, ["worker/src/xpost/client.ts"]);
  });

  it("the orchestrator lists it for the child strip, which is not a read", () => {
    const { code, strings } = lexFile(path.join(WORKER_SRC, "orchestrator.ts"));
    assert.ok(strings.includes(SECRET), "CHILD_SECRET_STRIP names it");
    assert.ok(!reads(code));
  });
});
