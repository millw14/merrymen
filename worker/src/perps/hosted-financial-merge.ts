/** Fold a finished shutdown into its exact full financial book without loading either history. */
import { createHash } from "node:crypto";
import { FINANCIAL_CAPSULE_TABLES } from "./hosted-financial-capsule";
import { STANDDOWN_TABLES } from "./hosted-standdown-ledger";
import { decodeFinancialRecords, encodeFinancialRecord, JOURNAL_KEYS, PUBLIC_AGENT_COLUMNS, validateFinancialStream,
  type FinancialChunks, type FinancialRow, type FinancialScope, type FinancialStreamRecord } from "./hosted-financial-stream";

class Cursor {
  item: FinancialStreamRecord | undefined;
  constructor(private iterator: AsyncGenerator<FinancialStreamRecord>) {}
  async next(): Promise<void> { const r = await this.iterator.next(); this.item = r.done ? undefined : r.value; }
  async header(scope: FinancialScope): Promise<void> {
    await this.next();
    if (this.item?.type !== "header" || this.item.scope !== scope) throw new Error("financial merge scope refused");
    await this.next();
  }
  async table(name: string): Promise<void> {
    if (this.item?.type !== "table" || this.item.name !== name) throw new Error("financial merge table order refused");
    await this.next();
  }
  row(): Extract<FinancialStreamRecord, { type: "row" }> | undefined {
    return this.item?.type === "row" ? this.item : undefined;
  }
  async finish(): Promise<void> {
    if (this.item?.type !== "end") throw new Error("financial merge input incomplete");
    await this.next(); // Exhaustion checks page digests and validator completion too.
    if (this.item !== undefined) throw new Error("financial merge trailing records refused");
  }
  async close(): Promise<void> { await this.iterator.return(undefined); }
}

/**
 * Both inputs are consumed once. Only one row from each and one public agent
 * identity are retained. Publish the result only after this iterator completes;
 * a late page failure must roll back staged output along with any restored rows.
 */
export async function* mergeFinancialStreams(full: FinancialChunks, shutdown: FinancialChunks, account: string): AsyncGenerator<Buffer> {
  const original = new Cursor(decodeFinancialRecords(validateFinancialStream(full, account, { scope: "financial" })));
  let reduced: Cursor | undefined;
  let agent: FinancialRow | undefined;
  try {
    await original.header("financial");
    yield encodeFinancialRecord({ type: "header", v: 3, scope: "financial", account: account.toLowerCase() });
    for (const table of FINANCIAL_CAPSULE_TABLES) {
      await original.table(table);
      yield encodeFinancialRecord({ type: "table", name: table });
      if (table === "journal") {
        const hash = createHash("sha256"); let count = 0;
        while (original.item?.type === "row") {
          const row = original.item.value;
          hash.update(JSON.stringify(JOURNAL_KEYS.map(k => row[k])) + "\n");
          count++; await original.next();
        }
        reduced = new Cursor(decodeFinancialRecords(validateFinancialStream(shutdown, account, {
          scope: "standdown", priorJournalProof: { count, digest: hash.digest("hex") },
        })));
        await reduced.header("standdown"); await reduced.table("agents");
        let sawAgent = false;
        while (reduced.item?.type === "row") {
          const row = reduced.item.value;
          if (!agent || PUBLIC_AGENT_COLUMNS.some(k => row[k] !== agent![k])) throw new Error("financial merge shutdown agent identity changed");
          sawAgent = true; await reduced.next();
        }
        if (!!agent !== sawAgent) throw new Error("financial merge shutdown agent identity missing");
        await reduced.table("journal");
        for (let row = reduced.row(); row; row = reduced.row()) { yield encodeFinancialRecord(row); await reduced.next(); }
      } else {
        const perps = (STANDDOWN_TABLES as readonly string[]).includes(table);
        while (original.item?.type === "row") {
          const row = original.item.value;
          if (table === "agents") agent = row;
          if (!perps || row.mode !== "live") yield encodeFinancialRecord(original.item);
          await original.next();
        }
        if (perps) {
          if (!reduced) throw new Error("financial merge shutdown journal missing");
          await reduced.table(table);
          while (reduced.item?.type === "row") {
            const value = table === "perp_orders" ? { ...reduced.item.value, tx_info: null } : reduced.item.value;
            yield encodeFinancialRecord({ type: "row", value }); await reduced.next();
          }
        }
      }
    }
    await original.finish();
    if (!reduced) throw new Error("financial merge shutdown stream missing");
    await reduced.finish();
    yield encodeFinancialRecord({ type: "end" });
  } finally {
    await Promise.allSettled([original.close(), reduced?.close()]);
  }
}
