/**
 * A KEY IN A URL NEVER REACHES A LOG LINE, A ROW OR A MESSAGE.
 *
 * Hosted RPC providers put the credential IN THE URL — Alchemy's
 * `…g.alchemy.com/v2/<key>`, Pimlico's `?apikey=`, Infura's `/v3/<key>` — and
 * viem prints the URL it was built with into every transport error: the
 * message of an `HttpRequestError` carries `URL: <url>` among its
 * metaMessages, every wrapper above it (`CallExecutionError`,
 * `ContractFunctionExecutionError`) copies those metaMessages into its own
 * message, and the error object itself holds `url` on its `cause`. viem strips
 * Basic-auth userinfo (errors/utils.ts getUrl) and nothing else.
 *
 * Measured 2026-10-17: with the house endpoint's monthly quota spent, every
 * read that the governor declined surfaced as one of those errors, and the
 * fleet printed the configured read URL — key included — into Railway's logs
 * from three children at once, and from the orchestrator's `autonomy| 1h
 * refusals` line every seventeen seconds.
 *
 * SO THERE IS ONE RULE, APPLIED AT THE PLACES TEXT LEAVES A PROCESS rather than
 * at the hundreds of places an error is caught: a process's stdout and stderr
 * (`guardStdio`), the orchestrator's relay of its children's output
 * (`lineRedactor`), and the store's free-text columns. Any URL in the text
 * keeps its scheme and host — which provider failed is what an operator needs —
 * and loses its userinfo always, and its path and query whenever the host is a
 * keyed provider's or any part of them looks like a credential.
 *
 * WHAT IT LEAVES ALONE. Public URLs read the same as before: the chain's own
 * RPC, a block explorer's `/tx/0x…` link (a hash or an address is public, and
 * an explorer link in a post is the point of the post), merrymen.dev, x.com.
 * A rule that redacted those would be switched off by the first person it got
 * in the way of.
 *
 * PURE except `guardStdio`, which patches the two streams it is given.
 */

import { StringDecoder } from "node:string_decoder";

/** What a removed credential reads as. The same marker redactSecrets uses. */
export const REDACTED = "[redacted]";

/**
 * Providers whose URL path or query IS the credential, matched on the host's
 * registrable suffix. A URL here loses its whole path and query whatever they
 * look like, so a key that happens to look like a word is still removed.
 */
const KEYED_HOSTS: readonly string[] = [
  "alchemy.com", // <net>.g.alchemy.com/v2/<key>
  "alchemyapi.io",
  "infura.io", // <net>.infura.io/v3/<key>
  "quiknode.pro", // <name>.<net>.quiknode.pro/<key>/
  "ankr.com", // rpc.ankr.com/<net>/<key>
  "drpc.org", // lb.drpc.org/ogrpc?network=…&dkey=<key>
  "chainstack.com",
  "blastapi.io",
  "getblock.io",
  "nodereal.io",
  "tenderly.co",
  "blockpi.network",
  "onfinality.io",
  "pimlico.io", // api.pimlico.io/v2/<chain>/rpc?apikey=<key>
  "zerodev.app", // rpc.zerodev.app/api/v2/bundler/<project>
  "stackup.sh",
  "biconomy.io",
  "candide.dev",
];

/**
 * Public pages whose PATH is an identifier people are meant to share — a
 * Solana signature or mint in base58, a handle, a repository — and which the
 * shape test below would otherwise take for a key. Their query is still
 * checked by parameter name. (Etherscan-style APIs carry their key as
 * `apikey=`, which that check removes on any host.)
 */
const PUBLIC_PATH_HOSTS: readonly string[] = [
  "solscan.io",
  "solana.fm",
  "explorer.solana.com",
  "dexscreener.com",
  "geckoterminal.com",
  "birdeye.so",
  "x.com",
  "twitter.com",
  "t.me",
  "github.com",
  "youtube.com",
  "youtu.be",
  "merrymen.dev",
];

/** Query parameter names that carry a credential, whatever host they are on. */
const SECRET_PARAM = /(?:^|[-_])(?:api[-_]?key|apikey|key|dkey|token|access[-_]?token|secret|auth|authorization|password|passwd|pwd|sig|signature|credential|credentials)$/i;

/**
 * A path segment or query value shaped like a credential: twenty or more
 * characters that read as random — upper case, lower case and digits mixed
 * (Alchemy, Pimlico and most base62/base64 keys), a run of bare hex of key
 * length (Infura), or a UUID (project ids).
 *
 * NOT `0x…` hex, which is an address or a hash — public by construction, and
 * the whole content of an explorer link. NOT a slug: `fed-holds-rates-2026-10-17`
 * mixes letters and digits, and a news link that lost its path to this test
 * would be the first thing somebody switched it off for. A digits-only run is
 * an id (a tweet, a block number). Only consulted for hosts outside
 * KEYED_HOSTS, whose path and query go whatever they look like.
 */
