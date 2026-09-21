import readline from "node:readline";

/**
 * Prompt helper for the CLI's interactive flows (onboard, recover, kill…).
 * Extracted from cli/bin.mjs so EOF behavior is unit-testable — bin.mjs
 * executes on import and can never be loaded by a test runner.
 *
 * A closed prompt (EOF / piped input ended / terminal gone) resolves "" —
 * the documented BLANK answer — never null, and never hangs. Every caller
 * already defines blank (keep current, skip optional, fail key/address
 * validation, decline [y/N] and type-to-confirm), so EOF inherits exactly
 * the semantics the prompt text promises instead of TypeErroring on .trim()
 * mid-onboarding and abandoning unsaved setup.
 */
export function makePrompter(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output, terminal: true });
  const ask = (q) =>
    new Promise((res) => {
      let done = false;
      const onClose = () => {
        if (!done) { done = true; res(""); }
      };
      rl.once("close", onClose);
      rl.question(q, (answer) => {
        if (!done) { done = true; rl.off("close", onClose); res(answer); }
      });
    });
  const askSecret = (q) =>
    new Promise((res) => {
      let done = false;
      const onClose = () => {
        if (!done) { done = true; rl._writeToOutput = orig; res(""); }
      };
      const orig = rl._writeToOutput.bind(rl);
      console.log(q);
      rl._writeToOutput = (s) => {
        if (s.includes("\n") || s.includes("\r")) orig(s);
      };
      rl.once("close", onClose);
      rl.question("", (answer) => {
        if (!done) { done = true; rl.off("close", onClose); }
        rl._writeToOutput = orig;
        res(answer);
      });
    });
  return { rl, ask, askSecret, close: () => rl.close() };
}
