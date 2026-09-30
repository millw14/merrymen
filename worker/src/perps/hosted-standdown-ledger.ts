/** A bounded account-bound ledger capsule, never a copy of the normal child's home. */
import type { Db } from "../db";
import { JOURNAL_GENESIS, journalHash } from "../store";

export const STANDDOWN_TABLES = ["perp_accounts", "perp_orders", "perp_order_legs", "perp_fills", "perp_funding", "perp_transfers", "perp_positions", "perp_carries", "perp_payouts"] as const;
type Row = Record<string, unknown>;
export interface StanddownLedger { v: 1; account: string; agent: Row | null; tables: Record<string, Row[]>; journal: Row[] }
/** Only public account identity and epoch are needed by store.ts's journal writer. */
const AGENT_COLUMNS = ["smart_account", "name", "owner_address", "session_key_address", "chain_id", "caps", "granted_at", "expires_at", "epoch"];

export async function captureStanddownLedger(db: Db, account: string, opts: { journalHeadOnly?: boolean } = {}): Promise<Buffer> {
 const tables: Record<string, Row[]> = {};
 for (const t of STANDDOWN_TABLES) {
  tables[t] = await db.prepare(`SELECT * FROM ${t} WHERE lower(agent_id) = ? AND mode = 'live'`).all(account.toLowerCase()) as Row[];
 }
 const agent = await db.prepare(`SELECT ${AGENT_COLUMNS.join(",")} FROM agents WHERE lower(smart_account) = ?`).get(account.toLowerCase()) as Row | undefined;
 const journal = await db.prepare(`SELECT * FROM journal WHERE lower(agent_id) = ? ORDER BY seq ${opts.journalHeadOnly ? "DESC LIMIT 1" : "ASC"}`)
  .all(account.toLowerCase()) as Row[];
 return encodeStanddownLedger({ v: 1, account: account.toLowerCase(), agent: agent ?? null, tables, journal });
}
export function encodeStanddownLedger(x: StanddownLedger): Buffer {
 const bytes = Buffer.from(JSON.stringify(x));
 validateStanddownLedger(bytes, x.account);
 return bytes;
}
export function validateStanddownLedger(bytes: Buffer, account: string): StanddownLedger {
 if (!bytes.length) throw new Error("stand-down ledger is empty");
 const x = JSON.parse(bytes.toString("utf8")) as StanddownLedger;
 const bound = account.toLowerCase();
 if (x.v !== 1 || x.account !== bound || !/^0x[0-9a-f]{40}$/.test(bound) || !x.tables || !Array.isArray(x.journal)) throw new Error("stand-down ledger account mismatch");
 if (Object.keys(x).some(k => !["v", "account", "agent", "tables", "journal"].includes(k))) throw new Error("stand-down ledger contains unrelated material");
 if (Object.keys(x.tables).some(k => !(STANDDOWN_TABLES as readonly string[]).includes(k))) throw new Error("stand-down ledger contains an unrelated table");
 const validRow = (row: Row, column: string) => {
  if (!row || typeof row !== "object" || Array.isArray(row) || String(row[column]).toLowerCase() !== bound || Object.values(row).some(v => v !== null && !["number", "string"].includes(typeof v))) throw new Error("stand-down ledger contains a foreign or malformed row");
  if (Object.keys(row).some(k => !/^[a-z_]+$/.test(k))) throw new Error("stand-down ledger column refused");
 };
 if (x.agent) {
  validRow(x.agent, "smart_account");
  if (Object.keys(x.agent).some(k => !AGENT_COLUMNS.includes(k))) throw new Error("stand-down agent contains unrelated fields");
 }
 for (const t of STANDDOWN_TABLES) {
  const rows = x.tables[t];
  if (!Array.isArray(rows)) throw new Error("stand-down ledger table refused");
  for (const row of rows) { validRow(row, "agent_id"); if (row.mode !== "live") throw new Error("stand-down paper row refused"); }
 }
 for (const row of x.journal) validRow(row, "agent_id");
 return x;
}

/** Complete, exact chain proof for an ordinary live checkpoint. A partial head is never enough. */
export function validateCompleteJournal(bytes: Buffer, account: string, previous?: Buffer | null): StanddownLedger {
 const x = validateStanddownLedger(bytes, account);
 validateJournalHistory(x.journal, account, previous ? validateCompleteJournal(previous, account).journal : undefined);
 return x;
}
/** Validate rows directly, without materializing a second serialized history. */
export function validateJournalHistory(rows: Row[], account: string, previous?: Row[]): void {
 const heads = new Map<number, string>(); let seq = 0;
 for (const row of rows) {
  const epoch = Number(row.epoch), n = Number(row.seq);
  if (String(row.agent_id).toLowerCase() !== account.toLowerCase() || !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(n) || n !== seq + 1 || typeof row.payload_json !== "string") throw new Error("perps journal sequence is incomplete");
  const prev = heads.get(epoch) ?? JOURNAL_GENESIS;
  if (row.prev_hash !== prev || row.hash !== journalHash(prev, row.payload_json)) throw new Error("perps journal chain does not verify");
  heads.set(epoch, String(row.hash)); seq = n;
 }
 if (previous) {
  if (rows.length < previous.length) throw new Error("perps journal history was shortened");
  for (let i = 0; i < previous.length; i++) {
   const a = previous[i]!, b = rows[i]!;
   for (const key of ["seq", "agent_id", "epoch", "kind", "payload_json", "prev_hash", "hash", "at"]) {
    if (a[key] !== b[key]) throw new Error("perps journal history was replaced");
   }
  }
 }
}

/** Destination is a fresh local ledger with the trusted application schema. */
export async function restoreStanddownLedger(db: Db, bytes: Buffer, account: string): Promise<void> {
 const x = validateStanddownLedger(bytes, account);
 await db.tx(async tx => {
  const insert = async (table: string, rows: Row[]) => {
   const schema = await tx.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
   const allowed = new Set(schema.map(c => c.name));
   for (const row of rows) {
    const cols = Object.keys(row);
    if (!cols.length || cols.some(c => !allowed.has(c))) throw new Error("stand-down ledger schema refused");
    await tx.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`).run(...cols.map(c => row[c]));
   }
  };
  if (x.agent) await insert("agents", [x.agent]);
  for (const t of STANDDOWN_TABLES) await insert(t, x.tables[t]!);
  await insert("journal", x.journal);
 });
}

/** Shared journal has no child-local seq. Hash deduplication keeps retries idempotent. */
export async function mirrorStanddownJournal(shared: Db, bytes: Buffer, account: string): Promise<void> {
 const x = validateStanddownLedger(bytes, account);
 await shared.tx(async tx => {
  for (const row of x.journal) {
   if (!["perp-fill", "funding", "margin", "perp-carry"].includes(String(row.kind))) continue;
   const held = await tx.prepare("SELECT hash FROM journal WHERE lower(agent_id) = ? AND epoch = ? AND hash = ?").get(account.toLowerCase(), row.epoch, row.hash);
   if (!held) await tx.prepare("INSERT INTO journal (agent_id, epoch, kind, payload_json, prev_hash, hash, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.agent_id, row.epoch, row.kind, row.payload_json, row.prev_hash, row.hash, row.at);
  }
 });
}
