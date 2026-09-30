/**
 * THE CHECKLIST DOES NOT TELL A FUNDED OWNER TO ADD FUNDS BECAUSE A READ FAILED.
 *
 * /api/grants says null for a balance it could not read, and canStart reads
 * null as "cannot start" — right for a readiness signal, and exactly the value
 * that drew "Add trading funds" and an "Add funds" button on the Settings
 * screen. An RPC hiccup became an instruction about money. Rendered, so what
 * is tested is what the owner is shown.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupStep } from "@/lib/can-start";

(globalThis as unknown as { React: typeof React }).React = React;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("which setup step an account is on", () => {
  it("an unread balance is not an empty one", () => {
    assert.equal(setupStep({ exists: true, balances: { ethWei: null, cashUsdg: null, vaultUsdg: null } }, false), "unread");
    assert.equal(setupStep({ exists: true }, false), "unread", "a status with no balances said nothing about them");
    assert.equal(
      setupStep({ exists: true, gasSponsored: true, balances: { ethWei: "0", cashUsdg: null, vaultUsdg: "0" } }, false),
      "unread",
      "sponsored, the cash leg decides — and it was not read",
    );
  });

  it("a measured zero still asks for funds", () => {
    assert.equal(setupStep({ exists: true, balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" } }, false), "fund");
    assert.equal(setupStep({ exists: true, gasSponsored: true, balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" } }, false), "fund");
  });

  it("gas, sponsored capital or paper mean there is nothing left to do", () => {
    assert.equal(setupStep({ exists: true, balances: { ethWei: "5" } }, false), "done");
    assert.equal(setupStep({ exists: true, gasSponsored: true, balances: { ethWei: "0", cashUsdg: "5", vaultUsdg: null } }, false), "done");
    assert.equal(setupStep({ exists: true, balances: { ethWei: null } }, true), "done");
    assert.equal(setupStep({ exists: false }, false), "create");
  });
});

describe("what the checklist draws", () => {
  const draw = async (status: object, paper = false) => {
    const { SetupProgress } = await import("./SetupChecklist");
    return text(renderToStaticMarkup(createElement(SetupProgress, { status: status as never, paper, onFund: () => {} })));
  };

  it("no Add funds for a balance nobody read — it says it could not read it", async () => {
    const html = await draw({ exists: true, balances: { ethWei: null, cashUsdg: null, vaultUsdg: null } });
    assert.doesNotMatch(html, /Add funds/);
    assert.match(html, /couldn.t read your balance/i);
  });

  it("Add funds for a balance read as zero", async () => {
    const html = await draw({ exists: true, balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" } });
    assert.match(html, /Add funds/);
  });

  it("nothing once the account can trade", async () => {
    assert.equal(await draw({ exists: true, balances: { ethWei: "5" } }), "");
  });
});
