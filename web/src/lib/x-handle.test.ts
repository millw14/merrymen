/**
 * THE HANDLE IS ATTACKER-SUPPLIED TEXT ON ITS WAY INTO AN href.
 *
 * `agents.x_handle` is whatever the owner typed. The hosted settings PUT does
 * apply X's own character rule — but `worker/src/settings.ts` resolves the same
 * field from a self-hosted `settings.json` or `MERRYMEN_X_HANDLE` with only a
 * `.trim()`, no shape check at all, while the lines around it check
 * `/^0x[0-9a-fA-F]{40}$/`. So arbitrary text can already sit in that column and
 * be mirrored to the shared database, and rows predate the current regex.
 *
 * This is the read-time gate. If it ever loosens, a `javascript:` payload from
 * a self-hosted install becomes a live link on a public page.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normaliseXHandle, shortAddress, xHandleTag, xProfileUrl } from "./x-handle";

describe("what may become a link", () => {
  it("accepts X's own rule, with or without the sigil", () => {
    assert.equal(xProfileUrl("much_miller"), "https://x.com/much_miller");
    assert.equal(xProfileUrl("@much_miller"), "https://x.com/much_miller");
    assert.equal(xProfileUrl("  @a  "), "https://x.com/a");
    // Exactly 15 is the documented maximum and must still pass.
    assert.equal(xProfileUrl("a".repeat(15)), `https://x.com/${"a".repeat(15)}`);
  });

  it("REFUSES ANYTHING THAT COULD CHANGE WHERE THE LINK GOES", () => {
    for (const bad of [
      "javascript:alert(1)",
      "//evil.com",
      "a/../../evil",
      "a?next=evil",
      "a#frag",
      "a b",
      "a".repeat(16),
      "",
      "   ",
      "@",
      "@@a",
      "ünïcode",
      "a​b", // zero-width space
      "a\nb",
    ]) {
      assert.equal(xProfileUrl(bad), null, `must refuse: ${JSON.stringify(bad)}`);
    }
  });

  it("refuses non-strings rather than throwing", () => {
    assert.equal(xProfileUrl(null), null);
    assert.equal(xProfileUrl(undefined), null);
    assert.equal(normaliseXHandle(null), null);
  });

  it("the tag always carries the sigil, so it cannot be mistaken for a name", () => {
    assert.equal(xHandleTag("jack"), "@jack");
    assert.equal(xHandleTag("@jack"), "@jack");
    assert.equal(xHandleTag("not a handle"), null);
  });
});

describe("the fallback when there is no handle", () => {
  it("shortens an address, and stays plain text", () => {
    // Plain text is the point: an address is a fact we checked, but it is not a
    // social account, so there is nowhere honest for it to link to.
    assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
    assert.equal(shortAddress("0xabcd"), "0xabcd");
  });

  it("refuses anything that is not an address", () => {
    for (const bad of ["", "jack", "0xzz", null, undefined, "1234567890"]) {
      assert.equal(shortAddress(bad as string | null), null);
    }
  });
});
