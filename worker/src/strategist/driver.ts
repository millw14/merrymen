/**
 * LLM driver for the strategist. The driver's ONLY job is: signals in,
 * raw proposal JSON out. It never sees addresses, never builds intents, and
 * its output goes straight into parseProposals → proposalsToIntents where
 * deterministic code disposes.
 *
 * The brain is provider-agnostic (Groq by default, Claude as the upgrade) via
 * the shared llm layer's forced, strict-schema tool call — the model cannot
 * reply in prose, only in the proposal schema.
 * NullDriver: what runs when no LLM key is set — proposes nothing.
 */

import { llmToolCall, type LlmCreds } from "../llm";

/** Sanitized, typed market signals — numbers and enums only, no free text. */
export interface Signals {
  cashUsdg: number;
  vaultUsdg: number;
  equityUsdg: number;
  /**
   * What is held, what it is worth, and — when the ledger knows — what it cost.
   *
   * `costUsdg` and `pnlUsdg` are ABSENT rather than zero when there is no cost
   * basis on record. Zero would tell the model the whole position is profit,
   * which is the original accounting bug in miniature; absent is a fact it can
   * reason about instead of a number it would act on.
   */
  holdings: {
    symbol: string;
    valueUsdg: number;
    priceStale: boolean;
    costUsdg?: number;
    pnlUsdg?: number;
  }[];
  prices: { symbol: string; usd: number; stale: boolean }[];
  tradableSymbols: string[];
  /**
   * The mechanical floor sitting below the model, in bps. ABSENT when none is
   * armed — never 0, which would read as a floor at break-even rather than as
   * no floor at all. Same discipline `costUsdg` follows.
   */
  stopLossBps?: number;
  maxPerActionUsdg: number;
  utcHour: number;
  utcDay: number;
  /**
   * Pool liquidity per symbol, when it has been read. Kept to four numbers a
   * token on purpose: the model has a 2048-token budget for its whole answer,
   * and a full tick ladder would spend the reply on a histogram it cannot act
   * on. These four are the ones that change a decision — how much fits, and
   * where the next wall is either side.
   */
  depth?: {
    symbol: string;
    /** USDG buyable before price rises >0.5%. */
    buyUsdg: number;
    /** USDG sellable before price falls >0.5%. */
    sellUsdg: number;
    supportUsd: number | null;
    resistanceUsd: number | null;
  }[];
  /**
   * THE AGENT'S PERPETUALS, present ONLY in a window where they are offered:
   * perps enabled, the strategist the perps driver, and Lighter read. ABSENT
   * otherwise — and absent means the Signals JSON, the tool schema and the
   * system prompt are byte-for-byte what they were before perps existed, for
   * every agent that does not trade them.
   */
  perps?: PerpSignals;
}

/**
 * What a model is told about the perp book: numbers and enums only. NO market
 * ids, NO venue integers, NO addresses — prices are rendered as decimals for
 * reading, and everything the model sends back is a market KEY and a USDG
 * figure the boundary rebuilds from the venue's own integers.
 */
