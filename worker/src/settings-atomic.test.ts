/**
 * settings.json IS REPLACED WHOLE, NEVER TRUNCATED AND REFILLED.
 *
 * Both writers used a plain writeFileSync — O_TRUNC, then write. The hosted
 * orchestrator did that to every child's copy every fifteen seconds, and the
 * child did it on /link, /strategy and /cap, while the child re-reads the file
 * on every tick. A read that landed in between got an empty or half file,
 * `resolveConfig` parsed that as "no overrides", and the tick ran on the
 * defaults: paper, the default strategy, an empty Telegram allowlist.
 *
 * Pinned at the source (neither writer may go back to writeFileSync) and
 * executed: a reader on another thread reads in a loop while large payloads
 * are written, and must never see a file that does not parse. The same race
 * run against a plain writeFileSync is the control — it proves this harness
 * can see a tear at all, so a pass means something.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import * as cliAtomic from "../../cli/atomic-write.mjs";
import { RENAME_RETRY_MS, renameRetrying, renameRetryingSync, writeFileAtomic, writeFileAtomicSync } from "./atomic-write";
import { patchSettingsFile } from "./settings";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const ORCH = codeOf(readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8"));
const SETTINGS = codeOf(readFileSync(new URL("./settings.ts", import.meta.url), "utf8"));

function body(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone — re-point this test at the settings.json writer`);
  return src.slice(at, src.indexOf("\n}\n", at));
}

const IN_PLACE_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|copyFileSync)\s*\(/;
const posix = process.platform !== "win32";
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "merrymen-atomic-"));
const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".tmp"));

describe("neither settings.json writer truncates the file in place", () => {
  it("the orchestrator's writeChildSettings goes through writeFileAtomicSync", () => {
    const fn = body(ORCH, "function writeChildSettings(");
    assert.doesNotMatch(fn, IN_PLACE_WRITE, "a truncate-then-write is exactly the torn read this replaced");
    assert.match(fn, /writeFileAtomicSync\(file, next, 0o600\);/);
  });

  it("the child's patchSettingsFile goes through writeFileAtomicSync", () => {
    const fn = body(SETTINGS, "export function patchSettingsFile(");
    assert.doesNotMatch(fn, IN_PLACE_WRITE);
    assert.match(fn, /writeFileAtomicSync\(file, JSON\.stringify\(next, null, 2\), 0o600\);/);
  });

  it("and nothing else in either file writes a settings.json directly", () => {
    for (const [name, src] of [["orchestrator.ts", ORCH], ["settings.ts", SETTINGS]] as const) {
      for (const m of src.matchAll(/\bwriteFileSync\(([^;]*)/g)) {
        assert.doesNotMatch(m[1] ?? "", /settings\.json|homePaths\.settings|MERRYMEN_SETTINGS_FILE/, `${name}: ${m[0].slice(0, 120)}`);
      }
    }
    assert.doesNotMatch(SETTINGS, /\bwriteFileSync\b/, "settings.ts has no reason to hold a non-atomic writer");
  });
});

/**
 * EVERY IMPLEMENTATION OF THE PROCEDURE, held to the same tests. The web tier
 * cannot block on an fsync, so it has an async spelling; each one is run here
 * rather than trusted to match the one that was.
 */
const WRITERS: ReadonlyArray<{ name: string; write: (file: string, data: string, mode?: number) => void | Promise<void> }> = [
  { name: "writeFileAtomicSync", write: writeFileAtomicSync },
  { name: "writeFileAtomic (async, the web tier's)", write: writeFileAtomic },
  // Plain .mjs: the CLI cannot import TypeScript, so it keeps a copy.
  { name: "the CLI's writeFileAtomicSync (cli/atomic-write.mjs)", write: cliAtomic.writeFileAtomicSync },
];

