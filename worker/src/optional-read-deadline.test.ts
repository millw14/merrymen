import assert from "node:assert/strict";
import { it } from "node:test";
import { boundedRead } from "./optional-read-deadline";

it("an optional read that hangs or fails returns no evidence", async () => {
  assert.equal(await boundedRead(() => new Promise(() => {}), 10), null);
  assert.equal(await boundedRead(async () => { throw new Error("offline"); }, 10), null);
  assert.deepEqual(await boundedRead(async () => ({ read: true }), 1000), { read: true });
});
