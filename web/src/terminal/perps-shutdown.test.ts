import assert from "node:assert/strict";
import { it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PerpsShutdownNotice, perpsShutdownLines } from "./PerpsShutdownNotice";
import { killPerpsFromStatus } from "../lib/perps-exposure";
(globalThis as unknown as { React: typeof React }).React = React;
it("deleted grant with queued, unknown or residual shutdown retains a custody warning", () => {
  for (const job of [{ state: "pending", result: null }, { state: "queued", result: null }, { state: "unknown" }, { state: "done", result: { outcome: "residual", openPositions: 1, collateralMicro: "1500000", ingested: true } }]) {
    assert.equal(killPerpsFromStatus({ exists: false, perpsShutdown: job }, Date.now()).exposure?.kind, "unread");
    const text = renderToStaticMarkup(React.createElement(PerpsShutdownNotice, { status: job }));
    assert.match(text, /Perpetual shutdown custody/); assert.match(text, /even after the agent is removed/);
    assert.doesNotMatch(text, /funds are home|account is empty/);
  }
});
it("a completed worker result does not imply the withdrawal claim arrived", () => {
  assert.match(perpsShutdownLines({ state: "done", result: { outcome: "done", openPositions: 0, ordersLeft: 0, collateralMicro: "0" } })!.join(" "), /does not by itself prove that funds have arrived home/);
  assert.equal(perpsShutdownLines(null), null);
});
