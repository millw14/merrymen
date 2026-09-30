import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { AgentImageField } from "./AgentImageField";
import { Face } from "./ui";
import { Profile } from "./screens/Profile";
import type { LiveAgent, Thesis } from "./live";
import { json, testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
let count = 0;
beforeEach(() => { ui = testDom(); URL.createObjectURL = () => "blob:local-preview"; URL.revokeObjectURL = () => {}; });
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; });
function agent(slug: string): LiveAgent {
  return { slug, name: "Desk", owner: null, ownerVerified: false, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "" }, thesis: "" } as unknown as LiveAgent;
}
const profile = (slug: string, theses: Thesis[] = []) => React.createElement(Profile, { agent: agent(slug), theses, tokens: [], isMine: true, onBack() {}, onToken() {} });
async function upload() {
  const input = ui.container.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new ui.dom.window.File(["image"], "avatar.png", { type: "image/png" })] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}

it("an upload refreshes every mounted avatar, including failed images; refused delete preserves them", async () => {
  const slug = `image-${++count}`;
  let deletionFails = true;
  globalThis.fetch = async (_, init) => init?.method === "PUT" ? json({ version: "new-avatar" }) : deletionFails ? json({ error: "remove denied" }, 403) : json({ ok: true });
  await ui.render(React.createElement("div", null,
    React.createElement(Face, { name: "One", slug }), React.createElement(Face, { name: "Two", slug }),
    React.createElement(AgentImageField, { kind: "avatar", slug, label: "Avatar", hint: "Choose image" })));
  await act(async () => { ui.container.querySelector(".face img")!.dispatchEvent(new Event("error")); });
  assert.equal(ui.container.querySelectorAll(".face img").length, 1);
  await upload();
  assert.equal(ui.container.querySelectorAll('.face img[src$="?v=new-avatar"]').length, 2);
  await ui.click("remove");
  assert.equal(ui.container.querySelectorAll(".face img").length, 2);
  assert.match(ui.container.textContent!, /remove denied/);
  deletionFails = false; await ui.click("remove");
  assert.equal(ui.container.querySelectorAll(".face img").length, 0);
  assert.equal(ui.container.querySelector(".agent-image-preview"), null);
});
it("a refused upload does not publish a new image revision", async () => {
  const slug = `image-${++count}`;
  globalThis.fetch = async () => json({ error: "invalid image" }, 415);
  await ui.render(React.createElement("div", null, React.createElement(Face, { name: "Desk", slug }), React.createElement(AgentImageField, { kind: "avatar", slug, label: "Avatar", hint: "" })));
  const source = ui.container.querySelector(".face img")!.getAttribute("src");
  await upload();
  assert.equal(ui.container.querySelector(".face img")!.getAttribute("src"), source);
  assert.match(ui.container.textContent!, /invalid image/);
});
it("banner upload revives a failed profile banner, and profile changes reset banner errors", async () => {
  const slug = `banner-${++count}`;
  globalThis.fetch = async () => json({ version: "new-banner" });
  await ui.render(React.createElement("div", null, profile(slug), React.createElement(AgentImageField, { kind: "banner", slug, label: "Banner", hint: "" })));
  await act(async () => { ui.container.querySelector(".public-agent-banner")!.dispatchEvent(new Event("error")); });
  assert.equal(ui.container.querySelector(".public-agent-banner"), null);
  await upload();
  assert.match(ui.container.querySelector(".public-agent-banner")!.getAttribute("src")!, /new-banner$/);
  await ui.render(profile("other-agent"));
  await act(async () => { ui.container.querySelector(".public-agent-banner")!.dispatchEvent(new Event("error")); });
  await ui.render(profile("third-agent"));
  assert.match(ui.container.querySelector(".public-agent-banner")!.getAttribute("src")!, /third-agent/);
});
it("profile Hold activity omits zero notional while real trade sizes remain visible", async () => {
  const slug = "activity-desk";
  const common = { name: "Desk", slug, handle: null, symbol: "TSLA", paper: false, head: "", reason: "wait", at: 1 };
  const theses: Thesis[] = [
    { ...common, action: "hold", sizeUsdg: 0 },
    { ...common, action: "buy", sizeUsdg: 15, at: 2 },
    { ...common, action: "sell", sizeUsdg: 5, at: 3 },
  ];
  await ui.render(profile(slug, theses));
  const articles = [...ui.container.querySelectorAll(".public-event")];
  const hold = articles.find(row => /Hold/.test(row.textContent!))!;
  assert.doesNotMatch(hold.textContent!, /\$0|0\.00/);
  assert.match(articles.find(row => /Buy/.test(row.textContent!))!.textContent!, /\$15/);
  assert.match(articles.find(row => /Sell/.test(row.textContent!))!.textContent!, /\$5/);
});