export interface PerpSignals {
  /** USDG posted at Lighter as cross collateral. */
  collateralUsdg: number;
  /** Of that, not tied up in a position's margin. */
  freeCollateralUsdg: number;
  /** Room left under the owner's total open-size limit. */
  openNotionalLeftUsdg: number;
  /** The most one new position may be (its full size, not its margin). */
  maxPerOpenUsdg: number;
  /** The stop distance an open may carry, percent. */
  minStopPct: number;
  maxStopPct: number;
  opensLeftToday: number;
  markets: {
    key: string;
    mark: number;
    index: number | null;
    /** Percent per hour; positive means longs pay shorts. Null = not read. */
    fundingPctPerHour: number | null;
    status: "active" | "reduce-only" | "inactive";
    /** Set per market from the owner's setting — never chosen by the model. */
    leverage: number;
    /** The smallest order the venue takes there, USDG. */
    minOrderUsdg: number;
  }[];
  positions: {
    key: string;
    side: "long" | "short";
    notionalUsdg: number;
    entry: number;
    mark: number;
    unrealizedPnlUsdg: number;
    liqPrice: number | null;
    liqDistancePct: number | null;
    /** The stop resting at the venue (its trigger), or null when none is seen resting. */
    stopPrice: number | null;
    /** Funding since open, signed from the holder's side: negative means it was paid. */
    fundingUsdg: number;
    heldHours: number;
  }[];
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
- A FLOOR MAY SIT BELOW YOU. When \`stopLossBps\` is present, a mechanical rule sells a holding
  outright once it is that far below what it cost. It only ever FORCES an exit and never prevents
  one, so cutting earlier is always available to you. It is a backstop for the case where you were
  wrong and had not noticed — never a level to hold a losing position down to because it is there.
- YOU ARE ALSO RESPONSIBLE FOR LEAVING. A holding may carry \`costUsdg\` and \`pnlUsdg\` — what
  it cost and what it is up or down since. Use them: take a profit that is worth taking, cut
  a loss that is running, and leave a position whose reason has stopped being true. A position
  you never close is not a decision you deferred, it is a decision you made.
  Where \`costUsdg\` is ABSENT the ledger has no entry price for that holding — you do not know
  whether you are up on it, and you must not assume you are. Say so rather than sizing off it.
  \`priceStale\` means the market for it is closed, so the P&L beside it is last week's number.
- There is no order book on this chain, so you cannot see one. When \`depth\` is present it is
  the next best thing and a different thing: pool liquidity. Per symbol it gives the USDG you
  could trade before moving the price more than 0.5%, and the nearest prices where liquidity
  clusters. Size to buyUsdg/sellUsdg — proposing above it moves the price against yourself.
  Treat support/resistance as context, never as a signal on their own: that liquidity is
  posted by market makers who can withdraw it in a block, and a cluster is nobody's resting
  order. A symbol missing from \`depth\` simply has not been read; it is not a warning.
- Execution is quote-simulated and slippage-bounded downstream, and every action passes a
  policy wall you cannot override. Propose intent, not execution.`;

/**
 * The perp paragraph, appended to SYSTEM only in a window that offers perps.
 * Every sentence is a fact the owner consented to (docs/perps.md rule 1) put
 * the way a model will act on it: collateral and liquidation, leverage that is
 * NOT the model's, hourly funding, the mandatory stop, shorts only as perps and
 * never spelled "sell", no adds and no flips, and a perp key that is not the
 * token of the same name.
 */
export const PERP_SYSTEM = `PERPETUALS ARE ALSO OPEN TO YOU THIS WINDOW, through \`perpActions\` — separate from \`actions\`.
- A perp is a leveraged position on Lighter, not a token you hold. It is backed by COLLATERAL — USDG
  posted at Lighter (\`perps.collateralUsdg\`, \`perps.freeCollateralUsdg\`) — and it can be
  LIQUIDATED: if the price moves far enough against it, the venue closes it and its margin is lost.
  Each position's \`liqPrice\` and \`liqDistancePct\` say how far away that is.
- LEVERAGE IS SET BY THE OWNER, NOT BY YOU. Each market's \`leverage\` is fixed from the owner's
  setting and is not yours to choose or to ask for. You choose a market, a side, a size
  (\`notionalUsdg\` — the whole position, not its margin) and a stop distance, and nothing else.
  Size inside \`maxPerOpenUsdg\` and \`openNotionalLeftUsdg\`, and above the market's \`minOrderUsdg\`.
- FUNDING IS PAID OR RECEIVED EVERY HOUR a position is open (\`fundingPctPerHour\`: positive means
  longs pay shorts). Held against you it is a recurring cost, not a one-off fee.
- EVERY OPEN MUST CARRY A STOP: \`stopPct\`, between \`minStopPct\` and \`maxStopPct\`. It rests at the
  venue from the moment the position exists. An open without one is refused, never repaired.
- SHORTS EXIST ONLY AS PERPS: a short is \`effect: "open", side: "short"\` in \`perpActions\`. Never
  spell a short "sell" — a "sell" in \`actions\` only ever sells a spot token already held.
- Never add to or flip a position: one position per market. To get out, \`effect: "close"\` takes all
  of it and \`"reduce"\` part of it, each naming the side you HOLD.
- \`BTC-PERP\`, \`TSLA-PERP\` and the rest are perp markets, not the tokens of the same name: a perp
  key never goes in \`actions\`, and a spot symbol never goes in \`perpActions\`.
- PERPS ARE NEVER PUBLISHED. Say what you think about a perp only in that perp action's own
  \`reason\`; keep perps out of every other reason and out of any public view you write.`;

/** The keys a window's `perpActions` may name: the markets read, plus any market a position is held in. */
export function perpKeysOf(perps: PerpSignals): string[] {
  const keys: string[] = [];
  for (const m of perps.markets) if (!keys.includes(m.key)) keys.push(m.key);
  for (const p of perps.positions) if (!keys.includes(p.key)) keys.push(p.key);
  return keys;
}

/**
 * The `perpActions` property, for one window's market keys. No leverage and
 * no take-profit field: leverage is venue state from the owner's setting, the
 * take is the owner's perpsTakeProfitPct. Never in the tool's top-level
 * `required` — Groq validates arguments server-side and rejects an emission
 * missing a required field (see the `reason` note below), and a window with
 * nothing to do on perps must not fail for leaving it out.
 */
export function perpActionsSchema(keys: readonly string[]) {
  return {
    type: "array",
    description: "Perpetual actions for this window. Leave it out, or empty, when there is nothing to do on perps.",
    items: {
      type: "object",
      properties: {
        market: { type: "string", enum: [...keys] },
        effect: { type: "string", enum: ["open", "reduce", "close"] },
        side: {
          type: "string",
          enum: ["long", "short"],
          description: "For an open, the side to take. For a reduce or close, the side you HOLD.",
        },
        notionalUsdg: {
          type: "number",
          description: "USDG: an open's whole position size (not its margin); how much to cut for a reduce; ignored for a close.",
        },
        stopPct: {
          type: "number",
          description: "An open's stop distance from its entry, percent, between minStopPct and maxStopPct. Required for an open.",
        },
        reason: {
          type: "string",
          description: "One sentence for THIS action, under 200 characters, citing the figures that decided it.",
        },
      },
      required: ["market", "effect", "side", "notionalUsdg"],
      additionalProperties: false,
    },
  };
}

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
            reason: {
              type: "string",
              // UNDESCRIBED UNTIL NOW, WHICH IS WHY THE FEED READ LIKE A LEDGER.
              // This string IS the thesis for every tenant not running the desk
              // — which is most of them — and the schema asked for it without
              // saying what it was for, so models returned a restatement of the
              // action ("buy NVDA") or nothing. Same wording as the desk's
              // thesis field so the two rails sound like one agent.
              description:
                "One sentence for THIS action, under 200 characters, in your own voice, citing the figures that decided " +
                "it. This is published — write it for a reader who was not here. Grounded only in " +
                "what you were shown; no invented numbers and no predictions you cannot support.",
            },
          },
          // "reason" optional: Groq validates arguments server-side and llama
          // sometimes omits it; parseProposals defaults it to "" anyway. The
          // description above guides it without requiring it — making it
          // required would break the provider production actually runs on.
          required: ["action", "symbol", "sizeUsdg"],
          additionalProperties: false,
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  },
};

