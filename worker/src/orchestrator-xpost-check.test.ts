import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoinFacts, CoinFactsRead, CoinFactsReader } from "./coin-facts-types";
import { createLarpChecker } from "./orchestrator-xpost-check";
import type { GithubRead } from "./research/github";
import { scanOf, scanPage, type PageScan, type ScanResult } from "./venues/research";
import { assessCheck } from "./xpost/check";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;
const CA = "0x86aF99052DB086a66aF7D764bB04d3abb81b485F";
const OTHER = "0x" + "b".repeat(40);

function facts(o: Partial<CoinFacts> = {}): CoinFacts {
  return { network: "robinhood", observedAt: NOW, priceUsd: 0.001, fdvNowUsd: 1e6, high: null, barsFromMs: null, poolCreatedAtMs: NOW - 20 * DAY, drawdownPct: null, steepest: null,
    liquidityUsd: 80_000, change24hPct: 2, buyers24h: 50, sellers24h: 40, holders: { count: 900, top10Pct: 35, updatedAtMs: NOW }, creatorHoldingPct: 1, info: "read", poolsSeen: 1,
    links: { websites: ["https://acme.example/"], twitter: "acme" }, ...o };
}
function page(o: Partial<PageScan> = {}, findings: Partial<PageScan["findings"]> = {}): PageScan {
  return { status: 200, title: "Acme — onchain widgets", description: "acme builds onchain widgets for traders", text: "x".repeat(2000), truncated: false, links: [],
    finalUrl: "https://acme.example/", allText: `Acme. CA: ${CA}. ` + "y".repeat(2000),
    findings: { evm: [{ address: CA, chain: "evm", where: ["text"] }], solana: [], github: [{ owner: "acme", repo: "acme-app", where: ["link"] }], x: ["acme"], telegram: true, discord: false, docs: true, ...findings },
    loaded: { scripts: 4, scriptBytes: 900_000, ownCalls: 6, callHosts: ["api.acme.example"] }, ...o };
}
const repoRead = (o: Record<string, unknown> = {}): GithubRead => ({ ok: true, record: { readAt: NOW, owner: "acme", pickedFromOwner: false, ownerRepos: null,
  repo: { owner: "acme", repo: "acme-app", createdAtMs: NOW - 300 * DAY, pushedAtMs: NOW - DAY, stars: 52, forks: 4, fork: false, archived: false, sizeKb: 9000, commits30d: 41, commitsPartial: false, lastCommitAtMs: NOW - DAY, ...o } } });

/** Fakes for every reader, recording what was asked. */
function world(o: { facts?: (network: string) => CoinFactsRead; scan?: (url: string) => ScanResult; github?: () => GithubRead } = {}) {
  const asked = { facts: [] as string[], scans: [] as string[], github: [] as string[] };
  const coinFacts: CoinFactsReader = async (q) => { asked.facts.push(`${q.network}:${q.address}`); return o.facts ? o.facts(q.network) : { ok: true, facts: facts() }; };
  const checker = createLarpChecker({
    browser: { baseUrl: "http://browser.internal", token: "t" }, coinFacts, now: () => NOW,
    scan: async (url) => { asked.scans.push(url); return o.scan ? o.scan(url) : { ok: true, url, page: page() }; },
    github: async (owner, repo) => { asked.github.push(`${owner}/${repo}`); return o.github ? o.github() : repoRead(); },
  });
  return { checker, asked };
}

