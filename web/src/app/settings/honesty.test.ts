import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * WHAT /settings MUST STILL DO AFTER IT IS RESTYLED.
 *
 * This file exists BEFORE the migration, not after it, and that ordering is the
 * whole point. A sibling investigation proved by mutation that seventeen
 * separate regressions to the grant and settings flows pass this repo's entire
 * suite — including deleting an RCE warning, unbinding a hosted provider filter
 * that exists to stop SSRF, and putting a redacted secret into an editable
 * input. Every one of those survives a class rename with the strings intact,
 * because nothing asserted the WIRING.
 *
 * A restyle touches roughly forty class names across 1,359 lines. The review
 * surface is far too large to eyeball, so the properties are written down first
 * and the diff is measured against them.
 *
 * Source scans, in the idiom of app/(app)/t/[token]/honesty.test.ts: these are
 * properties of how the page is WRITTEN, and a render test passes on a branch
 * that never fired.
 */

const SRC = readFileSync(new URL("../../terminal/screens/Settings.tsx", import.meta.url), "utf8");

/**
 * The same source with comments removed.
 *
 * Every "must not contain" assertion runs against this, because this codebase
 * explains its refusals right where it makes them and a comment describing a
 * forbidden shape would otherwise fail the rule that forbids it.
 */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * EVERY FIELD ON THE PAGE, so a dropped one is a failing diff rather than a
 * discovery. Measured before the migration began.
 */
const FIELDS = [
  "Claude / vision model",
  "Strategist decision interval",
  "LLM max per action",
  "Pimlico API key",
  "Pons curve adapter contract",
  "Class vault factory contract",
  "Rialto integrator key",
  "Rialto key header",
  "Virtuals API key",
  "base URL",
  "bitquery api key",
  "bot token",
  "breaker contract",
  "Pimlico API key",
  "bundler URL override",
  "Buy amount per check",
  "chat trade ceiling",
  "check every (minutes)",
  "connection",
  "contract address",
  "daily report hour",
  "daily transfer budget",
  "decimals",
  "files root",
  "gap budget",
  "idle cash floor",
  "mainnet RPC override",
  "max per token (USDG)",
  "max slippage",
  "max spot-vs-average gap (bps)",
  "merry circle token",
  "minimum pool depth (USD)",
  "model",
  "Agent name",
  "performance fee",
  "scout budget (USDG)",
  "step budget",
  "Strategy",
  "swap venue",
  "symbol",
  "testnet RPC override",
  "Market check interval",
  "trade pings — how often",
  "transcription key (voice)",
  "v4 adapter contract",
];

describe("every control survives the restyle", () => {
  /**
   * FOUR OF THESE WERE RENAMED, NOT REMOVED, in the mobile polish pass:
   *
   *   bundler             → Pimlico API key
   *   tick cadence        → Market check interval
   *   buy per tick        → Buy amount per check
   *   LLM decision window → Strategist decision interval
   *
   * Recorded rather than quietly re-pointed, because a census that is edited
   * every time it fails stops being a census. What made the rename safe to
   * accept is the sibling test below: the control COUNTS are unchanged, so each
   * of the four is still on the page and still editable — `bundlerApiKey`,
   * `tickSeconds`, `buyPerTickUsdg` and `llmIntervalMin` all still bind to an
   * input. A label may become plainer; a control may not vanish.
   */
  it("keeps all 45 field labels", () => {
    const missing = FIELDS.filter((f) => !SRC.includes(`label="${f}"`));
    assert.deepEqual(missing, [], "these fields disappeared from the page");
  });

  it("AND THE SETTINGS BEHIND THE RENAMED FOUR ARE STILL BOUND TO AN INPUT", () => {
    // The half a label census cannot see. A rename is cosmetic; losing the
    // binding means the owner keeps a setting they can no longer change — and
    // for `bundlerApiKey` that is the difference between paper and live.
    for (const key of ["bundlerApiKey", "tickSeconds", "buyPerTickUsdg", "llmIntervalMin"]) {
      assert.ok(SRC.includes(`set("${key}")`), `${key} lost its onChange binding`);
    }
  });

  it("keeps the measured control census", () => {
    // A number that moves is not necessarily wrong — but it must be noticed,
    // and a class rename is never the reason for one.
    const count = (re: RegExp) => (SRC.match(re) ?? []).length;
    // 12 since "research before deciding". deskEnabled was in core and read by
    // the worker while missing from BOTH the settings route's field list and
    // this screen — so the one setting that turns an agent from answering into
    // thinking could not be turned on by anybody.
    // 13 since "trade the platform coin list". Added deliberately, and it is the
    // only checkbox on the page that starts ON — so unlike its siblings the
    // control is what makes OFF reachable at all, and it is also the only place
    // an owner learns the coin list exists. A missing opt-out is worse than a
    // missing opt-in: the behaviour happens either way.
    assert.equal(count(/type="checkbox"/g), 13, "checkboxes");
    // 13 since "take profit" — the only exit steady-basket has. It was added to
    // core and read by the worker while being absent from the settings route's
    // field list AND from this screen, so it was unreachable from the app and
    // an owner could not turn it on at all.
    assert.equal(count(/type="number"/g), 13, "number inputs");
    assert.equal(count(/type="password"/g), 8, "password inputs");
    // 13 since the class vault factory. The number moved for the reason this
    // census exists to allow — a control was ADDED, deliberately — and the
    // check below pins that it is bound, because an address field nobody can
    // save is how ponsAdapterAddress spent a release being undocumentedly dead.
    assert.equal(count(/type="text"/g), 13, "text inputs");
    assert.equal(count(/type="url"/g), 3, "url inputs");
    assert.equal(count(/<select/g), 5, "selects");
  });

  it("sends exactly the 19 fields save() guards", () => {
    // Every guard is "the user did not touch this, so do not overwrite it".
    // One dropped guard silently resets a setting to whatever the form had.
    //
    // 19 since officialCoinsEnabled, and the guard matters more for it than for
    // any of the eighteen: it is the one field that defaults ON, so an unguarded
    // send would write `false` for every owner who opened this screen and saved
    // anything at all — silently opting the fleet out of the coin list by
    // visiting a page.
    assert.equal((code.match(/!== null\)/g) ?? []).length, 19);
  });
});

