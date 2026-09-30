import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React from "react";
import { agentNameForSlug, DEFAULT_AGENT_NAME } from "@merrymen/core";
import { NameChip } from "./NameChip";
import { json, testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
let requests: { url: string; method: string; body: unknown }[];
let respond: () => Promise<Response>;
beforeEach(() => {
  ui = testDom();
  requests = [];
  respond = async () => json({ ok: true, appliesWithin: "one worker tick" });
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return respond();
  };
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

let n = 0;
const slug = () => `7y2kq0m4c1x9h${(n++).toString(32).padStart(3, "0")}`;
const chip = (name: string, s: string | null, onSettings = () => {}) => React.createElement(NameChip, { name, slug: s, nameSource: "ledger", onSettings });
const text = () => ui.container.textContent ?? "";

it("one tap names an unnamed agent with its slug's name, and nothing else is sent", async () => {
  const s = slug();
  const suggestion = agentNameForSlug(s)!;
  await ui.render(chip(DEFAULT_AGENT_NAME, s));
  await ui.click(`Name your agent: ${suggestion}`);
  assert.deepEqual(requests, [{ url: "/api/settings", method: "PUT", body: { agentName: suggestion } }]);
  assert.match(text(), new RegExp(`${suggestion}`));
  assert.match(text(), /next tick/);
  // Once the feed carries the new name the chip has nothing left to offer.
  await ui.render(chip(suggestion, s));
  assert.equal(ui.container.querySelectorAll("button").length, 0);
});

it("an agent its owner already named is left alone", async () => {
  await ui.render(chip("Shogun", slug()));
  assert.equal(text(), "");
  assert.deepEqual(requests, []);
});

it("a refused save says what the server said, and the chip stays to try again", async () => {
  // Never a silent refusal: the owner tapped, and has to be told why nothing
  // changed.
  respond = async () => json({ errors: ["name: 1-24 characters, starting with a letter or number and containing at least one letter"] }, 400);
  const s = slug();
  const suggestion = agentNameForSlug(s)!;
  await ui.render(chip(DEFAULT_AGENT_NAME, s));
  await ui.click(`Name your agent: ${suggestion}`);
  assert.match(text(), /containing at least one letter/);
  assert.ok(ui.container.querySelectorAll("button").length > 0, "the offer is still there");
  assert.doesNotMatch(text(), /next tick/, "and nothing claims it was saved");
});

it("a network failure is said too, not swallowed", async () => {
  respond = async () => {
    throw new TypeError("Failed to fetch");
  };
  const s = slug();
  await ui.render(chip(DEFAULT_AGENT_NAME, s));
  await ui.click(`Name your agent: ${agentNameForSlug(s)}`);
  assert.match(text(), /could not be saved/i);
});

it("choosing one's own name goes to Settings and saves nothing", async () => {
  let opened = 0;
  await ui.render(chip(DEFAULT_AGENT_NAME, slug(), () => opened++));
  await ui.click("Choose my own");
  assert.equal(opened, 1);
  assert.deepEqual(requests, []);
});

it("with no public id yet there is no suggestion to make, only the way to Settings", async () => {
  let opened = 0;
  await ui.render(chip(DEFAULT_AGENT_NAME, null, () => opened++));
  assert.equal(ui.container.querySelectorAll("button").length, 2);
  await ui.click("Name your agent");
  assert.equal(opened, 1);
  assert.deepEqual(requests, []);
});

it("an owner who wants to stay Robin can say so once, and is not asked again", async () => {
  const s = slug();
  await ui.render(chip(DEFAULT_AGENT_NAME, s));
  await ui.click(`Keep ${DEFAULT_AGENT_NAME}`);
  assert.equal(ui.container.querySelectorAll("button").length, 0);
  await ui.remount(chip(DEFAULT_AGENT_NAME, s));
  assert.equal(ui.container.querySelectorAll("button").length, 0, "remembered in this browser");
  assert.deepEqual(requests, []);
});

it("a 'Robin' the feed fell back to is not offered a new name", async () => {
  // The feed answers "Robin" when it could not read the settings store or the
  // ledger. An owner whose agent is already "Shogun" could then be offered
  // "Name your agent: <generated>", and one tap would overwrite Shogun.
  await ui.render(React.createElement(NameChip, { name: DEFAULT_AGENT_NAME, slug: slug(), nameSource: "fallback", onSettings: () => {} }));
  assert.equal(ui.container.querySelectorAll("button").length, 0);
  await ui.render(React.createElement(NameChip, { name: DEFAULT_AGENT_NAME, slug: slug(), nameSource: null, onSettings: () => {} }));
  assert.equal(ui.container.querySelectorAll("button").length, 0, "nor one from a feed that does not say where its name came from");
  await ui.render(React.createElement(NameChip, { name: DEFAULT_AGENT_NAME, slug: slug(), nameSource: "ledger", onSettings: () => {} }));
  assert.ok(ui.container.querySelectorAll("button").length > 0, "a Robin actually read is offered one");
  assert.deepEqual(requests, []);
});
