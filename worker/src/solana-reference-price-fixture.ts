/**
 * Pyth SOL/USD accounts for tests: synthetic builders, and two recorded
 * mainnet reads (below, with what they can and cannot prove). Tests never
 * touch the network.
 */
import { createHash } from "node:crypto";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID, SOLANA_PYTH_DEFAULT_GENERATION, SOLANA_PYTH_FEEDS, solanaReferenceBound,
  type SolanaPythGeneration, type SolanaReferenceBound, type SolanaReferencePrice } from "./solana-reference-price";

export interface PythFixture {
  price?: bigint; conf?: bigint; exponent?: number; publishTimeMs: number; postedSlot?: bigint;
  feedId?: string; level?: number; owner?: string; length?: number;
  /** The Anchor account name whose discriminator leads the data. Default: PriceUpdateV2. */
  accountType?: string;
  /** What getAccountInfo reports for `executable`. Default: false. */
  executable?: unknown;
}
/** A PriceUpdateV2 account as getAccountInfo returns it (base64). Default: $500.00000000/SOL. */
export function pythAccount(f: PythFixture) {
  const data = Buffer.alloc(f.length ?? 134);
  createHash("sha256").update(`account:${f.accountType ?? "PriceUpdateV2"}`).digest().subarray(0, 8).copy(data);
  data[40] = f.level ?? 1;
  Buffer.from(f.feedId ?? PYTH_SOL_USD_FEED_ID, "hex").copy(data, 41);
  data.writeBigInt64LE(f.price ?? 50_000_000_000n, 73);
  data.writeBigUInt64LE(f.conf ?? 10_000_000n, 81);
  data.writeInt32LE(f.exponent ?? -8, 89);
  data.writeBigInt64LE(BigInt(Math.floor(f.publishTimeMs / 1000)), 93);
  data.writeBigUInt64LE(f.postedSlot ?? 999n, 125);
  return { owner: f.owner ?? PYTH_RECEIVER_PROGRAM, executable: Object.hasOwn(f, "executable") ? f.executable : false, lamports: 1_000_000,
    data: [data.toString("base64"), "base64"], space: data.length };
}
/** A reference read at `slot` from `generation`'s account, published at `nowMs`, at `usdPerSol` (8 decimals). */
export function pythReference(nowMs: number, usdPerSol = 50_000_000_000n, slot = 1000,
  generation: SolanaPythGeneration = SOLANA_PYTH_DEFAULT_GENERATION): SolanaReferencePrice {
  return { source: "pyth", account: SOLANA_PYTH_FEEDS[generation].account, feedId: PYTH_SOL_USD_FEED_ID,
    price: usdPerSol.toString(), conf: "10000000", exponent: -8, publishTimeMs: Math.floor(nowMs / 1000) * 1000, postedSlot: slot - 1, slot };
}
export function pythBound(intent: Parameters<typeof solanaReferenceBound>[0], nowMs: number, usdPerSol?: bigint, slot?: number, toleranceBps = 300): SolanaReferenceBound {
  return solanaReferenceBound(intent, pythReference(nowMs, usdPerSol, slot), toleranceBps);
}

/**
 * Solana mainnet reads, recorded read-only on 2026-10-19 at about 03:21 UTC from
 * the public endpoint https://api.mainnet-beta.solana.com (no API key, no
 * transaction) by an earlier pass on this code, as it reported them.
 * `minContextSlot` came from getSlot (commitment confirmed) sent at
 * `requestedAtMs`; `request` is the getAccountInfo call that followed, the
 * call `readSolanaReferencePrice` made then; `response` is the RPC's JSON answer as
 * recorded; `fetchedAtMs` is the local clock when it arrived. The module now
 * asks the same call at commitment finalized (pythSnapshotCall); the recording
 * is kept as it was made, before Alpenglow made the two one state.
 *
 * These two answers are the only raw evidence kept from that check; its other
 * captures were not preserved. Their bytes are internally consistent (layout,
 * discriminator, feed id, write authority, PDA), which tests prove, but nothing
 * offline can prove they came from mainnet rather than being typed in: a fresh
 * read-only read of the same accounts is the way to confirm them.
 */
export interface PythMainnetSnapshot {
  rpc: string; account: string; requestedAtMs: number; fetchedAtMs: number; minContextSlot: number;
  request: { method: "getAccountInfo"; params: [string, { encoding: "base64"; commitment: "confirmed"; minContextSlot: number }] };
  response: string;
}

/** The pinned, current-generation SOL/USD feed account (shard 0, owned by rec5EK…). */
export const PYTH_SOL_USD_MAINNET_SNAPSHOT: PythMainnetSnapshot = {
  rpc: "https://api.mainnet-beta.solana.com",
  account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  requestedAtMs: 1_792_380_064_144,
  fetchedAtMs: 1_792_380_065_220,
  minContextSlot: 458_681_623,
  request: { method: "getAccountInfo", params: ["7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
    { encoding: "base64", commitment: "confirmed", minContextSlot: 458_681_623 }] },
  response: '{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.0","slot":458681624},"value":{"data":["IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bTec0nICAAAA8DEyAAAAAAD4////oIzVagAAAACfjNVqAAAAAHwyyXECAAAAEistAAAAAAAY7VYbAAAAAAA=","base64"],"executable":false,"lamports":1825031,"owner":"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ","rentEpoch":18446744073709551615,"space":134}},"id":2}',
};

/**
 * The same feed's shard-0 account under Pyth's upgraded (2026-08-26) programs,
 * read straight after the snapshot above: owned by rec2HH…, at the PDA of
 * pyt2F4…. Accepted only when the "upgraded" generation is selected
 * (MERRYMEN_SOLANA_PYTH_GENERATION=upgraded); refused under "current".
 */
export const PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT: PythMainnetSnapshot = {
  rpc: "https://api.mainnet-beta.solana.com",
  account: "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE",
  requestedAtMs: 1_792_380_064_144,
  fetchedAtMs: 1_792_380_065_477,
  minContextSlot: 458_681_623,
  request: { method: "getAccountInfo", params: ["7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE",
    { encoding: "base64", commitment: "confirmed", minContextSlot: 458_681_623 }] },
  response: '{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.0","slot":458681625},"value":{"data":["IvEjY51+9M1bsRWwDdII6qyfKmvtWLaGyH3c9S5trfFYcCJDMhaezQHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bcHP0nICAAAAIEIxAAAAAAD4////n4zVagAAAACejNVqAAAAAI4gyXECAAAAuyotAAAAAAAZ7VYbAAAAAAA=","base64"],"executable":false,"lamports":1823520,"owner":"rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp","rentEpoch":18446744073709551615,"space":134}},"id":3}',
};

/** The call `readSolanaReferencePrice` makes for a recorded read today: the recorded request at commitment finalized. */
export function pythSnapshotCall(snapshot: PythMainnetSnapshot): [string, [string, { encoding: "base64"; commitment: "finalized"; minContextSlot: number }]] {
  const [account, config] = snapshot.request.params;
  return [snapshot.request.method, [account, { ...config, commitment: "finalized" }]];
}
/** The JSON-RPC `result` of a recorded read: `{ context: { slot }, value }`. */
export function pythSnapshotResult(snapshot: PythMainnetSnapshot): { context: { slot: number }; value: Record<string, unknown> } {
  return (JSON.parse(snapshot.response) as { result: { context: { slot: number }; value: Record<string, unknown> } }).result;
}
