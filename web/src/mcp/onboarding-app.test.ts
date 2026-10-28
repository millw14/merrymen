/** The embedded management UI, driven through the host bridge and real tool schemas. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { APPS_PROTOCOL_VERSION, appHtml } from "./apps";
import { ONBOARDING_TOOLS } from "./tools/onboarding";
import { AGENT_SETTINGS_TOOLS } from "./tools/agent-settings";
import { AGENT_TOOLS } from "./tools/agents";
import { PROPOSAL_TOOLS } from "./tools/proposals";
import { NOTIFICATIONS_TOOLS } from "./tools/notifications";
import type { ToolDef } from "./tool";
import { ERROR_META_KEY } from "./tool";
import { errorBody, McpError } from "./errors";

const TOOLS = [...ONBOARDING_TOOLS, ...AGENT_SETTINGS_TOOLS, ...AGENT_TOOLS, ...PROPOSAL_TOOLS, ...NOTIFICATIONS_TOOLS] as unknown as ToolDef[];
const tool = (name: string) => { const t = TOOLS.find(t => t.name === name); assert.ok(t, name); return t; };
function sample<T>(name: string, data: T): T {
  const parsed = tool(name).output.safeParse(data);
  assert.ok(parsed.success, `${name}: ${parsed.success ? "" : parsed.error.message}`);
  assert.deepEqual(parsed.data, data, "fixture has no undeclared keys"); return parsed.data as T;
}
const ISSUER = "https://app.test";
const SLUG = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";
const ADDR = "0x1111111111111111111111111111111111111111";
const TIME = "2026-10-14T10:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PID = "prp_" + "a".repeat(32);
const SID = "nsub_" + "b".repeat(32);
const CAPABILITIES = ["get_merryman_setup", "get_agent_settings", "get_agent_controls", "create_agent_draft", "propose_settings_change", "list_proposals", "get_proposal", "cancel_proposal", "list_notification_channels", "list_subscriptions", "subscribe", "unsubscribe"];
const AGENT = { id: SLUG, name: "Old worker name", account: ADDR, chain_id: 4663, status: "active", mode: "paper", strategy: "trencher", permission_expires_at: FUTURE, heartbeat_at: TIME, worker_fresh: true, live_blocker: null, energy: null };
const setup = (over: Record<string, unknown> = {}) => sample("get_merryman_setup", {
  phase: "paper", summary: "The worker reports paper mode. Practice uses simulated funds.",
  connection: { id: "connection-test-a", profile: "full", can_read_agents: true, can_create_draft: true, can_propose_settings: true, shared_agent_count: 1, available_tools: CAPABILITIES },
  agent: AGENT, next_steps: [], links: { create: ISSUER + "/create", wallet: ISSUER + "/grant", settings: ISSUER + "/settings", funding: ISSUER + "/deposit", connected_apps: ISSUER + "/connect/apps" },
  runtime: { hosted: true, keep_chat_open: false, explanation: "Hosted worker keeps running after chat closes." }, controls: [], observed_at: TIME, ...over,
});
const spec = (key: string, kind: string, value: unknown, over: Record<string, unknown> = {}) => ({ key, label: key, kind, unit: "integer", value, value_state: value === null ? "not_set" : "stored", valid_for_proposal: value === null ? null : true, display_value: value === null ? "Not set - worker default" : String(value), help: "Bounded preference.", min: null, max: null, options: null, zero_meaning: null, ...over });
const settings = (over: Record<string, unknown> = {}) => sample("get_agent_settings", {
  agent: SLUG, configured_name: "Saved name", strategy: "steady-basket",
  settings: [
    spec("slippageBps", "pct", 50, { label: "max slippage", unit: "basis_points", min: 1, max: 1000, display_value: "0.5%" }),
    spec("classMaxHoldSec", "hoursAsSec", null, { unit: "seconds", min: 60, max: 2592000 }),
    spec("classMaxPositions", "int", 0, { min: 1, max: 1000, display_value: "no limit", zero_meaning: "no limit", valid_for_proposal: false }),
    spec("officialCoinsEnabled", "bool", true, { unit: "boolean", display_value: "on" }),
    spec("basketSymbols", "symbols", ["NVDA"], { unit: "symbols", display_value: "NVDA" }),
    spec("assetMode", "enum", "stocks", { unit: "choice", options: ["all", "stocks", "crypto"] }),
  ], available_basket_symbols: ["NVDA", "AAPL", "Cat"], approval_required: true, note: "Saved settings are not a worker acknowledgement. 100 basis points = 1%.", observed_at: TIME, ...over,
});
const proposal = (over: Record<string, unknown> = {}) => sample("get_proposal", {
  proposal_id: PID, kind: "settings", status: "awaiting_approval", status_explained: "Waiting for owner approval.", terminal: false,
  approval_url: `${ISSUER}/connect/approve/${PID}`, created_at: TIME, expires_at: FUTURE, decided_at: null,
  requested_by: "ChatGPT", summary: { action: "Change max slippage", diff: [{ key: "slippageBps", label: "max slippage", current: "0.5%", proposed: "0.8%", help: "Worst accepted price move." }] }, order_id: null, result: null, ...over,
});
const subscription = () => ({ subscription_id: SID, agent: SLUG, kind: "summary", params: { period: "week", hour_utc: 0 }, description: "Weekly summary on Mondays at 00:00 UTC", status: "active", channel: "telegram", created_at: TIME, last_evaluated_at: null });
const subscriptions = (filled = false) => sample("list_subscriptions", { subscriptions: filled ? [{ ...subscription(), last_delivery: null }] : [], active_subscriptions: filled ? 1 : 0, not_shown: 0, max_active_subscriptions: 20, observed_at: TIME });
const channel = { channel: "telegram", linked: true, linked_at: TIME, telegram_enabled: true, alerts_enabled: true, ready: true, how_to_fix: null };

interface Message { jsonrpc: string; id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> }; result?: unknown }
const open: JSDOM[] = [];
afterEach(() => { while (open.length) open.pop()!.window.close(); });
function mount() {
  const sent: Message[] = [];
  const toolTimeouts: Array<() => void> = [];
  const host = { postMessage(m: Message) { sent.push(JSON.parse(JSON.stringify(m))); } };
  const dom = new JSDOM(appHtml("home", { issuer: ISSUER }), { runScripts: "dangerously", url: "https://sandbox.example", pretendToBeVisual: true, beforeParse(w) {
    (w as unknown as { parent: unknown }).parent = host;
    const schedule = w.setTimeout.bind(w);
    w.setTimeout = (handler, timeout, ...args) => {
      if (timeout === 30_000 && typeof handler === "function") toolTimeouts.push(() => handler(...args));
      return schedule(handler, timeout, ...args);
    };
  } });
  open.push(dom);
  const w = dom.window;
  const deliver = (data: unknown) => w.dispatchEvent(new w.MessageEvent("message", { data, source: host as never }));
  return { w, doc: w.document, sent, deliver, expireLastToolWait() { assert.ok(toolTimeouts.length); toolTimeouts.at(-1)!(); }, tick: () => new Promise<void>(r => setTimeout(r, 10)), text: () => w.document.getElementById("app")!.textContent ?? "" };
}
type Mount = ReturnType<typeof mount>;
async function show(m: Mount, data: unknown) { m.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: data } }); await m.tick(); }
async function start(data = setup()) {
  const m = mount(); const init = m.sent.find(m => m.method === "ui/initialize")!;
  m.deliver({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: APPS_PROTOCOL_VERSION, hostCapabilities: { serverTools: {}, openLinks: {} }, hostContext: {} } }); await m.tick(); await show(m, data); return m;
}
function click(m: Mount, text: string) { const b = [...m.doc.querySelectorAll("button")].find(b => b.textContent === text); assert.ok(b, `button ${text}`); assert.equal(b.disabled, false); b.click(); }
function calls(m: Mount) { return m.sent.filter(m => m.method === "tools/call"); }
function last(m: Mount, name: string) { const call = calls(m).at(-1)!; assert.equal(call?.params?.name, name); const parsed = tool(name).input.safeParse(call.params!.arguments); assert.ok(parsed.success, `${name} arguments valid`); return call; }
async function answer(m: Mount, call: Message, data: unknown) { sample(call.params!.name!, data); m.deliver({ jsonrpc: "2.0", id: call.id, result: { structuredContent: data } }); await m.tick(); }
async function fail(m: Mount, call: Message) { m.deliver({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "Temporary host failure" } }); await m.tick(); }
function field(m: Mount, label: string) { const v = m.doc.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`); assert.ok(v, label); return v; }
function change(m: Mount, label: string, value: string) { const v = field(m, label); v.value = value; v.dispatchEvent(new m.w.Event("input", { bubbles: true })); v.dispatchEvent(new m.w.Event("change", { bubbles: true })); }
function submit(m: Mount, label: string) { const input = field(m, label); assert.ok(input.form); input.form.dispatchEvent(new m.w.Event("submit", { bubbles: true, cancelable: true })); }
async function loadSettings(m: Mount) { click(m, "Settings"); const call = last(m, "get_agent_settings"); assert.deepEqual(call.params!.arguments, { agent: SLUG }); await answer(m, call, settings()); }

test("new connected identity has a creation-first home, no unknown worker or portfolio panels", async () => {
  const m = await start(setup({ phase: "permission_required", agent: { ...AGENT, account: null, mode: "unknown", strategy: null, heartbeat_at: null, worker_fresh: null }, connection: { ...setup().connection, available_tools: [...CAPABILITIES, "create_merryman", "get_portfolio", "get_trades"] } }));
  assert.match(m.text(), /Meet your next Merryman/); assert.doesNotMatch(m.text(), /LAST REPORTED MODE|Smart account|Not known/);
  assert.deepEqual([...m.doc.querySelectorAll('[role="tab"]')].map(t => t.textContent), ["Overview", "Approvals"]);
  assert.equal(field(m, "Name").value, "My Merryman"); assert.equal(calls(m).length, 0);
  change(m, "Assets to consider", "stocks"); change(m, "Basket symbols", "NVDA, AAPL"); submit(m, "Name");
  assert.deepEqual(last(m, "create_merryman").params!.arguments?.basket, ["NVDA", "AAPL"]);
});

test("saved settings initialize edits instead of stale worker reports, and unchanged values are omitted", async () => {
  const m = await start(); await loadSettings(m);
  assert.equal(field(m, "Name").value, "Saved name"); assert.equal(field(m, "Strategy").value, "steady-basket");
  assert.match(m.text(), /0\.5%/); assert.match(m.text(), /Saved settings are not a worker acknowledgement/);
  change(m, "Name", "Marian"); submit(m, "Name"); const args = last(m, "create_agent_draft").params!.arguments!;
  assert.deepEqual(Object.keys(args).sort(), ["idempotency_key", "name"]); assert.equal(args.name, "Marian"); assert.equal(args.agent, undefined);
});

test("unsent settings survive tab reads and errors; retries reuse the exact idempotency key", async () => {
  const m = await start(); await loadSettings(m); change(m, "Name", "Night Owl"); change(m, "Strategy", "dip-hunter");
  click(m, "Overview"); click(m, "Settings"); await fail(m, last(m, "get_agent_settings"));
  assert.equal(field(m, "Name").value, "Night Owl"); assert.equal(field(m, "Strategy").value, "dip-hunter");
  submit(m, "Name"); const first = last(m, "create_agent_draft"); await fail(m, first); submit(m, "Name"); assert.deepEqual(last(m, "create_agent_draft").params!.arguments, first.params!.arguments);
  await show(m, setup({ agent: { ...AGENT, id: OTHER }, connection: { ...setup().connection, available_tools: ["get_merryman_setup"] } }));
  assert.doesNotMatch(m.text(), /Night Owl|Saved name/); click(m, "Settings"); assert.equal(m.doc.querySelector("form"), null);
});

test("preference editor uses stored units and bounds, leaves unset and unproposable values empty", async () => {
  const m = await start(); await loadSettings(m); assert.equal(field(m, "New value (%)").value, "0.5");
  assert.match(m.text(), /100 basis points = 1%/); const before = calls(m).length;
  change(m, "New value (%)", "10.01"); submit(m, "New value (%)"); assert.equal(calls(m).length, before);
  change(m, "New value (%)", "0.8"); submit(m, "New value (%)"); const call = last(m, "propose_settings_change");
  assert.deepEqual(call.params!.arguments?.changes, { slippageBps: 80 }); assert.equal(call.params!.arguments?.agent, SLUG);
  await fail(m, call); change(m, "Preference to change", "classMaxHoldSec"); assert.equal(field(m, "New value (hours)").value, "");
  assert.match(m.text(), /Not set - worker default/); submit(m, "New value (hours)"); assert.equal(calls(m).at(-1), call);
  change(m, "Preference to change", "classMaxPositions"); assert.equal(field(m, "New value (integer)").value, ""); assert.match(m.text(), /Zero means: no limit/);
});

test("typed boolean and case-preserving basket edits are proposed without coercing unrelated preferences", async () => {
  const m = await start(); await loadSettings(m); change(m, "Preference to change", "officialCoinsEnabled"); change(m, "New value (boolean)", "false"); submit(m, "New value (boolean)");
  const first = last(m, "propose_settings_change"); assert.deepEqual(first.params!.arguments?.changes, { officialCoinsEnabled: false }); await fail(m, first);
  change(m, "Preference to change", "basketSymbols"); change(m, "New value (symbols)", "NVDA, Cat"); submit(m, "New value (symbols)");
  assert.deepEqual(last(m, "propose_settings_change").params!.arguments?.changes, { basketSymbols: ["NVDA", "Cat"] });
});

test("pending approvals are read-only until explicit cancel confirmation, never an approval or wallet call", async () => {
  const m = await start(); click(m, "Approvals"); await answer(m, last(m, "list_proposals"), { proposals: [proposal()] });
  click(m, "Review proposal"); await answer(m, last(m, "get_proposal"), proposal());
  assert.ok(m.doc.querySelector(`a[href="${ISSUER}/connect/approve/${PID}"]`)); const before = calls(m).length;
  click(m, "Cancel draft"); assert.equal(calls(m).length, before); click(m, "Keep draft"); assert.equal(calls(m).length, before);
  click(m, "Cancel draft"); click(m, "Confirm cancel draft"); assert.deepEqual(last(m, "cancel_proposal").params!.arguments, { proposal_id: PID });
  await answer(m, last(m, "cancel_proposal"), proposal({ status: "cancelled", terminal: true, approval_url: null, decided_at: TIME }));
  assert.match(m.text(), /Draft cancelled. Your saved settings are unchanged/); assert.ok(![...m.doc.querySelectorAll("button")].some(b => b.textContent === "Cancel draft"));
  assert.ok(!calls(m).some(c => /approve|execute|sign/.test(c.params!.name!)));
});

test("trade proposals and already approved configuration have no embedded cancel control", async () => {
  for (const data of [proposal({ kind: "trade" }), proposal({ status: "applied", terminal: true, approval_url: null })]) {
    const m = await start(); click(m, "Approvals"); await answer(m, last(m, "list_proposals"), { proposals: [data] }); click(m, "Review proposal"); await answer(m, last(m, "get_proposal"), data);
    assert.ok(![...m.doc.querySelectorAll("button")].some(b => b.textContent === "Cancel draft"));
  }
});

test("weekly Telegram summary preserves UTC midnight and refreshes the active subscription list", async () => {
  const m = await start(); click(m, "Alerts"); await answer(m, last(m, "list_subscriptions"), subscriptions());
  change(m, "Add an alert", "summary"); change(m, "Summary frequency", "week"); change(m, "Delivery hour (UTC)", "0"); submit(m, "Add an alert"); const call = last(m, "subscribe");
  assert.deepEqual(call.params!.arguments, { agent: SLUG, kind: "summary", params: { period: "week", hour_utc: 0 } });
  await answer(m, call, { subscription: subscription(), created: true, channel, active_subscriptions: 1, max_active_subscriptions: 20, warnings: [] });
  await answer(m, last(m, "list_subscriptions"), subscriptions(true)); assert.match(m.text(), /Alert added/); assert.match(m.text(), /Weekly summary on Mondays at 00:00 UTC/);
  assert.ok(![...m.doc.querySelectorAll<HTMLButtonElement>('[role="tab"]')].some(b => b.disabled));
});

test("inactivity and price alerts validate their inputs and price alerts are token-bound, not agent-bound", async () => {
  const m = await start(); click(m, "Alerts"); await answer(m, last(m, "list_subscriptions"), subscriptions());
  change(m, "Add an alert", "inactivity"); change(m, "Hours without activity", "5"); const before = calls(m).length; submit(m, "Add an alert"); assert.equal(calls(m).length, before);
  change(m, "Hours without activity", "6"); submit(m, "Add an alert"); const inactivity = last(m, "subscribe"); assert.deepEqual(inactivity.params!.arguments?.params, { hours: 6 }); await fail(m, inactivity);
  change(m, "Add an alert", "watchlist_price"); change(m, "Stock token address", ADDR); submit(m, "Add an alert"); assert.equal(calls(m).at(-1), inactivity);
  change(m, "Price above (USD)", "10"); change(m, "Price below (USD)", "20"); submit(m, "Add an alert"); assert.equal(calls(m).at(-1), inactivity);
  change(m, "Price below (USD)", "5"); submit(m, "Add an alert"); assert.deepEqual(last(m, "subscribe").params!.arguments, { kind: "watchlist_price", params: { token: ADDR, above: 10, below: 5 } });
});

test("removing an alert requires confirmation and reloads the list after success", async () => {
  const m = await start(); click(m, "Alerts"); await answer(m, last(m, "list_subscriptions"), subscriptions(true)); const before = calls(m).length;
  click(m, "Remove alert"); assert.equal(calls(m).length, before); click(m, "Keep alert"); assert.match(m.text(), /Weekly summary/);
  click(m, "Remove alert"); click(m, "Confirm remove alert"); await answer(m, last(m, "unsubscribe"), { subscription_id: SID, status: "deleted", already_deleted: false, pending_dropped: 1 });
  await answer(m, last(m, "list_subscriptions"), subscriptions()); assert.match(m.text(), /Alert removed/); assert.doesNotMatch(m.text(), /Weekly summary on Mondays/);
});

test("new host selection drops an in-flight settings result and all old draft data", async () => {
  const m = await start(); click(m, "Settings"); const pending = last(m, "get_agent_settings");
  await show(m, setup({ agent: { ...AGENT, id: OTHER, name: "Other agent" } })); await answer(m, pending, settings());
  assert.match(m.text(), /Other agent/); assert.doesNotMatch(m.text(), /Saved name|0\.5%/); assert.equal(m.doc.querySelector("form"), null);
});

test("a failed rename stays name-only when a refresh reveals newer saved strategy and basket", async () => {
  const m = await start(); await loadSettings(m); change(m, "Name", "New Robin"); submit(m, "Name"); const first = last(m, "create_agent_draft"); await fail(m, first);
  click(m, "Refresh"); await answer(m, last(m, "get_agent_settings"), settings({ strategy: "dip-hunter", settings: settings().settings.map(s => s.key === "basketSymbols" ? { ...s, value: ["AAPL"], display_value: "AAPL" } : s.key === "assetMode" ? { ...s, value: "all", display_value: "all" } : s) }));
  assert.equal(field(m, "Name").value, "New Robin"); assert.equal(field(m, "Strategy").value, "dip-hunter"); assert.equal(field(m, "Basket symbols").value, "AAPL");
  submit(m, "Name"); assert.deepEqual(last(m, "create_agent_draft").params!.arguments, first.params!.arguments);
});

function draftResult(purpose = "settings") {
  return { proposal_id: PID, kind: "agent_draft", status: "awaiting_approval", approval_url: `${ISSUER}/connect/approve/${PID}`, expires_at: FUTURE, binding_hash: "ab".repeat(32), summary: { action: purpose === "create" ? "Create a new Merryman" : "Update settings", purpose, settings: { agentName: "Marian" } }, next_steps: "Owner review required.", created: true, risk_profile: null, left_out: [], diff: null };
}

test("a host approval longer than 30 seconds still delivers the new Merryman handoff", async () => {
  const m = await start(setup({ agent: null, phase: "no_shared_agent", connection: { ...setup().connection, shared_agent_count: 0, available_tools: ["get_merryman_setup", "create_merryman"] } }));
  change(m, "Name", "Marian"); submit(m, "Name"); const call = last(m, "create_merryman");
  m.expireLastToolWait();
  assert.equal(field(m, "Name").value, "Marian", "waiting preserves the submitted setup");
  assert.equal(calls(m).length, 1, "waiting does not repeat a host approval or create another draft");
  await answer(m, call, draftResult("create"));
  assert.ok(m.doc.querySelector(`a[href="${ISSUER}/connect/approve/${PID}"]`), "late approved call remains actionable");
  assert.match(m.text(), /Draft prepared/);
  assert.doesNotMatch(m.doc.querySelector(".home-status")!.textContent!, /waiting|returned/i);
});

test("optional assets survive a delayed host response and the resulting approval has a single branded view", async () => {
  const m = await start(setup({ agent: null, phase: "no_shared_agent", connection: { ...setup().connection, shared_agent_count: 0, available_tools: ["get_merryman_setup", "create_merryman"] } }));
  const advanced = field(m, "Assets to consider").closest("details")!;
  assert.equal(advanced.open, false, "optional fields start folded");
  advanced.open = true;
  change(m, "Name", "Marian"); change(m, "Assets to consider", "stocks"); change(m, "Basket symbols", "NVDA, AAPL"); submit(m, "Name");
  const call = last(m, "create_merryman");
  assert.equal(call.params!.arguments!.asset_mode, "stocks");
  assert.deepEqual(call.params!.arguments!.basket, ["NVDA", "AAPL"]);
  m.expireLastToolWait();
  assert.equal(field(m, "Assets to consider").value, "stocks");
  assert.equal(field(m, "Basket symbols").value, "NVDA, AAPL");
  assert.equal(field(m, "Assets to consider").closest("details")!.open, true, "edited fields remain discoverable after waiting");
  assert.equal(calls(m).length, 1, "waiting never submits a second draft");
  const result = draftResult("create");
  await answer(m, call, { ...result, summary: { ...result.summary, settings: { agentName: "Marian", assetMode: "stocks", basketSymbols: ["NVDA", "AAPL"] } } });
  assert.equal(m.doc.querySelectorAll(".mm-brand").length, 1);
  assert.equal(m.doc.querySelector(".home-hero"), null, "the overview hero is not repeated above the approval");
  assert.equal(m.doc.querySelectorAll(".mm-setup-card").length, 1);
  assert.equal(m.doc.querySelectorAll(".mm-setup-card a.cta").length, 1);
  const details = m.doc.querySelector<HTMLDetailsElement>(".setup-details")!;
  assert.equal(details.open, false);
  assert.match(details.textContent!, /Marian/);
  assert.match(details.textContent!, /stocks/);
  assert.match(details.textContent!, /NVDA, AAPL/);
  assert.equal(calls(m).length, 1, "showing owner approval does not sign or activate");
});

test("home shows one next step while keeping later owner actions available in disclosure", async () => {
  const m = await start(setup({ phase: "permission_expired", next_steps: [
    { action: "renew_permission", label: "Renew trading permission", detail: "Owner signing is required to renew the existing permission.", url: ISSUER + "/grant", tool: null, owner_action_required: true },
    { action: "inspect_status", label: "Inspect worker status", detail: "Check the last worker report before changing settings.", url: ISSUER + "/agent", tool: null, owner_action_required: false },
  ] }));
  const next = m.doc.querySelector(".home-next")!;
  assert.match(next.textContent!, /Renew trading permission/);
  assert.doesNotMatch(next.textContent!, /Inspect worker status/);
  assert.equal(next.querySelector("a")!.getAttribute("href"), ISSUER + "/grant");
  const more = [...m.doc.querySelectorAll<HTMLDetailsElement>("details")].find(details => details.querySelector("summary")?.textContent === "More options")!;
  assert.equal(more.open, false);
  assert.match(more.textContent!, /Inspect worker status/);
  assert.equal(more.querySelector("a")!.getAttribute("href"), ISSUER + "/agent");
  assert.equal(calls(m).length, 0, "disclosing actions does not run them");
});

test("retrying a slow host request keeps its key and ignores an older result during the retry", async () => {
  const m = await start(); await loadSettings(m); change(m, "Name", "Marian"); submit(m, "Name"); const first = last(m, "create_agent_draft");
  m.expireLastToolWait(); submit(m, "Name"); const retry = last(m, "create_agent_draft");
  assert.notEqual(retry.id, first.id); assert.deepEqual(retry.params!.arguments, first.params!.arguments);
  await answer(m, first, draftResult());
  assert.equal(m.doc.querySelector(`a[href="${ISSUER}/connect/approve/${PID}"]`), null);
  assert.match(m.doc.querySelector(".home-status")!.textContent!, /Working/);
  assert.ok(m.doc.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled);
  await answer(m, retry, draftResult());
  assert.ok(m.doc.querySelector(`a[href="${ISSUER}/connect/approve/${PID}"]`));
});

test("a delayed host approval cannot restore the previous connection's setup", async () => {
  const initial = setup({ agent: null, phase: "no_shared_agent", connection: { ...setup().connection, shared_agent_count: 0, available_tools: ["get_merryman_setup", "create_merryman"] } });
  const m = await start(initial); change(m, "Name", "Private draft"); submit(m, "Name"); const call = last(m, "create_merryman");
  m.expireLastToolWait();
  await show(m, setup({ ...initial, connection: { ...initial.connection, id: "connection-test-b" } }));
  await answer(m, call, draftResult("create"));
  assert.equal(field(m, "Name").value, "My Merryman");
  assert.equal(m.doc.querySelector(`a[href="${ISSUER}/connect/approve/${PID}"]`), null);
  assert.doesNotMatch(m.text(), /Draft prepared|Private draft/);
});

test("a cancelled configuration draft does not trap an identical new intent behind its old idempotency key", async () => {
  const m = await start(); await loadSettings(m); change(m, "Name", "Marian"); submit(m, "Name"); const first = last(m, "create_agent_draft"); await answer(m, first, draftResult());
  click(m, "Cancel draft"); click(m, "Confirm cancel draft"); await answer(m, last(m, "cancel_proposal"), proposal({ kind: "agent_draft", status: "cancelled", terminal: true, approval_url: null }));
  click(m, "Settings"); await answer(m, last(m, "get_agent_settings"), settings()); change(m, "Name", "Marian"); submit(m, "Name"); const next = last(m, "create_agent_draft");
  assert.equal(next.params!.arguments?.name, "Marian"); assert.notEqual(next.params!.arguments?.idempotency_key, first.params!.arguments?.idempotency_key);
});

test("percent and hour fields convert exactly to bounded stored units, without silently rounding invalid precision", async () => {
  const m = await start(); await loadSettings(m); change(m, "New value (%)", "0.555"); const before = calls(m).length; submit(m, "New value (%)"); assert.equal(calls(m).length, before);
  change(m, "Preference to change", "classMaxHoldSec"); change(m, "New value (hours)", "0.5"); submit(m, "New value (hours)"); const call = last(m, "propose_settings_change"); assert.deepEqual(call.params!.arguments?.changes, { classMaxHoldSec: 1800 }); await fail(m, call);
  change(m, "New value (hours)", "0.0001"); submit(m, "New value (hours)"); assert.equal(calls(m).at(-1), call);
  change(m, "New value (hours)", "0.50001"); submit(m, "New value (hours)"); assert.equal(calls(m).at(-1), call);
});

test("switching agentless OAuth connections clears unsent forms, proposal data and retry keys", async () => {
  const initial = setup({ agent: null, phase: "no_shared_agent", connection: { ...setup().connection, shared_agent_count: 0, available_tools: ["get_merryman_setup", "create_merryman"] } });
  const m = await start(initial); change(m, "Name", "Private draft");
  await show(m, setup({ ...initial, connection: { ...initial.connection, id: "connection-test-b" } })); assert.equal(field(m, "Name").value, "My Merryman");
  change(m, "Name", "Marian"); submit(m, "Name"); const first = last(m, "create_merryman"); await answer(m, first, draftResult("create")); assert.ok(m.doc.querySelector(`a[href="${ISSUER}/connect/approve/${PID}"]`));
  await show(m, initial); assert.equal(m.doc.querySelector(`a[href="${ISSUER}/connect/approve/${PID}"]`), null); assert.equal(field(m, "Name").value, "My Merryman");
  change(m, "Name", "Marian"); submit(m, "Name"); assert.notEqual(last(m, "create_merryman").params!.arguments?.idempotency_key, first.params!.arguments?.idempotency_key);
});

test("reviewing an unrelated terminal proposal does not discard the current pending draft's retry key", async () => {
  const m = await start(); await loadSettings(m); change(m, "Name", "Marian"); submit(m, "Name"); const first = last(m, "create_agent_draft"); await answer(m, first, draftResult());
  click(m, "Back to approvals"); const old = proposal({ proposal_id: "prp_" + "c".repeat(32), status: "applied", terminal: true, approval_url: null });
  await answer(m, last(m, "list_proposals"), { proposals: [old] }); click(m, "Review proposal"); await answer(m, last(m, "get_proposal"), old);
  click(m, "Settings"); await answer(m, last(m, "get_agent_settings"), settings()); change(m, "Name", "Marian"); submit(m, "Name");
  assert.equal(last(m, "create_agent_draft").params!.arguments?.idempotency_key, first.params!.arguments?.idempotency_key);
});

test("tool failures show the human message and retry timing without JSON, protocol codes or trace ids", async () => {
  const body = errorBody(new McpError("upstream_unavailable", "Your Telegram link could not be read right now.", { retryAfterSec: 30 }), "private-trace-123");
  const content = [{ type: "text", text: `Error upstream_unavailable: ${body.error.message} Retry after 30s.\n\n${JSON.stringify(body)}` }];
  const replies = [
    { result: { isError: true, _meta: { [ERROR_META_KEY]: body.error }, content } },
    { result: { isError: true, content } },
    { error: { code: -32603, message: `upstream_unavailable: ${body.error.message}`, data: body.error } },
    { result: { isError: true, content: [{ type: "text", text: `Error upstream_unavailable: ${body.error.message} Retry after 30s.` }] } },
  ];
  for (const reply of replies) {
    const m = await start(); click(m, "Alerts"); await answer(m, last(m, "list_subscriptions"), subscriptions()); click(m, "Check alert channel");
    const call = last(m, "list_notification_channels"); m.deliver({ jsonrpc: "2.0", id: call.id, ...reply }); await m.tick();
    const status = m.doc.querySelector('.home-status')!.textContent!;
    assert.match(status, /^Your Telegram link could not be read right now\. Retry after 30(?: seconds|s)\.$/);
    assert.doesNotMatch(status, /upstream_unavailable|trace|private|retryable|\{|\}|-32603/);
    assert.equal((status.match(/Retry after/g) ?? []).length, 1, "no duplicate retry instruction");
    assert.ok(![...m.doc.querySelectorAll<HTMLButtonElement>('[role="tab"]')].some(b => b.disabled));
    assert.equal(calls(m).length, 2, "failure never automatically retries or creates an alert");
  }
});
