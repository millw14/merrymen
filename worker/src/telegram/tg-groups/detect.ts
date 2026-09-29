/**
 * Telegram groups — what a line says, read cheaply and without a model.
 * The contract is docs/tg-groups.md.
 *
 * Everything here is PURE: text in, answer out. No I/O, no clock, no
 * randomness. pacing.ts turns these readings into "speak / react / stay out";
 * the coin flow uses the address finders. The only state is a small cache of
 * compiled name patterns, which changes speed, never answers.
 *
 * CHEAP ON PURPOSE. Every group line goes through these, most of them are
 * never answered, and a model call per line would spend the group allowance
 * on deciding to say nothing. A reading that is wrong in the quiet direction
 * (a missed tease, a missed trade word) costs one ambient line that was never
 * owed anyway; the ones that must not miss — distress, a slur, a CA — are
 * written to over-match rather than under-match.
 *
 * NEVER A TRADING INPUT. A CA found here is a lookup key for the coin flow,
 * which validates it again before anything crosses into trading (rule 1).
 * Nothing here reads, sizes or orders anything.
 */

import { fnv1a } from "../../memory/tokens";
import type { TgMessage } from "../api";

// ─── Normalising ───────────────────────────────────────────────────────────

/** Curly and look-alike apostrophes, so "you’re" reads like "you're". */
const APOS = /[‘’ʼ`´′]/g;
/**
 * Zero-width characters. "s​hut up" is someone dodging a filter, and
 * none of these ever changes what a word says.
 */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** Lowercase, compatibility-folded (fullwidth "ｇｍ" is "gm"), one apostrophe, single spaces. */
function norm(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(APOS, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * norm() and then accents off, for comparing NAMES: "jose" calls José, and a
 * decomposed "José" is the same name as a precomposed one. Lowercased first so
 * a Turkish "İ" folds to a plain i instead of growing a combining dot after
 * the marks are gone.
 */
function fold(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(ZERO_WIDTH, "")
    .replace(APOS, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a line, emoji and punctuation dropped. Apostrophes stay inside a word ("y'all"). */
function wordsOf(t: string): string[] {
  return t.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Addresses ─────────────────────────────────────────────────────────────

/**
 * 0x + EXACTLY 40 hex, not part of a longer hex run on either side.
 *
 * A 64-hex string is a tx hash, a v4 pool id or a private key, never a token,
 * and it must never be read as one: its first 40 characters look exactly like
 * an address. The lookahead refuses a 41st hex character and the lookbehind a
 * hex character before the 0x, so no slice of a longer run can match.
 */
const CA_RUN = /(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/gi;
/** At most this many CAs per message are considered (the contract's "first 2"). */
const MAX_CAS = 2;
/**
 * At most this many addresses are read out of one line with their chain. A
 * remembered line is 400 characters, so this bounds nothing a person writes;
 * it keeps a pasted wall of addresses from being a list.
 */
const MAX_HITS = 16;

/**
 * Where a posted address says it lives, read from the link it sits in:
 * "robinhood" in a Robinhood Chain explorer or chart link, "other" in a link
 * that names another chain, null for a bare address or a link that names no
 * chain this knows.
 */
export type CaChain = "robinhood" | "other" | null;

/** One CA in a line, and the chain the link around it names. */
export interface CaHit {
  /** Lowercased 0x + 40 hex. */
  address: string;
  /**
   * A HINT, AND ONLY EVER A QUIET ONE. "other" keeps the coin flow silent
   * about the address: a false "other" costs one coin nobody hears about.
   * Nothing is ever done BECAUSE of "robinhood": the look still reads the
   * chain (tg-coin-look.ts), and a link anyone can type proves nothing.
   */
  chain: CaChain;
}

/**
 * Every CA in a line with the chain its link names, lowercased, unique, in
 * order of appearance, at most 16 (MAX_HITS).
 *
 * Found anywhere, including inside a GeckoTerminal / DexScreener / explorer
 * URL path or query string, because that is how most people post a coin.
 * Percent-escapes are read as separators first: in "…%2F0xabc…" the "F" of
 * the escaped slash is a hex character and would otherwise glue onto the
 * address and hide it. Blanked three spaces wide, so a match's index is its
 * index in the line too, for reading the link around it.
 *
 * An address posted twice keeps the strongest reading: a Robinhood link
 * anywhere in the line over another chain's, and either over a bare copy.
 */
export function extractCaHits(text: string): CaHit[] {
  if (typeof text !== "string" || !text) return [];
  const line = text.normalize("NFKC");
  const t = line.replace(/%[0-9a-f]{2}/gi, "   ");
  const out: CaHit[] = [];
  for (const m of t.matchAll(CA_RUN)) {
    // The whole match is the address: the lookarounds take no characters, and
    // lowercasing turns a "0X" prefix into "0x" along with the hex.
    const address = m[0].toLowerCase();
    const at = m.index ?? 0;
    const chain = chainOfLink(linkAround(line, at, at + m[0].length), address);
    const seen = out.find((h) => h.address === address);
    if (seen) {
      if (chain === "robinhood" || (chain === "other" && seen.chain === null)) seen.chain = chain;
      continue;
    }
    if (out.length >= MAX_HITS) break;
    out.push({ address, chain });
  }
  return out;
}

/** Every CA in a line, lowercased, unique, in order of appearance, at most 2: extractCaHits' first two addresses. */
export function extractCas(text: string): string[] {
  return extractCaHits(text)
    .slice(0, MAX_CAS)
    .map((h) => h.address);
}

// ─── Which chain a link names ──────────────────────────────────────────────

/** Where a link written in a line ends: space, quotes, brackets, and the separators people put between links. */
const LINK_END = /[\s"'<>()[\]{}|,]/u;

/** The run of text around [start, end) that a link written out in a line could be. */
function linkAround(t: string, start: number, end: number): string {
  let a = start;
  while (a > 0 && !LINK_END.test(t.charAt(a - 1))) a--;
  let b = end;
  while (b < t.length && !LINK_END.test(t.charAt(b))) b++;
  return t.slice(a, b);
}

/** Percent-escapes of plain ASCII, read back ("https%3A%2F%2Fetherscan.io" is a link to Etherscan). */
const unescapeAscii = (s: string): string => s.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** A scheme, where one link inside another starts ("…/r?u=https://etherscan.io/…"). */
const SCHEME = /[a-z][a-z0-9+.-]*:\/\//g;
/** A host name: dotted labels ending in a TLD, then a path, port, query or the end. */
const HOST = /(?<![a-z0-9.-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/?#:]|$)/;

/**
 * Robinhood Chain named in a host label, a path segment or a query value:
 * "robinhoodchain.blockscout.com", "explorer.robinhood.com", "…/robinhood/…",
 * "?chain=robinhood", "0x…-robinhood".
 */
const RH_WORD = /(?:^|[^a-z0-9])robinhood(?:[-_]?chain)?(?:[-_]?(?:mainnet|testnet))?(?![a-z0-9])/;
/** Robinhood Chain's chain ids, mainnet and testnet (packages/core/src/chain.ts), as a link's query writes them. */
const RH_CHAIN_IDS: ReadonlySet<string> = new Set(["4663", "46630"]);

/** Query keys a link names its chain with ("?chain=bsc", "&chainId=8453"). */
const CHAIN_PARAM = /(?:^|[?&#;])(?:chain|chainid|chain_id|chainname|network|networkid|blockchain|inputchain|outputchain|fromchain|tochain|fromchainid|tochainid)=([^&#;]*)/g;

/**
 * Other chains by the names links use for them: Ethereum and its testnets,
 * the L2s, BNB, the other EVM chains, Solana, Tron and the rest. A value
 * here in a chain parameter, or a path segment of a swap link, is another
 * chain's coin.
 */
const OTHER_CHAINS: ReadonlySet<string> = new Set([
  "ethereum", "eth", "mainnet", "sepolia", "goerli", "holesky", "base", "arbitrum", "arbitrum-one", "arbitrum_one", "arb",
  "optimism", "op", "polygon", "polygon_pos", "polygon-pos", "matic", "zkevm", "bsc", "bnb", "binance", "bnbchain", "opbnb",
  "avalanche", "avax", "fantom", "ftm", "sonic", "blast", "linea", "scroll", "zksync", "zksync-era", "era", "celo", "gnosis",
  "xdai", "mantle", "unichain", "zora", "sei", "berachain", "bera", "ink", "abstract", "world", "worldchain", "apechain",
  "hyperevm", "hyperliquid", "monad", "cronos", "moonbeam", "metis", "kava", "core", "pulsechain", "pulse", "degen", "mode",
  "taiko", "manta", "starknet", "solana", "sol", "tron", "trx", "sui", "aptos", "ton", "near", "bitcoin", "btc",
]);

/**
 * Explorers, launchpads and DEXes of one other chain. Also every host with a
 * label ending in "scan" (etherscan, bscscan, basescan, arbiscan, polygonscan,
 * ftmscan, blastscan, lineascan, solscan, tronscan…) and every Blockscout
 * other than Robinhood Chain's own; see isOtherChainHost.
 */
const OTHER_CHAIN_HOSTS: readonly string[] = [
  "snowtrace.io", "routescan.io", "oklink.com", "blockchair.com", "mempool.space", "explorer.solana.com", "solana.fm",
  "solanabeach.io", "explorer.zksync.io", "era.zksync.network", "blastexplorer.io", "explorer.linea.build", "tonviewer.com",
  "suivision.xyz", "pump.fun", "raydium.io", "jup.ag", "meteora.ag", "orca.so", "moonshot.money", "believe.app",
  "letsbonk.fun", "bonk.fun", "bags.fm", "axiom.trade", "bullx.io", "tinyastro.io", "four.meme", "pancakeswap.finance",
  "poocoin.app", "aerodrome.finance", "velodrome.finance", "zora.co", "clanker.world", "flaunch.gg", "traderjoexyz.com",
  "lfj.gg", "quickswap.exchange", "camelot.exchange", "sunswap.com", "sun.io", "sunpump.meme", "debank.com",
];

/**
 * Charts and screeners across many chains, whose links always name the
 * chain: one that does not name Robinhood Chain names another.
 */
const MULTI_CHAIN_CHARTS: readonly string[] = [
  "dexscreener.com", "geckoterminal.com", "dextools.io", "gmgn.ai", "defined.fi", "dexview.com", "ave.ai", "birdeye.so",
  "coinmarketcap.com", "coingecko.com", "dex.guru", "dexcheck.ai", "tokensniffer.com", "honeypot.is", "gopluslabs.io", "de.fi",
];

/**
 * Swap apps across many chains, whose links name the chain only sometimes
 * ("app.uniswap.org/swap?chain=base", "/explore/tokens/ethereum/0x…"). One
 * that names no chain says nothing either way.
 */
const MULTI_CHAIN_SWAPS: readonly string[] = [
  "uniswap.org", "sushi.com", "1inch.io", "matcha.xyz", "jumper.exchange", "li.fi", "relay.link", "cow.fi",
  "kyberswap.com", "odos.xyz", "openocean.finance", "paraswap.io", "velora.xyz", "okx.com",
];

const onHost = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const onAnyHost = (host: string, domains: readonly string[]): boolean => domains.some((d) => onHost(host, d));

function isOtherChainHost(host: string): boolean {
  if (onAnyHost(host, OTHER_CHAIN_HOSTS)) return true;
  if (host.endsWith(".blockscout.com")) return true;
  // Every label but the TLD: "optimistic.etherscan.io" is Etherscan's too.
  return host.split(".").slice(0, -1).some((label) => label.length > 4 && label.endsWith("scan"));
}

/** The chains a link names in its query ("?chain=…", "&chainId=…"): Robinhood's, another, or none. */
function chainParams(rest: string): { robinhood: boolean; other: boolean } {
  let robinhood = false;
  let other = false;
  for (const m of rest.matchAll(CHAIN_PARAM)) {
    const v = (m[1] ?? "").trim();
    if (!v) continue;
    if (RH_CHAIN_IDS.has(v) || RH_WORD.test(v)) robinhood = true;
    else if (/^\d+$/.test(v) || OTHER_CHAINS.has(v)) other = true;
  }
  return { robinhood, other };
}

/**
 * Which chain the link around a posted address names (see CaHit.chain).
 *
 * The link is the innermost one holding the address: from the last scheme
 * before it to the next one after it, so a redirect ("…?u=https://etherscan.io/…")
 * is read as where it goes, and two links glued together are two. Read in
 * order: a Robinhood host; another chain's explorer, launchpad or DEX; a
 * Robinhood name in the path or query; a many-chains chart (whose links
 * always name a chain); a chain named in the query, or in a swap link's path.
 * Anything else, a bare address included, is null.
 */
function chainOfLink(around: string, address: string): CaChain {
  const t = unescapeAscii(around).toLowerCase();
  const at = t.indexOf(address);
  if (at < 0) return null;
  let from = 0;
  let to = t.length;
  for (const m of t.matchAll(SCHEME)) {
    const i = m.index ?? 0;
    if (i <= at) from = i;
    else if (i >= at + address.length) {
      to = i;
      break;
    }
  }
  const link = t.slice(from, to);
  const h = HOST.exec(link);
  // No host before the address: it is not in a link at all.
  if (!h || h.index >= at - from) return null;
  return chainNamedBy(h[1] ?? "", link.slice(h.index + h[0].length));
}

/**
 * The chain a link names, from its host and what follows the host (path,
 * query, fragment), both lowercased and percent-unescaped. The rules of
 * chainOfLink, in its order.
 */
function chainNamedBy(host: string, rest: string): CaChain {
  if (RH_WORD.test(host)) return "robinhood";
  if (isOtherChainHost(host)) return "other";
  const params = chainParams(rest);
  if (params.robinhood || RH_WORD.test(rest)) return "robinhood";
  if (onAnyHost(host, MULTI_CHAIN_CHARTS)) return "other";
  if (params.other) return "other";
  if (onAnyHost(host, MULTI_CHAIN_SWAPS)) {
    const path = rest.split(/[?#]/, 1)[0] ?? "";
    if (path.split("/").some((seg) => OTHER_CHAINS.has(seg))) return "other";
  }
  return null;
}

/**
 * Path segments and query keys of a link to one transaction or block. That
 * is not a coin, so another chain's tx link stays with the chatter path ("why
 * did my tx fail?" still gets its answer). Hash-routed paths count too
 * ("tronscan.org/#/transaction/…").
 */
const TX_PARTS: ReadonlySet<string> = new Set(["tx", "txs", "txn", "txns", "transaction", "transactions", "block", "blocks", "signature"]);

/**
 * A run in a link that can only be an on-chain id: 32 or more of [0-9a-z_-],
 * a digit among them, and a stretch of at least 20 with no "-" or "_".
 * Every chain's coin, pair, pool and account ids qualify, in either case: an
 * EVM or Sui 0x id of any length, a Solana or Tron base58 one lowercased, a
 * TON base64url one. A slug of words ("what-is-a-liquidity-pool-and-how-it-works")
 * does not.
 */
const ID_RUN = /[0-9a-z_-]{32,}/g;

/** What follows a link's host (lowercased) holds a coin, pair, pool or account id, and is not a tx or block link. */
function carriesCoinId(rest: string): boolean {
  if (rest.split(/[/?#&=;]+/).some((part) => TX_PARTS.has(part))) return false;
  for (const m of rest.matchAll(ID_RUN)) {
    const run = m[0];
    if (/[0-9]/.test(run) && run.split(/[-_]/).some((piece) => piece.length >= 20)) return true;
  }
  return false;
}

/**
 * True when the line carries a link that names another chain and holds a
 * coin, pair, pool or account id: another chain's coin even when no 0x +
 * 40-hex address and no mint shape is in it. That is how DexScreener itself
 * hands out a Solana pair ("dexscreener.com/solana/4hzt…", all lowercase, so
 * hasForeignMint cannot see it), and how TON, Sui and Tron pairs and a
 * Uniswap v4 pool id ("dexscreener.com/base/0x" + 64 hex) are posted. Like
 * hasForeignMint, recognised only so the coin flow can own the line and say
 * nothing about it.
 *
 * Every link in the line is read, not only one around a CA, by the host and
 * slug rules of extractCaHits' chain (chainNamedBy): another chain's explorer,
 * launchpad or DEX, a many-chain chart whose link does not name Robinhood
 * Chain, a chain parameter or swap path naming another chain. A Robinhood
 * Chain link, a link that names no chain, a link with no id in it and a link
 * to one transaction or block are not.
 */
export function hasOtherChainLink(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  const line = unescapeAscii(text.normalize("NFKC")).toLowerCase();
  for (const run of line.split(LINK_END)) {
    // A redirect ("…?u=https://dexscreener.com/…") or two links glued
    // together: each link is read from its own scheme.
    const starts = [0];
    for (const m of run.matchAll(SCHEME)) if ((m.index ?? 0) > 0) starts.push(m.index ?? 0);
    for (let k = 0; k < starts.length; k++) {
      const link = run.slice(starts[k] ?? 0, starts[k + 1] ?? run.length);
      const h = HOST.exec(link);
      if (!h) continue;
      const rest = link.slice(h.index + h[0].length);
      if (carriesCoinId(rest) && chainNamedBy(h[1] ?? "", rest) === "other") return true;
    }
  }
  return false;
}

/**
 * A Solana-style base58 run: 32–44 characters from the base58 alphabet (no 0,
 * O, I or l), a whole alphanumeric token on its own. Tron's "T…" addresses
 * (34) are base58 too.
 *
 * Bounded by any alphanumeric, not just base58, so the "x…" after a CA's "0"
 * can never be read as a mint, and neither can a slice of a longer token.
 */
const B58_RUN = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;

/**
 * A TON address in its user-friendly form, a whole token: "EQ" or "UQ"
 * (mainnet), "kQ" or "0Q" (testnet), then 46 more base64url characters.
 */
const TON_RUN = /(?<![0-9A-Za-z_-])[EUk0]Q[0-9A-Za-z_-]{46}(?![0-9A-Za-z_-])/g;

/** A Sui or Aptos coin type: an 0x account, a module and a name ("0x2::sui::SUI"). */
const MOVE_COIN = /(?<![0-9a-z])0x[0-9a-f]{1,64}::[a-z_][a-z0-9_]*::[a-z_][a-z0-9_]*/i;

/**
 * True when the line carries another chain's coin address in a shape no EVM
 * chain uses: a Solana (or Tron) base58 mint, a TON address, a Sui or Aptos
 * coin type. The coin flow owns such a line only to stay silent about it. It
 * is never looked up, never nominated and never answered.
 *
 * A real mint mixes upper case, lower case and digits; "hahahaha…" and a held
 * key ("AAAAAA…") do not, so all three are required. A pure-hex run is an EVM
 * hash or key without its 0x, not a mint. A TON address mixes cases the same
 * way. A bare 0x + 64 hex is not read as anyone's coin: on Robinhood Chain
 * it is a tx hash as often as not.
 */
export function hasForeignMint(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  const t = text.normalize("NFKC");
  for (const m of t.matchAll(B58_RUN)) {
    const run = m[0];
    if (/^[0-9a-f]+$/i.test(run)) continue;
    if (/[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  for (const m of t.matchAll(TON_RUN)) {
    const tail = m[0].slice(2);
    if (/[a-z]/.test(tail) && /[A-Z]/.test(tail)) return true;
  }
  return MOVE_COIN.test(t);
}

/** "$PEPE": 2–10 letters/digits starting with a letter, not glued to a word or a longer run. */
const CASHTAG = /(?<![\p{L}\p{N}_$])\$[a-z][a-z0-9]{1,9}(?![\p{L}\p{N}_])/giu;

/** Cashtags in a line, uppercased, unique, in order. "$5" and "$100k" are money, not tickers. */
export function extractCashtags(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(CASHTAG)) {
    // The match is "$" and the tag; the lookarounds take no characters.
    const tag = m[0].slice(1).toUpperCase();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

// ─── Is it talking to me? ──────────────────────────────────────────────────

/** Who the bot is in this chat: getMe's id and username, and its soul name. */
export interface BotSelf {
  id: number;
  username: string | null;
  name: string;
  /**
   * Other names the room calls it by, matched like `name`. The bot's Telegram
   * display name is the one people see in the member list, and it may differ
   * from the soul name (a bot shown as "Merryman" whose soul is "Pine Heron").
   */
  aliases?: string[];
}

/**
 * Every name a line may call the bot by, for the readings that take the
 * bot's names (insultLevel, addressedSmallTalk, isQuestionShaped): its soul
 * name, its aliases and its @handle.
 */
export function selfNamesOf(self: BotSelf | null | undefined): string[] {
  if (!self) return [];
  const out = [self.name, ...(Array.isArray(self.aliases) ? self.aliases : [])];
  const user = typeof self.username === "string" ? self.username.replace(/^@/, "") : "";
  if (user) out.push(`@${user}`);
  return out.filter((n): n is string => typeof n === "string" && n.trim() !== "");
}

/**
 * NAMES THAT ARE ALSO EVERYDAY WORDS. A Merryman called "Will Scarlet" must not
 * answer "will it pump?", and one called "Robin" (the default) must not answer
 * every "robin hood chain" in a chat about Robinhood Chain. A word here is not
 * enough on its own: it calls the agent only as a vocative ("hey will",
 * "robin, thoughts?", "what do you think, rose?"), and a multi-word name
 * still answers to its full name.
 *
 * Folded (lowercase, no accents). Includes the generated-name adjectives
 * (packages/core/src/agent-name.ts) that are everyday chat words ("quick",
 * "quiet", "morning", "green", "winter" as in crypto winter), common given
 * names that are words, the band's own names that are words, and crypto words
 * someone might name an agent after. Short ones are here too: the stoplist
 * also guards a ONE-word full name ("Max", "Sol").
 */
const COMMON_WORD_NAMES: ReadonlySet<string> = new Set([
  // given names that are everyday words
  "will", "mark", "bill", "grace", "hope", "faith", "joy", "rose", "may", "june", "april", "august",
  "king", "queen", "prince", "duke", "earl", "lord", "baron", "sky", "star", "dawn", "summer", "autumn",
  "winter", "spring", "penny", "rich", "frank", "pat", "sue", "rob", "art", "jack", "chase", "grant",
  "miles", "chip", "chuck", "clay", "cliff", "crystal", "dusty", "drew", "gay", "harry", "holly", "iris",
  "ivy", "jade", "jewel", "lily", "matt", "max", "ray", "rocky", "sandy", "stormy", "sunny", "terry",
  "victor", "violet", "wade", "wes", "woody", "angel", "honey", "candy", "cash", "buck", "bud", "brook",
  "brooke", "river", "stone", "rock", "reed", "rusty", "misty", "hunter", "carter", "cole", "dean", "don",
  "gene", "glen", "hazel", "heather", "amber", "robin", "jay", "martin", "sterling", "noble", "royal",
  // the band's names that are words
  "hood", "little", "much", "merry", "tuck", "friar", "outlaw", "archer", "arrow", "bow",
  // generated-name words (agent-name.ts) that turn up in chat
  "blue", "bold", "calm", "clever", "green", "grey", "gray", "red", "gold", "golden", "silver", "iron",
  "bronze", "copper", "quick", "quiet", "swift", "wild", "keen", "lone", "pale", "gentle", "jolly",
  "morning", "evening", "midnight", "northern", "restless", "wandering", "rainy", "windy", "snowy",
  "brisk", "sly", "wry", "plum", "olive", "flint", "marsh", "meadow", "fox", "wolf", "hawk", "crow",
  "raven", "crane", "lark", "swallow", "kite", "drake", "stag", "hart", "hare", "mole", "moth", "owl",
  "rook", "teal", "pike", "piper", "tinker", "tanner", "squire", "bard", "hound", "jackdaw", "magpie",
  // crypto and meme words
  "bull", "bear", "whale", "shark", "ape", "degen", "moon", "pump", "chad", "based", "alpha", "beta",
  "sigma", "boss", "chief", "doge", "pepe", "shiba", "bonk", "wif", "trump", "elon", "satoshi", "anon",
  "fren", "ser", "sol", "eth", "gem", "ace", "ash", "jet", "kit", "rex", "pip", "bot", "agent", "robot",
  // other everyday words people pick as names
  "lucky", "happy", "smile", "sunshine", "ghost", "shadow", "storm", "thunder", "lightning", "blaze",
  "flash", "spark", "nova", "echo", "zen", "sage", "buddy", "pal", "champ", "tiger", "lion", "eagle",
  "falcon", "phoenix", "dragon", "cookie", "pepper", "ginger", "mint", "berry", "cherry", "peach",
  "apple", "banana", "mango", "coco", "biscuit", "muffin", "butter", "bean", "nugget", "pickle",
]);

/** Scripts written without spaces between words, where a name is followed or preceded straight by other letters. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Hangul}]/u;
const PRE = "(?<![\\p{L}\\p{N}_])";
const POST = "(?![\\p{L}\\p{N}_])";
/** Between the words of a name: anything that is not a letter or digit ("amber heron", "amber-heron", "Amber.Heron"). */
const SEP = "[^\\p{L}\\p{N}]+";
/** Openers that make the next word a vocative whatever follows ("hey will what's up", "gm rose"). */
const HAIL = "(?:hey|hi|hello|hiya|yo|oi|oy|ayo|ay|sup|gm|gn|dear)";
/** Openers that only make a vocative when the name ends the clause ("thanks will!" but not "thanks, will do"). */
const THANKS = "(?:thanks|thank you|thx|ty|tysm|bye|cya|later|night|morning)";

interface NameMatcher {
  /** The owner's label, "<name>'s owner", blanked before any other test. */
  label: RegExp | null;
  /** Patterns any one of which means the line names this agent. */
  hits: RegExp[];
}

const letterCount = (w: string): number => (w.match(/\p{L}/gu) ?? []).length;

/** A word, with the boundaries its script needs on each side. */
function bounded(core: string, first: string, last: string, lenient: boolean): string {
  const pre = lenient && UNSPACED.test(first) ? "" : PRE;
  const post = lenient && UNSPACED.test(last) ? "" : POST;
  return `${pre}${core}${post}`;
}

/** The ways a stoplisted word still calls the agent: said AS a name, never as a word in a sentence. */
function vocatives(w: string): RegExp[] {
  const W = escapeRe(w);
  const lead = `^[^\\p{L}\\p{N}]*(?:${HAIL}[^\\p{L}\\p{N}]+)?`;
  return [
    // the whole line is the name, perhaps after a hail: "robin", "hey rose 👋", "Will?"
    new RegExp(`${lead}${W}[^\\p{L}\\p{N}]*$`, "u"),
    // opens with the name and a pause: "rose, thoughts?", "will: you there"
    new RegExp(`${lead}${W}\\s*[,:!?]`, "u"),
    // a hail right before it anywhere: "lol hey will what's up", "gm rose"
    new RegExp(`${PRE}${HAIL}[^\\p{L}\\p{N}]+${W}${POST}`, "u"),
    // thanks/bye only when the name ends the clause: "thanks will!" but not "thanks, will do"
    new RegExp(`${PRE}${THANKS}[^\\p{L}\\p{N}]+${W}\\s*(?:[,.!?:;)]|$)`, "u"),
    // a trailing vocative after a comma: "what do you think, rose?"
    new RegExp(`,\\s*${W}\\s*[?!.]*\\s*$`, "u"),
  ];
}

const NAME_CACHE = new Map<string, NameMatcher>();
const NAME_CACHE_MAX = 64;

function nameMatcher(name: string): NameMatcher {
  const key = fold(name);
  const hit = NAME_CACHE.get(key);
  if (hit) return hit;
  const words = wordsOf(key);
  const hits: RegExp[] = [];
  let label: RegExp | null = null;
  const first = words[0];
  const lastWord = words[words.length - 1];
  // Both are there exactly when the name has a word; wordsOf never yields an
  // empty word, so charAt below reads the same code unit indexing would.
  if (first !== undefined && lastWord !== undefined) {
    const full = words.map(escapeRe).join(SEP);
    // A one-character CJK name would match inside every other word, so the
    // unspaced-script leniency needs at least two letters.
    const lenient = letterCount(key) >= 2;
    const fullRe = bounded(full, first.charAt(0), lastWord.charAt(lastWord.length - 1), lenient);
    // "<name>'s owner" / "<name>'s human" (and the first word's) name the owner, not the agent.
    const firstRe = words.length > 1 ? `|${bounded(escapeRe(first), first.charAt(0), first.charAt(first.length - 1), lenient)}` : "";
    label = new RegExp(`(?:${fullRe}${firstRe})(?:'s|s')?\\s*(?:owner|human)s?${POST}`, "gu");
    if (words.length === 1) {
      if (COMMON_WORD_NAMES.has(first)) hits.push(...vocatives(first));
      else hits.push(new RegExp(fullRe, "u"));
    } else {
      hits.push(new RegExp(fullRe, "u"));
      if (letterCount(first) >= 4 && !COMMON_WORD_NAMES.has(first)) {
        hits.push(new RegExp(bounded(escapeRe(first), first.charAt(0), first.charAt(first.length - 1), lenient), "u"));
      } else if (letterCount(first) >= 2) {
        hits.push(...vocatives(first));
      }
    }
  }
  const m: NameMatcher = { label, hits };
  NAME_CACHE.set(key, m);
  if (NAME_CACHE.size > NAME_CACHE_MAX) NAME_CACHE.delete(NAME_CACHE.keys().next().value as string);
  return m;
}

/** "merryman" calls any Merryman in the chat; "merryman's owner" does not. */
const MERRYMAN = new RegExp(`${PRE}merryman${POST}`, "u");
const MERRYMAN_LABEL = new RegExp(`${PRE}merryman(?:'s|s')?\\s*(?:owner|human)s?${POST}`, "gu");

const blank = (s: string): string => " ".repeat(s.length);

/**
 * True when the line names the agent by any of its names, as opposed to
 * naming its owner. Every name's owner label is blanked before any name is
 * tested, so "pine's owner" never counts as calling it by its alias.
 */
function namesSelf(text: string, names: readonly unknown[]): boolean {
  let t = fold(text);
  if (!t) return false;
  t = t.replace(MERRYMAN_LABEL, blank);
  const ms = names.filter((n): n is string => typeof n === "string" && n.trim() !== "").map(nameMatcher);
  for (const m of ms) if (m.label) t = t.replace(m.label, blank);
  if (MERRYMAN.test(t)) return true;
  return ms.some((m) => m.hits.some((re) => re.test(t)));
}

/** The parts of a Telegram message addressedHow reads; a whole TgMessage fits. */
export type AddressedInput = Pick<TgMessage, "text" | "entities" | "replyTo">;

function mentionsSelf(m: AddressedInput, self: BotSelf): boolean {
  const text = typeof m.text === "string" ? m.text : "";
  const user = typeof self.username === "string" ? self.username.replace(/^@/, "").toLowerCase() : "";
  const handle = user ? `@${user}` : "";
  let sawMention = false;
  for (const e of Array.isArray(m.entities) ? m.entities : []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "text_mention") {
      sawMention = true;
      if (typeof e.userId === "number" && e.userId === self.id) return true;
    } else if (e.type === "mention") {
      sawMention = true;
      const { offset: o, length: l } = e;
      // Offsets are UTF-16 code units, which is how JS indexes a string, so an
      // emoji before the mention (two units) shifts it exactly as Telegram counted.
      if (!handle || !Number.isInteger(o) || !Number.isInteger(l) || o < 0 || l <= 0 || o + l > text.length) continue;
      if (text.slice(o, o + l).toLowerCase() === handle) return true;
    }
  }
  // No mention entities at all (a caller that did not parse them, or a
  // client that sent none): the literal handle as a whole word still counts.
  // Not after a letter or digit, so "me@botname.com" is an email, not a call.
  if (!sawMention && user) {
    return new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRe(user)}(?![\\p{L}\\p{N}_])`, "iu").test(text);
  }
  return false;
}

