/**
 * WHAT TO DO ABOUT IT — the funding screen's half of the live blocker.
 *
 * The worker already writes a sentence per change (`liveBlockerText` in
 * `worker/src/exec-mode.ts`) and it is a good one, for an event log: it says
 * what is true. A funding panel needs a different sentence, because it is the
 * screen the owner is on when they can fix it, and the thing it must say is
 * what to send.
 *
 * WHY THIS EXISTS AT ALL, measured. Once the fleet stopped being SIGKILLed
 * mid-tick, a census of what actually blocks the live rail read:
 *
 *     no-gas 12 · wrong-chain 9 · dead-policy 6 · no-cash 2
 *
 * The largest bucket is agents funded with USDG and no ETH — whose owners were
 * reading "Send USDG to your agent's account on Robinhood Chain" and doing
 * exactly that, correctly, twice, while the agent could not pay for a single
 * operation. The fact was resolved every tick and published nowhere a screen
 * could read.
 *
 * NOT A SECOND OPINION. Nothing here decides anything: the verdict is the
 * child's, carried on `AgentStatus.liveBlocker`. This maps a name the worker
 * chose onto a sentence for one screen, and `live-blocker.test.ts` asserts the
 * map covers every rule `exec-mode.ts` defines — so a new refuse rule fails a
 * test here rather than rendering as nothing on a funding page.
 */

/** What a funding screen says about one blocker. Null where funding is not the fix. */
export interface BlockerAdvice {
  /** One line, addressed to the person who can act. */
  say: string;
  /** True when sending money to the deposit address is what clears it. */
  funding: boolean;
}

const ADVICE: Readonly<Record<string, BlockerAdvice>> = Object.freeze({
  // THE ONE THIS WAS BUILT FOR. Every operation pays its own fee before it
  // reaches the chain, and USDG cannot pay it.
  "no-gas": {
    say: "Your agent has no ETH, and every trade pays a network fee before it reaches the chain. Send a small amount of ETH to the same address — a few dollars covers a lot of trades.",
    funding: true,
  },
  "no-cash": {
    say: "Your agent has no USDG to trade with. Send USDG to the address below.",
    funding: true,
  },
  // MONEY IS NOT THE FIX FOR THESE THREE, and saying "add funds" would be the
  // exact failure this codebase keeps refusing: a screen that looks like it is
  // telling you what to do while being wrong about what would happen.
  "dead-policy": {
    say: "This agent's trading permission was signed before a fix and cannot reach the chain. Re-signing it is free and takes a moment — adding funds will not help until you do.",
    funding: false,
  },
  "wrong-chain": {
    say: "This agent's permission is for a different network than the one trading happens on. It needs a new grant on Robinhood Chain; funds sent here will sit unused.",
    funding: false,
  },
  "not-armed": {
    say: "This agent's trading key is not active yet, so it has no permission to trade with. It arms itself on the next pass — nothing to send.",
    funding: false,
  },
  "no-executor": {
    say: "No bundler is configured on this deployment, so nothing can be submitted to the chain. That is ours to fix, not yours.",
    funding: false,
  },
});

/**
 * The advice for a blocker, or null.
 *
 * NULL IS TWO ANSWERS AND NEITHER IS A PROBLEM: `blocker` is null when the
 * agent is trading for real, and also when it has never beaten. A caller that
 * wants to distinguish those reads `mode` and `workerAliveAt`; a caller that
 * just wants to know whether to warn does not need to.
 *
 * An UNKNOWN rule also returns null rather than a guess. A name this build has
 * not seen is a newer worker talking to an older page, and inventing advice for
 * it would be worse than silence.
 */
export function blockerAdvice(blocker: string | null | undefined): BlockerAdvice | null {
  if (!blocker) return null;
  return ADVICE[blocker] ?? null;
}

/** Every rule this page knows how to talk about. Read by the drift test. */
export const ADVISED_RULES: readonly string[] = Object.keys(ADVICE);
