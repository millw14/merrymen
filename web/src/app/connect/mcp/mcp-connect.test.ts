/**
 * The connect hub and the ways into it. Rendered to static markup, so what is
 * checked is what an owner's browser receives before any script runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installLinks } from "@/mcp/install-links";
import { McpConnectClient, connectedSummary, lastUsedWords } from "./McpConnectClient";

// See wire-ring.test.ts: tsx compiles `.tsx` against a global React.
(globalThis as unknown as { React: typeof React }).React = React;

const URL_ = "https://mcp.merrymen.dev/mcp";
const APP = "https://app.merrymen.dev";
const render = (enabled: boolean, disabledWhy: string | null = null) =>
  renderToStaticMarkup(createElement(McpConnectClient, { url: URL_, app: APP, enabled, disabledWhy }));
/** A staging or self-hosted server: not the address the plugin points at. */
const renderOther = () => renderToStaticMarkup(createElement(McpConnectClient, { url: "https://mcp.staging.example/mcp", app: "https://app.staging.example", enabled: true, disabledWhy: null }));
/** React escapes & in attributes; compare against what the browser will read. */
const unescape = (html: string) => html.replace(/&amp;/g, "&");
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the primary action is the pre-filled claude.ai link, in a new tab without a referrer or opener", () => {
  const html = unescape(render(true));
  const claude = installLinks(URL_).claude;
  const tag = html.match(new RegExp(`<a class="flow-primary" href="${claude.replace(/[.?]/g, "\\$&")}"[^>]*>`));
  assert.ok(tag, "Add to Claude links to the claude.ai dialog");
  assert.match(tag[0], /target="_blank"/);
  assert.match(tag[0], /rel="noopener noreferrer"/);
  assert.match(html, /Add to Claude/);
  assert.match(html, /Click <b>Continue<\/b>, then <b>Connect<\/b>/);
  assert.match(html, /then click <b>Allow<\/b>/);
});

test("every other assistant's action is on the page, and app links open the app, not a tab", () => {
  const html = unescape(render(true));
  const l = installLinks(URL_);
  for (const link of [l.claudeOrg, l.cursor, l.vscode, l.vscodeInsiders, l.kiro, l.chatgpt]) {
    assert.ok(html.includes(`href="${link}" target="_blank" rel="noopener noreferrer"`), link);
  }
  for (const link of [l.lmstudio, l.goose]) {
    assert.ok(html.includes(`href="${link}"`), link);
    assert.ok(!html.includes(`href="${link}" target=`), `${link} opens the app itself`);
  }
  for (const command of ["codex mcp add merrymen --url https://mcp.merrymen.dev/mcp", "claude mcp add --transport http --scope user merrymen https://mcp.merrymen.dev/mcp\nclaude mcp login merrymen", "gemini mcp add -s user -t http merrymen", "devin mcp login merrymen"]) {
    assert.ok(html.includes(command), command);
  }
  assert.ok(html.includes(`<code id=`) && html.includes(`>${URL_}</code>`), "the server address is shown");
});

test("every control has an accessible name, and every copy announces itself", () => {
  const html = render(true);
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length >= 6);
  for (const b of buttons) assert.match(b, /aria-label="Copy [^"]+"/, b);
  assert.equal((html.match(/role="status" aria-live="polite"/g) ?? []).length, buttons.length, "one live region per Copy");
  for (const a of html.match(/<a [^>]*>[\s\S]*?<\/a>/g) ?? []) {
    const name = a.replace(/<[^>]+>/g, "").trim() || (a.match(/aria-label="([^"]+)"/)?.[1] ?? "");
    assert.ok(name, `a link with no name: ${a}`);
  }
});

test("Claude Code comes first among the others, with the plugin's two commands copied one at a time", () => {
  const html = unescape(render(true));
  const others = html.slice(html.indexOf("Other assistants"));
  assert.ok(others.indexOf("Claude Code") < others.indexOf("ChatGPT"), "Claude Code is the first row");
  for (const line of ["/plugin marketplace add https://github.com/millw14/merrymen.git", "/plugin install merrymen@merrymen"]) {
    assert.ok(html.includes(`<code>${line}</code>`), `${line} in a block of its own`);
  }
  assert.match(html, /aria-label="Copy the first Claude Code command"/);
  assert.match(html, /aria-label="Copy the second Claude Code command"/);
  // Any other server (staging, self-hosted) gets no plugin, which points at production.
  const other = renderOther();
  assert.ok(!other.includes("/plugin install"));
  assert.ok(other.includes("claude mcp add --transport http --scope user merrymen https://mcp.staging.example/mcp"));
});

test("Claude Code: a sentence to just tell it, pointing at the setup text for this server", () => {
  const html = render(true);
  const claudeCode = html.slice(html.indexOf("<h3>Claude Code</h3>"), html.indexOf("<h3>ChatGPT</h3>"));
  assert.ok(claudeCode.includes("Or just tell Claude Code:"));
  assert.ok(claudeCode.includes("<code>Set up the Merrymen MCP server. Instructions: https://merrymen.dev/llms.txt</code>"), "the static copy merrymen.dev serves");
  assert.match(claudeCode, /aria-label="Copy the sentence to tell Claude Code"/);
  // Another server points at its own /llms.txt, never at production's.
  const other = renderOther();
  assert.ok(other.includes("<code>Set up the Merrymen MCP server. Instructions: https://app.staging.example/llms.txt</code>"));
  assert.ok(!other.includes("merrymen.dev/llms.txt"));
});