describe("the larp check's legwork", () => {
  it("a coin: the index, the site it lists, whether the site names it, and the site's own GitHub", async () => {
    const { checker, asked } = world();
    const run = await checker.check({ kind: "coin", address: CA, chain: "evm", site: null }, { budgetMs: 50_000, chatId: 1 });
    assert.deepEqual(asked.scans, ["https://acme.example/"]);
    assert.deepEqual(asked.github, ["acme/acme-app"]);
    assert.equal(run.evidence.site?.namesCoin, "yes");
    assert.equal(run.evidence.site?.ownCalls, 6);
    assert.equal(run.evidence.github?.found, "repo");
    assert.ok(Math.abs(run.evidence.github!.pushedDaysAgo! - 1) < 1e-9);
    assert.equal(run.evidence.token?.top10Pct, 35);
    assert.equal(run.claim, "acme builds onchain widgets for traders");
    assert.equal(assessCheck(run.evidence).verdict, "real");
    assert.ok(!run.notes.some((n) => n.includes("acme") || n.includes("0x")), "notes carry no url or address");
  });

  it("a 0x contract the house chain does not list is looked for on the other chains, in order", async () => {
    const { checker, asked } = world({ facts: (n) => (n === "base" ? { ok: true, facts: facts({ network: "base" }) } : { ok: false, why: "not-found" }) });
    await checker.check({ kind: "coin", address: CA, chain: "evm", site: null }, { budgetMs: 50_000, chatId: 1 });
    assert.deepEqual(asked.facts.map((f) => f.split(":")[0]), ["robinhood", "base"]);
  });

  it("a coin the index lists with no website at all is a finding; one it does not list is nothing seen", async () => {
    const bare = world({ facts: () => ({ ok: true, facts: facts({ links: { websites: [], twitter: null } }) }) });
    const r = await bare.checker.check({ kind: "coin", address: CA, chain: "evm", site: null }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(r.evidence.noSite, true);
    assert.deepEqual(bare.asked.scans, []);
    const unknown = world({ facts: () => ({ ok: false, why: "not-found" }) });
    const u = await unknown.checker.check({ kind: "coin", address: CA, chain: "evm", site: null }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(u.evidence.noSite, undefined);
    assert.equal(assessCheck(u.evidence).verdict, "unclear");
  });

  it("a site that shows a visitor another contract but never this one", async () => {
    const { checker } = world({ scan: (url) => ({ ok: true, url, page: page({ allText: `CA: ${OTHER}` }, { evm: [{ address: OTHER, chain: "evm", where: ["text"] }], github: [] }) }) });
    const r = await checker.check({ kind: "coin", address: CA, chain: "evm", site: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(r.evidence.site?.namesCoin, "other");
    assert.equal(r.evidence.github?.found, "none");
  });

  it("a library's address in a bundle is never 'another contract'", async () => {
    const { checker } = world({ scan: (url) => ({ ok: true, url, page: page({ allText: "no contract here" }, { evm: [{ address: OTHER, chain: "evm", where: ["script"] }] }) }) });
    const r = await checker.check({ kind: "coin", address: CA, chain: "evm", site: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(r.evidence.site?.namesCoin, "none");
  });

  it("a github.com link is read on GitHub, never in the browser", async () => {
    const { checker, asked } = world();
    const r = await checker.check({ kind: "site", url: "https://github.com/acme/acme-app" }, { budgetMs: 50_000, chatId: 1 });
    assert.deepEqual(asked.scans, []);
    assert.deepEqual(asked.github, ["acme/acme-app"]);
    assert.equal(r.evidence.github?.found, "repo");
  });

  it("a site's one visible contract is looked up for its holders", async () => {
    const { checker, asked } = world();
    const r = await checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.deepEqual(asked.facts, [`robinhood:${CA}`]);
    assert.equal(r.evidence.token?.top10Pct, 35);
    assert.equal(r.evidence.site?.namesCoin, null);
  });

  it("an error page is no site: a 404 or a 500 is the site down, a bot wall or a login is not read, and neither is scored (review of #333)", async () => {
    for (const [status, read] of [[404, "unreachable"], [500, "unreachable"], [410, "unreachable"], [403, "none"], [429, "none"], [503, "none"], [401, "none"]] as const) {
      const { checker, asked } = world({ scan: (url) => ({ ok: true, url, page: page({ status }) }) });
      const r = await checker.check({ kind: "coin", address: CA, chain: "evm", site: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
      assert.equal(r.evidence.site?.read, read, String(status));
      assert.equal(r.evidence.site?.namesCoin, null, `${status}: nothing on an error page is read`);
      assert.equal(r.evidence.github, null, `${status}: no GitHub from an error page`);
      assert.deepEqual(asked.github, [], String(status));
      assert.ok(!assessCheck(r.evidence).signals.includes("site-up"), String(status));
    }
  });

  it("a browser that cannot scan is never said as the site being down", async () => {
    const { checker } = world({ scan: (url) => ({ ok: false, url, failure: "browser-error" }) });
    const r = await checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(r.evidence.site?.read, "none");
    assert.ok(!assessCheck(r.evidence).signals.includes("site-down"));
    assert.equal(assessCheck(r.evidence).verdict, "unclear");
  });

  it("a busy browser and a GitHub that would not answer are unread, never findings", async () => {
    const { checker } = world({ scan: (url) => ({ ok: false, url, failure: "busy" }) });
    const r = await checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(r.evidence.site?.read, "busy");
    assert.equal(r.evidence.github, null);
    assert.equal(assessCheck(r.evidence).verdict, "unclear");
    const limited = world({ github: () => ({ ok: false, failure: "rate-limited", detail: "" }) });
    const g = await limited.checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(g.evidence.github?.found, "unread");
    assert.ok(g.notes.includes("check-github-rate-limited"));
  });

  it("remembers what it saw for half an hour, and never what it could not see", async () => {
    const seen = world();
    await seen.checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    const again = await seen.checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.deepEqual([seen.asked.scans.length, again.notes, again.lookups], [1, ["check-cached"], 0]);
    const blind = world({ scan: (url) => ({ ok: false, url, failure: "unreachable" }) });
    await blind.checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    await blind.checker.check({ kind: "site", url: "https://acme.example/" }, { budgetMs: 50_000, chatId: 1 });
    assert.equal(blind.asked.scans.length, 2);
  });
});

describe("the browser's /scan, as this side trusts it", () => {
  it("drops every malformed field rather than believe it", () => {
    const p = scanOf({ status: 200, title: 5, text: "hi", links: [{ href: "https://a.example", text: "a" }, { nope: 1 }], allText: "all",
      findings: { evm: [{ address: CA, where: ["text", "bogus"] }, { address: "0x123" }], solana: [{ address: "not base58 0OIl" }], github: [{ owner: "../x", repo: "y" }, { owner: "acme", repo: "a/b" }], x: ["acme", 5], docs: "yes" },
      loaded: { ownCalls: -1, callHosts: ["api.acme.example"] } });
    assert.ok(p);
    assert.deepEqual(p!.findings.evm, [{ address: CA, chain: "evm", where: ["text"] }]);
    assert.deepEqual(p!.findings.solana, []);
    assert.deepEqual(p!.findings.github, [{ owner: "acme", repo: null, where: [] }]);
    assert.deepEqual([p!.findings.x, p!.findings.docs, p!.loaded.ownCalls, p!.title], [["acme"], false, 0, ""]);
    assert.equal(scanOf("nope"), null);
  });

  it("sorts what the service said: busy, the page not loading, and a refused URL never sent", async () => {
    const calls: string[] = [];
    const say = (status: number, body: unknown) => (async (url: string) => { calls.push(url); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    const cfg = { baseUrl: "http://browser.internal/", token: "t" };
    assert.equal((await scanPage(cfg, "https://acme.example", say(429, {}))).failure, "busy");
    assert.equal((await scanPage(cfg, "https://acme.example", say(502, { error: "could not read the page: page.goto: net::ERR_NAME_NOT_RESOLVED at https://acme.example/" }))).failure, "unreachable");
    // Our side, never the site's: a browser without /scan, a crash, a browser that never answered.
    assert.equal((await scanPage(cfg, "https://acme.example", say(404, { error: "not found" }))).failure, "browser-error");
    assert.equal((await scanPage(cfg, "https://acme.example", say(502, { error: "could not read the page: browserType.launch: Executable doesn't exist" }))).failure, "browser-error");
    assert.equal((await scanPage(cfg, "https://acme.example", (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch)).failure, "browser-error");
    assert.equal((await scanPage(cfg, "https://acme.example", say(200, { nope: true }))).ok, true, "a body with no findings is a page with none");
    assert.equal((await scanPage(cfg, "http://acme.example", say(200, {}))).failure, "refused-url");
    assert.equal((await scanPage(null, "https://acme.example", say(200, {}))).failure, "no-browser");
    assert.ok(calls.every((c) => c === "http://browser.internal/scan"));
  });
});
