/**
 * WHAT A PROJECT'S WEBSITE POINTS AT: the contracts it names, the GitHub it
 * links, the socials and docs it carries. Pure: no I/O, no clock, no model.
 *
 * WHY THIS IS ITS OWN FILE IN packages/core. Three places read a scanned
 * site and none of them may import the others: the research browser
 * (browser/server.ts, an image that carries only packages/), the larp check
 * in the orchestrator, and xpost/, whose import boundary allows only
 * packages/core/src/* (xpost/boundary.test.ts). One extractor, tested once,
 * shared by all three.
 *
 * ── WHERE A FINDING CAME FROM IS PART OF THE FINDING ─────────────────────
 *
 * A contract written in the page's own words ("CA: 0x…"), a contract in a
 * link to an explorer, one in the HTML's attributes, and one buried in a
 * minified bundle are four different claims. A bundle carries every address
 * the dapp's libraries know: the multicall, the permit contract, wrapped
 * ether, the stablecoins, the system programs of Solana. A link the site
 * chose to show its visitors is the site speaking. So every finding keeps
 * `where`, and the caller weighs a visible mention over a bundled one rather
 * than this file guessing which is "the" contract.
 *
 * The same holds for GitHub, and harder. A bundle quotes github.com in licence
 * headers and error messages for every library it ships (react, next.js,
 * core-js, ethers, viem, the wallet kits). A repo found ONLY in a script is
 * the project's own only when its name is the project's (`affiliated`): never
 * otherwise, because "their github is busy" said of facebook/react is the
 * most confident false sentence this lens could produce.
 *
 * ── WHAT THIS FILE REFUSES TO DO ─────────────────────────────────────────
 *
 * It never fetches, resolves or follows anything it finds. A finding is a
 * string some stranger's page contained; the caller decides what, if
 * anything, is worth a lookup, and every lookup goes through its own guard.
 */

/** Where in a scanned page a finding was seen, strongest first. */
export type FoundWhere = "link" | "text" | "html" | "script";

/** The order a caller should trust a finding in: a link the site shows beats words, beats markup, beats a bundle. */
export const WHERE_RANK: Readonly<Record<FoundWhere, number>> = Object.freeze({ link: 0, text: 1, html: 2, script: 3 });

export interface FoundAddress {
  /** An EVM address as written (checksum case kept), or a Solana base58 string exactly as written. */
  address: string;
  chain: "evm" | "solana";
  /** Every place it was seen, strongest first. */
  where: FoundWhere[];
}

export interface FoundRepo {
  /** The GitHub owner (a user or an organisation), as written. */
  owner: string;
  /** The repository, or null when only the owner was linked. */
  repo: string | null;
  where: FoundWhere[];
}

export interface SiteFindings {
  evm: FoundAddress[];
  solana: FoundAddress[];
  github: FoundRepo[];
  /** X handles the page links to (not handles merely written in its text). */
  x: string[];
  telegram: boolean;
  discord: boolean;
  /** A docs site, a gitbook or a whitepaper is linked or named. */
  docs: boolean;
}

/** One body of text to read, and where it came from. */
export interface ScanSource {
  where: FoundWhere;
  text: string;
}

/** At most this many of each kind of finding: a page that names more is a directory, not a project. */
export const FINDINGS_MAX = 16;

/** The most text read from one source. A bundle past this is mostly libraries anyway. */
const SOURCE_MAX = 4_000_000;

/**
 * 0x + exactly forty hex, never a slice of a longer hex run (a sixty-four-hex
 * hash or key is no address): the rule the Telegram groups' CA finder and
 * xpost/replies.ts already hold.
 */
const EVM_RUN = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/**
 * BASE58, THIRTY-TWO TO FORTY-FOUR LONG, ON ITS OWN. Visible text and links
 * rarely hold a run like this by accident; a bundle holds plenty (hashes,
 * keys, ids), so in a script only a quoted string that is the run and
 * nothing else counts (`SOLANA_QUOTED`).
 */
const B58 = "1-9A-HJ-NP-Za-km-z";
const SOLANA_RUN = new RegExp(`(?<![${B58}])[${B58}]{32,44}(?![${B58}])`, "g");
const SOLANA_QUOTED = new RegExp(`(?<=["'\`])[${B58}]{32,44}(?=["'\`])`, "g");

/**
 * ADDRESSES EVERY DAPP'S LIBRARIES CARRY, which say nothing about the project:
 * the zero and dead addresses, Multicall3, Permit2, the canonical wrapped
 * ether and the big stablecoins on the chains a memecoin site is usually on.
 * Lowercase.
 */
