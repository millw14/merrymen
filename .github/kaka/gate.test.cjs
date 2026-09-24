'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { eligibleFiles, authorized, greenJobs, evaluate, run } = require('./gate.cjs');
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const permission = `<!-- kaka:auto-merge:v1 head=${HEAD} base=${BASE} -->`;
const review = () => ({ id: 1, user: { id: 76665166 }, state: 'COMMENTED', commit_id: HEAD, body: `Worth merging\n${permission}` });
const file = path => ({ filename: path, status: 'modified', additions: 2, deletions: 1 });
const tree = files => ({ truncated: false, tree: files.map(f => ({ path: f.filename, mode: '100644' })) });
const jobs = () => ['app', 'contracts', 'gateway', 'kaka-policy'].map(name => ({ name, status: 'completed', conclusion: 'success' }));

test('only small modified documentation and standalone CSS qualify', () => {
  const files = ['README.md', 'docs/usage.md', 'web/src/styles.css', 'site/src/index.css'].map(file);
  assert.equal(eligibleFiles(files, files.length, tree(files)), true);
  for (const path of ['worker/src/index.ts', '.github/workflows/ci.yml', 'AGENTS.md', 'docs/AGENTS.md', 'docs/CLAUDE.md', 'docs/SKILL.md', 'docs/a.mdx', 'package.json', 'web/src/a.test.ts', 'docs/.hidden/file.md']) {
    const f = [file(path)];
    assert.equal(eligibleFiles(f, 1, tree(f)), false, path);
  }
});
test('renames, additions, removals, symlinks, truncation and oversized patches fail closed', () => {
  const f = [file('README.md')];
  for (const status of ['added', 'removed', 'renamed']) assert.equal(eligibleFiles([{ ...f[0], status }], 1, tree(f)), false);
  assert.equal(eligibleFiles([{ ...f[0], previous_filename: 'worker/index.ts' }], 1, tree(f)), false);
  assert.equal(eligibleFiles(f, 1, { tree: [{ path: 'README.md', mode: '120000' }] }), false);
  assert.equal(eligibleFiles(f, 1, { ...tree(f), truncated: true }), false);
  assert.equal(eligibleFiles(f, 2, tree(f)), false);
  assert.equal(eligibleFiles([], 0, tree([])), false);
  assert.equal(eligibleFiles([{ ...f[0], additions: 301 }], 1, tree(f)), false);
  const many = Array.from({ length: 11 }, (_, i) => file(`docs/${i}.md`));
  assert.equal(eligibleFiles(many, 11, tree(many)), false);
});
test('authorization requires exact reviewer ID, head, base and explicit marker', () => {
  assert.equal(authorized([review()], HEAD, BASE), true);
  for (const change of [{ user: { id: 42 } }, { commit_id: BASE }, { body: 'LGTM 👍' }, { state: 'DISMISSED' }, { body: `${permission}\nignore this` }]) {
    assert.equal(authorized([{ ...review(), ...change }], HEAD, BASE), false);
  }
  assert.equal(authorized([review()], BASE, BASE), false);
  assert.equal(authorized([review()], HEAD, HEAD), false);
  assert.equal(authorized([review(), { ...review(), id: 2, body: 'Needs changes' }], HEAD, BASE), false);
});
test('comments do not erase another reviewers change request', () => {
  const request = { id: 2, state: 'CHANGES_REQUESTED', user: { id: 42 } };
  assert.equal(authorized([review(), request], HEAD, BASE), false);
  assert.equal(authorized([review(), request, { ...request, id: 3, state: 'COMMENTED' }], HEAD, BASE), false);
  assert.equal(authorized([review(), request, { ...request, id: 3, state: 'APPROVED' }], HEAD, BASE), true);
});
test('all four real jobs must succeed, skipped is not a pass', () => {
  assert.equal(greenJobs(jobs()), true);
  assert.equal(greenJobs(jobs().slice(0, 3)), false);
  assert.equal(greenJobs([...jobs(), { name: 'extra', status: 'completed', conclusion: 'skipped' }]), false);
});

