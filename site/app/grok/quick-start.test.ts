import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
let GrokQuickStart: typeof import("./GrokQuickStart").GrokQuickStart;

const SERVER = "https://mcp.example.test/mcp";
let ui: {
  container: HTMLElement;
  render(node: React.ReactNode): Promise<void>;
  click(text: string): Promise<void>;
  close(): Promise<void>;
};

beforeEach(async () => {
  // DOM helpers use root-only test dependencies; the standalone site build
  // must not resolve those packages as part of its own type check.
  const helper = "../../../web/src/terminal/test-dom";
  const { testDom } = await import(helper);
  ui = testDom();
  // The site's JSX transform expects the React global installed by testDom.
  ({ GrokQuickStart } = await import("./GrokQuickStart"));
});
afterEach(async () => { await ui?.close(); });

test("quick start copies the displayed address and offers the real connector settings link", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  await ui.render(React.createElement(GrokQuickStart, { server: SERVER }));
  await ui.click("Copy address");
  assert.deepEqual(copied, [SERVER]);
  assert.ok(ui.container.textContent?.includes("Server URL copied."));
  const link = ui.container.querySelector<HTMLAnchorElement>('a[href="https://grok.com/connectors"]');
  assert.equal(link?.target, "_blank");
  assert.equal(link?.rel, "noopener noreferrer");
  assert.ok(ui.container.textContent?.includes("Plugins → Connectors → New Connector → Custom"));
  await ui.click("Copy setup prompt");
  assert.match(copied[1], /^Set up a practice Merryman for me\./);
  assert.match(copied[1], /review the setup and sign in Merrymen/);
});

test("a rejected clipboard leaves the exact address selected and gives a visible remedy", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Clipboard unavailable"); } } });
  await ui.render(React.createElement(GrokQuickStart, { server: SERVER }));
  await ui.click("Copy address");
  assert.equal(window.getSelection()?.toString(), SERVER);
  assert.equal(document.activeElement?.textContent, SERVER);
  assert.ok(ui.container.textContent?.includes("Automatic copy is unavailable."));
  assert.equal(ui.container.querySelector<HTMLButtonElement>('[aria-label="Copy address"]')?.disabled, false);
});
