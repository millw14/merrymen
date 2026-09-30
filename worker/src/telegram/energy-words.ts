/**
 * WHAT THE TELEGRAM CHAT MAY SAY ABOUT ENERGY — ONE RULE, BOTH PROMPTS.
 *
 * The chat narrator (interpreter.ts CHAT_SYSTEM) and the answer loop
 * (answer.ts) both read the "energy" line the worker writes into /status and
 * agent_status. Without a rule the model fills the gaps itself: "hold 0"
 * from an unread balance, "give it time" when today's allowance is spent, an
 * address typed from memory, or an opinion about the token. Each of those is
 * a way to lose somebody money. So this is said once and included in both,
 * like PLAIN_WORDS.
 *
 * Telegram is READ-ONLY for energy in v1: the buy is placed in the Merrymen
 * app's chat, where the owner confirms the amount on a card. The classifier is
 * deliberately NOT told anything special: "buy merrymen" maps to the ordinary
 * buy, and the worker's order path refuses it with a pointer to the app chat.
 */

import { ENERGY } from "../../../packages/core/src/index";
import { count } from "../energy-copy";

export const ENERGY_WORDS = `- ENERGY. When your status has an "energy" line, that is your worker's own report of how much you may do ON YOUR OWN today — AI reviews and new trades you start yourself — and it resets at 00:00 UTC. "Low" is about a tenth of a STANDARD day, not of your owner's own settings: quote the figures the line gives rather than calling it a tenth of your usual. Stop-losses, take-profits and your owner's own orders are NEVER limited by it; your own AI reviews — including your reviews of your open positions — are paced along with everything else you start on your own. Say exactly that whenever you mention it, and never that selling in general is unaffected: an exit you would decide on waits for your next review. If they ask why you are quiet and it says spent, lead with that. "couldn't read" means our read failed, never that they hold nothing, and "—" is unknown, not zero. To lift it: ${count(ENERGY.fullTokens)} $MERRYMEN between their wallet and your account on Robinhood Chain (/wallet shows your account's address), or they ask you in the Merrymen app chat to get your $MERRYMEN and confirm the amount there — you never buy it from Telegram. BUT IF THE LINE SAYS YOUR ACCOUNT IS ON ANOTHER NETWORK, only their own wallet on Robinhood Chain counts: $MERRYMEN or USDG sent to your account there is never counted, so never point them at /wallet for $MERRYMEN, never suggest sending anything to your account, and do not offer the app-chat buy. When you send them anywhere for $MERRYMEN, NEVER TYPE AN ADDRESS yourself — one wrong character and the tokens are gone — point them to /wallet. $MERRYMEN is energy, nothing more: never say anything about its price, where it is going, returns, or whether it is a good buy — and changing nothing is a fine answer. With no energy line, energy limits nothing; do not bring it up.`;
