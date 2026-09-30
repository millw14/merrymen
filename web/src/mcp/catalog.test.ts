/**
 * Guards over the whole MCP catalogue, so a new tool cannot quietly skip a
 * rule: one scope per capability, the staff scope never advertised, every
 * tool named, described, schema'd and annotated consistently with what its
 * capability can do, and nothing that could move funds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as z from "zod";
import { ADVERTISED_SCOPES, SCOPES, scopeFor, type Capability, type McpProfile } from "./scopes";
import { ALL_TOOLS } from "./tools";
import { ALL_RESOURCES } from "./resources-catalog";
import { ERROR_CODES } from "./errors";
import { resourceInProfile, toolInProfile } from "./server";
import { withToolRefs, type ToolDef } from "./tool";
import { MODEL_INSTRUCTION, OTHER_TOOLS, schemaDescriptions, toolNamePattern } from "./testing";

const CAPABILITIES: Capability[] = [
  "market.read", "agents.read", "portfolio.read", "decisions.read", "chat.send", "research.submit", "watchlist.manage",
  "notifications.manage", "drafts.write", "trade.propose", "jobs.run", "social.write", "reports.read", "staff.diagnostics",
];

/** Capabilities whose tools only read. A tool using one of these must be read-only. */
const READ_ONLY_CAPABILITIES = new Set<Capability>(["market.read", "agents.read", "portfolio.read", "decisions.read", "staff.diagnostics"]);

test("every capability is granted by exactly one scope", () => {
  for (const c of CAPABILITIES) {
    const owners = SCOPES.filter((s) => s.capabilities.includes(c));
    assert.equal(owners.length, 1, c);
    assert.equal(scopeFor(c), owners[0]!.id);
  }
});

test("the staff scope is never advertised and never ticked by default", () => {
  assert.ok(!ADVERTISED_SCOPES.includes("staff:diagnostics"));
  assert.equal(SCOPES.find((s) => s.id === "staff:diagnostics")?.defaultOn, false);
  for (const s of SCOPES.filter((x) => x.level === "sensitive")) assert.equal(s.defaultOn, false, s.id);
});

test("every tool is well-formed and annotated consistently with its capability", () => {
  const names = new Set<string>();
  for (const t of ALL_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{2,63}$/, t.name);
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
    assert.ok(t.title.length > 2 && t.description.length > 20, t.name);
    assert.ok(CAPABILITIES.includes(t.capability), t.name);
    assert.ok(t.input && t.output, `${t.name} declares input and output schemas`);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    assert.equal(typeof t.annotations.openWorldHint, "boolean", t.name);
    if (READ_ONLY_CAPABILITIES.has(t.capability) && !t.anyOf) {
      assert.equal(t.annotations.readOnlyHint, true, `${t.name} uses a read capability and must be read-only`);
    }
    if (!t.annotations.readOnlyHint) assert.equal(typeof t.annotations.destructiveHint, "boolean", `${t.name} writes, so it must say whether it is destructive`);
    if (t.name.startsWith("staff_")) assert.equal(t.capability, "staff.diagnostics", t.name);
    if (t.capability === "staff.diagnostics") assert.ok(t.name.startsWith("staff_"), `${t.name}: staff tools are named staff_*`);
  }
});

/**
 * A tool that withdraws, stops or removes something the owner cannot get
 * back as it was is destructive, so a client asks before calling it. By name,
 * so a new cancel_* or remove_* tool cannot ship marked harmless.
 */
test("every tool that cancels, removes, unfollows or unsubscribes is marked destructive", () => {
  const undoing = /^(cancel|remove|delete|unfollow|unsubscribe)(_|$)/;
  const found = ALL_TOOLS.filter((t) => undoing.test(t.name)).map((t) => t.name);
  for (const name of ["cancel_proposal", "cancel_job", "remove_from_watchlist", "unfollow_agent", "unsubscribe"]) assert.ok(found.includes(name), `${name} is in the catalogue`);
  for (const t of ALL_TOOLS.filter((x) => undoing.test(x.name))) {
    assert.equal(t.annotations.readOnlyHint, false, t.name);
    assert.equal(t.annotations.destructiveHint, true, `${t.name} undoes something, so it must be marked destructive`);
  }
});

test("no tool can transfer funds, sign, or send arbitrary calls", () => {
  const forbidden = /\b(transfer|withdraw|sign_|send_transaction|execute|calldata|approve_token|sweep|set_live|enable_live|kill)\b/;
  for (const t of ALL_TOOLS) assert.doesNotMatch(t.name, forbidden, t.name);
});

