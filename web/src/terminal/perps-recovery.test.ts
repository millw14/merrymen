import assert from "node:assert/strict";
import { it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PerpsRecoveryNotice } from "./PerpsRecoveryNotice";
(globalThis as unknown as { React: typeof React }).React = React;

it("recovery notices distinguish paused and unknown, keep spot/paper available and never print raw failure data", () => {
  const render = (status: unknown) => renderToStaticMarkup(React.createElement(PerpsRecoveryNotice, { status }));
  assert.equal(render(null), "");
  assert.equal(render({ state: "healthy" }), "");
  const paused = render({ state: "paused", message: "DATABASE_SECRET_OR_KEY" });
  assert.match(paused, /Live perpetuals are paused/);
  assert.match(paused, /Spot and paper trading remain available/);
  assert.doesNotMatch(paused, /DATABASE_SECRET_OR_KEY/);
  assert.match(render({ state: "unknown" }), /could not be checked/);
});
