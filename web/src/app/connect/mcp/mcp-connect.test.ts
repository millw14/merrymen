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
const render = (enabled: boolean, disabledWhy: string | null = null) =>
  renderToStaticMarkup(createElement(McpConnectClient, { url: URL_, enabled, disabledWhy }));
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

test("when connections are off, the page says so and offers nothing to install", () => {
  const html = render(false, "MCP is available on hosted Merrymen only");
  assert.match(html, /Assistant connections are switched off on this server/);
  assert.match(html, /MCP is available on hosted Merrymen only/);
  assert.ok(!html.includes("claude.ai"), "no Add to Claude");
  assert.ok(!html.includes("<button"), "no Copy buttons");
  assert.ok(!html.includes(URL_), "no address to paste into an assistant");
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
