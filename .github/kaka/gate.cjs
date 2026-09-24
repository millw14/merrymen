'use strict';

const OWNER_ID = 76665166;
const REQUIRED = ['app', 'contracts', 'gateway', 'kaka-policy'];
const marker = /<!-- kaka:auto-merge:v1 head=([a-f0-9]{40}) base=([a-f0-9]{40}) -->\s*$/;

function eligibleFiles(files, count, tree) {
  if (!files.length || files.length !== count || files.length > 10 || tree.truncated) return false;
  if (files.reduce((n, f) => n + f.additions + f.deletions, 0) > 300) return false;
  const modes = new Map(tree.tree.map(f => [f.path, f.mode]));
  return files.every(f => {
    const path = f.filename;
    return f.status === 'modified' && !f.previous_filename && modes.get(path) === '100644'
      && !/(^|\/)\./.test(path)
      && !/(^|\/)(AGENTS|CLAUDE|GEMINI|SKILL)\.md$/i.test(path)
      && (path === 'README.md' || /^docs\/(?!.*(?:^|\/)\.)[^\r\n]+\.md$/.test(path)
        || /^(web|site)\/src\/[^\r\n]+\.css$/.test(path));
  });
}

function authorized(reviews, head, base) {
  const submitted = reviews.filter(r => ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'].includes(r.state));
  const latest = new Map();
  const decisions = new Map();
  for (const r of [...reviews].sort((a, b) => a.id - b.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) decisions.set(r.user.id, r.state);
  }
  for (const r of [...submitted].sort((a, b) => a.id - b.id)) latest.set(r.user.id, r);
  if ([...decisions.values()].some(state => state === 'CHANGES_REQUESTED')) return false;
  const review = latest.get(OWNER_ID);
  const match = review?.body?.match(marker);
  return !!match && review.commit_id === head && match[1] === head && match[2] === base;
}

function greenJobs(jobs) {
  return REQUIRED.every(name => jobs.some(j => j.name === name && j.status === 'completed' && j.conclusion === 'success'))
    && jobs.every(j => j.status === 'completed' && j.conclusion === 'success');
}

async function unresolvedThreads(github, owner, repo, number) {
  let cursor = null;
  do {
    const result = await github.graphql(`query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        reviewThreads(first:100,after:$cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
      } }
    }`, { owner, repo, number, cursor });
    const threads = result.repository.pullRequest.reviewThreads;
    if (threads.nodes.some(t => !t.isResolved)) return true;
    if (!threads.pageInfo.hasNextPage) return false;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) throw new Error('Missing review-thread pagination cursor');
  } while (true);
}

async function evaluate({ github, owner, repo, number }) {
  const api = github.rest;
  const params = { owner, repo };
  const { data: pr } = await api.pulls.get({ ...params, pull_number: number });
  const stop = reason => ({ eligible: false, reason });
  if (pr.state !== 'open' || pr.draft || pr.user.id === OWNER_ID || pr.base.ref !== 'main'
      || pr.base.repo.full_name !== `${owner}/${repo}`) return stop('Not an external, ready PR into main');
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean') return stop('Merge state is not clean');
  if (pr.labels.some(l => ['do-not-merge', 'hold', 'kaka:hold'].includes(l.name))) return stop('Maintainer hold');
  const { data: base } = await api.repos.getBranch({ ...params, branch: 'main' });
  const head = pr.head.sha;
  const baseSha = base.commit.sha;
  const reviews = await github.paginate(api.pulls.listReviews, { ...params, pull_number: number, per_page: 100 });
  if (!authorized(reviews, head, baseSha)) return stop('No current Kaka authorization, or changes requested');
  const files = await github.paginate(api.pulls.listFiles, { ...params, pull_number: number, per_page: 100 });
  const { data: tree } = await api.git.getTree({ ...params, tree_sha: head, recursive: '1' });
  if (!eligibleFiles(files, pr.changed_files, tree)) return stop('Outside the low-risk allowlist');
  const { data: comparison } = await api.repos.compareCommitsWithBasehead({ ...params, basehead: `${baseSha}...${head}` });
  if (!['ahead', 'identical'].includes(comparison.status)) return stop('Update branch with current main first');
  if (await unresolvedThreads(github, owner, repo, number)) return stop('Unresolved review threads');

  // Validate the source workflow, event, revision, PR association and actual jobs;
  // a check with a matching display name is not sufficient evidence.
  const { data: runs } = await api.actions.listWorkflowRuns({ ...params, workflow_id: 'ci.yml', event: 'pull_request', head_sha: head, per_page: 100 });
  const run = runs.workflow_runs.filter(r => r.path === '.github/workflows/ci.yml'
    && r.head_sha === head && r.pull_requests.some(p => p.number === number))
    .sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') return stop('Current CI has not succeeded');
  const jobs = await github.paginate(api.actions.listJobsForWorkflowRun, { ...params, run_id: run.id, filter: 'latest', per_page: 100 });
  if (!greenJobs(jobs)) return stop('Required CI jobs missing or unsuccessful');
  const checks = await github.paginate(api.checks.listForRef, { ...params, ref: head, filter: 'latest', per_page: 100 });
  if (checks.some(c => c.status !== 'completed' || c.conclusion !== 'success')) return stop('A head check is pending or unsuccessful');
  const statuses = await github.paginate(api.repos.listCommitStatusesForRef, { ...params, ref: head, per_page: 100 });
  const latestStatuses = new Map();
  for (const status of statuses) if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
  if ([...latestStatuses.values()].some(s => s.state !== 'success')) return stop('A commit status is pending or unsuccessful');
  return { eligible: true, head, base: baseSha };
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  if (`${owner}/${repo}` !== 'millw14/merrymen') throw new Error('Unexpected repository');
  const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: 'main', sort: 'created', direction: 'asc', per_page: 100 });
  for (const pr of prs) {
    try {
      const result = await evaluate({ github, owner, repo, number: pr.number });
      if (!result.eligible) { core.info(`#${pr.number}: ${result.reason}`); continue; }
      // Recheck the full gate immediately before merging, not just the head SHA.
      const fresh = await evaluate({ github, owner, repo, number: pr.number });
      if (!fresh.eligible || fresh.head !== result.head || fresh.base !== result.base) continue;
      const merged = await github.rest.pulls.merge({ owner, repo, pull_number: pr.number, sha: fresh.head, merge_method: 'squash' });
      if (!merged.data.merged) throw new Error('GitHub declined merge');
      core.info(`#${pr.number}: merged ${merged.data.sha}`);
      await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: 'ci.yml', ref: 'main' });
      await github.rest.issues.createComment({ owner, repo, issue_number: pr.number,
        body: `I'm Kaka, Milla's automated reviewer. Merged after the current review, low-risk policy and CI checks passed. Commit: ${merged.data.sha}. CI on main has been requested.` });
    } catch (error) {
      core.setFailed(`#${pr.number}: merge gate failed closed (${error.status ?? error.message}). Inspect this run before retrying.`);
    }
  }
}

module.exports = { eligibleFiles, authorized, greenJobs, unresolvedThreads, evaluate, run };
