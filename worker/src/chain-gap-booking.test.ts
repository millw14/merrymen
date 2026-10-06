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
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { ensureLedgerResumeSchema } from "./ledger-import";
import { gasFields } from "./key-install-accounting";
import { chainGapCheck, knownChainFacts, resumePreconditions } from "./ledger-resume";
import { CASH, GRANT_TRENCHER } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import {
  APPLY_FORMAT, applyBooking, BOOKINGS_TABLE, BookingRefused, canonical, digestOf, factsStillMissing, gapChainOf, parseApplyReport, planBooking, planLines,
  readBookingSnapshot, readChainEvidence, revertBooking, TRADE_COLUMNS, type BookingPlan,
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
function fakeRpc(o: { txs: ModelTx[]; head?: bigint; chainId?: number; decimals?: Record<string, bigint>; failReceipts?: boolean }) {
  const head = o.head ?? HEAD;
  const calls: string[] = [];
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
      return t ? { status: t.status ?? "0x1", blockNumber: `0x${t.block.toString(16)}`, blockHash: blockOf(t.block).hash, from: t.from, to: t.to, transactionHash: t.tx, logs: logsOf(t) } : null;
    }
    if (method === "eth_call") {
      const [call, tag] = params as [{ to: string; data: string }, string];
      assert.equal(call.data, "0x313ce567"); assert.equal(tag, "latest");
      const d = o.decimals?.[call.to.toLowerCase()];
      if (d === undefined) throw new Error("execution reverted");
      return `0x${word(d)}`;
    }
    throw new Error(`method ${method} is outside the fake`);
  };
  return { rpc, calls };
}

// ── the shared database ──────────────────────────────────────────────────────

const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); });

/** One tenant's Postgres as the incident left it: its registration, its history in epoch 2, its stalled cursors and its grant. */
async function books(o: { tenant?: string; account?: string; trencher?: boolean; knownBuy?: boolean; mode?: string } = {}) {
  const tenant = o.tenant ?? SHOGUN_TENANT, account = o.account ?? ACCOUNT;
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL); await db.exec(PAPER_CHECKPOINT_SCHEMA);
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL, row_version INTEGER NOT NULL)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, 1000, 1)").run(tenant, JSON.stringify({
    smartAccount: account, owner: tenant, chainId: 4663, serialized: "never-read", grantFeatures: o.trencher === false ? ["tradeable-v2"] : ["tradeable-v2", GRANT_TRENCHER],
    trencherVaultAddress: VAULT, trencherFactoryAddress: addr(0xfac7),
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
      preview_digest, backup_ref, state, applied_at_ms) VALUES ('x', ?, ?, 2, 4663, ?, 'trades', 1, '{}', 'd', 'p', 'b', 'applied', 1)`).run(SHOGUN_TENANT, ACCOUNT, `op:${SELL_OP}`), /UNIQUE/);
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
