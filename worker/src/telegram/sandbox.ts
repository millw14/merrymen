#!/usr/bin/env tsx
/**
 * Sandbox REPL wired to the Telegram interpreter/service — no token, no network.
 * Type a message + Enter → see what the bot would reply, with thinking-dump stripped.
 * Covers: slash, natural language via mocked LLM, bare "5" follow-up, and history sanitization.
 *
 * Usage: npx tsx worker/src/telegram/sandbox.ts
 * Then type e.g.  hi  |  /status  |  buy QQQ  |  5  |  5usdg  |  <think>reasoning</think>hello
 * Ctrl+C to exit.
 */

import * as readline from "node:readline";
import { stripThinkingBlock, parseSlash } from "./interpreter";

// --- Mock LLM: universal fix keeps thinking in separate reasoning bank, not in content ---
// With llm.ts reasoning_effort none, hi/5 no longer dump thinking into content.
// Content is clean, reasoning (if any) is separate and discarded — no prefix needed.
function mockLlmTextDump(userText: string): string {
  const t = userText.trim().toLowerCase();
  if (t === "hi") return `Hey there, good to see you — our QQQ is holding steady.`;
  if (t === "5" || t === "5usdg") return `Here's a thinking process:\n\n1. **Analyze**\n\nHey there — should not happen, bare-amount now bypasses LLM entirely`;
  if (t.includes("<think>")) return `<think>hidden chain of thought that should never reach the user</think>\n\nHey — I'm here.`;
  if (t.includes("reasoning_content")) return `reasoning_content dump should be ignored\n\nActual warm reply.`;
  return `Warm reply to: ${userText}`;
}

// Bare-amount detection mirrors service.ts askAmountCtx pre-check
const askAmountCtx = new Map<number, { side: "buy" | "sell"; symbol: string }>();
const chatId = 123;
let lastAssistantAskedForAmount = false;

function handleBareAmount(text: string): string | null {
  const pending = askAmountCtx.get(chatId);
  const bareMatch = text.trim().match(/^\s*(\d+(?:\.\d+)?)\s*(usdg|usd)?\s*$/i);
  if (pending && bareMatch) {
    const n = Number(bareMatch[1]);
    if (Number.isFinite(n) && n > 0) {
      askAmountCtx.delete(chatId);
      return `✅ would execute ${pending.side} ${pending.symbol} ${n} USDG (askAmountCtx consumed, no LLM)`;
    }
  }
  if (bareMatch && !pending) {
    const n = Number(bareMatch[1]);
    if (Number.isFinite(n) && n > 0) {
      return `to trade, tell me a ticker and a USDG amount, e.g. 'buy 10 of QQQ' — you sent just "${text.trim()}" (bare amount, no LLM)`;
    }
  }
  return null;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });

console.log("─ Telegram sandbox (thinking-dump + bare-amount) — type a message, see stripped reply ─");
console.log("  try: hi | /status | buy QQQ | 5 | 5usdg | <think>hidden</think>hello | Here\\'s a thinking process... | exit");
console.log(`  ld: llm.ts stripReasoningFromContent + interpreter.ts stripThinkingBlock + service.ts bare-amount pre-check`);
console.log("");

rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text || /^(exit|quit|q)$/i.test(text)) { rl.close(); return; }

  // 1. slash wins
  const slash = parseSlash(text);
  if (slash) {
    console.log(`  → slash: ${JSON.stringify(slash)}`);
    if (slash.kind === "buy" || slash.kind === "sell") {
      askAmountCtx.set(chatId, { side: slash.kind, symbol: (slash as any).symbol ?? "QQQ" });
      console.log(`  (askAmountCtx set for next bare amount: ${slash.kind} ${(slash as any).symbol})`);
    }
    rl.prompt(); return;
  }

  // 2. bare amount pre-check (must not hit LLM)
  const bare = handleBareAmount(text);
  if (bare) {
    console.log(`  bot> ${bare}`);
    console.log(`  (bare-amount path — no LLM, no thinking dump)`);
    // If the bot just asked for amount, remember it for next turn
    if (/tell me a ticker and a USDG amount/i.test(bare)) {
      // Try to infer symbol from last user that had buy/sell (here we just keep previous ask if any)
    }
    rl.prompt(); return;
  }

  // 3. natural language → mock LLM dump → strip
  const rawDump = mockLlmTextDump(text);
  const stripped = stripThinkingBlock(rawDump);

  console.log(`  raw LLM dump (simulated, would leak without fix):`);
  console.log(`  ┌ ${rawDump.split("\n").slice(0, 4).join("\n  │ ")}${rawDump.split("\n").length > 4 ? "\n  │ …" : ""}`);
  console.log(`  stripped → bot> ${stripped || "(empty — fallback to classifier)"}`);
  if (stripped !== rawDump) console.log(`  (stripThinkingBlock removed ${rawDump.length - stripped.length} chars of thinking)`);

  // Simulate coerce -> chat reply that asks for ticker, to set askAmountCtx for next "5"
  if (/buy|sell/i.test(text) && !text.match(/\d+/)) {
    askAmountCtx.set(chatId, { side: /sell/i.test(text) ? "sell" : "buy", symbol: (text.match(/\b([A-Za-z]{2,6})\b/g)?.find(s => !/buy|sell/i.test(s))?.toUpperCase() ?? "QQQ") });
    console.log(`  (bot would reply "to buy, tell me a ticker and a USDG amount" — askAmountCtx set for next bare amount: ${askAmountCtx.get(chatId)?.side} ${askAmountCtx.get(chatId)?.symbol})`);
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\nSandbox closed. Tests to run before commit: npm run typecheck && npm test");
  process.exit(0);
});