describe("a redacted secret never becomes an editable value", () => {
  it("a password input's value is the user's draft, never the stored view", () => {
    // The pattern is: PLACEHOLDER shows that a secret is stored, in redacted
    // form; VALUE is only what this user has typed, empty until they type. The
    // first draft of this test asserted no value at all and was simply wrong
    // about the page — an uncontrolled input is not the property.
    //
    // The property is which side of that split each attribute takes. Bind the
    // redacted view as the value and the mask lands in the DOM as editable
    // text, and saving writes it back over the real key.
    // Split on the tag and cut at its own close, so one fragment is one
    // element. A span-limited regex reaches into the NEXT input and reports its
    // value — which is how the first draft of this blamed a text field.
    const inputs = code
      .split("<input")
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf("/>")))
      .filter((chunk) => chunk.includes('type="password"'));
    assert.ok(inputs.length > 0, "expected password inputs to exist");
    for (const tag of inputs) {
      const value = /value=\{([^}]*)\}/.exec(tag)?.[1] ?? "";
      // Both accessors are in use: draft.bundlerApiKey and draft[providerKeyField].
      assert.ok(
        value === "" || /^draft[.[]/.test(value.trim()),
        `a password value must come from the draft, got: ${value}`,
      );
      assert.ok(
        !/secretPlaceholder/.test(value),
        "the redacted view must never be bound as a value",
      );
      // v() falls back to the STORED view when the draft has no entry, which
      // for a secret is the redaction. It is right for the plain-text fields
      // that use it and wrong here, and the difference is one character.
      assert.ok(!/^v\(/.test(value.trim()), "a password value must not come from v()");
    }
  });

  it("keeps the placeholder that says a secret is already stored", () => {
    assert.match(SRC, /placeholder=\{secretPlaceholder\(/);
  });
});

describe("the hosted refusals stay refused", () => {
  it("keeps the provider filter that exists to stop SSRF", () => {
    // A KEY is something a hosted tenant may offer us. An ADDRESS is something
    // that makes our server fetch whatever they name, which is the whole of the
    // vulnerability — so hosted drops custom and keyless providers.
    assert.match(code, /hosted/);
    assert.match(SRC, /providers[\s\S]{0,400}?filter\(/);
  });

  it("keeps every machine-access warning, by its words", () => {
    // Anchored on the PROSE, not the class. The first version of this counted
    // `pc-danger` blocks and failed the moment they were renamed — which is a
    // test measuring the styling rather than the property. What must survive a
    // restyle is the sentence that tells an owner what they are arming.
    for (const said of [
      "This lets Telegram touch this computer",
      "This is remote control of your computer",
      "Free-form shell is remote code execution by an AI",
      "The drawdown breaker cannot protect this money",
    ]) {
      assert.ok(SRC.includes(said), `this warning went missing: "${said}"`);
    }
  });

  it("keeps the automatic-shell warning in full", () => {
    // Auto-shell is the RCE boundary of the whole product. The warning is the
    // only thing between an owner and arming it by accident, and it is prose —
    // exactly the shape a restyle deletes without any test noticing.
    assert.match(SRC, /shell/i);
    assert.match(SRC, /Only enabled groups work; the rest are refused/);
  });

  it("keeps the capability chips announcing whether they are armed", () => {
    // They were spans with an onClick: no keyboard access, no pressed state, so
    // whether shell and keyboard access were armed was colour and opacity only.
    assert.match(SRC, /aria-pressed=\{capsVal\.includes\(c\.id\)\}/);
    assert.match(SRC, /aria-pressed=\{activeSymbols\.includes\(sym\)\}/);
  });

  it("keeps the trencher live gate", () => {
    assert.match(SRC, /trencherLive/);
  });
});
