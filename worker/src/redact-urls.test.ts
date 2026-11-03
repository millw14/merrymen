import assert from "node:assert/strict";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { ContractFunctionExecutionError, HttpRequestError, createPublicClient, erc20Abi, http } from "viem";
import { classifyRpcError, DECLINED_MARKER } from "./rpc-error";
import { REDACTED, errorText, redactLighterSecrets, redactUrls } from "./redact-urls";
import { guardStdio, lineRedactor } from "./redact-stdio";

/**
 * A made-up key in the shape Alchemy issues: 32 characters of base64url. It is
 * not, and never was, a real credential — every assertion below is about
 * whether THIS string survives, so it must be one nothing else would print.
 */
const KEY = "Fk7qZ2mXw9Lr4TbN0cVyH3sJ8dPaQe6U";
const HOST = "robinhood-mainnet.g.alchemy.com";
const KEYED = `https://${HOST}/v2/${KEY}`;

/**
 * Any eight characters of the key, anywhere. A slice that cut the URL in half
 * must not leave the half it kept.
 */
function leaksKey(text: string): boolean {
  for (let i = 0; i + 8 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 8))) return true;
  return false;
}

/**
 * Exactly how a child's read fails while the governor is declining: viem's
 * http transport calls the fetch, the fetch throws the declined marker, viem
 * wraps it as an HttpRequestError naming the transport's URL, and readContract
 * wraps THAT twice more. No socket is opened.
 */
async function declinedRead(): Promise<unknown> {
  const client = createPublicClient({
    transport: http(KEYED, {
      retryCount: 0,
      fetchFn: async () => {
        throw new Error(`${DECLINED_MARKER}: not sent — the endpoint refused this process 3 time(s) in a row`);
      },
    }),
  });
  try {
    await client.readContract({
      address: "0x1111111111111111111111111111111111111111",
      abi: erc20Abi,
      functionName: "balanceOf",
      args: ["0x2222222222222222222222222222222222222222"],
    });
  } catch (e) {
    return e;
  }
  throw new Error("expected the read to fail");
}

/** Everything a log line or a row could be made of, from one caught error. */
function everyRendering(e: unknown): Record<string, string> {
  const err = e as Error & { shortMessage?: string; details?: string };
  return {
    message: redactUrls(err.message),
    string: redactUrls(String(e)),
    stack: redactUrls(err.stack ?? ""),
    // What `console.error(e)` writes: the stack, then every own property —
    // `url: '…'`, `metaMessages: [ 'URL: …' ]` — and the cause chain.
    inspected: redactUrls(inspect(e, { depth: Infinity })),
    errorText: errorText(e),
    detail: classifyRpcError(e).detail,
    // index.ts's reject_rule: the shape the `autonomy| 1h refusals` line repeats.
    rejectRule: redactUrls(`couldn't submit: ${err.message.replace(/\s+/g, " ").slice(0, 80)}`),
  };
}

/** A stream that remembers what was written to it. */
function sink(): { stream: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream: w as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
}

describe("redactUrls on the errors viem actually raises", () => {
  it("an HttpRequestError with a keyed URL never yields the key", () => {
    const e = new HttpRequestError({
      url: KEYED,
      status: 429,
      body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [] },
      details: "Monthly capacity limit exceeded",
    });
    // The premise: viem really does print it, everywhere.
    assert.ok(e.message.includes(KEY), "viem no longer puts the URL in its message — revisit this module");
    assert.ok(inspect(e).includes(KEY));
    for (const [where, text] of Object.entries(everyRendering(e))) {
      assert.ok(!leaksKey(text), `${where} still carries the key`);
    }
    // And the host survives, because which provider failed is the useful part.
    assert.ok(redactUrls(e.message).includes(`URL: https://${HOST}/${REDACTED}`));
  });

  it("a ContractFunctionExecutionError from a declined read never yields the key", async () => {
    const e = await declinedRead();
    assert.ok(e instanceof ContractFunctionExecutionError, `got ${(e as Error)?.name}`);
    // The URL rides up through two wrappers' metaMessages and the cause chain.
    assert.ok((e as Error).message.includes(KEY));
    assert.ok(inspect(e, { depth: Infinity }).includes(KEY));
    for (const [where, text] of Object.entries(everyRendering(e))) {
      assert.ok(!leaksKey(text), `${where} still carries the key`);
    }
    // Still recognisably the failure it was.
    assert.equal(classifyRpcError(e).kind, "declined");
    assert.ok(errorText(e).includes(HOST));
  });

  it("console.error(e) through a guarded stream never writes the key", async () => {
    const e = await declinedRead();
    const out = sink();
    guardStdio([out.stream]);
    const c = new Console({ stdout: out.stream, stderr: out.stream });
    c.error(`[0xab7bde] tick failed:`, e);
    c.log({ url: KEYED, nested: { metaMessages: [`URL: ${KEYED}`] } });
    // A Buffer written straight to the stream, as a pipe would.
    out.stream.write(Buffer.from(`raw ${KEYED}\n`));
    const text = out.text();
    assert.ok(!leaksKey(text), "the guarded stream wrote the key");
    assert.ok(text.includes(HOST));
    assert.ok(text.includes(DECLINED_MARKER));
  });

  it("guarding twice wraps once", () => {
    const out = sink();
    guardStdio([out.stream]);
    const once = out.stream.write;
    guardStdio([out.stream]);
    assert.equal(out.stream.write, once);
  });
});

