import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { desktopPollDelay, desktopStatusLine, isDesktopApp, type DesktopState } from "./DesktopApp";

const base: DesktopState = {
  status: "unchecked",
  version: null,
  percent: null,
  appVersion: "0.1.8-dev.4",
  beta: false,
  paused: false,
};

describe("DesktopApp helpers", () => {
  it("stays silent outside the Electron window", () => {
    assert.equal(isDesktopApp(), false);
  });

  it("polls fast only while an update is in flight", () => {
    assert.equal(desktopPollDelay("checking"), 5000);
    assert.equal(desktopPollDelay("downloading"), 5000);
    for (const s of ["unchecked", "current", "available", "ready", "error"]) {
      assert.equal(desktopPollDelay(s), 20000);
    }
  });

  it("renders one honest line per update state", () => {
    assert.equal(desktopStatusLine({ ...base, status: "checking" }), "Checking for updates…");
    assert.equal(
      desktopStatusLine({ ...base, status: "current" }),
      "Up to date — 0.1.8-dev.4 is the latest.",
    );
    assert.equal(
      desktopStatusLine({ ...base, status: "available", version: "0.1.8-dev.5" }),
      "Version 0.1.8-dev.5 is available (you have 0.1.8-dev.4).",
    );
    assert.equal(
      desktopStatusLine({ ...base, status: "downloading", version: "0.1.8-dev.5", percent: 42 }),
      "Downloading 0.1.8-dev.5… 42%",
    );
    assert.equal(
      desktopStatusLine({ ...base, status: "ready", version: "0.1.8-dev.5" }),
      "Version 0.1.8-dev.5 downloaded — restart to install.",
    );
    assert.equal(desktopStatusLine({ ...base, status: "error" }), "Update check failed.");
    assert.equal(desktopStatusLine(base), "App version 0.1.8-dev.4.");
  });
});
