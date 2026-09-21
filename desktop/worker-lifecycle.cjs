/**
 * Worker restart sequencing, extracted from desktop/main.js so it is
 * unit-testable — main.js runs under Electron and can never load in a test
 * runner. CommonJS because main.js requires it.
 *
 * The rule: never start the replacement before the old worker is gone.
 * Sending SIGTERM is not evidence of exit, and the Electron
 * single-instance lock stays held throughout, so it cannot protect this
 * path either. Overlapping workers would trade against the same account.
 */

"use strict";

/** Resolve true when child exits within timeoutMs, false on timeout. */
function waitForExit(child, timeoutMs, setTimeoutFn = setTimeout) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeoutFn(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      try {
        clearTimeout(t);
      } catch {
        /* best effort — injected fakes may return foreign handles */
      }
      resolve(true);
    });
  });
}

/**
 * One restart operation with single-flight: concurrent restart() calls
 * collapse into the running one instead of queueing kills. Returns the new
 * child from startWorker.
 */
function createRestarter({
  getCurrent,
  setCurrent,
  startWorker,
  killGraceful,
  killForce,
  onEvent = () => {},
  gracefulMs = 8000,
  forceMs = 5000,
  setTimeoutFn = setTimeout,
}) {
  let restarting = false;
  return {
    async restart() {
      if (restarting) return getCurrent();
      restarting = true;
      try {
        const old = getCurrent();
        setCurrent(null);
        if (old && old.exitCode === null && old.signalCode === null) {
          killGraceful(old);
          if (!(await waitForExit(old, gracefulMs, setTimeoutFn))) {
            onEvent("escalate");
            try {
              killForce(old);
            } catch {
              /* already gone */
            }
            await waitForExit(old, forceMs, setTimeoutFn);
          }
        }
        const next = startWorker();
        setCurrent(next);
        onEvent("started");
        return next;
      } finally {
        restarting = false;
      }
    },
  };
}

module.exports = { waitForExit, createRestarter };
