/**
 * The Claude Code plugin (plugins/merrymen) and the marketplace that lists it
 * (.claude-plugin/marketplace.json). Nothing in the app imports these files,
 * so without this test a renamed tool or a moved endpoint would leave every
 * installed plugin pointing at something that no longer exists.
 *
 * `claude plugin validate --strict` is the authoritative schema check; run it
 * locally against both directories when changing them (CI has no Claude Code).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ALL_TOOLS } from "./tools";
import { PLUGIN_ID, PLUGIN_MARKETPLACE_REPO, PLUGIN_SERVER_URL, claudeCodePluginCommands } from "./install-links";

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;
const PLUGIN = "plugins/merrymen/";
const skills = readdirSync(new URL(`${PLUGIN}skills/`, root), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

test("the marketplace lists the plugin from its own directory, under the id the connect page tells people to install", () => {
  const market = json(".claude-plugin/marketplace.json");
  const entries = market.plugins as Array<{ name: string; source: string }>;
  assert.equal(entries.length, 1);
  assert.equal(`${entries[0].name}@${market.name}`, PLUGIN_ID);
  assert.equal(entries[0].source, "./plugins/merrymen");
  assert.ok(existsSync(new URL(`${PLUGIN}.claude-plugin/plugin.json`, root)));
  assert.equal(PLUGIN_MARKETPLACE_REPO, "millw14/merrymen");
  assert.deepEqual(claudeCodePluginCommands(PLUGIN_SERVER_URL), ["/plugin marketplace add millw14/merrymen", "/plugin install merrymen@merrymen"]);
});

test("the plugin's server is the production endpoint, the same address the connect page falls back to", () => {
  const manifest = json(`${PLUGIN}.claude-plugin/plugin.json`);
  assert.equal(manifest.name, "merrymen");
  assert.ok(typeof manifest.version === "string" && typeof manifest.description === "string");
  assert.ok((manifest.author as { name?: string }).name);
  const servers = (json(`${PLUGIN}.mcp.json`).mcpServers ?? {}) as Record<string, { type: string; url: string }>;
  assert.deepEqual(Object.keys(servers), ["merrymen"]);
  assert.deepEqual(servers.merrymen, { type: "http", url: PLUGIN_SERVER_URL });
  assert.match(read("web/src/app/connect/mcp/page.tsx"), new RegExp(`"${PLUGIN_SERVER_URL.replace(/[./]/g, "\\$&")}"`));
  // A staging or self-hosted page must not hand out a plugin that points at production.
  assert.equal(claudeCodePluginCommands("https://mcp.staging.example/mcp"), null);
});

test("every skill has a name matching its folder and a description, and names only tools that exist", () => {
  const tools = new Set(ALL_TOOLS.map((t) => t.name));
  assert.deepEqual(skills, ["connect", "portfolio", "status", "token", "week", "why"]);
  for (const skill of skills) {
    const text = read(`${PLUGIN}skills/${skill}/SKILL.md`);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
    assert.ok(front, `${skill}: frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${skill}$`, "m"), skill);
    const description = /^description: (.+)$/m.exec(front[1])?.[1] ?? "";
    assert.ok(description.length > 40 && description.length <= 1536, `${skill}: description`);
    for (const [, name] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      assert.ok(tools.has(name), `${skill} names \`${name}\`, which is not a Merrymen tool`);
    }
    for (const [, other] of text.matchAll(/\/merrymen:([a-z-]+)/g)) {
      assert.ok(skills.includes(other), `${skill} points at /merrymen:${other}, which does not exist`);
    }
  }
});

test("the plugin's README lists every command", () => {
  const readme = read(`${PLUGIN}README.md`);
  for (const skill of skills) assert.ok(readme.includes(`/merrymen:${skill}`), skill);
  assert.ok(readme.includes("/plugin marketplace add millw14/merrymen") && readme.includes("/plugin install merrymen@merrymen"));
});
