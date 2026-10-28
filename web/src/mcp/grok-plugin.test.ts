/** Package checks against the real MCP contract; these do not certify a host install. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_SERVER_URL } from "./install-links";
import { SCOPES, scopeFor } from "./scopes";
import { ALL_TOOLS } from "./tools";
import { SETUP_DRAFT_DEFAULTS } from "./instructions";

const root = new URL("../../../plugins/merrymen-grok/", import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, root), "utf8");
const skills = ["merrymen-monitor", "merrymen-setup"];

test("the Grok package is declarative and targets the production MCP endpoint without credentials", () => {
  const manifest = JSON.parse(read(".cursor-plugin/plugin.json"));
  assert.equal(manifest.name, "merrymen-grok");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description && manifest.author?.name);
  // Reject new execution/configuration surfaces unless their packaging is reviewed.
  assert.deepEqual(Object.keys(manifest).sort(), ["author", "description", "homepage", "keywords", "license", "logo", "name", "repository", "version"]);
  assert.deepEqual(JSON.parse(read("mcp.json")), {
    mcpServers: { merrymen: { url: PLUGIN_SERVER_URL } },
  });
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const parent = entry.parentPath ?? entry.path;
      return relative(fileURLToPath(root), join(parent, entry.name)).replaceAll("\\", "/");
    }).sort();
  assert.deepEqual(files, [
    ".cursor-plugin/plugin.json", "README.md", "assets/logo.png", "mcp.json",
    ...skills.map(skill => `skills/${skill}/SKILL.md`),
  ].sort(), "package contains only the reviewed manifest, logo, remote config, README and skills");
});

test("the plugin logo resolves within the package and matches the current public MCP icon", () => {
  const manifest = JSON.parse(read(".cursor-plugin/plugin.json"));
  assert.equal(manifest.logo, "assets/logo.png");
  const logo = readFileSync(new URL(manifest.logo, root));
  const publicIcon = readFileSync(new URL("../../public/mcp-icon-512.png", import.meta.url));
  assert.deepEqual(logo, publicIcon, "refresh the packaged logo when the public MCP icon changes");
  assert.deepEqual(logo.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(logo.readUInt32BE(16), 512, "logo width");
  assert.equal(logo.readUInt32BE(20), 512, "logo height");
});

test("packaged skills resolve to current Merrymen tools", () => {
  const tools = new Set(ALL_TOOLS.map(tool => tool.name));
  assert.deepEqual(readdirSync(new URL("skills/", root)).sort(), skills);
  for (const skill of skills) {
    const text = read(`skills/${skill}/SKILL.md`);
    const frontmatter = /^---\nname: ([a-z-]+)\ndescription: ([^\n]+)\n---\n/.exec(text);
    assert.equal(frontmatter?.[1], skill);
    assert.ok(frontmatter?.[2]);
    for (const [, name] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      assert.ok(tools.has(name), `${skill} references missing tool ${name}`);
    }
  }
});

test("the setup skill and host instructions carry the same supported draft template", () => {
  const text = read("skills/merrymen-setup/SKILL.md");
  const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  assert.ok(block, "setup must disclose its starter configuration");
  const defaults = JSON.parse(block);
  assert.deepEqual(defaults, SETUP_DRAFT_DEFAULTS);
  const tool = ALL_TOOLS.find(tool => tool.name === "create_merryman");
  assert.ok(tool);
  const input = { ...defaults, idempotency_key: "grok-setup-contract-test" };
  assert.deepEqual(tool.input.parse(input), input);
  assert.equal(tool.capability, "drafts.write");
  for (const unsupported of ["mode", "liveTradingEnabled", "wallet", "max_per_trade_usdg"]) {
    assert.equal(tool.input.safeParse({ ...input, [unsupported]: "paper" }).success, false,
      `${unsupported} must remain outside the setup proposal contract`);
  }
});

test("the monitoring workflow only allows existing read-only tools reachable by its read scopes", () => {
  const text = read("skills/merrymen-monitor/SKILL.md");
  const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  assert.ok(block, "monitoring workflow must declare its tool/scope allowlist");
  const policy = JSON.parse(block) as { scopes: string[]; tools: string[] };
  assert.deepEqual(Object.keys(policy).sort(), ["scopes", "tools"]);
  assert.deepEqual(policy.scopes, ["agents:read", "portfolio:read", "decisions:read"]);
  assert.ok(policy.tools.length > 0);
  assert.equal(new Set(policy.tools).size, policy.tools.length);
  const tools = new Map(ALL_TOOLS.map(tool => [tool.name, tool]));
  for (const scope of policy.scopes) {
    assert.equal(SCOPES.find(entry => entry.id === scope)?.level, "read", scope);
  }
  for (const name of policy.tools) {
    const tool = tools.get(name);
    assert.ok(tool, `monitoring references missing tool ${name}`);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} must not write`);
    assert.notEqual(tool.annotations.destructiveHint, true, name);
    assert.ok((tool.anyOf ?? [tool.capability]).some(capability => policy.scopes.includes(scopeFor(capability))),
      `${name} requires access outside the monitoring scope allowlist`);
  }
  for (const [, name] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
    assert.ok(policy.tools.includes(name), `monitoring prose directs a call outside its allowlist: ${name}`);
  }
});
