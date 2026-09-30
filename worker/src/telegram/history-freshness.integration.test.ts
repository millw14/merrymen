/**
 * The chat never holds on to a stale or failed read of the carried history.
 *
 * The parsed file is cached while it is the same file (history-overlay.ts),
 * and an answer's lookups share one connection (chat-tools.ts). Neither may
 * outlive what it stands for: a read that failed for a moment (a spent file
 * descriptor table) must be tried again, not remembered as "no history" for
 * the life of the child; and a file the orchestrator replaces mid-answer (its
 * re-read after the startup repair) must reach the very next lookup.
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-freshness-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { closeStoreForTest, initStore } = await import("../store");
const { toolByName, openToolSession } = await import("./chat-tools");
const { carriedHistory } = await import("./history-overlay");
const { writeHistoryFile, HISTORY_FILE } = await import("../history-files");
const { CASH } = await import("../../../packages/core/src/index");
type TradeHistory = import("../history-files").TradeHistory;

const SHOGUN = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const NOW = Math.floor(Date.now() / 1000);

function ctx() {
  return {
    status: { agentId: SHOGUN, name: "Shogun", strategy: "trencher", venue: "uniswap", paused: false, workerAliveSec: 5, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 },
    cfg: { customTokens: [], liveTradingEnabled: true, paperTradingEnabled: false, classSnipeEnabled: false, classPerEntryUsdg: 0, trencherLiveEnabled: true, sponsorGasEnabled: true },
    paused: false,
    grant: null,
    book: [SHOGUN],
    client: null,
    now: NOW,
  } as never;
}

function history(symbol: string, at: number): TradeHistory {
  return {
    schema: 1,
    agentId: SHOGUN,
    writtenAt: NOW,
    since: NOW - 30 * 86_400,
    decisionsFrom: NOW,
    decisions: [],
    trades: [
      {
        kind: "swap", target: "0xvault", sell_token: CASH.USDG, buy_token: "0x7a11ce0000000000000000000000000000000001", amount_usdg: 5,
        user_op_hash: null, tx_hash: null, status: "landed", reject_rule: null, decision_id: null, fill_side: "buy", fill_symbol: symbol,
        fill_qty_raw: null, fill_price_usd: null, realized_pnl_usdg: null, fill_cash_usdg: 5, gas_usdg: null, gas_wei: null, epoch: 1, created_at: at,
      },
    ],
  };
}

before(() => {
  initStore();
});

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("carried history freshness", () => {
  it("a read that failed for a moment is tried again, not remembered as 'no history'", () => {
    writeHistoryFile(HOME, history("FIRSTREAD", NOW - 86_400));
    const real = fs.readFileSync;
    let failed = 0;
    (fs as { readFileSync: unknown }).readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(p).endsWith(HISTORY_FILE) && failed === 0) {
        failed++;
        throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      }
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      assert.equal(carriedHistory(SHOGUN), null, "the failing read itself says nothing");
      assert.equal(failed, 1);
    } finally {
      (fs as { readFileSync: unknown }).readFileSync = real;
      syncBuiltinESMExports();
    }
    assert.equal(carriedHistory(SHOGUN)?.trades[0]?.fill_symbol, "FIRSTREAD", "the next lookup reads the unchanged file again");
  });

  it("a file replaced mid-answer reaches the very next lookup of that answer", async () => {
    writeHistoryFile(HOME, history("OLDNAME", NOW - 86_400));
    const c = ctx();
    const session = openToolSession(c);
    try {
      const first = await toolByName("list_trades")!.run({ since_hours: 720 }, c);
      assert.match(first, /OLDNAME/);
      // The orchestrator's re-read after its startup repair; the ledger itself is untouched.
      writeHistoryFile(HOME, history("NEWNAME", NOW - 86_400 + 1));
      const second = await toolByName("list_trades")!.run({ since_hours: 720 }, c);
      assert.match(second, /NEWNAME/);
      assert.doesNotMatch(second, /OLDNAME/);
    } finally {
      session.close();
    }
  });
});
