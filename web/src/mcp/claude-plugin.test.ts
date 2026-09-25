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
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ALL_TOOLS } from "./tools";
import { PLUGIN_ID, PLUGIN_MARKETPLACE_URL, PLUGIN_SERVER_URL, claudeCodePluginCommands } from "./install-links";

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
  assert.equal(PLUGIN_MARKETPLACE_URL, "https://github.com/millw14/merrymen.git");
  assert.deepEqual(claudeCodePluginCommands(PLUGIN_SERVER_URL), ["/plugin marketplace add https://github.com/millw14/merrymen.git", "/plugin install merrymen@merrymen"]);
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

/** Every property name anywhere in a zod schema (objects, arrays, optionals, unions). */
function schemaKeys(schema: unknown, into = new Set<string>(), depth = 0): Set<string> {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } } | undefined)?._zod?.def;
  if (!def || depth > 16) return into;
  if (def.type === "object") {
    for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) { into.add(key); schemaKeys(value, into, depth + 1); }
  } else if (def.type === "array") schemaKeys(def.element, into, depth + 1);
  else if (def.type === "union") for (const option of def.options as unknown[]) schemaKeys(option, into, depth + 1);
  else if (def.type === "pipe") { schemaKeys(def.in, into, depth + 1); schemaKeys(def.out, into, depth + 1); }
  else if ("innerType" in def) schemaKeys(def.innerType, into, depth + 1);
  return into;
}

test("every skill has a name matching its folder and a description, and names only real tools and their real fields", () => {
  const tools = new Map(ALL_TOOLS.map((t) => [t.name, t]));
  assert.deepEqual(skills, ["connect", "portfolio", "status", "token", "week", "why"]);
  for (const skill of skills) {
    const text = read(`${PLUGIN}skills/${skill}/SKILL.md`).replace(/\r\n/g, "\n");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, `${skill}: frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${skill}$`, "m"), skill);
    const description = /^description: (.+)$/m.exec(front[1])?.[1] ?? "";
    assert.ok(description.length > 40 && description.length <= 1536, `${skill}: description`);
    const named = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(([, name]) => name);
    // A field is checked against the schemas of the tools this skill uses, so
    // renaming `window_hours` or `confirmed_count` fails here, not in a session.
    const fields = new Set<string>();
    for (const name of named) { const t = tools.get(name); if (t) { schemaKeys(t.input, fields); schemaKeys(t.output, fields); } }
    for (const name of named) {
      assert.ok(tools.has(name) || fields.has(name), `${skill} names \`${name}\`, which is neither a Merrymen tool nor a field of one it uses`);
    }
    for (const [, other] of text.matchAll(/\/merrymen:([a-z-]+)/g)) {
      assert.ok(skills.includes(other), `${skill} points at /merrymen:${other}, which does not exist`);
    }
  }
  // get_summary defaults to one day; a week-in-review must ask for the week.
  assert.match(read(`${PLUGIN}skills/week/SKILL.md`), /`get_summary` with period "week"/);
});

/**
 * Claude Code caches an installed plugin by its manifest `version` and only
 * delivers a change when the version moves: a skill fixed in this repo (after
 * a tool rename, say) or a new server address never reaches anyone who
 * installed it before, however many times they update. So the content users
 * run is fingerprinted here, and changing it fails until `version` is bumped.
 * (The README is left out: Claude Code does not show it.)
 */
const PLUGIN_RELEASE = { version: "1.0.0", sha256: "b4a1878e41238aa5dae85755a97aa2a08ffae2e680b8bc7f813b3a4765bf3039" };

function pluginFingerprint(): string {
  const files: string[] = [".mcp.json"];
  for (const skill of skills) files.push(`skills/${skill}/SKILL.md`);
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(`${file}\0${read(`${PLUGIN}${file}`).replace(/\r\n/g, "\n")}\0`);
  return hash.digest("hex");
}

test("changing what the plugin runs needs a version bump, or installed copies never update", () => {
  const manifest = json(`${PLUGIN}.claude-plugin/plugin.json`);
  const now = { version: manifest.version, sha256: pluginFingerprint() };
  assert.deepEqual(now, PLUGIN_RELEASE,
    "plugins/merrymen changed: bump `version` in plugins/merrymen/.claude-plugin/plugin.json and set PLUGIN_RELEASE here to the new version and this sha256");
  const skillFiles = readdirSync(new URL(`${PLUGIN}skills/`, root), { recursive: true }).map(String).filter((f) => !f.endsWith("SKILL.md") && /\.[a-z]+$/i.test(f));
  assert.deepEqual(skillFiles, [], "a new kind of file in skills/ must be added to the fingerprint");
});

test("the plugin's README lists every command", () => {
  const readme = read(`${PLUGIN}README.md`);
  for (const skill of skills) assert.ok(readme.includes(`/merrymen:${skill}`), skill);
  assert.ok(readme.includes("/plugin marketplace add https://github.com/millw14/merrymen.git") && readme.includes("/plugin install merrymen@merrymen"));
});
