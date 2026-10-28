/**
 * OPERATOR-REVIEWED WRITE-OFF OF A VAULT SHORTFALL (npm run solana:resolve -- shortfall).
 *
 * A vault that holds less USDG or WSOL than its book holds the account's trades
 * and automated exits (SOLANA_STATUS_BELOW_BOOK), and the worker pages
 * operators ([alert] vault-below-book, which names the account by
 * solanaAccountRef alone). A withdrawal the owner made outside Merrymen (the
 * recovery tool, another wallet) is not for this tool: it is capital out, and the
 * owner records it under Owner controls from its own transaction. This is the
 * operator's way through for anything else, once they have found what moved the
 * tokens (an issuer's action on a token account, a booking error), and it adds
 * no authority:
 *
 * - show names the account by tenant or by the alert's account reference, reads
 *   the vault's finalized USDG and WSOL balances at or after the book's slot from
 *   each configured provider (and the operator's own with --third-rpc, whose URL
 *   comes from MERRYMEN_SOLANA_RESOLVE_THIRD_RPC), each on its own hostname, and
 *   shows them beside the book with exactly what a write-off would book
 *   (solanaShortfallWriteOff). It writes nothing.
 * - book writes off only when two providers on their own hostnames report the
 *   same balances, no counted provider reports others, and every provider not set
 *   aside (--exclude) could be read; the slot booked is the lowest either answered
 *   at (solanaQuorumSlot). It records the operator, their reason, the reading and
 *   every provider's view in solana_operator_shortfalls first, then books through
 *   the trading store (writeOffShortfall), which re-checks the reading against the
 *   book under the account's lock and marks the decision booked in the same
 *   transaction: a decision is marked booked if and only if it booked.
 * - It books a LOSS, never capital out: the high-water mark stays, so the
 *   drawdown breaker sees it, and buying pauses until the owner resumes it. An
 *   operator's word can never loosen a risk limit. Nothing is signed or sent.
 *
 * Output and the durable record carry provider labels and a short hash of each
 * hostname, never an endpoint URL.
 */
import { randomUUID } from "node:crypto";
import { address } from "@solana/kit";
import { deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import type { Db } from "./db";
import { solanaAccountRef } from "./solana-agent";
import { readSolanaVaultBalancesWith, SolanaExecutionError, solanaQuorumSlot } from "./solana-executor";
import { hostId, lineOf, ownerOf, SolanaResolveError, solanaResolveProviders, SOLANA_RESOLVE_USAGE, tenantOf, type SolanaResolveDeps,
  type SolanaResolveProvider } from "./solana-resolve";
import { SolanaRpcError } from "./solana-rpc";
import { ensureSolanaTradingSchema, solanaQuarantinedWsol, solanaShortfallWriteOff, SolanaTradingStore, SolanaTradingStoreError,
  type SolanaAccountScope, type SolanaLiveBook } from "./solana-trading-store";

function refuse(message: string): never { throw new SolanaResolveError(message); }

const SCHEMA = `CREATE TABLE IF NOT EXISTS solana_operator_shortfalls (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, slot BIGINT NOT NULL, cash_usdg TEXT NOT NULL, wsol_raw TEXT NOT NULL,
 operator TEXT NOT NULL, reason TEXT NOT NULL, evidence_json TEXT NOT NULL, approved_at_ms BIGINT NOT NULL, booked_at_ms BIGINT, refusal TEXT
);
CREATE INDEX IF NOT EXISTS solana_operator_shortfalls_account ON solana_operator_shortfalls(tenant, owner);`;
const ready = new WeakMap<Db, Promise<void>>();
/** The write-off decisions' table (and the trading tables it refers to). */
export async function ensureSolanaShortfallSchema(db: Db, postgres: boolean): Promise<void> {
  await ensureSolanaTradingSchema(db, postgres);
  let promise = ready.get(db);
  if (!promise) {
    promise = (postgres ? db.tx(async tx => { await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_986); await tx.exec(SCHEMA); }) : db.exec(SCHEMA))
      .catch(error => { ready.delete(db); throw error; });
    ready.set(db, promise);
  }
  return promise;
}

