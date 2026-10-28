/**
 * THE CARD IS THE BOUNDARY. THIS PINS THE CARD.
 *
 * `chat-commands.test.ts` pins the registry: an unknown id is not a command,
 * a command cannot write a field it did not declare, and the sentence is ours.
 * All of that is worth nothing if the screen renders the model's words, or
 * fires the command without a click, or lets a proposal survive a refresh and
 * be confirmed days later by an owner who never saw the conversation.
 *
 * Those three properties live in JSX, so this reads the JSX. Same discipline as
 * honesty.test.ts, which source-reads the file whose words are the property.
 *
 * WHAT THIS NO LONGER READS, BECAUSE IT IS RUN. The chat moved into an
 * App-level controller (chat-controller.ts) and the screen only draws it, so
 * four of the checks below were pins on code that no longer exists. They are
 * executed instead, against the real screen in a DOM, in
 * chat-controller.test.ts: a proposal is never stored and a reload shows no
 * card ("IT IS NEVER STORED"); nothing runs without the click, and declining
 * calls nothing ("AND NOTHING RUNS WITHOUT THE CLICK"); a refused write is said
 * in the thread and never answered "Done" ("A REFUSED SETTING IS NEVER CALLED
 * DONE"); and a confirmed setting is said back in the registry's own sentence.
 * Three more followed when the card's guard moved into the controller, where
 * two screens can share it: the proposal is only ever held, never run ("AND
 * NOTHING RUNS WITHOUT THE CLICK"); a confirmed setting sends only its declared
 * keys, through the settings route ("ONLY THE DECLARED KEYS"); and a navigate
 * command writes nothing on its way ("A NAVIGATE COMMAND WRITES NOTHING").
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { ChatController } from "./chat-controller";
import type { LiveMine } from "./live";
import { Agent } from "./screens/Agent";

(globalThis as unknown as { React: typeof React }).React = React;
const noop = () => {};
const held: FleetRecoveryView = { state: "history-only", tradingPaused: true, history: "available",
  memory: "unknown", checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: null };
const mine: LiveMine = { name: "Example Robin", slug: "example", handle: null, owner: "you", mode: "live",
  equity: 120, chg24: null, moves: [], thesis: null, statusLabel: "LIVE", glance: { id: "custom", label: "", cashUsd: 95 },
  autonomy: autonomyOf({ mode: "live", liveBlocker: null }) };
function renderProposal(proposal: ChatController["proposal"], recovery?: FleetRecoveryView) {
  let confirms = 0;
  const chat = { draft: "", setDraft: noop, proposal, setProposal: noop, confirming: false, messages: [],
    sending: false, streaming: "", ceiling: 10, confirm: () => { confirms++; } } as unknown as ChatController;
  const page = new JSDOM(renderToStaticMarkup(React.createElement(Agent, { mine: { ...mine, recovery }, tokens: [],
    stopped: false, chat, perTrade: 10, perDay: 20, liveBlocker: null, onToken: noop, onDeposit: noop,
    onWithdraw: noop, onLimits: noop, onResign: noop, onSettings: noop }))).window.document;
  assert.equal(confirms, 0, "rendering a proposal never confirms it");
  return page;
}

const AGENT = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");

/** The `.desk-chat-bottom` block, where the card and the composer both live. */
const BOTTOM = AGENT.slice(AGENT.indexOf('className="desk-chat-bottom"'));

describe("nothing happens without a click", () => {
  it("and the button that runs it is a button, wired to confirm", () => {
    assert.match(BOTTOM, /onClick=\{confirm\}/);
    // Not a form submit and not an effect: a click, from a person, on a
    // control they can see.
    assert.ok(!/useEffect\([^)]*confirm/.test(AGENT), "confirm must not fire from an effect");
  });

  it("DECLINING IS ALWAYS ON SCREEN BESIDE IT", () => {
    // A card with only one button is not a confirmation, it is a prompt to
    // comply. Dismiss clears the proposal and calls nothing.
    assert.match(BOTTOM, /onClick=\{\(\) => setPending\(null\)\}/);
  });
});

describe("the words on the card are ours", () => {
  it("THE SENTENCE COMES FROM THE REGISTRY, NOT FROM THE REPLY", () => {
    // If the card rendered model-written text it could describe one action and
    // request another, and the click would confirm the description.
    assert.match(BOTTOM, /commandFor\(pending\.id\)!\.say\(pending\.args\)/);
    // And nothing off the wire is rendered as the description.
    assert.ok(
      !/desk-confirm[\s\S]{0,400}\{pending\.(say|text|label|description)/.test(BOTTOM),
      "the card must not render a field supplied by the model",
    );
  });

  it("a command the client cannot describe is not shown at all", () => {
    // Fail-closed, a second time, in the browser. The route already validates
    // against the registry; this is the client refusing to render a card for
    // anything it cannot put a sentence on.
    const known = renderProposal({ id: "buy", args: { symbol: "EXAMPLE", usdgAmount: 5 } });
    const card = known.querySelector(".desk-confirm");
    assert.ok(card, "a registered proposal can be reviewed by its owner");
    assert.deepEqual([...card.querySelectorAll("button")].map(button => [button.type, button.textContent]),
      [["button", "Yes, do it"], ["button", "Not now"]]);
    for (const proposal of [null, { id: "unknown-command", args: {} }]) {
      const page = renderProposal(proposal);
      assert.equal(page.querySelector(".desk-confirm"), null, "an absent or unknown proposal offers no confirmation");
    }
  });

  it("a recovery hold hides financial confirmations while keeping the owner's Withdraw control", () => {
    const page = renderProposal({ id: "buy", args: { symbol: "EXAMPLE", usdgAmount: 5 } }, held);
    assert.equal(page.querySelector(".desk-confirm"), null, "a stale financial proposal cannot be confirmed during recovery");
    assert.match(page.body.textContent!, /Trading paused for recovery/);
    assert.ok([...page.querySelectorAll("button")].some(button => button.textContent === "Withdraw"),
      "the owner's separate Withdraw screen remains accessible");
  });
});
