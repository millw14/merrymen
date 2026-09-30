/**
 * NO FACE LEAVES OUR ORIGIN.
 *
 * `faceSrc` used to return `https://robohash.org/<slug>.png` and every `Face`
 * on every terminal screen hotlinked it — on a public feed, which means every
 * reader's IP goes to a third party once per avatar per page. `api/agent-face`
 * was written as the proxy for exactly that objection, and only the unmounted
 * `AgentAvatar` ever used it. Pointing every face at our own image route closes
 * the hotlink and serves the owner's upload in the same move.
 *
 * Asserted as a PROPERTY (the URL is relative) rather than as the current path,
 * so it still bites if the route is renamed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bannerSrc, faceSrc } from "./live";

const SLUG = "0123456789abcdef";

describe("face and banner URLs", () => {
  it("are same-origin, never a third-party hotlink", () => {
    for (const url of [faceSrc(SLUG), bannerSrc(SLUG)]) {
      assert.ok(url, "a slug must produce a URL");
      assert.ok(url!.startsWith("/"), `must be relative, got "${url}"`);
      assert.doesNotMatch(url!, /^https?:|^\/\//, `must not name a host, got "${url}"`);
    }
  });

  it("name the agent and the kind, so one route serves both", () => {
    assert.match(faceSrc(SLUG)!, new RegExp(`${SLUG}.*avatar`));
    assert.match(bannerSrc(SLUG)!, new RegExp(`${SLUG}.*banner`));
  });

  it("produce nothing without a slug — there is no agent to show", () => {
    assert.equal(faceSrc(null), null);
    assert.equal(bannerSrc(null), null);
  });

  it("escape the slug rather than trusting it", () => {
    // The route validates SLUG_RE before touching a database, but a URL builder
    // that interpolates raw is one refactor away from being handed something else.
    assert.ok(!faceSrc("a/../b")!.includes("/../"), faceSrc("a/../b")!);
    assert.ok(!bannerSrc("a b")!.includes(" "), bannerSrc("a b")!);
  });
});
