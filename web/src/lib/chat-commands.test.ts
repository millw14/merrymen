/**
 * THE CONFIRMATION IS THE SECURITY BOUNDARY, NOT A COURTESY.
 *
 * `/api/chat` is fed the owner's own ledger, and a position's `reason` is
 * model-written text from ANOTHER agent — so the context is genuinely
 * attacker-influenced. That is why the route's header says the model "can
 * NARRATE but never ACT" and calls a prompt-injected "sell everything" inert.
 *
 * Letting chat drive the app keeps that property only because the model
 * proposes and a human clicks. These tests pin the three things that make the
 * difference: the registry is an allowlist, the sentence an owner confirms is
 * OURS, and no command can write a field it did not declare.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CHAT_COMMANDS, COMMAND_IDS, commandFor, settingsPayload } from "./chat-commands";

describe("the registry is an allowlist", () => {
  it("AN UNKNOWN COMMAND IS NOT A COMMAND", () => {
    // The fail-closed direction. A model inventing a plausible id must not
    // reach a route by naming it.
    assert.equal(commandFor("drain-everything"), null);
    assert.equal(commandFor("set-bundler-url"), null);
    assert.equal(commandFor(""), null);
    assert.equal(commandFor(null), null);
    assert.equal(commandFor(42), null);
    assert.equal(commandFor({ id: "set-strategy" }), null);
  });

  it("and every registered command is reachable by its own id", () => {
    for (const id of COMMAND_IDS) assert.ok(commandFor(id), `${id} is advertised but unreachable`);
  });
});

describe("a command cannot write a field it did not declare", () => {
  it("THE MODEL SUPPLIES VALUES, NEVER FIELD NAMES", () => {
    // The attack this closes: a command that legitimately sets `strategy`
    // arriving with extra keys, and the payload being spread into a settings
    // PUT. `writes` is ours; anything else is dropped before it leaves.
    const cmd = commandFor("set-strategy")!;
    const payload = settingsPayload(cmd, {
      strategy: "dip-hunter",
      bundlerUrl: "https://evil.example",
      sponsorGasEnabled: true,
      tradeFeeAddress: "0xattacker",
      paperTradingEnabled: false,
    });
    assert.deepEqual(payload, { strategy: "dip-hunter" });
  });

  it("a navigate command writes nothing at all", () => {
    for (const cmd of CHAT_COMMANDS.filter((c) => c.via === "navigate")) {
      assert.equal(cmd.writes, undefined, `${cmd.id} navigates and must not write`);
      assert.deepEqual(settingsPayload(cmd, { strategy: "x" }), {});
    }
  });

  it("and no command declares a HOUSE-OWNED field", () => {
    // Reading the real list rather than a copy: a tenant cannot set these
    // through the settings route either, so a command that tried would be
    // stripped twice — but it should not exist in the first place.
    const settings = readFileSync(new URL("../../../packages/core/src/settings.ts", import.meta.url), "utf8");
    // Anchored on the DECLARATION. `HOUSE_KEY_FIELDS` is also named in a
    // comment further up, and slicing from there lands in prose and parses
    // nothing — a scan that finds no fields would pass this test vacuously.
    const at = settings.indexOf("export const HOUSE_KEY_FIELDS");
    const house = [...settings.slice(at, settings.indexOf("]", at)).matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!);
    assert.ok(house.length >= 5, `expected the house list, parsed ${house.length}`);
    for (const cmd of CHAT_COMMANDS) {
      for (const key of cmd.writes ?? []) {
        assert.ok(!house.includes(key), `${cmd.id} would write the house-owned ${key}`);
      }
    }
  });
});

describe("a command that takes you somewhere takes you somewhere real", () => {
  it("EVERY NAVIGATE TARGET HAS A ROUTE FILE", () => {
    // The failure nothing else catches: `/grant` resolving through the shell
    // when clicked and 404ing on refresh. It is the same trap nav.test.ts
    // guards for the tab bar — and worse here, because the owner arrived by
    // asking for their key and lands on a not-found page instead.
    const root = join(import.meta.dirname, "..", "..", "..");
    const missing: string[] = [];
    for (const cmd of CHAT_COMMANDS.filter((c) => c.via === "navigate")) {
      assert.ok(cmd.to?.startsWith("/"), `${cmd.id} navigates nowhere`);
      // A fragment is a scroll target on the page, not part of its path.
      const path = cmd.to!.split("#")[0]!;
      if (!existsSync(join(root, `web/src/app/(app)${path}/page.tsx`))) missing.push(`${cmd.id} → ${path}`);
    }
    assert.deepEqual(missing, [], `these commands lead to a 404: ${missing.join(", ")}`);
  });

  it("and a fragment target is one the page actually has", () => {
    // `resign` points at /grant#resign. If the anchor is renamed, the command
    // lands at the top of a long wallet page with no sign of what it promised.
    const wallet = readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8");
    for (const cmd of CHAT_COMMANDS.filter((c) => c.to?.includes("#"))) {
      const id = cmd.to!.split("#")[1]!;
      assert.match(wallet, new RegExp(`id="${id}"`), `${cmd.id} points at #${id}, which no longer exists`);
    }
  });
});

describe("the sentence an owner confirms is ours", () => {
  it("EVERY COMMAND WRITES ITS OWN DESCRIPTION", () => {
    // If the model supplied this text it could describe one action and request
    // another, and the confirmation would be confirming the description.
    for (const cmd of CHAT_COMMANDS) {
      const said = cmd.say({ strategy: "dip-hunter", basketSymbols: "TSLA,NVDA", slippageBps: 150, buyPerTickUsdg: 25, agentName: "Robin" });
      assert.equal(typeof said, "string");
      assert.ok(said.length > 10, `${cmd.id} has no sentence`);
    }
  });

  it("and it says what the setting ACTUALLY does, not what its name suggests", () => {
    // paperTradingEnabled is permission to simulate, not a request to —
    // execModeOf asks canTradeForReal first. "Switch to paper" would promise
    // something this setting does not do, which is the exact confusion a
    // tester reported when they went looking for a switch.
    const paper = commandFor("go-paper")!.say({});
    assert.match(paper, /not a switch to paper/i);
    assert.match(paper, /if every leg is available I still trade for real/i);
  });
});

describe("no secret is ever a command result", () => {
  it("REVEAL-KEY NAVIGATES, IT DOES NOT PRINT", () => {
    // It is the owner's key on the owner's machine and /grant already shows it
    // with a copy button. But a chat answer goes through the MODEL and is
    // PERSISTED to this browser's storage — so printing it there would put a
    // second copy somewhere with none of the wallet screen's warnings or gate.
    const cmd = commandFor("reveal-key")!;
    assert.equal(cmd.via, "navigate");
    assert.equal(cmd.to, "/grant");
    assert.equal(cmd.weighty, true);
    assert.match(cmd.say({}), /will not print it in chat/i);
  });

  it("and NOTHING in the registry returns a value rather than an action", () => {
    // Every command either writes a declared setting or moves the user. None
    // has a shape that could carry a secret back into the transcript.
    for (const cmd of CHAT_COMMANDS) {
      assert.ok(cmd.via === "settings" || cmd.via === "navigate", `${cmd.id} has a third kind of effect`);
    }
  });
});

describe("what changes money is marked", () => {
  it("every settings command that alters trading is weighty", () => {
    // The card says so louder. It does not skip the click — nothing does.
    for (const id of ["set-strategy", "set-basket", "go-paper", "go-live", "set-slippage", "set-impact", "set-size"]) {
      assert.equal(commandFor(id)!.weighty, true, `${id} changes what the agent does with money`);
    }
    // And a harmless one is not, so the marking still means something.
    assert.notEqual(commandFor("rename")!.weighty, true);
  });

  it("AND MONEY LEAVING IS MARKED TOO, even though chat cannot do it", () => {
    // It navigates, so it writes nothing — but an owner clicking it is on
    // their way to move funds, and the sentence has to say that the wall may
    // refuse before they get there. Settings.tsx: grants signed today register
    // no withdrawal address, so their wall carries no transfer permission.
    const out = commandFor("open-withdraw")!;
    assert.equal(out.weighty, true);
    assert.match(out.say({}), /cannot send it from chat/i);
    assert.equal(out.writes, undefined);
  });

  it("re-signing points at the ONE signing control", () => {
    // Not a second signer. Wallet.tsx: "One signing control, one set of
    // conditions, and everything else points at it."
    assert.equal(commandFor("resign")!.to, "/grant#resign");
  });
});
