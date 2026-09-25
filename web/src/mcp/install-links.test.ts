/**
 * The install links are pinned byte for byte. Each one is a format some other
 * company parses, a wrong byte fails silently on their side (an empty dialog, a
 * server with no address), and nothing in our own stack would notice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTOR_NAME, SERVER_KEY, installCommands, installLinks } from "./install-links";

const URL_ = "https://mcp.merrymen.dev/mcp";
/** base64('{"url":"https://mcp.merrymen.dev/mcp"}'), percent-encoded. */
const B64_CONFIG = "eyJ1cmwiOiJodHRwczovL21jcC5tZXJyeW1lbi5kZXYvbWNwIn0%3D";

test("the names an assistant stores and shows", () => {
  assert.equal(CONNECTOR_NAME, "Merrymen");
  assert.equal(SERVER_KEY, "merrymen");
});

test("every install link for the production address, exactly", () => {
  const l = installLinks(URL_);
  // Opened live on 2026-09-25: claude.ai's Add custom connector dialog, pre-filled.
  assert.equal(l.claude, "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Merrymen&connectorUrl=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp");
  assert.equal(l.claudeOrg, "https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Merrymen&connectorUrl=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp");
  assert.equal(l.cursor, `https://cursor.com/en/install-mcp?name=merrymen&config=${B64_CONFIG}`);
  assert.equal(l.vscode, "https://vscode.dev/redirect/mcp/install?name=merrymen&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.merrymen.dev%2Fmcp%22%7D");
  assert.equal(l.vscodeInsiders, "https://vscode.dev/redirect/mcp/install?name=merrymen&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.merrymen.dev%2Fmcp%22%7D&quality=insiders");
  assert.equal(l.kiro, "https://kiro.dev/launch/mcp/add?name=merrymen&config=%7B%22url%22%3A%22https%3A%2F%2Fmcp.merrymen.dev%2Fmcp%22%7D");
  assert.equal(l.lmstudio, `lmstudio://add_mcp?name=merrymen&config=${B64_CONFIG}`);
  assert.equal(l.goose, "goose://extension?url=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp&type=streamable_http&id=merrymen&name=Merrymen&description=Your%20Merrymen%20trading%20agent&timeout=300");
  assert.equal(l.chatgpt, "https://chatgpt.com/plugins");
});

test("the base64 configs decode to the address and nothing else", () => {
  const l = installLinks(URL_);
  for (const link of [l.cursor, l.lmstudio]) {
    const config = new URL(link).searchParams.get("config")!;
    assert.deepEqual(JSON.parse(atob(config)), { url: URL_ });
  }
});

test("every command for the production address, exactly", () => {
  assert.deepEqual(installCommands(URL_), {
    claudeCode: ["claude mcp add --transport http --scope user merrymen https://mcp.merrymen.dev/mcp", "claude mcp login merrymen"],
    codex: ["codex mcp add merrymen --url https://mcp.merrymen.dev/mcp"],
    gemini: ["gemini mcp add -s user -t http merrymen https://mcp.merrymen.dev/mcp"],
    devin: ["devin mcp add -s user merrymen https://mcp.merrymen.dev/mcp", "devin mcp login merrymen"],
  });
});

test("an address with a query, a fragment or odd characters is fully encoded in every link", () => {
  // Nothing in it may leak into the outer URL as a separator: a raw & would
  // start a new parameter and a raw # would cut the link short.
  const odd = "https://mcp.example.test/mcp?tenant=a&b=c d#frag'\"<>漢";
  const l = installLinks(odd);
  const expectedKeys: Record<keyof typeof l, string[]> = {
    claude: ["modal", "connectorName", "connectorUrl"],
    claudeOrg: ["modal", "connectorName", "connectorUrl"],
    cursor: ["name", "config"],
    vscode: ["name", "config"],
    vscodeInsiders: ["name", "config", "quality"],
    kiro: ["name", "config"],
    lmstudio: ["name", "config"],
    goose: ["url", "type", "id", "name", "description", "timeout"],
    chatgpt: [],
  };
  for (const [key, link] of Object.entries(l) as Array<[keyof typeof l, string]>) {
    assert.ok(!link.includes("#"), `${key}: no raw #`);
    // (encodeURIComponent leaves ' as it is; a URL may carry it.)
    assert.ok(!/[\s"<>]/.test(link), `${key}: no raw space, double quote or angle bracket`);
    assert.ok(/^[\x21-\x7e]+$/.test(link), `${key}: ASCII only`);
    const parsed = new URL(link);
    assert.deepEqual([...parsed.searchParams.keys()], expectedKeys[key], `${key}: the address added no parameter`);
    const p = parsed.searchParams;
    if (key === "claude" || key === "claudeOrg") assert.equal(p.get("connectorUrl"), odd);
    if (key === "goose") assert.equal(p.get("url"), odd);
    if (key === "vscode" || key === "vscodeInsiders") assert.deepEqual(JSON.parse(p.get("config")!), { type: "http", url: odd });
    if (key === "kiro") assert.deepEqual(JSON.parse(p.get("config")!), { url: odd });
    if (key === "cursor" || key === "lmstudio") {
      const bytes = Uint8Array.from(atob(p.get("config")!), (c) => c.charCodeAt(0));
      assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), { url: odd });
    }
  }
});

test("a command quotes an address a shell would act on, and leaves a plain one bare", () => {
  const odd = "https://mcp.example.test/mcp?a=1&b=it's";
  const c = installCommands(odd);
  assert.equal(c.codex[0], `codex mcp add merrymen --url 'https://mcp.example.test/mcp?a=1&b=it'\\''s'`);
  assert.equal(c.claudeCode[0], `claude mcp add --transport http --scope user merrymen 'https://mcp.example.test/mcp?a=1&b=it'\\''s'`);
  assert.equal(installCommands("http://localhost:3000/mcp").codex[0], "codex mcp add merrymen --url http://localhost:3000/mcp");
});
