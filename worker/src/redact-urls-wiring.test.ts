/**
 * THE GUARDS ARE WHERE THE LEAK WAS, and stay there.
 *
 * redact-urls.test.ts proves the helper; this file proves the places that
 * printed a keyed RPC URL on 2026-10-17 now go through it: the orchestrator's
 * relay of every child's output (exercised for real), and the two entry points
 * whose stdout and stderr Railway keeps (pinned in the source, the way
 * silence.test.ts pins the tick's event).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import { relayChildOutput } from "./orchestrator";
import { REDACTED } from "./redact-urls";

/** Made up, Alchemy-shaped. See redact-urls.test.ts. */
const KEY = "Fk7qZ2mXw9Lr4TbN0cVyH3sJ8dPaQe6U";
const HOST = "robinhood-mainnet.g.alchemy.com";
const KEYED = `https://${HOST}/v2/${KEY}`;

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const source = (f: string) => codeOf(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));

describe("the orchestrator's relay of a child's output", () => {
  it("writes whole, tagged lines with the key gone, however the pipe chunked them", async () => {
    const child = new PassThrough();
    const written: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        written.push(String(chunk));
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    relayChildOutput(child, sink, "[0xab7bde]");
    // What a child's `console.error("[tick]", e)` emits for a declined read,
    // cut mid-key the way a 64KB pipe buffer can cut it.
    const line = `[tick] ContractFunctionExecutionError: HTTP request failed.\n\nURL: ${KEYED}\n  url: '${KEYED}',\n`;
    const cut = line.indexOf(KEY) + 7;
    child.write(Buffer.from(line.slice(0, cut)));
    child.write(Buffer.from(line.slice(cut)));
    child.end("no newline at the end");
    await new Promise((r) => child.on("end", r));
    const out = written.join("");
    assert.ok(!out.includes(KEY.slice(0, 8)) && !out.includes(KEY.slice(-8)), out);
    assert.deepEqual(written, [
      "[0xab7bde] [tick] ContractFunctionExecutionError: HTTP request failed.\n",
      `[0xab7bde] URL: https://${HOST}/${REDACTED}\n`,
      `[0xab7bde]   url: 'https://${HOST}/${REDACTED}',\n`,
      "[0xab7bde] no newline at the end\n",
    ]);
  });

  it("is the only way a child's or a holder's output reaches the log", () => {
    const orch = source("orchestrator.ts");
    assert.equal((orch.match(/relayChildOutput\((proc|holderProc)\.(stdout|stderr), process\.\2, tag\)/g) ?? []).length, 4);
    // The old inline relays split chunks and redacted nothing.
    assert.doesNotMatch(orch, /\.on\("data", \(c: Buffer\) =>\s*String\(c\)/);
  });
});

describe("the entry points guard their own output first", () => {
  it("a worker child, before its store or its first read", () => {
    const index = source("index.ts");
    const main = index.slice(index.indexOf("async function main() {"));
    assert.match(main, /^async function main\(\) \{\s*guardStdio\(\);\s*await initStore\(\);/);
  });

  it("the orchestrator, before it runs", () => {
    const orch = source("orchestrator.ts");
    assert.match(orch, /fileURLToPath\(import\.meta\.url\) === path\.resolve\(process\.argv\[1\]\)\) \{\s*guardStdio\(\);\s*void runOrchestrator\(\);/);
  });
});

describe("the other places a caught error leaves the process", () => {
  /** The unredacted idiom, which none of these sites may use any more. */
  const RAW = /e instanceof Error \? e\.message : String\(e\)/;

  it("the Telegram replies, the LLM tool results and the recovery reasons", () => {
    const service = source("telegram/service.ts");
    assert.match(service, /const m = errorText\(e\);\s*deps\.note\("warn", `Telegram: \$\{cmd\.kind\} failed/);
    assert.match(service, /`🚫 that failed: \$\{esc\(errorText\(e\)\.slice\(0, 200\)\)\}`/);
    assert.match(source("telegram/answer.ts"), /That lookup failed \(\$\{e instanceof Error \? errorText\(e\)/);
    const agent = source("telegram/agent.ts");
    assert.match(agent, /impl\.exec\(use\.input\)\.catch\(\(e: unknown\) => `error: \$\{errorText\(e\)\}`\)/);
    assert.match(agent, /const m = errorText\(e\);\s*deps\.note\("warn", `Telegram agent: failed/);
    assert.match(source("strategist/desk.ts"), /`that could not be read: \$\{errorText\(e\)\}`/);
    const recover = source("recover.ts");
    assert.match(recover, /could not check the class vault: \$\{errorText\(e\)\}/);
    assert.match(recover, /const why = errorText\(e\);/);
    assert.match(recover, /const msg = errorText\(e\);/);
  });

  it("the web routes that hand a chain error to the browser", () => {
    const web = (f: string) => codeOf(readFileSync(new URL(`../../web/src/app/api/${f}`, import.meta.url), "utf8"));
    assert.match(web("recover/route.ts"), /const msg = \(e: unknown\) => errorText\(e\);/);
    const circle = web("circle/route.ts");
    assert.match(circle, /error: errorText\(e\),/);
    assert.doesNotMatch(circle, RAW);
    assert.match(web("grants/route.ts"), /derivationUnreachable\(errorText\(e\)\)/);
  });

  it("the hold process and the recovery-replies role guard their own output", () => {
    assert.match(source("telegram-hold.ts"), /guardStdio\(\);\s*const tgState = createStateRef\(\);/);
    assert.match(source("recovery-replies.ts"), /pathToFileURL\(process\.argv\[1\]\)\.href\) \{\s*guardStdio\(\);/);
  });
});
