/** Public, read-only question focus. A scenario describes evidence, never an order. */
import type { TgDeskIntent, TgDeskThought } from "../telegram/tg-groups/types";

export function deskQuestionIntent(question: string): TgDeskIntent {
  const q = String(question ?? "").slice(0, 400).normalize("NFKC").toLowerCase().replace(/[’']/g, "'");
  if (/\b(?:compar(?:e|ing|ison)|versus|vs\.?|which (?:one|coin|token) (?:is|looks)|which is (?:stronger|better)|better than|stronger than)\b/.test(q) && !/\b(?:buyers?|sellers?)\b/.test(q)) return "comparison";
  if (/\b(?:risk[\s/-]*(?:to[\s/-]*)?reward|r\s*[:/]\s*r|rr|r:r)\b/.test(q)) return "risk-reward";
  if (/\b(?:scalp(?:ing)?|quick flip|quick trade|short[- ]term entry)\b/.test(q)) return "scalp";
  if (/\b(?:position siz(?:e|ing)|how much (?:should|can|would)|how big|allocation|leverage|risk per trade)\b/.test(q)) return "sizing";
  if (/\b(?:stop(?:[- ]?loss)?|invalidat\w*|cut (?:the |this )?(?:trade|position)|where (?:am i|are we|is it) wrong|what (?:would )?(?:breaks?|kills?|ruins?) (?:the |this )?(?:idea|setup|thesis))\b/.test(q)) return "invalidation";
  if (/\b(?:take[- ]profit|targets?|tp|upside|where (?:to |would (?:you|it) )?(?:exit|sell)|how high|next resistance|(?:should|would|can) (?:i|you|we) (?:sell|exit)|(?:i|you|we) (?:should|would|could|can) (?:sell|exit)|(?:what if|if) (?:i|you|we) (?:sell|exit)|(?:selling|exiting)\s+\d+)\b/.test(q)) return "targets";
  if (/\b(?:break\s*out|breakout|retest|fakeout|breakdown|reclaim|confirmation)\b/.test(q)) return "breakout";
  if (/\b(?:entry|entr(?:y|ies) point|enter|entries|good (?:time|spot) to (?:buy|get in)|buy now|buy the dip|pullback|dip buy|support|where (?:would|should|can) (?:you|i|we) (?:buy|get in)|(?:should|would|can) (?:i|you|we) (?:buy|enter)|(?:i|you|we) (?:should|would|could|can) (?:buy|enter)|(?:what if|if) (?:i|you|we) (?:buy|enter)|(?:buying|entering)\s+\d+|chase)\b/.test(q)) return "entry";
  if (/\b(?:time[ -]?frame|swing trad\w*|hold(?:ing)? (?:time|long)|how long|how old (?:is )?(?:the |this )?chart|how fresh|stale|how recent)\b/.test(q)) return "timeframe";
  if (/\b(?:rsi(?:14)?|ema(?:\s*(?:20|50))?|moving average|vwap|atr(?:14)?|indicator\w*|overbought|oversold)\b/.test(q)) return "indicators";
  if (/\b\d+\s*(?:m|min|minute|h|hour|d|day)(?:s)?\b/.test(q)) return "timeframe";
  if (/\b(?:rug|honeypot|scam|safe|safety|contract risk|audit|locked liquidity|liquidity (?:is )?locked)\b/.test(q)) return "safety";
  if (/\b(?:liquidity|depth|slippage|price impact|thin pool|volume.*liquidity)\b/.test(q)) return "liquidity";
  if (/\b(?:volume|buyers?|sellers?|flow|participation|whales?|accumulation|distribution)\b/.test(q)) return "volume";
  if (/\b(?:news|catalyst|announcement|story|project|theme|what does (?:it|this) do|why (?:is|was) (?:it|this|\w+) (?:pumping|dumping|moving))\b/.test(q)) return "news";
  if (/\b(?:did you (?:buy|sell)|are you (?:holding|buying|selling)|your (?:position|holdings|trade)|have you (?:bought|sold)|execute|place (?:an? )?order)\b/.test(q)) return "execution";
  if (/\b(?:predict\w*|forecast|guarantee\w*|win rate|probability|chance|will (?:it|this|\w+) (?:pump|rise|recover|moon|dump|fall)|next (?:hour|day|week)|tomorrow|bottom(?:ed)?|top(?:ped)?)\b/.test(q)) return "prediction";
  if (/\b(?:trend|structure|bullish|bearish|higher (?:high|low)s?|lower (?:high|low)s?|what (?:has )?changed|still valid|still (?:good|bullish|bearish))\b/.test(q)) return "trend";
  return "overview";
}

export function deskQuestionIndicator(question: string): "rsi" | "ema20" | "ema50" | "vwap" | "atr" | null {
  const q = question.normalize("NFKC").toLowerCase();
  if (/\bvwap\b/.test(q)) return "vwap";
  if (/\batr(?:14)?\b/.test(q)) return "atr";
  if (/\bema\s*50\b|\b50\s*(?:ema|moving average)\b/.test(q)) return "ema50";
  if (/\bema\s*20\b|\b20\s*(?:ema|moving average)\b/.test(q)) return "ema20";
  if (/\brsi(?:14)?\b|\boversold\b|\boverbought\b/.test(q)) return "rsi";
  return null;
}

export const DESK_INTENT_FOCUS: Record<TgDeskIntent, string> = {
  scalp: "Answer the scalp entry directly: use hourly levels only as a map, require lower-timeframe confirmation, include failure level and nearby resistance. Hourly candles cannot establish a precise intraminute scalp entry.",
  entry: "Answer the entry question first: describe a conditional support hold or resistance reclaim using measured levels, confirmation, and where the setup fails. Include nearby resistance when available.",
  invalidation: "Answer what breaks the setup first. A measured support loss can be hypothetical invalidation; it is not a placed stop or a guaranteed fill. Do not invent a stop buffer.",
  targets: "Answer targets first using measured resistance as conditional checkpoints. Say when no measured upside level exists; do not invent a profit target or predict it will be reached.",
  breakout: "Answer breakout/retest/fakeout conditions first: a completed candle beyond a measured level, a held retest, and participation. The newest candle is still forming; do not call its close confirmed.",
  "risk-reward": "Use only a reward/risk ratio calculated in the brief. State its exact hypothetical entry, support and resistance assumptions and that costs/fills are excluded. Without those ordered levels, say the ratio cannot be established.",
  timeframe: "Answer the timeframe asked about first. The available chart is hourly; it cannot confirm minute-scale entries, a daily trend, or a holding duration. Distinguish the chart window from a suggested holding period.",
  trend: "Answer the current trend or thesis change using measured structure, momentum and participation. Do not claim a change since the previous reply without a comparable previous snapshot.",
  indicators: "Explain the requested indicator in relation to measured price and structure. Missing indicator values mean insufficient evidence. Oversold alone is not a reversal or an entry.",
  volume: "Answer whether participation supports the move using the measured buy/sell and volume windows. Counts do not establish trader identity, whale ownership, organic activity or manipulation.",
  liquidity: "Answer execution-depth concerns directly. Indexed reserves are not an executable quote; bonding-curve reserves may be virtual. Do not invent slippage, an executable size, or locked liquidity.",
  safety: "Separate price structure from contract safety. This public chart does not verify sellability, taxes, ownership powers, an audit, or a liquidity lock; never label the token safe from price/volume alone.",
  sizing: "This public desk cannot infer a person's balance, signed caps, liquidation buffer or loss budget. Explain missing inputs; do not recommend a position size or leverage from liquidity alone.",
  prediction: "Answer uncertainty directly. Describe conditional measured scenarios; no exact future price, win probability, guaranteed bottom, or guaranteed outcome can be established from this chart.",
  comparison: "Only compare assets that both have measured snapshots here. A single-coin brief cannot establish which of two coins is stronger; ask for the other asset's measured snapshot.",
  news: "Treat the sourced project description as a published claim, not verified news or a cause of price movement. Without separate timestamped news evidence, do not invent a catalyst.",
  execution: "This is public market analysis. It does not confirm any private account's positions or executed orders and cannot authorize a trade. Do not claim a buy, sell or holding.",
  overview: "Give a concise interpretation of structure, participation and liquidity. Discuss the published theme only if it helps answer the actual question.",
};

/** A model repeating the biography must not crowd out a specific market question. */
export function thoughtAnswersIntent(t: TgDeskThought, intent: TgDeskIntent): boolean {
  const read = t.read.normalize("NFKC").toLowerCase();
  if (intent === "scalp" && !/\b(?:hourly|lower[- ]timeframe|minute|intraminute)\b/.test(read)) return false;
  const patterns: Partial<Record<TgDeskIntent, RegExp>> = {
    scalp: /\b(?:scalp|entry|lower[- ]timeframe|minute|intraminute|pullback|reclaim|retest)\b/,
    entry: /\b(?:entry|support|pullback|reclaim|retest|confirmation|enter|chasing|chase)\b/,
    invalidation: /\b(?:invalidat\w*|stop|support|wrong|los(?:e|ing)|below|fails?|breaks?)\b/,
    targets: /\b(?:target|resistance|checkpoint|upside|exit|profit|ceiling)\b/,
    breakout: /\b(?:breakout|breakdown|retest|reclaim|fakeout|close|confirmation)\b/,
    "risk-reward": /\b(?:reward|risk|ratio|calculate|assumptions)\b/,
    timeframe: /\b(?:timeframe|hourly|minute|daily|holding|duration|window)\b/,
    indicators: /\b(?:rsi|ema|vwap|atr|indicator|average|overbought|oversold)\b/,
    volume: /\b(?:volume|participation|flow|buyers?|sellers?|whales?)\b/,
    liquidity: /\b(?:liquidity|depth|reserves|slippage|quote|curve|impact)\b/,
    safety: /\b(?:safe|safety|contract|audit|sellability|tax|ownership|lock|rug)\b/,
    sizing: /\b(?:siz(?:e|ing)|balance|budget|leverage|allocation|loss|caps?)\b/,
    prediction: /\b(?:predict|forecast|future|uncertain|cannot|can't|probability|conditional|bottom|guarantee)\b/,
    comparison: /\b(?:compar\w*|both|other|second|stronger|versus|vs)\b/,
    news: /\b(?:news|story|published|claim|catalyst|announcement|description|theme)\b/,
    execution: /\b(?:public|account|order|position|holding|execut\w*|private)\b/,
  };
  return patterns[intent]?.test(read) ?? true;
}
