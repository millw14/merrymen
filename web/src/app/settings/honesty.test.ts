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

const SRC = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

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
  "LLM decision window",
  "LLM max per action",
  "Pimlico API key",
  "Pons curve adapter contract",
  "Rialto integrator key",
  "Rialto key header",
  "Virtuals API key",
  "base URL",
  "bitquery api key",
  "bot token",
  "breaker contract",
  "bundler",
  "bundler URL override",
  "buy per tick",
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
  "name your merryman",
  "performance fee",
  "scout budget (USDG)",
  "step budget",
  "strategy",
  "swap venue",
  "symbol",
  "testnet RPC override",
  "tick cadence",
  "trade pings — how often",
  "transcription key (voice)",
  "v4 adapter contract",
];

describe("every control survives the restyle", () => {
  it("keeps all 44 field labels", () => {
    const missing = FIELDS.filter((f) => !SRC.includes(`label="${f}"`));
    assert.deepEqual(missing, [], "these fields disappeared from the page");
  });

  it("keeps the measured control census", () => {
    // A number that moves is not necessarily wrong — but it must be noticed,
    // and a class rename is never the reason for one.
    // 11→12 checkboxes: the auto-convert toggle (dev/auto-convert branch).
    const count = (re: RegExp) => (SRC.match(re) ?? []).length;
    assert.equal(count(/type="checkbox"/g), 12, "checkboxes");
    // 12→13 number inputs: the auto-convert gas reserve % (dev/auto-convert branch).
    assert.equal(count(/type="number"/g), 13, "number inputs");
    assert.equal(count(/type="password"/g), 8, "password inputs");
    assert.equal(count(/type="text"/g), 12, "text inputs");
    assert.equal(count(/type="url"/g), 3, "url inputs");
    assert.equal(count(/<select/g), 5, "selects");
  });

  it("sends exactly the 18 fields save() guards", () => {
    // Every guard is "the user did not touch this, so do not overwrite it".
    // One dropped guard silently resets a setting to whatever the form had.
    // 17→18: the autoConvertEnabled guard (dev/auto-convert branch).
    assert.equal((code.match(/!== null\)/g) ?? []).length, 18);
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
