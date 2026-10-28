import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readGithub } from "./github";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;

function repoJson(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "acme-core", owner: { login: "acme" }, created_at: new Date(NOW - 200 * DAY).toISOString(), pushed_at: new Date(NOW - 2 * DAY).toISOString(),
    stargazers_count: 41, forks_count: 3, fork: false, archived: false, size: 2048, ...o,
  };
}
const commit = (daysAgo: number) => ({ commit: { committer: { date: new Date(NOW - daysAgo * DAY).toISOString() } } });

/** A fake GitHub: routes by path prefix, records every call. */
function github(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const path = url.replace("https://api.github.com", "");
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) return new Response("{}", { status: 404 });
    const r = hit[1];
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("a project's GitHub, read for activity", () => {
  it("reads a linked repo and its last thirty days of commits", async () => {
    const g = github({ "/repos/acme/acme-core/commits": { body: [commit(1), commit(3), commit(9)] }, "/repos/acme/acme-core": { body: repoJson() } });
    const r = await readGithub({ owner: "acme", repo: "acme-core.git", timeoutMs: 5000, now: () => NOW, fetchImpl: g.fetchImpl, token: "ghp_secret" });
    assert.ok(r.ok);
    const repo = r.record.repo!;
    assert.deepEqual([repo.commits30d, repo.commitsPartial, repo.stars, repo.fork], [3, false, 41, false]);
    assert.equal(repo.lastCommitAtMs, NOW - DAY);
    assert.equal(r.record.pickedFromOwner, false);
    assert.match(g.calls[1]!.url, /since=2026-09-13/);
    assert.equal(g.calls[0]!.headers.authorization, "Bearer ghp_secret");
    assert.equal(g.calls[0]!.headers["user-agent"], "merrymen-research");
  });

  it("says a full page of commits is a floor, never an exact count", async () => {
    const g = github({ "/repos/acme/acme-core/commits": { body: Array.from({ length: 100 }, () => commit(1)) }, "/repos/acme/acme-core": { body: repoJson() } });
    const r = await readGithub({ owner: "acme", repo: "acme-core", timeoutMs: 5000, now: () => NOW, fetchImpl: g.fetchImpl });
    assert.ok(r.ok);
    assert.deepEqual([r.record.repo!.commits30d, r.record.repo!.commitsPartial], [100, true]);
  });

  it("measures zero only for an empty repo, and leaves commits unread on any other failure", async () => {
    const empty = github({ "/repos/acme/acme-core/commits": { status: 409 }, "/repos/acme/acme-core": { body: repoJson() } });
    const e = await readGithub({ owner: "acme", repo: "acme-core", timeoutMs: 5000, now: () => NOW, fetchImpl: empty.fetchImpl });
    assert.ok(e.ok);
    assert.equal(e.record.repo!.commits30d, 0);
    const down = github({ "/repos/acme/acme-core/commits": { status: 500 }, "/repos/acme/acme-core": { body: repoJson() } });
    const d = await readGithub({ owner: "acme", repo: "acme-core", timeoutMs: 5000, now: () => NOW, fetchImpl: down.fetchImpl });
    assert.ok(d.ok);
    assert.equal(d.record.repo!.commits30d, null, "unread, never zero");
  });

  it("for a bare owner, reads their newest repo of their own, never a fork", async () => {
    const g = github({
      "/users/acme/repos": { body: [repoJson({ name: "someones-fork", fork: true }), repoJson({ name: "acme-app" }), repoJson({ name: "older" })] },
      "/repos/acme/acme-app/commits": { body: [] },
      "/repos/acme/acme-app": { body: repoJson({ name: "acme-app" }) },
    });
    const r = await readGithub({ owner: "acme", repo: null, timeoutMs: 5000, now: () => NOW, fetchImpl: g.fetchImpl });
    assert.ok(r.ok);
    assert.deepEqual([r.record.repo!.repo, r.record.pickedFromOwner, r.record.ownerRepos, r.record.repo!.commits30d], ["acme-app", true, 3, 0]);
  });

  it("an owner with nothing of their own is found, with no repo", async () => {
    const g = github({ "/users/acme/repos": { body: [repoJson({ name: "fork", fork: true })] } });
    const r = await readGithub({ owner: "acme", repo: null, timeoutMs: 5000, now: () => NOW, fetchImpl: g.fetchImpl });
    assert.ok(r.ok);
    assert.equal(r.record.repo, null);
  });

  it("tells GitHub's rate limit apart from a missing repo, and spends nothing on a name GitHub could not have", async () => {
    const limited = github({ "/repos/": { status: 403, headers: { "x-ratelimit-remaining": "0" } } });
    const l = await readGithub({ owner: "acme", repo: "acme-core", timeoutMs: 5000, now: () => NOW, fetchImpl: limited.fetchImpl });
    assert.deepEqual(l.ok ? null : l.failure, "rate-limited");
    const missing = github({});
    const m = await readGithub({ owner: "acme", repo: "nope", timeoutMs: 5000, now: () => NOW, fetchImpl: missing.fetchImpl });
    assert.deepEqual(m.ok ? null : m.failure, "not-found");
    const bad = github({});
    const b = await readGithub({ owner: "../../evil", repo: null, timeoutMs: 5000, now: () => NOW, fetchImpl: bad.fetchImpl });
    assert.deepEqual(b.ok ? null : b.failure, "bad-name");
    assert.equal(bad.calls.length, 0);
  });

  it("never throws, and never quotes the token in a failure", async () => {
    const fetchImpl = (async () => { throw new Error("connect failed with ghp_secret in it"); }) as typeof fetch;
    const r = await readGithub({ owner: "acme", repo: "acme-core", timeoutMs: 5000, now: () => NOW, fetchImpl, token: "ghp_secret" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.failure === "unreachable" && !r.detail.includes("ghp_secret"));
  });
});