describe("redactUrls", () => {
  it("can be bundled for the browser without Node builtins", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./redact-urls.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
    });
    const output = result.outputFiles[0];
    assert.ok(output, "the browser bundle was produced");
    const bundled = await import(`data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`);
    assert.equal(bundled.errorText(new Error(`URL: ${KEYED}`)), `URL: https://${HOST}/${REDACTED}`);
  });

  it("keeps scheme and host, drops path and query, for keyed providers", () => {
    assert.equal(redactUrls(`URL: ${KEYED}`), `URL: https://${HOST}/${REDACTED}`);
    assert.equal(
      redactUrls("https://api.pimlico.io/v2/46630/rpc?apikey=pim_abc"),
      `https://api.pimlico.io/${REDACTED}`,
    );
    assert.equal(redactUrls("wss://mainnet.infura.io/ws/v3/abc"), `wss://mainnet.infura.io/${REDACTED}`);
    // A short key that looks like a word is still removed on a keyed host.
    assert.equal(redactUrls("https://x.quiknode.pro/hello/"), `https://x.quiknode.pro/${REDACTED}`);
  });

  it("removes a credential-shaped segment or parameter on any host", () => {
    assert.equal(redactUrls(`https://rpc.example.org/${KEY}`), `https://rpc.example.org/${REDACTED}`);
    assert.equal(redactUrls("https://rpc.example.org/x?token=abc"), `https://rpc.example.org/${REDACTED}`);
    assert.equal(redactUrls("https://rpc.example.org/?api_key=abc&x=1"), `https://rpc.example.org/${REDACTED}`);
    // A UUID-shaped project id.
    assert.equal(
      redactUrls("https://rpc.example.org/bundler/1c2d3e4f-5a6b-7c8d-9e0f-a1b2c3d4e5f6"),
      `https://rpc.example.org/${REDACTED}`,
    );
    // Infura's shape, on a host this file has never heard of.
    assert.equal(redactUrls(`https://rpc.example.org/v3/${"9f".repeat(16)}`), `https://rpc.example.org/${REDACTED}`);
    // Etherscan-style APIs: the key is a parameter, and the parameter is enough.
    assert.equal(
      redactUrls("https://api.etherscan.io/v2/api?chainid=1&module=account&apikey=ABC123"),
      `https://api.etherscan.io/${REDACTED}`,
    );
    // A public host's path is spared; a key in its query is not.
    assert.equal(redactUrls("https://x.com/i/api?access_token=abc"), `https://x.com/${REDACTED}`);
  });

  it("always removes userinfo", () => {
    assert.equal(redactUrls("https://me:hunter2@rpc.example.org/"), `https://${REDACTED}@rpc.example.org/`);
    assert.equal(redactUrls(`https://me:p@ss@${HOST}/v2/${KEY}`), `https://${REDACTED}@${HOST}/${REDACTED}`);
    // A database driver's error carries its connection URL, password and all.
    assert.equal(
      redactUrls("connect ECONNREFUSED 10.1.2.3:5432 (postgres://admin:hunter2@db.internal:5432/merrymen)"),
      `connect ECONNREFUSED 10.1.2.3:5432 (postgres://${REDACTED}@db.internal:5432/merrymen)`,
    );
    assert.equal(redactUrls("postgresql://u:p@h/d"), `postgresql://${REDACTED}@h/d`);
    assert.equal(redactUrls("rediss://default:s3cret@cache.internal:6380"), `rediss://${REDACTED}@cache.internal:6380`);
  });

  it("leaves public URLs exactly as they were", () => {
    for (const url of [
      "https://rpc.mainnet.chain.robinhood.com",
      "https://rpc.mainnet.chain.robinhood.com/",
      `https://explorer.mainnet.chain.robinhood.com/tx/0x${"ab".repeat(32)}`,
      `https://explorer.mainnet.chain.robinhood.com/address/0x${"cd".repeat(20)}`,
      "https://x.com/merrymen/status/1846123456789012345",
      "https://merrymen.dev/agents/alan?tab=trades",
      "https://web.example.com/_next/static/chunks/a1b2c3d4e5f6a7b8c9d0e1f2.js",
      "https://dexscreener.com/robinhood/0x1111111111111111111111111111111111111111",
      `https://etherscan.io/tx/0x${"ef".repeat(32)}`,
      // A news slug mixes letters and digits and is not a key.
      "https://www.reuters.com/markets/us/fed-holds-rates-steady-signals-cut-2026-10-17/",
      // Base58, mixed case and digits — a key's shape — on an explorer that is public.
      "https://solscan.io/tx/5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
      "https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ]) {
      assert.equal(redactUrls(`see ${url} now`), `see ${url} now`, url);
    }
  });

  it("ends a URL where the sentence, quote or bracket does", () => {
    assert.equal(redactUrls(`(URL: ${KEYED}).`), `(URL: https://${HOST}/${REDACTED}).`);
    assert.equal(redactUrls(`url: '${KEYED}',`), `url: 'https://${HOST}/${REDACTED}',`);
    assert.equal(redactUrls(`{"url":"${KEYED}"}`), `{"url":"https://${HOST}/${REDACTED}"}`);
    assert.equal(redactUrls(`a ${KEYED}, then ${KEYED}`), `a https://${HOST}/${REDACTED}, then https://${HOST}/${REDACTED}`);
  });

  it("leaves text without a URL untouched", () => {
    assert.equal(redactUrls("market unreadable — no trading this tick"), "market unreadable — no trading this tick");
    assert.equal(redactUrls(""), "");
  });
});