/** One provider's finalized reading of the vault, or why it could not be read (fixed text only). `excluded`: set aside by the operator. */
export type SolanaShortfallView = { label: string; hostId: string; excluded?: true }
  & ({ balances: { slot: number; fresh: number; cashUsdg: string; wsolRaw: string } } | { error: string });
export type SolanaShortfallDecision =
  | { book: true; snapshot: { slot: number; cashUsdg: string; wsolRaw: string }; agreed: string[] }
  | { book: false; reason: string };

/**
 * What may be written off from these readings. Every provider not set aside must
 * have been read (an unread one may show other balances), no two counted
 * providers may report different balances, and at least two on different
 * hostnames must report the same ones. The slot is solanaQuorumSlot's.
 */
export function solanaShortfallDecision(views: readonly SolanaShortfallView[]): SolanaShortfallDecision {
  if (views.some(view => !view.excluded && "error" in view)) {
    return { book: false, reason: "A provider could not be read, so nothing is written off: its answer may show other balances. If that provider is down, set it aside with --exclude "
      + "(two other providers must still agree)." };
  }
  const counted = views.filter((view): view is SolanaShortfallView & { balances: { slot: number; fresh: number; cashUsdg: string; wsolRaw: string } } => !view.excluded && "balances" in view);
  const readings = new Map<string, typeof counted>();
  for (const view of counted) {
    const key = JSON.stringify([view.balances.cashUsdg, view.balances.wsolRaw]);
    readings.set(key, [...(readings.get(key) ?? []), view]);
  }
  if (readings.size > 1) return { book: false, reason: "Providers report different finalized balances for this vault. Nothing is written off: find out which provider is wrong "
    + "before going further. Once you know, set it aside with --exclude (and --third-rpc for another provider): two other providers must still agree." };
  const [agreeing] = [...readings.values()];
  if (!agreeing || new Set(agreeing.map(view => view.hostId)).size < 2) {
    return { book: false, reason: "Fewer than two independent providers report these balances. Two must agree before anything is written off; consult another provider with --third-rpc." };
  }
  let slot: number;
  try { slot = solanaQuorumSlot(agreeing.map(view => ({ slot: view.balances.slot, fresh: view.balances.fresh }))); }
  catch { return { book: false, reason: "A provider answered at a slot far ahead of what another has finalized. Nothing is written off; ask again, or set that provider aside." }; }
  return { book: true, snapshot: { slot, cashUsdg: agreeing[0]!.balances.cashUsdg, wsolRaw: agreeing[0]!.balances.wsolRaw }, agreed: agreeing.map(view => view.label) };
}

