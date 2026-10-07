/**
 * BOOKING WHAT THE CHAIN HAS AND POSTGRES LACKS, against the three shapes the
 * held tenants are in:
 *
 *   Shogun (0x8e93…, account 0x05a198…)  a session-key trade whose row is
 *                                        missing, and its USDG leg with it
 *   0x4b6dcd…                            an operation with no USDG leg
 *   0x0e1ca0…                            a lone USDG transfer
 *
 * The receipts are Shogun's own, read from the public chain (Robinhood Chain
 * 4663): the Trencher sell at 2026-10-04 00:01:25 (tx 0x7a5bc1cc…), the
 * enable-mode buy at 00:00:47 (tx 0x8ca94fe3…) and an owner's root-key
 * operation at 2026-10-03 22:04:17 (tx 0xf7236957…). Which of Shogun's
 * operations Postgres actually lacks is for the preview to say; the shape is
 * what is tested. The deposits are synthetic. The shared database is a real
 * sqlite with the ledger schema; the chain is a fake JSON-RPC answering from
 * those receipts, consistently: getLogs, receipts and blocks are one model.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { ensureLedgerResumeSchema, LEDGER_IMPORT_SCHEMA } from "./ledger-import";
import { gasFields } from "./key-install-accounting";
import { CHAIN_REFUSAL, chainGapCheck, knownChainFacts, resumePreconditions } from "./ledger-resume";
import { CASH, GRANT_PONS_CLASS, GRANT_TRENCHER, MERRYMEN_TOKEN } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import {
  APPLY_FORMAT, applyBooking, BOOKINGS_TABLE, BookingRefused, canonical, digestOf, factsStillMissing, gapChainOf, holdingVerdict, microUsdg, parseApplyReport, planBooking, planLines,
  readBookingSnapshot, readChainEvidence, replayBasis, revertBooking, staleBasisVerdict, TRADE_COLUMNS, walkFills, type ApplyReport, type BookingPlan, type Holdings,
  type RecordedFill, type StaleBasis,
} from "./chain-gap-booking";

// ── the public chain, as read ────────────────────────────────────────────────

type FixtureLog = [address: string, topics: string[], data: string, logIndex: string];
interface FixtureTx { tx: string; block: string; blockHash: string; timestamp: number; from: string; to: string; logs: FixtureLog[]; status?: string }
const CHAIN: Record<"sell" | "buy" | "root", FixtureTx> = {
  sell: {
    tx: "0x7a5bc1cc670ac1b3a5d8125b4b01a679ebd0a4a79b76ba6e0bb99fca64cd4184", block: "0x4bcfebe", blockHash: "0x4106fa479b61893f93577c99e228d514544b1584610015639f0eaa4037804c3d", timestamp: 1791072085, from: "0x43375ce21e2c538a13bd3b46dd5c6001ca7c9b7c", to: "0x0000000071727de22e5e9d8baf0edac6f37da032",
    logs: [
      ["0x777777777777aec03fd955926dbf81597e66834c", ["0x7a270f29ae17e8e2304ff1245deb50c3b6206bca82928d904f3e284d35c5ffd2","0xb9a28c81083f8cd3b1404f917dcf5545735ed25074aa4d7a5d54ca1aa023d202","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487"], "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", "0x0"],
      ["0x0000000071727de22e5e9d8baf0edac6f37da032", ["0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972"], "0x", "0x1"],
      ["0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x0000000000000000000000000000000000000000000000000000000000000000", "0x2"],
      ["0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x0000000000000000000000000000000000000000000000029343d8834fb02ccd", "0x3"],
      ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000034f73f488309208b8cb6012eb47ffeb086ca1c2d","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x000000000000000000000000000000000000000000000000000690f991fa41b2", "0x4"],
      ["0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x00000000000000000000000034f73f488309208b8cb6012eb47ffeb086ca1c2d"], "0x0000000000000000000000000000000000000000000000029343d8834fb02ccd", "0x5"],
      ["0x34f73f488309208b8cb6012eb47ffeb086ca1c2d", ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffff96f066e05be4e0000000000000000000000000000000000000000000000029343d8834fb02ccd00000000000000000000000000000000000000a014a890ef3aac8bb9f03ea56e0000000000000000000000000000000000000000000006be7c47b953a090fa270000000000000000000000000000000000000000000000000000000000018c8e", "0x6"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000052e65b17fb6e5ba00ed806f37afcd2daa50271ca","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d"], "0x00000000000000000000000000000000000000000000000000000000004bc29d", "0x7"],
      ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2","0x00000000000000000000000052e65b17fb6e5ba00ed806f37afcd2daa50271ca"], "0x000000000000000000000000000000000000000000000000000690f991fa41b2", "0x8"],
      ["0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca", ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d"], "0x000000000000000000000000000000000000000000000000000690f991fa41b2ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb43d6300000000000000000000000000000000000000000003659aad13c96ff59dcb800000000000000000000000000000000000000000000000004f8a5433b623ccb2fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcfd10", "0x9"],
      ["0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x0000000000000000000000000000000000000000000000000000000000000000", "0xa"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487"], "0x00000000000000000000000000000000000000000000000000000000004bc29d", "0xb"],
      ["0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d", ["0xbac9694ac0daa55169abd117086fe32c89401d9a3b15dd1d34e55e0aa4e47a9d","0x000000000000000000000000aa07a0e9209e16ac99708c3ec70159c6ef3128a3"], "0x0000000000000000000000000000000000000000000000029343d8834fb02ccd00000000000000000000000000000000000000000000000000000000004bc29d", "0xc"],
      ["0x0000000071727de22e5e9d8baf0edac6f37da032", ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f","0xb9a28c81083f8cd3b1404f917dcf5545735ed25074aa4d7a5d54ca1aa023d202","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487","0x000000000000000000000000777777777777aec03fd955926dbf81597e66834c"], "0x0002d5cb71d80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000c20b9676e200000000000000000000000000000000000000000000000000000000000090b6a", "0xd"],
    ],
  },
  buy: {
    tx: "0x8ca94fe3afa278a3ca230aca8d4b84c6fd10716b0c341270a28d6ab5ba7038fb", block: "0x4bcfd46", blockHash: "0x61b97b5074a546921187a931ad52b7e0dc3529ccf261e1223dee0b229ee28e8b", timestamp: 1791072047, from: "0x4337045b9bc98b68963633ae96b34446a0c8f965", to: "0x0000000071727de22e5e9d8baf0edac6f37da032",
    logs: [
      ["0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487", ["0xd21d0b289f126c4b473ea641963e766833c2f13866e4ff480abd787c100ef123"], "0x0000000000000000000000000000000000000000000000000000000000000005000000000000000000000000b9f8f524be6ecd8c945b1b87f9ae5c192fdce20f", "0x0"],
      ["0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487", ["0xd21d0b289f126c4b473ea641963e766833c2f13866e4ff480abd787c100ef123"], "0x00000000000000000000000000000000000000000000000000000000000000050000000000000000000000009a52283276a0ec8740df50bf01b28a80d880eaf2", "0x1"],
      ["0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487", ["0xd21d0b289f126c4b473ea641963e766833c2f13866e4ff480abd787c100ef123"], "0x00000000000000000000000000000000000000000000000000000000000000060000000000000000000000006a6f069e2a08c2468e7724ab3250cdbfba14d4ff", "0x2"],
      ["0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487", ["0x9d17cd6d095ac90a655405ab29f30a7ee7e88ef3974c1bf7544bf591043bb71a"], "0xe9ae5c530000000000000000000000000000000000000000000000000000000002d5cb71d80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001", "0x3"],
      ["0x777777777777aec03fd955926dbf81597e66834c", ["0x7a270f29ae17e8e2304ff1245deb50c3b6206bca82928d904f3e284d35c5ffd2","0x0e04b717af22ed4680ec2717e2ca2b9ed14a42b71bd6fa840a0c36c60dbf7051","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487"], "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", "0x4"],
      ["0x0000000071727de22e5e9d8baf0edac6f37da032", ["0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972"], "0x", "0x5"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d"], "0x00000000000000000000000000000000000000000000000000000000004c4b40", "0x6"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d"], "0x00000000000000000000000000000000000000000000000000000000004c4b40", "0x7"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x0000000000000000000000000000000000000000000000000000000000000000", "0x8"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x00000000000000000000000000000000000000000000000000000000004c4b40", "0x9"],
      ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000052e65b17fb6e5ba00ed806f37afcd2daa50271ca","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x00000000000000000000000000000000000000000000000000069c7cd3bf148c", "0xa"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x00000000000000000000000052e65b17fb6e5ba00ed806f37afcd2daa50271ca"], "0x00000000000000000000000000000000000000000000000000000000004c4b40", "0xb"],
      ["0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca", ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffff963832c40eb7400000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000003659a1bea2540e04d72fd0000000000000000000000000000000000000000000000004f8a5433b623ccb2fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcfd10", "0xc"],
      ["0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000034f73f488309208b8cb6012eb47ffeb086ca1c2d","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d"], "0x0000000000000000000000000000000000000000000000029343d8834fb02ccd", "0xd"],
      ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2","0x00000000000000000000000034f73f488309208b8cb6012eb47ffeb086ca1c2d"], "0x00000000000000000000000000000000000000000000000000069c7cd3bf148c", "0xe"],
      ["0x34f73f488309208b8cb6012eb47ffeb086ca1c2d", ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d"], "0x00000000000000000000000000000000000000000000000000069c7cd3bf148cfffffffffffffffffffffffffffffffffffffffffffffffd6cbc277cb04fd33300000000000000000000000000000000000000a0035f10eb483b777d667fa1b7000000000000000000000000000000000000000000000379c328b1fbca3260910000000000000000000000000000000000000000000000000000000000018c86", "0xf"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x0000000000000000000000002ca2b5bd3b6635d630419c57a13c6b6a856ec96d","0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2"], "0x0000000000000000000000000000000000000000000000000000000000000000", "0x10"],
      ["0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d", ["0xa9a40dec7a304e5915d11358b968c1e8d365992abf20f82285d1df1b30c8e24c","0x000000000000000000000000aa07a0e9209e16ac99708c3ec70159c6ef3128a3"], "0x00000000000000000000000000000000000000000000000000000000004c4b400000000000000000000000000000000000000000000000029343d8834fb02ccd", "0x11"],
      ["0x0000000071727de22e5e9d8baf0edac6f37da032", ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f","0x0e04b717af22ed4680ec2717e2ca2b9ed14a42b71bd6fa840a0c36c60dbf7051","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487","0x000000000000000000000000777777777777aec03fd955926dbf81597e66834c"], "0x0102d5cb71d80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000009b082e1ff36a0000000000000000000000000000000000000000000000000000000000734c42", "0x12"],
    ],
  },
  root: {
    tx: "0xf72369574846234991150f01ee6b03ced222860c9efb2e5ab12139a11cc00117", block: "0x4bbee9c", blockHash: "0x3308dc83aa639d5b332ef2531100786c217db69e0c4546ad3cad899c55879910", timestamp: 1791065057, from: "0x433711cda558c0fa32a4b8554939ab8740b9f5ac", to: "0x0000000071727de22e5e9d8baf0edac6f37da032",
    logs: [
      ["0x0000000071727de22e5e9d8baf0edac6f37da032", ["0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972"], "0x", "0x44"],
      ["0x0000000071727de22e5e9d8baf0edac6f37da032", ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f","0xcf29d6d916f4860e8f4dd3b380b9c3364532a1cff3cd1112e9215db830f8df3e","0x00000000000000000000000005a198a677fbcd8f5c168d397fa7ef5eb6d65487","0x0000000000000000000000000000000000000000000000000000000000000000"], "0x0000845adb2c711129d4f3966735ed98a9f09fc4ce57000000000000000000030000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000002796dc97c1c000000000000000000000000000000000000000000000000000000000001d733", "0x45"],
    ],
  },
};

const SHOGUN_TENANT = "0x8e93bad5a60a266b4283855ceffa0979720aed72";
const ACCOUNT = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const VAULT = "0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d";
const COIN = "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3";
const USDG = String(CASH.USDG).toLowerCase();
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const BEFORE = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SELL_OP = "0xb9a28c81083f8cd3b1404f917dcf5545735ed25074aa4d7a5d54ca1aa023d202";
const BUY_OP = "0x0e04b717af22ed4680ec2717e2ca2b9ed14a42b71bd6fa840a0c36c60dbf7051";
const ROOT_OP = "0xcf29d6d916f4860e8f4dd3b380b9c3364532a1cff3cd1112e9215db830f8df3e";
const SELL_BLOCK = BigInt(CHAIN.sell.block);
/** Two and a half days after the sell: the morning the tenants were held. */
const NOW = CHAIN.sell.timestamp + 60 * 3600;
const HEAD = SELL_BLOCK + 2_160_000n;
const topic = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h32 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
const SOURCE = { files: { "chain-gap-booking.ts": "test" } }, TARGET = "test-database";

/** A transaction in the fake chain's model: its block, its receipt's logs. */
interface ModelTx { tx: string; block: bigint; blockHash?: string; timestamp?: number; from: string; to: string | null; status?: string; logs: FixtureLog[] }
const fromFixture = (f: FixtureTx): ModelTx => ({ tx: f.tx, block: BigInt(f.block), blockHash: f.blockHash, timestamp: f.timestamp, from: f.from, to: f.to, logs: f.logs });

/**
 * A JSON-RPC answering from one model: blocks dated at ten a second around the
 * sell's own block (its real time), each receipt's logs the only logs there
 * are. Every method the tool's transport admits, and nothing else.
 */
function fakeRpc(o: {
  txs: ModelTx[]; head?: bigint; chainId?: number; decimals?: Record<string, bigint>; failReceipts?: boolean;
  /** balanceOf answers by token, then holder; any other holder of a token holds none. A token named in `failBalances` cannot be read. */
  balances?: Record<string, Record<string, bigint>>; failBalances?: string[];
  /** Transactions whose receipt names a block hash that is not the canonical block's at that height. */
  orphaned?: string[];
}) {
  const head = o.head ?? HEAD;
  const calls: string[] = [];
  const balanceTags: string[] = [];
  const blockOf = (b: bigint) => {
    const real = o.txs.find((t) => t.block === b && t.blockHash);
    return { number: `0x${b.toString(16)}`, hash: real?.blockHash ?? h32(`block ${b}`),
      timestamp: `0x${(real?.timestamp ?? CHAIN.sell.timestamp + Math.floor(Number(b - SELL_BLOCK) / 10)).toString(16)}` };
  };
  const logsOf = (t: ModelTx) => t.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex, blockNumber: `0x${t.block.toString(16)}`, transactionHash: t.tx }));
  const rpc: RpcCall = async (method, params) => {
    calls.push(method);
    if (method === "eth_chainId") return `0x${(o.chainId ?? 4663).toString(16)}`;
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    if (method === "eth_getBlockByNumber") return blockOf(BigInt(params[0] as string));
    if (method === "eth_getLogs") {
      const f = params[0] as { address: string; fromBlock: string; toBlock: string; topics: Array<string | string[] | null> };
      return o.txs.filter((t) => t.block >= BigInt(f.fromBlock) && t.block <= BigInt(f.toBlock)).flatMap(logsOf)
        .filter((l) => l.address.toLowerCase() === f.address.toLowerCase()
          && f.topics.every((want, i) => want === null || (Array.isArray(want) ? want.map((x) => x.toLowerCase()) : [want.toLowerCase()]).includes(String(l.topics[i] ?? "").toLowerCase())));
    }
    if (method === "eth_getTransactionReceipt") {
      if (o.failReceipts) throw new Error("rpc-read-failed");
      const t = o.txs.find((x) => x.tx === params[0]);
      return t ? { status: t.status ?? "0x1", blockNumber: `0x${t.block.toString(16)}`, blockHash: o.orphaned?.includes(t.tx) ? h32(`orphan of ${t.block}`) : blockOf(t.block).hash,
        from: t.from, to: t.to, transactionHash: t.tx, logs: logsOf(t) } : null;
    }
    if (method === "eth_call") {
      const [call, tag] = params as [{ to: string; data: string }, string];
      if (call.data.startsWith("0x70a08231")) {
        // PINNED: a balance is read at admission's head less the 64 confirmations every booked fact has, never at "latest".
        balanceTags.push(tag);
        assert.equal(tag, `0x${(head - 64n).toString(16)}`);
        assert.match(call.data, /^0x70a08231[0]{24}[0-9a-f]{40}$/);
        if (o.failBalances?.includes(call.to.toLowerCase())) throw new Error("rpc-read-failed");
        return `0x${word(o.balances?.[call.to.toLowerCase()]?.[`0x${call.data.slice(-40)}`] ?? 0n)}`;
      }
      assert.equal(tag, "latest");
      assert.equal(call.data, "0x313ce567");
      const d = o.decimals?.[call.to.toLowerCase()];
      if (d === undefined) throw new Error("execution reverted");
      return `0x${word(d)}`;
    }
    throw new Error(`method ${method} is outside the fake`);
  };
  return { rpc, calls, balanceTags };
}