function looksLikeKey(s: string): boolean {
  let v = s;
  try {
    v = decodeURIComponent(s);
  } catch {
    /* malformed escapes: judge the raw text */
  }
  if (!/^[A-Za-z0-9_.~+/=-]{20,}$/.test(v)) return false;
  if (/^0x[0-9a-fA-F]+$/.test(v)) return false;
  // A file name with an extension (a hashed asset, an image) is not a key.
  if (/\.[A-Za-z0-9]{1,5}$/.test(v)) return false;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v)) return true;
  if (/^[0-9a-fA-F]{32,}$/.test(v)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function hostIn(host: string, list: readonly string[]): boolean {
  const h = host.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
  return list.some((k) => h === k || h.endsWith(`.${k}`));
}

/** Does this path-and-query carry anything credential-shaped? */
function restLooksKeyed(rest: string, publicPath: boolean): boolean {
  const hash = rest.indexOf("#");
  const noFrag = hash >= 0 ? rest.slice(0, hash) : rest;
  const q = noFrag.indexOf("?");
  const path = q >= 0 ? noFrag.slice(0, q) : noFrag;
  const query = q >= 0 ? noFrag.slice(q + 1) : "";
  if (!publicPath && path.split("/").some(looksLikeKey)) return true;
  for (const pair of query.split(/[&;]/)) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : "";
    if (SECRET_PARAM.test(name)) return true;
    if (!publicPath && (looksLikeKey(value) || looksLikeKey(name))) return true;
  }
  return false;
}

/**
 * Every http(s)/ws(s) URL in running text. Stops at whitespace, quotes,
 * brackets and backslashes, which is where a URL ends in a log line, a JSON
 * string or `util.inspect` output.
 */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>\\()[\]{}|^]+/gi;

/** Punctuation that ends a sentence rather than the URL inside it. A key never contains these. */
const TRAILING = /[.,;:!?]+$/;

function redactOne(raw: string): string {
  const tail = raw.match(TRAILING)?.[0] ?? "";
  const url = tail ? raw.slice(0, -tail.length) : raw;
  const m = /^([a-z]+:\/\/)([^/?#]*)(.*)$/is.exec(url);
  if (!m) return raw;
  const [, scheme, authority, rest] = m as unknown as [string, string, string, string];
  // Userinfo is a credential by definition. The LAST `@` before the path ends
  // it: a password may itself contain one.
  const at = authority.lastIndexOf("@");
  const host = at >= 0 ? authority.slice(at + 1) : authority;
  const user = at >= 0 ? `${REDACTED}@` : "";
  const hide = rest !== "" && rest !== "/" && (hostIn(host, KEYED_HOSTS) || restLooksKeyed(rest, hostIn(host, PUBLIC_PATH_HOSTS)));
  if (!user && !hide) return raw;
  return `${scheme}${user}${host}${hide ? `/${REDACTED}` : rest}${tail}`;
}

/**
 * THE helper. Text in, the same text out with every credential-bearing URL
 * reduced to its scheme and host. Never throws; non-strings are stringified.
 */
export function redactUrls(text: string): string {
  const s = typeof text === "string" ? text : String(text);
  // The cheap test first: most log lines carry no URL at all.
  if (!s.includes("://")) return s;
  return s.replace(URL_IN_TEXT, redactOne);
}

/**
 * The text of a caught error, safe to log or store: its message, or its string
 * form, through `redactUrls`. For the call sites that used to write
 * `e instanceof Error ? e.message : String(e)`.
 */
export function errorText(e: unknown): string {
  return redactUrls(e instanceof Error ? e.message : String(e));
}

/**
 * Split a byte stream into whole lines, so a URL is never redacted in two
 * halves. A `data` chunk ends wherever the pipe's buffer did, and the second
 * half of a split URL has no scheme for `redactUrls` to find.
 *
 * `push` returns the complete lines in this chunk, redacted; the remainder is
 * held for the next. `flush` returns what is left when the stream ends. A
 * line longer than `maxHeld` is released (redacted) rather than held forever.
 */
export function lineRedactor(maxHeld = 64 * 1024): { push(chunk: Buffer | string): string[]; flush(): string[] } {
  let held = "";
  // A multi-byte character split across chunks is held too, not garbled.
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      held += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const parts = held.split(/\r?\n/);
      held = parts.pop() ?? "";
      if (held.length > maxHeld) {
        parts.push(held);
        held = "";
      }
      return parts.map(redactUrls);
    },
    flush() {
      const rest = held + decoder.end();
      held = "";
      return rest ? [redactUrls(rest)] : [];
    },
  };
}

type Write = NodeJS.WriteStream["write"];
const GUARDED = Symbol.for("merrymen.redactUrls.guarded");

/**
 * Route everything this process writes to stdout and stderr through
 * `redactUrls` — `console.*` of an error object included, since console
 * formats it (stack, `url: '…'`, metaMessages, cause chain) to a string and
 * then calls the stream's `write`.
 *
 * Installed once at each production entry point, before anything can fail.
 * Idempotent. A Buffer is decoded only when it may hold a URL, and written
 * untouched when nothing in it changed.
 */
export function guardStdio(streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    const s = stream as NodeJS.WriteStream & { [GUARDED]?: true };
    if (s[GUARDED]) continue;
    const write = s.write.bind(s) as (...a: unknown[]) => boolean;
    s.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") return write(redactUrls(chunk), ...rest);
      const bytes = chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : null;
      if (bytes?.includes("://")) {
        const text = bytes.toString("utf8");
        const safe = redactUrls(text);
        if (safe !== text) {
          // The encoding argument described the bytes; the text is UTF-8 now.
          const cb = rest.find((a) => typeof a === "function");
          return cb ? write(safe, "utf8", cb) : write(safe, "utf8");
        }
      }
      return write(chunk, ...rest);
    }) as Write;
    s[GUARDED] = true;
  }
}
