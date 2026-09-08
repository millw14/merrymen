/**
 * WHAT AN OWNER CAN ASK FOR IN PLAIN LANGUAGE, AND WHAT HAPPENS WHEN THEY DO.
 *
 * ── THE PROPERTY THIS PRESERVES ──────────────────────────────────────────
 *
 * `/api/chat`'s header states the rule this feature has to work within:
 *
 *   "The model can NARRATE but never ACT: it only ever returns text. Orders
 *    (buy, sell, pause) are a separate wall-checked path, not something a chat
 *    reply can trigger — so a prompt-injected 'sell everything' in the context
 *    is inert here."
 *
 * That is not decoration. The chat prompt is fed the owner's own ledger, and a
 * position's `reason` is model-written text from another agent — so the context
 * is genuinely attacker-influenced, and a model that could act on it would act
 * on somebody else's words.
 *
 * So the model still never acts. It PROPOSES a named command from the registry
 * below; the owner sees it written out in their own terms and clicks; and the
 * CLIENT then calls the same authenticated route the buttons already call. The
 * rule becomes "the model cannot act without a human click", and an injected
 * instruction becomes a confirmation card that an owner declines.
 *
 * THE CONFIRMATION IS LOAD-BEARING, not a courtesy. It is the entire difference
 * between a convenience and a remote-execution hole.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 *
 * NO SECRET IS EVER A COMMAND RESULT. An owner asking "what's my private key"
 * is asking a reasonable question — it is their key, on their machine, and
 * `/grant` already shows it with a copy button. But a chat answer is different
 * from a wallet screen in two ways that matter: it goes through the MODEL (a
 * house-keyed third-party service, and a transcript on somebody's server), and
 * this app PERSISTS chat turns to localStorage. Printing a key into that
 * transcript would put a second copy of it in a place with none of the
 * warnings, checks, or deliberate friction the wallet screen has.
 *
 * So `reveal-key` is a command, and what it does is TAKE THEM TO THE CONTROL —
 * which already carries the backup gate and the "whoever holds this owns the
 * funds" warning. Same answer, same key, one place that knows how to show it.
 * Same reasoning the signer gets: one control, one set of conditions, and
 * everything else points at it.
 *
 * NO COMMAND MOVES MONEY, for the same reason and by the same shape. An owner
 * asking to send funds out is asking a reasonable question too — but whether a
 * transfer can execute is decided by the SIGNED permission, not by anything
 * chat can reach: USDG only, to an address in the sealed allowlist, capped per
 * transfer. Wallets signed today register no withdrawal address at all, so
 * their wall carries no transfer permission and the send is refused before
 * anything is built (Settings.tsx says exactly this, in those words).
 *
 * So `open-withdraw` takes them to the control that knows all of that, and the
 * command's own sentence says where it will be refused rather than implying
 * chat can widen a sealed grant. One control, one set of conditions, everything
 * else points at it — the third time this file reaches that conclusion.
 */

/** A value an owner can be asked to confirm. Strings and numbers only. */
export type CommandArg = string | number | boolean;

export interface ChatCommand {
  /** Stable id the model emits. Never shown to a person. */
  id: string;
  /**
   * What the owner is agreeing to, in their words, with the values filled in.
   *
   * WRITTEN BY US, NOT BY THE MODEL. If the model supplied this sentence it
   * could describe one action and request another, and the confirmation would
   * be confirming the description rather than the act.
   */
  say: (args: Record<string, CommandArg>) => string;
  /**
   * How it happens: which existing authenticated surface performs it.
   *
   * `settings` writes through PUT /api/settings, which is tenant-authorised and
   * strips every house-owned field — so a command cannot set a fee, a bundler,
   * or somebody's sponsorship, whatever the model asks for.
   * `navigate` goes to a screen and does nothing else.
   */
  via: "settings" | "navigate";
  /** For `settings`: which keys this command may write. Nothing else is sent. */
  writes?: readonly string[];
  /** For `navigate`: where to. */
  to?: string;
  /**
   * Does this need a second look even after the confirmation card?
   *
   * True for anything that changes what the agent does with money, or that puts
   * a secret on screen. The card says so louder; it does not skip the click.
   */
  weighty?: boolean;
}

const money = (n: CommandArg) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * THE REGISTRY IS THE ALLOWLIST. A command the model names that is not here
 * does nothing at all — `commandFor` returns null and the reply renders as
 * ordinary text. That is the fail-closed direction: a model inventing a
 * plausible-sounding command must not be able to reach a route by naming it.
 */