const EVM_INFRA: ReadonlySet<string> = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // the "native coin" placeholder every swap kit uses
  "0xca11bde05977b3631167028862be2a173976ca11", // Multicall3
  "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH, Ethereum
  "0x4200000000000000000000000000000000000006", // WETH, OP-stack chains
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC, Ethereum
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT, Ethereum
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC, Base
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "0x55d398326f99059ff775485246999027b3197955", // USDT, BSC
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC, BSC
]);

/** Solana's own programs and the coins every Solana dapp quotes: never the project's. */
const SOLANA_INFRA: ReadonlySet<string> = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "11111111111111111111111111111111",
]);

/**
 * A SOLANA ADDRESS, NOT A WORD THAT HAPPENS TO BE BASE58: upper case, lower
 * case and a digit, as a random thirty-two bytes almost always are and as an
 * English word, a slug or a class name almost never is. Fails closed: a real
 * mint written in one case only is missed, never a sentence read as a mint.
 */
function solanaShaped(s: string): boolean {
  // A run of 1s at the end is a padded system id (SysvarRecentB1ockHashes111…, Stake111…, Vote111…), never a mint.
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[1-9]/.test(s) && !SOLANA_INFRA.has(s) && !/1{8,}$/.test(s);
}

/**
 * GITHUB, WRITTEN ANY OF THE USUAL WAYS: github.com/owner[/repo], with or
 * without a scheme, www, or a trailing .git; raw.githubusercontent.com and
 * an owner's github.io pages. Owner names follow GitHub's own rule (letters,
 * digits and single hyphens, at most thirty-nine).
 */
