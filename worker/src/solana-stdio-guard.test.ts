/**
 * EVERY SOLANA PROCESS IS INSIDE #347'S OUTPUT-REDACTION NET.
 *
 * The Solana worker (the hosted start:solana role) and the operator and owner
 * CLIs print only fixed text today, but a keyed RPC URL reached Railway's logs
 * once through an error nobody meant to print (redact-urls.ts). So each entry
 * point installs guardStdio first, and the Solana RPC providers whose key is
 * in the URL are keyed hosts. Proven both ways: in the source, and by running
 * each entry point with a preload that writes a keyed URL once the entry's
 * own code has started.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REDACTED, redactUrls } from "./redact-urls";

const ENTRIES = ["solana-agent-cli.ts", "solana-paper-cli.ts", "solana-rpc-check.ts", "solana-hold-cli.ts", "solana-resolve-cli.ts", "solana-recover-cli.ts"] as const;
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const source = (f: string) => codeOf(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));

/** Made up, in each provider's own shape. */
const KEYED = {
  helius: "https://mainnet.helius-rpc.com/?api-key=3f9c2a71-5b0e-4d8a-9c6f-0e1d2b3a4c5d",
  heliusLegacy: "https://rpc.helius.xyz/?api-key=3f9c2a71-5b0e-4d8a-9c6f-0e1d2b3a4c5d",
  alchemy: "https://solana-mainnet.g.alchemy.com/v2/Fk7qZ2mXw9Lr4TbN0cVyH3sJ8dPaQe6U",
  quicknode: "https://young-sly-pond.solana-mainnet.quiknode.pro/4a1b6c9e2d7f8a3b5c0d1e2f3a4b5c6d7e8f9a0b/",
  triton: "https://acme-mainnet-a1b2.mainnet.rpcpool.com/plainlowercasetokenvalue0123",
  syndica: "https://solana-mainnet.api.syndica.io/api-key/plainlowercasetokenvalue0123",
};

describe("Solana RPC URLs with a key in them", () => {
  it("keep their scheme and host and lose the key, in every provider's shape", () => {
    for (const [name, url] of Object.entries(KEYED)) {
      const host = new URL(url).host;
      assert.equal(redactUrls(`rpc failed: ${url} (timeout)`), `rpc failed: https://${host}/${REDACTED} (timeout)`, name);
    }
    // Triton's and Syndica's tokens are lower case: only the keyed-host rule removes them.
    assert.equal(redactUrls("https://acme.mainnet.rpcpool.com/abcdefghijklmnopqrstuvwxyz"), `https://acme.mainnet.rpcpool.com/${REDACTED}`);
  });

  it("leave public Solana URLs readable", () => {
    for (const url of ["https://api.mainnet-beta.solana.com", "https://api.mainnet-beta.solana.com/", "https://acme.helius-rpc.com/",
      "https://solscan.io/tx/5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"]) {
      assert.equal(redactUrls(url), url);
    }
  });
});

describe("the Solana entry points guard their own output", () => {
  it("install guardStdio before anything else runs", () => {
    for (const f of ENTRIES.filter((e) => e !== "solana-agent-cli.ts")) {
      const code = source(f);
      assert.match(code, /^import \{ guardStdio \} from "\.\/redact-stdio";/, f);
      // The first statement after the imports.
      assert.match(code, /^(?:import [^\n]*\n|\s*\n)*guardStdio\(\);\s*try \{/, f);
    }
    assert.match(source("solana-agent-cli.ts"), /async function main\(\): Promise<void> \{\s*guardStdio\(\);\s*const args = process\.argv\.slice\(2\);/);
  });

  it("and a keyed URL written once each has started comes out redacted", { timeout: 120_000 }, async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "solana-stdio-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const key = "3f9c2a71-5b0e-4d8a-9c6f-0e1d2b3a4c5d";
    const probe = path.join(directory, "probe.mjs");
    // A preload runs before the entry. On Node 22 tsx loads the entry's module
    // graph asynchronously, so a single setImmediate can fire before any of the
    // entry's code has run. The probe therefore waits, one event-loop turn at a
    // time, until the entry has started and guarded both streams, then writes.
    // If no guard ever appears it writes anyway after 20 s, unredacted, and the
    // assertions below fail.
    writeFileSync(probe, `const G = Symbol.for("merrymen.redactUrls.guarded"); const until = Date.now() + 20000;\n`
      + `const write = () => { process.stderr.write("probe https://mainnet.helius-rpc.com/?api-key=${key}\\n"); `
      + `process.stdout.write("probe https://acme.mainnet.rpcpool.com/plainlowercasetokenvalue0123\\n"); };\n`
      + `const wait = () => (process.stdout[G] && process.stderr[G]) || Date.now() > until ? write() : setImmediate(wait);\n`
      + `setImmediate(wait);\n`);
    const env: Record<string, string> = { MERRYMEN_HOME: path.join(directory, "home"), NO_COLOR: "1" };
    for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) if (process.env[name] !== undefined) env[name] = process.env[name]!;
    const tsx = import.meta.resolve("tsx");
    const run = (entry: string) => new Promise<{ entry: string; out: string }>((resolve, reject) => {
      // --help where the entry has one: nothing is opened, read or sent.
      const args = entry === "solana-rpc-check.ts" || entry === "solana-hold-cli.ts" ? [] : ["--help"];
      const child = spawn(process.execPath, ["--import", tsx, "--import", pathToFileURL(probe).href,
        fileURLToPath(new URL(`./${entry}`, import.meta.url)), ...args], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", (d) => { out += String(d); });
      child.on("error", reject);
      child.on("close", () => resolve({ entry, out }));
    });
    for (const { entry, out } of await Promise.all(ENTRIES.map(run))) {
      assert.match(out, /probe https:\/\/mainnet\.helius-rpc\.com\/\[redacted\]/, `${entry}: ${out}`);
      assert.match(out, /probe https:\/\/acme\.mainnet\.rpcpool\.com\/\[redacted\]/, `${entry}: ${out}`);
      assert.ok(!out.includes(key) && !out.includes("plainlowercasetokenvalue0123"), `${entry} printed a key`);
    }
  });
});
