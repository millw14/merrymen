/**
 * THE SELF-HOSTED PERPS SAVE WRITES ONLY OVER THE settings.json IT READ
 * (settings.ts writeSettingsFileIfUnchanged).
 *
 * The kill turns the Perps home's `perpsEnabled` off in the same file the
 * settings PUT replaces whole, under a short cross-process file lock: here
 * (turnOffLocalPaperPerps) and from another one (`merrymen kill`, a
 * self-hosted Telegram /kill). The save reads the file, judges its body, and
 * hands this the text it read; a write that landed in between must make it
 * write nothing and say so, or the save puts its stale blob back over the
 * kill and practice perps are on again under a kill that answered "off".
 *
 * Nothing pinned that comparison: the route-level kill-race sweep can never
 * land a kill inside the save's read-to-write window (it has no event-loop
 * turn in it), so `if (now !== seen) return false` could be deleted and every
 * settings test still passed. Pinned here directly, byte for byte, and through
 * the real PUT in web/src/app/api/settings/perps-kill-race.test.ts.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { readSettingsFileWithText, writeSettingsFileIfUnchanged } from "./settings";

const root = mkdtempSync(path.join(tmpdir(), "mm-settings-if-unchanged-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
let n = 0;
/** A fresh Perps home's settings.json path, the directory not yet made. */
const fileIn = () => path.join(root, `home-${n++}`, "accounts", "perps", "settings.json");
const mode = (f: string) => statSync(f).mode & 0o777;

const READ = JSON.stringify({ strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 2 }, null, 2);
const KILLED = JSON.stringify({ strategy: "perps-only", perpsEnabled: false, perpsMaxLeverage: 2 }, null, 2);
const STALE_SAVE = JSON.stringify({ strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 3 }, null, 2);

describe("writeSettingsFileIfUnchanged: a write only over the text that was read", () => {
  it("A KILL THAT LANDED AFTER THE READ: nothing is written, false, and the kill's file is left byte for byte", () => {
    const f = fileIn();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, READ, { mode: 0o600 });
    const { text: seen } = readSettingsFileWithText(f);
    assert.equal(seen, READ);
    // Another process's kill: the file now says off.
    writeFileSync(f, KILLED);
    chmodSync(f, 0o640);
    const before = readFileSync(f);
    assert.equal(writeSettingsFileIfUnchanged(f, seen, STALE_SAVE), false);
    assert.deepEqual(readFileSync(f), before, "the kill's bytes stand");
    assert.equal(mode(f), 0o640, "not even rewritten with the same bytes");
  });

  it("nothing changed since the read: written whole, 0600, true", () => {
    const f = fileIn();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, READ);
    chmodSync(f, 0o644);
    const { text: seen } = readSettingsFileWithText(f);
    assert.equal(writeSettingsFileIfUnchanged(f, seen, STALE_SAVE), true);
    assert.equal(readFileSync(f, "utf8"), STALE_SAVE);
    assert.equal(mode(f), 0o600);
    // And the text it read is good for one write only: asked again with it, it misses.
    assert.equal(writeSettingsFileIfUnchanged(f, seen, READ), false);
    assert.equal(readFileSync(f, "utf8"), STALE_SAVE);
  });

  it("read as absent (null), and a file made since: nothing is written over it", () => {
    const f = fileIn();
    const { read, text: seen } = readSettingsFileWithText(f);
    assert.equal(read.kind, "absent");
    assert.equal(seen, null);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, KILLED);
    assert.equal(writeSettingsFileIfUnchanged(f, seen, STALE_SAVE), false);
    assert.equal(readFileSync(f, "utf8"), KILLED);
  });

  it("read as absent and still absent: made, 0600, with its directory", () => {
    const f = fileIn();
    assert.equal(writeSettingsFileIfUnchanged(f, null, STALE_SAVE), true);
    assert.equal(readFileSync(f, "utf8"), STALE_SAVE);
    assert.equal(mode(f), 0o600);
  });

  it("read with text, and the file removed since: not made again", () => {
    const f = fileIn();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, READ);
    const { text: seen } = readSettingsFileWithText(f);
    rmSync(f);
    assert.equal(writeSettingsFileIfUnchanged(f, seen, STALE_SAVE), false);
    assert.equal(existsSync(f), false);
  });

  it("the version is the RAW text: a BOM the reader strips to parse still matches, and one byte of difference does not", () => {
    const f = fileIn();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, `﻿${READ}`);
    const { read, text: seen } = readSettingsFileWithText(f);
    assert.equal(read.kind, "parsed");
    assert.equal(seen, `﻿${READ}`);
    // A save that read it writes over it…
    assert.equal(writeSettingsFileIfUnchanged(f, seen, STALE_SAVE), true);
    // …and one whose read differs by a trailing newline (an editor's save) does not.
    writeFileSync(f, READ);
    assert.equal(writeSettingsFileIfUnchanged(f, `${READ}\n`, KILLED), false);
    assert.equal(readFileSync(f, "utf8"), READ);
  });

  it("a file that cannot be looked at throws, and nothing is written", () => {
    const f = fileIn();
    mkdirSync(f, { recursive: true }); // settings.json is a directory: EISDIR
    assert.throws(() => writeSettingsFileIfUnchanged(f, null, STALE_SAVE), /EISDIR/);
    assert.equal(statSync(f).isDirectory(), true);
  });
});
