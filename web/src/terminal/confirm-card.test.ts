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
    assert.match(BOTTOM, /\{pending && commandFor\(pending\.id\) &&/);
  });
});
