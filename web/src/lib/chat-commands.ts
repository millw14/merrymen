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
   * `order` places a buy or a sell through POST /api/orders — which QUEUES it
   * for the worker rather than doing it. That difference is not an
   * implementation detail: a 200 means a row exists, not that a trade happened,
   * and the card must not say otherwise.
   */
  via: "settings" | "navigate" | "order";
  /** For `settings`: which keys this command may write. Nothing else is sent. */
  writes?: readonly string[];
  /**
   * Values the COMMAND supplies itself, overriding anything the model sent.
   *
   * For a command whose whole meaning IS the value — go-live is
   * `paperTradingEnabled: false` and nothing else — the model must not be the
   * one to say which way the flag goes. Its own sentence is fixed, so a model
   * that emitted the opposite boolean would produce a card promising one thing
   * and a write doing the other; and an empty `{}` would produce a card that
   * promised something and then wrote nothing at all, which is the quieter and
   * worse of the two.
   */
  fixed?: Record<string, CommandArg>;
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
// Typed on the way in rather than at the export, so each entry is checked
// against ChatCommand individually. Inferring the array first makes every
// optional field a union member (`fixed?: undefined` beside `fixed: {...}`),
// which then fails to satisfy the interface for reasons that have nothing to do
// with any of these commands.
const REGISTRY: ChatCommand[] = [
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
    fixed: { paperTradingEnabled: true },
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
    fixed: { paperTradingEnabled: false },
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
  // ── the two that spend money ─────────────────────────────────────────────
  //
  // THE ONLY COMMANDS THAT ASK FOR A TRADE, and they still do not perform one.
  // The route writes a row; the WORKER — the one process holding a key —
  // decides whether it is a trade, against the wall the owner signed. Every
  // refusal that always applied still applies in the same place: the sealed
  // per-trade cap, the daily cap, the asset allowlist, no-exit, the drawdown
  // breaker, gas. Nothing here widens any of them.
  //
  // Their sentences say WHAT IS NOT YET TRUE. "I'll place it" is honest;
  // "bought" would be a claim about somebody's money made by a browser, a
  // minute before the ledger has an opinion.
  {
    id: "buy",
    via: "order",
    writes: ["side", "symbol", "usdgAmount"],
    fixed: { side: "buy" },
    weighty: true,
    say: (a) =>
      `Spend ${money(a.usdgAmount)} buying ${String(a.symbol).toUpperCase()}. ` +
      `I'll place it — my key's limits still decide whether it goes through.`,
  },
  {
    id: "sell",
    via: "order",
    writes: ["side", "symbol", "usdgAmount"],
    fixed: { side: "sell" },
    weighty: true,
    // THE SIZE CAN COME OUT DIFFERENT IN EITHER DIRECTION, and the card is the
    // last chance to say so before money moves. A stock sell CLAMPS DOWN to
    // whatever the position is worth. A bonding-curve coin cannot be sold in
    // part at all — the worker exits the whole holding — so a card promising
    // "or all of it, if that is less than you hold" promised the opposite of
    // what happens, and the receipt then called a full liquidation a trim.
    say: (a) =>
      `Sell ${money(a.usdgAmount)} of ${String(a.symbol).toUpperCase()}. ` +
      `If that is more than you hold I sell what is there, and if it is a coin on a bonding curve I have to sell the whole position — ` +
      `I'll tell you which happened. I'll place it; my key's limits still decide.`,
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
];

export const CHAT_COMMANDS: readonly ChatCommand[] = Object.freeze(REGISTRY);

const BY_ID = new Map(CHAT_COMMANDS.map((c) => [c.id, c]));

/** The command by that id, or null. An unknown id is not a command. */
export function commandFor(id: unknown): ChatCommand | null {
  return typeof id === "string" ? (BY_ID.get(id) ?? null) : null;
}

/**
 * The body a command may send — nothing but its own declared keys.
 *
 * THE MODEL SUPPLIES VALUES, NEVER FIELD NAMES. It can ask to set `strategy`
 * to something; it cannot ask to set `bundlerUrl`, because `writes` is ours and
 * anything outside it is dropped here. The server strips house fields again
 * (/api/settings) and re-validates the whole order shape (/api/orders), so this
 * is the first of two independent gates rather than the only one.
 *
 * NAMED FOR THE COMMAND RATHER THAN THE ROUTE since orders started using it.
 * It was `settingsPayload`, and leaving that name would have meant either a
 * second copy of the same filtering for the route where the stakes are highest,
 * or a function whose name says it cannot do what it does.
 */
export function commandPayload(
  cmd: ChatCommand,
  args: Record<string, CommandArg>,
): Record<string, CommandArg | string[]> {
  const out: Record<string, CommandArg | string[]> = {};
  for (const key of cmd.writes ?? []) {
    if (!(key in args)) continue;
    const v = args[key]!;
    // A LIST FIELD IS SENT AS A LIST. The model may only give us scalars — that
    // is the route's own guard against a nested object reaching a settings
    // write — so a basket arrives as "TSLA,NVDA" and /api/settings refuses
    // anything that is not an array ("basketSymbols: must be an array of
    // symbols"). Without this the command would fail every single time, which
    // is worse than not existing: an owner would confirm and be told no.
    out[key] = LIST_FIELDS.has(key)
      ? String(v)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : v;
  }
  // LAST, SO THE COMMAND WINS. See `fixed`: for go-live and go-paper the value
  // is the command's meaning, not the model's to choose.
  for (const [key, v] of Object.entries(cmd.fixed ?? {})) {
    if ((cmd.writes ?? []).includes(key)) out[key] = v;
  }
  return out;
}

/**
 * Settings fields stored as arrays, which a scalar-only command must widen.
 *
 * Only what a command actually writes belongs here. `customTokens` is an array
 * too and is deliberately absent — adding a token is "know about this", which
 * registry.ts keeps separate from "trade it" on purpose, and it is not
 * something chat may do.
 */
const LIST_FIELDS = new Set(["basketSymbols"]);

/** Every id the model is allowed to name, for the prompt. */
export const COMMAND_IDS = CHAT_COMMANDS.map((c) => c.id);

/**
 * Pull a proposed command off a reply, if there is one.
 *
 * THE SEAM BETWEEN MODEL OUTPUT AND THE REGISTRY, and it lives here rather
 * than in the route because everything it enforces is the registry's rule: the
 * id must be one we already know, and the arguments must be flat scalars. A
 * nested object or array would otherwise be forwarded into a settings write,
 * and this is the only place its shape is checked.
 *
 * Anything unparseable is simply STRIPPED and the reply renders as ordinary
 * text — never surfaced as an error. A malformed proposal is the model failing
 * to offer something, not the owner doing anything wrong, and an error message
 * about a marker they never saw would be nonsense to them.
 */
/**
 * ANCHORED TO THE END OF THE REPLY, and that anchor is a security control.
 *
 * It used to match anywhere. The prompt is fed the owner's ledger, and a
 * position's `reason` is model-written text from ANOTHER agent — so an attacker
 * who lands one sentence containing a literal marker does not have to persuade
 * this model of anything. They only have to get it QUOTED, and "why did you buy
 * that?" is a question whose honest answer repeats it back. The card that
 * appeared would be real, correctly worded, authored by this registry, and
 * shown exactly when the owner was reading about that position.
 *
 * A proposal is the LAST thing a reply does — the prompt says so, and now the
 * parser agrees. Quoted text is followed by more sentence; a decision is not.
 * The other half of this lives in /api/chat, which defangs any marker in the
 * input before the model ever sees it. Both, because either alone is one regex
 * from failing open.
 */
// `[^{}]*` and NOT `[\s\S]*?` — the args of a command are flat scalars, so a
// brace can never legitimately nest. The lazy form could backtrack ACROSS an
// intervening `>>` and swallow a second marker whole, which turned two markers
// into one match with unparseable args: a quoted marker earlier in the reply
// could then capture the model's real one.
const MARKER = /<<CMD\s+([a-z-]+)\s*(\{[^{}]*\})?\s*>>\s*$/;
/**
 * Anything marker-SHAPED — used only to scrub, never to act.
 *
 * DELIBERATELY LOOSER THAN THE ONE ABOVE, and the asymmetry is the point:
 * strict about what may become an action, permissive about what may be shown.
 * A marker the strict regex refuses (nested braces, a mangled id, a quoted one
 * from another agent's text) is still plumbing, and rendering it as though the
 * agent had written it is its own small lie.
 */
const ANY_MARKER = /<<CMD[\s\S]*?>>/g;

export function splitCommand(raw: string): {
  reply: string;
  command?: { id: string; args: Record<string, CommandArg> };
} {
  const m = raw.match(MARKER);
  // EVERY MARKER IS SCRUBBED, VALID OR NOT, ANCHORED OR NOT. It is machinery:
  // leaving one in the reply shows an owner the plumbing — and a marker in the
  // MIDDLE of a reply is very likely quoted from somebody else's text, which is
  // the last thing to render as if the agent had written it.
  const reply = raw.replace(ANY_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!m) return { reply };
  if (!commandFor(m[1])) return { reply };
  let args: Record<string, CommandArg> = {};
  try {
    const parsed: unknown = m[2] ? JSON.parse(m[2]) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") args[k] = v;
      }
    }
  } catch {
    args = {};
  }
  return { reply, command: { id: m[1]!, args } };
}
