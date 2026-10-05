import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReturnReview, underReturnReview } from "./return-review";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

test("an unset or blank list holds nobody's return", () => {
  for (const raw of [undefined, "", "  ", " , ,\n"]) {
    assert.deepEqual(parseReturnReview(raw), { all: false, accounts: new Set() }, JSON.stringify(raw));
    assert.equal(underReturnReview(A, raw), false);
  }
});

test("listed accounts are held whatever their casing or separator, and only they are", () => {
  for (const raw of [`${A},${B}`, `${A.toUpperCase().replace("0X", "0x")} ${B}`, `\n${A} ,\t${B.toLowerCase()},`]) {
    assert.equal(underReturnReview(A, raw), true, raw);
    assert.equal(underReturnReview(B.toLowerCase(), raw), true, raw);
    assert.equal(underReturnReview("0xcccccccccccccccccccccccccccccccccccccccc", raw), false, raw);
  }
});

test("one entry that is not an address holds EVERY return rather than silently publishing one", () => {
  // A dropped character would otherwise publish exactly the return the list
  // was set to hold back, with nothing on the page to say so.
  for (const raw of [`${A},${B.slice(0, -1)}`, `${A};${B}`, "johnny", `${A} 0x`, `${A} ${A}z`]) {
    assert.deepEqual(parseReturnReview(raw), { all: true }, raw);
    assert.equal(underReturnReview("0xcccccccccccccccccccccccccccccccccccccccc", raw), true, raw);
  }
});

test("read from the environment on every call, not at import", () => {
  const saved = process.env.MERRYMEN_RETURN_REVIEW;
  try {
    delete process.env.MERRYMEN_RETURN_REVIEW;
    assert.equal(underReturnReview(A), false);
    process.env.MERRYMEN_RETURN_REVIEW = A;
    assert.equal(underReturnReview(A), true);
  } finally {
    if (saved === undefined) delete process.env.MERRYMEN_RETURN_REVIEW;
    else process.env.MERRYMEN_RETURN_REVIEW = saved;
  }
});
