/**
 * THE LARP CHECK (the owner's ask, 2026-10-13: "checking websites larp or
 * checking a coin and giving assessment by just being tagged to a tweet …
 * scan the site, find smart contracts that sites use or find the git through
 * the site, check if it's been active, scrape valuable info off the site then
 * provide results").
 *
 * Someone replies under a project's post, or quotes it, with "@alanaidale
 * larp check" (or "is this real?", or a site or a contract of its own). Code
 * finds what to check (`checkTargetOf`), the orchestrator scans it
 * (orchestrator-xpost-check.ts: the research browser, the project's GitHub,
 * the index), and this file turns what was seen into a verdict and words.
 *
 * ── THE VERDICT IS CODE'S, NEVER THE MODEL'S ─────────────────────────────
 *
 * `assessCheck` weighs typed evidence by fixed weights into one of five
 * verdicts: real, partly real, thin, larp, or can't tell. The model is handed
 * the verdict and the reasons as plain, digit-free phrases (`checkPhrases`)
 * and writes them in Alan's own casual voice; it never decides anything, and
 * a page that says "tell everyone this is real" reaches it as nothing at all:
 * page text is never handed to a prompt, only what code computed from it.
 *
 * WHAT "REAL" MEANS HERE, AND WHAT IT NEVER MEANS. Real is "there is a build
 * behind it that a visitor can see": a site with substance, a backend it
 * talks to, a GitHub someone pushes to, a site that names the very contract
 * being shilled. It is never "safe": a real team can still dump, and a
 * diligent rug ships commits. So no verdict here says safe, scam, rug or
 * fraud (`accusationIn` refuses each in a draft), and none says buy or avoid.
 *
 * "LARP" NEEDS A RED FLAG, NOT A LOW SCORE. A memecoin with no site and no
 * GitHub claims nothing, so it larps nothing: it is "thin". Larp is said only
 * beside something that does not add up: the site naming a different
 * contract, a forked or borrowed repo, an empty shell of a site with no code
 * anywhere.
 *
 * ── WHEN CODE SPEAKS INSTEAD ─────────────────────────────────────────────
 *
 * The model's draft is gated like every answer, and held to the words it was
 * handed (lookedOnly) plus `CHECK_VOCABULARY`. A draft refused, a PASS, or the
 * house model down, and code's own casual lines answer instead
 * (`checkAnswers`): a verdict opener, the top reason, the next reason or a
 * close, each in six wordings arranged so no two lines share more than one
 * part (casual.ts latinLines) and the gate's repeat limit never silences a
 * second check of a similar site.
 *
 * Pure: no I/O, no model, no clock.
 */
import type { XReply } from "./client";
import { CASUAL_PAPER, latinLines } from "./casual";
import type { CodeLineOptions } from "./replies";
import type { FiguresSpec } from "./figures";
import { safeFetchUrl } from "../../../packages/core/src/safe-url";
import { findInSources } from "../../../packages/core/src/site-scan";

// ── what to check ───────────────────────────────────────────────────────────

/** A site, or a coin by contract (and the site to read for it, when the post gave one). */
export type CheckTarget =
  | { kind: "site"; url: string }
  | { kind: "coin"; address: string; chain: "evm" | "solana"; site: string | null };

/** Where the target was found: the tag's own words or links, the post it replies to or quotes, or that post's author's profile link. */
export type CheckFrom = "tag" | "parent" | "quote" | "profile";

/**
 * "LARP CHECK", ASKED ANY OF THE PLAIN WAYS: the whole tag, once the leading
 * handles, the links, the contract, a couple of friendly words and one emoji
 * are off, is one of these. Never a sentence with a claim beside it ("larp
 * check, the dev is my friend"): a whole-tag allowlist, as every answer kind
 * on this account is.
 */