test("the page ends with small print for AI assistants, and makes no liveness claim it cannot back", () => {
  const html = unescape(render(true));
  // A static "accepting connections" would read as up during an outage; llms.txt names the health check instead.
  assert.ok(!html.includes("Accepting connections"));
  const ai = html.slice(html.indexOf('<section class="mcp-hub-section mcp-hub-ai"'));
  assert.ok(ai.length < html.length && html.indexOf("mcp-hub-ai") > html.indexOf("Good to know"), "the last section of the panel");
  assert.ok(ai.includes(`<h2 id="mcp-hub-ai">For AI assistants</h2>`));
  assert.equal((ai.slice(0, ai.indexOf("</section>")).match(/<li>/g) ?? []).length, 3, "three bullets");
  assert.ok(ai.includes("<code>claude mcp add --transport http --scope user merrymen https://mcp.merrymen.dev/mcp</code>"));
  assert.ok(ai.includes("<code>/mcp</code>") && ai.includes("Authenticate"));
  // The same guards as llms.txt: check before adding, leave the sign-in to the owner, never ask for a token.
  assert.ok(ai.includes("run <code>claude mcp list</code> first; an entry at <code>https://mcp.merrymen.dev/mcp</code> means it is already set up"));
  assert.ok(ai.includes("do not run <code>claude mcp login</code> yourself") && ai.includes("never ask for one"));
  assert.ok(ai.includes(`href="${installLinks(URL_).claude}" target="_blank" rel="noopener noreferrer">Add to Claude link`));
  assert.ok(ai.includes('<a href="https://merrymen.dev/llms.txt">https://merrymen.dev/llms.txt</a>'));
  assert.ok(!ai.includes("/plugin"), "the default route only; the plugin is llms.txt's alternative");
  const other = unescape(renderOther());
  assert.ok(other.includes('<a href="https://app.staging.example/llms.txt">https://app.staging.example/llms.txt</a>'));
  assert.ok(other.includes("<code>claude mcp add --transport http --scope user merrymen https://mcp.staging.example/mcp</code>"));
});

test("when connections are off, the page says so and offers nothing to install", () => {
  const html = render(false, "MCP is available on hosted Merrymen only");
  assert.match(html, /Assistant connections are switched off on this server/);
  assert.match(html, /MCP is available on hosted Merrymen only/);
  assert.ok(!html.includes("claude.ai"), "no Add to Claude");
  assert.ok(!html.includes("<button"), "no Copy buttons");
  assert.ok(!html.includes(URL_), "no address to paste into an assistant");
  for (const s of ["llms.txt", "Or just tell Claude Code", "For AI assistants", "Accepting connections", "claude mcp add"]) assert.ok(!html.includes(s), `no ${s}`);
});

test("the signed-in line: names once each, most recent use, nothing for nothing", () => {
  const now = 1_800_000_000;
  assert.equal(connectedSummary([], now), null);
  assert.equal(connectedSummary(null, now), null);
  assert.equal(connectedSummary({ connections: [] }, now), null);
  assert.deepEqual(connectedSummary([
    { clientName: "Claude", clientHost: "claude.ai", lastUsedAt: now - 3600 },
    { clientName: "Claude", clientHost: "claude.ai", lastUsedAt: now - 300 },
    { clientName: null, clientHost: "cursor.com", lastUsedAt: null },
  ], now), { names: "Claude, cursor.com", lastUsed: "last used 5 min ago", claude: true });
  assert.deepEqual(connectedSummary([{ clientName: "A", lastUsedAt: null }, { clientName: "B" }, { clientName: "C" }, { clientName: "D" }, { clientName: "E" }], now),
    { names: "A, B, C and 2 more", lastUsed: "not used yet", claude: false });
  // Claude Code verifies at claude.ai too, but it is not the Claude the big button adds.
  assert.equal(connectedSummary([{ clientName: "Claude Code", clientHost: "claude.ai", lastUsedAt: null }], now)?.claude, false);
  assert.equal(lastUsedWords(now - 10, now), "last used just now");
  assert.equal(lastUsedWords(now - 3600, now), "last used 1 hour ago");
  assert.equal(lastUsedWords(now - 3 * 86_400, now), "last used 3 days ago");
});

test("the status read gives up after 10 s, and nothing it starts outlives the page", () => {
  const code = source("./McpConnectClient.tsx");
  assert.match(code, /STATUS_TIMEOUT_MS = 10_000/);
  assert.match(code, /credentials: "same-origin"/);
  assert.match(code, /cache: "no-store"/);
  // Every setTimeout in the file has a clearTimeout in an unmount cleanup.
  assert.equal((code.match(/setTimeout\(/g) ?? []).length, 2);
  assert.match(code, /return \(\) => \{\s*clearTimeout\(timeout\);\s*abort\.abort\(\);/);
  assert.match(code, /alive\.current = false;\s*if \(timer\.current\) clearTimeout\(timer\.current\);/);
});

test("the terminal's ways in: the profile row, the desktop account menu, and Connected apps when empty", () => {
  const you = source("../../../terminal/screens/You.tsx");
  const desktop = source("../../../terminal/Desktop.tsx");
  const apps = source("../apps/AppsClient.tsx");
  assert.ok(you.includes("<strong>Connect to Claude</strong>") && you.includes("href={CONNECT_ASSISTANT_HREF}"));
  assert.ok(desktop.includes("<Link href={CONNECT_ASSISTANT_HREF}>Connect to Claude</Link>"));
  assert.ok(apps.includes("installLinks(listing.endpoint).claude") && apps.includes(`href="/connect/mcp">Other assistants`));
  assert.match(source("../../../terminal/assistant-connect.ts"), /CONNECT_ASSISTANT_HREF = "\/connect\/mcp"/);
});
