/**
 * Generation guard for async previews (swap quotes): the debounce cancels
 * only the timer, never an in-flight fetch, so an older request can resolve
 * after a newer one. Only the latest generation may write component state.
 *
 * Framework-free on purpose — the rule is testable without mounting React,
 * and the component stays a thin wire-up (see Swap.tsx).
 */
export interface QuoteGuard {
  /** Claim the next generation (call when STARTING a fetch). */
  next(): number;
  /** True when this generation is still the latest (call before APPLYING). */
  isCurrent(gen: number): boolean;
  /** Retire whatever is in flight (call when the input clears/changes). */
  invalidate(): void;
}

export function createQuoteGuard(): QuoteGuard {
  let gen = 0;
  return {
    next: () => ++gen,
    isCurrent: (g: number) => g === gen,
    invalidate: () => {
      gen += 1;
    },
  };
}
