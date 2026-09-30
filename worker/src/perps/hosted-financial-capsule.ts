/** A single, encrypted recovery snapshot for the journal and every financial domain it describes. */
import { preserveAccountControls } from "./owner-controls";
import type { Db } from "../db";
import { resetBootstrapFlowIdentity } from "../bootstrap-flow-cursor";
import { OrderDeadlineFloor } from "./restore-order-deadline";
import { encodeStanddownLedger, STANDDOWN_TABLES, validateJournalHistory, type StanddownLedger } from "./hosted-standdown-ledger";

export const FINANCIAL_CAPSULE_TABLES = ["agents", "journal", "trades", "flows", "equity", "fee_accruals", "positions", "cost_basis", "position_floors", "trench_positions", "class_positions", "paper_book", "risk_periods", "energy_days", "decisions", "flows_quarantine", ...STANDDOWN_TABLES] as const;
type Row = Record<string, unknown>;
export interface FinancialCapsule { v: 2; account: string; tables: Record<string, Row[]> }
const identity = (table: string) => table === "agents" ? "smart_account" : "agent_id";

/** Caller holds a single SQLite read transaction across this entire capture. */
export async function captureFinancialCapsule(db: Db, account: string): Promise<Buffer> {
 const tables: Record<string, Row[]> = {};
 for (const table of FINANCIAL_CAPSULE_TABLES) {
  tables[table] = await db.prepare(`SELECT * FROM ${table} WHERE lower(${identity(table)}) = ?${table === "journal" ? " ORDER BY seq ASC" : ""}`).all(account.toLowerCase()) as Row[];
 }
 const bytes = Buffer.from(JSON.stringify({ v: 2, account: account.toLowerCase(), tables }));
 validateFinancialCapsule(bytes, account); return bytes;
}
export function validateFinancialCapsule(bytes: Buffer, account: string, previous?: Buffer | null): FinancialCapsule {
 if (!bytes.length) throw new Error("financial capsule is empty");
 const x = JSON.parse(bytes.toString("utf8")) as FinancialCapsule;
 if (x.v !== 2 || x.account !== account.toLowerCase() || !/^0x[0-9a-f]{40}$/.test(x.account) || !x.tables || Object.keys(x).some(k => !["v", "account", "tables"].includes(k))) throw new Error("financial capsule binding refused");
 if (Object.keys(x.tables).some(k => !(FINANCIAL_CAPSULE_TABLES as readonly string[]).includes(k))) throw new Error("financial capsule includes an unrelated table");
 for (const table of FINANCIAL_CAPSULE_TABLES) {
  const rows = x.tables[table];
  if (!Array.isArray(rows)) throw new Error("financial capsule table refused");
  for (const row of rows) {
   if (!row || typeof row !== "object" || Array.isArray(row) || String(row[identity(table)]).toLowerCase() !== x.account || Object.values(row).some(v => v !== null && !["number", "string"].includes(typeof v)) || Object.keys(row).some(k => !/^[a-z_]+$/.test(k))) throw new Error("financial capsule contains a foreign or malformed row");
  }
 }
 if (x.tables.agents!.length > 1) throw new Error("financial capsule agent identity ambiguous");
 const prior = previous ? validateFinancialCapsule(previous, account).tables.journal : undefined;
 validateJournalHistory(x.tables.journal!, account, prior);
 return x;
}
/** The temporary venue process receives only perps rows, public identity and journal continuity. */
export function narrowFinancialCapsule(x: FinancialCapsule): Buffer {
 const agent = x.tables.agents![0];
 const columns = ["smart_account", "name", "owner_address", "session_key_address", "chain_id", "caps", "granted_at", "expires_at", "epoch"];
 const tables: StanddownLedger["tables"] = {};
 for (const table of STANDDOWN_TABLES) tables[table] = x.tables[table]!.filter(r => r.mode === "live");
 return encodeStanddownLedger({ v: 1, account: x.account, agent: agent ? Object.fromEntries(columns.filter(k => k in agent).map(k => [k, agent[k]])) : null,
  tables, journal: x.tables.journal! });
}
export async function restoreFinancialCapsule(db: Db, bytes: Buffer, account: string): Promise<void> {
 const x = validateFinancialCapsule(bytes, account);
 await db.tx(async tx => {
  await resetBootstrapFlowIdentity(tx);
  for (const table of FINANCIAL_CAPSULE_TABLES) {
   const columns = await tx.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
   const allowed = new Set(columns.map(c => c.name));
   // The destination is this account's child. A foreign row is never overwritten.
   if (await tx.prepare(`SELECT 1 FROM ${table} WHERE lower(${identity(table)}) <> ? LIMIT 1`).get(account.toLowerCase())) throw new Error("financial recovery found a foreign tenant's row");
   const heldAccounts = table === "perp_accounts" ? await tx.prepare("SELECT * FROM perp_accounts WHERE lower(agent_id) = ?").all(account.toLowerCase()) as Row[] : [];
   const deadlines=table==="perp_orders"?await OrderDeadlineFloor.create(tx):undefined;
   try {
   if(deadlines)await deadlines.rememberLedger(account,false);
   await tx.prepare(`DELETE FROM ${table} WHERE lower(${identity(table)}) = ?`).run(account.toLowerCase());
   const sourceRows = [...x.tables[table]!];
   if (table === "perp_accounts") for (const held of heldAccounts) if (!sourceRows.some(r => r.mode === held.mode)) sourceRows.push(held);
   for (const original of sourceRows) {
    const row = table === "perp_accounts" ? preserveAccountControls(original, heldAccounts.find(r => r.mode === original.mode)) : deadlines ? await deadlines.apply(original) : original;
    const keys = Object.keys(row);
    if (!keys.length || keys.some(k => !allowed.has(k))) throw new Error("financial capsule schema refused");
    await tx.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k]));
   }
   } finally { await deadlines?.close(); }
  }
 });
}
