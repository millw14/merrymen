import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("direct release guard fails with the supported tarball workflow", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./publish-guard.mjs", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm run pack:release/);
  assert.match(result.stderr, /npm publish .*\.tgz/);
});