// ── the shared database ──────────────────────────────────────────────────────

const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); });

/** When admission last refused the held tenants here: half an hour before the preview, long after everything on the fixture chain landed. */
const REFUSED_AT = NOW - 1800;
/**
 * Admission's refusal of the tenant, as moveApproval records one: a chain
 * refusal says where its read began (`readFromSec`, the cursors' start less
 * 600s unless given; null as a row from before the column has it).
 */
function refuse(raw: DatabaseSync, o: { tenant: string; account: string; id?: string; atSec?: number; reason?: string; state?: string; generation?: string | null;
  readFromSec?: number | null }) {
  const at = (o.atSec ?? REFUSED_AT) * 1000;
  const reason = o.reason ?? `${CHAIN_REFUSAL}: operation ${SELL_OP} in tx ${CHAIN.sell.tx} at block ${SELL_BLOCK}`;
  const chain = (o.state ?? "refused") === "refused" && reason.startsWith(CHAIN_REFUSAL);
  raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, generation,
      reason, created_at_ms, updated_at_ms, chain_read_from_sec) VALUES (?, ?, ?, 4663, ?, ?, '{}', 'r', ?, ?, ?, ?, ?, ?)`)
    .run(o.id ?? "refusal", o.tenant, o.account, o.tenant, h32(`evidence ${o.id ?? "refusal"}`).slice(2), o.state ?? "refused", o.generation ?? null,
      reason, at - 60_000, at, chain ? (o.readFromSec === undefined ? CHAIN.root.timestamp - 3600 - 600 : o.readFromSec) : null);
}

/**
 * One tenant's Postgres as the incident left it: its registration, its
 * history in epoch 2, its stalled cursors and its grant — and admission's
 * chain refusal of it, which is what holds it (unless `refused: false`).
 */
async function books(o: { tenant?: string; account?: string; trencher?: boolean; classVault?: string; knownBuy?: boolean; mode?: string; refused?: boolean } = {}) {
  const tenant = o.tenant ?? SHOGUN_TENANT, account = o.account ?? ACCOUNT;
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL); await db.exec(PAPER_CHECKPOINT_SCHEMA);
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL, row_version INTEGER NOT NULL)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, 1000, 1)").run(tenant, JSON.stringify({
    smartAccount: account, owner: tenant, chainId: 4663, serialized: "never-read",
    grantFeatures: [...(o.trencher === false ? ["tradeable-v2"] : ["tradeable-v2", GRANT_TRENCHER]), ...(o.classVault ? [GRANT_PONS_CLASS] : [])],
    trencherVaultAddress: VAULT, trencherFactoryAddress: addr(0xfac7), ...(o.classVault ? { ponsClassVaultAddress: o.classVault } : {}),
  }));
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 25, ?)`).run(account, tenant, addr(1), o.mode ?? "live");
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 1, 0, 'live')`).run(addr(0x0ca1), addr(0x0ca2), addr(1));
  const opened = CHAIN.sell.timestamp - 3 * 86_400;
  raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
    VALUES (?, 'in', 25, ?, 70000000, 3, 'chain-log', ?, 2, 4663)`).run(account, h32("first deposit"), opened);
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 20, 0, 5, 25, ?, 2, 'live')")
    .run(account, CHAIN.sell.timestamp - 7200);
  if (o.knownBuy !== false) {
    raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch)
      VALUES (?, 'swap', ?, ?, ?, 5, ?, ?, 'landed', ?, 2)`).run(account, VAULT, USDG, COIN, BUY_OP, CHAIN.buy.tx, CHAIN.buy.timestamp);
  }
  for (const table of ["trades", "flows", "equity", "events"]) {
    raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, 9, ?, ?)").run(tenant, table, opened, CHAIN.root.timestamp - 3600);
  }
  await ensureLedgerResumeSchema(db);
  if (o.refused !== false) refuse(raw, { tenant, account });
  return { raw, db, tenant, account };
}

async function preview(b: { db: Db; tenant: string }, rpc: RpcCall, nowSec = NOW): Promise<BookingPlan> {
  const snap = await readBookingSnapshot(b.db, { tenant: b.tenant, dialect: "sqlite", nowSec });
  const ev = await readChainEvidence(rpc, snap, { sleep: async () => {}, maxSpan: 5_000_000n });
  return planBooking(snap, ev, { nowSec, source: SOURCE, target: TARGET });
}
const rows = (raw: DatabaseSync, sql: string, ...args: unknown[]) => (raw.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
/** What admission's chain check says about the account now, from the same model. */
async function admissionSays(b: { db: Db; account: string; tenant: string }, rpc: RpcCall) {
  const k = await knownChainFacts(b.db, b.account);
  const snap = await readBookingSnapshot(b.db, { tenant: b.tenant, dialect: "sqlite", nowSec: NOW });
  return chainGapCheck({ chain: gapChainOf(rpc, async () => {}), account: b.account, usdg: USDG, sinceSec: snap.gapFromSec, known: k, maxSpan: 5_000_000n });
}
const CONTROLS = { readable: true, why: null, digest: "c".repeat(64) };
const preconditions = (b: { db: Db; tenant: string; account: string }) =>
  resumePreconditions(b.db, { tenant: b.tenant, account: b.account, grantAccount: b.account, nowSec: NOW, controls: CONTROLS, homePendingImport: false });

/** A synthetic plain USDG transfer: no EntryPoint, one Transfer log. */
function lone(o: { from: string; to: string; amount: bigint; block: bigint; tag: string; sender?: string }): ModelTx {
  return { tx: h32(o.tag), block: o.block, from: o.sender ?? o.from, to: USDG, logs: [[USDG, [TR, topic(o.from), topic(o.to)], `0x${word(o.amount)}`, "0x4"]] };
}
/** A synthetic operation of the account: BeforeExecution, its execution's logs, its event. */
function operation(o: { opHash: string; nonce: bigint; success?: boolean; paymaster?: string; gasWei?: bigint; gasUnits?: bigint; block: bigint; tag: string; logs?: FixtureLog[] }): ModelTx {
  const event = `0x${word(o.nonce)}${word(o.success === false ? 0n : 1n)}${word(o.gasWei ?? 4_000_000_000_000n)}${word(o.gasUnits ?? 90_000n)}`;
  return { tx: h32(o.tag), block: o.block, from: addr(0x4337), to: EP, logs: [
    [EP, [BEFORE], "0x", "0x1"], ...(o.logs ?? []),
    [EP, [UOE, o.opHash, topic(ACCOUNT), topic(o.paymaster ?? addr(0))], event, `0x${(2 + (o.logs?.length ?? 0)).toString(16)}`],
  ] };
}
/** Kernel v3 nonce: mode ‖ validator type ‖ identifier ‖ key ‖ sequence. 0x02 is a permission (the session key). */
const SESSION_NONCE = (0x0002d5cb71d8n << 208n) | 7n;

describe("Shogun's shape: a session-key trade whose row is missing", () => {
  it("proposes the reconciler's landed row with the receipt's fill, and the USDG leg rides on its transaction", async () => {
    const b = await books();
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell), fromFixture(CHAIN.root)], decimals: { [COIN]: 18n } });
    // Postgres holds the buy; the root operation is the owner's and is given a row here so only the sell is missing.
    b.raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch) VALUES (?, 'swap', ?, 0, ?, ?, 'landed', ?, 2)`)
      .run(ACCOUNT, ACCOUNT, ROOT_OP, CHAIN.root.tx, CHAIN.root.timestamp);
    const before = await admissionSays(b, rpc);
    assert.equal(before.status, "missing");
    assert.deepEqual({ ops: (before as { ops: number }).ops, transfers: (before as { transfers: number }).transfers }, { ops: 1, transfers: 1 }, "Shogun's line: 1 op + 1 transfer");

    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready", planLines(p).join("\n"));
    assert.deepEqual(p.items.map((i) => [i.key, i.class]), [[`log:${CHAIN.sell.tx}#11`, "operation-leg"], [`op:${SELL_OP}`, "session-trade"]]);
    assert.equal(p.items[0]!.coveredBy, `op:${SELL_OP}`);
    const qty = BigInt("0x29343d8834fb02ccd");
    assert.deepEqual(p.items[1]!.proposal, { table: "trades", row: {
      agent_id: ACCOUNT, kind: "swap", target: ACCOUNT, sell_token: COIN, buy_token: USDG, amount_usdg: 4.965021,
      user_op_hash: SELL_OP, tx_hash: CHAIN.sell.tx, status: "landed", reject_rule: null, decision_id: null,
      fill_side: "sell", fill_symbol: null, fill_qty_raw: qty.toString(), fill_price_usd: 4.965021 / (Number(qty) / 1e18), realized_pnl_usdg: null,
      basis_source: "receipt",
      // Sponsored: the paymaster paid, and the EntryPoint's own event says how much and how many units.
      gas_wei: null, sponsored_gas_wei: BigInt("0x0c20b9676e20").toString(), gas_usdg: null, gas_units: BigInt("0x090b6a").toString(),
      fill_cash_usdg: 4.965021, epoch: 2, created_at: CHAIN.sell.timestamp, budget_settled_at: null,
    } });
    assert.deepEqual(p.remaining, [], "admission would find nothing left");
    assert.equal(p.items[1]!.evidence.validator, "permission");
    assert.deepEqual(p.cas.ledger.trades, { n: 2, maxId: 2 });
    // The same books and chain preview to the same digest; the time of the preview is not in it.
    assert.equal((await preview(b, rpc, NOW + 600)).previewDigest, p.previewDigest);
    assert.ok(planLines(p).some((l) => l.includes(`session-trade: operation ${SELL_OP} in tx ${CHAIN.sell.tx} at block ${SELL_BLOCK} → trades row`)));
    assert.ok(p.warnings.some((w) => /without touching cost_basis/.test(w)));
  });

  it("the enable-mode buy reads as the session key's own buy, never the owner's", async () => {
    const b = await books({ knownBuy: false });
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)], decimals: { [COIN]: 18n } });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready", planLines(p).join("\n"));
    const buy = p.items.find((i) => i.key === `op:${BUY_OP}`)!;
    assert.equal(buy.class, "session-trade");
    const row = buy.proposal!.row as unknown as Record<string, unknown>;
    assert.deepEqual([row.fill_side, row.sell_token, row.buy_token, row.amount_usdg, row.fill_qty_raw, row.sponsored_gas_wei],
      ["buy", USDG, COIN, 5, BigInt("0x29343d8834fb02ccd").toString(), BigInt("0x9b082e1ff36a").toString()]);
    assert.equal(p.items.find((i) => i.key === `log:${CHAIN.buy.tx}#7`)?.class, "operation-leg", "account → vault inside the buy's own execution");
  });

  it("without the vault in the grant the same sell is unresolved — the leg from the vault is never read as a deposit", async () => {
    const b = await books({ trencher: false });
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)], decimals: { [COIN]: 18n } });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "blocked");
    assert.equal(p.items.find((i) => i.key === `op:${SELL_OP}`)?.class, "unresolved");
    assert.match(p.items.find((i) => i.key === `op:${SELL_OP}`)!.why, /a session key moved USDG \(USDG \+4\.965021\) with nothing visible the other way/);
    assert.equal(p.items.find((i) => i.key === `log:${CHAIN.sell.tx}#11`)?.class, "unresolved", "its leg waits on it");
    assert.equal(p.items.filter((i) => i.proposal).length, 0);
    assert.equal(p.remaining.length, 2);
  });

  it("an unreadable decimals() leaves the price NULL and books the rest; the fill is the logs' own amounts", async () => {
    const b = await books();
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)] });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready");
    const row = p.items.find((i) => i.key === `op:${SELL_OP}`)!.proposal!.row as unknown as Record<string, unknown>;
    assert.equal(row.fill_price_usd, null);
    assert.equal(row.fill_cash_usdg, 4.965021);
    assert.ok(p.warnings.some((w) => w.includes("fill_price_usd stays NULL")));
  });
});

describe("0x4b6dcd's shape: an operation with no USDG leg", () => {
  it("an owner's root-key operation is classified as the owner's, and blocks: the agent's book has no writer for it", async () => {
    const b = await books();
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.root)] });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "blocked");
    assert.deepEqual(p.items.map((i) => [i.key, i.class]), [[`op:${ROOT_OP}`, "owner-operation"]]);
    assert.equal(p.items[0]!.evidence.validator, "root");
    assert.match(p.items[0]!.why, /the owner's own key \(the root validator\) signed this operation \(it moved nothing\)/);
    assert.deepEqual(p.remaining.map((f) => f.kind), ["operation"]);
    assert.ok(planLines(p).some((l) => l.includes("owner-operation") && l.includes("NOT BOOKED")));
  });

  it("a session key's operation that moved nothing gets the reconciler's notional-0 row, with the gas its event recorded split as gasFields splits it", async () => {
    const b = await books();
    const op = h32("a quiet op"), block = SELL_BLOCK + 10n;
    const approve: FixtureLog = [USDG, ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", topic(ACCOUNT), topic(VAULT)], `0x${word(0n)}`, "0x2"];
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), operation({ opHash: op, nonce: SESSION_NONCE, block, tag: "quiet", logs: [approve], gasWei: 777n, gasUnits: 55n })] });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready", planLines(p).join("\n"));
    const it0 = p.items[0]!;
    assert.equal(it0.class, "session-no-movement");
    const row = it0.proposal!.row as unknown as Record<string, unknown>;
    assert.deepEqual([row.kind, row.amount_usdg, row.sell_token, row.buy_token, row.status, row.basis_source, row.fill_side], ["swap", 0, null, null, "landed", "receipt", null]);
    // Owner-paid (no paymaster): the same split key-install-accounting.ts gasFields makes.
    const expected = gasFields({ gasWei: 777n, gasUnits: 55n, gasPayer: "owner" })!;
    assert.deepEqual({ gas_wei: row.gas_wei, gas_units: row.gas_units, sponsored_gas_wei: row.sponsored_gas_wei, gas_usdg: row.gas_usdg },
      { gas_wei: expected.gas_wei, gas_units: expected.gas_units, sponsored_gas_wei: null, gas_usdg: null });
  });

  it("a session key's reverted operation gets a resolved revert's row, counted toward no cap", async () => {
    const b = await books();
    const op = h32("a reverted op");
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), operation({ opHash: op, nonce: SESSION_NONCE, success: false, paymaster: addr(0x7777), block: SELL_BLOCK + 20n, tag: "rev" })] });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready");
    const row = p.items[0]!.proposal!.row as unknown as Record<string, unknown>;
    assert.equal(p.items[0]!.class, "session-reverted");
    assert.deepEqual([row.status, row.reject_rule, row.amount_usdg, row.basis_source, row.gas_wei, row.sponsored_gas_wei], ["reverted", "reverted on-chain (resolved)", 0, null, null, "4000000000000"]);
  });

  it("a session key moving USDG with nothing back, and an unmeasured validator, are unresolved", async () => {
    const b = await books();
    const out: FixtureLog = [USDG, [TR, topic(ACCOUNT), topic(addr(0xbeef))], `0x${word(1_000_000n)}`, "0x2"];
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy),
      operation({ opHash: h32("home"), nonce: SESSION_NONCE, block: SELL_BLOCK + 30n, tag: "home", logs: [out] }),
      operation({ opHash: h32("odd"), nonce: (0x0003n << 240n) | 1n, block: SELL_BLOCK + 40n, tag: "odd" })] });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "blocked");
    const home = p.items.find((i) => i.key === `op:${h32("home")}`)!;
    assert.match(home.why, /a transfer home or an energy purchase books a flow beside its row/);
    assert.equal(p.items.find((i) => i.key === `log:${h32("home")}#2`)?.class, "unresolved");
    assert.match(p.items.find((i) => i.key === `op:${h32("odd")}`)!.why, /names no validator this tool reads/);
    // An energy purchase is a clean USDG-for-one-token receipt and still not a trade: its flow moves both peaks.
    const reserve = MERRYMEN_TOKEN.address.toLowerCase();
    const energy = await preview(await books(), fakeRpc({ txs: [fromFixture(CHAIN.buy), operation({ opHash: h32("energy"), nonce: SESSION_NONCE, block: SELL_BLOCK + 50n, tag: "energy",
      logs: [[USDG, [TR, topic(ACCOUNT), topic(addr(0x9001))], `0x${word(2_000_000n)}`, "0x2"], [reserve, [TR, topic(addr(0x9001)), topic(ACCOUNT)], `0x${word(77n)}`, "0x3"]] })] }).rpc);
    assert.equal(energy.verdict, "blocked");
    assert.match(energy.items.find((i) => i.key === `op:${h32("energy")}`)!.why, /energy purchase .* 'energy-buy' flow that moves both peaks/);
  });
});