test("resources have unique names and merrymen:// or ui:// URIs", () => {
  const names = new Set<string>();
  for (const r of ALL_RESOURCES) {
    assert.ok(!names.has(r.name), r.name);
    names.add(r.name);
    assert.match(r.uri, /^(merrymen|ui):\/\//, r.name);
  }
});

/**
 * A character that must never appear literally in source, by Unicode category
 * rather than by a list (a list missed U+0085, U+009B, U+061C and U+2028/2029,
 * all of which editing tools have written into this tree): every control
 * character (Cc) except tab, line feed and carriage return; every format
 * character (Cf: bidi marks, embeddings, overrides and isolates, zero-width
 * characters, BOM, soft hyphen, the Arabic letter mark); and the line and
 * paragraph separators (Zl, Zp). Written as property classes so this file
 * cannot itself carry one.
 */
const HIDDEN = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Where each hidden character is, as `line:column U+XXXX`. */
function hiddenCharacters(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HIDDEN)) {
    const at = m.index ?? 0;
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    const column = at - before.lastIndexOf("\n");
    out.push(`${line}:${column} U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return out;
}

test("the hidden-character guard catches every control, format and separator character, and nothing a source file needs", () => {
  const C = (...cps: number[]) => String.fromCodePoint(...cps);
  const caught = [0x0, 0x7, 0x1b, 0x7f, 0x85, 0x9b, 0xad, 0x61c, 0x180e, 0x200b, 0x200d, 0x200e, 0x202e, 0x2028, 0x2029, 0x2060, 0x2066, 0x2069, 0xfeff, 0xfff9, 0xe0001];
  for (const cp of caught) assert.equal(hiddenCharacters(`a${C(cp)}b`).length, 1, `U+${cp.toString(16)}`);
  assert.deepEqual(hiddenCharacters(`x\ny${C(0x2028)}`), ["2:2 U+2028"]);
  // Tabs, newlines, CRLF endings and ordinary non-ASCII text are fine.
  assert.deepEqual(hiddenCharacters(`\tif (a) {\r\n  b; // \u00b7 \u2014 \u201cquoted\u201d \u2026 \u22121 \u2713 ${C(0xa0)} \u00e9 \u65e5\u672c ${C(0x1f600)}\n}`), []);
});

test("no invisible, bidirectional, control or separator characters hide in the MCP source (write them as \\u escapes)", () => {
  const roots = [
    "web/src/mcp", "web/src/lib/services", "web/src/app/mcp", "web/src/app/api/mcp", "web/src/app/connect", "web/src/app/oauth",
    "web/src/app/.well-known", "worker/src/mcp",
  ];
  const walk = (d: string): string[] => {
    try {
      return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    } catch {
      return [];
    }
  };
  const source = (f: string) => /\.(ts|tsx|js|jsx|mjs|cjs|css|json)$/.test(f);
  // Every root must exist and hold source: a moved or misspelled root would
  // otherwise be skipped silently and the guard would stay green over nothing.
  for (const r of roots) assert.ok(walk(path.join(process.cwd(), r)).some(source), `${r} holds no source files (run from the repository root)`);
  const files = roots.flatMap((r) => walk(path.join(process.cwd(), r))).filter(source);
  assert.ok(files.some((f) => f.endsWith(path.join("worker", "src", "mcp", "notify.ts"))), "the roots resolve (run from the repository root)");
  const offenders = files.flatMap((f) => hiddenCharacters(readFileSync(f, "utf8")).map((at) => `${path.relative(process.cwd(), f)}:${at}`));
  assert.deepEqual(offenders, []);
});

test("the docs name every tool and every error code", () => {
  const docs = path.join(process.cwd(), "docs", "mcp");
  const tools = readFileSync(path.join(docs, "tools.md"), "utf8");
  for (const t of ALL_TOOLS) assert.ok(tools.includes(`\`${t.name}\``), `docs/mcp/tools.md is missing ${t.name}`);
  const errors = readFileSync(path.join(docs, "errors.md"), "utf8");
  for (const code of Object.keys(ERROR_CODES)) assert.ok(errors.includes(`\`${code}\``), `docs/mcp/errors.md is missing ${code}`);
});

// ── the directory profile's tool text ───────────────────────────────────────
// Anthropic's connector directory asks that tool descriptions carry no
// instructions about model behaviour or other tools. The directory profile
// (/mcp/directory) serves each tool's directoryDescription (withToolRefs); the
// full server keeps its pointers to the next tool.

const TOOL_NAME = toolNamePattern(ALL_TOOLS.map((t) => t.name));

/** What a client reads about a tool on a profile: its description, then every field description of its input and output. */
function servedTexts(t: ToolDef, profile: McpProfile): string[] {
  const own = profile === "directory" ? t.directoryDescription ?? t.description : t.description;
  return [
    own,
    ...schemaDescriptions(z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" })),
    ...schemaDescriptions(z.toJSONSchema(t.output, { io: "output", unrepresentable: "any" })),
  ];
}

const otherToolsIn = (self: string, text: string) => [...text.matchAll(TOOL_NAME)].map((m) => m[1]).filter((n) => n !== self);

/** Why a text may not be served on the directory profile, or null when it may. */
function directoryOffence(self: string, text: string): string | null {
  const others = otherToolsIn(self, text);
  if (others.length) return `names ${others.join(", ")}`;
  if (OTHER_TOOLS.test(text)) return "points at other tools";
  if (MODEL_INSTRUCTION.test(text)) return "instructs the model";
  return null;
}

test("withToolRefs cuts each ref exactly once, and refuses one that is missing, repeated or empty", () => {
  assert.deepEqual(withToolRefs("Lists them. Use one with get_x.", " Use one with get_x."), { description: "Lists them. Use one with get_x.", directoryDescription: "Lists them.", directoryCuts: [" Use one with get_x."] });
  assert.equal(withToolRefs("A (see a_b) and (see c_d).", " (see a_b)", " (see c_d)").directoryDescription, "A and.");
  assert.throws(() => withToolRefs("No pointer here.", " (see get_x)"), /must occur exactly once/);
  assert.throws(() => withToolRefs("get_x, then get_x.", "get_x"), /must occur exactly once/);
  assert.throws(() => withToolRefs("Anything.", ""), /must occur exactly once/);
});

test("a directory description is exactly the full one with its pointers to other tools cut, and nothing else", () => {
  const cut = ALL_TOOLS.filter((t) => t.directoryDescription !== undefined || t.directoryCuts !== undefined);
  assert.ok(cut.length > 0);
  for (const t of cut) {
    assert.ok(t.directoryCuts?.length && t.directoryDescription !== undefined, `${t.name}: built by hand, not with withToolRefs`);
    // Re-derived from the full description: nothing added, nothing else removed.
    assert.equal(withToolRefs(t.description, ...t.directoryCuts!).directoryDescription, t.directoryDescription, `${t.name}: not the full description with its cuts removed`);
    for (const ref of t.directoryCuts!) {
      assert.ok(otherToolsIn(t.name, ref).length > 0 || OTHER_TOOLS.test(ref), `${t.name}: the cut ${JSON.stringify(ref)} is not a pointer to another tool`);
    }
    const short = t.directoryDescription!;
    assert.equal(short.trim(), short, `${t.name}: a cut left stray whitespace`);
    assert.ok(!/ {2}| [.,;:)]|\( /.test(short), `${t.name}: a cut left stray spacing or punctuation: ${short}`);
  }
});

test("nothing the directory profile serves about a tool points at another tool or tells the model what to do", () => {
  const offenders: string[] = [];
  for (const t of ALL_TOOLS.filter((x) => toolInProfile(x, "directory"))) {
    for (const text of [t.title, ...servedTexts(t, "directory")]) {
      const why = directoryOffence(t.name, text);
      if (why) offenders.push(`${t.name} ${why}: ${text}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("nor does any resource the directory profile lists", () => {
  const offenders: string[] = [];
  for (const r of ALL_RESOURCES.filter((x) => resourceInProfile(x, "directory"))) {
    for (const text of [r.title, r.description]) {
      const why = directoryOffence("", text);
      if (why) offenders.push(`${r.uri} ${why}: ${text}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the full server's descriptions give no model instructions either (their pointers to the next tool stay)", () => {
  const offenders: string[] = [];
  for (const t of ALL_TOOLS) for (const text of servedTexts(t, "full")) if (MODEL_INSTRUCTION.test(text)) offenders.push(`${t.name}: ${text}`);
  assert.deepEqual(offenders, []);
  // The pointers themselves are kept where they help a client choose the next tool.
  assert.match(ALL_TOOLS.find((t) => t.name === "list_agents")!.description, /Use the id as `agent` in other tools/);
});

