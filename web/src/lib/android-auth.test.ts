import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANDROID_AUTH_URL, androidAuthReturnHref, androidOAuthEnabled, isAndroidAuthWebView } from "./android-auth";

const query = () => new URLSearchParams({ privy_oauth_code: "one-time-code", privy_oauth_state: "s".repeat(48), privy_oauth_provider: "twitter" });
describe("Android OAuth presentation and rollout", () => {
  it("stays unavailable until explicitly enabled on the production origin with Privy", () => {
    assert.equal(androidOAuthEnabled("https://app.merrymen.dev", "1", true), true);
    for (const args of [["https://other.example", "1", true], ["https://app.merrymen.dev", undefined, true], ["https://app.merrymen.dev", "1", false]] as const) {
      assert.equal(androidOAuthEnabled(args[0], args[1], args[2]), false);
    }
  });
  it("recognizes only the complete native presentation marker", () => {
    assert.equal(isAndroidAuthWebView("Mozilla/5.0 MerrymenAndroid/1"), true);
    assert.equal(isAndroidAuthWebView("Mozilla/5.0"), false);
    assert.equal(isAndroidAuthWebView("MerrymenAndroid/10"), false);
  });
  it("builds a fixed HTTPS return carrying only the three SDK inputs", () => {
    const href = androidAuthReturnHref(query());
    assert.equal(href, `${ANDROID_AUTH_URL}?${query()}`);
    assert.equal(androidAuthReturnHref(new URLSearchParams()), null);
  });
  it("rejects duplicates, extra destinations/tokens, wrong provider and malformed values", () => {
    for (const [key, value] of [["privy_oauth_code", "second"], ["return_to", "https://attacker.invalid"], ["access_token", "secret"]]) {
      const q = query(); q.append(key, value); assert.equal(androidAuthReturnHref(q), null);
    }
    for (const [key, value] of [["privy_oauth_provider", "google"], ["privy_oauth_code", "bad\ncode"], ["privy_oauth_state", "short"]]) {
      const q = query(); q.set(key, value); assert.equal(androidAuthReturnHref(q), null);
    }
  });
});