describe("0x0e1ca0's shape: a lone USDG transfer", () => {
  it("USDG in from outside the system, with no operation of the account, is a chain-log flow as the reconstruction books it", async () => {
    const b = await books();
    const dep = lone({ from: addr(0xd0d0), to: ACCOUNT, amount: 12_500_000n, block: SELL_BLOCK + 1_000n, tag: "deposit" });
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), dep] });
    const before = await admissionSays(b, rpc);
    assert.deepEqual({ ops: (before as { ops: number }).ops, transfers: (before as { transfers: number }).transfers }, { ops: 0, transfers: 1 }, "0x0e1ca0's line: 0 ops + 1 transfer");
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready", planLines(p).join("\n"));
    assert.equal(p.items[0]!.class, "deposit");
    assert.deepEqual(p.items[0]!.proposal, { table: "flows", row: { agent_id: ACCOUNT, direction: "in", amount_usdg: 12.5, tx_hash: dep.tx,
      block_number: Number(dep.block), log_index: 4, source: "chain-log", epoch: 2, chain_id: 4663, at: CHAIN.sell.timestamp + 100 } });
    assert.ok(p.warnings.some((w) => /without moving agents\.hwm_usdg/.test(w)), "the peaks are said not to move");
  });

  it("USDG leaving with no operation, USDG from another hosted account, and USDG from the account's own vault are unresolved", async () => {
    const b = await books();
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy),
      lone({ from: ACCOUNT, to: addr(0xd0d0), amount: 1n, block: SELL_BLOCK + 2_000n, tag: "pulled", sender: addr(0xbad) }),
      lone({ from: addr(0x0ca1), to: ACCOUNT, amount: 2n, block: SELL_BLOCK + 2_001n, tag: "sibling" }),
      lone({ from: VAULT, to: ACCOUNT, amount: 3n, block: SELL_BLOCK + 2_002n, tag: "vault" })] });
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "blocked");
    assert.deepEqual(p.items.map((i) => i.class), ["unresolved", "unresolved", "unresolved"]);
    assert.match(p.items[0]!.why, /an allowance was spent/);
    assert.match(p.items[1]!.why, /reads it as internal: the counterparty 0x0000000000000000000000000000000000000ca1 is another account this system controls/);
    assert.match(p.items[2]!.why, /reads it as internal: .*holds this account's own assets/);
  });
});

