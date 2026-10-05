#!/bin/sh
# The hosted image's start step: ONE image, THREE roles, picked per Railway
# service by MERRYMEN_START. The Dockerfile runs it as
#
#   /usr/bin/tini -- /bin/sh /app/scripts/container-start.sh
#
# WHY THIS FILE EXISTS INSTEAD OF `sh -c "npm run …"`.
#
# The image used to start with CMD ["sh", "-c", "npm run ${MERRYMEN_START…}"],
# which put a shell, npm and npm's own `sh -c` between PID 1 and node. Railway
# stops a deployment by sending SIGTERM to PID 1 — and PID 1 is the one process
# the kernel gives no default signal action: a signal it has no handler for is
# simply dropped. So whether the stop ever reached the orchestrator's handler
# (the one that calls the fleet home, carries a pending Telegram kill to the
# store and releases the tenant leases for the replica taking over) rested on
# details nobody here owns: whether each shell happened to exec its one
# command, and whether npm, as PID 1, passed the signal on. npm as PID 1 also
# reaps nothing, and is a second node process idling for the container's life.
#
# Now tini is PID 1 (the Dockerfile's ENTRYPOINT): it forwards SIGTERM to its
# one child and reaps the orphans PID 1 inherits. Its child is THIS script, and
# every role below `exec`s — the shell REPLACES itself with node (or next, which
# is node) under the same PID, so the signal tini forwards lands on the process
# that handles it. Nothing may run after an exec, and nothing may sit between
# tini and node: a wrapper that forks instead of exec'ing puts the signal back
# on the wrong process. worker/src/container-start.test.ts holds all of this.
#
# THE COMMANDS ARE package.json's start scripts, spelled out. npm is gone from
# the start path because it forks, not because the commands changed; the test
# runs both against the same stubs and requires identical argv and cwd. It
# also reads the role `case` below as sh does and requires its patterns — all
# of them, whatever they look like — to be exactly the `start:*` scripts
# there, one per branch, each exec'ing once, with the `*)` refusal last; and
# nothing outside those branches may exec at all. A new role is a package.json
# start script first, and a branch here second.
#
# Plain POSIX sh: the image's /bin/sh is Debian's dash, not bash. LF endings
# only (.gitattributes) — a CR would ride into every word on every line.
set -eu

# `-` and NOT `:-`, deliberately.
#
# Unset means the web service, as it always has. SET BUT EMPTY means somebody
# cleared the variable instead of deleting it — on the orchestrator service, a
# supervisor about to come up as a dashboard: green, healthy-looking, and with
# the fleet it should be running simply gone. `:-` would do exactly that, and
# quietly. `-` lets the empty string fall through to the refusal below.
role=${MERRYMEN_START-start:web}

# Which build this is, for the one line every start prints. Railway sets the
# variable at runtime; anything that is not a hex SHA is reported as unknown
# rather than copied into the log (it is an environment value, not ours).
commit=${RAILWAY_GIT_COMMIT_SHA:-}
case $commit in
  '' | *[!0-9a-f]*) commit=unknown ;;
esac

# The app root is this file's parent's parent, whatever directory we were
# started from (WORKDIR is /app in the image, but nothing here relies on it).
cd "$(dirname "$0")/.."
# What `npm run` put on PATH for these same scripts, so `next` — and anything a
# role later runs by name — resolves exactly as it did under npm.
PATH="$(pwd)/node_modules/.bin:$PATH"
export PATH

started() {
  echo "[start] role=$role commit=$commit"
}

# THE DEPLOY GUARD, in every allowlisted branch, after the [start] line and
# before the exec (worker/src/deploy-guard.ts). On Railway it holds the fleet
# roles to their own service, a persistent home and this image, and refuses
# the orchestrator while a one-shot repair variable is still set mid-rollout;
# the web role gets the allowlist check only; off Railway it says it skipped.
#
# It is NOT exec'd: it runs, answers and exits, and only then does the role
# exec in this shell's place — so the role is still tini's one child.
# A refusal ends the script with the guard's own status (78, EX_CONFIG) before
# anything has started; `|| exit` says so here rather than leaving it to set -e.
guard() {
  node --import tsx worker/src/deploy-guard.ts --phase=start "--role=$role" || exit $?
}

case $role in
  start:web)
    started
    guard
    cd web
    exec next start -H 0.0.0.0 -p "${PORT:-3100}"
    ;;
  start:orchestrator)
    started
    guard
    exec node --import tsx worker/src/orchestrator.ts
    ;;
  start:recovery-replies)
    started
    guard
    exec node --import tsx worker/src/recovery-replies.ts
    ;;
  *)
    # 64 is EX_USAGE: the configuration is wrong, not the code. Nothing has
    # started, so nothing needs stopping; Railway's ON_FAILURE policy retries a
    # few times and then shows the deploy as crashed, which is the point — a
    # loud failure instead of the wrong role running green. The value itself is
    # not printed: it is whatever was pasted into the variable.
    if [ -z "$role" ]; then
      echo "[start] refused: MERRYMEN_START is set but empty — delete it for the web role, or name one of: start:web start:orchestrator start:recovery-replies" >&2
    else
      echo "[start] refused: MERRYMEN_START is not one of: start:web start:orchestrator start:recovery-replies" >&2
    fi
    exit 64
    ;;
esac
