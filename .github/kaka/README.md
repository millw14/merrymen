# Kaka PR processor

Kaka reviews outside contributions hourly using a Codex task heartbeat and the
existing GitHub login. GitHub runs the deterministic merge gate after CI and
every 15 minutes. Local scheduled reviews require the Codex host to be available;
GitHub's merge gate continues independently for already-reviewed revisions.

## Review procedure

1. Fetch main and read this policy and root AGENTS.md from main. List open,
   non-draft PRs targeting main from authors other than millw14. Do not execute
   contributor code on the local host. Read diffs and relevant source through
   GitHub, and inspect the isolated GitHub CI results and prior review threads.
2. Assess usefulness, correctness, compatibility, tests and unresolved concerns.
   Post a GitHub COMMENT review beginning "I'm Kaka, Milla's automated reviewer."
   Give one verdict: Worth merging, Needs changes, or Not recommended. Include
   concise evidence and limitations. Be courteous; strict is not hostile.
3. Review all contribution types, but reserve automatic eligibility for at most
   10 modified regular files and 300 changed lines, limited to README.md,
   docs/**/*.md and web/src/**/*.css or site/src/**/*.css. No file additions,
   removals or renames. No agent instruction files (AGENTS, CLAUDE, GEMINI,
   SKILL). Documentation must not alter financial/risk/security instructions,
   advertise unverified claims or suggest unsafe commands. CSS must not obscure
   warnings, balances, permissions, consent or trade controls, or introduce
   external requests, tracking or misleading states. Uncertainty means no merge.
4. Eligibility also requires the branch to contain current main, clean merge
   state, successful app/contracts/gateway/kaka-policy jobs from the repository's
   CI pull_request workflow at the current head, no other failing/pending checks,
   no outstanding changes-requested reviews and no unresolved review threads.
   Inspect the actual changed behavior; do not infer usefulness from filenames.
5. For a fully verified eligible PR, post a COMMENT review with commit_id set
   explicitly to the reviewed head SHA. End the review with exactly this marker
   (replace both SHAs with the actual 40-character lowercase commit IDs):

   <!-- kaka:auto-merge:v1 head=HEAD_SHA base=MAIN_SHA -->

   This is permission to merge that exact revision against that exact base.
   Only reviews from GitHub user ID 76665166 (millw14) are trusted by the gate.
   The native Codex bot's findings remain supporting evidence, not authorization.
6. For any other verdict, omit the marker. Never post an eligibility marker on
   Milla's own PR or on this processor's configuration changes. Do not merge from
   the scheduled review task; let the workflow enforce the gate with its token.
7. Do not repeat reviews for an unchanged head/base/evidence. Re-evaluate after
   new commits, base changes, CI completion or contributor responses. Preserve
   public review history. Never claim an unobserved test or completed merge.

## Merge gate and controls

`.github/workflows/kaka-auto-merge.yml` checks fresh GitHub state and uses an
expected head SHA when squash-merging. It executes only code from main, never
checks out a contributor branch, and receives no production secrets. All check
runs/statuses must succeed, including Vercel if present; authentication failures
are not silently ignored. Both old and new review-thread findings block merging
until resolved. A newer owner review supersedes an older eligibility marker.

Set repository variable KAKA_AUTO_MERGE to true to enable the gate, or false to
stop it. A missing variable disables it. Disable the hourly Codex heartbeat to
stop automated comments as well. The gate processes PRs in oldest-first order;
every PR is evaluated independently.

Merges made using GITHUB_TOKEN do not trigger ordinary push workflows. The gate
therefore explicitly dispatches CI on main after a successful merge. If that
dispatch fails, the gate fails visibly; the merge itself has already completed.
No changes are made to branch-protection bypass lists or required approvals.

## Verification

Run `node --test .github/kaka/gate.test.cjs`. The CI kaka-policy job runs the same
tests for future PRs. The rules are enforced in code, not just in the AI prompt.
