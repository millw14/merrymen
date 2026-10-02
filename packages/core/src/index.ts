export * from "./chain";
export * from "./settings";
export * from "./llm-providers";
export * from "./tokens";
export * from "./token";
// ENERGY — what $MERRYMEN is for on the hosted service: the thresholds, the
// report the worker publishes, and the one route an agent may buy it through.
export * from "./energy";
export * from "./protocols";
export * from "./official-coins";
export * from "./abis";
export * from "./grant";
export * from "./holder-proof";
export * from "./derivation";
export * from "./explain";
// A NAME FOR AN AGENT NOBODY NAMED, seeded on the slug so the grants route and
// the Agent screen offer the same one without a round trip.
export * from "./agent-name";
export * from "./hosted";
export * from "./wall";
// The per-account vault address the wall pins, resolved from the factory at
// signing time. Separate from wall.ts because that file is pure and this one
// reads the chain.
export * from "./classvault";
export * from "./mcp";
export * from "./safe-url";
export * from "./robinhood-oauth";
export * from "./flow-evidence";
export * from "./capital-classify";

// WHETHER AN AGENT CAN ACT ON ITS OWN, and why not when it cannot. Here rather
// than in the worker because the dashboard, the chat and the feed all render
// these words, and a second copy in the web tier is how one surface comes to
// say "add funds" while another says "re-sign".
export * from "./autonomy";

// WHETHER A P&L HAS HAD ITS GAS TAKEN OUT. Three sites derived this and all
// three read a sponsored agent's measured zero as an absence.
export * from "./gas-basis";

// WHAT A PERMISSION WALL COSTS TO INSTALL, derived from the wall itself, so the
// signer and the executor cannot drift about which walls are deployable.
export * from "./first-enable-gas";

// THE CANONICAL PORTFOLIO SNAPSHOT. One type, one builder, four consumers —
// worker, web, social and Brain. Exported from core precisely so none of them
// can grow its own NAV or P&L implementation.
export * from "./portfolio-snapshot";

// ONE SERIES, ONE BOOK. The paper and funded books both write to `equity`;
// this is the rule every reader of that series applies to tell them apart.
export * from "./equity-book";

// "SNIPE PEPE WITH $20" — one typed word to one token, and never a guess when
// two coins share a ticker.
export * from "./snipe-target";

// ONE DIAL INSTEAD OF SIX — a risk level a beginner can answer, and an honest
// account of the two caps only a signature can move.
export * from "./risk-level";

// WHO ACTUALLY HOLDS THIS COIN — ChainMind's holder, transfer and swap
// forensics, ported as the pure analysis behind the `onchain` lens.
export * from "./onchain-forensics";
export * from "./trencher-vault";
export * from "./grant-installable";

// WAS THIS GRANT SIGNED AGAINST AN OLDER WALL? A release date, enforced by a
// fingerprint test, because `serialized` never leaves the browser that minted it.
export * from "./wall-release";

export * from "./chat-math";
