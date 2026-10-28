/** Compact setup cards still carry an exact, owner-approved proposal. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { APPS_PROTOCOL_VERSION, appHtml } from "./apps";

const ISSUER = "https://app.test";
const PID = "prp_" + "a".repeat(32);
const OTHER_PID = "prp_" + "b".repeat(32);
const BINDING = "ce".repeat(32);
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const APPROVAL = `${ISSUER}/connect/approve/${PID}`;

function draft(over: Record<string, unknown> = {}) {
  return {
    proposal_id: PID, kind: "agent_draft", status: "awaiting_approval", approval_url: APPROVAL,
    expires_at: FUTURE, binding_hash: BINDING, created: true,
    summary: {
      action: "Create a new Merryman", purpose: "create", risk_level: "careful", requested_by: "Grok Bot",
      settings: {
        agentName: "Marian", strategy: "steady-basket", basketSymbols: ["NVDA", "AAPL"],
        assetMode: "stocks", slippageBps: 50, buyPerTickUsdg: 10, classMaxHoldSec: 7200,
      },
      left_out: [{ key: "maxImpactBps", why: "The price-impact safety floor stays unchanged." }],
      after_approval: "Owner wallet creation and permission signing are still required.",
    },
    next_steps: "Review the exact setup and sign the wallet permission in Merrymen.",
    risk_profile: null, left_out: [], diff: null, ...over,
  };
}

interface Message { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown> }
const opened: JSDOM[] = [];
afterEach(() => { while (opened.length) opened.pop()!.window.close(); });

async function show(data: unknown, options: { openLinks?: boolean; issuer?: string } = {}) {
  const sent: Message[] = [];
  const host = { postMessage(message: Message) { sent.push(JSON.parse(JSON.stringify(message)) as Message); } };
  const dom = new JSDOM(appHtml("proposal", { issuer: options.issuer ?? ISSUER }), {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://sandbox.example/",
    beforeParse(w) { (w as unknown as { parent: unknown }).parent = host; },
  });
  opened.push(dom);
  const w = dom.window;
  const deliver = (message: unknown) => w.dispatchEvent(new w.MessageEvent("message", { data: message, source: host as never }));
  const initialize = sent.find(message => message.method === "ui/initialize");
  assert.ok(initialize);
  deliver({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: APPS_PROTOCOL_VERSION, hostCapabilities: options.openLinks === false ? {} : { openLinks: {} }, hostContext: {} } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: data } });
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  const root = w.document.getElementById("app")!;
  return { w, doc: w.document, sent, deliver, root, text: () => root.textContent ?? "" };
}

function initiallyVisibleText(root: Element) {
  const copy = root.cloneNode(true) as Element;
  copy.querySelectorAll("details:not([open])").forEach(details => details.replaceChildren(details.querySelector("summary")!.cloneNode(true)));
  return copy.textContent ?? "";
}

test("setup card leads with one owner action and keeps reference data in a closed disclosure", async () => {
  const m = await show(draft());
  const card = m.doc.querySelector(".mm-setup-card");
  assert.ok(card);
  assert.match(initiallyVisibleText(card), /merrymen/i);
  assert.match(initiallyVisibleText(card), /Marian/);
  assert.equal(card.querySelectorAll("a.cta").length, 1);
  assert.equal(card.querySelector("a.cta")!.getAttribute("href"), APPROVAL);
  const reference = card.querySelector<HTMLDetailsElement>("details.setup-reference");
  assert.ok(reference);
  assert.equal(reference.open, false);
  for (const raw of [PID, BINDING, APPROVAL]) {
    assert.ok(reference.textContent!.includes(raw), `reference retains ${raw}`);
    assert.ok(!initiallyVisibleText(card).includes(raw), "raw references do not crowd the primary action");
  }
  assert.equal(m.sent.filter(message => /tools\/call|ui\/open-link/.test(message.method ?? "")).length, 0, "rendering never calls a tool or opens a page");
});

test("collapsed setup details preserve the exact proposed configuration, units and unchanged limits", async () => {
  const m = await show(draft());
  const details = m.doc.querySelector<HTMLDetailsElement>("details.setup-details");
  assert.ok(details);
  assert.equal(details.open, false);
  const text = details.textContent ?? "";
  for (const expected of ["Marian", "NVDA, AAPL", "stocks", "0.5%", "10 USDG", "2 hours"]) assert.ok(text.includes(expected), `details retain ${expected}`);
  assert.match(text, /steady.basket/i);
  assert.match(m.text(), /careful/i);
  assert.match(initiallyVisibleText(m.root), /expir/i, "the expiry remains visible without opening details");
  assert.match(initiallyVisibleText(m.root), /The price-impact safety floor stays unchanged\./, "unchanged safety limits stay visible");
});

test("settings card preserves the exact before and after values and requires owner approval", async () => {
  const m = await show(draft({ kind: "settings", summary: {
    action: "Change slippage", requested_by: "Grok Bot", diff: [
      { key: "slippageBps", label: "Max slippage", current: "0.5%", proposed: "0.8%", help: "Maximum accepted price move." },
    ], after_approval: "Approval changes your saved preferences.",
  } }));
  const details = m.doc.querySelector<HTMLDetailsElement>("details.setup-details");
  assert.ok(details);
  assert.equal(details.open, false);
  const rows = Array.from(details.querySelectorAll("tbody tr")).map(row => Array.from(row.querySelectorAll("td")).map(cell => cell.textContent));
  assert.deepEqual(rows, [["Max slippage", "0.5%", "0.8%"]]);
  assert.equal(m.doc.querySelectorAll("a.cta").length, 1);
  assert.equal(m.doc.querySelector("a.cta")!.getAttribute("href"), APPROVAL);
  assert.match(initiallyVisibleText(m.root), /approv/i);
  assert.equal(m.sent.filter(message => message.method === "tools/call").length, 0);
});

test("compact setup card rejects foreign, mismatched and decorated approval links", async () => {
  for (const approval_url of [
    "javascript:alert(1)", `https://evil.test/connect/approve/${PID}`,
    `https://app.test.evil.test/connect/approve/${PID}`, `https://user:secret@app.test/connect/approve/${PID}`,
    `${ISSUER}/connect/approve/${OTHER_PID}`, `${APPROVAL}?next=https://evil.test`, `${APPROVAL}#approved`,
    `${ISSUER}/connect/setup/${PID}`, `${ISSUER}/somewhere-else`,
  ]) {
    const m = await show(draft({ approval_url }));
    assert.equal(m.doc.querySelectorAll("a").length, 0, `unsafe address is not linked: ${approval_url}`);
    assert.match(initiallyVisibleText(m.root), /not.*(?:linked|verified|approval page)|unavailable|cannot|could not/i, "the owner sees why the action is unavailable");
    assert.equal(m.sent.filter(message => message.method === "ui/open-link").length, 0);
  }
  for (const options of [{ issuer: "" }, {}]) {
    const m = await show(draft({ proposal_id: "prp_invalid", approval_url: `${ISSUER}/connect/approve/prp_invalid` }), options);
    assert.equal(m.doc.querySelectorAll("a").length, 0, "a malformed binding id is never approvable");
  }
});

test("expired or cancelled setup cards never offer approval or continuation", async () => {
  for (const status of ["awaiting_approval", "applied"]) {
    const m = await show(draft({ status, expires_at: PAST, result: status === "applied" ? { setup_only: true } : null }));
    assert.equal(m.doc.querySelectorAll("a.cta").length, 0, `${status} has expired`);
    assert.match(initiallyVisibleText(m.root), /expired/i);
  }
  for (const [status, wording] of [["cancelled", /cancelled/i], ["rejected", /declined|rejected/i], ["failed", /failed|needs attention/i], ["expired", /expired/i]] as const) {
    const m = await show(draft({ status, terminal: true }));
    assert.equal(m.doc.querySelectorAll("a.cta").length, 0, `terminal ${status} does not offer approval even if a URL was returned`);
    assert.match(initiallyVisibleText(m.root), wording);
  }
});

test("approved creation continues the exact owner setup while activation remains unconfirmed", async () => {
  const m = await show(draft({ status: "applied", terminal: true, approval_url: null, result: { setup_only: true, setup_url: "https://evil.test/steal", note: "Your setup is saved; owner signing is required." } }));
  const link = m.doc.querySelector<HTMLAnchorElement>("a.cta");
  assert.ok(link);
  assert.equal(link.href, `${ISSUER}/connect/setup/${PID}`);
  assert.equal(m.doc.querySelectorAll('a[href^="https://evil.test"]').length, 0);
  const steps = Array.from(m.doc.querySelectorAll(".setup-progress li"));
  assert.equal(steps.length, 3);
  assert.match(steps[2]!.textContent!, /Activation/i);
  assert.ok(!steps[2]!.classList.contains("done"), "approval cannot mark activation complete");
  assert.match(initiallyVisibleText(m.root), /(?:activation|running).*(?:not|still)|(?:not|still).*(?:activation|running)|signing.*required/i);
  assert.doesNotMatch(initiallyVisibleText(m.root), /https:\/\/evil\.test|setup[_ ]only|setup[_ ]url/i, "technical result fields do not crowd the visible approval state");
  assert.match(initiallyVisibleText(m.root), /Your setup is saved; owner signing is required\./, "result guidance remains visible");
  assert.equal(m.sent.filter(message => message.method === "tools/call").length, 0);

  const settings = await show(draft({ status: "applied", kind: "settings", summary: { action: "Change slippage" }, approval_url: APPROVAL, result: { applied: true } }));
  assert.equal(settings.doc.querySelectorAll("a.cta").length, 0, "an applied settings change is not a creation handoff");
});

test("the only setup action opens the exact approved path through the host after a click", async () => {
  const m = await show(draft());
  const link = m.doc.querySelector<HTMLAnchorElement>("a.cta")!;
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  link.dispatchEvent(new m.w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const opens = m.sent.filter(message => message.method === "ui/open-link");
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0]!.params, { url: APPROVAL });
  assert.equal(m.sent.filter(message => message.method === "tools/call").length, 0, "the iframe never approves or signs");
  m.deliver({ jsonrpc: "2.0", id: opens[0]!.id, result: { isError: true } });
  assert.match(m.text(), /did not open|could not open/i);
  const reference = m.doc.querySelector<HTMLDetailsElement>("details.setup-reference")!;
  assert.equal(reference.open, true, "failed host navigation reveals the exact address for browser fallback");
  assert.equal(reference.closest<HTMLDetailsElement>("details.setup-details")!.open, true, "the outer configuration disclosure also opens for fallback");
  assert.ok(initiallyVisibleText(m.root).includes(APPROVAL));

  const fallback = await show(draft(), { openLinks: false });
  const click = new fallback.w.MouseEvent("click", { bubbles: true, cancelable: true });
  const anchor = fallback.doc.querySelector<HTMLAnchorElement>("a.cta")!;
  let prevented = true;
  anchor.addEventListener("click", event => { prevented = event.defaultPrevented; event.preventDefault(); });
  anchor.dispatchEvent(click);
  assert.equal(prevented, false, "plain anchor navigation remains available without openLinks");
});

test("assistant supplied setup text cannot become markup or an approval affordance", async () => {
  const attack = '<img src=x onerror="alert(1)"><a href="https://evil.test">Approve</a>';
  const source = draft();
  const m = await show(draft({ summary: { ...source.summary, settings: { ...source.summary.settings, agentName: attack }, assistant_note: attack, requested_by: attack } }));
  assert.equal(m.doc.querySelectorAll("img,iframe").length, 0);
  assert.equal(m.doc.querySelectorAll("script").length, 1, "only the static application script exists");
  assert.equal(m.doc.querySelectorAll("a").length, 1, "only the validated approval action is a link");
  assert.ok(m.doc.querySelector(".ut-inline"), "assistant-provided names remain marked as third-party text");
  assert.ok(m.doc.querySelector(".untrusted"), "assistant notes remain visibly separated as third-party text");
});
