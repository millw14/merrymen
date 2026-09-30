import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it } from "node:test";
import type { LighterApi } from "./api";
import { guardedStanddownApi, type LiveSendMetadata } from "./live-handle";
import type { StanddownCallContext } from "./standdown";

describe("retained-key send boundary", () => {
  function setup(beforeSend?: (tx: LiveSendMetadata) => Promise<void>) {
    let now = 100;
    let sends = 0;
    const controller = new AbortController();
    const context = new AsyncLocalStorage<StanddownCallContext>();
    const api = guardedStanddownApi({
      api: { sendTx: async () => { sends++; return { ok: true, value: {} }; } } as unknown as LighterApi,
      now: () => now, standdownOnly: true, deadlineMs: 200, beforeSend,
    }, context);
    const send = (txType = 14, ReduceOnly = 1) => api.sendTx({ txType, txInfo: JSON.stringify({ ReduceOnly, MarketIndex: 1 }), txHash: "test" });
    const scoped = <T>(fn: () => T) => context.run({ reason: "kill", signal: controller.signal }, fn);
    return { send, scoped, controller, sends: () => sends, expire: () => { now = 200; } };
  }

  it("requires a stand-down context and rejects entry/leverage bytes", async () => {
    const t = setup();
    await assert.rejects(t.send(), /requires a live stand-down/);
    for (const [type, reduce] of [[14, 0], [20, 0], [28, 1]]) {
      await assert.rejects(t.scoped(() => t.send(type, reduce)), /cannot send an entry/);
    }
    assert.equal(t.sends(), 0);
    for (const type of [13, 14, 15, 16]) await t.scoped(() => t.send(type));
    assert.equal(t.sends(), 4);
  });

  it("identifies fresh and replayed closes before each send without exposing signed bytes", async () => {
    const seen:LiveSendMetadata[]=[];const t=setup(async tx=>{seen.push(tx);});
    await t.scoped(()=>t.send());await t.scoped(()=>t.send());
    assert.deepEqual(seen,[{txType:14,txHash:"test",marketId:1,reduceOnly:true},{txType:14,txHash:"test",marketId:1,reduceOnly:true}]);
    assert.equal(t.sends(),2);assert.ok(!Object.hasOwn(seen[0]!,"txInfo"));
  });

  it("abandoned calls and expired jobs send no bytes", async () => {
    const aborted = setup();
    aborted.controller.abort();
    await assert.rejects(aborted.scoped(() => aborted.send()), /ended before send/);
    const expired = setup();
    expired.expire();
    await assert.rejects(expired.scoped(() => expired.send(13)), /expired before send/);
    assert.equal(aborted.sends() + expired.sends(), 0);
  });

  it("rechecks abort and deadline after awaiting the hosted lease check", async () => {
    const aborting = setup(async () => { aborting.controller.abort(); });
    await assert.rejects(aborting.scoped(() => aborting.send(16)), /ended before send/);
    const expiring = setup(async () => { expiring.expire(); });
    await assert.rejects(expiring.scoped(() => expiring.send(13)), /expired before send/);
    const revoked = setup(async () => { throw new Error("lease revoked"); });
    await assert.rejects(revoked.scoped(() => revoked.send()), /lease revoked/);
    assert.equal(aborting.sends() + expiring.sends() + revoked.sends(), 0);
  });

  it("rechecks owner and stand-down numeric deadlines after a delayed lease check before timers fire", async () => {
    for (const bound of ["owner", "standdown"] as const) {
      let now = 100, sends = 0;
      const controller = new AbortController();
      const context = new AsyncLocalStorage<StanddownCallContext>();
      const api = guardedStanddownApi({
        api: { sendTx: async () => { sends++; return { ok: true, value: {} }; } } as unknown as LighterApi,
        now: () => now,
        beforeSend: async () => { now = 150; },
      }, context);
      const send = () => api.sendTx({ txType: 14, txInfo: '{"ReduceOnly":1,"MarketIndex":1}', txHash: "test" },
        bound === "owner" ? { notAfterMs: 150 } : undefined);
      await assert.rejects(context.run({ signal: controller.signal, reason: "flatten", ...(bound === "standdown" ? { deadlineMs: 150 } : {}) }, send), /expired before send/);
      assert.equal(controller.signal.aborted, false, "the numeric fence does not depend on timer delivery");
      assert.equal(sends, 0, bound);
    }
  });
});
