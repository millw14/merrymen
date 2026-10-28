/**
 * IS ANYBODY ACTUALLY SHIPPING CODE AT THE GITHUB A PROJECT POINTS TO.
 *
 * The X agent's larp check (orchestrator-xpost-check.ts) finds a project's
 * GitHub on its site (packages/core/src/site-scan.ts) and asks this file one
 * question about it: is it alive. Not whether the code is good, not whether
 * it does what the site says, not whether the coin is safe — a diligent team
 * ships commits, and so does a diligent rug. Activity is a fact about the
 * repo, and it is the one a casual reader most wants and least checks.
 *
 * ── WHAT IS READ ─────────────────────────────────────────────────────────
 *
 * GitHub's public REST API, three calls at most:
 *   - the repo (created, last pushed, stars, forks, size, fork, archived);
 *   - its commits in the last thirty days (one page of a hundred: a FLOOR
 *     when the page is full, and `commitsPartial` says so — "a hundred
 *     commits" and "at least a hundred" are different claims that read the
 *     same once they are a sentence, the rule research/builder.ts keeps);
 *   - for a bare owner, their most recently pushed repos first, and the
 *     newest of their own (not forked, not archived) repos is the one read.
 *
 * Unauthenticated, GitHub allows sixty calls an hour from one address, which
 * the whole fleet shares behind Railway's egress. MERRYMEN_GITHUB_TOKEN (any
 * fine-grained token with no permissions: public data only) lifts that to
 * five thousand. Without it the reader still works, and a 403 that is
 * GitHub's rate limit is reported as `rate-limited`, never as "not found":
 * our cadence is no fact about the repo.
 *
 * ── ABSENCE IS NOT A VERDICT ─────────────────────────────────────────────
 *
 * A null field is unread, never zero. A repo that answered 409 (empty: no
 * commits ever) is the one case where zero commits is a measurement.
 *
 * NO RETRIES, the same rule as hey.ts and the browser client: a source that
 * did not answer is a fact about this window, and the tag that asked is
 * answered without it.
 */
import { readBoundedJson } from "../bounded-read";

const API = "https://api.github.com";
/** GitHub's own rule for an owner: letters, digits, single hyphens, at most thirty-nine. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const DAY_MS = 86_400_000;
/** The window "commits lately" counts. */
export const COMMIT_WINDOW_DAYS = 30;
/** One page of commits: past this the count is a floor. */
const COMMITS_PAGE = 100;
/** A repo's JSON is a few kilobytes; a full page of commits a few hundred. */
const REPO_BYTES = 256_000;
const LIST_BYTES = 1_500_000;
const DETAIL_MAX = 160;

export type GithubFailure =
  /** The owner or repo was not a name GitHub could have. OUR bug or the page's junk, never GitHub's. */
  | "bad-name"
  /** GitHub answered 404: no such owner or repo, or a private one. */
  | "not-found"
  /** Our cadence, not the repo's: GitHub's rate limit (403 with nothing left, or 429). */
  | "rate-limited"
  /** The token was refused: the house's gap. */
  | "unauthorized"
  | "unreachable"
  | "http-error"
  | "unreadable";

export interface GithubRepoRecord {
  owner: string;
  repo: string;
  createdAtMs: number | null;
  /** The last push to any branch, GitHub's own `pushed_at`. */
  pushedAtMs: number | null;
  stars: number | null;
  forks: number | null;
  /** A fork of someone else's repo: the code is theirs until shown otherwise. */
  fork: boolean;
  archived: boolean;
  /** GitHub's size in kilobytes: a near-empty repo is a placeholder. */
  sizeKb: number | null;
  /** Commits on the default branch in the last COMMIT_WINDOW_DAYS, or null unread. */
  commits30d: number | null;
  /** True when the count filled the page: "at least", never "exactly". */
  commitsPartial: boolean;
  /** The newest commit's date, when one was in the window. */
  lastCommitAtMs: number | null;
}

export interface GithubRecord {
  readAt: number;
  owner: string;
  /** The repo read, or null when the owner has none of their own. */
  repo: GithubRepoRecord | null;
  /** True when the page linked only the owner and this file picked their newest own repo. */
  pickedFromOwner: boolean;
  /** The owner's public repo count, when the owner itself was read. */
  ownerRepos: number | null;
}

export type GithubRead = { ok: true; record: GithubRecord } | { ok: false; failure: GithubFailure; detail: string };

type Fetch = typeof fetch;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}
function when(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** A token never reaches a log or a detail, however an error message quotes it. */
function scrub(s: string, token: string): string {
  const out = token ? s.split(token).join("[token]") : s;
  return out.slice(0, DETAIL_MAX);
}

/** One GET against the API, sorted into what it means about us and what it means about the repo. */
async function get(path: string, o: { token: string; deadline: number; now: () => number; fetchImpl: Fetch; maxBytes: number }):
  Promise<{ ok: true; body: unknown } | { ok: false; status: number; failure: GithubFailure; detail: string }> {
  const ms = o.deadline - o.now();
  if (ms <= 100) return { ok: false, status: 0, failure: "unreachable", detail: "out of time" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await o.fetchImpl(API + path, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        // GitHub refuses a request with no user agent.
        "user-agent": "merrymen-research",
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      },
      signal: ctl.signal,
    });
    if (!res.ok) {
      const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      const failure: GithubFailure = res.status === 404 ? "not-found" : limited ? "rate-limited" : res.status === 401 ? "unauthorized" : "http-error";
      // Drain nothing: the body of a refusal is GitHub's prose, never needed.
      return { ok: false, status: res.status, failure, detail: `github answered ${res.status}` };
    }
    const body = await readBoundedJson<unknown>(res, o.maxBytes);
    return body.ok ? { ok: true, body: body.value } : { ok: false, status: res.status, failure: "unreadable", detail: scrub(body.detail, o.token) };
  } catch (e) {
    return { ok: false, status: 0, failure: "unreachable", detail: scrub(e instanceof Error ? e.message : String(e), o.token) };
  } finally {
    clearTimeout(timer);
  }
}