describe("what is never booked, whatever its class", () => {
  it("a fact not 64 blocks deep, one before the epoch opened, a leg outside its operation, and an unread receipt", async () => {
    const b = await books();
    const shallow = lone({ from: addr(0xd0d0), to: ACCOUNT, amount: 5n, block: HEAD - 10n, tag: "shallow" });
    const p = await preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy), shallow] }).rpc);
    assert.match(p.items[0]!.why, /not yet 64 blocks deep/);
    // The current epoch opened after this deposit: which epoch it belongs to is not this tool's to say.
    const b2 = await books();
    b2.raw.prepare("UPDATE flows SET at = ? WHERE agent_id = ?").run(CHAIN.sell.timestamp + 5_000, ACCOUNT);
    b2.raw.prepare("UPDATE equity SET at = ? WHERE agent_id = ?").run(CHAIN.sell.timestamp + 5_000, ACCOUNT);
    b2.raw.prepare("UPDATE trades SET created_at = ? WHERE agent_id = ?").run(CHAIN.sell.timestamp + 5_000, ACCOUNT);
    const early = lone({ from: addr(0xd0d0), to: ACCOUNT, amount: 5n, block: SELL_BLOCK + 100n, tag: "early" });
    const q = await preview(b2, fakeRpc({ txs: [early] }).rpc);
    assert.match(q.items[0]!.why, /before accounting epoch 2 opened/);
    // A USDG transfer of the account outside the sell's own execution: a row for the sell would cover it unbooked.
    const sell = fromFixture(CHAIN.sell);
    sell.logs = [...sell.logs, [USDG, [TR, topic(addr(0xd0d0)), topic(ACCOUNT)], `0x${word(9n)}`, "0x20"]];
    const r = await preview(await books(), fakeRpc({ txs: [fromFixture(CHAIN.buy), sell], decimals: { [COIN]: 18n } }).rpc);
    assert.equal(r.verdict, "blocked");
    assert.match(r.items.find((i) => i.key === `op:${SELL_OP}`)!.why, /1 USDG transfer\(s\) of the account outside this operation's execution/);
    const s = await preview(await books(), fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)], failReceipts: true }).rpc);
    assert.ok(s.items.every((i) => /receipt or block could not be read/.test(i.why)));
    assert.equal(s.verdict, "blocked");
  });

  it("refuses the tenant outright: an open approval, an admitted book, two spellings, another chain's RPC, an unreadable chain", async () => {
    const txs = [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)];
    const b = await books();
    await ensureLedgerResumeSchema(b.db);
    b.raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, created_at_ms, updated_at_ms)
      VALUES ('a', ?, ?, 4663, ?, ?, '{}', 'r', 'approved', 1, 1)`).run(SHOGUN_TENANT, ACCOUNT, SHOGUN_TENANT, "e".repeat(64));
    const p = await preview(b, fakeRpc({ txs, decimals: { [COIN]: 18n } }).rpc);
    assert.equal(p.verdict, "blocked");
    assert.ok(p.refusals.some((r) => r.includes(`MERRYMEN_RESUME_REVOKE=${SHOGUN_TENANT}:${"e".repeat(64)}`)), p.refusals.join("; "));
    const c = await books();
    c.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '1', '1', 1)").run(ACCOUNT.toUpperCase().replace("0X", "0x"));
    assert.ok((await preview(c, fakeRpc({ txs }).rpc)).refusals.some((r) => /spelled 2 ways/.test(r)));
    assert.ok((await preview(await books(), fakeRpc({ txs, chainId: 46630 }).rpc)).refusals.some((r) => /serves chain 46630/.test(r)));
    const down: RpcCall = async (m) => { if (m === "eth_chainId") return "0x1237"; throw new Error("rpc-read-failed"); };
    const d = await preview(await books(), down);
    assert.equal(d.verdict, "blocked");
    assert.ok(d.refusals.some((r) => /the chain could not be read/.test(r)));
  });

  it("nothing missing is said as such, and proposes nothing", async () => {
    const b = await books();
    const p = await preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy)] }).rpc);
    assert.equal(p.verdict, "nothing-missing");
    assert.deepEqual([p.items.length, p.found.length], [0, 0]);
  });

  it("factsStillMissing is admission's rule: an op by its hash, a transfer by its tx, its tx#log, or its operation's transaction", () => {
    const op = { kind: "operation" as const, userOpHash: "0xop", txHash: "0xt1", block: "1", logIndex: 2, success: true };
    const leg = { kind: "transfer" as const, txHash: "0xt1", block: "1", logIndex: 1, direction: "in" as const, amountRaw: "1", counterparty: null };
    const dep = { kind: "transfer" as const, txHash: "0xt2", block: "1", logIndex: 0, direction: "in" as const, amountRaw: "1", counterparty: null };
    const none = { ops: new Set<string>(), txs: new Set<string>(), flows: new Set<string>() };
    assert.equal(factsStillMissing([op, leg, dep], none).length, 3);
    assert.deepEqual(factsStillMissing([op, leg, dep], { ...none, ops: new Set(["0xop"]) }), [dep], "the op's own transaction covers its leg");
    assert.deepEqual(factsStillMissing([op, leg, dep], { ops: new Set(["0xop"]), txs: new Set(), flows: new Set(["0xt2:0"]) }), []);
  });
});

describe("apply and revert", () => {
  async function ready() {
    const b = await books();
    const dep = lone({ from: addr(0xd0d0), to: ACCOUNT, amount: 12_500_000n, block: SELL_BLOCK + 1_000n, tag: "deposit" });
    const model = fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell), dep], decimals: { [COIN]: 18n } });
    const p = await preview(b, model.rpc);
    assert.equal(p.verdict, "ready", planLines(p).join("\n"));
    return { b, p, rpc: model.rpc, dep };
  }
  const apply = (db: Db, p: BookingPlan, extra: Partial<{ confirm: string; backupRef: string; nowMs: number }> = {}) =>
    applyBooking(db, p, { confirm: p.previewDigest, backupRef: "railway-backup-2026-10-06T09:00Z", dialect: "sqlite", nowMs: NOW * 1000, ...extra });

  it("writes exactly the proposed rows once, records a receipt for each, and admission's chain check is then clean — its preconditions unchanged", async () => {
    const { b, p, rpc, dep } = await ready();
    const pre = await preconditions(b);
    const report = await apply(b.db, p);
    assert.equal(report.format, APPLY_FORMAT);
    assert.equal(report.reportDigest, digestOf((({ reportDigest: _d, ...rest }) => rest)(report)));
    assert.deepEqual(report.rows.map((r) => [r.table, r.evidenceKey]), [["trades", `op:${SELL_OP}`], ["flows", `log:${dep.tx}#4`]]);
    const trade = rows(b.raw, `SELECT ${TRADE_COLUMNS.join(", ")} FROM trades WHERE user_op_hash = ?`, SELL_OP);
    assert.deepEqual(trade, [p.items.find((i) => i.key === `op:${SELL_OP}`)!.proposal!.row]);
    const flow = rows(b.raw, "SELECT agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at FROM flows WHERE tx_hash = ?", dep.tx);
    assert.deepEqual(flow, [p.items.find((i) => i.key === `log:${dep.tx}#4`)!.proposal!.row]);
    const receipts = rows(b.raw, `SELECT evidence_key, table_name, row_id, state, backup_ref, preview_digest, epoch, account FROM ${BOOKINGS_TABLE} ORDER BY evidence_key`);
    assert.deepEqual(receipts.map((r) => [r.evidence_key, r.state, r.backup_ref, r.preview_digest, r.epoch, r.account]),
      [[`log:${dep.tx}#4`, "applied", "railway-backup-2026-10-06T09:00Z", p.previewDigest, 2, ACCOUNT], [`op:${SELL_OP}`, "applied", "railway-backup-2026-10-06T09:00Z", p.previewDigest, 2, ACCOUNT]]);
    // ADMISSION, ASKED AGAIN: the chain check finds nothing, and every Postgres precondition answers as before.
    assert.equal((await admissionSays(b, rpc)).status, "clean");
    const post = await preconditions(b);
    assert.deepEqual(post.refusals, pre.refusals);
    assert.deepEqual(post.refusals, []);
    // IDEMPOTENT: a fresh preview finds nothing missing, and the old plan applies nothing.
    assert.equal((await preview(b, rpc)).verdict, "nothing-missing");
    await assert.rejects(apply(b.db, p), (e: unknown) => e instanceof BookingRefused && e.code === "cas" && /ledger|known|booked/.test(e.message));
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = ?", SELL_OP)[0]!.n, 1);
    // And the receipts' own key refuses a second applied booking of the same evidence outright.
    assert.throws(() => b.raw.prepare(`INSERT INTO ${BOOKINGS_TABLE} (booking_id, tenant, account, epoch, chain_id, evidence_key, table_name, row_id, row_json, row_digest,
      preview_digest, backup_ref, admission_json, state, applied_at_ms) VALUES ('x', ?, ?, 2, 4663, ?, 'trades', 1, '{}', 'd', 'p', 'b', '{}', 'applied', 1)`)
      .run(SHOGUN_TENANT, ACCOUNT, `op:${SELL_OP}`), /UNIQUE/);
    // Each receipt keeps where the tenant stood with admission, as the report does: the chain refusal that held it, and nothing since.
    const kept = rows(b.raw, `SELECT DISTINCT admission_json FROM ${BOOKINGS_TABLE} WHERE booking_id = ?`, report.bookingId);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.admission_json, canonical(report.admission));
    assert.deepEqual(report.admission.approvals.map((a) => [a.approvalId, a.state, a.chainRefusal]), [["refusal", "refused", true]]);
  });

  it("refuses, writing nothing: a digest the owner did not review, no backup named, a plan that is not ready, books that moved since the preview", async () => {
    const { b, p } = await ready();
    const count = () => rows(b.raw, "SELECT (SELECT COUNT(*) FROM trades) AS t, (SELECT COUNT(*) FROM flows) AS f")[0];
    const before = count();
    await assert.rejects(apply(b.db, p, { confirm: "f".repeat(64) }), (e: unknown) => (e as BookingRefused).code === "confirm-mismatch");
    await assert.rejects(apply(b.db, p, { backupRef: "" }), (e: unknown) => (e as BookingRefused).code === "backup-ref");
    await assert.rejects(apply(b.db, p, { backupRef: "https://user:pw@host/db" }), (e: unknown) => (e as BookingRefused).code === "backup-ref");
    await assert.rejects(apply(b.db, { ...p, verdict: "blocked" }), (e: unknown) => (e as BookingRefused).code === "not-ready");
    // A row lands for the account between the preview and the apply: compare-and-set refuses the whole booking.
    b.raw.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'x', 1, 'rejected', ?, 2)").run(ACCOUNT, NOW);
    await assert.rejects(apply(b.db, p), (e: unknown) => (e as BookingRefused).code === "cas" && /\(ledger\)/.test((e as Error).message));
    assert.deepEqual(count(), { t: (before!.t as number) + 1, f: before!.f });
    assert.equal(rows(b.raw, `SELECT COUNT(*) AS n FROM ${BOOKINGS_TABLE}`)[0]!.n, 0);
  });

  it("a failure inside the transaction rolls every row back", async () => {
    const { b, p } = await ready();
    // The flow's identity is taken after the snapshot was compared: the insert finds it, and the trade inserted before it goes too.
    const realTx = b.db.tx.bind(b.db);
    const sneaky = { ...b.db, prepare: b.db.prepare.bind(b.db), exec: b.db.exec.bind(b.db), tx: <T>(fn: (db: Db) => Promise<T>) => realTx(async (tx) => fn({
      ...tx, exec: tx.exec.bind(tx), tx: tx.tx.bind(tx),
      prepare(sql: string) {
        if (/^INSERT INTO flows/.test(sql)) b.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
          VALUES (?, 'in', 12.5, ?, 1, 4, 'chain-log', 2, 4663, 1)`).run(ACCOUNT, p.items.find((i) => i.proposal?.table === "flows")!.proposal!.row.tx_hash);
        return tx.prepare(sql);
      },
    })) } as Db;
    await assert.rejects(apply(sneaky, p), (e: unknown) => (e as BookingRefused).code === "insert");
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = ?", SELL_OP)[0]!.n, 0, "the trade went with it");
  });

  it("revert takes the booking back exactly, keeps each row in its receipt, and the chain check refuses again", async () => {
    const { b, p, rpc } = await ready();
    const report = await apply(b.db, p);
    const reparsed = parseApplyReport(JSON.stringify(report));
    const r = await revertBooking(b.db, reparsed, { nowMs: (NOW + 60) * 1000, dialect: "sqlite" });
    assert.equal(r.outcome, "reverted");
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = ?", SELL_OP)[0]!.n, 0);
    const receipts = rows(b.raw, `SELECT evidence_key, state, reverted_at_ms, row_json FROM ${BOOKINGS_TABLE} ORDER BY evidence_key`);
    assert.deepEqual(receipts.map((x) => [x.state, x.reverted_at_ms]), [["reverted", (NOW + 60) * 1000], ["reverted", (NOW + 60) * 1000]]);
    assert.deepEqual(JSON.parse(String(receipts[1]!.row_json)), JSON.parse(canonical(report.rows[0]!.row)), "the row, kept in full");
    assert.equal((await admissionSays(b, rpc)).status, "missing");
    assert.equal((await revertBooking(b.db, reparsed, { nowMs: NOW * 1000, dialect: "sqlite" })).outcome, "already-reverted");
    // Reverted, the evidence can be booked again by a new preview.
    const again = await preview(b, rpc);
    assert.equal(again.verdict, "ready");
    await apply(b.db, again);
  });

  it("revert refuses a row changed since, a tenant admitted on the rows, and a report that does not verify", async () => {
    const { b, p } = await ready();
    const report = await apply(b.db, p);
    b.raw.prepare("UPDATE trades SET realized_pnl_usdg = 0.1 WHERE user_op_hash = ?").run(SELL_OP);
    await assert.rejects(revertBooking(b.db, report, { nowMs: NOW * 1000, dialect: "sqlite" }), (e: unknown) => (e as BookingRefused).code === "cas" && /no longer exactly as booked/.test((e as Error).message));
    b.raw.prepare("UPDATE trades SET realized_pnl_usdg = NULL WHERE user_op_hash = ?").run(SELL_OP);
    await ensureLedgerResumeSchema(b.db);
    b.raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, created_at_ms, updated_at_ms)
      VALUES ('a', ?, ?, 4663, ?, ?, '{}', 'r', 'registered', ?, ?)`).run(SHOGUN_TENANT, ACCOUNT, SHOGUN_TENANT, "e".repeat(64), NOW * 1000 + 1, NOW * 1000 + 1);
    await assert.rejects(revertBooking(b.db, report, { nowMs: NOW * 1000, dialect: "sqlite" }), (e: unknown) => (e as BookingRefused).code === "admitted");
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = ?", SELL_OP)[0]!.n, 1, "nothing changed");
    const tampered = { ...report, rows: report.rows.map((r) => ({ ...r, id: r.id + 1 })) };
    assert.throws(() => parseApplyReport(JSON.stringify(tampered)), (e: unknown) => (e as BookingRefused).code === "report");
    assert.throws(() => parseApplyReport("{"), (e: unknown) => (e as BookingRefused).code === "report");
  });
});

// ── what the reviews asked to see refused ───────────────────────────────────

const applyNow = (db: Db, p: BookingPlan, extra: Partial<{ confirm: string; backupRef: string; nowMs: number }> = {}) =>
  applyBooking(db, p, { confirm: p.previewDigest, backupRef: "railway-backup-2026-10-06T09:00Z", dialect: "sqlite", nowMs: NOW * 1000, ...extra });
/** A deposit from outside the system: the simplest fact that books. */
const depositAt = (block: bigint, tag = "deposit") => lone({ from: addr(0xd0d0), to: ACCOUNT, amount: 12_500_000n, block, tag });
/** The fixture chain's block at a given second: ten a second, dated from the sell's own block. */
const blockAt = (sec: number) => SELL_BLOCK + BigInt((sec - CHAIN.sell.timestamp) * 10);
type Books = Awaited<ReturnType<typeof books>>;

describe("only a held tenant is booked (holdOf)", () => {
  it("a tenant admission never refused — running, its heartbeat 5s old, its mirror 60s, an operation 30s and 300 blocks deep — is BLOCKED, and nothing applies", async () => {
    const b = await books({ refused: false });
    b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW - 5, ACCOUNT);
    b.raw.prepare("UPDATE mirror_state SET updated_at = ? WHERE tenant = ?").run(NOW - 60, SHOGUN_TENANT);
    const op = h32("not mirrored yet");
    const { rpc } = fakeRpc({ txs: [fromFixture(CHAIN.buy), operation({ opHash: op, nonce: SESSION_NONCE, block: HEAD - 300n, tag: "not mirrored yet" })] });
    const p = await preview(b, rpc);
    assert.deepEqual(p.items.map((i) => i.class), ["session-no-movement"], "the operation itself classifies; the tenant is what is refused");
    assert.equal(p.verdict, "blocked");
    assert.ok(p.refusals.some((r) => /admission has never refused this tenant on the chain/.test(r)), p.refusals.join("; "));
    await assert.rejects(applyNow(b.db, p), (e: unknown) => (e as BookingRefused).code === "not-ready");
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = ?", op)[0]!.n, 0, "the child's own row stays the one the mirror brings");
  });

  it("refused for another reason, admitted since, a heartbeat or a mirrored row after the chain refusal, or a book written in the last ten minutes: each refuses", async () => {
    const txs = [fromFixture(CHAIN.buy), depositAt(SELL_BLOCK + 1_000n)];
    assert.equal((await preview(await books(), fakeRpc({ txs }).rpc)).verdict, "ready", "held on a chain refusal, nothing since: it books");
    const refusedWith = async (setup: (b: Books) => void, pattern: RegExp) => {
      const b = await books();
      setup(b);
      const p = await preview(b, fakeRpc({ txs }).rpc);
      assert.equal(p.verdict, "blocked", pattern.source);
      assert.ok(p.refusals.some((r) => pattern.test(r)), `${pattern.source}: ${p.refusals.join("; ")}`);
    };
    await refusedWith((b) => b.raw.prepare("UPDATE ledger_resume_approvals SET reason = 'the stored grant names a different account, chain or owner than the approval'").run(),
      /newest admission decision \(approval refusal…, refused for another reason\) is not a chain refusal: this tool books only what admission refused a held tenant on$/);
    await refusedWith((b) => refuse(b.raw, { tenant: b.tenant, account: b.account, id: "admitted", atSec: REFUSED_AT + 60, state: "applied", generation: "g".repeat(36), reason: "" }),
      /newest admission decision \(approval admitted…, applied\) is not a chain refusal: this tool books only what admission refused a held tenant on$/);
    // A later refusal for another reason over the chain refusal: the anchor rule stands, and the way out is said — one approval, which
    // reads the chain again for a tenant with a chain refusal no admission has answered, and refuses it afresh while Postgres lacks it.
    await refusedWith((b) => refuse(b.raw, { tenant: b.tenant, account: b.account, id: "evidence", atSec: REFUSED_AT + 60, reason: "the evidence changed since the preview" }),
      /newest admission decision \(approval evidence…, refused for another reason\) is not a chain refusal: .*\. An earlier approval was refused on the chain: preview the tenant in admission's preview and approve the digest it prints once, .*from where that refused read began.*fresh chain refusal; then take it out of the rollout and preview here again$/);
    // Not when an admission answered that chain refusal before the later one: there is nothing for an approval to read the chain again for.
    await refusedWith((b) => {
      refuse(b.raw, { tenant: b.tenant, account: b.account, id: "admitted", atSec: REFUSED_AT + 30, state: "applied", generation: "g".repeat(36), reason: "" });
      refuse(b.raw, { tenant: b.tenant, account: b.account, id: "evidence", atSec: REFUSED_AT + 60, reason: "the evidence changed since the preview" });
    }, /newest admission decision \(approval evidence…, refused for another reason\) is not a chain refusal: this tool books only what admission refused a held tenant on$/);
    await refusedWith((b) => b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(REFUSED_AT + 10, ACCOUNT),
      /its worker beat at .* after admission refused it at .*: it has run since, so it is not held/);
    // The same heartbeat in milliseconds, as rows carried from elsewhere have held it.
    await refusedWith((b) => b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run((REFUSED_AT + 10) * 1000, ACCOUNT), /its worker beat at /);
    await refusedWith((b) => b.raw.prepare("UPDATE mirror_state SET updated_at = ? WHERE tenant = ? AND table_name = 'events'").run(REFUSED_AT + 10, SHOGUN_TENANT),
      /rows were mirrored for it at .* after admission refused it/);
    // Before the refusal, but not ten minutes ago.
    await refusedWith((b) => {
      b.raw.prepare("UPDATE ledger_resume_approvals SET updated_at_ms = ?").run((NOW - 60) * 1000);
      b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW - 300, ACCOUNT);
    }, /its book was written 300s ago \(heartbeat or mirror\): preview again once it has been quiet for 10 minutes/);
  });

  it("a revoked approval after the chain refusal decided nothing; a fact that landed after the refusal, or within a minute before it, is not booked", async () => {
    const b = await books();
    refuse(b.raw, { tenant: b.tenant, account: b.account, id: "withdrawn", atSec: REFUSED_AT + 600, state: "revoked", reason: "revoked by the operator" });
    const early = depositAt(SELL_BLOCK + 1_000n, "early"), edge = depositAt(blockAt(REFUSED_AT - 30), "edge"), late = depositAt(blockAt(REFUSED_AT + 120), "late");
    const p = await preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy), early, edge, late] }).rpc);
    assert.deepEqual(p.refusals, [], "the revoked approval is passed over: the chain refusal before it still holds the tenant");
    assert.equal(p.items.find((i) => i.fact.txHash === early.tx)?.class, "deposit");
    for (const t of [edge, late]) {
      const it = p.items.find((i) => i.fact.txHash === t.tx)!;
      assert.equal(it.class, "unresolved");
      assert.match(it.why, /not before admission's chain refusal of this tenant at .*: let admission refuse the tenant again/);
    }
    assert.equal(p.verdict, "blocked");
  });

  it("a tenant that wakes between the preview and the apply is refused by the compare-and-set, writing nothing", async () => {
    const wakes: Array<[string, (b: Books) => void]> = [
      ["a heartbeat", (b) => b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW, ACCOUNT)],
      ["a mirrored row", (b) => b.raw.prepare("UPDATE mirror_state SET updated_at = ? WHERE tenant = ? AND table_name = 'events'").run(NOW, SHOGUN_TENANT)],
      ["its mode", (b) => b.raw.prepare("UPDATE agents SET mode = 'paper' WHERE smart_account = ?").run(ACCOUNT)],
      ["an approval", (b) => refuse(b.raw, { tenant: b.tenant, account: b.account, id: "newer", atSec: NOW - 10 })],
      ["a position", (b) => b.raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
        VALUES (?, 'X', ?, '1', '1', 1, 0, 'pool', 1, ?)`).run(ACCOUNT, addr(0x99), NOW)],
      // No count or maximum id moves: only the fills' own digest sees it.
      ["a recorded fill repaired in place", (b) => b.raw.prepare("UPDATE trades SET fill_side = 'buy', fill_qty_raw = '1', basis_source = 'receipt' WHERE user_op_hash = ?").run(BUY_OP)],
    ];
    for (const [what, wake] of wakes) {
      const b = await books();
      const dep = depositAt(SELL_BLOCK + 1_000n);
      const p = await preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy), dep] }).rpc);
      assert.equal(p.verdict, "ready", what);
      wake(b);
      await assert.rejects(applyNow(b.db, p), (e: unknown) => (e as BookingRefused).code === "cas" && /\((admission|agents|holdings|fills)\)/.test((e as Error).message), what);
      assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?", dep.tx)[0]!.n, 0, what);
    }
  });
});

describe("a trade only where the seed already holds what the chain does (holdingVerdict)", () => {
  /** Shogun's sell of COIN missing, its buy in Postgres; the book's balances as given. */
  const sellPlan = (b: Books, o: { balances?: Record<string, Record<string, bigint>>; failBalances?: string[] } = {}) =>
    preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)], decimals: { [COIN]: 18n }, ...o }).rpc);
  /** What the lost book's last mirror left: a COIN position of `raw` (1000) written at `positionAt`, and its basis at `basisAt` (none when null), costing 5 USDG. */
  const snapshot = (b: Books, o: { positionAt: number; basisAt?: number | null; raw?: bigint }) => {
    b.raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
      VALUES (?, 'COIN', ?, ?, '1', 1, 0, 'pool', 1, ?)`).run(ACCOUNT, COIN, (o.raw ?? 1000n).toString(), o.positionAt);
    if (o.basisAt !== null) b.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', ?, '5000000', ?)").run(ACCOUNT, (o.raw ?? 1000n).toString(), o.basisAt ?? o.positionAt);
  };
  /** The 1000 that snapshot says, held in the Trencher vault at the pinned block. */
  const inVault = { balances: { [COIN]: { [VAULT]: 1000n } } };
  const sell = (p: BookingPlan) => p.items.find((i) => i.key === `op:${SELL_OP}`)!;
  const leg = (p: BookingPlan) => p.items.find((i) => i.key === `log:${CHAIN.sell.tx}#11`)!;
  /** What Shogun's buy and sell each moved: the same lot of COIN. */
  const LOT = BigInt("0x29343d8834fb02ccd");

  it("held, its position and basis each what the book holds at the pinned block, its fills walked from flat and its cost what they give: the trade books, and its evidence says how", async () => {
    const b = await books();
    // The executor's rows, fills and all: an earlier buy of a lot for 5 USDG, and Shogun's own buy of another (the row books() wrote, with its fill).
    b.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch,
        fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, basis_source) VALUES (?, 'swap', ?, ?, ?, 5, ?, ?, 'landed', ?, 2, 'buy', 'COIN', ?, 5, 'receipt')`)
      .run(ACCOUNT, VAULT, USDG, COIN, h32("earlier buy"), h32("earlier buy tx"), CHAIN.buy.timestamp - 600, LOT.toString());
    b.raw.prepare("UPDATE trades SET fill_side = 'buy', fill_symbol = 'COIN', fill_qty_raw = ?, fill_cash_usdg = 5, basis_source = 'receipt' WHERE user_op_hash = ?")
      .run(LOT.toString(), BUY_OP);
    // The mirror after the sell: one lot left, at half the 10 USDG the two cost.
    snapshot(b, { positionAt: CHAIN.sell.timestamp + 5, raw: LOT });
    const model = fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)], decimals: { [COIN]: 18n }, balances: { [COIN]: { [VAULT]: LOT } } });
    const p = await preview(b, model.rpc);
    assert.equal(p.verdict, "ready", planLines(p).join("\n"));
    const holding = sell(p).evidence.holding as { lastTradeAt: number; position: { updatedAt: number }; basis: { updatedAt: number }; refusal: null;
      bookBalance: { total: string }; fills: { verdict: string; anchor: string }; cost: { verdict: string; basis: unknown } };
    assert.deepEqual([holding.lastTradeAt, holding.position.updatedAt, holding.basis.updatedAt], [CHAIN.sell.timestamp, CHAIN.sell.timestamp + 5, CHAIN.sell.timestamp + 5]);
    assert.deepEqual([holding.refusal, holding.bookBalance.total], [null, LOT.toString()]);
    // PINNED: every balance was read at admission's head less 64, and the plan says which block (outside the digest, as the head is).
    assert.ok(model.balanceTags.length > 0 && model.balanceTags.every((t) => t === `0x${(HEAD - 64n).toString(16)}`), model.balanceTags.join(","));
    assert.equal(p.capture.balanceBlock, (HEAD - 64n).toString());
    // A lot held ← the missed sell of one ← the buy of one ← the earlier buy of one, from flat; and (2 lots, 10 USDG) less half is the basis's cost exactly.
    assert.deepEqual([holding.fills.verdict, holding.fills.anchor], ["reproduced", "before every fill Postgres records in the token"]);
    assert.deepEqual(holding.cost, { verdict: "replayed", why: null, basis: { qtyRaw: LOT.toString(), costUsdg: "5000000" } });
    assert.ok(!p.warnings.some((w) => /could not be walked/.test(w)), p.warnings.join("\n"));
  });

  it("not held, and none of it on chain across the account and its vault: the trade books", async () => {
    const p = await sellPlan(await books());
    assert.equal(p.verdict, "ready");
    const holding = sell(p).evidence.holding as { position: unknown; bookBalance: { total: string; by: Record<string, string> } };
    assert.equal(holding.position, null);
    assert.deepEqual(holding.bookBalance, { total: "0", by: { [ACCOUNT]: "0", [VAULT]: "0" } });
    // Postgres's buy of COIN carries no fill, so the walk cannot be done: with nothing held there is nothing seeded, so it is said, not refused.
    assert.ok(p.warnings.some((w) => /0xaa07.*: none of it is held, on chain or in the snapshot, .*could not be walked back .*trade #1 in 0xaa07.* records no fill/.test(w)),
      p.warnings.join("\n"));
  });

  it("a Pons class vault: positions do not cover it, so one holding the token refuses by name; one holding none is read and books", async () => {
    const CLASS = addr(0xc1a5);
    const holding = await sellPlan(await books({ classVault: CLASS }), { balances: { [COIN]: { [CLASS]: 7n } } });
    assert.equal(holding.verdict, "blocked");
    assert.equal((sell(holding).evidence.holding as { refusal: string }).refusal, "class-vault-held");
    assert.match(sell(holding).why, new RegExp(`^not booked \\(class-vault-held\\): the account's Pons class vault ${CLASS} held 7 base units of 0xaa07.* at the pinned block: ` +
      "Postgres's positions and cost basis cover the account and its Trencher vault"));
    const none = await sellPlan(await books({ classVault: CLASS }));
    assert.equal(none.verdict, "ready", planLines(none).join("\n"));
    assert.deepEqual((sell(none).evidence.holding as { bookBalance: unknown }).bookBalance, { total: "0", by: { [ACCOUNT]: "0", [CLASS]: "0", [VAULT]: "0" } });
  });

  it("a position or basis other than the chain's, a held position with no basis, one written before the trade, a balance the snapshot does not know of, a held token whose fills cannot be walked, or an unread balance: unresolved, legs and all", async () => {
    const cases: Array<[string, (b: Books) => void, Parameters<typeof sellPlan>[1], string, RegExp]> = [
      // Every quantity and time agrees — but Postgres's buy of COIN carries no fill (as the in-flight reconciler writes its rows, until the history
      // repair fills them in), so what the book holds cannot be traced to the fills that put it there, and the seed would carry that basis into the
      // new book.
      ["held, the fills unwalkable", (b) => snapshot(b, { positionAt: CHAIN.sell.timestamp + 5 }), inVault, "fills-unproven",
        /could not be walked back to where its basis opened \(trade #1 in 0xaa07.* records no fill \(side and quantity\)\): the position and basis hold the chain's quantity/],
      ["position other than the chain's", (b) => snapshot(b, { positionAt: CHAIN.sell.timestamp + 5 }), {}, "position-differs",
        /position in COIN \(0xaa07.*\) holds 1000 base units, and the book held 0 on chain at the pinned block/],
      ["basis other than the chain's", (b) => {
        snapshot(b, { positionAt: CHAIN.sell.timestamp + 5 });
        b.raw.prepare("UPDATE cost_basis SET qty_raw = '400'").run();
      }, inVault, "basis-differs", /live cost basis for COIN covers 400 base units, and the book held 1000 on chain at the pinned block/],
      ["position before the trade", (b) => snapshot(b, { positionAt: CHAIN.sell.timestamp - 60 }), inVault, "position-stale",
        /position in COIN \(0xaa07.*\) was last written 2026-.*, before the tenant's last trade in it .*: the attested book is seeded from that snapshot/],
      ["no basis", (b) => snapshot(b, { positionAt: CHAIN.sell.timestamp + 5, basisAt: null }), inVault, "basis-missing", /holds a position in COIN .* with no live cost basis/],
      ["basis before the trade", (b) => snapshot(b, { positionAt: CHAIN.sell.timestamp + 5, basisAt: CHAIN.sell.timestamp - 60 }), inVault, "basis-stale",
        /cost basis for COIN was last written .* before the tenant's last trade in it/],
      ["held on chain, not in the snapshot", () => {}, { balances: { [COIN]: { [VAULT]: 7n } } }, "held-unrecorded",
        /the book held 7 base units of 0xaa07.* on chain at the pinned block .*, and the snapshot .* holds none/],
      ["balance unread", () => {}, { failBalances: [COIN] }, "balance-unread", /the book's balance of 0xaa07.* at the pinned block could not be read/],
      ["balance unread, the snapshot holding it", (b) => snapshot(b, { positionAt: CHAIN.sell.timestamp + 5 }), { failBalances: [COIN] }, "balance-unread",
        /could not be read .*cannot be proved/],
    ];
    for (const [what, setup, chain, refusal, pattern] of cases) {
      const b = await books();
      setup(b);
      const p = await sellPlan(b, chain);
      assert.equal(p.verdict, "blocked", what);
      assert.equal(sell(p).class, "unresolved", what);
      assert.equal(sell(p).proposal, null, what);
      assert.match(sell(p).why, pattern, what);
      assert.equal((sell(p).evidence.holding as { refusal: string }).refusal, refusal, what);
      assert.equal(leg(p).class, "unresolved", `${what}: its leg waits on it`);
      assert.equal(p.remaining.length, 2, what);
    }
  });

  it("a buy and a sell of one token, both missing, are judged at the last of them", async () => {
    // A round trip: the snapshot holds none, the chain holds none — both book.
    const flat = await books({ knownBuy: false });
    const ok = await preview(flat, fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)], decimals: { [COIN]: 18n } }).rpc);
    assert.equal(ok.verdict, "ready");
    assert.deepEqual(ok.items.filter((i) => i.class === "session-trade").map((i) => (i.evidence.holding as { lastTradeAt: number }).lastTradeAt),
      [CHAIN.sell.timestamp, CHAIN.sell.timestamp]);
    // The two fills, from flat, are the chain's nothing exactly.
    assert.deepEqual(ok.items.filter((i) => i.class === "session-trade").map((i) => (i.evidence.holding as { fills: { verdict: string } }).fills.verdict),
      ["reproduced", "reproduced"]);
    // A snapshot taken between the buy and the sell knows the buy and not the sell: neither books.
    const between = await books({ knownBuy: false });
    snapshot(between, { positionAt: CHAIN.buy.timestamp + 10 });
    const no = await preview(between, fakeRpc({ txs: [fromFixture(CHAIN.buy), fromFixture(CHAIN.sell)], decimals: { [COIN]: 18n } }).rpc);
    assert.equal(no.verdict, "blocked");
    assert.deepEqual(no.items.filter((i) => i.fact.kind === "operation").map((i) => i.class), ["unresolved", "unresolved"]);
  });
});