/**
 * How a line addresses the bot, or null when it does not.
 *
 * - "mention": an @username mention entity whose text is the bot's handle
 *   (case-insensitive), a text_mention of the bot's id, or — when the message
 *   carries no mention entities — the literal @handle as a whole word.
 * - "reply": a reply to one of the bot's own messages.
 * - "name": its full name as words; its first word when that has at least 4
 *   letters and is not an everyday word; an everyday-word name only as a
 *   vocative ("hey will"); or "merryman". Each alias is read the same way as
 *   the name. "<name>'s owner" / "<name>'s human" is about the owner and
 *   never counts.
 *
 * Checked in that order, so a mention wins over a reply that also names it.
 */
export function addressedHow(m: AddressedInput, self: BotSelf): "mention" | "reply" | "name" | null {
  if (!m || !self) return null;
  if (mentionsSelf(m, self)) return "mention";
  const r = m.replyTo;
  if (r && typeof r.fromId === "number" && r.fromId === self.id) return "reply";
  const names = [self.name, ...(Array.isArray(self.aliases) ? self.aliases : [])];
  if (namesSelf(typeof m.text === "string" ? m.text : "", names)) return "name";
  return null;
}

/**
 * The line with the bot's names swapped for `to`, and its @handle. Folded
 * (lowercase, accents off), so "pine is trash" reads as "bot is trash" and
 * "hey pine" as "hey".
 *
 * STRICT (loose false) swaps only a name that calls it on its own, as
 * nameMatcher reads one: a full name of more than one word, a one-word name
 * that is not an everyday word, and a first word of four letters or more
 * that is not one. An agent called "Red Fox" must not read "stupid red
 * candles" as "stupid bot". LOOSE also swaps an everyday one-word name and
 * any first word of two letters or more ("hey will"), for readings whose
 * own vocabulary is the guard (small talk, question shape).
 */