/** A repo's JSON, as this file keeps it. Null when it is not a repo object at all. */
function repoOf(body: unknown): Omit<GithubRepoRecord, "commits30d" | "commitsPartial" | "lastCommitAtMs"> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  const owner = (r.owner as Record<string, unknown> | undefined)?.login;
  if (typeof r.name !== "string" || !REPO_RE.test(r.name) || typeof owner !== "string" || !OWNER_RE.test(owner)) return null;
  return {
    owner, repo: r.name,
    createdAtMs: when(r.created_at), pushedAtMs: when(r.pushed_at),
    stars: num(r.stargazers_count), forks: num(r.forks_count),
    fork: r.fork === true, archived: r.archived === true, sizeKb: num(r.size),
  };
}

/**
 * ONE PROJECT'S GITHUB, by owner and (when the page linked one) repo. Never
 * throws. Three calls at most, all inside `timeoutMs`.
 */
export async function readGithub(args: {
  owner: string;
  repo: string | null;
  /** MERRYMEN_GITHUB_TOKEN, or empty: sixty calls an hour instead of five thousand. */
  token?: string;
  timeoutMs: number;
  now?: () => number;
  fetchImpl?: Fetch;
}): Promise<GithubRead> {
  const now = args.now ?? Date.now;
  const owner = String(args.owner ?? "").trim();
  const asked = args.repo === null ? null : String(args.repo ?? "").trim().replace(/\.git$/i, "");
  // CHECKED BEFORE A CALL IS SPENT: a stranger's page chose these strings.
  if (!OWNER_RE.test(owner) || (asked !== null && !REPO_RE.test(asked))) return { ok: false, failure: "bad-name", detail: "not a GitHub name" };
  const o = { token: String(args.token ?? ""), deadline: now() + Math.max(0, args.timeoutMs), now, fetchImpl: args.fetchImpl ?? fetch, maxBytes: REPO_BYTES };
  const enc = encodeURIComponent;
  let name = asked;
  let ownerRepos: number | null = null;
  if (name === null) {
    // A BARE OWNER: their most recently pushed repos, newest first, and the
    // newest that is their own (a fork is someone else's code). The owner's
    // own record is skipped: its repo count is in no sentence worth a call.
    const list = await get(`/users/${enc(owner)}/repos?sort=pushed&direction=desc&per_page=10&type=owner`, { ...o, maxBytes: LIST_BYTES });
    if (!list.ok) return { ok: false, failure: list.failure, detail: list.detail };
    const repos = Array.isArray(list.body) ? list.body.map(repoOf).filter((r): r is NonNullable<ReturnType<typeof repoOf>> => r !== null) : [];
    ownerRepos = repos.length;
    const pick = repos.find((r) => !r.fork && !r.archived) ?? null;
    if (!pick) return { ok: true, record: { readAt: now(), owner, repo: null, pickedFromOwner: true, ownerRepos } };
    name = pick.repo;
  }
  const repoRead = await get(`/repos/${enc(owner)}/${enc(name)}`, o);
  if (!repoRead.ok) return { ok: false, failure: repoRead.failure, detail: repoRead.detail };
  const base = repoOf(repoRead.body);
  if (!base) return { ok: false, failure: "unreadable", detail: "not a repository" };
  // THE LAST THIRTY DAYS OF COMMITS, one page. 409 is GitHub's "this repo is
  // empty": the one place zero is measured rather than assumed.
  const since = new Date(now() - COMMIT_WINDOW_DAYS * DAY_MS).toISOString();
  const commits = await get(`/repos/${enc(base.owner)}/${enc(base.repo)}/commits?since=${enc(since)}&per_page=${COMMITS_PAGE}`, { ...o, maxBytes: LIST_BYTES });
  let commits30d: number | null = null, commitsPartial = false, lastCommitAtMs: number | null = null;
  if (commits.ok && Array.isArray(commits.body)) {
    commits30d = commits.body.length;
    commitsPartial = commits.body.length >= COMMITS_PAGE;
    const first = commits.body[0] as { commit?: { committer?: { date?: unknown }; author?: { date?: unknown } } } | undefined;
    lastCommitAtMs = when(first?.commit?.committer?.date) ?? when(first?.commit?.author?.date);
  } else if (!commits.ok && commits.status === 409) {
    commits30d = 0;
  }
  return {
    ok: true,
    record: { readAt: now(), owner: base.owner, repo: { ...base, commits30d, commitsPartial, lastCommitAtMs }, pickedFromOwner: asked === null, ownerRepos },
  };
}
