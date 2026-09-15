/**
 * SIGNING OUT HAS TO END BOTH SESSIONS, OR IT ENDS NEITHER.
 *
 * The button POSTed `/api/auth/logout` and stopped there. That clears the
 * SERVER cookie and leaves Privy authenticated in the browser — and
 * `PrivySignIn`'s prove-on-authenticated effect fires immediately, re-proves,
 * and mints a fresh session. Reported verbatim: "I signed out and it forcefully
 * signed me back in."
 *
 * There is no way out of that loop from the UI, which also means no way to sign
 * in as a DIFFERENT wallet — so it blocked standing up a second account, which
 * is exactly what it was blocking when it was found.
 *
 * Source-read, in the idiom of app/settings/honesty.test.ts: these are
 * properties of how the flow is WRITTEN. A render test would mount a Privy
 * provider that has no session to end and prove nothing about the race.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SIGNOUT = readFileSync(new URL("./SignOut.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const WALLET = readFileSync(new URL("./screens/Wallet.tsx", import.meta.url), "utf8");
const PRIVY = readFileSync(new URL("./PrivySignIn.tsx", import.meta.url), "utf8");

/** Comments stripped — this repo explains its refusals where it makes them. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("sign out ends the browser session too", () => {
  it("the re-sign-in effect it has to beat still exists", () => {
    // If this guard ever stops depending on `authenticated`, the ordering below
    // is no longer load-bearing and this whole file should be re-read.
    assert.match(PRIVY, /if \(!authenticated \|\| phase === "done" \|\| phase === "proving"\) return;/);
  });

  it("calls Privy logout BEFORE clearing the server cookie", () => {
    // The order is the fix. Clear the cookie first and the effect can win the
    // race and re-prove; log out of Privy first and `authenticated` is already
    // false, so the guard holds.
    const fn = code(SIGNOUT).slice(code(SIGNOUT).indexOf("function SignOutWithPrivy"));
    const body = fn.slice(0, fn.indexOf("function SignOutServerOnly"));
    const privyAt = body.indexOf("await logout()");
    const serverAt = body.indexOf("clearServerSession()");
    assert.ok(privyAt >= 0, "the Privy session must be ended");
    assert.ok(serverAt >= 0, "and so must the server session");
    assert.ok(privyAt < serverAt, "Privy must be logged out FIRST, or the effect re-signs you in");
  });

  it("still clears the server session when Privy logout throws", () => {
    // A half-sign-out that forgets the server is recoverable. One that leaves
    // Privy live is not — it just re-proves.
    const fn = SIGNOUT.slice(SIGNOUT.indexOf("function SignOutWithPrivy"));
    assert.match(fn.slice(0, fn.indexOf("function SignOutServerOnly")), /catch \{[\s\S]*?\}\s*try \{/);
  });

  it("does not call usePrivy where there is no provider", () => {
    // `Providers` renders NO PrivyProvider when Privy is disabled, so a
    // conditional hook would throw for those deployments. Two components,
    // branched on a build-time flag, each calling its hooks unconditionally.
    assert.match(SIGNOUT, /privyEnabled\(\) \? \(/);
    // Comment-stripped: the doc above names `usePrivy()` while explaining why
    // it is confined, so counting the raw text counts the explanation.
    assert.equal(
      (code(SIGNOUT).match(/usePrivy\(\)/g) ?? []).length,
      1,
      "exactly one component may call the hook",
    );
  });
});

describe("sign out is findable, and says who you are", () => {
  it("is on the account tab AND on the wallet page", () => {
    // /grant is titled "Wallet & permissions" and is where anyone changing
    // accounts arrives. It had no sign-out at all — which is how this was
    // reported: "no logout button".
    assert.match(APP, /<SignOut/);
    assert.match(WALLET, /<SignOut/);
  });

  it("shows the signed-in address, which no screen used to", () => {
    // The tenant address is the one fact that says which account you are
    // operating, and the owner had to be told it out of an API response.
    assert.match(APP, /signed in as <code>\{account\.session\.address\}<\/code>/);
    assert.match(WALLET, /signed in as <code>\{session\.address\}<\/code>/);
  });

  it("shows the ADDRESS only — never a key", () => {
    // /api/auth/session returns {hosted,address} and nothing else. The wallet
    // page holds an owner recovery key elsewhere in its state; it must not be
    // anywhere near this block.
    const block = WALLET.slice(WALLET.indexOf("grant-session"), WALLET.indexOf("desync banner"));
    assert.doesNotMatch(block, /ownerKey|privateKey|recovery|secret/i);
  });
});
