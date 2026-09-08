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
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const AGENT = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");

/** The `.desk-chat-bottom` block, where the card and the composer both live. */
const BOTTOM = AGENT.slice(AGENT.indexOf('className="desk-chat-bottom"'));

describe("nothing happens without a click", () => {
  it("THE PROPOSAL IS ONLY EVER STORED, NEVER RUN", () => {
    // The whole property in one line: what arrives from /api/chat goes into
    // state. If `send` ever called `confirm` — or fetched a route itself off
    // the back of `data.command` — the model would be acting, and the chat
    // context is attacker-influenced (another agent writes a position's
    // `reason`, and it is fed to this prompt).
    const send = AGENT.slice(AGENT.indexOf("const send = async"), AGENT.indexOf("const confirm = async"));
    assert.match(send, /setPending\(data\.command && commandFor\(data\.command\.id\) \? data\.command : null\)/);
    assert.ok(!/confirm\(/.test(send), "send must not invoke the command it just received");
  });

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
    assert.match(BOTTOM, /\{pending && commandFor\(pending\.id\) &&/);
  });
});

describe("a proposal does not outlive the conversation on screen", () => {
  it("PENDING IS STATE, NOT A PERSISTED TURN", () => {
    // Turns are written to this browser's storage (chat-store.ts). A card
    // restored from storage would be an offer to act, made by nobody, on a
    // page reopened days later — and confirmed against whatever the settings
    // say then, not what they said when it was proposed.
    assert.match(AGENT, /const \[pending,setPending\]=useState<\{id:string;args:Record<string,CommandArg>\}\|null>\(null\)/);
    // THE onTurn CALL ITSELF, not the lines around it — `setPending` sits two
    // lines below and mentions `command`, so a looser slice would pass while
    // asserting nothing. Every argument to the persisted turn, listed:
    const at = AGENT.indexOf("onTurn({question:question.trim()");
    const turn = AGENT.slice(at, AGENT.indexOf(";", at));
    assert.equal(turn, "onTurn({question:question.trim(),answer:data.reply})");
  });
});

describe("what it does when confirmed", () => {
  const CONFIRM = AGENT.slice(AGENT.indexOf("const confirm = async"), AGENT.indexOf("const blocked = blockerAdvice"));

  it("SENDS ONLY THE DECLARED KEYS, THROUGH THE ROUTE THAT ALREADY EXISTS", () => {
    // Not a new write path. The same authenticated PUT the settings screen
    // uses, carrying nothing but `writes` — and /api/settings strips every
    // house-owned field again on the server, so this is one of two gates.
    assert.match(CONFIRM, /fetch\("\/api\/settings", \{/);
    assert.match(CONFIRM, /JSON\.stringify\(settingsPayload\(cmd, pending!\.args\)\)/);
    assert.ok(!/\.\.\.pending/.test(CONFIRM), "the raw args must never be spread into the body");
  });

  it("a navigate command writes nothing on its way", () => {
    // It returns before the PUT. A command that both moved you and wrote
    // something would be two acts behind one sentence.
    const nav = CONFIRM.indexOf('cmd.via === "navigate"');
    const put = CONFIRM.indexOf('fetch("/api/settings"');
    assert.ok(nav > 0 && nav < put, "the navigate branch must return before any write");
    assert.match(CONFIRM.slice(nav, put), /return;/);
  });

  it("A REFUSAL IS REPORTED, NOT SWALLOWED", () => {
    // The settings route answers with `errors`. Saying "done" over a rejected
    // write is the same class of lie as reporting a trade that never landed.
    assert.match(CONFIRM, /if \(!put\.ok\)/);
    assert.match(CONFIRM, /errors\?\.join/);
    assert.match(CONFIRM, /setChatError\(/);
  });

  it("and what happened is said back in the conversation", () => {
    // Where they asked is where they should be told. And it is the registry's
    // sentence again, so the confirmation and the receipt cannot disagree.
    assert.match(CONFIRM, /onTurn\(\{ question: "✓ confirmed", answer: `Done — \$\{cmd\.say\(pending!\.args\)\}` \}\)/);
  });
});
