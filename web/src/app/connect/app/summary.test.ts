/**
 * The consent screen's summary and starting selection: the grouping and
 * wording the owner reads before they click Allow, and the rule that a
 * reconnect starts from the current connection instead of dropping what the
 * owner ticked before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPES } from "@/mcp/scopes";
import { accessSummary, initialSelection, joinPhrases, previousNote } from "./summary";

/** The scopes as the consent view offers them (no offline_access), in the view's (sorted) order. */
const VIEW_SCOPES = SCOPES.filter((s) => s.id !== "offline_access")
  .map((s) => ({ id: s.id, level: s.level, phrase: s.phrase, needsAgent: s.needsAgent, defaultOn: s.defaultOn }))
  .sort((a, b) => a.id.localeCompare(b.id));
const nonStaff = VIEW_SCOPES.filter((s) => s.level !== "staff");
const ids = (...list: string[]) => new Set(list);

test("phrases are joined as a, b and c", () => {
  assert.equal(joinPhrases([]), "");
  assert.equal(joinPhrases(["a"]), "a");
  assert.equal(joinPhrases(["a", "b"]), "a and b");
  assert.equal(joinPhrases(["a", "b", "c"]), "a, b and c");
  // An item with its own "and" would blur the list: semicolons instead.
  assert.equal(joinPhrases(["your portfolio and trades", "reports and exports"]), "your portfolio and trades; reports and exports");
  assert.equal(joinPhrases(["backtests", "your portfolio and trades", "your alerts"]), "backtests; your portfolio and trades; your alerts");
});

test("the summary groups what is ticked under See, Do, Suggest and Staff, in that order, leaving empty groups out", () => {
  const all = accessSummary(VIEW_SCOPES, new Set(VIEW_SCOPES.map((s) => s.id)), true);
  assert.deepEqual(all.map((g) => g.label), ["See", "Do", "Suggest, only with your approval", "Staff tools"]);
  assert.deepEqual(all.map((g) => g.level), ["read", "write", "sensitive", "staff"]);
  const see = all.find((g) => g.level === "read")!;
  assert.equal(see.text, "your agent’s status and settings; your agent’s decisions; market and public-agent research; your portfolio and trades; reports and exports");
  const only = accessSummary(nonStaff, ids("market:read", "jobs:run"), true);
  assert.deepEqual(only, [
    { level: "read", label: "See", text: "market and public-agent research" },
    { level: "write", label: "Do", text: "backtests" },
  ]);
  assert.deepEqual(accessSummary(nonStaff, ids(), true), []);
  // An id the view does not offer never shows up, whatever is ticked.
  assert.deepEqual(accessSummary(nonStaff, ids("staff:diagnostics", "admin:everything"), true), []);
});

test("an agent permission is left out of the summary when no agent is ticked, as the checklist disables it", () => {
  const defaults = new Set(nonStaff.filter((s) => s.defaultOn).map((s) => s.id));
  const without = accessSummary(nonStaff, defaults, false);
  assert.deepEqual(without, [
    { level: "read", label: "See", text: "market and public-agent research" },
    { level: "write", label: "Do", text: "backtests and your watchlist" },
  ]);
  const withAgent = accessSummary(nonStaff, defaults, true);
  assert.match(withAgent.find((g) => g.level === "read")!.text, /your portfolio and trades/);
  assert.match(withAgent.find((g) => g.level === "write")!.text, /chats with your agent/);
  // A sensitive permission that needs an agent is dropped too; one that does not stays.
  assert.deepEqual(accessSummary(nonStaff, ids("trade:propose", "drafts:write"), false), [
    { level: "sensitive", label: "Suggest, only with your approval", text: "setting-change suggestions" },
  ]);
});

test("following agents is listed as something done at once, never under 'only with your approval' (it asks for none)", () => {
  const out = accessSummary(nonStaff, ids("social:write", "trade:propose", "watchlist:manage"), true);
  assert.deepEqual(out, [
    { level: "write", label: "Do", text: "your watchlist and following public agents" },
    { level: "sensitive", label: "Suggest, only with your approval", text: "draft posts and trade suggestions" },
  ]);
  const sensitive = out.find((g) => g.level === "sensitive")!.text;
  assert.doesNotMatch(sensitive, /follow/);
});

test("every summary phrase comes from the scope table, so no scope can be summarised as nothing", () => {
  for (const s of VIEW_SCOPES) {
    const out = accessSummary(VIEW_SCOPES, ids(s.id), true);
    assert.ok(out.length > 0 && out.every((g) => g.text.trim().length > 0), s.id);
  }
});

