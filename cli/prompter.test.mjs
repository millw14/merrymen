import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import { makePrompter } from "./prompter.mjs";

/**
 * EOF must never crash or hang a prompt. Piping nothing (or a closed
 * terminal) closes readline mid-question: every ask* resolves "" — the
 * documented BLANK answer each caller already defines — so onboarding
 * degrades to defaults/skips instead of TypeErroring on .trim() and
 * abandoning unsaved setup.
 */
describe("makePrompter — closed input resolves blank, never null, never hangs", () => {
  it("ask() on immediate EOF resolves empty string", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = makePrompter(input, output);
    const pending = p.ask("name? ");
    input.end(); // EOF before any answer
    assert.equal(await pending, "");
    p.close();
  });

  it("askSecret() on immediate EOF resolves empty string (previously hung forever)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = makePrompter(input, output);
    const pending = p.askSecret("key? ");
    input.end();
    assert.equal(
      await Promise.race([pending, new Promise((_, rej) => setTimeout(() => rej(new Error("hung")), 2000))]),
      "",
    );
    p.close();
  });

  it("normal answers still work, and .trim() callers are safe on EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = makePrompter(input, output);
    const pending = p.ask("pick? ");
    input.write("2\n");
    // The exact caller shape from onboard()/recover()/kill: trim immediately.
    assert.equal((await pending).trim(), "2");
    const eof = p.ask("gone? ");
    input.end();
    assert.equal((await eof).trim(), "");
    p.close();
  });
});