describe("lineRedactor", () => {
  it("redacts a URL that a pipe split across two chunks", () => {
    const r = lineRedactor();
    const line = `HTTP request failed. URL: ${KEYED}`;
    const cut = line.indexOf(KEY) - 5;
    const first = r.push(Buffer.from(line.slice(0, cut)));
    const second = r.push(Buffer.from(`${line.slice(cut)}\nnext line\npartial`));
    assert.deepEqual(first, []);
    assert.deepEqual(second, [`HTTP request failed. URL: https://${HOST}/${REDACTED}`, "next line"]);
    assert.deepEqual(r.flush(), ["partial"]);
    assert.deepEqual(r.flush(), []);
  });

  it("releases an unterminated line once it is too long to hold", () => {
    const r = lineRedactor(16);
    assert.deepEqual(r.push(`${"x".repeat(20)}`), [`${"x".repeat(20)} [truncated]`]);
    assert.deepEqual(r.push("discarded tail\nnext\n"), ["next"]);
  });

  it("never emits the bare tail of a URL split at the held-line limit", () => {
    const r = lineRedactor(64);
    const first = r.push(`${"x".repeat(64)} ${KEYED.slice(0, -16)}`);
    assert.deepEqual(first, [`${"x".repeat(64)} https://${HOST}/${REDACTED} [truncated]`]);
    assert.deepEqual(r.push(KEYED.slice(-16)), []);
    assert.deepEqual(r.push(`\nnext ${KEYED}\n`), [`next https://${HOST}/${REDACTED}`]);
    assert.deepEqual(r.flush(), []);

    const ended = lineRedactor(16);
    ended.push(`${"x".repeat(20)} ${KEYED.slice(0, -16)}`);
    ended.push(KEYED.slice(-16));
    assert.deepEqual(ended.flush(), []);
  });
});

/**
 * Lighter key material (docs/perps.md rule 5) at #347's choke points. Made-up
 * values in the venue's shapes: a 40-byte API private key (80 hex) and an auth
 * token, `<deadline>:<account>:<keyIndex>:<160 hex>`.
 */
describe("Lighter key material", () => {
  const PERP_KEY = "0123456789abcdef".repeat(4) + "a1b2c3d4e5f60718";
  const AUTH = `1790700000:22149:16:${"ab12".repeat(40)}`;

  it("removes an API private key in every spelling, and an auth token whole", () => {
    for (const k of [`0x${PERP_KEY}`, PERP_KEY, `0x${PERP_KEY.toUpperCase()}`, PERP_KEY.toUpperCase()]) {
      assert.equal(redactUrls(`perps: key ${k} failed`), `perps: key ${REDACTED} failed`, k);
    }
    assert.equal(redactUrls(`perp-key.json: {"privateKey":"0x${PERP_KEY}"}`), `perp-key.json: {"privateKey":"${REDACTED}"}`);
    assert.equal(redactUrls(`Authorization: ${AUTH}`), `Authorization: ${REDACTED}`);
    assert.equal(redactUrls(`https://api.rh.lighter.xyz/api/v1/trades?auth=${AUTH}`), `https://api.rh.lighter.xyz/${REDACTED}`);
  });

  it("leaves hashes, addresses, calldata and signatures as they were", () => {
    const hash = `0x${"9f".repeat(32)}`;
    const calldata = `0xa9059cbb${"00".repeat(12)}${"5f".repeat(20)}${"00".repeat(31)}01`;
    const signature = `0x${"1c".repeat(65)}`;
    const line = `tx ${hash} to 0x${"ab".repeat(20)} data ${calldata} sig ${signature}`;
    assert.equal(redactUrls(line), line);
    assert.equal(redactLighterSecrets(`${"a".repeat(80)} ${"0".repeat(80)}`), `${"a".repeat(80)} ${"0".repeat(80)}`, "one character held down is not a key");
  });

  it("reaches stdout and stderr through guardStdio, string or Buffer", () => {
    const seen: string[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { seen.push(String(chunk)); cb(); } }) as unknown as NodeJS.WriteStream;
    guardStdio([sink]);
    sink.write(`a ${PERP_KEY} b\n`);
    sink.write(Buffer.from(`c ${AUTH} d\n`));
    assert.deepEqual(seen, [`a ${REDACTED} b\n`, `c ${REDACTED} d\n`]);
  });
});
