import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { CHAINS } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, solanaPaperAgentId, validateSolanaPaperLimits } from "../../packages/core/src/solana";
import { merrymenHome } from "./home";
import { createSolanaMarket } from "./solana-market";
import { SolanaPaperStore, type SolanaPaperLimitsRenewal } from "./solana-paper-store";
import { assertSolanaPaperLocalMode, createSolanaPaperService, type SolanaPaperMarket } from "./solana-paper-service";

export class SolanaPaperCommandError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaPaperCommandError"; }
}

export const SOLANA_PAPER_HELP = `Solana paper trading — local simulation; no wallet signing or real funds.

init --owner PUBLIC_KEY [--cash 1000] [--per-trade 25] [--daily 100]
     [--max-ops 20] [--drawdown-bps 1000] [--expires-days 7]
renew --owner PUBLIC_KEY [--expires-days N] [--per-trade USDG] [--daily USDG]
      [--max-ops N] [--drawdown-bps N] [--loosen]
status --owner PUBLIC_KEY
inspect-mint --mint MINT
quote --owner PUBLIC_KEY --input MINT --output MINT --amount-raw INTEGER
      [--slippage-bps 100]
trade --owner PUBLIC_KEY --input MINT --output MINT --amount-raw INTEGER
      --request-id UNIQUE_ID [--slippage-bps 100]
write-off --owner PUBLIC_KEY --mint MINT

Each swap must have exactly one Solana USDG leg. Raw amounts use token base
units (USDG has 6 decimals). Reuse a trade's request ID after interruption;
it returns the saved receipt without applying another fill. Never reset a
book by repeating init: an existing book is refused. Once limits expire, the
owner can renew them. renew changes only the limits given (others are kept)
and prints what changed. Without --expires-days: an expired book gets 7 days
from now; a running book keeps its expiry when renew changes a limit, so
tightening never lengthens it; a bare renew extends it to 7 days from now,
or keeps it if later. Only --expires-days can shorten the expiry, or lengthen
it alongside a limit change. Lowering a limit needs nothing more; raising the
per-trade, daily, max-ops or drawdown limit also needs --loosen. Every renewal
is kept in the book's limitsHistory with the previous and new limits. renew
never changes cash, positions, P&L or receipts, and the rolling 24-hour
limits still count earlier trades.

A partial sell must leave an amount that a route still buys back; one that
would leave dust is refused (sell the whole position, or less of it). A
position no route buys back at all (dust) can be written off: write-off
quotes the whole position first and goes ahead only when Jupiter quotes no
output for it. The lot leaves the book with its cost basis realized as a
loss, cash and the peak stay as they are, and the book keeps the record,
with Jupiter's zero-output answer as its evidence, in writeOffs.

Quotes require MERRYMEN_SOLANA_RPC_MAINNET and MERRYMEN_JUPITER_API_KEY.
An optional MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK provides independent RPC
reads. The book lives in MERRYMEN_HOME/solana-paper.sqlite (default ~/.merrymen).
The owner is a paper-book label, not proof of wallet control or a deposit
address. Hosted use and live mode are unavailable. Results simulate quote
minimum output; network fees and rent are excluded.`;

const FLAGS: Record<string, readonly string[]> = {
  init: ["owner", "cash", "per-trade", "daily", "max-ops", "drawdown-bps", "expires-days"],
  // Deliberately no --cash: a renewal can never refill a book.
  renew: ["owner", "per-trade", "daily", "max-ops", "drawdown-bps", "expires-days", "loosen"],
  status: ["owner"],
  "inspect-mint": ["mint"],
  quote: ["owner", "input", "output", "amount-raw", "slippage-bps"],
  trade: ["owner", "input", "output", "amount-raw", "slippage-bps", "request-id"],
  "write-off": ["owner", "mint"],
};

/** Options that take no value. */
const SWITCHES = new Set(["loosen"]);

function parseFlags(command: string, args: readonly string[]): Record<string, string> {
  const allowed = FLAGS[command];
  if (!allowed) throw new SolanaPaperCommandError("Unknown Solana paper command. Run solana-paper --help.");
  const flags: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    const invalid = () => new SolanaPaperCommandError("Invalid, duplicate or unsupported Solana paper option. Run solana-paper --help.");
    if (!args[i]?.startsWith("--") || !key || !allowed.includes(key) || Object.hasOwn(flags, key)) throw invalid();
    if (SWITCHES.has(key)) { flags[key] = "yes"; i--; continue; }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--") || !value.length || value.length > 128) throw invalid();
    flags[key] = value;
  }
  return flags;
}

function required(flags: Record<string, string>, key: string): string {
  if (!flags[key]) throw new SolanaPaperCommandError(`The --${key} option is required.`);
  return flags[key];
}

/** Display USDG to raw units, without ever passing through floating point. */
export function paperUsdgRaw(value: string): string {
  if (!/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$/.test(value)) {
    throw new SolanaPaperCommandError("USDG amounts must be positive decimals with at most six fractional digits.");
  }
  const [whole, fraction = ""] = value.split(".");
  const raw = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  parseSolanaRawAmount(raw.toString());
  return raw.toString();
}

function numberOption(value: string, maximum: number): number {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(value) || Number(value) > maximum) {
    throw new SolanaPaperCommandError("Numeric options must be bounded nonnegative integers.");
  }
  return Number(value);
}