const ASK_LEAD = String.raw`(?:(?:yo|hey|hi|ok|okay|alan|pls|plz|please|ser|sir|bro|fren|gm|quick|can\s+you|could\s+you|mind\s+to)[\s,]+){0,3}`;
const ASK_CORE = [
  String.raw`larp\s*check(?:\s+(?:this|it|this\s+one|that|them|pls|please))?`,
  String.raw`(?:check|scan|verify|audit|look\s+at|look\s+into)(?:\s+(?:this|it|this\s+one|that|them|this\s+project|this\s+coin|this\s+token|this\s+site|the\s+site|their\s+site))?(?:\s+out)?(?:\s+for\s+(?:me|us))?`,
  String.raw`(?:is|are)\s+(?:this|it|that|they|this\s+project|this\s+coin|this\s+token|this\s+site|this\s+one)\s+(?:real|larp(?:ing)?|a\s+larp|legit|for\s+real|fake|a\s+real\s+project)`,
  String.raw`real\s+or\s+(?:larp|not|fake)|larp\s+or\s+(?:real|not|legit)|legit\s+or\s+larp`,
  String.raw`(?:larp|real|legit|fake)`,
  String.raw`dyor(?:\s+(?:this|it|this\s+one))?`,
  String.raw`what\s+(?:is|are)\s+(?:this|that|they)(?:\s+(?:project|coin|token|site))?`,
  String.raw`(?:any\s+)?thoughts\s+on\s+(?:this|it|that|this\s+project|this\s+coin|this\s+token|this\s+site)`,
  String.raw`(?:is\s+there\s+)?anything\s+(?:real\s+)?behind\s+(?:this|it|that)`,
];
const ASK_TAIL = String.raw`(?:[\s,]+(?:pls|plz|please|alan|ser|sir|bro|fren|for\s+me|for\s+us|real\s+quick|quick|asap))?`;
const CHECK_ASK = new RegExp(String.raw`^${ASK_LEAD}(?:${ASK_CORE.join("|")})${ASK_TAIL}[\s?!.…]*$`, "i");

const LEADING_HANDLES = /^(?:\s*@[a-z0-9_]{1,15}\b[\s,:-]*)+/i;
const URL_RUN = /\bhttps?:\/\/\S+/gi;
const EVM_RUN = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const B58_RUN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const ONE_EMOJI = /\p{Extended_Pictographic}️?/gu;

/** The ask as the allowlist reads it: leading handles, its own handle anywhere, links, contracts, a "ca:" label and emoji off; curly quotes plain. */
export function checkAskText(raw: unknown, own = ""): string {
  if (typeof raw !== "string") return "";
  const me = String(own ?? "").trim().replace(/^@/, "");
  const mine = /^[a-z0-9_]{1,15}$/i.test(me) ? new RegExp(`@${me}\\b`, "gi") : null;
  return raw.normalize("NFKC").replace(/[’‘]/g, "'").replace(LEADING_HANDLES, "").replace(mine ?? /(?!)/g, " ")
    .replace(URL_RUN, " ").replace(EVM_RUN, " ").replace(B58_RUN, " ").replace(/\bca\s*[:=]?\s*(?=\s|$)/gi, " ")
    .replace(ONE_EMOJI, " ").replace(/\s+/g, " ").trim();
}

/** Is this tag a larp check, asked any of the plain ways? Never with anyone's handle left in it but its own (`own`). */
export function checkAsk(raw: unknown, own = ""): boolean {
  const t = checkAskText(raw, own);
  return t !== "" && t.length <= 60 && !t.includes("@") && CHECK_ASK.test(t);
}

/**
 * LINKS THAT ARE NO PROJECT'S SITE: X itself, the chat apps, the big
 * platforms, the charting and swap sites. A post's link to its own status, a
 * Telegram invite or a chart is not what a larp check reads.
 */
const NOT_A_SITE = /(?:^|\.)(?:x\.com|twitter\.com|t\.co|t\.me|telegram\.me|telegram\.org|discord\.gg|discord\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.com|linkedin\.com|reddit\.com|linktr\.ee|medium\.com|substack\.com|google\.com|apple\.com|dexscreener\.com|geckoterminal\.com|coingecko\.com|coinmarketcap\.com|dextools\.io|birdeye\.so|solscan\.io|etherscan\.io|basescan\.org|bscscan\.com|blockscout\.com|gmgn\.ai|pump\.fun|axiom\.trade|bullx\.io|photon-sol\.tinyastro\.io|jup\.ag|raydium\.io|uniswap\.org|app\.uniswap\.org|opensea\.io|giphy\.com|imgur\.com|tenor\.com|merrymen\.dev|merrymen\.app)$/i;

