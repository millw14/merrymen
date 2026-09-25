/**
 * Guards over the whole MCP catalogue, so a new tool cannot quietly skip a
 * rule: one scope per capability, the staff scope never advertised, every
 * tool named, described, schema'd and annotated consistently with what its
 * capability can do, and nothing that could move funds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ADVERTISED_SCOPES, SCOPES, scopeFor, type Capability } from "./scopes";
import { ALL_TOOLS } from "./tools";
import { ALL_RESOURCES } from "./resources-catalog";
import { ERROR_CODES } from "./errors";

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

test("the docs name every tool and every error code", () => {
  const docs = path.join(process.cwd(), "docs", "mcp");
  const tools = readFileSync(path.join(docs, "tools.md"), "utf8");
  for (const t of ALL_TOOLS) assert.ok(tools.includes(`\`${t.name}\``), `docs/mcp/tools.md is missing ${t.name}`);
  const errors = readFileSync(path.join(docs, "errors.md"), "utf8");
  for (const code of Object.keys(ERROR_CODES)) assert.ok(errors.includes(`\`${code}\``), `docs/mcp/errors.md is missing ${code}`);
});
