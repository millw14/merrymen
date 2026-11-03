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
 * Pure and browser-safe. Node stream adapters live in redact-stdio.ts.
 */

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
  // Solana RPC providers. Helius takes ?api-key= (removed on any host by name),
  // but its dedicated and older endpoints too; Triton (rpcpool.com) and Syndica
  // put a lower-case token in the path, which the shape test does not read as a
  // key. Alchemy, QuickNode, Ankr and Chainstack are listed above.
  "helius-rpc.com", // mainnet.helius-rpc.com/?api-key=<key>
  "helius.xyz", // rpc.helius.xyz/?api-key=<key>
  "rpcpool.com", // <name>.mainnet.rpcpool.com/<token>
  "syndica.io", // solana-mainnet.api.syndica.io/api-key/<key>
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
 * Every http(s)/ws(s) URL in running text, and the database URLs a driver's
 * error can carry (postgres, redis): their userinfo is the database password.
 * Stops at whitespace, quotes, brackets and backslashes, which is where a URL
 * ends in a log line, a JSON string or `util.inspect` output.
 */
const URL_IN_TEXT = /\b(?:https?|wss?|postgres(?:ql)?|rediss?):\/\/[^\s"'`<>\\()[\]{}|^]+/gi;

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
 * reduced to its scheme and host, and Lighter key material removed
 * (redactLighterSecrets). Never throws; non-strings are stringified.
 */
export function redactUrls(text: string): string {
  const s = typeof text === "string" ? text : String(text);
  // The cheap test first: most log lines carry no URL at all. URLs before key
  // shapes, so a token in a query goes with its URL as one marker.
  return redactLighterSecrets(s.includes("://") ? s.replace(URL_IN_TEXT, redactOne) : s);
}

/**
 * A Lighter auth token, `<deadline>:<account>:<keyIndex>:<160 hex>`, taken
 * whole so the account it authenticates goes with it (docs/perps.md rule 5).
 * Matched before the key shape, which would otherwise take only its signature.
 */
const LIGHTER_AUTH_TOKEN = /\b\d{9,11}:\d{1,16}:\d{1,3}:[0-9a-fA-F]{160}(?![0-9a-fA-F])/g;

/**
 * A Lighter API private key is 40 bytes: exactly 80 hex, 0x or bare, either
 * case, standing alone (docs/perps.md rule 5). Exactly 80 and bounded on both
 * sides, so the calldata and signatures a log line carries (0x plus 8 + 64k
 * hex, 130-hex signatures) keep reading as they did; Lighter tx hashes are 80
 * hex too and go with it, which costs nothing. The Telegram agent's redactor,
 * whose output reaches a model, takes every run of 80 or more instead.
 */
const LIGHTER_KEY = /(^|[^0-9A-Za-z])((?:0x)?[0-9a-fA-F]{80})(?![0-9A-Za-z])/g;

/** A digit AND a letter: a key, not a run of one character (a test's `aaaa…`, a padded zero). */
function keyLike(run: string): boolean {
  const hex = run.startsWith("0x") ? run.slice(2) : run;
  return /[0-9]/.test(hex) && /[a-fA-F]/.test(hex);
}

/**
 * Lighter key material out of text that leaves a process (#347's choke
 * points: stdout and stderr, the orchestrator's relay, events and
 * reject_rule). Its URL query twin, `?auth=`, is removed by SECRET_PARAM.
 * Never throws.
 */
export function redactLighterSecrets(text: string): string {
  // The cheap test first: no run of 80 hex, nothing to do.
  if (!/[0-9a-fA-F]{80}/.test(text)) return text;
  // The character before the key is captured, not looked behind at: this file
  // is browser-safe, and older Safari has no lookbehind.
  return text.replace(LIGHTER_AUTH_TOKEN, REDACTED).replace(LIGHTER_KEY, (m, before: string, key: string) => (keyLike(key) ? `${before}${REDACTED}` : m));
}

/**
 * The text of a caught error, safe to log or store: its message, or its string
 * form, through `redactUrls`. For the call sites that used to write
 * `e instanceof Error ? e.message : String(e)`.
 */
export function errorText(e: unknown): string {
  return redactUrls(e instanceof Error ? e.message : String(e));
}
