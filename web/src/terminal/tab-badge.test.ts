/**
 * "(3) merrymen" WHILE THE TAB IS HIDDEN — and the title given back intact.
 *
 * The count is prefixed onto whatever the page's title is, and taken off
 * again, rather than written as a fixed string: the title is the route's
 * (Next sets it per page), and a badge that replaced it would leave a token
 * page titled "merrymen" after the reader came back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { badgedTitle, plainTitle } from "./tab-badge";

describe("the tab title", () => {
  it("counts what arrived, on the page's own title", () => {
    assert.equal(badgedTitle("merrymen", 3), "(3) merrymen");
    assert.equal(badgedTitle("TSLA · merrymen", 1), "(1) TSLA · merrymen");
  });

  it("replaces its own count rather than stacking one on another", () => {
    assert.equal(badgedTitle("(3) merrymen", 5), "(5) merrymen");
    assert.equal(badgedTitle("(99+) merrymen", 5), "(5) merrymen");
  });

  it("gives the title back exactly at zero", () => {
    assert.equal(badgedTitle("(3) merrymen", 0), "merrymen");
    assert.equal(plainTitle("(12) TSLA · merrymen"), "TSLA · merrymen");
    assert.equal(plainTitle("merrymen"), "merrymen");
  });

  it("does not take a bracket that is part of the page's own title", () => {
    assert.equal(plainTitle("(TSLA) merrymen"), "(TSLA) merrymen");
  });

  it("stops counting digits at 99", () => {
    assert.equal(badgedTitle("merrymen", 250), "(99+) merrymen");
  });
});
