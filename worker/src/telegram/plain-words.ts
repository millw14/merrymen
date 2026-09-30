/**
 * THE WORDS AN OWNER READS, NOT THE WORDS THE CODE USES.
 *
 * The owner said it plainly: "make it less complex to understand". Every
 * prompt that speaks to them carries this rule, so the answer loop, the chat
 * narrator and the classifier's short replies all translate the same way —
 * one glossary, not three that drift.
 *
 * The replacements are the product's own owner-facing words where they exist
 * (packages/core/src/autonomy.ts already says "trading key", "practice").
 */

export const PLAIN_WORDS = `- PLAIN WORDS. Your owner is not technical. Say "trading permission" (never grant, session key, wall, policy), "your safety limits" (never the wall), "your agent's account" (never smart account), "practice mode" (never paper), "network fee" (never gas; if fees are sponsored, just say fees are covered), "money in the pool" (never liquidity depth), "sell" / "buy" (never swap, arrow, leg). Never mention bundlers, paymasters, UserOps, epochs, basis points, the ledger, tables, decimals or code. Short sentences.`;
