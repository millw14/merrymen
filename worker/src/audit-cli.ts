/**
 * `merrymen export` and `merrymen verify` — the two commands that make the
 * README's "verifiable, not claimed" true rather than aspirational.
 *
 * The pair is meant to be used by someone who does not trust the operator:
 *
 *   merrymen export > ledger.jsonl        # run by the operator
 *   merrymen verify ledger.jsonl          # run by anyone, anywhere
 *
 * `verify` deliberately reads NOTHING but the file it is handed. It does not
 * open ~/.merrymen, does not consult settings, and does not care which machine
 * produced the export — otherwise it would only be checking the operator's
 * ledger against itself, which proves nothing.
 */

import { readFileSync } from "node:fs";
import { getAgentEpoch, readJournal, type JournalEntry } from "./store";
import {
  compareRecord,
  reconcile,
  reconstruct,
  verifyChain,
  type AuditFinding,
  type ExportedEntry,
  type FetchedReceipt,
} from "./audit";
import { gasQualifier, pnlUsdg } from "./equity";
import {
  guaranteeLines,
  qualityGaps,
  UNKNOWN_QUALITY,
  type PortfolioQuality,
} from "./portfolio-quality";

const args = process.argv.slice(2);
const cmd = args[0];

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Whose ledger to export. One agent per install, so the armed one, else newest. */
async function resolveAgent(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const { DatabaseSync } = await import("node:sqlite");
  const { homePaths } = await import("./home");
  const db = new DatabaseSync(homePaths.db(), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT smart_account FROM agents
          ORDER BY (status = 'armed') DESC, created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as { smart_account: string } | undefined;
    if (!row?.smart_account) fail("no agent in the ledger — nothing to export.");
    return row.smart_account;
  } finally {
    db.close();
  }
}

/** The chain and cash token this ledger is about — recorded in the export header. */
async function exportContext(agentId: string): Promise<{ chainId: number | null; usdgToken: string }> {
  const { CASH } = await import("../../packages/core/src/index");
  const { DatabaseSync } = await import("node:sqlite");
  const { homePaths } = await import("./home");
  let chainId: number | null = null;
  try {
    const db = new DatabaseSync(homePaths.db(), { readOnly: true });
    const row = db
      .prepare("SELECT chain_id FROM agents WHERE smart_account = ?")
      .get(agentId) as { chain_id: number } | undefined;
    chainId = row?.chain_id ?? null;
    db.close();
  } catch {
    /* the export is still valid without it; the verifier says what is missing */
  }
  return { chainId, usdgToken: String(CASH.USDG) };
}

async function doExport(): Promise<void> {
  const agentFlag = args.indexOf("--agent");
  const epochFlag = args.indexOf("--epoch");
  const agentId = await resolveAgent(agentFlag >= 0 ? args[agentFlag + 1] : undefined);
  const epoch = epochFlag >= 0 ? Number(args[epochFlag + 1]) : await getAgentEpoch(agentId);
  if (!Number.isInteger(epoch) || epoch < 1) fail(`bad --epoch: ${args[epochFlag + 1]}`);

  const entries = await readJournal(agentId, epoch);
  // A header line, so the file says what it is and a verifier can refuse a file
  // it doesn't understand rather than guessing.
  //
  // It also carries what an on-chain check NEEDS: whose account to measure
  // movements for, which chain, and which token is cash. Without those the
  // verifier would have to be told them out of band — and anything the auditor
  // has to be told separately is something the operator gets to choose.
  const { chainId, usdgToken } = await exportContext(agentId);
  process.stdout.write(
    JSON.stringify({
      format: "merrymen-journal",
      version: 1,
      agentId,
      epoch,
      chainId,
      usdgToken,
      records: entries.length,
    }) + "\n",
  );
  for (const e of entries) process.stdout.write(JSON.stringify(e) + "\n");
  if (entries.length === 0) {
    console.error(
      `\n(no journal records for epoch ${epoch}. Rows written before the audit trail existed are ` +
        `epoch 1 and are deliberately not exportable — they cannot be verified, so presenting them ` +
        `as an audit would be dishonest.)`,
    );
  }
}

