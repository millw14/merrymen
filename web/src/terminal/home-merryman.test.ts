/**
 * HOME NEVER INVITES AN OWNER TO CREATE WHAT THEY ALREADY HAVE.
 *
 * `mine` is null while an existing owner's book loads or fails to load, and
 * the newcomer's "Meet your merryman… Create your merryman" used to render for
 * them too — to a live, real-money owner, indefinitely while a read failed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createElement } from "react";

import { testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
beforeEach(() => { ui = testDom(); });
afterEach(async () => { await ui.close(); });

const noop = () => {};
const props = { tokens: [], agents: [], theses: [], read: "ok", tokenTab: "buys", onTokenTab: noop, onToken: noop, onAgent: noop, onDeposit: noop, onSearch: noop, onDesk: noop, onCreate: noop, onWardrobe: noop };

it("an owner whose book is loading or unreadable is told so, not invited to create", async () => {
  const { Home } = await import("./screens/Home");
  for (const phase of ["loading", "failed"] as const) {
    await ui.render(createElement(Home, { ...props, mine: null, hasAgent: true, phase } as never));
    const text = ui.container.textContent ?? "";
    assert.doesNotMatch(text, /Meet your merryman|Create your merryman/, phase);
    assert.match(text, phase === "failed" ? /Can't reach your merryman's numbers/ : /Fetching your merryman's numbers/);
  }
});

it("a newcomer is invited, and the invitation goes to create", async () => {
  const { Home } = await import("./screens/Home");
  let created = 0;
  await ui.render(createElement(Home, { ...props, onCreate: () => created++, mine: null, hasAgent: false, phase: "no-agent" } as never));
  assert.match(ui.container.textContent ?? "", /Meet your merryman/);
  await ui.click("Create your merryman");
  assert.equal(created, 1);
});

it("a signed-out visitor gets the way back in, and a signed-in newcomer does not", async () => {
  const { Home } = await import("./screens/Home");
  const signIn = createElement("button", { type: "button" }, "Continue with email");
  await ui.render(createElement(Home, { ...props, mine: null, hasAgent: false, phase: "signed-out", signIn } as never));
  const signedOut = ui.container.textContent ?? "";
  assert.match(signedOut, /Already have a merryman\?/);
  assert.match(signedOut, /Continue with email/);
  // Still the newcomer's invitation too: signing in is offered beside it, not instead of it.
  assert.match(signedOut, /Create your merryman/);

  await ui.render(createElement(Home, { ...props, mine: null, hasAgent: false, phase: "no-agent", signIn } as never));
  assert.doesNotMatch(ui.container.textContent ?? "", /Already have a merryman\?|Continue with email/);
});