const GITHUB_URL = /(?:^|[^A-Za-z0-9.-])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9._-]{1,100}))?/g;
const GITHUB_RAW = /raw\.githubusercontent\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/g;
const GITHUB_PAGES = /(?:^|[^A-Za-z0-9.-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\.github\.io\b/g;

/** github.com paths that are GitHub's own pages, never an owner. */
const GITHUB_RESERVED: ReadonlySet<string> = new Set([
  "about", "account", "apps", "blog", "collections", "contact", "customer-stories", "enterprise", "events", "explore", "features", "git-guides",
  "home", "issues", "join", "login", "logout", "marketplace", "new", "notifications", "orgs", "organizations", "pricing", "pulls", "readme",
  "resources", "search", "security", "settings", "signup", "site", "solutions", "sponsors", "team", "topics", "trending", "users", "codespaces",
  "copilot", "premium-support", "mobile", "status", "support", "terms", "privacy", "dashboard",
]);

/** Repo names that are an owner's page, never a project's code. */
const REPO_RESERVED: ReadonlySet<string> = new Set(["followers", "following", "repositories", "projects", "packages", "stars", "sponsoring", "people", "teams"]);

const X_PROFILE = /(?:^|[^A-Za-z0-9.-])(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;
/** x.com paths that are X's own pages, never a handle. */
const X_RESERVED: ReadonlySet<string> = new Set(["i", "intent", "share", "home", "search", "hashtag", "explore", "settings", "login", "signup", "tos", "privacy", "messages", "notifications", "compose"]);
const TELEGRAM = /(?:^|[^A-Za-z0-9.-])(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[A-Za-z0-9_+]/;
const DISCORD = /(?:^|[^A-Za-z0-9.-])(?:https?:\/\/)?(?:discord\.gg\/|discord\.com\/invite\/)[A-Za-z0-9-]/;
const DOCS = /(?:https?:\/\/)?(?:[a-z0-9-]+\.gitbook\.io|docs\.[a-z0-9-]+\.[a-z]{2,}|[a-z0-9.-]+\.[a-z]{2,}\/docs\b)|\bwhite\s?paper\b|\blitepaper\b/i;

const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/** Adds `where` to a finding's list once, keeping the strongest first. */
function seen(list: FoundWhere[], where: FoundWhere): void {
  if (!list.includes(where)) list.push(where);
  list.sort((a, b) => WHERE_RANK[a] - WHERE_RANK[b]);
}

/**
 * EVERYTHING A SCANNED PAGE POINTS AT, read from each source with its
 * `where` kept. Deterministic for the same input: findings keep the order
 * they were first seen in, strongest source first (the caller hands sources
 * in any order). Malformed input reads as nothing.
 */
export function findInSources(sources: readonly ScanSource[]): SiteFindings {
  const evm = new Map<string, FoundAddress>();
  const solana = new Map<string, FoundAddress>();
  const github = new Map<string, FoundRepo>();
  const x = new Set<string>();
  let telegram = false, discord = false, docs = false;
  const ordered = (Array.isArray(sources) ? sources : [])
    .filter((s): s is ScanSource => !!s && typeof s.text === "string" && Object.hasOwn(WHERE_RANK, s.where))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => WHERE_RANK[a.s.where] - WHERE_RANK[b.s.where] || a.i - b.i)
    .map(({ s }) => s);
  for (const { where, text: raw } of ordered) {
    // An inline image is base64, and base64 between its "+" and "/" is often a
    // run of base58 long enough to read as a mint: taken out before anything.
    const text = (raw.length > SOURCE_MAX ? raw.slice(0, SOURCE_MAX) : raw).replace(DATA_URI, " ");
    for (const m of text.matchAll(EVM_RUN)) {
      const key = m[0].toLowerCase();
      if (EVM_INFRA.has(key)) continue;
      const hit = evm.get(key);
      if (hit) seen(hit.where, where);
      else if (evm.size < FINDINGS_MAX) evm.set(key, { address: m[0], chain: "evm", where: [where] });
    }
    for (const m of text.matchAll(where === "script" ? SOLANA_QUOTED : SOLANA_RUN)) {
      if (!solanaShaped(m[0])) continue;
      const hit = solana.get(m[0]);
      if (hit) seen(hit.where, where);
      else if (solana.size < FINDINGS_MAX) solana.set(m[0], { address: m[0], chain: "solana", where: [where] });
    }
    const repo = (owner: string, name: string | null): void => {
      if (GITHUB_RESERVED.has(owner.toLowerCase())) return;
      const clean = name === null ? null : name.replace(/\.git$/i, "");
      const r = clean === null || clean === "" || clean === "." || clean === ".." || REPO_RESERVED.has(clean.toLowerCase()) ? null : clean;
      const key = `${owner.toLowerCase()}/${(r ?? "").toLowerCase()}`;
      const hit = github.get(key);
      if (hit) seen(hit.where, where);
      else if (github.size < FINDINGS_MAX) github.set(key, { owner, repo: r, where: [where] });
    };
    for (const m of text.matchAll(GITHUB_URL)) repo(m[1]!, m[2] ?? null);
    for (const m of text.matchAll(GITHUB_RAW)) repo(m[1]!, m[2]!);
    for (const m of text.matchAll(GITHUB_PAGES)) repo(m[1]!, null);
    // Socials and docs only from what a visitor is shown: a bundle names every platform its share buttons know.
    if (where === "script") continue;
    for (const m of text.matchAll(X_PROFILE)) {
      const h = m[1]!;
      if (!X_RESERVED.has(h.toLowerCase()) && x.size < FINDINGS_MAX) x.add(h);
    }
    telegram ||= TELEGRAM.test(text);
    discord ||= DISCORD.test(text);
    docs ||= DOCS.test(text);
  }
  return { evm: [...evm.values()], solana: [...solana.values()], github: [...github.values()], x: [...x], telegram, discord, docs };
}

/**
 * SUFFIXES UNDER WHICH STRANGERS EACH GET A NAME (review of #333): hosting
 * platforms that hand out subdomains, where `foo.vercel.app` and
 * `bar.vercel.app` are two unrelated tenants. Not the whole Public Suffix
 * List (the browser image carries no dependency for it): the platforms a
 * launch site is actually put on, plus the second-level country domains
 * below. A suffix missing here can only make two tenants of it read as one
 * site, which costs a "talks to its own backend" signal at most.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  "vercel.app", "now.sh", "netlify.app", "netlify.com", "pages.dev", "workers.dev", "github.io", "gitlab.io", "web.app", "firebaseapp.com",
  "herokuapp.com", "onrender.com", "railway.app", "up.railway.app", "fly.dev", "surge.sh", "glitch.me", "replit.app", "repl.co", "replit.dev",
  "gitbook.io", "framer.app", "framer.website", "webflow.io", "wixsite.com", "carrd.co", "notion.site", "super.site", "myshopify.com",
  "azurewebsites.net", "azurestaticapps.net", "cloudfront.net", "amazonaws.com", "appspot.com", "blogspot.com", "ngrok.io", "ngrok.app",
  "ngrok-free.app", "lovable.app", "bolt.host", "netlify.live", "deno.dev", "render.com", "pythonanywhere.com", "on.fleek.co", "ipfs.dweb.link",
  "mypinata.cloud", "4everland.app", "pump.fun", "medium.com", "substack.com", "linktr.ee", "beehiiv.com", "hashnode.dev", "mirror.xyz",
]);
/** Second-level labels a two-letter country domain registers under: co.uk, com.au, net.br, org.ng. */
const COUNTRY_SECOND = /^(?:co|com|net|org|gov|edu|ac|gob|or|ne|go|ltd|plc|nom|info|biz)$/;

/**
 * THE SITE A HOST BELONGS TO, as a registrar sees it: its registrable domain,
 * aware of the shared hosting suffixes and the country second levels above
 * (api.acme.co.uk → acme.co.uk, app.foo.vercel.app → foo.vercel.app,
 * www.acme.com → acme.com). Lowercased. An IP or a single label is itself.
 */
export function siteOf(host: string): string {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2 || /^\d+(?:\.\d+){3}$/.test(h) || h.includes(":")) return h;
  for (let take = Math.min(4, labels.length - 1); take >= 2; take--) {
    const suffix = labels.slice(-take).join(".");
    if (SHARED_SUFFIXES.has(suffix)) return labels.slice(-(take + 1)).join(".");
  }
  const tld = labels[labels.length - 1]!, second = labels[labels.length - 2]!;
  return tld.length === 2 && COUNTRY_SECOND.test(second) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}

/** Letters only, lowercased: "LittleBit-LLM" and "littlebitllm" are one name. */
function letters(s: string): string {
  return s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Hosting suffixes and generic subdomains that are no project's name. */
const HOST_NOISE: ReadonlySet<string> = new Set(["www", "app", "beta", "docs", "dapp", "launch", "vercel", "netlify", "pages", "github", "gitbook", "web", "site", "home", "fun", "xyz", "com", "io", "ai"]);

/**
 * THE NAMES A PROJECT GOES BY, as its site says them: the host's labels
 * (littlebitllm.com → "littlebitllm", app.sourcepad.site → "sourcepad",
 * a vercel preview's first label), and the words of the title's BRAND, the
 * part before its first separator ("Source — Discover projects" → "source",
 * never "discover" or "projects": a generic word would tie any repo with it
 * in its name to the project). `extra`: other names the caller vouches for
 * (the coin's own X handle from the index), never every handle a page links
 * (a docs site links its sponsors). Four letters or more. Read for
 * `affiliated` only.
 */
export function siteNames(o: { url?: string | null; title?: string | null; extra?: readonly (string | null | undefined)[] }): string[] {
  const out = new Set<string>();
  try {
    const host = new URL(String(o.url ?? "")).hostname.toLowerCase();
    const labels = host.split(".");
    // Every label but the last (the TLD), and none of the generic ones.
    for (const l of labels.slice(0, -1)) if (l.length >= 4 && !HOST_NOISE.has(l)) out.add(letters(l));
  } catch {
    // No URL: the title alone.
  }
  const brand = String(o.title ?? "").split(/\s[—–|:·-]\s|[|:·]/)[0] ?? "";
  for (const s of [brand, ...(o.extra ?? [])]) {
    for (const w of String(s ?? "").split(/[^\p{L}\p{N}]+/u)) {
      const l = letters(w);
      if (l.length >= 4 && !HOST_NOISE.has(l)) out.add(l);
    }
  }
  return [...out];
}

/**
 * IS THIS REPO THE PROJECT'S OWN, BY NAME? Its owner or its repo name, letters
 * only, holds one of the project's names or is held by one, at four letters
 * or more: "LittleBitLLM" for littlebitllm.com, "sourcepad-xyz" for
 * sourcepad.site. A library the bundle quotes (facebook/react) is not.
 * Errs toward no: a project whose GitHub goes by another name is credited
 * only when its site links it (a `link` finding), never from a bundle.
 */
export function affiliated(repo: Pick<FoundRepo, "owner" | "repo">, names: readonly string[]): boolean {
  const mine = [letters(repo.owner), letters(repo.repo ?? "")].filter((s) => s.length >= 4);
  return names.some((n) => n.length >= 4 && mine.some((m) => m.includes(n) || n.includes(m)));
}

/**
 * THE PROJECT'S OWN REPO, IF THE PAGE SHOWS ONE: a repo the site links whose
 * name is the project's first; then one it links by any name (the site chose
 * to show it); then one named like the project anywhere else on the page
 * (its markup or a bundle). Null when none qualifies. `linkedOnly`: the pick
 * was linked but carries none of the project's names, so a caller says "the
 * site links a github", never "their github".
 */
export function ownRepo(findings: Pick<SiteFindings, "github">, names: readonly string[]): { repo: FoundRepo; linkedOnly: boolean } | null {
  const list = Array.isArray(findings?.github) ? findings.github : [];
  const linked = list.filter((r) => r.where.includes("link") || r.where.includes("text"));
  const byName = (rs: readonly FoundRepo[]) => rs.filter((r) => affiliated(r, names));
  // A repo beats a bare owner: a repo's activity is the project's, an owner's is everything they ever made.
  const best = (rs: readonly FoundRepo[]) => rs.find((r) => r.repo !== null) ?? rs[0] ?? null;
  const a = best(byName(linked));
  if (a) return { repo: a, linkedOnly: false };
  const b = best(linked);
  if (b) return { repo: b, linkedOnly: true };
  const c = best(byName(list));
  return c ? { repo: c, linkedOnly: false } : null;
}