/**
 * WHEN THE SNAPSHOT WAS WRITTEN IS NEVER ENOUGH (Codex on #293). A missed
 * fill followed by an ordinary one in the same token rewrites the position
 * and the basis after the missed fill, and the basis can still leave it out.
 * Synthetic session-key swaps of one token against USDG, on the account
 * alone; Postgres records the ordinary fills as the live path writes them
 * (fill side and quantity read off the receipt, and — where a test gives it —
 * the cash bookFill applied to the basis).
 */
describe("the snapshot's contents against the chain, never its timestamps alone", () => {
  const TOKEN = addr(0x70c3), POOL = addr(0x900d);
  const E18 = 10n ** 18n;
  /** A session key's swap of TOKEN against USDG, on chain: the missed one. */
  const swap = (o: { tag: string; side: "buy" | "sell"; qty: bigint; cash: bigint; block: bigint }) => operation({ opHash: h32(o.tag), nonce: SESSION_NONCE, block: o.block,
    tag: o.tag, logs: o.side === "buy"
      ? [[USDG, [TR, topic(ACCOUNT), topic(POOL)], `0x${word(o.cash)}`, "0x2"], [TOKEN, [TR, topic(POOL), topic(ACCOUNT)], `0x${word(o.qty)}`, "0x3"]]
      : [[TOKEN, [TR, topic(ACCOUNT), topic(POOL)], `0x${word(o.qty)}`, "0x2"], [USDG, [TR, topic(POOL), topic(ACCOUNT)], `0x${word(o.cash)}`, "0x3"]] });
  /** An ordinary fill Postgres holds, as the executor writes it; `cash` in micro-USDG, as fill_cash_usdg carries it (none when not given). */
  const recorded = (b: Books, o: { tag: string; side: "buy" | "sell"; qty: bigint; at: number; cash?: bigint; basisSource?: string; status?: string }) =>
    b.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch,
        fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, basis_source) VALUES (?, 'swap', ?, ?, ?, 1, ?, ?, ?, ?, 2, ?, 'TKN', ?, ?, ?)`)
      .run(ACCOUNT, POOL, o.side === "buy" ? USDG : TOKEN, o.side === "buy" ? TOKEN : USDG, h32(o.tag), h32(`${o.tag} tx`), o.status ?? "landed", o.at, o.side,
        o.qty.toString(), o.cash === undefined ? null : Number(o.cash) / 1e6, o.basisSource ?? "receipt");
  /**
   * A landed row the in-flight reconciler writes for an operation the book lost (index.ts reconcileInFlightAtArm): its legs, 'receipt', and no
   * fill — dated `at`, when the arm wrote it.
   */
  const reconciled = (b: Books, o: { tag: string; side: "buy" | "sell"; at: number }) =>
    b.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch, basis_source)
        VALUES (?, 'swap', ?, ?, ?, 1, ?, ?, 'landed', ?, 2, 'receipt')`)
      .run(ACCOUNT, ACCOUNT, o.side === "buy" ? USDG : TOKEN, o.side === "buy" ? TOKEN : USDG, h32(o.tag), h32(`${o.tag} tx`), o.at);
  /** The lost book's last mirror: the position (rewritten every tick) and the live basis (at its last fill, costing `cost` — 1 USDG unless given), or neither. */
  const mirrored = (b: Books, o: { raw: bigint; basisQty: bigint | null; at: number; cost?: bigint }) => {
    b.raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
      VALUES (?, 'TKN', ?, ?, '1', 1, 0, 'pool', 1, ?)`).run(ACCOUNT, TOKEN, o.raw.toString(), o.at + 5);
    if (o.basisQty !== null) {
      b.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'TKN', ?, ?, ?)").run(ACCOUNT, o.basisQty.toString(), (o.cost ?? 1_000_000n).toString(), o.at);
    }
  };
  const T0 = CHAIN.sell.timestamp + 100, MISSED = SELL_BLOCK + 2_000n, MISSED_AT = CHAIN.sell.timestamp + 200, T2 = CHAIN.sell.timestamp + 300;
  const plan = (b: Books, missed: ModelTx | ModelTx[], o: { balance?: bigint; failBalances?: string[] } = {}) =>
    preview(b, fakeRpc({ txs: [missed].flat(), decimals: { [TOKEN]: 18n }, balances: { [TOKEN]: { [ACCOUNT]: o.balance ?? 0n } }, failBalances: o.failBalances }).rpc);
  const trade = (p: BookingPlan, tag: string) => p.items.find((i) => i.key === `op:${h32(tag)}`)!;
  const holdingOf = (p: BookingPlan, tag: string) => trade(p, tag).evidence.holding as { refusal: string | null; fills: { verdict: string; anchor: string | null };
    cost: { verdict: string; why: string | null; basis: { qtyRaw: string; costUsdg: string } | null } };

  it("a missed buy, then an ordinary buy that rewrote both rows after it: refused while the basis leaves the missed buy out, or its cost cannot be replayed; booked once it holds it at what the fills cost", async () => {
    const missed = swap({ tag: "missed buy", side: "buy", qty: 100n * E18, cash: 100_000_000n, block: MISSED });
    // The later buy of 50 for 50 USDG, its cash on record or not; the basis as given, costing 150 USDG (the two buys').
    const run = async (basisQty: bigint, o: { cash?: boolean } = {}) => {
      const b = await books();
      recorded(b, { tag: "later buy", side: "buy", qty: 50n * E18, at: T2, ...(o.cash === false ? {} : { cash: 50_000_000n }) });
      mirrored(b, { raw: 150n * E18, basisQty, cost: 150_000_000n, at: T2 });
      return plan(b, missed, { balance: 150n * E18 });
    };
    const left = await run(50n * E18);
    // Both rows were written after the missed buy — the timestamps alone would have booked it.
    const h = trade(left, "missed buy").evidence.holding as { position: { updatedAt: number }; basis: { updatedAt: number } };
    assert.ok(h.position.updatedAt > MISSED_AT && h.basis.updatedAt > MISSED_AT);
    assert.equal(left.verdict, "blocked", planLines(left).join("\n"));
    assert.equal(trade(left, "missed buy").class, "unresolved");
    assert.equal(holdingOf(left, "missed buy").refusal, "basis-differs");
    assert.match(trade(left, "missed buy").why,
      /^not booked \(basis-differs\): Postgres's live cost basis for TKN covers 50000000000000000000 base units, and the book held 150000000000000000000 on chain at the pinned block/);
    assert.ok(planLines(left).some((l) => /why: not booked \(basis-differs\)/.test(l)), "named at the console");
    assert.equal(left.items.filter((i) => i.proposal).length, 0, "its USDG leg waits on it");

    const holds = await run(150n * E18);
    assert.equal(holds.verdict, "ready", planLines(holds).join("\n"));
    // 150 held ← the later buy of 50 ← the missed buy of 100, from flat; and 100 + 50 USDG is the basis's cost exactly.
    const { fills, cost } = holdingOf(holds, "missed buy");
    assert.deepEqual([fills.verdict, fills.anchor], ["reproduced", "before every fill Postgres records in the token"]);
    assert.deepEqual(cost, { verdict: "replayed", why: null, basis: { qtyRaw: (150n * E18).toString(), costUsdg: "150000000" } });
    assert.ok(!holds.warnings.some((w) => /0x0+70c3:/.test(w)), holds.warnings.join("\n"));

    // The same, with the later buy's cash not on record: every quantity agrees, and the trades are all buys — but the cost cannot be replayed,
    // and nothing else says the basis was built from these fills. Refused, legs and all.
    const unreplayed = await run(150n * E18, { cash: false });
    assert.equal(unreplayed.verdict, "blocked", planLines(unreplayed).join("\n"));
    const u = holdingOf(unreplayed, "missed buy");
    assert.deepEqual([u.fills.verdict, u.cost.verdict, u.refusal], ["reproduced", "unproven", "cost-unproven"]);
    assert.match(trade(unreplayed, "missed buy").why, new RegExp("^not booked \\(cost-unproven\\): Postgres's live cost basis for TKN holds the chain's " +
      "150000000000000000000 base units at a cost of 150\\.000000 USDG, and what the fills since it last opened \\(before every fill Postgres records in the " +
      "token\\) cost cannot be replayed to check it \\(trades#\\d+ records no exact cash for its buy \\(fill_cash_usdg\\)"));
    assert.equal(unreplayed.items.filter((i) => i.proposal).length, 0, "its USDG leg waits on it");
    assert.ok(!unreplayed.warnings.some((w) => /was not checked/.test(w)), "no note books it in place of the cost");
  });

  it("a missed sell, then an ordinary sell: refused while the basis leaves the missed sell out, or the first buy's cash is not on record; booked once it holds it", async () => {
    const missed = swap({ tag: "missed sell", side: "sell", qty: 40n * E18, cash: 44_000_000n, block: MISSED });
    // The first buy of 100 for 100 USDG, its cash on record or not. Each sell takes cost pro rata: 100 at 100 → 60 at 60 → 30 at 30.
    const run = async (basisQty: bigint, o: { cash?: boolean } = {}) => {
      const b = await books();
      recorded(b, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0, ...(o.cash === false ? {} : { cash: 100_000_000n }) });
      recorded(b, { tag: "later sell", side: "sell", qty: 30n * E18, at: T2 });
      mirrored(b, { raw: 30n * E18, basisQty, cost: 30_000_000n, at: T2 });
      return plan(b, missed, { balance: 30n * E18 });
    };
    const left = await run(70n * E18);
    assert.equal(left.verdict, "blocked");
    assert.equal(holdingOf(left, "missed sell").refusal, "basis-differs");
    assert.match(trade(left, "missed sell").why, /covers 70000000000000000000 base units, and the book held 30000000000000000000 on chain/);
    const holds = await run(30n * E18);
    assert.equal(holds.verdict, "ready", planLines(holds).join("\n"));
    // 30 held ← the later sell ← the missed sell ← the first buy, from flat; and 30 at 30 USDG is the basis exactly.
    assert.equal(holdingOf(holds, "missed sell").fills.verdict, "reproduced");
    assert.deepEqual(holdingOf(holds, "missed sell").cost.basis, { qtyRaw: (30n * E18).toString(), costUsdg: "30000000" });
    // The trades booked here are all sells, and the quantities all agree — but with the buy's cash not on record, the cost is unproven.
    const unreplayed = await run(30n * E18, { cash: false });
    assert.equal(unreplayed.verdict, "blocked", planLines(unreplayed).join("\n"));
    assert.deepEqual([holdingOf(unreplayed, "missed sell").fills.verdict, holdingOf(unreplayed, "missed sell").refusal], ["reproduced", "cost-unproven"]);
  });

  it("a token fully exited — no position, no basis, nothing on chain — books; a basis left over the flat book books only where the seed cannot carry it", async () => {
    const missed = swap({ tag: "missed exit", side: "sell", qty: 100n * E18, cash: 101_000_000n, block: MISSED });
    const b = await books();
    recorded(b, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0 });
    const flat = await plan(b, missed);
    assert.equal(flat.verdict, "ready", planLines(flat).join("\n"));
    assert.deepEqual([holdingOf(flat, "missed exit").refusal, holdingOf(flat, "missed exit").fills.verdict], [null, "reproduced"]);
    assert.equal((trade(flat, "missed exit").evidence.holding as { staleBasis?: unknown }).staleBasis, undefined, "no basis, nothing to name");
    // The basis the exit never reached: nothing holds TKN, so the seed carries none of it, and it is named, not booked.
    const staleBooks = async () => {
      const s = await books();
      recorded(s, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0 });
      s.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'TKN', ?, '1000000', ?)").run(ACCOUNT, (100n * E18).toString(), T0);
      return s;
    };
    const named = await plan(await staleBooks(), missed);
    assert.equal(named.verdict, "ready", planLines(named).join("\n"));
    assert.ok(named.warnings.some((w) => /^0x0+70c3: Postgres's live cost basis under TKN \(100000000000000000000 base units at 1\.000000 USDG, .*\) is left over a token the book does not hold/.test(w)),
      named.warnings.join("\n"));
    // A held position under its name — another token's — and the seed would hand it this cost: refused.
    const another = await staleBooks();
    another.raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
      VALUES (?, 'TKN', ?, '5', '1', 1, 0, 'pool', 1, ?)`).run(ACCOUNT, addr(0xbad), T2);
    const p = await plan(another, missed);
    assert.equal(p.verdict, "blocked");
    assert.equal(holdingOf(p, "missed exit").refusal, "basis-without-position");
    assert.match(trade(p, "missed exit").why, /yet its live cost basis under TKN still covers 100000000000000000000: Postgres's positions hold TKN \(0x0+bad\) at 5/);
  });

  it("an unreadable balance refuses, even under a snapshot that holds the trade and was written after it", async () => {
    const missed = swap({ tag: "missed buy", side: "buy", qty: 100n * E18, cash: 100_000_000n, block: MISSED });
    const b = await books();
    mirrored(b, { raw: 100n * E18, basisQty: 100n * E18, at: T2 });
    const p = await plan(b, missed, { balance: 100n * E18, failBalances: [TOKEN] });
    assert.equal(p.verdict, "blocked");
    assert.equal(holdingOf(p, "missed buy").refusal, "balance-unread");
    assert.match(trade(p, "missed buy").why, /balance of 0x0+70c3 at the pinned block could not be read \(0x05a198.* unread\)/);
  });

  it("fills more than the chain holds refuse, even with the position and basis equal to it", async () => {
    // Postgres records a buy of 150 and the chain holds 150: there is no room for a missed buy of 100 before it.
    const missed = swap({ tag: "missed buy", side: "buy", qty: 100n * E18, cash: 100_000_000n, block: MISSED });
    const b = await books();
    recorded(b, { tag: "later buy", side: "buy", qty: 150n * E18, at: T2 });
    mirrored(b, { raw: 150n * E18, basisQty: 150n * E18, at: T2 });
    const p = await plan(b, missed, { balance: 150n * E18 });
    assert.equal(p.verdict, "blocked");
    assert.equal(holdingOf(p, "missed buy").refusal, "fills-exceed-chain");
    assert.match(trade(p, "missed buy").why, /op:0x[0-9a-f]{64} \(a buy of 100000000000000000000 at .*\) leaves -100000000000000000000: the fills Postgres records and the ones this plan would book are more than the chain holds/);
  });

  /**
   * A ROUND TRIP NO QUANTITY CAN SEE (review of #293). On a held token, a
   * missed buy of 50 for 200 USDG and a missed sell of the same 50 for 50, between
   * a recorded buy of 100 and a recorded buy of 20 that rewrote both rows. The
   * chain, the position and the basis all hold 120, and the fills walk back
   * from 120 to flat — yet a basis that left the round trip out costs 120 USDG,
   * where one that holds it costs 220, and the stop-loss and take-profit would
   * measure from 1.00 a unit instead of about 1.83. As Shogun's own Trencher
   * lot shows, a sell of exactly the lot bought is ordinary.
   */
  it("a missed buy and sell of the same amount on a held token, a later buy rewriting both rows: every quantity agrees, and it books only when the basis's cost is what the fills give", async () => {
    const roundTrip = [swap({ tag: "missed buy", side: "buy", qty: 50n * E18, cash: 200_000_000n, block: MISSED }),
      swap({ tag: "missed sell", side: "sell", qty: 50n * E18, cash: 50_000_000n, block: MISSED + 100n })];
    const run = async (o: { cash: boolean; cost: bigint }) => {
      const b = await books();
      recorded(b, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0, ...(o.cash ? { cash: 100_000_000n } : {}) });
      recorded(b, { tag: "later buy", side: "buy", qty: 20n * E18, at: T2, ...(o.cash ? { cash: 20_000_000n } : {}) });
      mirrored(b, { raw: 120n * E18, basisQty: 120n * E18, cost: o.cost, at: T2 });
      return plan(b, roundTrip, { balance: 120n * E18 });
    };
    // No cash on record: the cost cannot be replayed, and a held token needs it.
    const unreplayed = await run({ cash: false, cost: 120_000_000n });
    assert.equal(unreplayed.verdict, "blocked", planLines(unreplayed).join("\n"));
    const h = holdingOf(unreplayed, "missed buy");
    // The quantity reproduces exactly, and both rows were written after the round trip: neither says the basis holds it.
    assert.deepEqual([h.fills.verdict, h.cost.verdict, h.refusal], ["reproduced", "unproven", "cost-unproven"]);
    assert.match(trade(unreplayed, "missed sell").why,
      /^not booked \(cost-unproven\): Postgres's live cost basis for TKN holds the chain's 120000000000000000000 base units .* \(trades#\d+ records no exact cash for its buy/);
    assert.equal(unreplayed.items.filter((i) => i.proposal).length, 0, "neither trade, nor a leg");
    // The cost on record: 100 at 100, +50 at 200 → 150 at 300, −50 takes a third → 100 at 200, +20 at 20 → 120 at 220. A basis at 120 left it out.
    const wrong = await run({ cash: true, cost: 120_000_000n });
    assert.equal(wrong.verdict, "blocked");
    assert.equal(holdingOf(wrong, "missed buy").refusal, "basis-cost-differs");
    assert.match(trade(wrong, "missed buy").why, new RegExp("^not booked \\(basis-cost-differs\\): Postgres's live cost basis for TKN holds 120000000000000000000 base " +
      "units at a cost of 120\\.000000 USDG, and the fills since it last opened \\(before every fill Postgres records in the token\\), with the trades booked here, " +
      "give 120000000000000000000 at 220\\.000000 USDG"));
    // A basis that holds the round trip books: both trades, and their legs.
    const right = await run({ cash: true, cost: 220_000_000n });
    assert.equal(right.verdict, "ready", planLines(right).join("\n"));
    assert.deepEqual(holdingOf(right, "missed sell").cost, { verdict: "replayed", why: null, basis: { qtyRaw: (120n * E18).toString(), costUsdg: "220000000" } });
  });

  it("three missed fills with a round trip among them, though they net to a buy: refused without the cost to prove the basis holds them", async () => {
    const b = await books();
    recorded(b, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0 });
    recorded(b, { tag: "later buy", side: "buy", qty: 20n * E18, at: T2 });
    // The basis holds the first buy, the missed buy of 30 and the later buy — not the round trip of 50.
    mirrored(b, { raw: 150n * E18, basisQty: 150n * E18, cost: 150_000_000n, at: T2 });
    const p = await plan(b, [swap({ tag: "missed buy", side: "buy", qty: 50n * E18, cash: 200_000_000n, block: MISSED }),
      swap({ tag: "missed sell", side: "sell", qty: 50n * E18, cash: 50_000_000n, block: MISSED + 100n }),
      swap({ tag: "missed buy 30", side: "buy", qty: 30n * E18, cash: 30_000_000n, block: MISSED + 150n })], { balance: 150n * E18 });
    assert.equal(p.verdict, "blocked", planLines(p).join("\n"));
    assert.deepEqual(["missed buy", "missed sell", "missed buy 30"].map((t) => [trade(p, t).class, holdingOf(p, t).fills.verdict, holdingOf(p, t).refusal]),
      Array(3).fill(["unresolved", "reproduced", "cost-unproven"]));
    assert.equal(p.items.filter((i) => i.proposal).length, 0);
  });

  /**
   * ONE WAY HERE, THE OTHER IN POSTGRES (review of #293). The quantity checks
   * cannot prove the cost even when every trade booked here goes one way: the
   * other leg of a round trip can be a fill Postgres records that the basis
   * never had (the reconciler's row for a token it did not watch, filled in
   * later by the history repair; or a stale mirrored basis). A recorded buy
   * of 100 with no cash on record, a recorded sell of 50 for 60 that the
   * basis never had, the missed buy of 50 for 500, and a recorded buy of 10
   * for 10 that rewrote both rows: the chain, the position and the basis all
   * hold 110, the walk reproduces it from flat, and the basis costs 110 USDG
   * where one holding every fill (the first buy at 100) costs 560. The stop-
   * loss and take-profit would measure from about 1.0 a unit instead of 5.1.
   */
  it("a missed buy offset by a recorded sell the basis never had: every quantity agrees, and it books only on a cost replayed and equal", async () => {
    const missed = swap({ tag: "missed buy", side: "buy", qty: 50n * E18, cash: 500_000_000n, block: MISSED });
    const run = async (o: { firstCash: boolean; cost: bigint }) => {
      const b = await books();
      recorded(b, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0, ...(o.firstCash ? { cash: 100_000_000n } : {}) });
      recorded(b, { tag: "unbooked sell", side: "sell", qty: 50n * E18, at: T0 + 50, cash: 60_000_000n });
      recorded(b, { tag: "later buy", side: "buy", qty: 10n * E18, at: T2, cash: 10_000_000n });
      mirrored(b, { raw: 110n * E18, basisQty: 110n * E18, cost: o.cost, at: T2 });
      return plan(b, missed, { balance: 110n * E18 });
    };
    // The first buy's cash not on record: before, this booked on the quantities with a note. Now the cost is unproven, and it refuses.
    const unreplayed = await run({ firstCash: false, cost: 110_000_000n });
    assert.equal(unreplayed.verdict, "blocked", planLines(unreplayed).join("\n"));
    const h = trade(unreplayed, "missed buy").evidence.holding as { refusal: string; fills: { verdict: string; anchor: string };
      position: { updatedAt: number }; basis: { updatedAt: number } };
    assert.ok(h.position.updatedAt > MISSED_AT && h.basis.updatedAt > MISSED_AT, "both rows were written after the missed buy");
    assert.deepEqual([h.fills.verdict, h.fills.anchor, h.refusal], ["reproduced", "before every fill Postgres records in the token", "cost-unproven"]);
    assert.equal(trade(unreplayed, "missed buy").class, "unresolved");
    assert.deepEqual(unreplayed.items.filter((i) => i.proposal), [], "neither the trade nor its leg");
    assert.deepEqual(unreplayed.warnings, []);
    // The cash on record: 100 at 100, −50 takes half → 50 at 50, +50 at 500 → 100 at 550, +10 at 10 → 110 at 560. A basis at 110 left the sell out.
    const wrong = await run({ firstCash: true, cost: 110_000_000n });
    assert.equal(wrong.verdict, "blocked");
    assert.equal(holdingOf(wrong, "missed buy").refusal, "basis-cost-differs");
    assert.match(trade(wrong, "missed buy").why, /at a cost of 110\.000000 USDG, and the fills since it last opened .* give 110000000000000000000 at 560\.000000 USDG/);
    // A basis built from every fill books.
    const right = await run({ firstCash: true, cost: 560_000_000n });
    assert.equal(right.verdict, "ready", planLines(right).join("\n"));
    assert.deepEqual(holdingOf(right, "missed buy").cost.basis, { qtyRaw: (110n * E18).toString(), costUsdg: "560000000" });
  });

  it("holdingVerdict over the same history, read directly: a held token whose cost cannot be replayed refuses, whichever way the trades booked here go", () => {
    const fill = (id: number, side: "buy" | "sell", qty: bigint, at: number, cashUsdg: string | null): RecordedFill => ({ id, status: "landed",
      buyToken: side === "buy" ? TOKEN : USDG, sellToken: side === "buy" ? USDG : TOKEN, side, qtyRaw: qty.toString(), symbol: "TKN", basisSource: "receipt", at, cashUsdg });
    const fills = [fill(1, "buy", 100n * E18, 1000, null), fill(2, "sell", 50n * E18, 2000, "60000000"), fill(3, "buy", 10n * E18, 3100, "10000000")];
    const holdings = { positions: [{ symbol: "TKN", token: TOKEN, rawBalance: (110n * E18).toString(), updatedAt: 3200 }],
      basis: [{ agentId: ACCOUNT, symbol: "TKN", qtyRaw: (110n * E18).toString(), costUsdg: "110000000", updatedAt: 3100 }],
      seeded: [{ symbol: "TKN", qtyRaw: (110n * E18).toString(), costUsdg: "110000000" }] };
    const balance = { total: (110n * E18).toString(), by: { [ACCOUNT]: (110n * E18).toString() } };
    const v = holdingVerdict({ token: TOKEN, holdings, fills, balance, classVault: null, grantSpelling: ACCOUNT,
      proposed: [{ key: "op:m", side: "buy", qtyRaw: (50n * E18).toString(), cashUsdg: "500000000", at: 3000, symbol: "TKN" }] });
    assert.equal(v.refusal, "cost-unproven");
    assert.match(v.why!, /trades#1 records no exact cash for its buy/);
    assert.deepEqual(v.notes, []);
    // A sell booked here over a buy Postgres records and the basis never had: the same hole the other way, and the same refusal.
    const sold = holdingVerdict({ token: TOKEN, classVault: null, grantSpelling: ACCOUNT,
      balance: { total: (100n * E18).toString(), by: { [ACCOUNT]: (100n * E18).toString() } },
      fills: [fill(1, "buy", 100n * E18, 1000, null), fill(2, "buy", 40n * E18, 2000, "400000000")],
      holdings: { positions: [{ symbol: "TKN", token: TOKEN, rawBalance: (100n * E18).toString(), updatedAt: 3200 }],
        basis: [{ agentId: ACCOUNT, symbol: "TKN", qtyRaw: (100n * E18).toString(), costUsdg: "100000000", updatedAt: 3100 }],
        seeded: [{ symbol: "TKN", qtyRaw: (100n * E18).toString(), costUsdg: "100000000" }] },
      proposed: [{ key: "op:s", side: "sell", qtyRaw: (40n * E18).toString(), cashUsdg: "30000000", at: 3000, symbol: "TKN" }] });
    assert.deepEqual([sold.refusal, sold.notes], ["cost-unproven", []]);
  });

  it("trades all one way: a basis of the chain's quantity at a cost the fills disprove refuses", async () => {
    // A missed buy of 100 for 100 USDG, then a recorded buy of 50 for 60: a basis built from both costs 160.
    const missed = swap({ tag: "missed buy", side: "buy", qty: 100n * E18, cash: 100_000_000n, block: MISSED });
    const run = async (cost: bigint) => {
      const b = await books();
      recorded(b, { tag: "later buy", side: "buy", qty: 50n * E18, at: T2, cash: 60_000_000n });
      mirrored(b, { raw: 150n * E18, basisQty: 150n * E18, cost, at: T2 });
      return plan(b, missed, { balance: 150n * E18 });
    };
    const right = await run(160_000_000n);
    assert.equal(right.verdict, "ready", planLines(right).join("\n"));
    assert.deepEqual([holdingOf(right, "missed buy").cost.verdict, holdingOf(right, "missed buy").cost.basis?.costUsdg], ["replayed", "160000000"]);
    assert.ok(!right.warnings.some((w) => /was not checked/.test(w)), right.warnings.join("\n"));
    const wrong = await run(150_000_000n);
    assert.equal(wrong.verdict, "blocked");
    assert.equal(holdingOf(wrong, "missed buy").refusal, "basis-cost-differs");
  });

  it("a held token whose history holds the reconciler's row, which carries no fill, refuses as unproven; a token nobody holds books over the same history, with a note", async () => {
    // A buy of 100, the reconciler's row for a lost buy of 40 (written at the arm an hour later, no fill), a buy of 10; and the missed sell of 40
    // between them. Position, basis and chain all hold 110 — and the basis never had the sell.
    const missed = swap({ tag: "missed sell", side: "sell", qty: 40n * E18, cash: 30_000_000n, block: MISSED });
    const b = await books();
    recorded(b, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0 });
    reconciled(b, { tag: "reconciled buy", side: "buy", at: T2 + 3600 });
    recorded(b, { tag: "later buy", side: "buy", qty: 10n * E18, at: T2 });
    mirrored(b, { raw: 110n * E18, basisQty: 110n * E18, at: T2 });
    const p = await plan(b, missed, { balance: 110n * E18 });
    assert.equal(p.verdict, "blocked", planLines(p).join("\n"));
    assert.deepEqual([holdingOf(p, "missed sell").fills.verdict, holdingOf(p, "missed sell").refusal], ["unproven", "fills-unproven"]);
    assert.match(trade(p, "missed sell").why, new RegExp("^not booked \\(fills-unproven\\): the fills Postgres records in 0x0+70c3 could not be walked back to where " +
      "its basis opened \\(trade #\\d+ in 0x0+70c3 records no fill \\(side and quantity\\)\\)"));
    // The same history, all of it sold by the missed sell: nothing is held or seeded, so what it cost cannot reach the new book.
    const out = await books();
    recorded(out, { tag: "first buy", side: "buy", qty: 100n * E18, at: T0 });
    reconciled(out, { tag: "reconciled buy", side: "buy", at: T2 + 3600 });
    const flat = await plan(out, swap({ tag: "missed exit", side: "sell", qty: 140n * E18, cash: 150_000_000n, block: MISSED }));
    assert.equal(flat.verdict, "ready", planLines(flat).join("\n"));
    assert.deepEqual([holdingOf(flat, "missed exit").fills.verdict, holdingOf(flat, "missed exit").refusal], ["unproven", null]);
    assert.ok(flat.warnings.some((w) => /0x0+70c3: none of it is held, on chain or in the snapshot/.test(w)), flat.warnings.join("\n"));
  });

  it("a reconciler's row the history repair filled in is read at the arm's time, out of order: a flat round trip across it refuses rather than books", async () => {
    // The reconciler's buy of 100 landed before the missed sell of 100, but its row was written at the arm an hour after the sell, and the history
    // repair (history-fill-repair.ts) later filled in its fill off the receipt, keeping 'receipt'. Nothing is held on chain or in the snapshot.
    const b = await books();
    reconciled(b, { tag: "reconciled buy", side: "buy", at: MISSED_AT + 3600 });
    b.raw.prepare("UPDATE trades SET fill_side = 'buy', fill_symbol = 'TKN', fill_qty_raw = ?, fill_cash_usdg = 100 WHERE user_op_hash = ?")
      .run((100n * E18).toString(), h32("reconciled buy"));
    const p = await plan(b, swap({ tag: "missed sell", side: "sell", qty: 100n * E18, cash: 101_000_000n, block: MISSED }));
    assert.equal(p.verdict, "blocked", planLines(p).join("\n"));
    assert.deepEqual([trade(p, "missed sell").class, holdingOf(p, "missed sell").fills.verdict, holdingOf(p, "missed sell").refusal],
      ["unresolved", "exceeds", "fills-exceed-chain"]);
    assert.match(trade(p, "missed sell").why, /trades#\d+ \(a buy of 100000000000000000000 at .*\) leaves -100000000000000000000/);
  });

  it("microUsdg: fill_cash_usdg back exactly as written, or not at all", () => {
    assert.deepEqual([4.965021, 5, 0.5, "12.25", 0, 123456789.123456].map(microUsdg), ["4965021", "5000000", "500000", "12250000", "0", "123456789123456"]);
    for (const v of [null, undefined, "", -1, 1e-7, 1.2345678, Number.NaN, Number.POSITIVE_INFINITY, 1234567890.123456, "1e3", "abc"]) {
      assert.equal(microUsdg(v), null, String(v));
    }
  });

  it("walkFills: back to where the basis opened, and no further; an unreadable record says so rather than guess", () => {
    const fill = (id: number, side: string | null, qty: string | null, at: number, extra: Partial<RecordedFill> = {}): RecordedFill => ({
      id, status: "landed", buyToken: side === "buy" ? TOKEN : USDG, sellToken: side === "buy" ? USDG : TOKEN, side, qtyRaw: qty, symbol: "TKN", basisSource: "receipt", at,
      cashUsdg: null, ...extra });
    const proposed = [{ key: "op:p", side: "buy" as const, qtyRaw: "3", cashUsdg: "6", at: 50, symbol: null }];
    const walk = (fills: RecordedFill[], total: bigint) => walkFills({ token: TOKEN, fills, proposed, symbols: new Set(["TKN"]), total });
    // Flat after #3: #1 (no fill, from before) is never read.
    const history = [fill(1, null, null, 10), fill(2, "buy", "5", 20), fill(3, "sell", "5", 30), fill(4, "buy", "7", 40)];
    const ok = walk(history, 10n);
    assert.deepEqual([ok.verdict, ok.anchor, ok.walked.map((w) => [w.ref, w.heldBefore])], ["reproduced", "after trades#3", [["op:p", "7"], ["trades#4", "0"]]]);
    // Another token's row is not this one's, however large.
    assert.equal(walk([...history, fill(5, "buy", "999", 45, { buyToken: addr(0xabc), symbol: "OTHER" })], 10n).verdict, "reproduced");
    // A fill read from a quote, a row still in flight, and records that run out holding some: the walk cannot say.
    for (const [extra, why] of [[{ basisSource: "quote" }, /trade #4's fill is from its quote, not read off its receipt/],
      [{ status: "submitted" }, /trade #4 in 0x0+70c3 is still 'submitted'/]] as const) {
      const w = walk([...history.slice(0, 3), fill(4, "buy", "7", 40, extra)], 10n);
      assert.equal(w.verdict, "unproven");
      assert.match(w.why!, why);
    }
    const short = walk([fill(4, "buy", "7", 40)], 12n);
    assert.deepEqual([short.verdict, short.anchor], ["unproven", null]);
    assert.match(short.why!, /the book still held 2 base units before the first of them/);
    // More than the chain holds: a buy bigger than what was held after it.
    assert.equal(walk(history, 5n).verdict, "exceeds");

    // REPRODUCED IS A QUANTITY. The cost is replayed forward from where the walk stopped, as applyFill books it: #4 bought 7 for 70 and the
    // proposal 3 for 6 → 10 at 76; and through a sell, which takes cost pro rata: 5 for 50, −2 takes 20 → 3 at 30, +3 for 6 → 6 at 36.
    assert.deepEqual(replayBasis(walk([...history.slice(0, 3), fill(4, "buy", "7", 40, { cashUsdg: "70" })], 10n)),
      { verdict: "replayed", why: null, basis: { qtyRaw: "10", costUsdg: "76" } });
    assert.deepEqual(replayBasis(walk([fill(2, "buy", "5", 20, { cashUsdg: "50" }), fill(3, "sell", "2", 30, { cashUsdg: "1" })], 6n)),
      { verdict: "replayed", why: null, basis: { qtyRaw: "6", costUsdg: "36" } });
    // What a sell was paid never reaches the basis, so a sell with no cash on record replays the same.
    assert.deepEqual(replayBasis(walk([fill(2, "buy", "5", 20, { cashUsdg: "50" }), fill(3, "sell", "2", 30)], 6n)).basis, { qtyRaw: "6", costUsdg: "36" });
    // A walked row with no exact cash, or a walk that did not reproduce, replays nothing.
    assert.deepEqual(replayBasis(ok), { verdict: "unproven", basis: null,
      why: "trades#4 records no exact cash for its buy (fill_cash_usdg), so what it added to the basis's cost is not on the books" });
    assert.deepEqual([replayBasis(short).verdict, replayBasis(walk(history, 5n)).verdict], ["unproven", "unproven"]);
  });
});

/**
 * SHOGUN'S TSLA, AS THE PRODUCTION PREVIEW OF 2026-10-07 FOUND IT (epoch 1,
 * live): a permission-validator Trencher buy of TSLA that Postgres never
 * recorded (op 0x73578ec3… in tx 0xdb99af5b…, block 63838886, 8.332500 USDG
 * out to 0xc4f0172d… at log 13, 23387133169451971 base units in); trade
 * #94285, the other buy, recorded with no fill; trade #101069, one sell of
 * both lots together (46757368332762768, the two buys exactly) for 17.250862
 * USDG; and a live cost basis still covering the other buy's lot at 8.332500
 * USDG, written after that sell. The chain holds none of TSLA at any address
 * of the book (the account, the Trencher vault and the class vault), and
 * positions hold none. The preview printed hashes and addresses by their
 * first bytes: the rest of each is synthetic here, as is #94285's time; the
 * amounts, ids, blocks and the other times are its own.
 */
describe("Shogun's TSLA: a basis left over a flat token (staleBasisVerdict)", () => {
  const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";
  const prefixed = (prefix: string, tag: string, bytes = 32) => `${prefix}${h32(tag).slice(prefix.length, 2 + bytes * 2)}`;
  const TSLA_OP = prefixed("0x73578ec3", "tsla op"), TSLA_TX = prefixed("0xdb99af5b", "tsla tx");
  const TSLA_POOL = prefixed("0xc4f0172d", "tsla pool", 20), SHOGUN_CLASS = prefixed("0x3fcdde6e", "shogun class vault", 20);
  const TSLA_BLOCK = 63_838_886n, TSLA_AT = 1_789_493_909;
  const MISSED = 23_387_133_169_451_971n, OTHER = 23_370_235_163_310_797n, SOLD = 46_757_368_332_762_768n, CASH = 8_332_500n;
  const OTHER_AT = TSLA_AT + 3_600, SOLD_AT = 1_789_978_946, BASIS_AT = 1_790_028_733;
  const PAYMASTER = "0x777777777777aec03fd955926dbf81597e66834c";
  /** The buy Postgres lacks: the account's USDG out to the pool at log 13, TSLA into the Trencher vault, sponsored. */
  const missedBuy: ModelTx = { tx: TSLA_TX, block: TSLA_BLOCK, blockHash: h32("tsla block"), timestamp: TSLA_AT, from: addr(0x4337), to: EP, logs: [
    [EP, [BEFORE], "0x", "0xb"],
    [USDG, [TR, topic(ACCOUNT), topic(TSLA_POOL)], `0x${word(CASH)}`, "0xd"],
    [TSLA, [TR, topic(TSLA_POOL), topic(VAULT)], `0x${word(MISSED)}`, "0xe"],
    [EP, [UOE, TSLA_OP, topic(ACCOUNT), topic(PAYMASTER)], `0x${word(SESSION_NONCE)}${word(1n)}${word(52_000_000_000_000n)}${word(410_000n)}`, "0xf"],
  ] };
  /** Shogun's Postgres for TSLA as the preview read it, held on admission's chain refusal of the missed buy. `spelled`: how the grant spells the account. */
  async function shogun(o: { spelled?: string } = {}) {
    const b = await books({ refused: false, knownBuy: false, classVault: SHOGUN_CLASS });
    if (o.spelled) {
      const g = JSON.parse(String((b.raw.prepare("SELECT grant_json FROM grants").get() as { grant_json: string }).grant_json)) as Record<string, unknown>;
      b.raw.prepare("UPDATE grants SET grant_json = ?").run(JSON.stringify({ ...g, smartAccount: o.spelled }));
    }
    // Its own epoch 1, opened by its first deposit long before the buy.
    b.raw.prepare("UPDATE agents SET epoch = 1 WHERE smart_account = ?").run(ACCOUNT);
    b.raw.prepare("UPDATE flows SET epoch = 1, at = ? WHERE agent_id = ?").run(TSLA_AT - 30 * 86_400, ACCOUNT);
    b.raw.prepare("UPDATE equity SET epoch = 1 WHERE agent_id = ?").run(ACCOUNT);
    // Trade #94285: the other buy, its legs and no fill.
    b.raw.prepare(`INSERT INTO trades (id, agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch, basis_source)
      VALUES (94285, ?, 'swap', ?, ?, ?, 8.3325, ?, ?, 'landed', ?, 1, 'receipt')`).run(ACCOUNT, ACCOUNT, USDG, TSLA, h32("the other buy"), h32("the other buy tx"), OTHER_AT);
    // Trade #101069: one sell of both lots.
    b.raw.prepare(`INSERT INTO trades (id, agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch,
        fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, basis_source) VALUES (101069, ?, 'swap', ?, ?, ?, 17.250862, ?, ?, 'landed', ?, 1, 'sell', 'TSLA', ?, 17.250862, 'receipt')`)
      .run(ACCOUNT, ACCOUNT, TSLA, USDG, h32("the sell"), h32("the sell tx"), SOLD_AT, SOLD.toString());
    // The live basis: the other buy's lot, at what a lot cost, written after the sell that took both.
    b.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'TSLA', ?, ?, ?)").run(ACCOUNT, OTHER.toString(), CASH.toString(), BASIS_AT);
    refuse(b.raw, { tenant: b.tenant, account: b.account, readFromSec: TSLA_AT - 86_400,
      reason: `${CHAIN_REFUSAL}: operation ${TSLA_OP} in tx ${TSLA_TX} at block ${TSLA_BLOCK}; USDG out 8.332500 in tx ${TSLA_TX} log 13 at block ${TSLA_BLOCK}` });
    return b;
  }
  const shogunPlan = (b: Books, o: { balances?: Record<string, Record<string, bigint>>; failBalances?: string[] } = {}) =>
    preview(b, fakeRpc({ txs: [missedBuy], decimals: { [TSLA]: 18n }, ...o }).rpc);
  const buy = (p: BookingPlan) => p.items.find((i) => i.key === `op:${TSLA_OP}`)!;
  const leg = (p: BookingPlan) => p.items.find((i) => i.key === `log:${TSLA_TX}#13`)!;
  type Holding = { refusal: string | null; bookBalance: unknown; fills: { verdict: string; why: string | null }; staleBasis?: StaleBasis["evidence"] };
  const holdingOf = (p: BookingPlan) => buy(p).evidence.holding as Holding;
  const position = (b: Books, token: string, raw: string) =>
    b.raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
      VALUES (?, 'TSLA', ?, ?, '1', 400, 0, 'chainlink', 0, ?)`).run(ACCOUNT, token, raw, BASIS_AT);

  it("the preview's own shape: one trades row for the missed buy, its USDG leg covered, and the basis named — neither booked nor changed", async () => {
    assert.equal(MISSED + OTHER, SOLD, "the sell took both lots exactly");
    const b = await shogun();
    const model = fakeRpc({ txs: [missedBuy], decimals: { [TSLA]: 18n } });
    const before = await admissionSays(b, model.rpc);
    assert.deepEqual([before.status, (before as { ops: number }).ops, (before as { transfers: number }).transfers], ["missing", 1, 1], "the preview's line: 1 op + 1 transfer");
    const p = await preview(b, model.rpc);
    assert.equal(p.verdict, "ready", planLines(p).join("\n"));
    assert.deepEqual(p.items.map((i) => [i.key, i.class]).sort(), [[`log:${TSLA_TX}#13`, "operation-leg"], [`op:${TSLA_OP}`, "session-trade"]]);
    assert.equal(leg(p).coveredBy, `op:${TSLA_OP}`);
    assert.equal(p.items.filter((i) => i.proposal).length, 1, "one trades row");
    assert.deepEqual(p.remaining, []);
    assert.equal(buy(p).proposal!.table, "trades");
    const row = buy(p).proposal!.row as unknown as Record<string, unknown>;
    assert.deepEqual([row.agent_id, row.fill_side, row.sell_token, row.buy_token, row.amount_usdg, row.fill_qty_raw, row.fill_symbol,
      row.fill_cash_usdg, row.realized_pnl_usdg, row.basis_source, row.status, row.epoch, row.created_at, row.gas_wei, row.sponsored_gas_wei],
    [ACCOUNT, "buy", USDG, TSLA, 8.3325, MISSED.toString(), "TSLA", 8.3325, null, "receipt", "landed", 1, TSLA_AT, null, "52000000000000"]);
    assert.equal(buy(p).evidence.validator, "permission");
    const holding = holdingOf(p);
    assert.equal(holding.refusal, null);
    assert.deepEqual(holding.bookBalance, { total: "0", by: { [ACCOUNT]: "0", [SHOGUN_CLASS]: "0", [VAULT]: "0" } }, "every address of the book, the class vault's among them");
    assert.equal(holding.fills.verdict, "unproven");
    assert.match(holding.fills.why!, /trade #94285 in 0x322f0929\S* records no fill \(side and quantity\)/);
    // THE STALE BASIS, IN THE EVIDENCE (so in the digest), with what was checked and the note.
    const stale = holding.staleBasis!;
    assert.deepEqual(stale.rows, [{ agentId: ACCOUNT, symbol: "TSLA", qtyRaw: OTHER.toString(), costUsdg: CASH.toString(), updatedAt: BASIS_AT }]);
    assert.deepEqual([stale.names, stale.heldUnderNames, stale.seededUnderNames, stale.positionsUnderNames, stale.deletedAs], [["TSLA"], [], [], [], ACCOUNT]);
    assert.match(stale.note!, new RegExp(`^${TSLA}: Postgres's live cost basis under TSLA \\(23370235163310797 base units at 8\\.332500 USDG, written \\S+\\) ` +
      "is left over a token the book does not hold: the chain held none of it at the pinned block at any address of the book, and no position under TSLA is held\\. " +
      "It is not booked here and not changed\\. It cannot reach the attested book: admission seeds a basis only for a symbol positions shows held, and its own " +
      `seed, asked on this read \\(planAttestedSeed\\), carries none of it; and the first mirror pass after the new book's worker arms deletes every cost_basis ` +
      `row spelled ${ACCOUNT}, as this one is, keeping only the new book's own .* Until then it is read only as it is today, and acts on nothing: no page ` +
      "that values a holding shows it, since each joins basis to a positions row under its name and there is none; and the owner's report export lists it, " +
      "as not valued, only while the agent's newest equity mark is paper$"));
    assert.ok(p.warnings.includes(stale.note!), "and said at the console");
    assert.ok(planLines(p).some((l) => l === `  note: ${stale.note}`));
    assert.ok(p.warnings.some((w) => new RegExp(`^${TSLA}: none of it is held, on chain or in the snapshot, .*trade #94285 .* records no fill`).test(w)), p.warnings.join("\n"));
    // The digest binds the basis as it was read: the same books preview the same; a basis a micro-USDG away does not.
    assert.equal((await preview(b, model.rpc, NOW + 600)).previewDigest, p.previewDigest);
    const moved = await shogun();
    moved.raw.prepare("UPDATE cost_basis SET cost_usdg = '8332501'").run();
    assert.notEqual((await preview(moved, model.rpc)).previewDigest, p.previewDigest);

    // APPLIED: exactly the trade, and the basis and positions as they were.
    const report = await applyNow(b.db, p);
    assert.deepEqual(report.rows.map((r) => [r.table, r.evidenceKey]), [["trades", `op:${TSLA_OP}`]]);
    assert.deepEqual(rows(b.raw, "SELECT agent_id, mode, symbol, qty_raw, cost_usdg, updated_at FROM cost_basis"),
      [{ agent_id: ACCOUNT, mode: "live", symbol: "TSLA", qty_raw: OTHER.toString(), cost_usdg: CASH.toString(), updated_at: BASIS_AT }]);
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM positions")[0]!.n, 0);
    assert.equal((await admissionSays(b, model.rpc)).status, "clean", "admission's chain check now finds the buy and its leg");
  });

  it("refused, the tenant held: a held position under TSLA, any TSLA on chain, an unread balance, a basis spelled otherwise than the grant, or fills more than the chain holds", async () => {
    const cases: Array<[string, (b: Books) => void, Parameters<typeof shogunPlan>[1], string, RegExp, { spelled?: string }?]> = [
      ["another token held under TSLA", (b) => position(b, addr(0x7e57a), "5"), {}, "basis-without-position",
        new RegExp(`yet its live cost basis under TSLA still covers ${OTHER}: Postgres's positions hold TSLA \\(0x0+7e57a\\) at 5, under a name ${TSLA} has gone by: ` +
          "admission seeds a basis for every symbol positions shows held \\(planAttestedSeed\\)")],
      ["TSLA itself held in positions", (b) => position(b, TSLA, "7"), {}, "position-differs", /position in TSLA \(0x322f.*\) holds 7 base units, and the book held 0/],
      ["TSLA in the Trencher vault", () => {}, { balances: { [TSLA]: { [VAULT]: 1n } } }, "held-unrecorded", /the book held 1 base units of 0x322f.* on chain/],
      ["TSLA in the account", () => {}, { balances: { [TSLA]: { [ACCOUNT]: 1n } } }, "held-unrecorded", /the book held 1 base units of 0x322f.* on chain/],
      ["TSLA in the class vault", () => {}, { balances: { [TSLA]: { [SHOGUN_CLASS]: 1n } } }, "class-vault-held", /Pons class vault 0x3fcdde6e\S* held 1 base units/],
      ["the balance unread", () => {}, { failBalances: [TSLA] }, "balance-unread", /balance of 0x322f.* at the pinned block could not be read/],
      ["the grant spelling the account otherwise", () => {}, {}, "basis-without-position",
        new RegExp(`the row under TSLA is spelled ${ACCOUNT}, not as the grant spells the account \\(0x05A198A677FBCD8F5C168D397FA7EF5EB6D65487\\): the new book's ` +
          "first mirror pass deletes the tenant's cost_basis by the grant's spelling exactly \\(ledger-mirror\\.ts\\), so it would outlive admission"),
        { spelled: "0x05A198A677FBCD8F5C168D397FA7EF5EB6D65487" }],
      // A buy Postgres records after the sell, with nothing on chain to show for it: walking back from 0 it leaves less than nothing.
      ["fills more than the chain holds", (b) => b.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status,
          created_at, epoch, fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, basis_source) VALUES (?, 'swap', ?, ?, ?, 1, ?, ?, 'landed', ?, 1, 'buy', 'TSLA', '1000', 1,
          'receipt')`).run(ACCOUNT, ACCOUNT, USDG, TSLA, h32("a later buy"), h32("a later buy tx"), SOLD_AT + 60), {}, "fills-exceed-chain", /leaves -1000: the fills Postgres records/],
    ];
    for (const [what, setup, chain, refusal, pattern, o] of cases) {
      const b = await shogun(o ?? {});
      setup(b);
      const p = await shogunPlan(b, chain);
      assert.equal(p.verdict, "blocked", what);
      assert.equal(buy(p).class, "unresolved", what);
      assert.equal(buy(p).proposal, null, what);
      assert.equal(holdingOf(p).refusal, refusal, what);
      assert.match(buy(p).why, pattern, what);
      assert.equal(leg(p).class, "unresolved", `${what}: its leg waits on it`);
      assert.equal(p.items.filter((i) => i.proposal).length, 0, what);
      assert.ok(!p.warnings.some((w) => /is left over a token the book does not hold/.test(w)), `${what}: no note passes it over`);
    }
    // The seed's own code says the same: with another token held under TSLA, planAttestedSeed would carry this basis into the new book.
    const other = await shogun();
    position(other, addr(0x7e57a), "5");
    const seeded = holdingOf(await shogunPlan(other)).staleBasis!;
    assert.deepEqual(seeded.seededUnderNames, [{ symbol: "TSLA", qtyRaw: OTHER.toString(), costUsdg: CASH.toString() }]);
    assert.deepEqual(seeded.heldUnderNames.map((p) => [p.symbol, p.token, p.rawBalance]), [["TSLA", addr(0x7e57a), "5"]]);
    // And with the walk going below zero, the basis passed its own checks: named in the evidence, the refusal the walk's.
    const exceeds = await shogun();
    cases[cases.length - 1]![1](exceeds);
    const ex = holdingOf(await shogunPlan(exceeds));
    assert.deepEqual([ex.refusal, ex.staleBasis?.note === null], ["fills-exceed-chain", false]);
  });

  it("a positions row under TSLA that holds 0 is not held, as the seed reads it: the trade books, and the note says the dashboard shows the cost beside it until the first mirror pass", async () => {
    for (const token of [TSLA, addr(0x7e57a)]) {
      const b = await shogun();
      position(b, token, "0");
      const p = await shogunPlan(b);
      assert.equal(p.verdict, "ready", `${token}: ${planLines(p).join("\n")}`);
      const stale = holdingOf(p).staleBasis!;
      assert.deepEqual([stale.heldUnderNames, stale.seededUnderNames, stale.positionsUnderNames.map((x) => [x.token, x.rawBalance])], [[], [], [[token, "0"]]], token);
      assert.match(stale.note!, /acts on nothing: the dashboard shows this cost beside the positions row\(s\) under TSLA that hold 0; and the owner's report export/, token);
    }
  });

  it("the basis named in the preview is compared again by the apply: changed, re-spelled, gone, or a position under its name since, the apply refuses and writes nothing", async () => {
    const changes: Array<[string, (b: Books) => void, RegExp?]> = [
      ["its cost", (b) => b.raw.prepare("UPDATE cost_basis SET cost_usdg = '8332501'").run()],
      ["its quantity", (b) => b.raw.prepare("UPDATE cost_basis SET qty_raw = ?").run((OTHER + 1n).toString())],
      ["its time", (b) => b.raw.prepare("UPDATE cost_basis SET updated_at = updated_at + 1").run()],
      // A second spelling across the financial tables is the first fact to differ.
      ["re-spelled", (b) => b.raw.prepare("UPDATE cost_basis SET agent_id = ?").run(ACCOUNT.toUpperCase().replace(/^0X/, "0x")), /\(spellings\)/],
      ["deleted", (b) => b.raw.prepare("DELETE FROM cost_basis").run()],
      ["a positions row under its name", (b) => position(b, addr(0x7e57a), "0")],
    ];
    for (const [what, change, field] of changes) {
      const b = await shogun();
      const p = await shogunPlan(b);
      assert.equal(p.verdict, "ready", what);
      change(b);
      await assert.rejects(applyNow(b.db, p), (e: unknown) => (e as BookingRefused).code === "cas" && (field ?? /\(holdings\)/).test((e as Error).message), what);
      assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = ?", TSLA_OP)[0]!.n, 0, what);
    }
  });

  it("staleBasisVerdict read directly: each check refuses on its own, and none is needed where no basis is left", () => {
    const basis = [{ agentId: ACCOUNT, symbol: "TSLA", qtyRaw: OTHER.toString(), costUsdg: CASH.toString(), updatedAt: BASIS_AT }];
    const zero = { total: "0", by: { [ACCOUNT]: "0", [SHOGUN_CLASS]: "0", [VAULT]: "0" } };
    const v = (o: { holdings?: Partial<Holdings>; balance?: typeof zero; classVault?: string | null; spelled?: string | null } = {}) => staleBasisVerdict({
      token: TSLA, names: new Set(["TSLA"]), holdings: { positions: [], basis, seeded: [], ...o.holdings }, balance: o.balance ?? zero,
      classVault: o.classVault === undefined ? SHOGUN_CLASS : o.classVault, grantSpelling: o.spelled === undefined ? ACCOUNT : o.spelled });
    assert.equal(v()!.why, null);
    assert.ok(v()!.note);
    assert.equal(v({ holdings: { basis: [{ ...basis[0]!, qtyRaw: "0" }] } }), null, "a zero row is no basis");
    assert.equal(v({ holdings: { basis: [{ ...basis[0]!, symbol: "NVDA" }] } }), null, "a basis under another name is not this token's");
    const refuses: Array<[string, StaleBasis | null, RegExp]> = [
      ["an address not 0", v({ balance: { total: "0", by: { [ACCOUNT]: "0", [SHOGUN_CLASS]: "0", [VAULT]: "1" } } }), /not 0 at every address/],
      ["the class vault not read", v({ balance: { total: "0", by: { [ACCOUNT]: "0", [VAULT]: "0" } } as typeof zero }), /class vault 0x3fcdde6e\S* was not read/],
      ["held under its name", v({ holdings: { positions: [{ symbol: "TSLA", token: addr(1), rawBalance: "5", updatedAt: 1 }] } }), /Postgres's positions hold TSLA/],
      ["held as this token", v({ holdings: { positions: [{ symbol: "TSLA.x", token: TSLA, rawBalance: "5", updatedAt: 1 }] } }), /Postgres's positions hold TSLA\.x/],
      ["the seed not asked", v({ holdings: { seeded: null } }), /what admission would seed could not be asked/],
      // The seed's own answer stands even where the positions read here say nothing is held.
      ["the seed carrying it", v({ holdings: { seeded: [{ symbol: "TSLA", qtyRaw: OTHER.toString(), costUsdg: CASH.toString() }] } }),
        /admission's own seed, asked on this same read \(planAttestedSeed\), would carry TSLA at 23370235163310797 into the new book/],
      ["another spelling", v({ spelled: ACCOUNT.toUpperCase().replace(/^0X/, "0x") }), /is spelled 0x05a198.*, not as the grant spells the account/],
      ["no grant", v({ spelled: null }), /not as the grant spells the account \(no grant\)/],
    ];
    for (const [what, r, pattern] of refuses) {
      assert.ok(r && r.why, what);
      assert.match(r.why!, pattern, what);
      assert.equal(r.note, null, what);
    }
  });
});

describe("the guards no test exercised", () => {
  it("an epoch with no row yet cannot be dated: nothing is booked into it", async () => {
    const b = await books();
    for (const table of ["trades", "flows", "equity"]) b.raw.prepare(`UPDATE ${table} SET epoch = 1`).run();
    const p = await preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy), depositAt(SELL_BLOCK + 1_000n)] }).rpc);
    assert.equal(p.observations.epochOpenedAt, null);
    assert.equal(p.verdict, "blocked");
    assert.match(p.items[0]!.why, /accounting epoch 2 holds no trade, flow or equity row yet, so when it opened cannot be dated/);
  });

  it("a receipt whose block is not the canonical block at its height is not booked", async () => {
    const dep = depositAt(SELL_BLOCK + 1_000n);
    const p = await preview(await books(), fakeRpc({ txs: [fromFixture(CHAIN.buy), dep], orphaned: [dep.tx] }).rpc);
    assert.equal(p.verdict, "blocked");
    assert.match(p.items[0]!.why, /the receipt's block 0x[0-9a-f]{64} is not the canonical block 0x[0-9a-f]{64} at that height/);
  });

  it("apply refuses, writing nothing, when the flows would not be distinct, and when admission would still find a fact", async () => {
    // The same deposit already filed with no log index: the booked log beside it is one transfer booked two ways.
    const b = await books();
    const dep = depositAt(SELL_BLOCK + 1_000n);
    b.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
      VALUES (?, 'in', 12.5, ?, NULL, NULL, 'deposit', ?, 2, 4663)`).run(ACCOUNT, dep.tx, CHAIN.sell.timestamp + 100);
    const p = await preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy), dep] }).rpc);
    assert.equal(p.verdict, "ready", "admission's chain rule does not read a row with no log index as the log");
    await assert.rejects(applyNow(b.db, p), (e: unknown) => (e as BookingRefused).code === "flows");
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?", dep.tx)[0]!.n, 1, "rolled back");
    assert.equal(rows(b.raw, `SELECT COUNT(*) AS n FROM ${BOOKINGS_TABLE}`)[0]!.n, 0);
    // A plan whose proposals do not answer every fact it found.
    const c = await books();
    const q = await preview(c, fakeRpc({ txs: [fromFixture(CHAIN.buy), depositAt(SELL_BLOCK + 1_000n)] }).rpc);
    const unanswered = { kind: "transfer" as const, txHash: h32("never proposed"), block: "1", logIndex: 0, direction: "in" as const, amountRaw: "1", counterparty: null };
    await assert.rejects(applyNow(c.db, { ...q, found: [...q.found, unanswered] }), (e: unknown) => (e as BookingRefused).code === "coverage");
    assert.equal(rows(c.raw, "SELECT COUNT(*) AS n FROM flows WHERE source = 'chain-log' AND amount_usdg = 12.5")[0]!.n, 0, "rolled back");
  });
});