function units(rawAmount: bigint | string, decimals: number, symbol: string): string {
  const value = BigInt(rawAmount), sign = value < 0n ? "-" : "", abs = value < 0n ? -value : value, whole = 10n ** BigInt(decimals);
  const fraction = (abs % whole).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${abs / whole}${fraction ? `.${fraction}` : ""} ${symbol}`;
}
const usdg = (value: bigint | string) => units(value, 6, "USDG"), sol = (value: bigint | string) => units(value, 9, "wrapped SOL");
function describeBook(book: SolanaLiveBook): string {
  const aside = solanaQuarantinedWsol(book);
  return `${usdg(book.cashRaw)} and ${sol(book.wsolRaw)}${aside > 0n ? ` (plus ${sol(aside)} quarantined)` : ""}, at slot ${book.slot}`;
}
function viewError(error: unknown): string {
  if (error instanceof SolanaRpcError || error instanceof SolanaExecutionError) return error.message;
  return "Its answer could not be read.";
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SolanaRpcError("malformed");
  return value;
}

/** The account a tenant, or the vault-below-book alert's account reference (solanaAccountRef), names. */
async function accountOf(db: Db, named: string | undefined): Promise<SolanaAccountScope> {
  if (named !== undefined && /^[0-9a-f]{16}$/.test(named)) {
    const rows = await db.prepare("SELECT tenant,owner FROM solana_runtime_live_books").all() as SolanaAccountScope[];
    const matches = rows.filter(row => solanaAccountRef(row) === named);
    if (matches.length !== 1) refuse("No live account has that account reference.");
    if (await ownerOf(db, matches[0]!.tenant) !== matches[0]!.owner) refuse("That account's tenant is now bound to another owner key.");
    return matches[0]!;
  }
  const tenant = tenantOf(named);
  return { tenant, owner: await ownerOf(db, tenant) };
}
/** The account's vault under the configured program, checked against the vault its permission and trades name. */
async function vaultOf(db: Db, env: Readonly<Record<string, string | undefined>>, scope: SolanaAccountScope): Promise<string> {
  const program = env.MERRYMEN_SOLANA_VAULT_PROGRAM;
  try { address(program ?? ""); } catch { refuse("Set MERRYMEN_SOLANA_VAULT_PROGRAM to the configured vault program, then run this again."); }
  const vault = await deriveSolanaVaultAddress(program!, scope.owner);
  const session = await db.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(scope.tenant, scope.owner) as { record_json: string } | undefined;
  const traded = await db.prepare("SELECT vault FROM solana_runtime_submissions WHERE tenant=? AND owner=? ORDER BY created_at_ms DESC LIMIT 1").get(scope.tenant, scope.owner) as { vault: string } | undefined;
  let registered: unknown;
  try { registered = session ? (JSON.parse(session.record_json) as { vault?: unknown }).vault : undefined; } catch { registered = null; }
  if ((session && registered !== vault) || (traded && traded.vault !== vault)) refuse("The configured vault program does not derive the vault this account's permission or trades name.");
  return vault;
}

export interface SolanaShortfallInput {
  db: Db; postgres?: boolean;
  /** A tenant (0x address) or the vault-below-book alert's account reference. */
  account: string;
  providers: readonly SolanaResolveProvider[];
  /** For MERRYMEN_SOLANA_VAULT_PROGRAM, which derives the vault. */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Write it off, recording who decided and why. Without it nothing is written. */
  book?: { operator: string; reason: string };
  /** The label of one provider the operator sets aside (--exclude): read, shown and recorded, never counted. */
  exclude?: string;
}
export interface SolanaShortfallResult {
  tenant: string; owner: string; views: SolanaShortfallView[]; decision: SolanaShortfallDecision | null;
  /** True only when this run's decision booked the write-off. */
  booked: boolean; lines: string[];
}

/** Shows every provider's reading of an account's vault beside its book; with `book`, records the decision and writes the shortfall off. */
export async function resolveSolanaShortfall(input: SolanaShortfallInput): Promise<SolanaShortfallResult> {
  const now = input.now ?? Date.now, postgres = input.postgres ?? false;
  const book = input.book ? { operator: lineOf(input.book.operator, "the operator's name", 80), reason: lineOf(input.book.reason, "a reason", 200) } : undefined;
  const hosts = input.providers.map(provider => provider.host);
  if (new Set(hosts).size !== hosts.length) refuse("Every provider must be on its own hostname.");
  if (input.exclude !== undefined && !input.providers.some(provider => provider.label === input.exclude)) refuse("The excluded provider is not one of the providers consulted.");
  await ensureSolanaShortfallSchema(input.db, postgres);
  const scope = await accountOf(input.db, input.account), { tenant, owner } = scope;
  const store = new SolanaTradingStore(input.db, scope, now);
  const recorded = await store.liveBook();
  if (!recorded) refuse("That account has no live trading record.");
  // Its own trades and owner transactions settle first: one that landed leaves the vault short until it is booked.
  if ((await store.pending()).length) refuse("A live trade of this account is still pending: its landing may be the shortfall. Resolve it first (npm run solana:resolve -- pending names it).");
  const ownerSetup = await store.setup();
  if (ownerSetup?.signature && ownerSetup.status !== "finalized" && ownerSetup.status !== "failed") {
    refuse("An owner transaction of this account is still pending: its landing may be the shortfall. Resolve it first (npm run solana:resolve -- pending names it).");
  }
  const vault = await vaultOf(input.db, input.env, scope);
  const lines = [`Account ${solanaAccountRef(scope)} (tenant ${tenant}), vault ${vault}: its book holds ${describeBook(recorded)}.`];
  const views: SolanaShortfallView[] = [];
  for (const provider of input.providers) {
    const base = { label: provider.label, hostId: hostId(provider.host), ...(provider.label === input.exclude ? { excluded: true as const } : {}) };
    try {
      views.push({ ...base, balances: await provider.read(async read => {
        const held = await readSolanaVaultBalancesWith(read, vault, recorded.slot);
        return { ...held, fresh: integer(await read("getSlot", [{ commitment: "finalized" }])) };
      }) });
    } catch (error) { views.push({ ...base, error: viewError(error) }); }
  }
  const observedAtMs = now();
  for (const view of views) {
    const text = "error" in view ? `could not be used: ${view.error}` : `finalized at slot ${view.balances.slot}: ${usdg(view.balances.cashUsdg)} and ${sol(view.balances.wsolRaw)}`;
    lines.push(`  ${view.label}: ${view.excluded ? `${text} (excluded by the operator: shown and recorded, not counted)` : text}`);
  }
  const decision = solanaShortfallDecision(views);
  if (!decision.book) { lines.push(decision.reason); return { tenant, owner, views, decision, booked: false, lines }; }
  lines.push(`${decision.agreed.join(" and ")} agree at slot ${decision.snapshot.slot}.`);
  let effect: ReturnType<typeof solanaShortfallWriteOff>;
  try { effect = solanaShortfallWriteOff(recorded, decision.snapshot); }
  catch (error) {
    if (!(error instanceof SolanaTradingStoreError)) throw error;
    lines.push("Nothing is short: the vault holds at least its book, so there is nothing to write off. Status books any excess as an inflow by itself.");
    return { tenant, owner, views, decision: { book: false, reason: error.message }, booked: false, lines };
  }
  const { lost, inflow } = effect;
  if (lost.usdgRaw > 0n) lines.push(`Short ${usdg(lost.usdgRaw)}: cash falls to ${usdg(decision.snapshot.cashUsdg)}, and realized P&L by ${usdg(lost.usdgRaw)}.`);
  if (lost.quarantinedWsolRaw > 0n) lines.push(`Short ${sol(lost.quarantinedWsolRaw)} of quarantined SOL (zero basis): it leaves quarantine at no P&L.`);
  if (lost.wsolRaw > 0n) lines.push(`Short ${sol(lost.wsolRaw)} of the position: it leaves with its cost basis of ${usdg(lost.costBasisUsdgRaw)}, which realized P&L falls by.`);
  if (inflow.usdgRaw > 0n) lines.push(`Above the book: ${usdg(inflow.usdgRaw)} is booked as a deposit, as status books one.`);
  if (inflow.quarantinedWsolRaw > 0n) lines.push(`Above the book: ${sol(inflow.quarantinedWsolRaw)} is quarantined at zero basis, as status books it.`);
  lines.push(`A write-off is a loss, never capital out: the high-water mark stays at ${usdg(recorded.hwmRaw)}${effect.book.buyPaused && !recorded.buyPaused ? ", and buying pauses until the owner resumes it" : ""}.`,
    "Ask the owner first whether they withdrew outside Merrymen (the recovery tool or their own wallet): that is capital out, which they record under Owner controls, "
    + "and nothing is written off here.");
  if (!book) { lines.push("Nothing was written. To write it off, run shortfall book with --operator and --reason."); return { tenant, owner, views, decision, booked: false, lines }; }
  // The record comes first: nothing is ever written off without who decided it, why and on what reading.
  const id = randomUUID();
  const evidence = { vault, bookSlot: recorded.slot, agreed: decision.agreed, ...(input.exclude !== undefined ? { excluded: input.exclude } : {}),
    providers: views.map(view => ({ label: view.label, hostId: view.hostId, ...(view.excluded ? { excluded: true } : {}), ...("error" in view ? { error: view.error } : { balances: view.balances }) })) };
  await input.db.prepare(`INSERT INTO solana_operator_shortfalls(id,tenant,owner,slot,cash_usdg,wsol_raw,operator,reason,evidence_json,approved_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tenant, owner, decision.snapshot.slot, decision.snapshot.cashUsdg, decision.snapshot.wsolRaw, book.operator, book.reason, JSON.stringify(evidence), now());
  try { await store.writeOffShortfall({ ...decision.snapshot, observedAtMs, commitment: "finalized" }, id); }
  catch (error) {
    // An error after the store committed (a lost reply) is not a refusal: the decision is marked booked in the store's own transaction.
    let mark: { booked_at_ms: number | string | null } | undefined;
    try { mark = await input.db.prepare("SELECT booked_at_ms FROM solana_operator_shortfalls WHERE id=?").get(id) as typeof mark; }
    catch { refuse("The write-off's reply was lost and its decision could not be read again, so it may or may not be booked. Run shortfall history to see whether it was."); }
    if (!mark || mark.booked_at_ms === null) {
      const refusal = error instanceof SolanaTradingStoreError ? error.message : "The write-off could not be written.";
      await input.db.prepare("UPDATE solana_operator_shortfalls SET refusal=? WHERE id=? AND booked_at_ms IS NULL").run(refusal, id);
      refuse(`Nothing was written off: ${refusal} The decision is recorded as refused.`);
    }
  }
  lines.push(`Written off, recorded as decided by ${book.operator}.`);
  return { tenant, owner, views, decision, booked: true, lines };
}

