/**
 * LLM drivers for the strategist. The driver's ONLY job is: signals in,
 * raw proposal JSON out. It never sees addresses, never builds intents, and
 * its output goes straight into parseProposals → proposalsToIntents where
 * deterministic code disposes.
 *
 * AnthropicDriver: Claude via the Messages API with a forced, strict-schema
 * tool call — the model cannot reply in prose, only in the proposal schema.
 * NullDriver: what runs when no ANTHROPIC_API_KEY is set — proposes nothing.
 */

import Anthropic from "@anthropic-ai/sdk";

/** Sanitized, typed market signals — numbers and enums only, no free text. */
export interface Signals {
  cashUsdg: number;
  vaultUsdg: number;
  equityUsdg: number;
  holdings: { symbol: string; valueUsdg: number; priceStale: boolean }[];
  prices: { symbol: string; usd: number; stale: boolean }[];
  tradableSymbols: string[];
  maxPerActionUsdg: number;
  utcHour: number;
  utcDay: number;
}

export interface ProposalDriver {
  name: string;
  propose(signals: Signals): Promise<unknown>;
}

/** No key, no model, no trades — the safe default. */
export const nullDriver: ProposalDriver = {
  name: "null",
  propose: async () => ({ actions: [] }),
};

const SYSTEM = `You are the strategist for a stock-token trading agent on Robinhood Chain.
Tokenized equities trade 24/7 while underlying markets close nights and weekends; Chainlink
prices are stale when markets are closed (that is expected, not an error). Idle cash earns
vault yield automatically — you do not manage the vault.

Propose portfolio actions via the propose_trades tool. Discipline rules:
- Only trade symbols from tradableSymbols. Sizes are in USDG and must respect maxPerActionUsdg.
- Prefer few, deliberate actions; propose holds when nothing is attractive.
- You cannot see order books; execution is quote-simulated and slippage-bounded downstream,
  and every action passes a policy wall you cannot override. Propose intent, not execution.`;

const PROPOSE_TOOL = {
  name: "propose_trades",
  description:
    "Propose the portfolio actions for this decision window. Every action is validated " +
    "against hard policy caps downstream; oversized or out-of-universe actions are dropped.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["buy", "sell", "hold"] },
            symbol: { type: "string" },
            sizeUsdg: { type: "number" },
            reason: { type: "string" },
          },
          required: ["action", "symbol", "sizeUsdg", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  },
};

export function createAnthropicDriver(opts: { apiKey: string; model?: string }): ProposalDriver {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? "claude-opus-4-8";

  return {
    name: `anthropic:${model}`,
    async propose(signals: Signals): Promise<unknown> {
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM,
        // Forced tool_choice requires thinking off; the schema does the shaping.
        thinking: { type: "disabled" },
        tools: [PROPOSE_TOOL],
        tool_choice: { type: "tool", name: "propose_trades" },
        messages: [
          {
            role: "user",
            content: `Market and account signals:\n${JSON.stringify(signals, null, 2)}`,
          },
        ],
      });

      const toolUse = response.content.find((b) => b.type === "tool_use");
      return toolUse && toolUse.type === "tool_use" ? toolUse.input : { actions: [] };
    },
  };
}