describe("revert, decided by what the database recorded", () => {
  async function applied(o: { operatorAheadSec?: number } = {}) {
    const b = await books();
    const dep = depositAt(SELL_BLOCK + 1_000n);
    const p = await preview(b, fakeRpc({ txs: [fromFixture(CHAIN.buy), dep] }).rpc);
    assert.equal(p.verdict, "ready");
    const report = await applyNow(b.db, p, { nowMs: (NOW + (o.operatorAheadSec ?? 0)) * 1000 });
    return { b, dep, report };
  }
  /** Admission at the orchestrator's own time: an approval, and for a registration its attestation and its consumed import. */
  async function admit(b: Books, o: { atSec: number; state: string; generation?: string | null; archived?: boolean; attested?: boolean; consumed?: boolean }) {
    const id = `admission-${o.state}-${o.atSec}`;
    const generation = o.generation === undefined ? randomUUID() : o.generation;
    refuse(b.raw, { tenant: b.tenant, account: b.account, id, atSec: o.atSec, state: o.state, generation,
      reason: o.state === "refused" ? "the stored grant names a different account, chain or owner than the registered book" : "" });
    if (o.archived) b.raw.prepare("UPDATE ledger_resume_approvals SET archive_path = '/data/archive/x' WHERE approval_id = ?").run(id);
    if (o.attested && generation) {
      b.raw.prepare(`INSERT INTO ledger_resume_attestations (generation, approval_id, tenant, smart_account, chain_id, owner, evidence_digest, receipt_digest, mirror_state_digest,
        snapshot_digest, created_at_ms) VALUES (?, ?, ?, ?, 4663, ?, 'e', 'r', 'm', 's', ?)`).run(generation, id, b.tenant, b.account, b.tenant, o.atSec * 1000);
      if (o.consumed) {
        await b.db.exec(LEDGER_IMPORT_SCHEMA);
        b.raw.prepare(`INSERT INTO tenant_ledger_import (tenant, generation, target_volume_id, state, bytes, sha256, source_digest, bindings_json, created_at_ms,
          grant_updated_at, grant_row_version) VALUES (?, ?, 'v', 'consumed', 1, 's', 'd', '{}', ?, '1', '1')`).run(b.tenant, generation, o.atSec * 1000);
      }
    }
  }
  const revert = (b: Books, report: ApplyReport) => revertBooking(b.db, parseApplyReport(JSON.stringify(report)), { nowMs: (NOW + 900) * 1000, dialect: "sqlite" });
  const stillBooked = (b: Books, dep: ModelTx) => rows(b.raw, "SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?", dep.tx)[0]!.n;

  it("the operator's clock five minutes ahead and the tenant admitted two minutes after the apply: refused, nothing changed", async () => {
    const { b, dep, report } = await applied({ operatorAheadSec: 300 });
    await admit(b, { atSec: NOW + 120, state: "applied", attested: true, consumed: true });
    await assert.rejects(revert(b, report), (e: unknown) => (e as BookingRefused).code === "admitted" && /runs an attested book/.test((e as Error).message));
    assert.equal(stillBooked(b, dep), 1);
  });

  it("registered after the apply, then refused on a grant change with its attestation in place: refused, nothing changed", async () => {
    const { b, dep, report } = await applied();
    await admit(b, { atSec: NOW + 60, state: "refused", attested: true, archived: true });
    await assert.rejects(revert(b, report), (e: unknown) => (e as BookingRefused).code === "admitted" && /attested a book for the tenant after this booking/.test((e as Error).message));
    assert.equal(stillBooked(b, dep), 1);
  });

  it("an approval past approval with no attestation yet, an approval still only approved, and a heartbeat since: each refuses", async () => {
    const archived = await applied();
    await admit(archived.b, { atSec: NOW + 60, state: "archived", archived: true });
    await assert.rejects(revert(archived.b, archived.report), (e: unknown) => (e as BookingRefused).code === "admitted" && /went past approval \(now archived/.test((e as Error).message));
    const open = await applied();
    await admit(open.b, { atSec: NOW + 60, state: "approved", generation: null });
    await assert.rejects(revert(open.b, open.report), (e: unknown) => (e as BookingRefused).code === "open-approval" && /MERRYMEN_RESUME_REVOKE/.test((e as Error).message));
    const beat = await applied();
    beat.b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW + 30, ACCOUNT);
    await assert.rejects(revert(beat.b, beat.report), (e: unknown) => (e as BookingRefused).code === "moved");
    for (const x of [archived, open, beat]) assert.equal(stillBooked(x.b, x.dep), 1);
  });

  it("an approval refused or revoked after the apply, before it minted anything, stood on nothing: the revert goes ahead", async () => {
    const { b, dep, report } = await applied();
    await admit(b, { atSec: NOW + 60, state: "refused", generation: null });
    await admit(b, { atSec: NOW + 120, state: "revoked", generation: null });
    assert.equal((await revert(b, report)).outcome, "reverted");
    assert.equal(stillBooked(b, dep), 0);
  });

  it("a report whose time or admission record is not the receipts' reverts nothing, even with its own digest recomputed", async () => {
    const { b, dep, report } = await applied();
    const reseal = (r: ApplyReport): ApplyReport => { const { reportDigest: _d, ...body } = r; return { ...r, reportDigest: digestOf(body) }; };
    for (const forged of [reseal({ ...report, appliedAtMs: report.appliedAtMs - 3_600_000 }), reseal({ ...report, admission: { ...report.admission, approvals: [] } })]) {
      await assert.rejects(revert(b, forged), (e: unknown) => (e as BookingRefused).code === "receipts");
    }
    assert.equal(stillBooked(b, dep), 1);
  });
});
