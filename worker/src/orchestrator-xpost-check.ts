/**
 * THE LARP CHECK'S LEGWORK: what an active agent reads before it answers
 * "@alanaidale larp check" under a project's post (xpost/check.ts says what
 * it checks and what the reading means; this file only reads).
 *
 * WHY AN orchestrator*.ts FILE. It reaches the research browser (venues/
 * research.ts scanPage), GitHub (research/github.ts) and the index's coin
 * facts (desk/facts.ts), and hands xpost/ typed evidence. xpost/ may import
 * none of those (xpost/boundary.test.ts).
 *
 * ── WHAT IS READ, IN ORDER, INSIDE ONE BUDGET ────────────────────────────
 *
 *   1. A coin: its facts on the index, on the house chain first and then the
 *      chains a launch is usually on, with the token's info, which lists the
 *      project's own website. That is the site to scan when the post gave
 *      none, and a coin the index lists with no website at all is a finding.
 *   2. The site, through the research browser's /scan: the words, what the
 *      page points at (contracts, GitHub, docs), and how many calls it made
 *      to its own backend. For a coin, whether the site names this very
 *      contract, only others, or none.
 *   3. The project's own GitHub, if the site shows one (packages/core/src/
 *      site-scan.ts ownRepo): last push, commits in thirty days, stars, age,
 *      fork, archived, size.
 *   4. For a site, the one contract it shows a visitor, on the index: how
 *      its holders sit.
 *
 * Every read is time-boxed inside the check's own budget and never throws; a
 * read that fails is evidence that says it was not read, and assessCheck
 * says "can't tell" rather than guess. Nothing read here is handed to a
 * prompt as text: only the typed evidence, and the site's own one-line
 * description, which research screens as an unverified claim.
 *
 * ── WHAT IS NEVER DONE ───────────────────────────────────────────────────
 *
 * No wallet is connected, nothing is signed, nothing downloaded is run, no
 * form is submitted (the browser's own guards: downloads off, WebSockets and
 * WebRTC closed, every request through the public-only proxy). Nothing read
 * here reaches trading: the evidence is words for one public answer.
 */
import type { CoinFacts, CoinFactsReader, FactsNetwork } from "./coin-facts-types";
import { readGithub, type GithubRead } from "./research/github";
import { scanPage, type BrowserConfig, type PageScan, type ScanResult } from "./venues/research";
import { siteLink, type CheckEvidence, type CheckTarget } from "./xpost/check";
import { ownRepo, siteNames, WHERE_RANK } from "../../packages/core/src/site-scan";

const DAY = 86_400_000;

/**
 * THE CHECK'S OWN BUDGET: longer than an answer's twelve seconds, because a
 * real browser has to load a real page (the browser's own navigation cap is
 * fifteen seconds, and a scan waits for the one browser when discovery has
 * it). The X pass is not awaited by anything on a trading path
 * (orchestrator.ts startXPostPass), so a slow check only delays the next X pass.
 */
export const CHECK_BUDGET_MS = 50_000;
/** The scan's share: the browser's navigation, settle and bundles, and its wait for the one browser. */
const SCAN_MS = 42_000;
const GITHUB_MS = 8_000;
const FACTS_MS = 5_000;
/** A check is remembered this long: the same project asked about twice in a row is read once. */
const CACHE_MS = 30 * 60_000;
const CACHE_MAX = 200;

/** The chains a 0x contract is looked for on, the house chain first. A Solana mint is Solana's. */
const EVM_NETWORKS: readonly FactsNetwork[] = ["robinhood", "base", "ethereum", "bsc"];

export interface LarpCheckerDeps {
  /** The research browser (MERRYMEN_BROWSER_URL / _TOKEN). Null: no site is scanned, and a check says it could not see. */
  browser: BrowserConfig | null;
  /** MERRYMEN_GITHUB_TOKEN, optional. */
  githubToken?: string;
  /** The index's coin facts, on the X account's own limiter (orchestrator-xpost-research.ts passes its own). */
  coinFacts: CoinFactsReader;
  /** Injected by tests. */
  scan?: (url: string, timeoutMs: number) => Promise<ScanResult>;
  github?: (owner: string, repo: string | null, timeoutMs: number) => Promise<GithubRead>;
  now?: () => number;
}

export interface CheckRun {
  evidence: CheckEvidence;
  /** The site's own one-line description of itself (meta description, else title), raw: research screens it as a claim. */
  claim: string | null;
  /** Reads made (a scan, a GitHub read, an index read each count one). */
  lookups: number;
  /** What happened, by stable word, for the pass's counts. Never a URL, an address or page text. */
  notes: string[];
}

export interface LarpChecker {
  check(target: CheckTarget, o: { budgetMs: number; chatId: number }): Promise<CheckRun>;
}

const sameAddress = (chain: "evm" | "solana", a: string, b: string) => (chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** A github.com link is read on GitHub's API, never in the browser: the page is GitHub's, the code is theirs. */
function githubOf(url: string): { owner: string; repo: string | null } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    return owner ? { owner, repo: repo ? repo.replace(/\.git$/i, "") : null } : null;
  } catch {
    return null;
  }
}

