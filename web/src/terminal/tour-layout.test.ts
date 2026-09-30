import assert from "node:assert/strict";
import { it } from "node:test";
import { tourCardPosition } from "./tour-layout";

it("keeps a tall card on screen beside a target instead of using a fixed height guess", () => {
  const p = tourCardPosition({ top: 270, left: 650, width: 100, height: 40 }, { width: 380, height: 360 }, { top: 0, left: 0, width: 1000, height: 600 });
  assert.deepEqual(p, { left: 256, top: 110 });
});
it("places the card above the phone navigation using its actual width and height", () => {
  const p = tourCardPosition({ top: 750, left: 310, width: 48, height: 48 }, { width: 366, height: 280 }, { top: 0, left: 0, width: 390, height: 844 });
  assert.deepEqual(p, { left: 12, top: 456 });
});
it("respects the visible viewport when a keyboard or zoom reduces the usable area", () => {
  const p = tourCardPosition(null, { width: 296, height: 230 }, { top: 150, left: 30, width: 320, height: 254 });
  assert.deepEqual(p, { left: 42, top: 162 });
});
