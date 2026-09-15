/**
 * A CONFIRMATION THAT UNDERSTATES WHAT IT MOVES IS NOT A CONFIRMATION.
 *
 * The recovery ENGINE has swept the class vault since `recover.ts:591-638`, and
 * `class-owner-recovery.test.ts` pins that. But that file reads `recover.ts` and
 * `recover-cli.ts` — the engine and its JSON wire — and neither is a surface a
 * human ever looks at. The two that are, `cli/bin.mjs` and `RecoverPanel.tsx`,
 * were never asserted on at all, and both were wrong in the same way: they
 * built their disclosure from `balances` alone.
 *
 * `balances` is what the ACCOUNT holds. A class position lives in a separate
 * PonsClassVault contract, so it is in no entry.
 *
 * MEASURED 2026-09-12 on Shogun (account 0x05a198A6…, vault 0x3fcdde6e…): the
 * owner would have been asked to type `sweep` against the words
 *
 *     about to sweep 20.000000 USDG
 *
 * while the operation also moved 1,063,408.141815 DOGGOS out of the vault. And
 * had the account held no USDG — the ordinary case for a book that is purely
 * class positions — `cli/bin.mjs` would have returned "nothing to recover"
 * BEFORE the prompt, making recovery unreachable for exactly the positions the
 * vault exists to hold. `RecoverPanel.tsx` printed "This account is empty".
 *
 * These are source-read assertions, in the idiom of
 * `app/settings/honesty.test.ts`: what is being pinned is that these files ASK
 * for the vault at all. Rendering the panel would prove nothing about a
 * `window.confirm` string, and `cli/bin.mjs` is an interactive prompt around a
 * child process.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = readFileSync(path.join(__dirname, "..", "..", "cli", "bin.mjs"), "utf8");
const PANEL = readFileSync(
  path.join(__dirname, "..", "..", "web", "src", "components", "RecoverPanel.tsx"),
  "utf8",
);

/**
 * Comments stripped. Both files now explain the defect by QUOTING it — the
 * strings "20.000000 USDG" and "1,063,408.141815 DOGGOS" appear in the prose —
 * so a bare search finds the explanation and reads it as the code.
 */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const BIN_CODE = code(BIN);
const PANEL_CODE = code(PANEL);

describe("the CLI prompt discloses the class vault", () => {
  it("reads the holdings off the plan at all", () => {
    assert.match(BIN_CODE, /plan\.result\.classHoldings/, "the prompt must ask for the vault's contents");
    assert.match(BIN_CODE, /plan\.result\.classVault/, "and for the vault address");
  });

  it("STOPS SAYING 'nothing to recover' over a full vault", () => {
    // The engine's own early return already tests all three terms
    // (recover.ts:526). This is the line that did not, and it is the one that
    // returns before the owner is ever offered the prompt.
    assert.match(
      BIN_CODE,
      /balances\.length === 0 && heldWei === 0n && classHoldings\.length === 0/,
      "the emptiness test must count vault holdings as something to recover",
    );
  });

  it("prints the three headings, grouped by CUSTODY", () => {
    // Grouped rather than flattened because the two custodies behave
    // differently: the vault is emptied by a first operation and the account by
    // a second, and one comma-separated list cannot show that a whole contract
    // is being drained.
    assert.match(BIN_CODE, /CLASS VAULT/, "the vault must be named");
    assert.match(BIN_CODE, /SMART ACCOUNT/, "and the account");
    assert.match(BIN_CODE, /DESTINATION/, "and where it is all going");
  });

  it("the success receipt names everything that moved, vault included", () => {
    // `list` is reused for the "recovered." line. Built from `balances` alone it
    // would confirm a sweep of the account while the vault's coins had also
    // gone, which is the same defect one step later.
    assert.match(
      BIN_CODE,
      /const list = \[\.\.\.classParts, \.\.\.accountParts\]/,
      "the receipt must include the class holdings",
    );
  });

  it("the old flattened one-liner is gone", () => {
    // Anchored on the exact call that produced "about to sweep 20.000000 USDG".
    assert.doesNotMatch(
      BIN_CODE,
      /warn\(`about to sweep \$\{bold\(list\)\}`\)/,
      "the single-line disclosure must not come back",
    );
  });
});

describe("the hosted panel discloses the class vault", () => {
  it("reads the holdings and the vault address", () => {
    assert.match(PANEL_CODE, /classHoldings/, "the panel must ask for the vault's contents");
    assert.match(PANEL_CODE, /classVault/, "and for the vault address");
  });

  it("cannot call an account with a funded vault 'empty' — nor 'blind'", () => {
    // Two claims, both of which were made from `balances` alone. `blind` matters
    // as much as `empty`: an unreadable label plus a readable vault is not
    // "nothing found".
    const emptyLine = /const empty = known && balances\.length === 0 && classHoldings\.length === 0/;
    const blindLine = /const blind = known && balances\.length === 0 && classHoldings\.length === 0/;
    assert.match(PANEL_CODE, emptyLine, "empty must count the vault");
    assert.match(PANEL_CODE, blindLine, "and so must blind");
  });

  it("puts the three headings in the confirm dialog, not a flat list", () => {
    assert.match(PANEL_CODE, /"CLASS VAULT"/, "the vault must be named in the dialog");
    assert.match(PANEL_CODE, /SMART ACCOUNT \$\{smartAccount/, "and the account");
    assert.match(PANEL_CODE, /"DESTINATION"/, "and the destination");
  });

  it("renders the vault's holdings on screen, keyed by token not symbol", () => {
    // A class token's symbol is frequently unreadable and falls back to a short
    // address, which is not unique — two such holdings would collide on a
    // symbol key and React would drop one.
    assert.match(PANEL_CODE, /classHoldings\.map\(\(h\)/, "the holdings must be rendered");
    assert.match(PANEL_CODE, /key=\{h\.token\}/, "keyed by token, which is unique");
  });

  it("says the vault is a separate contract, because that is why it needs saying", () => {
    assert.match(
      PANEL_CODE,
      /Held in a separate contract, not in the account/,
      "an owner must be told why this money was not in the balance list",
    );
  });
});
