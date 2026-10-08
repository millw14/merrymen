import assert from "node:assert/strict";
import { it } from "node:test";
import { sendKill } from "./kill-answer";
it("dedicated kill targets only its purpose while legacy default remains Spot", async () => {
  const urls: string[] = [];
  const fetcher = (async (url, init) => { urls.push(String(url)); assert.equal(init?.method, "DELETE"); return Response.json({ custody: "stopped" }); }) as typeof fetch;
  assert.equal((await sendKill(fetcher, "perps")).kind, "done");
  assert.equal((await sendKill(fetcher)).kind, "done");
  assert.deepEqual(urls, ["/api/grants?purpose=perps", "/api/grants"]);
});
