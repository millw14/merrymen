/**
 * DEPOSITS BOOKED FROM THE CHAIN WITHOUT AN OPERATOR, IN THE ONE SHAPE WHERE THE
 * CHAIN LEAVES NOTHING TO JUDGE.
 *
 * WHAT WENT WRONG. An owner creates an agent and funds it afterwards, which is
 * how everybody starts. The agent's first tick reads 0 USDG and drops it to
 * paper, and a paper tick never reads the real balance again (index.ts, the cash
 * latch beside the paper gas refresh), so the deposit is invisible until a deploy
 * restarts the child. That restart sees the money as drift and doubts its
 * contributions, but only for the life of that process, and meanwhile it writes
 * an equity row that already holds the new cash. The NEXT restart takes that row
 * as its baseline, finds no drift and resumes "clean" on contributions of zero:
 * the deposit is marked up as profit and the Brain refuses to size anything
 * against a book with no capital. On 2026-09-25 an owner sat that way with
 * 10.872801 USDG plainly on chain, told by his agent that he had no money, until
 * an operator ran MERRYMEN_REPAIR by hand.
 *
 * WHY THE FIX LIVES IN THE ORCHESTRATOR. Only a receipt — a chain-log row —
 * makes contributions known (bootstrap-state.ts accountingLicence), and a child
 * cannot write one for money that arrived before it started, because in hosted
 * mode it cannot see what is already booked (index.ts, the reverted reach-back).
 * This process can. It reads the shared ledger, scans the chain, and runs the
 * SAME repair an operator runs — accounting-repair.ts, insert, verify and
 * quarantine in one transaction — and the caller then restarts the child so it
 * arms against an anchor that holds the deposits.
 *
 * WHY ONLY THIS SHAPE. The operator repair waits for a human because two figures
 * move together and only history says how: contributions and the high-water
 * mark. For an account whose every USDG movement is an inbound deposit, whose
 * balance is exactly their sum, and which has never traded, sent money out or
 * used its vault, history has one reading: the contributions ARE the deposits,
 * and so is the peak. Anything else is refused here and left to MERRYMEN_REPAIR,
 * exactly as before.
 */
import type { Db } from "./db";
import { scanFleetCapital, type AccountCapital, type RpcCall } from "./chain-capital";
import { planReconstruction, type AccountPlan } from "./accounting-reconstruction";
import { runRepair } from "./accounting-repair";
import { bigintToMicro, type TenantBootstrapState } from "./bootstrap-state";

/** Below a dollar is dust, not a deposit an owner is waiting on. */
export const AUTO_CAPITAL_MIN_CASH_RAW = 1_000_000n;

/**
 * HOW OLD THE NEWEST DEPOSIT MUST BE, in blocks. About ten minutes on this chain
 * (~17 blocks a second).
 *
 * A live child books a deposit it SEES by inference, within one tick. If this
 * pass booked the receipt in the seconds before that tick, the child's inferred
 * row would land on top of it and the deposit would count twice. Waiting until
 * any running child has had many ticks to see it closes that window: by then the
 * inferred row is either in the ledger — and the repair quarantines it — or the
 * child is on paper and was never going to book it.
 */
export const AUTO_CAPITAL_MIN_AGE_BLOCKS = 10_000n;

const microOf = (usdg: number): bigint => BigInt(Math.round(usdg * 1e6));
const usdgOf = (raw: bigint): string => (Number(raw) / 1e6).toFixed(6);
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export interface AutoCapitalKnobs {
  enabled: boolean;
  everyMs: number;
  /** The line an operator reads to know the switch took. */
  note: string;
}

/** Read the switch. PURE, so the default is tested rather than trusted. On unless set to exactly "0". */
export function autoCapitalEnv(env: Record<string, string | undefined> = process.env): AutoCapitalKnobs {
  const off = (env.MERRYMEN_AUTO_CAPITAL ?? "").trim() === "0";
  const raw = Number(env.MERRYMEN_AUTO_CAPITAL_EVERY_SEC);
  const everySec = Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 600;
  return {
    enabled: !off,
    everyMs: everySec * 1000,
    note: off
      ? "capital| automatic deposit booking is OFF (MERRYMEN_AUTO_CAPITAL=0) — unbooked deposits need MERRYMEN_REPAIR"
      : `capital| automatic deposit booking on — every ${everySec}s, deposit-only accounts that have never traded`,
  };
}