/** The target's cache key: a contract by chain and address, a site by its URL. */
function keyOf(t: CheckTarget): string {
  return t.kind === "coin" ? `coin:${t.chain}:${t.chain === "evm" ? t.address.toLowerCase() : t.address}:${t.site ?? ""}` : `site:${t.url}`;
}

export function createLarpChecker(d: LarpCheckerDeps): LarpChecker {
  const now = d.now ?? Date.now;
  const scan = d.scan ?? ((url: string, timeoutMs: number) => scanPage(d.browser ? { ...d.browser, timeoutMs } : null, url));
  const github = d.github ?? ((owner: string, repo: string | null, timeoutMs: number) => readGithub({ owner, repo, token: d.githubToken ?? "", timeoutMs, now }));
  const cache = new Map<string, { run: CheckRun; until: number }>();

  return {
    async check(target, o) {
      const key = keyOf(target);
      const hit = cache.get(key);
      if (hit && hit.until > now()) return { ...hit.run, lookups: 0, notes: ["check-cached"] };
      const started = now();
      const budget = Math.max(0, Math.min(CHECK_BUDGET_MS, o.budgetMs));
      const left = () => budget - (now() - started);
      const notes: string[] = [];
      let lookups = 0;

      /** A coin on the index: the first chain that lists it, held to what is left. */
      const factsFor = async (address: string, chain: "evm" | "solana"): Promise<CoinFacts | null> => {
        // Not found everywhere and some chain unreadable are different notes: the second is the index's window, not the coin.
        let unread = false;
        for (const network of chain === "solana" ? (["solana"] as const) : EVM_NETWORKS) {
          if (left() < 1_000) {
            notes.push("check-late");
            return null;
          }
          lookups++;
          const r = await d.coinFacts({ network, address, chatId: o.chatId, timeoutMs: Math.min(FACTS_MS, left()), withInfo: true })
            .catch(() => ({ ok: false as const, why: "unavailable" as const }));
          if (r.ok) return r.facts;
          // Busy is our own limiter: no other chain will answer either.
          if (r.why === "busy") {
            notes.push("check-index-busy");
            return null;
          }
          if (r.why === "unavailable") unread = true;
        }
        notes.push(unread ? "check-index-unavailable" : "check-index-not-found");
        return null;
      };
      const tokenOf = (f: CoinFacts | null): CheckEvidence["token"] => f === null ? null : {
        liquidityUsd: f.liquidityUsd, top10Pct: f.holders?.top10Pct ?? null, creatorPct: f.creatorHoldingPct,
        poolAgeDays: f.poolCreatedAtMs !== null ? Math.max(0, (now() - f.poolCreatedAtMs) / DAY) : null,
      };

      // 1. A COIN: the index, and the website it lists when the post gave none.
      let siteUrl: string | null = target.kind === "site" ? target.url : target.site;
      let token: CheckEvidence["token"] = null;
      let noSite = false;
      let coinHandle: string | null = null;
      if (target.kind === "coin") {
        const facts = await factsFor(target.address, target.chain);
        token = tokenOf(facts);
        coinHandle = facts?.links?.twitter ?? null;
        if (!siteUrl && facts) {
          const listed = facts.links?.websites ?? [];
          siteUrl = listed.map(siteLink).find((s): s is string => s !== null) ?? null;
          // A listing read that names no site at all is a finding; an unread one is not.
          if (!siteUrl && facts.info === "read" && listed.length === 0) noSite = true;
        }
      }

      // 2. THE SITE (or, for a github.com link, GitHub straight away).
      let site: CheckEvidence["site"] = null;
      let page: PageScan | null = null;
      let repoAsked: { owner: string; repo: string | null; linkedOnly: boolean } | null = null;
      const gh = siteUrl ? githubOf(siteUrl) : null;
      if (gh) {
        repoAsked = { ...gh, linkedOnly: false };
      } else if (siteUrl) {
        if (left() < 5_000) notes.push("check-late");
        else {
          lookups++;
          const r = await scan(siteUrl, Math.min(SCAN_MS, left() - 3_000)).catch((): ScanResult => ({ ok: false, url: siteUrl!, failure: "browser-error" }));
          // AN ERROR PAGE IS NO SITE (review of #333): a 404 or a 500 still loads
          // in a browser, and a verbose error page would otherwise earn
          // "site-up", hand over unrelated links and help a broken project URL
          // to a public "real". Gone or broken (404, 410, a 5xx but 503) is the
          // site down; anything else at 400 and over (401, 403, 429, 503: a
          // login, a bot wall, a rate limit, Cloudflare's own page) is the site
          // refusing to be read, which says nothing about it.
          const status = r.ok && r.page ? r.page.status : 0;
          const errored = status >= 400;
          const broken = status === 404 || status === 410 || (status >= 500 && status !== 503);
          if (r.ok && r.page && !errored) {
            page = r.page;
            notes.push("check-site-read");
          } else if (errored) {
            notes.push(broken ? "check-site-http-broken" : "check-site-http-refused");
          } else {
            notes.push(`check-site-${r.failure ?? "failed"}`);
          }
          // "unreachable" only when the browser saw the page fail to load (scanPage) or the site answered gone or broken; every other failure is ours, and is "not read".
          const read: NonNullable<CheckEvidence["site"]>["read"] = page ? "ok" : errored ? (broken ? "unreachable" : "none")
            : r.failure === "busy" ? "busy" : r.failure === "unreachable" ? "unreachable" : "none";
          let namesCoin: NonNullable<CheckEvidence["site"]>["namesCoin"] = null;
          if (page && target.kind === "coin") {
            const all = [...page.findings.evm, ...page.findings.solana];
            const written = page.allText.includes(target.address) || (target.chain === "evm" && page.allText.toLowerCase().includes(target.address.toLowerCase()));
            // Named anywhere (a dapp that hardcodes its own token in its bundle names it too);
            // "other" only for contracts a visitor is shown, never a library's address in a bundle.
            const visible = all.filter((a) => a.where.some((w) => WHERE_RANK[w] <= WHERE_RANK.text));
            namesCoin = written || all.some((a) => a.chain === target.chain && sameAddress(target.chain, a.address, target.address)) ? "yes" : visible.length ? "other" : "none";
          }
          site = { url: siteUrl, read, textChars: page ? Math.max(page.allText.length, page.text.length) : 0, ownCalls: page ? page.loaded.ownCalls : null,
            docs: page?.findings.docs === true, namesCoin };
          if (page) {
            // The coin's own X handle, as the index lists it, is one of its names; the handles a page links are not (a docs site links its sponsors).
            const names = siteNames({ url: page.finalUrl || siteUrl, title: page.title, extra: coinHandle ? [coinHandle] : [] });
            const own = ownRepo(page.findings, names);
            if (own) repoAsked = { owner: own.repo.owner, repo: own.repo.repo, linkedOnly: own.linkedOnly };
          }
        }
      }

      // 3. THE GITHUB, and 4. FOR A SITE, THE ONE CONTRACT IT SHOWS: side by side.
      const shown = target.kind === "site" && page
        ? [...page.findings.evm, ...page.findings.solana].filter((a) => a.where.some((w) => WHERE_RANK[w] <= WHERE_RANK.text))
        : [];
      const [ghRead, shownFacts] = await Promise.all([
        repoAsked && left() > 1_500 ? (lookups++, github(repoAsked.owner, repoAsked.repo, Math.min(GITHUB_MS, left() - 500)).catch((): GithubRead => ({ ok: false, failure: "unreachable", detail: "" }))) : Promise.resolve(null),
        shown.length === 1 && left() > 2_000 ? factsFor(shown[0]!.address, shown[0]!.chain) : Promise.resolve(null),
      ]);
      if (shownFacts) token = tokenOf(shownFacts);
      let githubEv: CheckEvidence["github"] = null;
      const none = { linkedOnly: false, pushedDaysAgo: null, createdDaysAgo: null, commits30d: null, commitsPartial: false, stars: null, fork: false, archived: false, sizeKb: null };
      if (repoAsked && ghRead === null) githubEv = { found: "unread", ...none };
      else if (ghRead && !ghRead.ok) {
        notes.push(`check-github-${ghRead.failure}`);
        // A linked GitHub that does not exist is no GitHub; one GitHub would not answer for is unread.
        githubEv = { found: ghRead.failure === "not-found" || ghRead.failure === "bad-name" ? "none" : "unread", ...none };
      } else if (ghRead && ghRead.ok) {
        const r = ghRead.record.repo;
        notes.push(r ? "check-github-read" : "check-github-empty-owner");
        githubEv = r === null ? { found: "none", ...none } : {
          found: "repo", linkedOnly: repoAsked?.linkedOnly === true,
          pushedDaysAgo: r.pushedAtMs !== null ? Math.max(0, (now() - r.pushedAtMs) / DAY) : null,
          createdDaysAgo: r.createdAtMs !== null ? Math.max(0, (now() - r.createdAtMs) / DAY) : null,
          commits30d: r.commits30d, commitsPartial: r.commitsPartial, stars: r.stars, fork: r.fork, archived: r.archived, sizeKb: r.sizeKb,
        };
      } else if (page) {
        // The site was read and shows no GitHub of any kind.
        githubEv = { found: "none", ...none };
      }

      const run: CheckRun = {
        evidence: { target, site, ...(noSite ? { noSite: true as const } : {}), github: githubEv, token },
        claim: page ? (page.description || page.title || null) : null,
        lookups,
        notes,
      };
      // Remembered only when something was actually seen: a check that saw nothing is asked again next time.
      if (page || ghRead?.ok || token) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, { run, until: now() + CACHE_MS });
      }
      return run;
    },
  };
}