for (const { name, write } of WRITERS) describe(name, () => {
  it("replaces the file whole, owner-only even over a looser file, and leaves no temp file", async () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, "settings.json");
      writeFileSync(file, '{"strategy":"old"}');
      if (posix) chmodSync(file, 0o644);
      await write(file, '{"strategy":"new"}', 0o600);
      assert.equal(readFileSync(file, "utf8"), '{"strategy":"new"}');
      if (posix) assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), ["settings.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes THROUGH a symlink — the link survives, as it did under writeFileSync", { skip: !posix }, async () => {
    const dir = tmpDir();
    try {
      mkdirSync(path.join(dir, "real"));
      mkdirSync(path.join(dir, "home"));
      const real = path.join(dir, "real", "settings.json");
      const link = path.join(dir, "home", "settings.json");
      writeFileSync(real, "{}");
      symlinkSync(real, link);
      await write(link, '{"a":1}');
      assert.ok(lstatSync(link).isSymbolicLink(), "rename must not replace the link with a regular file");
      assert.equal(readFileSync(real, "utf8"), '{"a":1}');
      assert.deepEqual(leftovers(path.join(dir, "real")), []);
      assert.deepEqual(leftovers(path.join(dir, "home")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed replace throws, removes its temp file, and leaves the target alone", async () => {
    const dir = tmpDir();
    try {
      // A directory at the name: the temp file is written, the rename is refused.
      const file = path.join(dir, "settings.json");
      mkdirSync(file);
      writeFileSync(path.join(file, "keep"), "x");
      await assert.rejects(async () => write(file, "{}"));
      assert.deepEqual(readdirSync(dir), ["settings.json"]);
      assert.equal(readFileSync(path.join(file, "keep"), "utf8"), "x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const absolute of [false, true]) {
    it(`creates a dangling ${absolute ? "absolute" : "relative"} symlink's destination without replacing the link`, { skip: !posix }, async () => {
      const dir = tmpDir();
      try {
        mkdirSync(path.join(dir, "real"));
        mkdirSync(path.join(dir, "home"));
        const real = path.join(dir, "real", "settings.json");
        const link = path.join(dir, "home", "settings.json");
        symlinkSync(absolute ? real : "../real/settings.json", link);
        await write(link, '{"a":1}');
        assert.ok(lstatSync(link).isSymbolicLink());
        assert.equal(readFileSync(real, "utf8"), '{"a":1}');
        assert.equal(statSync(real).mode & 0o777, 0o600);
        assert.deepEqual(leftovers(path.dirname(real)), []);
        assert.deepEqual(leftovers(path.dirname(link)), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("follows a dangling chain through a linked directory using the real link parent", { skip: !posix }, async () => {
    const dir = tmpDir();
    try {
      mkdirSync(path.join(dir, "real", "home"), { recursive: true });
      symlinkSync("real/home", path.join(dir, "home"));
      const link = path.join(dir, "home", "settings.json");
      const next = path.join(dir, "real", "next.json");
      symlinkSync("../next.json", link);
      symlinkSync("settings.json", next);
      await write(link, '{"a":1}');
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.ok(lstatSync(next).isSymbolicLink());
      assert.equal(readFileSync(path.join(dir, "real", "settings.json"), "utf8"), '{"a":1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves links untouched when their destination directory is missing or they form a loop", { skip: !posix }, async () => {
    const dir = tmpDir();
    try {
      const missing = path.join(dir, "missing.json");
      const loop = path.join(dir, "loop.json");
      symlinkSync("absent/settings.json", missing);
      symlinkSync("loop.json", loop);
      await assert.rejects(async () => write(missing, "{}"), { code: "ENOENT" });
      await assert.rejects(async () => write(loop, "{}"), { code: "ELOOP" });
      assert.ok(lstatSync(missing).isSymbolicLink());
      assert.ok(lstatSync(loop).isSymbolicLink());
      assert.deepEqual(leftovers(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * WINDOWS refuses a rename over a file another process holds open (antivirus,
 * indexer, editor) with EPERM/EACCES/EBUSY, where the truncating write this
 * replaced went through. Platform and rename are injected, so this runs anywhere.
 */
describe("the rename is retried, briefly, on Windows' transient refusals", () => {
  const failing = (codes: string[]) => {
    let calls = 0;
    return {
      fn: () => {
        const code = codes[Math.min(calls++, codes.length - 1)];
        if (code) throw Object.assign(new Error(code), { code });
      },
      calls: () => calls,
    };
  };

  it("busy twice, then through — sync and async", async () => {
    const a = failing(["EPERM", "EBUSY", ""]);
    renameRetryingSync("a", "b", "win32", a.fn);
    assert.equal(a.calls(), 3);
    const b = failing(["EACCES", "EPERM", ""]);
    await renameRetrying("a", "b", "win32", async () => b.fn());
    assert.equal(b.calls(), 3);
  });

  it("only on Windows, only for those codes, and not for ever", async () => {
    const linux = failing(["EPERM"]);
    assert.throws(() => renameRetryingSync("a", "b", "linux", linux.fn), /EPERM/);
    assert.equal(linux.calls(), 1, "elsewhere EPERM is a real answer");
    const missing = failing(["ENOENT"]);
    assert.throws(() => renameRetryingSync("a", "b", "win32", missing.fn), /ENOENT/);
    assert.equal(missing.calls(), 1);
    const stuck = failing(["EBUSY"]);
    await assert.rejects(renameRetrying("a", "b", "win32", async () => stuck.fn()), /EBUSY/);
    assert.equal(stuck.calls(), RENAME_RETRY_MS.length + 1, "gives up after the last wait");
  });

  it("both writers go through it", () => {
    const helper = readFileSync(new URL("./atomic-write.ts", import.meta.url), "utf8");
    assert.match(helper, /\n    renameRetryingSync\(tmp, target\);/);
    assert.match(helper, /\n    await renameRetrying\(tmp, target\);/);
  });
});

describe("patchSettingsFile", () => {
  let dir = "";
  let file = "";
  const saved = { home: process.env.MERRYMEN_HOME, file: process.env.MERRYMEN_SETTINGS_FILE };
  before(() => {
    dir = tmpDir();
    file = path.join(dir, "settings.json");
    process.env.MERRYMEN_HOME = dir;
    process.env.MERRYMEN_SETTINGS_FILE = file;
  });
  after(() => {
    for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_SETTINGS_FILE", saved.file]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges into the file, keeps every other key, stays 0600, leaves no temp file", () => {
    writeFileSync(file, "﻿" + JSON.stringify({ strategy: "steady-basket", telegramBotToken: "t", holderAddress: "0xabc" }));
    if (posix) chmodSync(file, 0o644);
    const next = patchSettingsFile({ strategy: "dip-hunter" });
    assert.deepEqual(next, { strategy: "dip-hunter", telegramBotToken: "t", holderAddress: "0xabc" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), next);
    if (posix) assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(dir), []);
  });

  it("creates the file when there is none", () => {
    rmSync(file, { force: true });
    assert.deepEqual(patchSettingsFile({ telegramMaxActionUsdg: 25 }), { telegramMaxActionUsdg: 25 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { telegramMaxActionUsdg: 25 });
  });

  it("REFUSES a file that is there but does not parse, rather than replacing it with the patch alone", () => {
    // An empty file is what a torn read of a truncating writer sees; a stray
    // comma is a self-hosted hand edit. Either way the old merge read `{}` and
    // wrote back the patch and nothing else.
    for (const broken of ["", '{"strategy":"steady-basket","telegramBotToken":"t",}']) {
      writeFileSync(file, broken);
      assert.throws(() => patchSettingsFile({ strategy: "dip-hunter" }), /not valid JSON/);
      assert.equal(readFileSync(file, "utf8"), broken, "untouched");
      assert.deepEqual(leftovers(dir), []);
    }
  });

  it("refuses valid JSON that is not a settings object without overwriting it", () => {
    for (const unusable of ["null", "[]", '"secret text"', "42", "true"]) {
      writeFileSync(file, unusable);
      assert.throws(() => patchSettingsFile({ strategy: "dip-hunter" }), /not a JSON object/);
      assert.equal(readFileSync(file, "utf8"), unusable);
      assert.deepEqual(leftovers(dir), []);
    }
  });
});

// ── the race ────────────────────────────────────────────────────────────────

/**
 * Reads `file` in a loop on its own thread until told to stop. flags[0] = stop,
 * flags[1] = reads that did not parse (or found no file), flags[2] = reads.
 * Plain CommonJS so it runs without the TypeScript loader.
 */
const READER = `
const { readFileSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const flags = new Int32Array(workerData.ctl);
const versions = new Set();
let lastError = "";
parentPort.postMessage("ready");
while (Atomics.load(flags, 0) === 0) {
  let text;
  try {
    text = readFileSync(workerData.file, "utf8");
  } catch (e) {
    Atomics.add(flags, 1, 1);
    lastError = String(e && e.code);
    continue;
  }
  Atomics.add(flags, 2, 1);
  try {
    const v = JSON.parse(text);
    if (typeof v.version !== "number" || typeof v.pad !== "string" || v.pad.length !== v.padLength) throw new Error("wrong shape");
    versions.add(v.version);
  } catch (e) {
    Atomics.add(flags, 1, 1);
    lastError = String(e).slice(0, 120) + " (" + text.length + " chars)";
  }
}
parentPort.postMessage({ versions: versions.size, lastError });
`;

interface RaceResult {
  writes: number;
  reads: number;
  torn: number;
  versions: number;
  lastError: string;
}

/** Sizes alternate so a half-written file can never pass for a whole one. */
const payload = (version: number) => {
  const padLength = version % 2 === 0 ? 2 * 1024 * 1024 : 512 * 1024;
  return { version, padLength, pad: "x".repeat(padLength) };
};

async function race(write: (file: string, version: number) => void | Promise<void>, iterations: number, stopOnTear = false): Promise<RaceResult> {
  const dir = tmpDir();
  const file = path.join(dir, "settings.json");
  writeFileAtomicSync(file, JSON.stringify(payload(0)));
  const ctl = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const flags = new Int32Array(ctl);
  const reader = new Worker(READER, { eval: true, workerData: { file, ctl } });
  try {
    const finished = new Promise<{ versions: number; lastError: string }>((resolve, reject) => {
      reader.on("message", (m) => m !== "ready" && resolve(m));
      reader.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      reader.once("message", () => resolve());
      reader.once("error", reject);
    });
    // Do not start writing until the reader is actually reading.
    const deadline = Date.now() + 5_000;
    while (Atomics.load(flags, 2) === 0 && Date.now() < deadline) {
      /* spin — the reader is another thread */
    }
    let writes = 0;
    for (let v = 1; v <= iterations; v++) {
      await write(file, v);
      writes++;
      if (stopOnTear && Atomics.load(flags, 1) > 0) break;
    }
    Atomics.store(flags, 0, 1);
    const { versions, lastError } = await finished;
    return { writes, reads: Atomics.load(flags, 2), torn: Atomics.load(flags, 1), versions, lastError };
  } finally {
    await reader.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a reader racing a settings.json write never gets a file that does not parse", () => {
  it("CONTROL: the old truncate-then-write is caught tearing by this same race", async () => {
    const r = await race((file, v) => writeFileSync(file, JSON.stringify(payload(v)), { encoding: "utf8", mode: 0o600 }), 5_000, true);
    assert.ok(r.torn > 0, `no torn read in ${r.writes} plain writes / ${r.reads} reads — the harness cannot see the bug`);
  });

  it("CONTROL: the async truncate-then-write (fs/promises writeFile) tears too — the web route's old writer", async () => {
    const r = await race((file, v) => writeFile(file, JSON.stringify(payload(v)), { encoding: "utf8", mode: 0o600 }), 5_000, true);
    assert.ok(r.torn > 0, `no torn read in ${r.writes} plain writes / ${r.reads} reads — the harness cannot see the bug`);
  });

  for (const { name, write } of WRITERS) {
    it(`${name}: every read parses, and the reader saw the file change under it`, async () => {
      const r = await race((file, v) => write(file, JSON.stringify(payload(v))), 150);
      assert.equal(r.torn, 0, `${r.torn} of ${r.reads} reads failed — last: ${r.lastError}`);
      assert.ok(r.versions >= 3, `the reader saw ${r.versions} version(s) in ${r.reads} reads — it never raced the writes`);
    });
  }

  it("patchSettingsFile, the child's writer: the same", async () => {
    const saved = { home: process.env.MERRYMEN_HOME, file: process.env.MERRYMEN_SETTINGS_FILE };
    const home = tmpDir();
    process.env.MERRYMEN_HOME = home;
    try {
      const r = await race((file, v) => {
        process.env.MERRYMEN_SETTINGS_FILE = file;
        patchSettingsFile(payload(v) as never);
      }, 150);
      assert.equal(r.torn, 0, `${r.torn} of ${r.reads} reads failed — last: ${r.lastError}`);
      assert.ok(r.versions >= 3, `the reader saw ${r.versions} version(s) in ${r.reads} reads — it never raced the writes`);
    } finally {
      for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_SETTINGS_FILE", saved.file]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