/** The recorded write-off decisions for a tenant, newest first. */
export async function listSolanaShortfalls(db: Db, tenant: string, postgres = false) {
  await ensureSolanaShortfallSchema(db, postgres);
  const rows = await db.prepare(`SELECT slot,cash_usdg,wsol_raw,operator,reason,approved_at_ms,booked_at_ms,refusal FROM solana_operator_shortfalls WHERE tenant=?
    ORDER BY approved_at_ms DESC`).all(tenantOf(tenant)) as Array<{ slot: number | string; cash_usdg: string; wsol_raw: string; operator: string; reason: string;
      approved_at_ms: number | string; booked_at_ms: number | string | null; refusal: string | null }>;
  return rows.map(row => ({ slot: Number(row.slot), cashUsdg: row.cash_usdg, wsolRaw: row.wsol_raw, operator: row.operator, reason: row.reason,
    approvedAtMs: Number(row.approved_at_ms), bookedAtMs: row.booked_at_ms === null ? null : Number(row.booked_at_ms), refusal: row.refusal }));
}

/**
 * `npm run solana:resolve -- shortfall show|book|history ...`: `positional` and
 * `flags` as runSolanaResolveCommand parsed them; `exclude` the provider label
 * --exclude named.
 */
export async function runSolanaShortfallCommand(positional: readonly string[], flags: ReadonlyMap<string, string>, deps: SolanaResolveDeps, exclude?: string): Promise<string> {
  const [command, account, ...extra] = positional, postgres = deps.postgres ?? false;
  if (extra.length || account === undefined) refuse(SOLANA_RESOLVE_USAGE);
  if (command === "history") {
    if (flags.size) refuse(SOLANA_RESOLVE_USAGE);
    const rows = await listSolanaShortfalls(deps.db, account, postgres);
    if (!rows.length) return "No shortfall write-offs are recorded for that tenant.";
    return rows.map(row => [new Date(row.approvedAtMs).toISOString(), `slot ${row.slot}`, `${usdg(row.cashUsdg)}, ${sol(row.wsolRaw)}`,
      row.bookedAtMs !== null ? "written off" : row.refusal ? `refused: ${row.refusal}` : "not booked", `by ${row.operator}`, row.reason].join("\t")).join("\n");
  }
  const booking = command === "book";
  if ((command !== "show" && !booking) || (booking ? !flags.has("operator") || !flags.has("reason") : flags.has("operator") || flags.has("reason"))) refuse(SOLANA_RESOLVE_USAGE);
  const providers = solanaResolveProviders(deps.env ?? process.env, flags.has("third-rpc"), { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  const result = await resolveSolanaShortfall({ db: deps.db, postgres, account, providers, env: deps.env ?? process.env, now: deps.now,
    ...(exclude !== undefined ? { exclude } : {}), ...(booking ? { book: { operator: flags.get("operator")!, reason: flags.get("reason")! } } : {}) });
  // A book that booked nothing is a failure the operator must see (exit status 1).
  if (booking && !result.booked) refuse(result.lines.join("\n"));
  return result.lines.join("\n");
}