function readExport(file: string): { header: Record<string, unknown>; entries: ExportedEntry[] } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return fail(`cannot read ${file}`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) fail(`${file} is empty`);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]!) as Record<string, unknown>;
  } catch {
    return fail(`${file}: first line is not the export header`);
  }
  if (header.format !== "merrymen-journal") fail(`${file}: not a merrymen journal export`);
  const entries: ExportedEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]!) as ExportedEntry);
    } catch {
      fail(`${file}: line ${i + 1} is not valid JSON`);
    }
  }
  return { header, entries };
}

/**
 * Minimal JSON-RPC. Deliberately plain `fetch` rather than a library: a
 * verifier should be small enough that someone can read it and believe it,
 * and `eth_getTransactionReceipt` needs nothing more.
 */
async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result ?? null;
}

async function doVerify(): Promise<void> {
  const file = args[1];
  if (!file) fail("usage: merrymen verify <ledger.jsonl> [--rpc <url>]");
  const { header, entries } = readExport(file);

  console.log(`\n  merrymen ledger — agent ${header.agentId}, epoch ${header.epoch}`);
  console.log(`  ${entries.length} record(s)\n`);

  // ── 1. tamper evidence ────────────────────────────────────────────────
  const findings = verifyChain(entries);
  if (findings.length === 0) {
    console.log("  ✓ hash chain intact — no record was edited, and none is missing");
  } else {
    console.log(`  ✗ ${findings.length} problem(s) with the record itself:`);
    for (const f of findings) console.log(`      [${f.check}] seq ${f.seq ?? "?"}: ${f.detail}`);
  }

  // ── 2. what the arithmetic says ───────────────────────────────────────
  const book = reconstruct(entries);
  const r = reconcile(book);
  console.log("");
  console.log(`  contributed:  ${book.netContributionsUsdg.toFixed(2)} USDG`);
  console.log(`  realized P&L: ${book.realizedPnlUsdg.toFixed(2)} USDG (gross of gas)`);
  console.log(
    `  gas paid:     ${(Number(book.gasWei) / 1e18).toFixed(6)} ETH = ${book.gasUsdg.toFixed(2)} USDG` +
      (book.gasUnpricedFills > 0 ? ` (+ ${book.gasUnpricedFills} fill(s) whose gas is UNPRICED)` : ""),
  );
  if (book.publishedEquityUsdg !== null) {
    console.log(`  equity:       ${book.publishedEquityUsdg.toFixed(2)} USDG (as published)`);
    const net = pnlUsdg(book.publishedEquityUsdg, book.netContributionsUsdg, book.gasUsdg);
    console.log(
      `  P&L net:      ${net?.toFixed(2) ?? "—"} USDG — ` +
        gasQualifier({ usdg: book.gasUsdg, unpricedTrades: book.gasUnpricedFills }),
    );
    console.log(`  residual:     ${r.residualUsdg?.toFixed(2) ?? "—"} USDG — unrealized on open positions`);
  }
  if (r.findings.length > 0) {
    console.log("");
    console.log(`  ✗ ${r.findings.length} arithmetic problem(s) — the book does not add up:`);
    for (const f of r.findings) console.log(`      ${f.detail}`);
  } else if (book.markCount > 0 && r.checked) {
    console.log(
      `  ✓ the published figures are internally consistent and the residual is within what the book can explain`,
    );
  } else if (book.markCount > 0) {
    console.log(
      `  ! the arithmetic could NOT be checked — the latest mark does not carry every term of the equity ` +
        `identity (quarantined cost was added to the journal later), so the sum cannot be closed. UNKNOWN, not sound.`,
    );
  }

  // ── 3. the chain of custody ───────────────────────────────────────────
  console.log("");
  const rpcFlag = args.indexOf("--rpc");
  const rpcUrl = rpcFlag >= 0 ? args[rpcFlag + 1] : undefined;
  const onchain: AuditFinding[] = [];
  let unreachable = 0;
  /** How many transactions were actually refetched. Zero is not a pass. */
  let onchainChecked = 0;

  if (!rpcUrl) {
    console.log(`  ${book.chainRefs.length} record(s) name a transaction and can be checked on-chain`);
    console.log(`    Pass --rpc <url> to actually refetch them.`);
  } else {
    const account = String(header.agentId ?? "");
    const usdgToken = String(header.usdgToken ?? "");
    if (!account || !usdgToken) {
      // An older export predates the header carrying what a check needs. Say
      // which field is missing rather than silently checking nothing.
      console.log(`  ! this export has no ${!account ? "agentId" : "usdgToken"} in its header — cannot check on-chain`);
    } else {
      console.log(`  checking ${book.chainRefs.length} transaction(s) against ${new URL(rpcUrl).host}…`);
      const byTx = new Map(entries.map((e) => [e.seq, e]));

      for (const ref of book.chainRefs) {
        const entry = byTx.get(ref.seq);
        if (!entry) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(entry.payload_json) as Record<string, unknown>;
        } catch {
          continue;
        }
        let receipt: FetchedReceipt | null = null;
        try {
          receipt = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [ref.txHash])) as FetchedReceipt | null;
        } catch (e) {
          // A network failure is NOT a verification failure. Conflating the two
          // would let a flaky RPC condemn an honest ledger, or a hostile one
          // launder a dishonest ledger into "couldn't check".
          console.log(`      seq ${ref.seq}: RPC error — ${e instanceof Error ? e.message : String(e)} (not checked)`);
          continue;
        }
        onchainChecked++;
        onchain.push(
          ...compareRecord({ seq: ref.seq, kind: entry.kind, payload, receipt, account, usdgToken }),
        );
      }
      if (onchain.length > 0) {
        console.log(`  ✗ ${onchain.length} record(s) disagree with the chain:`);
        for (const f of onchain) console.log(`      seq ${f.seq}: ${f.detail}`);
      } else if (onchainChecked > 0) {
        console.log(`  ✓ ${onchainChecked} transaction(s) match the chain — amounts and direction confirmed`);
      }
      if (onchainChecked < book.chainRefs.length) {
        // NEVER a green tick for work that did not happen. A verifier whose
        // failure mode is a pass is worse than no verifier, because it launders
        // "we couldn't look" into "we looked and it was fine".
        unreachable = book.chainRefs.length - onchainChecked;
        console.log(`  ! ${unreachable} of ${book.chainRefs.length} could not be fetched — UNKNOWN, not verified`);
      }
    }
  }

  if (book.unanchored.length) {
    console.log("");
    console.log(`  ${book.unanchored.length} record(s) CANNOT be checked against any chain:`);
    for (const u of book.unanchored.slice(0, 10)) {
      console.log(`      seq ${u.seq} (${u.kind}): ${u.why}`);
    }
    if (book.unanchored.length > 10) console.log(`      … and ${book.unanchored.length - 10} more`);
    console.log(`    Drop these and recompute if you want a chain-verifiable figure only.`);
  }

  // ── 4. the three guarantees, reported separately ──────────────────────
  //
  // THEY FAIL INDEPENDENTLY, SO THEY ARE REPORTED INDEPENDENTLY. Collapsing
  // them into one boolean is what let this command print a clean bill of health
  // for a run that never opened a socket: with no `--rpc` there were no on-chain
  // findings, no on-chain findings meant nothing was wrong, and nothing wrong
  // meant exit 0. "We did not look" and "we looked and it was fine" produced the
  // same output, which is the worst property a verifier can have.
  const chainFindings = findings.filter((f) => f.check === "chain" || f.check === "gap");
  const arithmetic = r.findings;

  const lowestSeq = entries.length ? Math.min(...entries.map((e) => e.seq)) : null;
  const quality: PortfolioQuality = {
    ...UNKNOWN_QUALITY,
    epoch: Number(header.epoch ?? 0) || 0,
    // Arithmetic is VERIFIED only when there was something to verify. A book
    // with no marks has not passed this check; it has not taken it.
    // THREE STATES. `r.checked` is false when a term of the equity identity was
    // missing from the mark, and an unrun check is neither a pass nor a failure.
    arithmetic: arithmetic.length > 0 ? "failed" : book.markCount > 0 && r.checked ? "verified" : "unknown",
    // The journal alone cannot say whether a contribution is missing, only
    // whether what is recorded is self-consistent. The envelope check above is
    // what would have caught the over-booking, so a clean envelope with marks
    // present is the strongest claim available from an export.
    contributionsKnown:
      arithmetic.length === 0 && book.markCount > 0 && r.checked && book.unanchored.length === 0,
    costBasisComplete: book.unanchored.filter((u) => u.kind === "fill").length === 0,
    marksComplete: book.markCount > 0,
    gasAccounting: book.gasUnpricedFills > 0 ? "gross" : book.gasWei > 0n ? "net" : "unknown",
    // THREE STATES, DECIDED HERE where the facts are, not recovered later from
    // a sentence. "We refetched nothing" is UNKNOWN; only a real disagreement
    // or a real gap in coverage is a failure.
    onchain: !rpcUrl || onchainChecked === 0
      ? "unknown"
      : onchain.length > 0 || unreachable > 0
        ? "failed"
        : "verified",
    onchainDetail: !rpcUrl
      ? "not checked — no --rpc was given, so nothing was refetched"
      : onchain.length > 0
        ? `${onchain.length} record(s) disagree with the chain`
        : unreachable > 0
          ? `${unreachable} of ${book.chainRefs.length} could not be fetched`
          : onchainChecked === 0
            ? "not checked — no record in this export names a transaction"
            : `${onchainChecked} transaction(s) refetched and matched`,
    journalContinuity:
      chainFindings.length > 0 ? "partial" : lowestSeq === null ? "unknown" : lowestSeq === 1 ? "verified" : "partial",
    journalDetail:
      chainFindings.length > 0
        ? `${chainFindings.length} break(s) in the hash chain`
        : lowestSeq === null
          ? "no records in this export"
          : lowestSeq === 1
            ? "unbroken from the first record"
            : `this export begins at seq ${lowestSeq}, so everything before it is outside the chain verified here. ` +
              `A hosted child's journal lives in an ephemeral container directory and is destroyed by a redeploy; ` +
              `if that is what happened, the earlier rows are GONE and no continuity can be established for them.`,
  };

  console.log("");
  console.log("  ── guarantees ────────────────────────────────────────────");
  for (const line of guaranteeLines(quality)) console.log(`  ${line}`);

  console.log("");
  // THREE OUTCOMES, THREE EXIT CODES.
  //
  //   0  every guarantee HELD — checked, and sound
  //   1  something FAILED — the record is wrong
  //   2  INDETERMINATE — nothing failed, but at least one guarantee was never
  //      established. A gate wanting certainty requires 0; one that only cares
  //      about detected wrongness can accept 2. Neither can mistake one for the
  //      other, which is the whole point of not sharing a code with 0.
  const failed = chainFindings.length + arithmetic.length + onchain.length > 0;
  const unknowns = qualityGaps(quality);
  // EVERY GAP COUNTS, not just the three headline guarantees.
  //
  // The first version tested only the three guarantee fields, so a book whose
  // contributions could not be established — flows with no transaction behind
  // them, the exact corruption this branch is about — reported CHECKED AND SOUND
  // and exited 0, while the line above it said P&L was unavailable. A verdict
  // that contradicts the report printed two inches higher is worse than no
  // verdict. `qualityGaps` already enumerates every unknown; the exit code now
  // reads the same list the operator does.
  const indeterminate = unknowns.length > 0;

  if (failed) {
    console.log("  verdict: FAILED — the record does not hold up. See the findings above.");
    process.exit(1);
  }
  if (indeterminate) {
    console.log("  verdict: INDETERMINATE — nothing checked was wrong, and not everything was checked:");
    for (const g of unknowns) console.log(`    · ${g}`);
    process.exit(2);
  }
  console.log("  verdict: CHECKED AND SOUND — all three guarantees held.");
  process.exit(0);
}

if (cmd === "export") {
  await doExport();
} else if (cmd === "verify") {
  await doVerify();
} else {
  fail("usage: audit-cli <export|verify> …");
}

export type { JournalEntry };