const view = (over: Partial<Parameters<typeof initialSelection>[0]> = {}) => ({
  scopes: nonStaff,
  agents: [{ slug: "aaaa" }],
  previous: null,
  ...over,
});

test("a first connection starts from the defaults: default-on permissions (never a sensitive one) and every agent", () => {
  const start = initialSelection(view({ agents: [{ slug: "aaaa" }, { slug: "bbbb" }] }));
  assert.equal(start.fromPrevious, false);
  assert.deepEqual([...start.agents].sort(), ["aaaa", "bbbb"]);
  assert.deepEqual([...start.scopes].sort(), nonStaff.filter((s) => s.defaultOn).map((s) => s.id).sort());
  for (const s of nonStaff) if (s.level === "sensitive") assert.ok(!start.scopes.has(s.id), s.id);
});

test("a reconnect starts from the current connection, keeping a sensitive permission the owner ticked before", () => {
  const start = initialSelection(view({ previous: { scopes: ["market:read", "trade:propose"], agentSlugs: ["aaaa"] } }));
  assert.equal(start.fromPrevious, true);
  assert.deepEqual([...start.scopes].sort(), ["market:read", "trade:propose"]);
  assert.deepEqual([...start.agents], ["aaaa"]);
  // Several agents: the previous choice of agents is kept as it was, including none.
  const several = initialSelection(view({ agents: [{ slug: "aaaa" }, { slug: "bbbb" }], previous: { scopes: ["market:read"], agentSlugs: [] } }));
  assert.equal(several.fromPrevious, true);
  assert.deepEqual([...several.agents], []);
});

test("a connection made without the only agent keeps it unshared; Share alone then adds the usual agent access", () => {
  // What such a connection can hold: only permissions that need no agent (the server drops the rest).
  const before = nonStaff.filter((s) => !s.needsAgent).map((s) => s.id);
  assert.ok(before.length > 0);
  const start = initialSelection(view({ previous: { scopes: before, agentSlugs: [] } }));
  assert.equal(start.fromPrevious, true);
  assert.deepEqual([...start.agents], [], "the agent stays unshared, as the owner left it");
  const agentDefaults = nonStaff.filter((s) => s.defaultOn && s.needsAgent).map((s) => s.id);
  assert.ok(agentDefaults.length > 0);
  assert.deepEqual([...start.scopes].sort(), [...before, ...agentDefaults].sort());
  // Unshared, the agent permissions grant nothing: the summary is exactly the old connection.
  assert.deepEqual(accessSummary(nonStaff, start.scopes, false), accessSummary(nonStaff, new Set(before), false));
  // Ticking Share adds the default agent access, and never a sensitive permission.
  assert.notDeepEqual(accessSummary(nonStaff, start.scopes, true), accessSummary(nonStaff, new Set(before), false));
  for (const s of nonStaff) if (s.level === "sensitive") assert.ok(!agentDefaults.includes(s.id), s.id);
});

test("a previous choice that grants nothing starts from the defaults", () => {
  // Nothing left that this request offers.
  assert.equal(initialSelection(view({ previous: { scopes: [], agentSlugs: ["aaaa"] } })).fromPrevious, false);
  // Only agent permissions, and no agent to apply them to.
  assert.equal(initialSelection(view({ agents: [], previous: { scopes: ["portfolio:read"], agentSlugs: [] } })).fromPrevious, false);
  // Ids the view does not offer, or agents the owner does not have, are never ticked.
  const odd = initialSelection(view({ previous: { scopes: ["market:read", "staff:diagnostics", "admin:x"], agentSlugs: ["aaaa", "zzzz"] } }));
  assert.deepEqual([...odd.scopes], ["market:read"]);
  assert.deepEqual([...odd.agents], ["aaaa"]);
});

test("'same access' is said only while the ticked boxes are still exactly the current connection's", () => {
  const start = initialSelection(view({ previous: { scopes: ["market:read", "trade:propose"], agentSlugs: ["aaaa"] } }));
  const same = { scopes: new Set(start.scopes), agents: new Set(start.agents) };
  assert.equal(previousNote(start, same, false, "Claude"), "Same access as your current connection.");
  assert.match(previousNote(start, same, true, "Claude")!, /except what Claude no longer asks for/);
  assert.equal(previousNote(start, { scopes: ids("market:read"), agents: same.agents }, false, "Claude"), null);
  assert.equal(previousNote(start, { scopes: same.scopes, agents: ids() }, false, "Claude"), null);
  const fresh = initialSelection(view());
  assert.equal(previousNote(fresh, { scopes: fresh.scopes, agents: fresh.agents }, false, "Claude"), null);
});

