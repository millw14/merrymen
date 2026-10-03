import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "./route";

test("OpenAI domain proof is absent until a portal token is configured", async () => {
  const before = process.env.MERRYMEN_OPENAI_APPS_CHALLENGE;
  try {
    delete process.env.MERRYMEN_OPENAI_APPS_CHALLENGE;
    assert.equal(GET().status, 404);

    const token = "openai-apps-challenge=sample-token";
    process.env.MERRYMEN_OPENAI_APPS_CHALLENGE = token;
    const response = GET();
    assert.equal(response.status, 200);
    assert.equal(await response.text(), token, "the proof is returned byte for byte, with no JSON or newline");
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(response.headers.get("cache-control"), "no-store");

    process.env.MERRYMEN_OPENAI_APPS_CHALLENGE = `${token}\nsecond-token`;
    assert.equal(GET().status, 404, "a malformed multiline value cannot expose another token");
  } finally {
    if (before === undefined) delete process.env.MERRYMEN_OPENAI_APPS_CHALLENGE;
    else process.env.MERRYMEN_OPENAI_APPS_CHALLENGE = before;
  }
});