/**
 * Parse and bound every renewal option before a writable book is opened.
 * Without --expires-days the store decides the expiry (SolanaPaperLimitsRenewal);
 * raising a limit needs --loosen, which the store enforces against the book's
 * current limits.
 */
function renewalOf(flags: Record<string, string>, nowMs: number): SolanaPaperLimitsRenewal {
  const renewal: SolanaPaperLimitsRenewal = {};
  if (flags["expires-days"] !== undefined) {
    const days = numberOption(flags["expires-days"], 365);
    if (days < 1) throw new SolanaPaperCommandError("Renewed limits must last at least one day (--expires-days 1 or more).");
    renewal.expiresAtMs = nowMs + days * 86_400_000;
  }
  if (flags.loosen !== undefined) renewal.loosen = true;
  if (flags["per-trade"] !== undefined) renewal.perTradeUsdg = paperUsdgRaw(flags["per-trade"]);
  if (flags.daily !== undefined) renewal.dailyUsdg = paperUsdgRaw(flags.daily);
  if (renewal.perTradeUsdg !== undefined && renewal.dailyUsdg !== undefined && BigInt(renewal.perTradeUsdg) > BigInt(renewal.dailyUsdg)) {
    throw new SolanaPaperCommandError("The per-trade limit must not exceed the daily limit.");
  }
  if (flags["max-ops"] !== undefined) renewal.maxOpsPerDay = numberOption(flags["max-ops"], 100_000);
  if (flags["drawdown-bps"] !== undefined) renewal.maxDrawdownBps = numberOption(flags["drawdown-bps"], 10_000);
  if (renewal.maxOpsPerDay === 0 || renewal.maxDrawdownBps === 0) throw new SolanaPaperCommandError("Operation and drawdown limits must be at least 1.");
  return renewal;
}

function openPaperStore(): SolanaPaperStore {
  const home = merrymenHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "solana-paper.sqlite");
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  return new SolanaPaperStore(file);
}

export interface SolanaPaperCommandDeps {
  openStore?: () => SolanaPaperStore;
  market?: () => SolanaPaperMarket;
  now?: () => number;
}

export async function runSolanaPaperCommand(args: readonly string[], deps: SolanaPaperCommandDeps = {}): Promise<unknown> {
  const [command = "help", ...rest] = args;
  if (["help", "--help", "-h"].includes(command) && !rest.length) return SOLANA_PAPER_HELP;
  assertSolanaPaperLocalMode();
  const flags = parseFlags(command, rest);
  const now = deps.now ?? Date.now;
  // Construct providers only for commands that read the market. Offline init,
  // status and durable retries must work without an RPC/Jupiter configuration.
  let market: SolanaPaperMarket | undefined;
  const lazyMarket: SolanaPaperMarket = {
    readMint: (address) => (market ??= (deps.market ?? createSolanaMarket)()).readMint(address),
    quote: (intent) => (market ??= (deps.market ?? createSolanaMarket)()).quote(intent),
  };
  if (command === "inspect-mint") {
    const mint = required(flags, "mint");
    solanaPaperAgentId(mint);
    return { mode: "paper", mint: await lazyMarket.readMint(mint) };
  }
  const owner = required(flags, "owner");
  solanaPaperAgentId(owner);
  // Parse everything before opening a writable book.
  const intent = command === "quote" || command === "trade" ? parseSolanaSwapIntent({
    kind: "spl-swap", chain: CHAINS.solana, mode: "paper",
    requestId: command === "trade" ? required(flags, "request-id") : "preview",
    inputMint: required(flags, "input"), outputMint: required(flags, "output"),
    amountRaw: required(flags, "amount-raw"), slippageBps: numberOption(flags["slippage-bps"] ?? "100", 100),
  }) : null;
  const createdAt = now();
  const days = command === "init" ? numberOption(flags["expires-days"] ?? "7", 365) : 0;
  const limits = command === "init" ? validateSolanaPaperLimits({
    perTradeUsdg: paperUsdgRaw(flags["per-trade"] ?? "25"), dailyUsdg: paperUsdgRaw(flags.daily ?? "100"),
    maxOpsPerDay: numberOption(flags["max-ops"] ?? "20", 100_000),
    maxDrawdownBps: numberOption(flags["drawdown-bps"] ?? "1000", 10_000),
    expiresAtMs: createdAt + days * 86_400_000,
  }, createdAt) : null;
  const initialCash = command === "init" ? paperUsdgRaw(flags.cash ?? "1000") : null;
  const renewal = command === "renew" ? renewalOf(flags, createdAt) : null;
  const writeOffMint = command === "write-off" ? required(flags, "mint") : null;
  if (writeOffMint !== null) solanaPaperAgentId(writeOffMint);
  const store = (deps.openStore ?? openPaperStore)();
  try {
    if (command === "init") return store.create(owner, initialCash!, limits!, createdAt);
    if (command === "renew") return store.renew(owner, renewal!, createdAt);
    if (command === "status") {
      const book = store.get(owner);
      if (!book) throw new SolanaPaperCommandError("No Solana paper book exists for this owner.");
      return book;
    }
    const service = createSolanaPaperService(store, lazyMarket, now);
    if (command === "write-off") return await service.writeOff(owner, writeOffMint!);
    return command === "quote" ? { mode: "paper", preview: await service.preview(owner, intent) }
      : await service.trade(owner, intent);
  } finally {
    store.close();
  }
}