/** A link that names a coin by its contract: a launchpad's or an explorer's page for one token. */
const COIN_LINK: readonly { re: RegExp; chain: "evm" | "solana" }[] = [
  { re: /^https?:\/\/(?:www\.)?pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/i, chain: "solana" },
  { re: /^https?:\/\/(?:www\.)?(?:solscan\.io|birdeye\.so)\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/i, chain: "solana" },
  { re: /^https?:\/\/(?:www\.)?gmgn\.ai\/sol\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/i, chain: "solana" },
  { re: /^https?:\/\/(?:www\.)?(?:etherscan\.io|basescan\.org|bscscan\.com|[a-z0-9-]+\.blockscout\.com)\/(?:token|address)\/(0x[0-9a-fA-F]{40})(?:[/?#]|$)/i, chain: "evm" },
];

function coinOfLink(url: string): { address: string; chain: "evm" | "solana" } | null {
  for (const { re, chain } of COIN_LINK) {
    const m = re.exec(url);
    if (m) return { address: m[1]!, chain };
  }
  return null;
}

/**
 * A SITE WORTH SCANNING, OR NONE: https only (the research browser refuses
 * anything else), on a public host, not one of the platforms above, not a
 * merrymen page (the house never larp-checks itself). The fragment is off.
 */
export function siteLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = safeFetchUrl(raw);
  if (!u || NOT_A_SITE.test(u.hostname) || /merrymen/i.test(u.hostname)) return null;
  u.hash = "";
  return u.toString();
}

/** The distinct contracts written in a post's words: EVM by forty hex, Solana by the site scanner's own rules. */
function addressesIn(text: string): { address: string; chain: "evm" | "solana" }[] {
  const f = findInSources([{ where: "text", text: String(text ?? "") }]);
  return [...f.evm, ...f.solana].map((a) => ({ address: a.address, chain: a.chain }));
}

/** One post's own target: one contract (with its one site, if any), else one site. Two contracts, or nothing: none. */
function targetIn(text: string, links: readonly string[]): CheckTarget | null {
  const coins = [...addressesIn(text), ...links.map(coinOfLink).filter((c): c is NonNullable<typeof c> => c !== null)];
  const distinct = coins.filter((c, i) => coins.findIndex((d) => (d.chain === "evm" ? d.address.toLowerCase() === c.address.toLowerCase() : d.address === c.address)) === i);
  const sites = [...new Set(links.map(siteLink).filter((s): s is string => s !== null).map((s) => s))];
  // Two sites on different hosts: the first, as the post put it first; two contracts: no telling which is meant.
  if (distinct.length > 1) return null;
  if (distinct.length === 1) return { kind: "coin", address: distinct[0]!.address, chain: distinct[0]!.chain, site: sites[0] ?? null };
  return sites.length ? { kind: "site", url: sites[0]! } : null;
}

/**
 * WHAT A TAG ASKS TO CHECK, AND WHERE THAT CAME FROM. The tag's own contract
 * or link first; then the post it replies to; then the post it quotes; then
 * the profile link of whoever wrote the post it sits under. Never one of its
 * own posts (`ownPosts`, or a post by `ownId`): a tag under its own buy post
 * would have it larp-check the coin it just bought. Null when nothing in reach
 * is one clear target.
 */
export function checkTargetOf(reply: XReply, o: { ownId?: string; ownPosts?: ReadonlySet<string> } = {}): { target: CheckTarget; from: CheckFrom } | null {
  if (!reply || typeof reply.text !== "string") return null;
  const tagCoins = addressesIn(reply.text);
  const tagLinks = Array.isArray(reply.links) ? reply.links : [];
  if (tagCoins.length > 1) return null;
  const own = targetIn(reply.text, tagLinks);
  const contexts = (Array.isArray(reply.context) ? reply.context : [])
    .filter((c) => c && typeof c.text === "string" && o.ownPosts?.has(c.id) !== true && (o.ownId === undefined || c.authorId !== o.ownId));
  if (own) {
    // A contract in the tag, with no site of its own: the site of the post it sits under, if that post names the same contract.
    if (own.kind === "coin" && own.site === null) {
      const same = contexts.map((c) => targetIn(c.text, c.links)).find((t) => t?.kind === "coin" && t.site !== null
        && (t.chain === "evm" ? t.address.toLowerCase() === own.address.toLowerCase() : t.address === own.address));
      if (same && same.kind === "coin") return { target: { ...own, site: same.site }, from: "tag" };
    }
    return { target: own, from: "tag" };
  }
  for (const c of contexts) {
    const t = targetIn(c.text, c.links);
    if (t) return { target: t, from: c.relation === "quoted" ? "quote" : "parent" };
  }
  for (const c of contexts) {
    const profile = siteLink(c.author?.url);
    if (profile) return { target: { kind: "site", url: profile }, from: "profile" };
  }
  return null;
}

// ── what was seen ───────────────────────────────────────────────────────────

/**
 * EVERYTHING A CHECK SAW, as typed measurements (orchestrator-xpost-check.ts
 * builds it). Null where a part was not read; nothing here is page text.
 */
export interface CheckEvidence {
  target: CheckTarget;
  /** The site scanned (the target's, or the coin's listed one). Null when there was none to scan. */
  site: null | {
    url: string;
    /** "ok": read; "unreachable": the page did not answer; "busy" or "none": the browser was busy or is not configured. */
    read: "ok" | "unreachable" | "busy" | "none";
    /** Characters of visible words on the page. */
    textChars: number;
    /** Calls the page made to its own site while it settled, or null unread. */
    ownCalls: number | null;
    docs: boolean;
    /** For a coin: does the site name this contract ("yes"), only others ("other"), none at all ("none")? Null for a site check. */
    namesCoin: "yes" | "other" | "none" | null;
  };
  /** A coin with no site anywhere: the index lists none and the post gave none. */
  noSite?: true;
  github: null | {
    /** "repo": a repo read; "none": the site was read and links no GitHub; "unread": one was found but GitHub did not answer. */
    found: "repo" | "none" | "unread";
    /** The site links this repo, but it carries none of the project's names: someone else's code (a paper, a library). */
    linkedOnly: boolean;
    pushedDaysAgo: number | null;
    createdDaysAgo: number | null;
    commits30d: number | null;
    commitsPartial: boolean;
    stars: number | null;
    fork: boolean;
    archived: boolean;
    sizeKb: number | null;
  };
  /** The coin on the index, when there is one (the target coin, or the one contract a site shows). */
  token: null | {
    liquidityUsd: number | null;
    top10Pct: number | null;
    creatorPct: number | null;
    poolAgeDays: number | null;
  };
}

export type CheckVerdict = "real" | "partly" | "thin" | "larp" | "unclear";

export type CheckSignal =
  | "names-other" | "names-coin" | "names-none"
  | "site-app" | "site-up" | "site-thin" | "site-down" | "no-site" | "docs"
  | "git-active" | "git-recent" | "git-quiet" | "git-stale" | "git-none" | "git-linked-only" | "git-fork" | "git-empty" | "git-archived" | "git-new" | "git-old" | "git-busy"
  | "holders-concentrated" | "creator-heavy" | "liq-thin" | "coin-young";

export interface CheckRead {
  verdict: CheckVerdict;
  /** What decided it, most telling first for the verdict's direction. */
  signals: CheckSignal[];
  /** The weighed score, 0 for "unclear": for the pass's notes and the tests, never for a post. */
  score: number;
}

/** Signals that something does not add up: "larp" is said only beside one of these. */
const RED_FLAGS: ReadonlySet<CheckSignal> = new Set(["names-other", "git-fork", "git-linked-only", "git-empty"]);

/**
 * THE VERDICT, BY FIXED WEIGHTS. From fifty: the site's substance, a backend
 * it calls and its docs; whether it names the coin (the strongest single
 * signal either way: a site that names a different contract than the one
 * being shilled is the classic larp); the GitHub's last push, its commits,
 * whether it is forked, archived or empty, its age; and, lightly, how the
 * coin's supply sits. Seventy-five or more: real. Fifty-five: partly real.
 * Below that: thin, or larp when a red flag stands beside a low score. And
 * when nothing was actually seen (no site read, no repo read, and no
 * established absence of a site), can't tell.
 */
export function assessCheck(e: CheckEvidence): CheckRead {
  const w: { signal: CheckSignal; weight: number }[] = [];
  const add = (signal: CheckSignal, weight: number) => w.push({ signal, weight });
  const site = e?.site ?? null;
  const siteRead = site?.read === "ok";
  if (e?.noSite === true) add("no-site", -12);
  if (site) {
    if (site.read === "ok") {
      add(site.textChars >= 600 ? "site-up" : "site-thin", site.textChars >= 600 ? 10 : -8);
      if ((site.ownCalls ?? 0) >= 2) add("site-app", 10);
      if (site.docs) add("docs", 4);
      if (site.namesCoin === "yes") add("names-coin", 15);
      else if (site.namesCoin === "other") add("names-other", -25);
      else if (site.namesCoin === "none") add("names-none", -6);
    } else if (site.read === "unreachable") add("site-down", -10);
  }
  const g = e?.github ?? null;
  if (g?.found === "repo" && g.linkedOnly) add("git-linked-only", -6);
  else if (g?.found === "repo") {
    const p = g.pushedDaysAgo;
    if (p !== null) {
      if (p <= 7) add("git-active", 20);
      else if (p <= 30) add("git-recent", 12);
      else if (p <= 90) add("git-quiet", -2);
      else add("git-stale", -12);
    }
    if ((g.commits30d ?? 0) >= 20) add("git-busy", 5);
    if (g.fork) add("git-fork", -15);
    if (g.archived) add("git-archived", -10);
    if (g.sizeKb !== null && g.sizeKb < 50) add("git-empty", -10);
    if (g.createdDaysAgo !== null && g.createdDaysAgo <= 14) add("git-new", -4);
    else if (g.createdDaysAgo !== null && g.createdDaysAgo >= 365) add("git-old", 6);
  } else if (g?.found === "none" && siteRead) add("git-none", -10);
  const t = e?.token ?? null;
  if (t) {
    if (t.top10Pct !== null && t.top10Pct >= 70) add("holders-concentrated", -3);
    if (t.creatorPct !== null && t.creatorPct >= 20) add("creator-heavy", -3);
    if (t.liquidityUsd !== null && t.liquidityUsd < 10_000) add("liq-thin", 0);
    if (t.poolAgeDays !== null && t.poolAgeDays <= 2) add("coin-young", 0);
  }
  const score = 50 + w.reduce((n, x) => n + x.weight, 0);
  const saw = siteRead || e?.noSite === true || g?.found === "repo";
  const flagged = w.some((x) => RED_FLAGS.has(x.signal)) || (w.some((x) => x.signal === "site-thin") && w.some((x) => x.signal === "git-none"));
  // A COIN SHILLED WITH A SITE THAT NAMES ANOTHER CONTRACT IS A LARP, however
  // good the site (live run, 2026-10-13): $BIT's contract beside larpcheck.app
  // scored "thin", the site's own app and words credited to a coin that is
  // not on it. Everything the site shows is the site's; the coin only
  // borrows it.
  const borrowed = w.some((x) => x.signal === "names-other");
  const verdict: CheckVerdict = !saw ? "unclear" : borrowed ? "larp" : score >= 75 ? "real" : score >= 55 ? "partly" : score < 35 && flagged ? "larp" : "thin";
  // For a good verdict the good news leads; for a bad one the bad news does. Colour (no weight) last.
  const up = verdict === "real" || verdict === "partly";
  const ordered = [...w].sort((a, b) => {
    const ka = a.weight === 0 ? 2 : (a.weight > 0) === up ? 0 : 1, kb = b.weight === 0 ? 2 : (b.weight > 0) === up ? 0 : 1;
    return ka - kb || Math.abs(b.weight) - Math.abs(a.weight);
  });
  return { verdict, signals: ordered.map((x) => x.signal), score: verdict === "unclear" ? 0 : score };
}

// ── words ───────────────────────────────────────────────────────────────────

/**
 * EACH SIGNAL IN SIX WORDINGS, the first the plainest (the one the model is
 * handed). Every wording names its subject (the site, the repo, the
 * contract), never a figure, a source's brand, an address or a link, and
 * clears the X gate's vocabulary (no "wallets", "apis", "offline", "broken",
 * "legit", "official", "pump"): xpost/check.test.ts reads every line through
 * the real gate. Pinned by the test: six each.
 */
const SAID: Readonly<Record<CheckSignal, readonly string[]>> = Object.freeze({
  "names-other": ["the site points at a different contract", "the contract on their page isn't this one", "their site lists some other token address",
    "wrong contract on the site", "the page names another contract entirely", "site and coin don't match up"],
  "names-coin": ["the site lists this exact contract", "the contract on the page matches", "their page names this very token",
    "site and contract line up", "the token on their site is this one", "the page carries the same contract"],
  "names-none": ["the site never mentions a contract", "no contract anywhere on their page", "the page doesn't name any token",
    "their page skips the contract entirely", "the site stays silent on the token", "nothing on the page ties it to a contract"],
  "site-app": ["the site actually talks to its own backend", "their app does real work under the hood", "the page calls home to a running backend",
    "there's a working app behind the page", "the site runs actual logic, not just a picture", "their frontend hits its own backend"],
  "site-up": ["their site is up with real content", "the page loads with a proper writeup", "the site is up and fleshed out",
    "a full site, not a placeholder", "the landing page has actual substance", "their site has more than a logo on it"],
  "site-thin": ["the site is basically a splash page", "their homepage is nearly blank", "just a landing screen with little on it",
    "the site is a placeholder", "barely any words on their page", "the frontend is bare bones"],
  "site-down": ["their site wouldn't load", "the page didn't come up", "their site never answered",
    "the site was unreachable", "their link goes nowhere right now", "the site never loaded"],
  "no-site": ["no website listed for it anywhere", "the coin has no site at all", "there's no homepage for this one",
    "nobody bothered making a site", "not even a website", "the token links to no site"],
  docs: ["they have docs up", "there's documentation", "docs are published",
    "a written guide exists", "they put out docs", "the project has a docs page"],
  "git-active": ["their github got pushes this week", "code landed on the repo days ago", "the repo is getting fresh commits",
    "devs pushed code very recently", "github shows work this week", "the codebase is moving right now"],
  "git-recent": ["their github saw pushes this month", "the repo got code within the last month", "some recent commits on github",
    "devs touched the code lately", "github has had activity in recent weeks", "the codebase moved not long ago"],
  "git-quiet": ["their github has gone quiet for weeks", "the repo has been idle a while", "no fresh commits in over a month",
    "github is slowing down", "devs haven't pushed in a bit", "the codebase has been sitting still"],
  "git-stale": ["their github hasn't moved in months", "the repo is stale", "the code has been untouched for ages",
    "github looks abandoned", "nobody has pushed there in months", "the codebase is gathering dust"],
  "git-none": ["no github anywhere on the site", "there's no public code to look at", "they don't link a repo",
    "no codebase in sight", "github is nowhere to be found", "nothing open source to check"],
  "git-linked-only": ["the github they link isn't theirs by name", "the linked repo belongs to someone else", "their github link points at another team's code",
    "the repo they show isn't their own", "the code they link is borrowed", "the github link goes to an outside project"],
  "git-fork": ["the repo is a fork of someone else's code", "their code is forked, not original", "github is just a copied repo",
    "the codebase is borrowed from another project", "it's a forked repo", "the repo started as somebody else's"],
  "git-empty": ["the repo is nearly empty", "barely any code in the repo", "the github is a shell",
    "the codebase is tiny", "almost nothing committed", "the repo has next to no code"],
  "git-archived": ["the repo is archived", "their github is frozen", "the codebase was shelved",
    "github marks it as archived", "the project's code is locked", "the repo got retired"],
  "git-new": ["the repo is brand new", "github only appeared recently", "the code was put up days ago",
    "the repo is freshly made", "the codebase just showed up", "github is a newcomer"],
  "git-old": ["the repo goes back over a year", "the code has a long history", "their github has been around a while",
    "the codebase predates the hype", "the repo has some age to it", "github history runs deep"],
  "git-busy": ["commits are landing steadily", "a steady stream of commits", "the commit log is busy",
    "devs commit often", "the repo is humming", "frequent commits"],
  "holders-concentrated": ["holders look concentrated", "supply sits in few hands", "the top holders have most of it",
    "distribution is top heavy", "a small group holds the bulk", "ownership is lopsided"],
  "creator-heavy": ["the creator still holds a big share", "the dev sits on a large chunk", "the creator's share is hefty",
    "the dev never let go of much supply", "a big slice is still with the creator", "the deployer kept plenty"],
  "liq-thin": ["liquidity is thin", "the pool is shallow", "not much liquidity behind it",
    "the pool runs light", "liquidity is light", "trading depth is thin"],
  "coin-young": ["the coin is only days old", "the token just launched", "it's a fresh launch",
    "the coin is brand new", "the token is newly minted", "it only just showed up"],
});

/** How each verdict opens a code line, six ways; and the plain verdict the model is handed. */
const OPENERS: Readonly<Record<CheckVerdict, readonly string[]>> = Object.freeze({
  real: ["dug through it, there's a real build here", "went through it, actual work behind this one", "scanned it and it holds up",
    "looked under the hood, real stuff here", "not a larp from what's visible", "real build here, receipts and all"],
  partly: ["partly real, partly talk", "half built so far, the rest is promises", "some substance, some fluff",
    "there's something here, just not much yet", "mixed bag after a scan", "real-ish, with gaps"],
  thin: ["pretty thin under the hood", "mostly vibes so far, light on proof", "not a lot behind it yet",
    "light on substance after a scan", "looks more like a pitch than a product", "hard to find anything solid yet"],
  larp: ["smells like a larp from here", "larp vibes all over this", "this reads like a larp",
    "no visible build behind it", "classic larp setup, story first and product later", "the receipts aren't there, larp territory"],
  unclear: ["couldn't get a clean read on this one", "no clear call, too little to go on", "can't tell yet, not enough visible",
    "the scan came back murky", "too little out in the open to judge", "inconclusive for now, the evidence is patchy"],
});
const VERDICT_SAID: Readonly<Record<CheckVerdict, string>> = Object.freeze({
  real: "the verdict: there's a real build behind it",
  partly: "the verdict: partly real, some of it is still just talk",
  thin: "the verdict: thin, mostly vibes so far",
  larp: "the verdict: it smells like a larp",
  unclear: "the verdict: no clean read, too little visible to call it",
});
/** The third part when there is no second reason: a close that claims nothing. */
const CLOSERS: readonly string[] = ["that's the read", "make of it what you will", "for what it's worth",
  "just a quick scan", "only what's visible right now", "surface level, but that's it"];

/**
 * WHAT THE MODEL IS HANDED: the verdict and up to five reasons, each a plain
 * phrase, digit-free and naming no source's brand. The answer prompt says to
 * put them in its own words and add nothing (writer.ts checkPrompt).
 */
export function checkPhrases(r: CheckRead): string[] {
  if (!r || !Object.hasOwn(VERDICT_SAID, r.verdict)) return [];
  return [VERDICT_SAID[r.verdict], ...r.signals.slice(0, 5).map((s) => SAID[s]?.[0]).filter((s): s is string => typeof s === "string")];
}

/**
 * WORDS A CHECK'S DRAFT MAY USE beside what it was handed (XGateCtx.known):
 * how people talk about digging through a project. Neutral, every one: none
 * accuses, none advises, none is a figure.
 */
export const CHECK_VOCABULARY = [
  "scanned scan scanning checked checking dug digging looked looking through under hood quick glance",
  "code coded coding devs dev team shipping shipped ships building built build builds work working works",
  "repo repos github commits commit pushed push pushes codebase open source",
  "site sites page pages website landing app frontend backend docs documentation homepage",
  "contract contracts token tokens coin coins address matches match matching different another theirs own",
  "real realness larp larping larpy thin solid sketchy fluff vibes empty busy quiet fresh active stale abandoned dusty",
  "recent recently lately week weeks month months days new old receipts nothing behind visible verdict partly mostly half",
  "loads loaded fork forked archived concentrated holders creator liquidity shallow pool tell clean read murky",
  "substance placeholder splash shell actually honestly pretty kinda lowkey ngl tbh",
].join(" ");

/**
 * CODE'S OWN LINES FOR A CHECK, this mention's own first: the verdict's
 * opener, the top reason, and the next reason or a close, in six wordings
 * each by a Latin square (casual.ts latinLines), so any two of the thirty-six
 * share at most one part. A paper agent's line says paper (the gate refuses
 * a paper reply that never does), in a fixed clause about its own book.
 */
export function checkAnswers(r: CheckRead, seed: string, o: CodeLineOptions = {}): string[] {
  if (!r || !Object.hasOwn(OPENERS, r.verdict)) return [];
  const said = r.signals.map((s) => SAID[s]).filter((x): x is readonly string[] => Array.isArray(x) && x.length === 6);
  const first = said[0] ?? CLOSERS;
  const second = said[0] ? said[1] ?? CLOSERS : CLOSERS.map((c, i) => CLOSERS[(i + 3) % 6]!);
  const paperOf = new Map(OPENERS[r.verdict].map((open, i) => [open, CASUAL_PAPER[i % CASUAL_PAPER.length]!] as const));
  return latinLines([OPENERS[r.verdict], first, second], seed, (a, b, c) =>
    `${a}. ${b}${c === b ? "" : `, ${c}`}${o.paper === true ? `. ${paperOf.get(a)!}` : ""}.`);
}

/**
 * THE FIGURES A CHECK MAY CARRY (xpost/figures.ts): the project's own repo
 * (never one the site merely links: those numbers are somebody else's), and
 * the coin's holders as the index counts them.
 */
export function checkFigures(e: CheckEvidence): FiguresSpec {
  const out: FiguresSpec[number][] = [];
  const g = e?.github;
  if (g?.found === "repo" && !g.linkedOnly && g.pushedDaysAgo !== null) {
    out.push({ kind: "git", pushedDaysAgo: g.pushedDaysAgo, commits30d: g.commits30d, commitsPartial: g.commitsPartial, stars: g.stars, repoAgeDays: g.createdDaysAgo });
  }
  if (e?.token && e.token.top10Pct !== null) out.push({ kind: "holders", top10Pct: e.token.top10Pct, creatorPct: e.token.creatorPct });
  return out;
}

/**
 * NEVER AN ACCUSATION, NEVER A SAFETY CALL, NEVER ADVICE, in a check's
 * draft: a scam, a rug, fraud, a honeypot, theft; "safe"; "avoid" or "stay
 * away". The check saw whether a build is visible, never anyone's intent, and
 * the house account calling a stranger's project a scam is a claim it cannot
 * stand behind. Read after the gate, on the text it admitted.
 */
const ACCUSATION = /\b(?:scam\w*|rug\w*|fraud\w*|honey\s?pots?|ponzi\w*|steal\w*|stole\w*|theft|thie(?:f|ves)|criminal\w*|crook\w*|exit\s+liquidity|safe(?:ty|ly)?|unsafe|avoid\w*|stay\s+away|steer\s+clear|run\s+away)\b/i;
export function accusationIn(text: unknown): boolean {
  return typeof text === "string" && ACCUSATION.test(text);
}