/** What the shared ledger says about one account, read before anything touches the chain. */
export interface LedgerFacts {
  onchainCashRaw: bigint;
  /** Σ flows that name a transaction (or bridge an epoch) — what the anchor counts as known. */
  evidencedNetRaw: bigint;
  /** Flows with no transaction. Any at all makes contributions unknown. */
  unevidencedRows: number;
  /** Trades that went anywhere near the chain — everything but paper fills and refusals. */
  liveTrades: number;
}

/**
 * Is this account worth a chain scan? PURE, and deliberately cheap to say no.
 *
 * The scan is the authority; this only keeps the fleet's RPC out of it for the
 * accounts whose ledger already agrees with their balance, or which have traded
 * and so are an operator's to judge whatever the scan would say.
 */
export function autoCapitalCandidate(f: LedgerFacts): { candidate: boolean; why: string } {
  if (f.onchainCashRaw < AUTO_CAPITAL_MIN_CASH_RAW) return { candidate: false, why: "holds under 1 USDG" };
  if (f.liveTrades > 0) return { candidate: false, why: `has ${f.liveTrades} live trade(s) on record` };
  if (f.unevidencedRows === 0 && f.evidencedNetRaw === f.onchainCashRaw) {
    return { candidate: false, why: "the ledger already matches the balance" };
  }
  return {
    candidate: true,
    why:
      `holds ${usdgOf(f.onchainCashRaw)} USDG against ${usdgOf(f.evidencedNetRaw)} of evidenced contributions` +
      (f.unevidencedRows ? ` and ${f.unevidencedRows} unevidenced flow(s)` : ""),
  };
}

export interface AutoCapitalDecision {
  apply: boolean;
  /**
   * True when the refusal can clear on its own — a scan window the node would
   * not serve, a deposit still settling — so the next pass should look again.
   * False means only a new movement of money could change the answer.
   */
  retry: boolean;
  why: string;
  /** Gross peak to raise to before booking; null when the peak already equals the deposits. */
  hwmGrossTarget: number | null;
  depositsRaw: bigint;
}

/**
 * Book it or leave it. PURE. Every refusal says why, because the refusal is what
 * an operator reads next to MERRYMEN_REPAIR.
 */
