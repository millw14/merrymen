/**
 * "IF SOMEONE WANT TO BUILD A STRATEGY ON PONS TOKENS OR LONG TOKENS OR STOCKS
 * ONLY, YOU SHOULD HAVE A STEP BY STEP SETTING THAT LET YOU CHOOSE THE BASKET
 * AND ALSO ADD ADRESSES."
 *
 * The wizard had four steps and asked about none of that. A new agent got the
 * three-symbol equity default, and every universe decision was deferred to
 * Settings — where the same owner then found a basket "full of all stocks",
 * added a coin, saved, re-signed, and still had an agent that traded only
 * stocks.
 *
 * THE REASON THIS STEP IS WORTH A WHOLE SCREEN is not that it saves clicks. It
 * is that it happens BEFORE the signature. `create()` seals `extraTokens` into
 * the grant it mints, so a coin named here is covered by the FIRST permission —
 * no re-sign, no coverage banner, and no `no-exit` refusal. The identical coin
 * added an hour later needs a second signature before it can be SOLD, and until
 * that lands every buy of it is refused. Same coin, same owner; the only
 * difference is which side of the signature they were on.
 *
 * The assertion that matters most in this file is the local merge: `settings` is
 * fetched BEFORE the PUT, so re-reading it for the mint would silently drop
 * every coin the owner just named — storing them and then leaving them out of
 * the signature, which is exactly the trap the step exists to remove.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("./screens/CreateAgent.tsx", import.meta.url), "utf8");
/** Comments stripped — this file explains its own reasoning at length. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

describe("the wizard asks what to trade", () => {
  it("THERE IS A MARKET STEP, between naming it and setting limits", () => {
    assert.match(code, /"agent"\|"market"\|"limits"\|"backup"\|"fund"/);
    assert.match(code, /\["agent","market","limits","backup","fund"\]\.indexOf\(step\)/);
  });

  it("and the progress list counts it, so the owner is not surprised by a fifth screen", () => {
    assert.match(code, /\["Agent","Market","Limits","Backup","Ready"\]/);
  });

  it("BACK GOES BACK THROUGH IT, rather than skipping a step the owner just filled in", () => {
    assert.match(code, /step==="limits"\?setStep\("market"\):step==="market"\?setStep\("agent"\):onBack\(\)/);
  });

  it("and the agent step leads into it", () => {
    assert.match(code, /setStep\("market"\)/);
  });
});

describe("a coin named in the wizard is covered by the first signature", () => {
  it("THE MINT MERGES WIZARD TOKENS LOCALLY — it does not re-read settings", () => {
    // The whole payoff, and the one line that would silently undo it.
    // `settings` is fetched BEFORE the PUT, so re-reading
    // `settings.values.customTokens` here would miss everything just added:
    // stored, then left out of the signature, then refused on `no-exit`.
    const at = code.indexOf("const mintOptions=");
    assert.ok(at > 0, "the mint options must still be built here");
    const opts = code.slice(at, code.indexOf("};", at));
    assert.match(opts, /extraTokens:\[\.\.\.\(\(settings\.values\.customTokens\?\?\[\]\)/);
    assert.match(opts, /\.\.\.wizardTokens\]/, "the wizard's own coins travel with them");
  });

  it("and the settings write carries them too, so the worker sees the same list", () => {
    // Both, not either: the signature decides what CAN be sold, the settings
    // decide what the agent watches and proposes. A coin in one and not the
    // other is the two-gate trap in a new costume.
    const at = code.indexOf("/api/settings\",{method:\"PUT\"");
    assert.ok(at > 0);
    const put = code.slice(at, code.indexOf("});", at));
    assert.match(put, /customTokens:\[/);
    assert.match(put, /wizardTokens/);
    assert.match(put, /basketSymbols:basket/, "and what to trade");
    assert.match(put, /assetMode/, "and which markets");
  });

  it("ONE ROUND TRIP — the answers ride the write that was already happening", () => {
    assert.equal(
      (code.match(/requestJson\("\/api\/settings",\{method:"PUT"/g) ?? []).length,
      1,
      "a second PUT would be a second way for the two halves to disagree",
    );
  });
});

describe("adding a coin here does both writes, like everywhere else", () => {
  it("IT IS ADDED AND SELECTED", () => {
    // Same rule as the Settings screen: "know about this" and "trade it" are
    // two different writes, and hiding the second is what made it a trap.
    const at = code.indexOf("add coin");
    assert.ok(at > 0, "the control must exist");
    const handler = code.slice(code.lastIndexOf("onClick", at) - 1200, at);
    assert.match(handler, /setWizardTokens/);
    assert.match(handler, /setBasket/);
  });

  it("and it refuses a malformed address rather than sealing one into a signature", () => {
    // This list is minted into the wall. A bad entry here is not a typo in a
    // settings file, it is a permission.
    assert.match(code, /isValidCustomToken\(candidate\)/);
  });

  it("and will not let the owner leave with nothing to trade", () => {
    // "crypto only" with no coins added resolves to zero legs — an agent that
    // does nothing, for a reason no screen would otherwise connect to a choice
    // made here.
    assert.match(code, /disabled=\{basket\.length===0\}/);
  });
});
