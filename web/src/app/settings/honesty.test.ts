import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EN, type MessageKey } from "@/lib/messages/en";

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
    // MEASURED AGAINST THE CATALOGUE, because that is where the labels live
    // now. The census is unchanged — these forty-five fields must still be on
    // the page — but the component names a key and the English sits in en.ts,
    // so looking for `label="…"` in the JSX would report every field missing
    // the moment the screen became translatable.
    // `Set<string>`, not the literal union `Object.values` infers — the point
    // is to ask whether an arbitrary label is present, which a union of the
    // exact strings will not let you do.
    const shipped = new Set<string>(Object.values(EN));
    const missing = FIELDS.filter((f) => !shipped.has(f));
    assert.deepEqual(missing, [], "these fields disappeared from the page");
    // And the screen must still RENDER a label for each, rather than merely
    // having the string sit unused in the catalogue. Counted with a plain
    // substring, because the thing being looked for is full of regex
    // metacharacters and an escaping slip here would silently match nothing.
    const rendered = SRC.split('label={t("settings.label.').length - 1;
    assert.ok(rendered >= 40, `only ${rendered} field labels are rendered from the catalogue`);
  });

  it("AND THE SETTINGS BEHIND THE RENAMED FOUR ARE STILL BOUND TO AN INPUT", () => {
    // The half a label census cannot see. A rename is cosmetic; losing the
    // binding means the owner keeps a setting they can no longer change — and
    // for `bundlerApiKey` that is the difference between paper and live.
    // `set` OR `setNum` — the numeric ones moved to a handler that keeps the
    // owner's raw text instead of letting a number input throw it away. What
    // this test cares about is that the control is still bound to something,
    // which is the half a label census cannot see.
    for (const key of ["bundlerApiKey", "tickSeconds", "buyPerTickUsdg", "llmIntervalMin"]) {
      assert.ok(
        SRC.includes(`set("${key}")`) || SRC.includes(`setNum("${key}")`),
        `${key} lost its onChange binding`,
      );
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
    // 14 since the class route's own switch. It had a type, a PUT-allowlist
    // entry and a worker read, and no control at all — so it could not be
    // turned on from the app by anyone, and the factory field sitting alone in
    // Connections made the page look as though the feature were reachable.
    // 15 since LIVE TRADING — the switch that decides whether any of this costs
    // real money, and the one this page went longest without. Two other screens
    // told owners to change paper/live "in Settings" while no such control
    // existed here; worse, until `liveTradingEnabled` became a required term of
    // canTradeForReal there was nothing to bind it to, so a funded agent traded
    // real money whatever its owner had chosen. First on the page, because it
    // outranks every control below it.
    // 16 since "Trade this one too", beside the add-token form. Adding a token
    // and trading it are two different writes — `customTokens` says "know about
    // this", `basketSymbols` says "trade it" — and only the first was ever
    // offered here. The second existed as an unselected chip at the end of
    // twenty-five stock chips and as a JSX comment, so an owner pasted an
    // address, saved, re-signed, and asked the group why his agent still traded
    // only stocks. Deliberately a control rather than an automatic write: the
    // rule it respects (strategies/registry.ts, "a token added to be tracked
    // must not start being bought on its own") protects owners from the
    // PLATFORM widening what gets bought, and a person typing an address is not
    // the platform — so the choice is theirs, visible, and defaulted on.
    // 19 since TELEGRAM GROUPS (docs/tg-groups.md): "Hang out in Telegram
    // groups" and "Look at coins people post". Both default ON, so — like the
    // platform coin list — the control is what makes OFF reachable, and both
    // are dashboard-only: the chat refuses them and points here.
    assert.equal(count(/type="checkbox"/g), 19, "checkboxes");
    // 13 since "take profit" — the only exit steady-basket has. It was added to
    // core and read by the worker while being absent from the settings route's
    // field list AND from this screen, so it was unreachable from the app and
    // an owner could not turn it on at all.
    // 14 includes the owner-configurable class-position exit timer.
    //
    // COUNTED BY HANDLER, NOT BY `type`. The census used to count
    // `type="number"`, and every one of those became `type="text"` with an
    // `inputMode`: a number input hands JavaScript an EMPTY STRING for anything
    // its own locale cannot parse, and empty means "clear to default" at the
    // server — so a comma keystroke silently reset the setting. `setNum` is now
    // the thing that makes a field numeric, so it is the thing to count.
    //
    // 22, not 14, because the eight fields that were ALREADY plain text with an
    // `inputMode` were on the same broken path and now share the handler.
    assert.equal(count(/setNum\("/g), 22, "numeric settings");
    // And every one of them shows its own refusal, rather than relying on a
    // save-time error for a field the reader has already scrolled past.
    assert.equal(count(/aria-invalid=/g), 22, "numeric settings marking themselves invalid");
    assert.equal(count(/type="password"/g), 8, "password inputs");
    // 13 since the class vault factory. The number moved for the reason this
    // census exists to allow — a control was ADDED, deliberately — and the
    // check below pins that it is bound, because an address field nobody can
    // save is how ponsAdapterAddress spent a release being undocumentedly dead.
    //
    // 27 since the fourteen `type="number"` fields became `type="text"`. No
    // control was added or removed — the SAME fourteen are on the page — but a
    // number input destroys the owner's raw text before JavaScript sees it,
    // handing over an empty string for anything its locale cannot parse, and
    // empty means "clear to default" at the server. It is also what kept
    // `<html lang>` static: Firefox picks a number input's decimal separator
    // from the page language, so translating the UI would have changed which
    // strings these fields accept.
    assert.equal(count(/type="text"/g), 27, "text inputs");
    assert.equal(count(/type="url"/g), 3, "url inputs");
    // 6 since ASSET MODE — All assets / Stocks only / Crypto only. Several
    // owners asked for it at once ("there should be an option mode for stocks
    // only, crypto only..."), and it is a filter over what may be BOUGHT, never
    // over what is watched: a class switched off stays priced and sellable.
    // 7 since how chatty it is in Telegram groups (quiet / normal / chatty),
    // the third Telegram groups control beside the two switches above.
    assert.equal(count(/<select/g), 7, "selects");
  });

  it("sends exactly the 26 fields save() guards", () => {
    // Every guard is "the user did not touch this, so do not overwrite it".
    // One dropped guard silently resets a setting to whatever the form had.
    //
    // 19 since officialCoinsEnabled, and the guard matters more for it than for
    // any of the eighteen: it is the one field that defaults ON, so an unguarded
    // send would write `false` for every owner who opened this screen and saved
    // anything at all — silently opting the fleet out of the coin list by
    // visiting a page.
    // 20 since classSnipeEnabled. Same reasoning as officialCoinsEnabled above,
    // pointing the other way: unguarded, an owner who opened this screen and
    // saved anything would send `false` and silently switch a running class
    // canary off mid-position.
    // 21 since liveTradingEnabled, and this guard is load-bearing in a way none
    // of the others are: unguarded, an owner who opened this screen and saved
    // anything at all would send whatever the form happened to hold for the
    // consent flag — either switching a live agent to paper mid-position, or
    // granting permission to spend real money. No other field here can do the
    // second thing.
    // 22 since assetMode. Unguarded, an owner who opened this screen and saved
    // anything at all would send whatever the form happened to hold and could
    // silently narrow what their agent trades — the same class of failure as the
    // consent flag above, one step less dangerous.
    // 23 includes the opt-in fast Trencher profile.
    // 26 since the three Telegram groups settings. Two of them default ON, so
    // unguarded they would write whatever the form held for every owner who
    // saved anything — silently taking a bot out of its groups, or switching
    // coin-looking off, by visiting a page.
    assert.equal((code.match(/if \(\w+ !== null\) body\.\w+ = \w+;/g) ?? []).length, 26);
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
    //
    // The warnings themselves moved into the catalogue with the rest of the
    // screen, so each pair asserts both ends: the catalogue still says the
    // sentence, and the screen still renders that key. Either half going
    // missing fails loudly instead of silently un-translating a warning.
    for (const [said, key] of [
      ["This lets Telegram touch this computer", "settings.text.thisLetsTelegramTouch"],
      ["This is remote control of your computer", "settings.text.thisIsRemoteControl"],
      ["Free-form shell is remote code execution by an AI", "settings.text.freeFormShellIs"],
      ["The drawdown breaker cannot protect this money", "settings.text.theDrawdownBreakerCannot"],
    ] as const) {
      assert.ok(
        (EN[key as MessageKey] as string).includes(said),
        `the catalogue stopped saying: "${said}"`,
      );
      assert.ok(SRC.includes(`t("${key}")`), `the screen stopped rendering ${key}: "${said}"`);
    }
  });

  it("keeps the automatic-shell warning in full", () => {
    // Auto-shell is the RCE boundary of the whole product. The warning is the
    // only thing between an owner and arming it by accident, and it is prose —
    // exactly the shape a restyle deletes without any test noticing.
    assert.match(SRC, /shell/i);
    // The warning itself moved into the catalogue with the rest of the screen.
    // Asserting on the WORDS still, just where they are.
    assert.ok(
      Object.values(EN).some((v) => /Only enabled groups work; the rest are refused/.test(v)),
      "the auto-shell warning must survive somewhere in the shipped copy",
    );
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

describe("nothing is left behind after a save", () => {
  it("EVERY FIELD save() SENDS IS CLEARED AFTER IT, so the screen shows the server's value", () => {
    // "THE SEVEN THAT WERE LEFT BEHIND": a toggle sent but not reset after the
    // save keeps showing the LOCAL value while `view` holds the server's, and
    // the two differ exactly when a write did not land. Derived from the
    // guards themselves, so a toggle added tomorrow is held to it too.
    // `save(` and not `save()`: it takes the "Move it here" answer to a 409
    // bot claim (lib/telegram-claims.ts), and the guards are the same either way.
    const save = code.slice(code.indexOf("async function save("));
    const saved = save.indexOf('setStatus("Changes saved")');
    const refetch = save.indexOf('const fresh = await fetch("/api/settings")');
    const resetEnd = save.indexOf("void loadTelegram();", saved);
    assert.ok(refetch > 0 && saved > refetch && resetEnd > saved, "saved values must be read back before clearing the draft");
    const reset = save.slice(saved, resetEnd);
    const guarded = [...save.slice(0, saved).matchAll(/if \((\w+) !== null\) body\.\w+ = \1;/g)].map((m) => m[1]!);
    assert.equal(guarded.length, 26, "every guard has the `if (x !== null) body.key = x;` shape");
    const left = guarded.filter((name) => !reset.includes(`set${name[0]!.toUpperCase()}${name.slice(1)}(null)`));
    assert.deepEqual(left, [], "sent by save() but not reset after it");
  });
});

describe("Telegram groups (docs/tg-groups.md)", () => {
  it("the three settings are bound, guarded and sent under their exact keys", () => {
    // `telegramGroupsChattiness`, with "Groups": the other spelling trips the
    // web room's boundary test in the worker and is not a setting.
    assert.match(code, /if \(tgGroups !== null\) body\.telegramGroupsEnabled = tgGroups;/);
    assert.match(code, /if \(tgGroupCoins !== null\) body\.telegramGroupCoinsEnabled = tgGroupCoins;/);
    assert.match(code, /if \(tgChattiness !== null\) body\.telegramGroupsChattiness = tgChattiness;/);
    assert.match(code, /onChange=\{\(e\) => setTgGroups\(e\.target\.checked\)\}/);
    assert.match(code, /onChange=\{\(e\) => setTgGroupCoins\(e\.target\.checked\)\}/);
    assert.match(code, /onChange=\{\(e\) => setTgChattiness\(e\.target\.value as TelegramGroupsChattiness\)\}/);
    // Both switches default ON: without the default an unsaved owner would see
    // them unticked while the bot talked.
    assert.match(code, /view\.values\.telegramGroupsEnabled \?\? d\.telegramGroupsEnabled/);
    assert.match(code, /view\.values\.telegramGroupCoinsEnabled \?\? d\.telegramGroupCoinsEnabled/);
    assert.match(code, /view\.values\.telegramGroupsChattiness \?\? d\.telegramGroupsChattiness/);
    // One list of levels, core's.
    assert.match(code, /TELEGRAM_GROUPS_CHATTINESS\.map\(/);
  });

  it("they live inside the Telegram section, not under Advanced", () => {
    const telegram = SRC.indexOf('id="telegram"');
    const block = SRC.indexOf('t("settings.section.telegramGroups")');
    const end = SRC.indexOf("</details>", telegram);
    assert.ok(telegram > 0 && block > telegram && block < end, "the Telegram groups block is not inside <details id=\"telegram\">");
  });

  it("the words the contract fixes are the words shipped", () => {
    assert.equal(EN["settings.section.telegramGroups"], "Telegram groups");
    assert.equal(EN["settings.label.hangOutInTelegramGroups"], "Hang out in Telegram groups");
    assert.equal(EN["settings.label.lookAtCoinsPeoplePost"], "Look at coins people post");
    assert.equal(EN["settings.hint.lookAtCoinsPeoplePost"], "Only in trencher mode. Its Brain decides and every trencher limit still applies.");
    assert.ok(
      EN["settings.text.privacyModeSteps"].startsWith("@BotFather → /setprivacy → your bot → Disable, then remove the bot from the group and add it back"),
      "the privacy-mode steps",
    );
    // "Telegram groups" everywhere: the web room owns the other name.
    for (const [k, v] of Object.entries(EN)) {
      if (k.includes("elegramGroups") || k.includes("privacyMode") || k.includes("chattiness") || k.includes("Chatty")) {
        assert.doesNotMatch(v, /group ?chat/i, `${k} uses the web room's name`);
      }
    }
  });

  it("PRIVACY MODE HAS THREE STATES: off says it can follow the chat, on and UNKNOWN both show the steps", () => {
    // Unknown (no token, a failed getMe, an older server) must never read as
    // "on": that claim sends an owner to BotFather for nothing. Only an
    // explicit false earns the verdict.
    assert.match(code, /tg\?\.canReadAllGroupMessages === true \? \(\s*t\("settings\.text\.privacyModeOff"\)/);
    assert.match(code, /tg\?\.canReadAllGroupMessages === false \? t\("settings\.text\.privacyModeOn"\) : t\("settings\.text\.privacyModeUnknown"\)\}\{" "\}\s*\{t\("settings\.text\.privacyModeSteps"\)\}/);
    assert.match(code, /tg\?\.canJoinGroups === false && /);
  });
});