export function decideAutoCapital(a: {
  plan: AccountPlan;
  cap: AccountCapital | undefined;
  onchainCashRaw: bigint;
  /** USDG sitting in the account's class vault(s). */
  vaultCashRaw: bigint;
  head: bigint;
  minAgeBlocks?: bigint;
  hwmGrossUsdg: number;
  hwmWithdrawnUsdg: number;
}): AutoCapitalDecision {
  const no = (why: string, retry = false): AutoCapitalDecision => ({
    apply: false,
    retry,
    why,
    hwmGrossTarget: null,
    depositsRaw: 0n,
  });
  const { plan, cap } = a;
  if (!cap) return no("no chain scan result", true);
  if (!cap.complete) return no("the chain scan did not cover every window — trying again next pass", true);
  if (plan.blocked) return no(plan.blocked, !plan.chainComplete);
  // ONE EPOCH ONLY. A later epoch opens on a carried balance, and the chain's
  // deposits span every epoch, so booking them all into this one would count
  // the money twice.
  if (plan.epoch !== 1) return no(`the account is in accounting epoch ${plan.epoch} — an operator's call`);
  if (cap.movements.length === 0) return no("no USDG has ever moved on this account");

  // EVERY MOVEMENT A DEPOSIT, or nothing is decided here. A withdrawal, a trade
  // leg, a vault transfer, a fee to infrastructure or anything the classifier
  // would not name all make the peak a matter of history.
  const other = cap.movements.filter((m) => m.classification.kind !== "capital-in");
  if (other.length > 0) {
    const kinds = [...new Set(other.map((m) => m.classification.kind))].join(", ");
    return no(`the account has ${other.length} movement(s) that are not deposits (${kinds}) — an operator's call`);
  }
  if (a.vaultCashRaw !== 0n) return no(`its class vault holds ${usdgOf(a.vaultCashRaw)} USDG — an operator's call`);

  const deposits = BigInt(cap.totals.netContributionsRaw);
  // THE BALANCE MUST BE THE DEPOSITS, TO THE MICRO-USDG. If it is not, money
  // moved in a way the USDG logs do not show, and booking the deposits would
  // leave that difference to be read as profit or loss.
  if (a.onchainCashRaw !== deposits) {
    return no(
      `the balance ${usdgOf(a.onchainCashRaw)} is not the sum of the deposits ${usdgOf(deposits)} — an operator's call`,
    );
  }

  const newest = cap.movements.reduce((m, x) => (x.blockNumber > m ? x.blockNumber : m), 0);
  const minAge = a.minAgeBlocks ?? AUTO_CAPITAL_MIN_AGE_BLOCKS;
  if (BigInt(newest) > a.head - minAge) {
    return no(`the newest deposit (block ${newest}) is still settling — a running agent may book it first`, true);
  }

  if (plan.insert.length === 0 || plan.insert.some((r) => r.direction !== "in")) {
    return no("the repair plan does not consist of deposits");
  }
  if (plan.quarantine.length === 0 && microOf(plan.existingTotalUsdg) === deposits) {
    return no("the ledger already records these deposits");
  }

  // THE PEAK. With nothing but deposits, the highest the book has ever honestly
  // stood is their sum. Below it, it rises to meet it here — otherwise the first
  // live tick would read the deposits as profit above the peak. Above it, the
  // peak came from something this pass cannot see, and it is not touched.
  const effective = microOf(a.hwmGrossUsdg) - microOf(a.hwmWithdrawnUsdg);
  if (effective > deposits) {
    return no(
      `the recorded peak ${usdgOf(effective)} is above every dollar ever deposited (${usdgOf(deposits)}) on an ` +
        "account that has never traded — an operator's call",
    );
  }
  const hwmGrossTarget = effective < deposits ? a.hwmWithdrawnUsdg + Number(deposits) / 1e6 : null;
  return {
    apply: true,
    retry: false,
    why: `${cap.movements.length} deposit(s) totalling ${usdgOf(deposits)} USDG, nothing else ever moved`,
    hwmGrossTarget,
    depositsRaw: deposits,
  };
}

/** The balance this process read off the chain for an account it just booked. */
export interface VerifiedCash {
  cashRaw: bigint;
  atSec: number;
}

/**
 * Hand the restarted child the balance that was just verified. PURE.
 *
 * The child's downtime check compares its first balance against the anchor's
 * newest equity row. For an account that went unbooked, that row is from before
 * the deposit, or from a paper tick, so without this the booked money would be
 * read as fresh drift and contributions doubted all over again. The override
 * stands only until the child writes an equity row of its own.
 */
export function withVerifiedCash(
  accounting: TenantBootstrapState["accounting"],
  verified: VerifiedCash | undefined,
  newestEquityAtSec: number | null,
): TenantBootstrapState["accounting"] {
  if (!verified || accounting.kind !== "established") return accounting;
  // STRICTLY newer. A row from the same second can only be the dying child's
  // last one, and on a paper-latched agent that row holds paper cash.
  if (newestEquityAtSec !== null && newestEquityAtSec > verified.atSec) return accounting;
  return {
    ...accounting,
    lastObservedCashUsdg: bigintToMicro(verified.cashRaw),
    observedAt: Math.max(accounting.observedAt, verified.atSec),
  };
}

export interface AutoCapitalTenant {
  tenant: string;
  smartAccount: string;
  vaults: readonly string[];
}

