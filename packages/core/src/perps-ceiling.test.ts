/**
 * MERRYMEN_PERPS HAS ONE PARSER, and it only ever takes capability away.
 *
 * The worker, the orchestrator and the web all read the lever through
 * perps-ceiling.ts, so a value means one thing everywhere. Unset is off,
 * `live` is off in this build, and anything unrecognised is off: a typo in a
 * variable that exists to take capability away must not hand it back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERPS_CEILINGS, perpsCeilingNote, perpsCeilingOf } from "./perps-ceiling";

describe("perpsCeilingOf", () => {
  it("unset, empty and off are off", () => {
    for (const raw of [undefined, "", "  ", "off", "OFF", " off "]) assert.equal(perpsCeilingOf(raw), "off", String(raw));
  });

  it("paper is paper, however it is spelled in case and space", () => {
    for (const raw of ["paper", "Paper", " PAPER "]) assert.equal(perpsCeilingOf(raw), "paper", raw);
  });

  it("live is OFF in this build, never practice perps an operator believes are real", () => {
    for (const raw of ["live", "Live", " LIVE "]) assert.equal(perpsCeilingOf(raw), "off", raw);
  });

  it("anything it does not recognise is off", () => {
    for (const raw of ["lvie", "1", "true", "on", "yes", "paper,live", "papers"]) assert.equal(perpsCeilingOf(raw), "off", raw);
  });

  it("answers only with a ceiling it names", () => {
    for (const raw of [undefined, "paper", "live", "x"]) assert.ok((PERPS_CEILINGS as readonly string[]).includes(perpsCeilingOf(raw)));
  });
});

describe("perpsCeilingNote", () => {
  it("is silent when the operator asked for nothing more than this build gives", () => {
    for (const raw of [undefined, "", "off", "paper", " Paper "]) assert.equal(perpsCeilingNote(raw), null, String(raw));
  });

  it("says so when it asked for more", () => {
    assert.match(perpsCeilingNote("live") ?? "", /not in this build, so perps are OFF/);
    assert.match(perpsCeilingNote("lvie") ?? "", /is not off, paper or live, so perps are OFF/);
  });
});