export const CHAT_COMMANDS: readonly ChatCommand[] = Object.freeze([
  {
    id: "set-strategy",
    via: "settings",
    writes: ["strategy"],
    weighty: true,
    say: (a) => `Switch me to the ${String(a.strategy)} strategy. It changes what I trade and when.`,
  },
  {
    id: "set-basket",
    via: "settings",
    writes: ["basketSymbols"],
    weighty: true,
    say: (a) =>
      `Trade this basket from now on: ${String(a.basketSymbols).split(",").join(", ")}. ` +
      `Anything not on that list I stop buying.`,
  },
  {
    id: "go-paper",
    via: "settings",
    writes: ["paperTradingEnabled"],
    weighty: true,
    // PAPER IS PERMISSION TO SIMULATE, NOT A REQUEST TO — execModeOf asks
    // canTradeForReal first. Saying "switch to paper" would promise something
    // this setting does not do.
    say: () => `Let me fall back to practice fills when I cannot trade for real. It is not a switch to paper — if every leg is available I still trade for real.`,
  },
  {
    id: "go-live",
    via: "settings",
    writes: ["paperTradingEnabled"],
    weighty: true,
    say: () => `Stop simulating. If I cannot trade for real I will do nothing instead of practising.`,
  },
  {
    id: "set-slippage",
    via: "settings",
    writes: ["slippageBps"],
    weighty: true,
    say: (a) => `Refuse a fill worse than ${Number(a.slippageBps) / 100}% off the quote.`,
  },
  {
    id: "set-impact",
    via: "settings",
    writes: ["maxImpactBps"],
    weighty: true,
    // NOT THE SAME THING AS SLIPPAGE, and owners conflate them constantly.
    // Slippage is how far the fill may drift from the quote; impact is how far
    // MY OWN order is allowed to push the pool. settings.ts: "refuses the trade
    // that would quietly cost more than the strategy could ever make back."
    say: (a) => `Refuse any trade where my own order would move the price more than ${Number(a.maxImpactBps) / 100}%.`,
  },
  {
    id: "set-size",
    via: "settings",
    writes: ["buyPerTickUsdg"],
    weighty: true,
    say: (a) => `Put ${money(a.buyPerTickUsdg)} to work each time I trade.`,
  },
  {
    id: "rename",
    via: "settings",
    writes: ["agentName"],
    say: (a) => `Call me ${String(a.agentName)} from now on.`,
  },
  // ── the ones that only take you somewhere ────────────────────────────────
  {
    id: "open-deposit",
    via: "navigate",
    to: "/deposit",
    say: () => `Show you where to send funds.`,
  },
  {
    id: "open-withdraw",
    via: "navigate",
    to: "/withdraw",
    weighty: true,
    // I CANNOT SEND IT FROM HERE, AND SAYING SO IS THE POINT. A transfer is
    // decided by the signed permission, and a grant signed today registers no
    // withdrawal address — so an agent that answered "sure, sending it" would
    // be promising something the wall refuses before anything is built.
    say: () =>
      `Take you to the withdraw screen. I cannot send it from chat — moving money out ` +
      `needs a permission sealed into my key when you signed, and most keys carry none.`,
  },
  {
    id: "open-settings",
    via: "navigate",
    to: "/settings",
    // THE ANSWER WHEN I AM NOT SURE WHICH KNOB THEY MEANT. Proposing the wrong
    // setting is worse than proposing the screen that shows all of them, and
    // this gives the model somewhere honest to land instead of guessing.
    say: () => `Open your settings, where every dial I have is listed.`,
  },
  {
    id: "open-limits",
    via: "navigate",
    to: "/limits",
    say: () => `Show you the spending limits sealed into my key.`,
  },
  {
    id: "show-address",
    via: "navigate",
    to: "/grant",
    say: () => `Show you my account address.`,
  },
  {
    id: "reveal-key",
    via: "navigate",
    to: "/grant",
    weighty: true,
    // NOT PRINTED HERE. See the header: a chat answer goes through the model and
    // is persisted to this browser's storage, and the wallet screen is the one
    // place that knows how to show a key — with the backup gate and the warning
    // that whoever holds it owns the funds.
    say: () =>
      `Take you to your owner key on the wallet page. I will not print it in chat — ` +
      `it would go through my brain and be saved in this conversation, and that key is the money.`,
  },
  {
    id: "resign",
    via: "navigate",
    to: "/grant#resign",
    weighty: true,
    say: () => `Take you to re-sign my trading permission — free, one signature, nothing moves on-chain.`,
  },
]);

const BY_ID = new Map(CHAT_COMMANDS.map((c) => [c.id, c]));

/** The command by that id, or null. An unknown id is not a command. */
export function commandFor(id: unknown): ChatCommand | null {
  return typeof id === "string" ? (BY_ID.get(id) ?? null) : null;
}

/**
 * The settings payload a command may send — nothing but its own declared keys.
 *
 * THE MODEL SUPPLIES VALUES, NEVER FIELD NAMES. It can ask to set `strategy`
 * to something; it cannot ask to set `bundlerUrl`, because `writes` is ours and
 * anything outside it is dropped here. /api/settings strips house fields again
 * on the server, so this is the first of two independent gates rather than the
 * only one.
 */
export function settingsPayload(
  cmd: ChatCommand,
  args: Record<string, CommandArg>,
): Record<string, CommandArg> {
  const out: Record<string, CommandArg> = {};
  for (const key of cmd.writes ?? []) {
    if (key in args) out[key] = args[key]!;
  }
  return out;
}

/** Every id the model is allowed to name, for the prompt. */
export const COMMAND_IDS = CHAT_COMMANDS.map((c) => c.id);