export interface AutoCapitalBooked {
  tenant: string;
  account: string;
  cashRaw: bigint;
  deposits: number;
}

export interface AutoCapitalDeps {
  db: Db;
  rpc: RpcCall;
  usdgToken: string;
  chainId: number;
  tenants: readonly AutoCapitalTenant[];
  /** account (lower-case) → the balance it was refused at. Skipped until the balance moves. */
  refused: Map<string, bigint>;
  log: (m: string) => void;
  scan?: typeof scanFleetCapital;
  nowSec?: () => number;
  minAgeBlocks?: bigint;
}

async function balanceOf(rpc: RpcCall, token: string, holder: string, block?: bigint): Promise<bigint> {
  const data = "0x70a08231" + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const tag = block === undefined ? "latest" : "0x" + block.toString(16);
  return BigInt((await rpc("eth_call", [{ to: token, data }, tag])) as string);
}

/**
 * One pass over the tenants this replica holds. Returns the accounts it booked,
 * so the caller can restart their children and hand them the verified balance.
 * Never throws for one account's sake: each is read, judged and written alone.
 */
export async function runAutoCapitalPass(d: AutoCapitalDeps): Promise<AutoCapitalBooked[]> {
  const nowSec = d.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const candidates: {
    t: AutoCapitalTenant;
    agent: Record<string, unknown>;
    account: string;
    cashRaw: bigint;
  }[] = [];

  for (const t of d.tenants) {
    const key = t.smartAccount.toLowerCase();
    try {
      const agents = (await d.db
        .prepare(
          "SELECT smart_account, owner_address, epoch, mode, hwm_usdg, hwm_withdrawn_usdg, contributions_known " +
            "FROM agents WHERE LOWER(smart_account) = ?",
        )
        .all(key)) as Record<string, unknown>[];
      // NO LEDGER ROW, NO PEAK TO KEEP IN STEP. The child writes the row on its
      // first tick; the next pass finds it.
      if (agents.length !== 1) continue;
      const agent = agents[0]!;
      const cashRaw = await balanceOf(d.rpc, d.usdgToken, t.smartAccount);
      const refusedAt = d.refused.get(key);
      if (refusedAt !== undefined) {
        if (refusedAt === cashRaw) continue;
        d.refused.delete(key);
      }
      const epoch = num(agent.epoch) || 1;
      const flows = (await d.db
        .prepare(
          "SELECT " +
            "COALESCE(SUM(CASE WHEN (tx_hash IS NOT NULL AND tx_hash <> '') OR source = 'epoch-carry' " +
            "THEN (CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) ELSE 0 END), 0) AS evidenced, " +
            "COALESCE(SUM(CASE WHEN (tx_hash IS NOT NULL AND tx_hash <> '') OR source = 'epoch-carry' " +
            "THEN 0 ELSE 1 END), 0) AS unevidenced " +
            "FROM flows WHERE LOWER(agent_id) = ? AND epoch = ?",
        )
        .get(key, epoch)) as { evidenced: unknown; unevidenced: unknown } | undefined;
      const trades = (await d.db
        .prepare("SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ? AND status NOT IN ('paper', 'rejected')")
        .get(key)) as { n: unknown } | undefined;
      const c = autoCapitalCandidate({
        onchainCashRaw: cashRaw,
        evidencedNetRaw: microOf(num(flows?.evidenced)),
        unevidencedRows: num(flows?.unevidenced),
        liveTrades: num(trades?.n),
      });
      if (!c.candidate) continue;
      d.log(`capital| ${String(agent.smart_account)} ${c.why} — scanning its history`);
      candidates.push({ t, agent, account: String(agent.smart_account), cashRaw });
    } catch (e) {
      d.log(`capital| ${t.smartAccount} could not be read — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (candidates.length === 0) return [];

  // EVERY ACCOUNT THIS SYSTEM CONTROLS, not just the ones being scanned. The
  // classifier calls a transfer from a hosted account internal only if it knows
  // the sender is one; left out, an owner moving money from an old account (or
  // one agent paying another) would be booked here as a fresh outside deposit.
  // Internal is not a deposit, so such an account is refused below.
  const roster = (await d.db.prepare("SELECT smart_account FROM agents").all()) as { smart_account: unknown }[];
  const knownAccounts = [
    ...new Set(
      [...roster.map((r) => String(r.smart_account)), ...d.tenants.map((t) => t.smartAccount)].map((a) =>
        a.toLowerCase(),
      ),
    ),
  ];

  const head = BigInt((await d.rpc("eth_blockNumber", [])) as string);
  const vaultsOf = new Map(candidates.map((c) => [c.account.toLowerCase(), c.t.vaults]));
  const chain = await (d.scan ?? scanFleetCapital)(d.rpc, {
    accounts: candidates.map((c) => c.account),
    knownAccounts,
    usdgToken: d.usdgToken,
    fromBlock: 0n,
    toBlock: head,
    // Without the vault in the set, a class buy reads as a withdrawal (chain-capital.ts).
    custodyAddressesFor: (a) => vaultsOf.get(a.toLowerCase()),
    log: (m) => d.log(`capital| ${m}`),
  });

  const booked: AutoCapitalBooked[] = [];
  for (const c of candidates) {
    const key = c.account.toLowerCase();
    try {
      let vaultCashRaw = 0n;
      for (const v of c.t.vaults) vaultCashRaw += await balanceOf(d.rpc, d.usdgToken, v);
      const epoch = num(c.agent.epoch) || 1;
      const flows = (await d.db
        .prepare(
          "SELECT id, agent_id, epoch, direction, amount_usdg, source, tx_hash, at FROM flows WHERE LOWER(agent_id) = ?",
        )
        .all(key)) as Record<string, unknown>[];
      const mark = (await d.db
        .prepare("SELECT equity_usdg FROM equity WHERE LOWER(agent_id) = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 1")
        .get(key, epoch)) as { equity_usdg: unknown } | undefined;
      const equityByAccountEpoch = new Map<string, number>();
      if (mark) equityByAccountEpoch.set(`${key}#${epoch}`, num(mark.equity_usdg));
      const [plan] = planReconstruction({
        agents: [c.agent],
        flows,
        equityByAccountEpoch,
        chain,
        onchainCash: new Map([[key, Number(c.cashRaw) / 1e6]]),
        tenantByAccount: new Map([[key, c.t.tenant]]),
      });
      if (!plan) continue;

      const dec = decideAutoCapital({
        plan,
        cap: chain.get(key),
        onchainCashRaw: c.cashRaw,
        vaultCashRaw,
        head,
        minAgeBlocks: d.minAgeBlocks,
        hwmGrossUsdg: num(c.agent.hwm_usdg),
        hwmWithdrawnUsdg: num(c.agent.hwm_withdrawn_usdg),
      });
      if (!dec.apply) {
        d.log(`capital| ${c.account} NOT booked — ${dec.why}`);
        if (!dec.retry) d.refused.set(key, c.cashRaw);
        continue;
      }

      // THE SNAPSHOT AGAIN, AT THE LAST MOMENT. The decision above rests on a
      // balance read before the head was fixed and a history read up to that
      // head, and the history scan can take a while. Money that moved after it —
      // a withdrawal, say — is in neither, while the old balance still equals
      // the old deposits. So: a fresh head, every movement since the scanned one,
      // and the balance AT that fresh head. Anything moved, or any difference,
      // and nothing is written; the next pass judges the new state.
      const confirmHead = BigInt((await d.rpc("eth_blockNumber", [])) as string);
      if (confirmHead > head) {
        const since = (
          await (d.scan ?? scanFleetCapital)(d.rpc, {
            accounts: [c.account],
            knownAccounts,
            usdgToken: d.usdgToken,
            fromBlock: head + 1n,
            toBlock: confirmHead,
            custodyAddressesFor: (a) => vaultsOf.get(a.toLowerCase()),
            log: (m) => d.log(`capital| ${m}`),
          })
        ).get(key);
        if (!since || !since.complete || since.movements.length > 0) {
          d.log(
            `capital| ${c.account} NOT booked — ` +
              (since && since.complete
                ? `${since.movements.length} USDG movement(s) since block ${head}; judging again next pass`
                : `could not confirm nothing moved since block ${head}; trying again next pass`),
          );
          continue;
        }
      }
      const cashAtConfirm = await balanceOf(d.rpc, d.usdgToken, c.account, confirmHead);
      if (cashAtConfirm !== c.cashRaw) {
        d.log(
          `capital| ${c.account} NOT booked — the balance moved from ${usdgOf(c.cashRaw)} to ${usdgOf(cashAtConfirm)} ` +
            "while it was being judged; judging again next pass",
        );
        continue;
      }

      // THE PEAK FIRST. Raised on its own it is exactly what the next live tick
      // would ratchet to anyway, so a failure after this line leaves nothing
      // worse than today. Booking the deposits first and failing here would
      // leave them booked under a peak that treats them as profit.
      if (dec.hwmGrossTarget !== null) {
        await d.db
          .prepare("UPDATE agents SET hwm_usdg = CASE WHEN ? > hwm_usdg THEN ? ELSE hwm_usdg END WHERE smart_account = ?")
          .run(dec.hwmGrossTarget, dec.hwmGrossTarget, c.account);
        const after = (await d.db
          .prepare("SELECT hwm_usdg, hwm_withdrawn_usdg FROM agents WHERE smart_account = ?")
          .get(c.account)) as { hwm_usdg: unknown; hwm_withdrawn_usdg: unknown } | undefined;
        const effective = microOf(num(after?.hwm_usdg)) - microOf(num(after?.hwm_withdrawn_usdg));
        if (effective !== dec.depositsRaw) {
          d.log(`capital| ${c.account} NOT booked — the peak read back as ${usdgOf(effective)}, wanted ${usdgOf(dec.depositsRaw)}`);
          continue;
        }
      }

      const runId = `auto-capital-${nowSec()}-${key.slice(2, 10)}`;
      const [result] = await runRepair(
        d.db,
        [plan],
        { mode: "commit", accounts: [key], runId, resume: false },
        d.chainId,
      );
      if (!result || result.stage !== "recomputed" || !result.contributionsKnownAfter) {
        d.log(`capital| ${c.account} NOT booked — the repair ${result?.stage ?? "returned nothing"}: ${result?.why ?? ""}`);
        continue;
      }

      // RECORDED BEFORE ANYTHING ELSE CAN FAIL. The deposits are committed; if
      // the caller never hears so, the child is never restarted, keeps its old
      // anchor, and the next pass skips the account because its ledger now
      // agrees with its balance. The owner's note below is best effort.
      const deposits = plan.insert.length;
      booked.push({ tenant: c.t.tenant, account: c.account, cashRaw: c.cashRaw, deposits });
      try {
        await d.db
          .prepare("INSERT INTO events (agent_id, level, message) VALUES (?, ?, ?)")
          .run(
            c.account,
            "ok",
            `📥 your deposits are on record — ${deposits} transfer(s) totalling ${usdgOf(dec.depositsRaw)} USDG, read ` +
              "from the chain. They count as the money you put in, not as profit, so your agent can size trades against them.",
          );
      } catch (e) {
        d.log(`capital| ${c.account} booked, but the owner's note was not written — ${e instanceof Error ? e.message : String(e)}`);
      }
      d.log(
        `capital| ${c.account} BOOKED — ${dec.why}; contributions ${result.contributionsBeforeUsdg.toFixed(6)} -> ` +
          `${result.contributionsAfterUsdg.toFixed(6)}, quarantined ${result.quarantined}` +
          (dec.hwmGrossTarget !== null ? `, peak raised to ${usdgOf(dec.depositsRaw)}` : "") +
          ` (run ${runId})`,
      );
    } catch (e) {
      d.log(`capital| ${c.account} failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return booked;
}