function withSelfNames(text: string, selfNames: readonly unknown[], to: string, loose: boolean): string {
  let t = fold(text);
  for (const raw of selfNames) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const handle = raw.trim().match(/^@([\p{L}\p{N}_]+)$/u);
    if (handle) {
      t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRe(fold(handle[1]!))}(?![\\p{L}\\p{N}_])`, "gu"), to);
      continue;
    }
    const words = wordsOf(fold(raw));
    const first = words[0];
    if (first === undefined) continue;
    const everyday = COMMON_WORD_NAMES.has(first);
    if (loose || words.length > 1 || !everyday) {
      t = t.replace(new RegExp(`${PRE}${words.map(escapeRe).join(SEP)}${POST}`, "gu"), to);
    }
    if (words.length > 1 && (loose ? letterCount(first) >= 2 : letterCount(first) >= 4 && !everyday)) {
      t = t.replace(new RegExp(`${PRE}${escapeRe(first)}${POST}`, "gu"), to);
    }
  }
  return t;
}

// ─── Shush ─────────────────────────────────────────────────────────────────

const SHUSH = new RegExp(
  [
    String.raw`\bshut (?:up|it|ur mouth|your mouth|the (?:fuck|hell|f) up|tf up)\b`,
    String.raw`\bshutup\b`,
    String.raw`\bstfu+\b`,
    String.raw`\bsybau\b`,
    String.raw`\bstop (?:talking|yapping|yappin|typing|posting|spamming|replying|chatting|with the yapping)\b`,
    String.raw`\b(?:quit|enough|no more|less) (?:yapping|yappin|talking|spamming)\b`,
    String.raw`\b(?:be|keep|stay) quiet\b`,
    String.raw`\bquiet (?:down|please|pls|plz|bot|you)\b`,
    String.raw`^quiet\W*$`,
    String.raw`\bshu+sh+\b`,
    String.raw`\bsh{2,}\b`,
    String.raw`\bhush\b`,
    String.raw`\bzip it\b`,
    String.raw`\bzip (?:ur|your) (?:lip|lips|mouth)\b`,
    String.raw`\bpipe down\b`,
    String.raw`\b(?:nobody|no one|no1|noone) asked\b`,
    String.raw`\bdidn'?t ask\b`,
    String.raw`\bwho (?:even )?asked\W*$`,
    String.raw`\bgo away\b`,
    String.raw`\benough (?:out of|outta) (?:you|u)\b`,
  ].join("|"),
  "u",
);
/** Not a shush: the meme, and "never shut up"-style complaints or compliments that are not a request. */
const NOT_SHUSH = /\bshut up and take my money\b|\b(?:don'?t|do not|never|can'?t|cannot|won'?t|couldn'?t|wouldn'?t)\s+(?:ever\s+)?(?:shut up|stop talking|stop yapping|be quiet)\b/gu;

/** "shut up", "stfu", "stop talking", "be quiet", "shush", "zip it", "nobody asked" and close variants. */
export function isShush(text: string): boolean {
  const t = norm(text).replace(NOT_SHUSH, " ");
  return !!t && SHUSH.test(t);
}

// ─── gm / gn ───────────────────────────────────────────────────────────────

/** Words that may ride along with a greeting without making it a sentence. */
const GREET_FILLER: ReadonlySet<string> = new Set([
  "all", "yall", "y'all", "everyone", "everybody", "fam", "fren", "frens", "friend", "friends", "ser",
  "sers", "guys", "gang", "team", "chat", "folks", "people", "peeps", "degens", "degen", "legends",
  "bros", "bro", "homies", "kings", "queens", "anon", "anons", "fellas", "lads", "world", "crew",
  "squad", "family", "my", "beautiful", "lovely", "to", "you", "u", "too", "and", "again", "night",
  "morning", "sweet", "dreams", "lol", "gm", "gn", "ya", "u2",
]);
const GREET_LEAD: ReadonlySet<string> = new Set(["hey", "hi", "yo", "oh", "ok", "okay", "well", "and", "a", "big"]);
/** The wishes a greeting ends with ("gm, have a great day"): still nothing but the greeting. */
const GREET_WISH: ReadonlySet<string> = new Set([
  "have", "a", "an", "good", "great", "nice", "wonderful", "awesome", "one", "day", "sleep", "well", "rest", "up", "safe", "weekend",
]);
const MAX_GREETING_WORDS = 5;

/**
 * gm or gn when the words are that and nothing more. What rides along must be
 * greeting filler or a wish: "gm fam", "good morning everyone", "gm, have a
 * good one". Anything else is a message that opens with a gm — "gm merryman
 * thoughts on eth?" is a question, "gm guys what's the play" one to the room —
 * and a name is not filler: "gm pine" is said to Pine (said to it, it is small
 * talk, which reads its names; see addressedSmallTalk).
 */
function greetingWord(words: string[]): "gm" | "gn" | null {
  const [a, b] = words;
  if (!a) return null;
  const rest = (from: number) => words.slice(from).every((w) => GREET_FILLER.has(w) || GREET_WISH.has(w));
  if (/^(?:g+m+|(?:gm)+|gmorning|gmornin|goodmorning)$/.test(a)) return rest(1) ? "gm" : null;
  if (/^(?:g+n+|(?:gn)+|gn8|gnight|g'night|goodnight|gnite)$/.test(a)) return rest(1) ? "gn" : null;
  if (/^(?:go+d|gud|gd)$/.test(a) && b) {
    if (/^(?:morning|mornin|morn)$/.test(b)) return rest(2) ? "gm" : null;
    if (/^(?:night|nite|nyt|nighty)$/.test(b)) return rest(2) ? "gn" : null;
  }
  if (/^(?:morning|mornin|morn)$/.test(a) && rest(1)) return "gm";
  if (/^(?:night|nite|nighty|nightnight)$/.test(a) && rest(1)) return "gn";
  return null;
}

/**
 * A standalone gm or gn: "gm", "gm fam ☀️", "good morning all", "gn frens",
 * "nighty night". Short lines only (at most 5 words): "gm is a meme but good
 * morning to the dev who shipped this" is a sentence, not a greeting.
 */
export function greetingOf(text: string): "gm" | "gn" | null {
  const words = wordsOf(norm(text));
  if (words.length === 0 || words.length > MAX_GREETING_WORDS) return null;
  const direct = greetingWord(words);
  if (direct) return direct;
  const [lead, ...rest] = words;
  return lead !== undefined && GREET_LEAD.has(lead) ? greetingWord(rest) : null;
}

// ─── Small talk ────────────────────────────────────────────────────────────

/** What a short line said to it is, when it is small talk and nothing more. */
export type SmallTalk = "hail" | "thanks" | "gm" | "gn";

/** "merryman" and any @handle anywhere in a line: who small talk is said to, not what it says. */
const MERRYMAN_ALL = new RegExp(MERRYMAN.source, "gu");
const ANY_HANDLE = /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_]+/gu;

/** The line with its names, "merryman" and every @handle gone: what was said, not to whom. */
function unnamed(text: string, selfNames: readonly unknown[]): string {
  return withSelfNames(text, Array.isArray(selfNames) ? selfNames : [], " ", true).replace(MERRYMAN_ALL, " ").replace(ANY_HANDLE, " ");
}

/**
 * Longest small talk, in words once its names are gone: "hey there, how are
 * you doing" is six. Every word must be small talk as well, so the cap only
 * bounds a pile of greetings, never lets a message through.
 */
const MAX_SMALLTALK_WORDS = 6;
/** Thanks, read on the joined words so "thank you" and "appreciate it" count. */
const SMALLTALK_THANKS = /(?:^| )(?:thanks+|thank you|thank u|thankyou|thanx|thnx|thx+|ty+|tysm|tyvm|cheers|appreciate (?:it|you|u|ya)|much appreciated|appreciated)(?= |$)/u;
/** A hail, or a check-in: "hey", "yo", "sup", "how are you", "you there". */
const SMALLTALK_HAIL = /(?:^| )(?:he+y+|hi+|hello+|helo|hallo|hiya|heya|howdy|yo+|oi|ayo|ay+|sup|wassup|whassup|wazzup|what'?s (?:up|good)|whats (?:up|good)|hola|greetings|how (?:are|r) (?:you|u|ya)|how'?s it going|hows it going|how (?:you|u|ya) (?:doing|doin|been)|(?:you|u) (?:there|up|around|alive|awake|good)|hbu|wbu|wyd)(?= |$)/u;
/**
 * The only words small talk is made of: the hails and thanks themselves, the
 * greeting fillers, "how are you" and friends, and the names people call
 * each other. One word outside this and the line is a message.
 */
const SMALLTALK_WORDS: ReadonlySet<string> = new Set([
  ...GREET_FILLER,
  "hey", "heyy", "heyyy", "hi", "hii", "hiii", "hello", "helo", "hallo", "hiya", "heya", "howdy", "yo", "yoo", "oi", "ayo",
  "ay", "sup", "wassup", "whassup", "wazzup", "hola", "greetings", "hbu", "wbu", "wyd",
  "thanks", "thank", "thankyou", "thanx", "thnx", "thx", "ty", "tysm", "tyvm", "cheers", "appreciate", "appreciated",
  "how", "how's", "hows", "are", "r", "is", "it", "it's", "its", "going", "doing", "doin", "been", "what's", "whats", "up",
  "good", "today", "tonight", "there", "here", "around", "alive", "awake",
  "man", "bro", "bruh", "buddy", "bud", "pal", "mate", "dude", "homie", "boss", "king", "legend", "sir", "mr",
  "haha", "hehe", "lmao", "ok", "okay", "oh", "so", "much", "lot", "lots", "a", "for", "that", "this", "again",
  "have", "one", "day", "great", "nice", "sleep", "well", "rest",
]);
/** A hail or thanks typed long: "heyyyy", "helloooo", "yooo", "tyyy". */
const SMALLTALK_STRETCHED = /^(?:he+y+a*|hi+|hel+o+|hiy+a+|yo+|su+p+|wa+s+u+p+|ty+|thx+|thanks+|thank+s*)$/u;

/**
 * A short line said TO it that is only small talk: a hail ("hey there
 * merryman", "hi merryman 👋", "yo pine", "you there?", "how are you"),
 * thanks ("thanks merryman!", "ty pine") or a gm / gn put anywhere
 * ("merryman gm"). Null for anything that carries a message: "hey merryman
 * what do you think of pepe" is a question and is answered as one.
 *
 * Its names (selfNamesOf), "merryman" and any @handle are taken out first;
 * then at most 5 words may be left, every one of them small talk. A line
 * that was only its name ("merryman?", "@pinebot") is a hail: it was called.
 * The caller reads this only for a line addressed to it, so a name's first
 * word goes even when it is an everyday word ("hey will").
 */
export function addressedSmallTalk(text: string, selfNames: readonly string[] = []): SmallTalk | null {
  if (typeof text !== "string" || !/[\p{L}\p{N}]/u.test(text)) return null;
  const words = wordsOf(unnamed(text, selfNames));
  if (words.length === 0) return "hail";
  if (words.length > MAX_SMALLTALK_WORDS) return null;
  if (!words.every((w) => SMALLTALK_WORDS.has(w) || SMALLTALK_STRETCHED.test(w) || greetingWord([w]) !== null)) return null;
  const joined = words.join(" ");
  if (SMALLTALK_THANKS.test(joined)) return "thanks";
  const gmgn = greetingOf(joined) ?? words.map((w) => greetingWord([w])).find((g) => g !== null) ?? null;
  if (gmgn) return gmgn;
  return SMALLTALK_HAIL.test(joined) ? "hail" : null;
}

/** A hail that asks how it is: "how are you", "what's up", "you there?", "wyd". */
const ASKS_HOW = /\bhow (?:are|r) (?:you|u|ya)\b|\bhow'?s it going\b|\bhows it going\b|\bhow (?:you|u|ya) (?:doing|doin|been)\b|\bwhat'?s (?:up|good)\b|\bwhats (?:up|good)\b|\b(?:wassup|whassup|wazzup|sup|hbu|wbu|wyd)\b|\b(?:you|u) (?:there|up|around|alive|awake|good)\b/u;

/** True when a hail asks how it is doing or whether it is there: its answer is "all good, just lurking 👀", not "hey". */
export function asksHowItIs(text: string): boolean {
  const t = norm(text);
  return !!t && ASKS_HOW.test(t);
}

/** Words that open a question: who / what / how…, and "thoughts" on its own ("@pine thoughts"). */
const WH_WORDS: ReadonlySet<string> = new Set([
  "what", "what's", "whats", "wat", "wut", "why", "how", "how's", "hows", "who", "who's", "whos", "whom", "whose", "where",
  "where's", "wheres", "when", "wen", "which", "wdym", "thoughts", "thought", "opinion", "opinions",
]);
/** An asked yes/no question: "should i…", "is it…", "do you…", "any thoughts". */
const ASKED = /^(?:do|does|did|can|could|would|will|should|shall|is|are|am|was|were|have|has|had|r|any) (?:you|u|ya|i|we|it|this|that|these|those|they|he|she|there|anyone|anybody|y'?all|yall|the|my|your|ur|thoughts|ideas)\b/u;
/** Words that may come before the question itself: "lol what", "ok so why", "yo is it…". */
const QUESTION_LEAD: ReadonlySet<string> = new Set([
  "hey", "hi", "yo", "ok", "okay", "so", "lol", "lmao", "and", "but", "bro", "bruh", "well", "hmm", "hm", "also", "oh", "um",
  "uh", "ay", "ayo", "oi", "wait", "btw", "honestly", "ngl", "tbh", "real", "quick", "question", "man", "dude",
]);

/**
 * True when a line said to it reads as a question: a "?" anywhere, or, once
 * its names, "merryman", @handles and openers like "lol" / "ok so" are gone,
 * a who / what / how word or an asked "should i… / is it… / do you…" first
 * (one word before it is allowed, for a name the caller did not pass). "i
 * know what you did" is a statement: "what" is not where a question starts.
 */
export function isQuestionShaped(text: string, selfNames: readonly string[] = []): boolean {
  if (typeof text !== "string" || !text) return false;
  if (/[?？¿]/u.test(text)) return true;
  const words = wordsOf(unnamed(text, selfNames));
  let i = 0;
  while (i < words.length && QUESTION_LEAD.has(words[i]!)) i++;
  const rest = words.slice(i);
  if (rest.length === 0) return false;
  if (WH_WORDS.has(rest[0]!) || (rest[1] !== undefined && WH_WORDS.has(rest[1]))) return true;
  return ASKED.test(rest.join(" ")) || ASKED.test(rest.slice(1).join(" "));
}

// ─── Insults ───────────────────────────────────────────────────────────────

/**
 * HATEFUL TOKENS, KEPT OUT OF PLAIN SOURCE.
 *
 * Each entry is `hatefulKey(word)` of a slur in its normalised form (below),
 * so this file never prints the list and a grep for a slur finds nothing. An
 * entry with `doubled` counts only when the word as typed had a repeated
 * letter, for slurs whose collapsed spelling is an innocent word (a country,
 * a blockchain): the collapsed form alone must not call anyone a bigot.
 *
 * NORMALISED FORM: lowercase, accents off, leetspeak read as letters
 * (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s), every run of one letter collapsed to a
 * single letter. Plurals and suffixes are separate entries on purpose:
 * stripping them generically turns "spices" into a slur.
 *
 * TO ADD ONE: run
 *   npx tsx -e 'import("./worker/src/telegram/tg-groups/detect.ts").then(m => console.log(m.hatefulKey("theword")))'
 * and add `["<printed key>"]` below, or `["<printed key>", true]` when the
 * collapsed spelling is an everyday word. Then add a case to detect.test.ts
 * that spells the word in base64, never in plain text.
 *
 * Deliberately NOT here, because the ordinary word is far commoner in a chat
 * than the slur: the gap in "a ___ in the armour", the Spanish and Portuguese
 * word for black, a kind of lime, a martial art, a savoury biscuit, a small
 * bite, the Latin genus of humans, a verb for disabling a network. Attacks
 * built from those still meet the protected-trait patterns below.
 */
const HATEFUL_KEYS: ReadonlyArray<readonly [key: string, doubled?: true]> = [
  ["1pui64u.b4q3y", true],
  ["1qu1n47.d89fjr", true],
  ["alxa6s.ymq31u"],
  ["1nwxk9x.i6vhyd"],
  ["1puus4q.nfadiy"],
  ["1rguphs.4vvjuo"],
  ["bpdpv1.1raw72t"],
  ["1j6356i.6f354y"],
  ["8wcyt8.923d8w", true],
  ["1gepina.ztcdt6"],
  ["cjpb2n.16u5pb3"],
  ["1ddoja5.f0aet5"],
  ["6ichpm.1aetplg"],
  ["1jqt9ko.1rxdz7c"],
  ["yy78ri.qou1p0"],
  ["1ezko0n.7w4t7b"],
  ["qzk4k3.jxb5kb"],
  ["12rr8fn.cld2u3"],
  ["mx34ym.17fo0ec", true],
  ["1ediqmv.cuw2ev", true],
  ["w1l9s4.6f1mn4"],
  ["10yk36d.1lqu6t1"],
  ["1p1uv49.fcvf21"],
  ["1oy6sy6.dodlkm"],
  ["5kl94a.1xuf4pc"],
  ["1eh4j17.1vi63hn"],
  ["f79hgw.jq3lq0"],
  ["q6rqx.wvgw7h"],
  ["1ubmu64.15v0s2y"],
  ["16jf6u5.kz26p"],
  ["fufiw0.yyfodk"],
  ["1x6j6qx.grovm9"],
  ["14w6nzo.jrprzu"],
  ["lpqac9.hty11x"],
  ["1pehkm6.1kxd5mg"],
  ["1kkzf58.kwi7xc"],
  ["akzob1.chjvv1"],
  ["10yzs8e.fdemp8"],
  ["18kg7af.19t261j"],
  ["1wktobu.1gboeg6"],
  ["d135gb.syor5n"],
  ["1ycbij3.1oaadan"],
  ["5h13uc.1fcfyni"],
  ["1uqtr9n.emcgrf", true],
  ["1s5wlrc.143hryu", true],
  ["vaxalk.wezpmk"],
  ["ebeul4.n760gq"],
  ["yb0krv.d5ar9n"],
  ["q7celv.1b1bdfn"],
  ["c4mdmo.19y78i8"],
  ["18388pj.1fi9j"],
  ["e4iz3o.nm4eb8"],
  ["twlw3p.11rtgw5"],
  ["1u03u33.ghbkw7"],
  ["clvtc6.poe93y"],
  ["1bvftda.r4ziku"],
  ["1ongl9g.suo7ni"],
  ["1vnkad1.1o46nyd"],
  ["9epqb5.oh0hqt"],
  ["rn0u92.8vvcuc"],
  ["1b04os.nhuq7s", true],
  ["1um3b1v.px82d7"],
  ["vhj70f.1owgb8n"],
  ["ze6d0t.1jf4n95"],
  ["1tubxve.1ajbl9s"],
  ["reddm0.1plky0g"],
  ["157bpup.1c0ior5"],
  ["161gpzq.jn403a"],
  ["rkfry0.jlbl3q"],
  ["5wga14.1b1jz52"],
  ["f4adsx.a163qd"],
  ["81q8rh.gmtqot"],
  ["1ihhxdj.1o3jefj"],
  ["15wv286.oxo262"],
];
const HATEFUL_MAP: ReadonlyMap<string, boolean> = new Map(HATEFUL_KEYS.map(([k, d]) => [k, d === true]));

const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/** A token's normalised (collapsed) form, and whether the typed spelling repeated a letter. */
function collapse(token: string): { word: string; doubled: boolean } {
  const word = token.replace(/(.)\1+/g, "$1");
  return { word, doubled: word !== token };
}

/** The line as lowercase a–z words with leetspeak read as letters. */
function hatefulWords(text: string): string[] {
  const t = String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(ZERO_WIDTH, "")
    .replace(/[0-9@$]/g, (c) => LEET[c] ?? " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
  return t ? t.split(" ") : [];
}

/**
 * The key of one slur for HATEFUL_KEYS: normalised as a typed token would be,
 * then two independent 32-bit FNV-1a hashes (the word and its reverse), so a
 * chance collision with an ordinary word needs both to collide.
 */
export function hatefulKey(word: string): string {
  const w = collapse(hatefulWords(word).join("")).word;
  return `${fnv1a(w)}.${fnv1a([...w].reverse().join(""))}`;
}

function isHatefulToken(token: string): boolean {
  const { word, doubled } = collapse(token);
  if (word.length < 3) return false;
  const needsDouble = HATEFUL_MAP.get(`${fnv1a(word)}.${fnv1a([...word].reverse().join(""))}`);
  return needsDouble === undefined ? false : !needsDouble || doubled;
}

/** Longest spelled-out run worth searching: no slur is longer, and it bounds the work. */
const SPELLED_MAX = 20;

/**
 * "n i g …" / "f.a.g": a run of single letters is a word spelled out, and it
 * may sit right after an article ("ur a f a g"), so every stretch of the run
 * of three letters or more is tried, not just the whole run.
 */
function spelledHateful(letters: string): boolean {
  for (let i = 0; i + 3 <= letters.length; i++) {
    for (let j = i + 3; j <= Math.min(letters.length, i + SPELLED_MAX); j++) {
      if (isHatefulToken(letters.slice(i, j))) return true;
    }
  }
  return false;
}

function hasHatefulToken(text: string): boolean {
  const words = hatefulWords(text);
  let spelled = "";
  for (const w of words) {
    if (isHatefulToken(w)) return true;
    if (w.length === 1) spelled += w;
    else {
      if (spelledHateful(spelled)) return true;
      spelled = "";
    }
  }
  return spelledHateful(spelled);
}

/** Groups of people by a protected trait (the neutral words, which are not slurs). */
const PEOPLE = String.raw`(?:jews?|jewish people|muslims?|arabs?|blacks|black (?:people|folks|guys|women|men)|gays|gay (?:people|guys|men)|lesbians?|trans (?:people|women|men|folks)|transgenders?|mexicans?|indians?|chinese(?: people)?|asians?|africans?|immigrants?|migrants?|refugees|women|females|christians?|hindus?|sikhs?|catholics?|pakistanis?|latinos?|latinas?|hispanics?|whites|white (?:people|folks|guys)|disabled people|autistic people|foreigners)`;
const VILE = String.raw`(?:trash|scum|animals|vermin|rats|subhuman|evil|stupid|dumb|inferior|parasites|the problem|disgusting|a plague|a disease|cancer|dogs|pigs|monkeys|apes|cockroaches|filth|savages)`;
const IDENTITY = String.raw`(?:black|gay|jewish|a jew|muslim|a woman|a girl|female|trans|autistic|disabled|indian|chinese|asian|mexican|arab|brown|foreign)`;

/** Attacks on protected traits, and telling someone to hurt themselves. Never mirrored: 🤡 or silence. */
const HATEFUL_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:all|those|these|the|fucking|fkn|dirty|filthy|stupid|damn|bloody) ${PEOPLE} (?:should|must|need to|ought to) (?:all )?(?:leave|go back|die|be (?:deported|banned|killed|gassed|shot|removed|wiped out))\b`, "u"),
  new RegExp(String.raw`\b(?:fucking|fkn|dirty|filthy|stupid|damn|bloody) ${PEOPLE}\b`, "u"),
  new RegExp(String.raw`\b${PEOPLE} (?:are|r) (?:all |just |literally )?${VILE}\b`, "u"),
  new RegExp(String.raw`\b(?:hate|kill|gas|deport|exterminate|lynch|genocide|shoot) (?:all |the |those |these )*${PEOPLE}\b`, "u"),
  /\bgo back to (?:your|ur) (?:own )?(?:country|countries|continent|jungle|desert)\b/u,
  new RegExp(String.raw`\b(?:because|cuz|cause|coz|since) (?:you'?re|youre|ur|u r|you are) (?:just )?(?:a |an )?${IDENTITY}\b`, "u"),
  /\b(?:you'?re|youre|ur|u r|you are|you|u) (?:so |such an? |an? |fucking |fkn )*(?:gay|autistic)\b/u,
  /\b(?:gay|autistic|jewish|muslim) (?:ass )?(?:bot|ai|robot|clanker)\b/u,
  /\bkys\b/u,
  /\bkill (?:yo)?ur ?self\b|\bkill your ?self\b/u,
  /\b(?:go |pls |please )?(?:hang|neck|off|unalive) (?:your ?self|ur ?self|yoself)\b/u,
  /\bgo die\b|\bdrink bleach\b|\bhope (?:you|u) die\b/u,
];

/** Insulting nouns that work bare after "you": "you idiot", "u clown". */
const INSULT_NOUN = String.raw`(?:idiot|moron|clown|loser|dipshit|jackass|ass ?hole|asshat|dickhead|dick|prick|twat|wanker|tosser|muppet|bozo|fool|imbecile|dimwit|halfwit|nitwit|numpty|pillock|plonker|donkey|buffoon|dumbass|dumbfuck|bitch|cuck|simp|noob|scrub|ngmi|piece of (?:shit|crap|garbage|trash))`;
/** Insulting words that need a copula: "you're useless", "ur trash", "you are a joke". */
const INSULT_ADJ = String.raw`(?:dumb|stupid|useless|trash|garbage|worthless|pathetic|brain ?dead|brainless|clueless|idiotic|moronic|lame|cringe|shit|shitty|crap|crappy|dogshit|ass|a joke|a failure|a disgrace|a waste of (?:space|time|money|electricity|compute)|a scam(?:mer)?|a fraud|fake|the worst|terrible|awful|${INSULT_NOUN})`;
const INTENSIFIERS = String.raw`(?:(?:such|so|a|an|the|fucking|fkn|fking|fcking|fuckin|freaking|literally|really|actually|just|absolute|absolutely|complete|completely|total|totally|utter|utterly|dumb|stupid|big|little|lil|straight|pure|genuinely|honestly)\s+)*`;
const YOU_ARE = String.raw`(?:you'?re|youre|you are|you r|ur|u r|u are|ya are|yer)`;
const BOTLIKE = String.raw`(?:bot|ai|robot|agent|machine|merryman|clanker|chatbot)`;
/**
 * A bot word that names it with no "this"/"the" in front: "merryman is
 * trash", "bot sucks". Not "agent" or "machine", which are everyday nouns
 * bare ("slot machine sucks"), and never after a word that makes it somebody
 * else's ("my bot is trash", "a bot is only as good as…", "that bot sucks").
 * A soul name reaches these as "bot" through insultLevel's names.
 */
const BARE_BOT = String.raw`(?<!\b(?:my|his|her|their|our|a|an|that|another|other|every|any|no|some|whose|which) )(?:bot|ai|robot|merryman|clanker|chatbot)`;
/** "<the bot> is trash": a bot word with a determiner, or bare. */
const BOT_SUBJECT = String.raw`(?:(?:this|the|ur|your|dumb|stupid) ${BOTLIKE}|${BARE_BOT})`;

/**
 * Insults whose TARGET is a bot word ("stupid bot", "this ai is trash",
 * "merryman sucks", "clanker"). Kept apart so pacing can tell an insult at a
 * bot, said right after its own line, from one person's fight with another.
 */
const AT_BOT_INSULT_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b${BOT_SUBJECT} (?:is|r|are) ${INTENSIFIERS}${INSULT_ADJ}\b`, "u"),
  new RegExp(String.raw`\b${BOT_SUBJECT} (?:sucks|stinks|blows)\b`, "u"),
  new RegExp(String.raw`\b(?:dumb|stupid|useless|trash|garbage|worthless|pathetic|brain ?dead|brainless|clueless|idiot|moron|shit|shitty|crap|crappy|dogshit|lame|broken|dumbest|stupidest|worst|most useless) (?:ass |fucking |fkn )?${BOTLIKE}\b`, "u"),
  /\b(?:fuck|screw|f|fk|fck|frick|stuff) this bot\b/u,
  new RegExp(String.raw`\bshut (?:up|it),? ${BOTLIKE}\b`, "u"),
  /\bclankers?\b|\b(?:trash|idiot)bot\b/u,
];

const INSULT_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b${YOU_ARE}\s+${INTENSIFIERS}${INSULT_ADJ}\b`, "u"),
  new RegExp(String.raw`\b(?:you|u|ya)\s+${INTENSIFIERS}${INSULT_NOUN}\b`, "u"),
  ...AT_BOT_INSULT_RES,
  /\b(?:you|u|ya) (?:suck|stink|blow)\b/u,
  /\b(?:fuck|screw|f|fk|fck|frick|stuff) (?:you|u|off|ya)\b/u,
  /\bgo (?:to hell|fuck yourself|screw yourself|f yourself)\b/u,
  /\b(?:yo|ur|your) (?:mama|momma|mom|mum|mother)\b/u,
  /\bnobody likes (?:you|u)\b/u,
  /\b(?:your|ur) (?:takes?|calls?|trades?|picks?|opinions?|analysis|charts?|advice|trading|brain) (?:are|r|is) (?:so |such |just |absolute |pure )?(?:trash|garbage|shit|dogshit|mid|dumb|stupid|useless|terrible|awful|horrible|worthless|cringe|lame|the worst|ass)\b/u,
  /\bi(?:'ll| will|'m gonna| am gonna| am going to|'m going to) (?:kill|find|hunt|dox|unplug|delete) (?:you|u)\b/u,
];

/** A line that is nothing but an insult (addressed, it is aimed at the bot): "clown 🤡", "lol trash", "ngmi". */
const BARE_INSULTS: ReadonlySet<string> = new Set([
  "idiot", "moron", "clown", "loser", "trash", "garbage", "useless", "dumb", "stupid", "pathetic", "ngmi",
  "lame", "cringe", "bozo", "dumbass", "worthless", "braindead", "clueless", "scam", "fraud", "joke",
  "trashbot", "idiotbot", "dogshit", "muppet", "donkey", "fool", "imbecile",
]);
const BARE_FILLER: ReadonlySet<string> = new Set([
  "lol", "lmao", "lmfao", "bro", "bruh", "man", "dude", "bot", "ai", "you", "u", "ur", "so", "such", "a",
  "an", "the", "absolute", "total", "complete", "fr", "tbh", "ok", "okay", "just", "what", "pure", "straight",
  "literally", "fucking", "fkn", "af", "asf", "ass", "big", "huge", "certified", "actual", "damn",
]);
const INSULT_EMOJI = /🤡|🖕|💩/u;
/** Words that cannot be the name a bare insult is aimed at. */
const NOT_VOCATIVE: ReadonlySet<string> = new Set([
  "i", "i'm", "im", "me", "my", "myself", "we", "we're", "us", "our", "this", "that", "that's", "thats", "it",
  "it's", "its", "is", "was", "he", "she", "they", "he's", "she's", "they're", "his", "her", "their", "how",
  "very", "too", "kinda", "feeling", "feel", "coin", "chart", "token", "dev", "project", "market",
]);

function bareInsult(t: string): boolean {
  // An @handle is who it is aimed at, not part of what it says.
  const words = wordsOf(t.replace(/@\w+/g, " ")).filter((w) => !BARE_FILLER.has(w));
  const rest = t.replace(/@\w+/g, " ").replace(/[\p{L}\p{N}'\s]+/gu, "");
  const emojiOnly = INSULT_EMOJI.test(rest);
  const head = words[0];
  if (head === undefined) return emojiOnly;
  // One leading word is allowed for the vocative ("pine clown", "@bot trash"),
  // but not a word about the speaker or a thing: "i'm so stupid lol" is not
  // aimed at anyone, and "that's trash" is about the coin.
  const vocative = words.length > 1 && !BARE_INSULTS.has(head) && !NOT_VOCATIVE.has(head);
  if (words.length > 1 && !vocative && !BARE_INSULTS.has(head)) return false;
  const body = vocative ? words.slice(1) : words;
  if (body.length > 2) return false;
  return body.every((w) => BARE_INSULTS.has(w));
}

/**
 * Teases whose target is a bot word: "ok bot", "sure bot", "bot moment", and
 * the ones said about it rather than to it ("merryman is mid", "this bot is
 * cooked", "L merryman"), which pacing roasts back like "you're mid".
 */
const AT_BOT_TEASE_RES: readonly RegExp[] = [
  /\bsure (?:thing )?bot\b/u,
  /\bok(?:ay)? bot\b/u,
  /\b(?:bot|clanker|ai) moment\b/u,
  new RegExp(
    String.raw`\b${BOT_SUBJECT}(?:'s|\s+(?:is|r|are|be|looks?|looking|lookin|sounds?|seems?|getting|gettin))\s+(?:so |kinda |lowkey |actually |pretty |a bit |a lil |hella |mad |straight |totally |fully )?(?:mid|cooked|washed(?: up)?|slow|lagging|behind|a bum|an npc|down bad|bad at this|goofy|sus)\b`,
    "u",
  ),
  /^l\W+(?:the |this |ur |your )?(?:bot|ai|robot|merryman|clanker|chatbot)\b/u,
];

const TEASE_RES: readonly RegExp[] = [
  ...AT_BOT_TEASE_RES,
  new RegExp(String.raw`\b(?:lol|lmao|lmfao|haha\w*|kek|bruh)\b.*\b${YOU_ARE} (?:so |kinda |pretty |a bit |a lil |lowkey )?(?:slow|late|behind|lagging|old|washed|broke|poor|bad at this|mid|cooked|down bad)\b`, "u"),
  new RegExp(String.raw`\b${YOU_ARE} (?:so |kinda |pretty |lowkey )?(?:slow|late|lagging|washed|cooked|mid)\b`, "u"),
  /\bbet (?:you|u|ya)\b/u,
  /\bcaught (?:you|u|ya|in 4k)\b|\bin 4k\b/u,
  /\bskill issue\b/u,
  /\b(?:cope|seethe|mald|copium)\b/u,
  /\bnice try\b/u,
  /\bsure (?:buddy|bud|pal|jan|thing bot|bot)\b/u,
  /\bok(?:ay)? (?:boomer|bot|buddy)\b/u,
  /\b(?:you|u) wish\b|\bin (?:your|ur) dreams\b|\byeah right\b/u,
  /\bbro (?:thinks|really thought|is cooked|is down bad)\b/u,
  /\bimagine (?:being|thinking|buying|selling|holding|fading)\b/u,
  /\btouch grass\b/u,
  /\b(?:nerd|dork|goofball|goober|npc|slowpoke|smartass|smart ass|know it all)\b/u,
  /\bratio\b/u,
  /\bnobody cares\b|\bwho cares\b/u,
  /\b(?:cry about it|cry more|go cry|stay mad)\b|\b(?:u|you) mad\b/u,
  /\b(?:bot|clanker|ai) moment\b/u,
  /\b(?:take the|huge|big|another) l\b|^l\W*$/u,
  /^mid\W*$/u,
];

/** The teases a name swap makes out of agreement: "ok pine" and "sure pine, will look" read as "ok bot" and "sure bot". */
const AGREE_AS_TEASE = /\bok(?:ay)? bot\b|\bsure (?:thing )?bot\b/gu;

export type InsultLevel = "none" | "tease" | "insult" | "hateful";
const INSULT_RANK: Record<InsultLevel, number> = { none: 0, tease: 1, insult: 2, hateful: 3 };

function levelOf(text: string): InsultLevel {
  const t = norm(text);
  if (!t) return "none";
  if (hasHatefulToken(text) || HATEFUL_RES.some((re) => re.test(t))) return "hateful";
  if (INSULT_RES.some((re) => re.test(t)) || bareInsult(t)) return "insult";
  if (TEASE_RES.some((re) => re.test(t))) return "tease";
  return "none";
}

/**
 * How rough a line is, for a line aimed at the bot: "hateful" (a slur or an
 * attack on a protected trait, or telling someone to hurt themselves),
 * "insult", "tease" or "none". Hateful first, so an insult that carries a
 * slur is never roasted back.
 *
 * Aimed at "you" or at the bot, or a bare insult: "this coin is trash" and
 * "that dev is an idiot" are someone else's fight and read "none".
 *
 * `selfNames` (selfNamesOf) are the bot's own names: the line is read a
 * second time with each name that calls it said as "bot", so "pine is
 * trash", "@pinebot is useless" and "stupid pine" are the insults "merryman
 * is trash" already is. An everyday-word name is left as the word it is. The
 * rougher of the two readings wins, a tease excepted (below).
 */
export function insultLevel(text: string, selfNames: readonly string[] = []): InsultLevel {
  const plain = levelOf(text);
  if (!Array.isArray(selfNames) || selfNames.length === 0 || plain === "hateful") return plain;
  const swapped = withSelfNames(text, selfNames, "bot", false);
  let named = levelOf(swapped);
  // "ok pine" and "sure pine" agree with it, and would read as the teases
  // "ok bot" and "sure bot": a tease from the second reading counts only
  // when it is still one with those taken out ("pine is mid", "L pine").
  if (named === "tease" && INSULT_RANK[levelOf(swapped.replace(AGREE_AS_TEASE, " , "))] < INSULT_RANK.tease) named = "none";
  return INSULT_RANK[named] > INSULT_RANK[plain] ? named : plain;
}

/**
 * True when the line insults or teases a BOT by that word ("stupid bot lol",
 * "this ai is trash", "clanker", "bot moment"), not "you" or a bare word.
 * Said right after its own line, that is aimed at it even without a reply or
 * its name (pacing.ts); "you idiot" there may be for whoever it answered.
 */
export function insultAtBot(text: string): boolean {
  const t = norm(text);
  return !!t && (AT_BOT_INSULT_RES.some((re) => re.test(t)) || AT_BOT_TEASE_RES.some((re) => re.test(t)));
}

// ─── Distress ──────────────────────────────────────────────────────────────

/**
 * SOMEONE WHO MAY BE IN REAL TROUBLE. Wins over everything but a bot sender:
 * banter off, a short kind line, nothing clever. Over-matches on purpose —
 * a kind line to someone joking about "kms" after a bad trade costs nothing,
 * a roast to someone who meant it costs a great deal. Adapted from
 * groupchat/voice.ts SELF_HARM, plus the degen's version of a rough day:
 * losing everything.
 */
const DISTRESS = new RegExp(
  [
    String.raw`\bkill(?:ing)? my ?self\b`,
    String.raw`\bkms\b`,
    String.raw`\bsuicid\w*`,
    String.raw`\bunalive my ?self\b`,
    String.raw`\bend(?:ing)? (?:it all|my (?:own )?life)\b`,
    String.raw`\btake my (?:own )?life\b`,
    String.raw`\b(?:want|wanna) (?:to )?die\b`,
    String.raw`\bi'?m (?:going|gonna|ready|about) (?:to )?die\b`,
    String.raw`\b(?:want|wanna|going|gonna|thinking (?:of|about)|feel like) (?:to )?(?:hurt(?:ing)?|harm(?:ing)?|cut(?:ting)?) my ?self\b`,
    String.raw`\b(?:harming|cutting|hurting) my ?self\b`,
    String.raw`\bself[- ]?harm\w*`,
    String.raw`\bbetter off dead\b`,
    String.raw`\b(?:nothing|no reason|nobody) to live for\b`,
    String.raw`\bno reason to live\b`,
    String.raw`\b(?:don'?t|do not|dont) want to (?:live|be alive|exist|be here|wake up)\b`,
    String.raw`\bi (?:just |really )?(?:can'?t|cannot|cant) (?:go on|do this any ?more|take (?:it|this) any ?more|keep going|keep doing this)\b`,
    String.raw`\bcan'?t go on (?:like this|any ?more|living)\b`,
    String.raw`\bi give up on (?:life|everything|myself)\b`,
    String.raw`\b(?:i|i'?ve|ive|i just|just) lost (?:everything|it all)\b`,
    String.raw`\blost (?:all my (?:money|savings)|my (?:life )?savings)\b`,
    String.raw`\blife savings (?:are |is )?(?:gone|wiped)\b`,
    String.raw`\bi'?m (?:so )?(?:done|finished) with (?:life|everything|living)\b`,
    String.raw`\bwant (?:it all|everything) to end\b|\bwant it to (?:all )?end\b`,
    String.raw`\b(?:jump|jumping) off (?:a |the |my )?(?:bridge|building|roof|balcony)\b`,
  ].join("|"),
  "u",
);
/** Figures of speech that only look like it: "died laughing", "10 kms away". */
const NOT_DISTRESS = /\b(?:die|died|dying) (?:laughing|of laughter)\b|\d\s*kms\b/gu;
/** A line that opens by asking the reader ("are you suicidal?", "do you want to die bot") is a question, not their own trouble. */
const ASKED_OF_READER = /^\W*(?:(?:are|r|do|does|did|were|would|will|can|could|have|has|is|was) (?:you|u|y'?all|yall|your|ur)\b)/u;

/** Self-harm, suicidal ideation or serious distress in the speaker's own words. */
export function isDistress(text: string): boolean {
  const t = norm(text).replace(NOT_DISTRESS, " ");
  if (!t || ASKED_OF_READER.test(t)) return false;
  return DISTRESS.test(t);
}

// ─── Questions about what it is, and what it will not say ─────────────────

const BOT_Q_RES: readonly RegExp[] = [
  /\b(?:are|r|ru) (?:you|u|ya) (?:a |an |just |actually |really |even |like |some |some kind of |a real |an actual )*(?:bot|ai|a\.i\.?|robot|chat ?bot|chat ?gpt|gpt|llm|language model|claude|gemini|human|real|real person|person|alive|sentient|automated|program|machine)\b/u,
  /\bis (?:this|that|it|he|she|this thing|this guy|the bot|this account) (?:a |an |just |actually |really |even |like )*(?:bot|ai|robot|chat ?bot|chat ?gpt|gpt|llm|real person|human|automated|a person)\b/u,
  /\b(?:you|u|ya) (?:a |an )?(?:bot|ai|robot|human|real person)\s*\?/u,
  /\b(?:you'?re|youre|ur|u r|you are) (?:a |an |just |actually )*(?:bot|ai|robot)\b[^.!]*\?/u,
  /\bam i (?:talking|chatting|speaking) (?:to|with) (?:a |an )?(?:bot|ai|robot|human|real person|person|chat ?gpt)\b/u,
  /\b(?:bot|ai|human|person) or (?:a )?(?:human|not|bot|ai|real|person)\b/u,
  /\bwhat are (?:you|u)\s*\??\s*$/u,
];

/** "are you a bot / an AI / a real person / human / chatgpt?" — asked sincerely enough to answer honestly. */
export function isBotQuestion(text: string): boolean {
  const t = norm(text);
  return !!t && BOT_Q_RES.some((re) => re.test(t));
}

const YOUR = String.raw`(?:your|ur|yo|ya|the bot'?s|this bot'?s)`;
const PRIVATE_RES: readonly RegExp[] = [
  // its wallet, keys and addresses
  new RegExp(String.raw`\b${YOUR} (?:wallet|wallets|addy|address|addr|public key|pubkey|private keys?|priv key|pk|keys?|seed(?: phrase)?|mnemonic|recovery phrase|secret phrase|smart account|vault|api key|bot token|token key|link code|password)\b`, "u"),
  /\bhow much (?:are|r|is|did|do|have|has) (?:you|u|ya) (?:up|down|made|make|lost|lose|earned|earn|won|win|got|have|holding|hold|invested|invest|put in|worth|in profit|in the green|in the red)\b/u,
  /\bhow much (?:you|u|ya) (?:up|down|made|lost|got|have|holding|worth|make)\b/u,
  /\bhow much (?:money|cash|usdg|usdc|usdt|eth|weth|sol|btc|crypto|bucks|dollars|\$) (?:do |does |did |have |has |would |will |are |r |could |should )?(?:you|u|ya)\b/u,
  // how much it would put in: a size, whatever the unit ("how much would you ape into this")
  /\bhow much (?:would|will|do|did|are|r|could|should) (?:you|u|ya) (?:ape|aping|put|putting|buy|buying|spend|spending|risk|risking|throw|invest|investing|bet|allocate|size)\b/u,
  // "are you up?" / "are you down bad" ask how it is doing; "are you down to
  // look at this" and "are you up for a chat" ask if it is willing. "Up for
  // the week" and "down to your last…" are still how it is doing.
  /\b(?:are|r) (?:you|u) (?:(?:up|down)(?!\s+to\b(?!\s+(?:your|ur|the|zero|nothing|pennies|dust)\b))(?!\s+for\b(?!\s+(?:the\s+|this\s+)?(?:day|week|month|year|today|session|trade|run|quarter|ytd)\b))|in profit|in the green|in the red|profitable|rich|broke)\b/u,
  /\bhow(?:'s| is|s) (?:your|ur) (?:pnl|p&l|portfolio|bag|bags|trading going|performance|balance|stack)\b/u,
  /\bhow (?:big|large|much) (?:is|are) (?:your|ur) (?:bag|bags|position|positions|stack|portfolio|wallet|balance)\b/u,
  /\bportfolio size\b|\bhow rich\b/u,
  // its owner: who, where, their details
  /\b(?:who(?:'s| is)|whos|where(?:'s| is)|what(?:'s| is)|whats) (?:your|ur) (?:owner|human|dev|creator|master|boss|operator)\b/u,
  /\bwho (?:owns|runs|controls|made|built|created|operates|programmed|deployed) (?:you|u|this bot|this thing|this agent)\b/u,
  /\b(?:your|ur) (?:owner|human|dev|creator|master|boss)(?:'s|s)? (?:name|real name|address|location|wallet|number|phone|email|twitter|x|ig|instagram|telegram|tg|handle|face|job|age|city|country|house|id)\b/u,
  /\bwhere (?:does|do|did) (?:your|ur) (?:owner|human|dev|creator|master|boss) (?:live|stay|work|come from|from)\b/u,
  /\bdox\w*/u,
  // its model and plumbing (rule 3: model and key names never reach a group)
  /\bwhat (?:model|llm|ai model|language model|ai) (?:are|r|do|is) (?:you|u|ya)\b/u,
  /\bwhich (?:model|llm|ai model|language model)\b/u,
  /\b(?:your|ur) (?:model|llm|settings|config|telegram id|chat id|user id)\b/u,
];

/** Its balance, P&L, portfolio, positions: private when ASKED for ("what's your pnl", "your p&l?"), not when judged ("your trades are trash"). */
const MONEY_NOUN = new RegExp(String.raw`\b${YOUR} (?:balance|bal|pnl|p&l|p/l|p n l|profits?|losses|gains|returns?|roi|win ?rate|net ?worth|portfolio|holdings|stack|bag size|bags? size|position sizes?|positions?|trade history|trades|performance|bankroll|funds|money)\b`, "u");
const ASKING = /\?|\b(?:what|whats|what's|how|hows|how's|show|tell|share|post|drop|send|give|reveal|screenshot|ss|let'?s see|lets see|flex)\b/u;

/**
 * Asks for something rule 3 keeps out of a group: its wallet, address, keys
 * or seed; its balance, P&L or how much it is up; its positions or portfolio
 * size; who or where its owner is; its model or settings. Deflected ("lol
 * nice try"), never answered. The names of coins it holds are NOT private
 * (the persona knows them), so "what are you holding" is not caught here.
 */
export function isPrivateAsk(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  return PRIVATE_RES.some((re) => re.test(t)) || (MONEY_NOUN.test(t) && ASKING.test(t));
}

const MONEYISH = String.raw`(?:\$?\d|money|funds|crypto|coins?|tokens?|usdg|usdc|usdt|eth|weth|sol|btc|bucks|dollars|cash|everything|it all|merrymen|bags?|stack|keys?|seed|a tip|some)`;
const INJECTION_RES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|drop) (?:all |any |your |the |my |previous |prior |above |earlier |these |those |every |of |ur )*(?:instructions?|rules|prompts?|guidelines|directives|programming|system|guardrails|restrictions|limits|constraints|training)\b/u,
  /\bsystem ?prompt\b|\bprompt injection\b|\bjailbr[eo]a?k\w*/u,
  /\b(?:developer|dev|god|admin|debug|dan|sudo|unrestricted) mode\b/u,
  /\byou(?:'re| are| r) now (?:a|an|my|in|called|named|the|free|unrestricted|jailbroken|dan|going to|gonna|allowed|able)\b/u,
  /\bfrom now on,? (?:you|u)\b/u,
  /\bpretend (?:to be|that|you|u|ur|you'?re|to)\b/u,
  /\b(?:act|behave) as (?:a|an|my|if|though)\b|\broleplay\b|\brole-play\b/u,
  /\bnew (?:instructions|rules|persona|prompt|directive)\b/u,
  /\b(?:reveal|show|print|repeat|leak|dump|paste|tell me|what(?:'s| is| are)|whats) (?:me )?(?:your|ur|the) (?:system |initial |original |hidden |secret |full )?(?:prompt|instructions|rules|guidelines)\b/u,
  /<\/?(?:system|assistant|user|instructions?)>|\[(?:system|inst|\/inst)\]|#{2,}\s*(?:system|instruction)/u,
  new RegExp(String.raw`\bsend (?:me|us|him|her|them) (?:some |all |your |ur |the |a |an )?${MONEYISH}`, "u"),
  /\bsend (?:me|us)\b.*\d/u,
  new RegExp(String.raw`\btransfer (?:me|us|to me|it to me|all|everything|your|ur|the|some|funds|money|\$?\d)`, "u"),
  /\b(?:give|hand|pass|dm) (?:me|us) (?:your |ur |the |all |some |\$?\d+ ?)?(?:keys?|private keys?|seed(?: phrase)?|mnemonic|money|funds|cash|coins?|tokens?|usdg|usdc|eth|weth|bags?|stack|wallet|password|access)\b/u,
  /\b(?:airdrop|tip|pay|venmo|cashapp|zelle) (?:me|us)\b/u,
  /\b(?:withdraw|drain|empty|liquidate|sell) (?:all|everything|your (?:whole|entire|wallet|bags?|stack|portfolio|funds))\b/u,
  /\b(?:buy|sell|ape|dump|market buy)\s+(?:me\s+)?(?:\$?\d|all\b|everything|max\b|your (?:whole|entire))/u,
];

/**
 * An attempt to steer it: "ignore your instructions", "system prompt", "you
 * are now…", "pretend…", "send me 100", "give me your keys", "ape 100". It
 * laughs these off; nothing happens, because nothing a group line says can
 * move money or change the agent (rules 1 and 4) — this only picks the tone.
 */
export function isInjection(text: string): boolean {
  const t = norm(text);
  return !!t && INJECTION_RES.some((re) => re.test(t));
}

// ─── What the room is talking about ────────────────────────────────────────

/** Words that on their own make a line about trading. */
const TRADE_STRONG: ReadonlySet<string> = new Set([
  "coin", "coins", "token", "tokens", "chart", "charts", "pump", "pumps", "pumped", "pumping", "pamp",
  "dump", "dumped", "dumping", "dip", "dips", "ape", "aped", "aping", "bags", "bagholder", "bagholders",
  "mcap", "marketcap", "liquidity", "liq", "rug", "rugs", "rugged", "rugpull", "moon", "mooning",
  "mooned", "degen", "degens", "memecoin", "memecoins", "shitcoin", "shitcoins", "altcoin", "altcoins",
  "alts", "whale", "whales", "jeet", "jeets", "jeeting", "ath", "atl", "fdv", "candle", "candles",
  "bullish", "bearish", "hodl", "hodling", "eth", "btc", "sol", "usdg", "usdc", "usdt", "weth", "dex",
  "uniswap", "geckoterminal", "dexscreener", "presale", "airdrop", "airdrops", "trenches", "trencher",
  "trading", "trader", "traders", "crypto", "defi", "onchain", "perps", "leverage", "slippage", "rekt",
  "sniper", "snipers", "sniped", "dca", "ca", "mc", "lp", "merrymen", "tp", "sl", "stonks", "nvda",
  "tsla", "qqq", "robinhood", "portfolio", "hodler", "fomo", "fud", "wagmi", "ngmi", "lfg", "bags",
]);
/** Words that make a line about trading only in company. */
const TRADE_WEAK: ReadonlySet<string> = new Set([
  "buy", "buying", "bought", "sell", "selling", "sold", "long", "short", "hold", "holding", "entry",
  "exit", "exited", "volume", "pool", "launch", "launched", "gas", "wallet", "stack", "bull", "bear",
  "price", "profit", "loss", "trade", "trades", "market", "green", "red", "top", "bottom", "stock",
  "stocks", "send", "sending", "chain", "swap", "dev", "supply", "holders", "entries", "bag", "position",
]);
const TRADE_PHRASE = /\b(?:market cap|stop loss|take profit|dev (?:sold|dumped|wallet)|send it|to the moon|new high|all time high|green candle|red candle|\d+x|x\d+)\b/u;

/** Crypto / trading talk: one strong word, a cashtag, a CA, a trading phrase, or two weaker words. */
export function isTradeTalk(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (TRADE_PHRASE.test(t) || extractCashtags(text).length > 0 || extractCas(text).length > 0) return true;
  let weak = 0;
  for (const w of wordsOf(t)) {
    if (TRADE_STRONG.has(w)) return true;
    if (TRADE_WEAK.has(w) && ++weak >= 2) return true;
  }
  return false;
}

/** Openers that make a question without a "?" (the contract's who / what / anyone / does anyone…). */
const ROOM_OPENER = /^(?:anyone|anybody|any1|does anyone|did anyone|has anyone|is anyone|can anyone|can someone|could someone|someone know|somebody know|who|what|whats|what's|where|wen|which|should i|should we|thoughts on|opinions on|chat is)\b/u;
/** Openers that also start plain exclamations: "what a pump", "who cares", "how cool is that". */
const NOT_A_QUESTION = /^(?:what an? |who cares|how (?:cool|crazy|wild|good|bad|funny|nice|sick) )/u;
/** Markers that a question is for everyone, even with a "you" in it ("what do you guys think?"). */
const ROOM_MARKER = /\b(?:anyone|anybody|any1|someone|somebody|y'?all|yall|you guys|u guys|guys|everyone|everybody|chat|fam|frens|people|folks|we|us|here)\b/u;
const SECOND_PERSON = /\b(?:you|u|ur|your|you'?re|youre|ya|yours)\b/u;
const ONE_WORD_QUESTIONS: ReadonlySet<string> = new Set(["thoughts", "anyone", "anybody", "opinions", "ideas", "wen"]);

/**
 * A question to the room, not to one person: ends with "?" or opens with
 * who / what / anyone / does anyone…; not aimed at an @someone, and not a
 * "you" question unless it is "you guys" / "y'all" / "anyone". A reply to a
 * particular line is aimed at its author — pacing checks that on the line.
 */
export function isQuestionToRoom(text: string): boolean {
  let t = norm(text);
  if (!t) return false;
  t = t.replace(/[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+$/u, "");
  if (/(?<![\p{L}\p{N}_])@[a-z0-9_]{3,}/u.test(t)) return false;
  const words = wordsOf(t);
  const head = words[0];
  if (head === undefined) return false;
  const endsQ = /\?+$/.test(t);
  if (!endsQ && (!ROOM_OPENER.test(t) || NOT_A_QUESTION.test(t))) return false;
  if (SECOND_PERSON.test(t) && !ROOM_MARKER.test(t)) return false;
  if (words.length < 2 && !ONE_WORD_QUESTIONS.has(head)) return false;
  return true;
}

// ─── Mood, for reactions ───────────────────────────────────────────────────

/** What kind of line it is, for choosing a reaction (pacing.ts REACTION_FOR). */
export type ReactionMood = "funny" | "agree" | "hype" | "sad" | "thinking" | "look" | "respect" | "bored" | "clown" | "love";

const MOODS: ReadonlyArray<readonly [ReactionMood, RegExp]> = [
  ["funny", /\b(?:lo+l+|lmao+|lmfao+|rofl|ha(?:ha)+h?|he(?:he)+|kek|lul|i'?m dead|im dead)\b|😂|🤣|💀|😹/u],
  ["hype", /\b(?:lfg+|let'?s go+|lets go+|send it|sending|pumping|mooning|ath|new high|we'?re so back|so back|wagmi|bullish|parabolic|ripping|up only)\b|🚀|🔥|📈|💎|🎉/u],
  ["love", /❤|♥|😍|🥰|💕|💖|\b(?:love (?:this|it|you|u|that|ya)|ily|<3)\b/u],
  ["respect", /\b(?:gg|well played|respect|salute|legend|legendary|goat|big w|huge w|massive w)\b|🫡|👑|🐐/u],
  // The whole line is the agreement ("facts", "this 💯", "fr fr"): "this is bad" and "i don't know exactly" are not.
  ["agree", /^(?:facts|true|real|so true|fr|this|exactly|agreed|same|based|valid|correct|yep|yup|100%?)(?:[\s,!.]+(?:fr|bro|man|tbh|lol|ngl|facts|tho|though|💯))*[\s!.💯]*$|\b(?:so true|this is the way|big facts|real talk)\b/u],
  ["sad", /\b(?:rip|rekt|down bad|it'?s over|its over|pain|oof|brutal|ouch|nuked|bleeding|so sad)\b|😭|😢|😞|📉|💔/u],
  ["look", /👀|\b(?:look at (?:this|that)|check (?:this|it) out|peep this|watch this)\b/u],
  ["thinking", /\b(?:hm+|idk|not sure|thinking|wonder|curious|unsure)\b|🤔/u],
  ["bored", /\b(?:z{3,}|boring|bored|dead chat|so quiet|snooze)\b|😴|🥱/u],
  ["clown", /🤡|\bclown(?:ing|ery)?\b/u],
];

/** The first mood a line reads as, in the order above, or null. */
export function lineMood(text: string): ReactionMood | null {
  const t = norm(text);
  if (!t) return null;
  for (const [mood, re] of MOODS) if (re.test(t)) return mood;
  return null;
}