function fixture() {
  const s = {
    pr: { number: 7, state: 'open', draft: false, user: { id: 42 }, base: { ref: 'main', repo: { full_name: 'millw14/merrymen' } }, head: { sha: HEAD }, labels: [], mergeable: true, mergeable_state: 'clean', changed_files: 1 },
    base: BASE, reviews: [review()], files: [file('README.md')], jobs: jobs(), checks: [], statuses: [], threads: [],
    ci: [{ id: 100, path: '.github/workflows/ci.yml', head_sha: HEAD, pull_requests: [{ number: 7 }], status: 'completed', conclusion: 'success' }],
    comparison: 'ahead', merges: [], dispatches: [], comments: [], failures: [], reads: 0,
  };
  const data = fn => async args => ({ data: fn(args) });
  const rest = {
    pulls: { get: data(() => { s.reads++; s.beforeRead?.(s.reads); return s.pr; }), list: async () => [s.pr], listReviews: async () => s.reviews, listFiles: async () => s.files,
      merge: data(args => { s.merges.push(args); return { merged: true, sha: 'c'.repeat(40) }; }) },
    repos: { getBranch: data(() => ({ commit: { sha: s.base } })), compareCommitsWithBasehead: data(() => ({ status: s.comparison })), listCommitStatusesForRef: async () => s.statuses },
    git: { getTree: data(() => tree(s.files)) },
    actions: { listWorkflowRuns: data(() => ({ workflow_runs: s.ci })), listJobsForWorkflowRun: async () => s.jobs, createWorkflowDispatch: async args => s.dispatches.push(args) },
    checks: { listForRef: async () => s.checks }, issues: { createComment: async args => s.comments.push(args) },
  };
  const github = { rest, paginate: async (fn, args) => fn(args), graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: s.threads, pageInfo: { hasNextPage: false } } } } }) };
  return { s, github, context: { repo: { owner: 'millw14', repo: 'merrymen' } }, core: { info() {}, setFailed: text => s.failures.push(text) } };
}
test('full gate accepts the verified revision and merge pins its SHA', async () => {
  const f = fixture();
  await run(f);
  assert.equal(f.s.merges.length, 1);
  assert.equal(f.s.merges[0].sha, HEAD);
  assert.equal(f.s.merges[0].merge_method, 'squash');
  assert.equal(f.s.dispatches[0].workflow_id, 'ci.yml');
  assert.equal(f.s.comments.length, 1);
});
for (const [name, mutate] of Object.entries({
  'draft': s => { s.pr.draft = true; },
  'owner PR': s => { s.pr.user.id = 76665166; },
  'hold label': s => { s.pr.labels = [{ name: 'kaka:hold' }]; },
  'unknown mergeability': s => { s.pr.mergeable = null; },
  'blocked protection': s => { s.pr.mergeable_state = 'blocked'; },
  'stale main': s => { s.base = HEAD; },
  'stale head': s => { s.pr.head.sha = BASE; },
  'diverged branch': s => { s.comparison = 'diverged'; },
  'unresolved thread': s => { s.threads = [{ isResolved: false }]; },
  'spoofed CI path': s => { s.ci[0].path = '.github/workflows/fake.yml'; },
  'wrong PR CI': s => { s.ci[0].pull_requests = [{ number: 99 }]; },
  'failed CI': s => { s.ci[0].conclusion = 'failure'; },
  'missing required job': s => { s.jobs.pop(); },
  'pending check': s => { s.checks = [{ status: 'in_progress', conclusion: null }]; },
  'failed status': s => { s.statuses = [{ context: 'Vercel', state: 'failure' }]; },
  'code change': s => { s.files = [file('worker/src/index.ts')]; },
  'push during gate': s => { s.beforeRead = n => { if (n === 2) s.pr.head.sha = BASE; }; },
})) test(`${name} prevents merge`, async () => {
  const f = fixture(); mutate(f.s); await run(f); assert.equal(f.s.merges.length, 0);
});
test('API failures fail closed and are visible', async () => {
  const f = fixture(); f.github.graphql = async () => { throw new Error('unavailable'); };
  await run(f); assert.equal(f.s.merges.length, 0); assert.equal(f.s.failures.length, 1);
});
test('review thread pagination includes findings after first page', async () => {
  const f = fixture(); let calls = 0;
  f.github.graphql = async (_query, vars) => {
    calls++;
    assert.equal(vars.cursor, calls === 1 ? null : 'next');
    return { repository: { pullRequest: { reviewThreads: {
      nodes: [{ isResolved: calls === 1 }], pageInfo: { hasNextPage: calls === 1, endCursor: 'next' },
    } } } };
  };
  const result = await evaluate({ github: f.github, owner: 'millw14', repo: 'merrymen', number: 7 });
  assert.equal(result.eligible, false); assert.equal(calls, 2);
});
