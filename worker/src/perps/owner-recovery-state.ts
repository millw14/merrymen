/** Public immutable records of verified owner recovery. Receipt references alone never create records. */
import { createHash } from 'node:crypto';
import { readPerpRecoveryReference, validatePerpPubKey, type PerpRecoveryReference } from '../../../packages/core/src/index';
type Row = Record<string, unknown>;
export interface OwnerRecoveryRecord { id: string; reference: PerpRecoveryReference; retiredKeys: string[]; acknowledgedFills: string[] }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const body = (r: Omit<OwnerRecoveryRecord, 'id'>) => [r.reference, r.retiredKeys, r.acknowledgedFills];
export const MAX_RECOVERIES = 128;
export const MAX_ACKNOWLEDGED_FILLS = 4096;
export const recoveryEvidenceDigest = (fingerprints: readonly string[]) => hash([...new Set(fingerprints)].sort());
export function recoveryRecord(reference: PerpRecoveryReference, retiredKeys: string[], acknowledgedFills: string[]): OwnerRecoveryRecord {
 const canonical = readPerpRecoveryReference(reference);
 if (!canonical) throw new Error("perp recovery reference is malformed");
 const r = { reference: canonical, retiredKeys: [...new Set(retiredKeys)].sort(), acknowledgedFills: [...new Set(acknowledgedFills)].sort() };
 const result = { ...r, id: hash(body(r)) }; readRecoveries(JSON.stringify([result]), reference.smartAccount); return result;
}
export function readRecoveries(raw: unknown, account: string): OwnerRecoveryRecord[] {
 if (raw == null) return [];
 if (typeof raw !== 'string') throw new Error('perp recovery history is unreadable');
 const rows = JSON.parse(raw) as OwnerRecoveryRecord[];
 if (!Array.isArray(rows) || rows.length > MAX_RECOVERIES) throw new Error('perp recovery history is invalid');
 const ids = new Set<string>(), incidents = new Set<string>();
 for (const r of rows) {
  if (!r || Object.keys(r).some(k => !['id','reference','retiredKeys','acknowledgedFills'].includes(k)) || !readPerpRecoveryReference(r.reference) || r.reference.smartAccount !== account.toLowerCase() || !Array.isArray(r.retiredKeys) || !r.retiredKeys.includes(r.reference.oldPublicKey) || r.retiredKeys.some(k => validatePerpPubKey(k) !== k) || r.retiredKeys.includes(r.reference.newPublicKey) || !Array.isArray(r.acknowledgedFills) || r.acknowledgedFills.length > MAX_ACKNOWLEDGED_FILLS || r.acknowledgedFills.some(k => !/^[a-f0-9]{64}$/.test(k)) || recoveryEvidenceDigest(r.acknowledgedFills) !== r.reference.evidenceDigest || hash(body(r)) !== r.id || ids.has(r.id) || incidents.has(r.reference.incidentId)) throw new Error('perp recovery record does not verify');
  ids.add(r.id); incidents.add(r.reference.incidentId);
 }
 return rows;
}
export function mergeRecoveries(a: Row, b: Row): { recoveries_json: string | null; incident_json: unknown; incident_id: unknown; incident_sealed_pubkey: unknown } {
 if (String(a.agent_id).toLowerCase() !== String(b.agent_id).toLowerCase() || a.mode !== b.mode) throw new Error('perp recovery cross-account merge');
 const records = [...readRecoveries(a.recoveries_json, String(a.agent_id))];
 for (const r of readRecoveries(b.recoveries_json, String(b.agent_id))) {
  const held = records.find(x => x.reference.incidentId === r.reference.incidentId);
  if (held && held.id !== r.id) throw new Error('perp recovery acknowledgement conflicts');
  if (!held) records.push(r);
 }
 records.sort((x,y) => x.id.localeCompare(y.id));
 const encoded = records.length ? JSON.stringify(records) : null;
 readRecoveries(encoded, String(a.agent_id));
 const unresolved = [a,b].filter(r => r.incident_json != null && !records.some(p => p.reference.incidentId === r.incident_id));
 if (unresolved.length === 2 && unresolved[0]!.incident_id && unresolved[1]!.incident_id && unresolved[0]!.incident_id !== unresolved[1]!.incident_id) throw new Error('perp recovery found conflicting incidents');
 let incident = unresolved[0];
 if (unresolved.length === 2 && (!unresolved[0]!.incident_id || !unresolved[1]!.incident_id)) {
  const facts = unresolved.map(r => { const v = JSON.parse(String(r.incident_json)); return JSON.stringify([v.kind, v.at]); });
  if (facts[0] !== facts[1]) throw new Error("perp legacy incident changed during migration");
  incident = unresolved.find(r => r.incident_id) ?? incident;
 }
 return { recoveries_json: encoded, incident_json: incident?.incident_json ?? null, incident_id: incident?.incident_id ?? null, incident_sealed_pubkey: incident?.incident_sealed_pubkey ?? null };
}
/** Exact immutable venue facts, excluding mutable attribution/journal metadata. */
export function recoveryFillFingerprint(row: Row): string {
 const columns = ['agent_id','mode','venue_trade_id','side_role','market_id','side','role','base','price','quote_micro','fee_micro','realized_micro','position_before','entry_quote_before_micro','trade_type','venue_order_index','client_order_index','venue_tx_hash','venue_ts_ms'];
 return hash(columns.map(k => row[k] == null ? null : String(row[k]).toLowerCase()));
}
export function recoveryReplacementKeys(raw: unknown, account: string, sealed: string): string[] {
 return readRecoveries(raw, account).filter(r => r.reference.newPublicKey === sealed).map(r => r.reference.recoveryPublicKey);
}

export function recoveryFillInputFingerprint(fill: import("../store").PerpFillInput): string {
 return recoveryFillFingerprint({agent_id:fill.agentId.toLowerCase(),mode:fill.mode,venue_trade_id:fill.venueTradeId,side_role:fill.sideRole,market_id:fill.marketId,side:fill.side,role:fill.role,base:fill.base,price:fill.price,quote_micro:fill.quoteMicro,fee_micro:fill.feeMicro,realized_micro:fill.realizedMicro,position_before:fill.positionBefore,entry_quote_before_micro:fill.entryQuoteBeforeMicro,trade_type:fill.tradeType,venue_order_index:fill.venueOrderIndex,client_order_index:fill.clientOrderIndex,venue_tx_hash:fill.venueTxHash,venue_ts_ms:fill.venueTsMs});
}
