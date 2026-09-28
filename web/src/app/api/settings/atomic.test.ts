import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * SELF-HOSTED, THE WEB UI REPLACES settings.json WHOLE — AND NEVER OVER A FILE
 * IT COULD NOT READ.
 *
 * The worker re-reads ~/.merrymen/settings.json every tick. This route wrote it
 * with fs/promises writeFile — O_TRUNC, then write — so a tick that read in
 * between got an empty or half file and ran on the defaults: paper, the default
 * strategy, an empty Telegram allowlist. The race itself, and a control proving
 * the harness sees a plain writeFile tear, are in worker/src/settings-atomic.test.ts;
 * this file pins that the route uses the writer that race clears, and drives
 * the real PUT against a real file.
 *
 * And the read half: PUT merges the body into what it read and writes the
 * result back whole, so a file that did not parse was read as `{}` and every
 * key the request did not carry — the owner's API keys, strategy, wallets —
 * was gone. It is refused now, and left exactly as it was.
 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const ROUTE = codeOf(readFileSync(new URL("./route.ts", import.meta.url), "utf8"));
const posix = process.platform !== "win32";

describe("the settings route's self-hosted write is atomic", () => {
  it("has no in-place writer for settings.json at all", () => {
    assert.doesNotMatch(
      ROUTE,
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|truncate)\s*\(/,
      "a truncate-then-write is the torn read this replaced",
    );
    assert.doesNotMatch(ROUTE, /\bchmod\s*\(/, "the mode is set on the temp file, before it is visible");
  });

  it("writes through writeFileAtomic, owner-only", () => {
    assert.match(ROUTE, /import \{ writeFileAtomic \} from "@merrymen\/atomic-write";/);
    assert.match(ROUTE, /await writeFileAtomic\(SETTINGS_FILE, JSON\.stringify\(next, null, 2\), 0o600\);/);
  });

  it("PUT reads strictly, and refuses before merging anything", () => {
    const put = ROUTE.slice(ROUTE.indexOf("export async function PUT("));
    const strict = put.indexOf("await readStoredStrict(tenant)");
    assert.ok(strict > 0, "PUT must read with readStoredStrict — readStored turns a broken file into {}");
    assert.doesNotMatch(put, /await readStored\(/, "the lenient reader is for display only");
    assert.ok(strict < put.indexOf("const next: MerrymenSettings = { ...stored };"), "the refusal comes before the merge");
  });
});

describe("PUT /api/settings against a real settings.json", () => {
  let home: string;
  let PUT: (req: Request) => Promise<Response>;
  const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED };
  const file = () => path.join(home, "settings.json");
  const leftovers = () => readdirSync(home).filter((n) => n.endsWith(".tmp"));

  before(async () => {
    home = mkdtempSync(path.join(tmpdir(), "mm-settings-atomic-"));
    process.env.MERRYMEN_HOME = home;
    delete process.env.MERRYMEN_HOSTED;
    // After the env: the route resolves its settings path when it loads.
    ({ PUT } = await import("./route"));
  });
  after(() => {
    for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const put = async (body: unknown) => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[] } };
  };

  it("replaces the file by rename — a new inode, 0600 over a looser file, every other key kept, no temp file", async () => {
    writeFileSync(file(), "﻿" + JSON.stringify({ strategy: "dip-hunter", telegramBotToken: "123456:secret-token" }));
    if (posix) chmodSync(file(), 0o644);
    const before = statSync(file()).ino;
    const r = await put({ publicBook: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    assert.deepEqual(after, { strategy: "dip-hunter", telegramBotToken: "123456:secret-token", publicBook: true });
    // writeFile keeps the inode it truncated; only a rename installs a new one.
    if (posix) assert.notEqual(statSync(file()).ino, before, "the file was rewritten in place, not replaced");
    if (posix) assert.equal(statSync(file()).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(), []);
  });

  it("creates the file when there is none", async () => {
    rmSync(file(), { force: true });
    const r = await put({ publicBook: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")), { publicBook: false });
  });

  it("REFUSES a file that is there but does not parse, and leaves it byte for byte", async () => {
    // Empty is what a read racing a truncating writer sees; the stray comma is a
    // hand edit; `null` and an array parse, but are not settings.
    for (const broken of ["", '{"strategy":"dip-hunter","telegramBotToken":"123456:secret-token",}', "null", "[]"]) {
      writeFileSync(file(), broken);
      const r = await put({ publicBook: true });
      assert.equal(r.status, 409, `${JSON.stringify(broken)} was merged over: ${JSON.stringify(r.body)}`);
      assert.match(r.body.errors?.[0] ?? "", /settings\.json is not valid JSON — nothing was saved/);
      assert.equal(readFileSync(file(), "utf8"), broken, "untouched");
      assert.deepEqual(leftovers(), []);
    }
  });
});