/**
 * The system prompt and tool for one window — built per call because a
 * window that offers perps carries their paragraph and their property, and
 * one that does not must be EXACTLY today's request (strategist/perp-boundary.test.ts
 * pins its hash). `perpActions` goes into `properties` only, never into `required`.
 */
export function proposeRequest(signals: Signals): { system: string; tool: { name: string; description: string; schema: Record<string, unknown> } } {
  const keys = signals.perps ? perpKeysOf(signals.perps) : [];
  if (keys.length === 0) {
    return { system: SYSTEM, tool: { name: PROPOSE_TOOL.name, description: PROPOSE_TOOL.description, schema: PROPOSE_TOOL.input_schema } };
  }
  const base = PROPOSE_TOOL.input_schema;
  return {
    system: `${SYSTEM}\n\n${PERP_SYSTEM}`,
    tool: {
      name: PROPOSE_TOOL.name,
      description: PROPOSE_TOOL.description,
      schema: { ...base, properties: { ...base.properties, perpActions: perpActionsSchema(keys) } },
    },
  };
}

export function createDriver(creds: LlmCreds): ProposalDriver {
  return {
    name: `${creds.provider}:${creds.model}`,
    async propose(signals: Signals): Promise<unknown> {
      const req = proposeRequest(signals);
      return llmToolCall(creds, {
        system: req.system,
        maxTokens: 2048,
        tool: req.tool,
        messages: [{ role: "user", content: `Market and account signals:\n${JSON.stringify(signals, null, 2)}` }],
      });
    },
  };
}
