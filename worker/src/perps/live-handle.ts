/**
 * THE LIVE VENUE HANDLE — the one object that holds the agent's Lighter key
 * and everything built on it: the signer client, the auth-token cache, the
 * nonce allocator, the live executor and the reconciler (docs/perps.md rules
 * 5, 8a, 9, 10, 13, 16; w4a wiring notes).
 *
 * WHY ONE OBJECT, AND WHY THE LANE HOLDS IT RATHER THAN `active`. A key
 * registered at the venue stays valid there whatever the grant says (rule 5),
 * so a position opened with it must keep an exit for as long as it lives
 * (rule 8a) — through a kill, a grant expiry, a re-sign, perps switched off.
 * index.ts's `active` is cleared by every one of those. The handle is keyed on
 * (agent, venue account, sealed public key) instead, lives in the perp lane,
 * and is let go only once the venue reads flat (lane.ts `retained`).
 *
 * OPENING IT IS FAIL-CLOSED AND SAYS WHY. Each step can refuse, and each
 * refusal is the PerpBlocker the owner sees plus a sentence for the log:
 *
 *   key file   keystore.ts: self-hosted perp-keys/<pub>.json, hosted
 *              perp-key.json, 0600, paired with the SEALED public key — never
 *              settings, env or the grant.
 *   signer     signer.ts loadSigner: hash-pinned WASM, known-answer test at
 *              load. A signer that fails its KAT signs nothing, ever.
 *   client     one per (account, route key index), chain id 466324.
 *
 * Nothing here touches the network while opening: the auth cache mints
 * lazily, the nonce allocator arms on its first reservation, and the
 * reconciler's first pass is the lane's to run. The KEY CHECK (verifyKey)
 * and every read are the caller's, on its own clock.
 *
 * WHAT IT NEVER DOES: decide. It is edges for lane.ts — the executor and
 * reconciler adapters the stand-down drives (standdown.ts wiring notes), the
 * rule-5 self-check, one light account + orders read for the protective loop.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { LIGHTER_ROUTE_V1, type PerpBlocker } from "../../../packages/core/src/perps";
import type { PerpExitIntent } from "../policy";
import type { PerpOrderRow } from "../store";
import type { LighterApi } from "./api";
import { createLighterAuth, type LighterAuth } from "./auth";
import { createLivePerpExecutor, type LivePerpExecutor, type LivePerpStore, type LiveTxResult } from "./executor-live";
import type { LighterFeedRead } from "./feed-reader";
import { loadPerpPrivateKey, PerpKeystoreError, type PerpKeyPair } from "./keystore";
import type { PerpAccountRead, PerpDecimals, VenueOrder } from "./markets";
import { createNonceAllocator, type NonceStore } from "./nonce";
import { apiKeySlotOf, verifyKeyUsable, type ApiKeySlot, type KeyUsableVerdict } from "./onboard";
import { createLiveReconciler, type LiveReconciler, type LiveReconcileStore, type ReconcileResult } from "./reconcile";
import type { LighterSignerClient } from "./signer";
import type {
  StanddownAccount,
  StanddownCallContext,
  StanddownExecutor,
  StanddownPlaceContext,
  StanddownPlaceResult,
  StanddownReconcile,
  StanddownResolution,
  StanddownSend,
} from "./standdown";

// ── what the handle is built from ───────────────────────────────────────────

/** The ledger functions the handle's executor, reconciler and nonce allocator write through — store.ts's own. */
export interface LiveHandleStore extends LivePerpStore, LiveReconcileStore, NonceStore {
  getPerpOrder(agentId: string, mode: "live", id: string): Promise<PerpOrderRow | null>;
}

/** The slice of signer.ts's LighterSigner the handle uses (a test passes the real one). */
export interface LiveSignerLike {
  createClient(args: { accountIndex: number; apiKeyIndex: number; privateKey: string; apiPublicKey: string }): LighterSignerClient;
}

export interface LiveHandleDeps {
  agentId: string;
  /** The agent's smart account — the venue account's L1 address. */
  smartAccount: string;
  /** addressToAccountIndex(self), read on chain; > 0. */
  accountIndex: number;
  /** The public key the grant sealed (grantPerp(grant).apiPublicKey). */
  sealedPubKey: `0x${string}`;
  /** MERRYMEN_HOME — where the keystore looks. */
  home: string;
  /** An ADDRESS-KEYED, authenticated client for this L1 address (api.ts budgetKey = smartAccount). */
  api: LighterApi;
  /**
   * The PUBLIC client: the key-slot read that must work before our key is
   * registered, and the stand-down's account read when our own token no
   * longer works (a key replaced under us — the venue publishes the account).
   */
  publicApi: Pick<LighterApi, "apikeys" | "account">;
  store: LiveHandleStore;
  /** The fleet feed as of now. */
  feed: () => LighterFeedRead | null;
  /** ms — the signer, the nonce floor and every write read the same clock. */
  now: () => number;
  epoch: () => number;
  /** The process's signer (signer.ts loadSigner). */
  loadSigner: () => Promise<LiveSignerLike>;
  /** Test seam: the keystore. */
  loadKey?: (args: { home: string; apiPublicKey: string }) => PerpKeyPair;
  /** Test seam: the executor's /tx poll (executor-live.ts sleep / txPollDelaysMs). */
  executorTuning?: { sleep?: (ms: number) => Promise<void>; txPollDelaysMs?: readonly number[] };
  /** A retained-key runner may only close, cancel and withdraw. */
  standdownOnly?: boolean;
  /** Absolute job expiry; checked again after the lease validation awaits. */
  deadlineMs?: number;
  /** Hosted runner lease/generation check, immediately before any send. */
  beforeSend?: (tx: LiveSendMetadata) => Promise<void>;
  log?: (line: string) => void;
}

/** Public transaction identity only; signed bytes stay in the durable ledger. */
export interface LiveSendMetadata {
  txType: number;
  txHash: string;
  marketId: number | null;
  reduceOnly: boolean;
}

export type LiveHandleOpen =
  | { ok: true; handle: LiveHandle }
  | {
      ok: false;
      /** What the owner is shown while this stands. */
      blocker: PerpBlocker;
      /** The operator's line: a path and a reason, never key material. */
      why: string;
      /** Worth asking again later (a signer that may load next time); false for what needs the owner (a missing key file). */
      retryable: boolean;
    };

export interface LiveHandle {
  readonly agentId: string;
  readonly smartAccount: string;
  readonly accountIndex: number;
  readonly sealedPubKey: `0x${string}`;
  readonly executor: LivePerpExecutor;
  readonly reconciler: LiveReconciler;
  readonly auth: LighterAuth;
  readonly api: LighterApi;
  /**
   * Reads are marked as exit reads (api.ts `exit`) while this is set — the
   * exits-only lane and a stand-down spend the reserved end of the budget.
   */
  exitReads: boolean;
  /** The decimals the last reconcile parsed with (orderBookDetails), or null before any. */
  decimals(): ReadonlyMap<number, PerpDecimals> | null;
  /** Feed a reconcile result back in: its decimals become the executor's. */
  noteReconcile(r: ReconcileResult): void;
  /** The key slot at (our account, 16), read with the PUBLIC client — the one read that works before our key is registered. */
  keySlot(): Promise<ApiKeySlot>;
  /**
   * RULE 5's SELF-CHECK (onboard.ts verifyKeyUsable): the venue holds the
   * sealed key at our index AND accepts a token our private key minted. Only
   * a pass arms live perps; `unread` is "could not check", never a pass.
   */
  verifyKey(slot?: ApiKeySlot): Promise<KeyUsableVerdict>;
  /** The account's resting orders (authenticated), for a light read; null = unread. */
  activeOrders(): Promise<VenueOrder[] | null>;
  /** The stand-down's executor over this handle (standdown.ts wiring notes). */
  standdownExecutor(decide: (intent: PerpExitIntent, reason: string) => Promise<void>): StanddownExecutor;
  /** The stand-down's reconcile over this handle. */
  standdownReconcile(): StanddownReconcile;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
}

/** The last boundary before bytes leave the process, including replays. */
export function guardedStanddownApi(
  d: Pick<LiveHandleDeps, "api" | "now" | "standdownOnly" | "deadlineMs" | "beforeSend">,
  context: AsyncLocalStorage<StanddownCallContext>,
): LighterApi {
  return {
    ...d.api,
    async sendTx(tx, flags) {
      const ctx = context.getStore();
      let packet: { MarketIndex?: unknown; ReduceOnly?: unknown } = {};
      try { packet = JSON.parse(tx.txInfo); } catch { /* retained-key validation refuses it below */ }
      const metadata: LiveSendMetadata = { txType: tx.txType, txHash: tx.txHash,
        marketId: Number.isSafeInteger(packet?.MarketIndex) && Number(packet.MarketIndex) >= 0 && Number(packet.MarketIndex) <= 65_535 ? Number(packet.MarketIndex) : null,
        reduceOnly: packet?.ReduceOnly === 1 };
      const check = () => {
        if (ctx?.signal.aborted) throw new Error("the stand-down call ended before send");
        for (const deadline of [ctx?.deadlineMs, flags?.notAfterMs]) {
          if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline <= 0 || d.now() >= deadline)) {
            throw new Error("the request expired before send");
          }
        }
        if (d.deadlineMs !== undefined && (!Number.isFinite(d.deadlineMs) || d.now() >= d.deadlineMs)) {
          throw new Error("the stand-down job expired before send");
        }
        if (d.standdownOnly) {
          if (ctx === undefined) throw new Error("a retained-key send requires a live stand-down call");
          if (!(tx.txType === 13 || tx.txType === 15 || tx.txType === 16 || (tx.txType === 14 && metadata.reduceOnly && metadata.marketId !== null))) {
            throw new Error("a retained-key runner cannot send an entry or leverage change");
          }
        }
      };
      check();
      await d.beforeSend?.(metadata);
      check();
      return d.api.sendTx(tx, flags);
    },
  };
}

/**
 * OPEN THE HANDLE: key file → signer (KAT) → client → auth, nonces, executor,
 * reconciler. No network. See the header for what each refusal means.
 */
export async function openLiveHandle(d: LiveHandleDeps): Promise<LiveHandleOpen> {
  const log = d.log ?? (() => {});
  const apiKeyIndex = LIGHTER_ROUTE_V1.apiKeyIndex;
  if (!Number.isSafeInteger(d.accountIndex) || d.accountIndex < 1) {
    return { ok: false, blocker: "perps-awaiting-deposit", why: "the agent has no Lighter account yet", retryable: true };
  }

  // ── the key file ──
  let pair: PerpKeyPair;
  try {
    pair = (d.loadKey ?? loadPerpPrivateKey)({ home: d.home, apiPublicKey: d.sealedPubKey });
  } catch (e) {
    // A missing, loose-moded or mismatched key file is the OWNER's to fix
    // (re-run keygen and re-sign, or chmod 600): asking again every tick
    // changes nothing, so it is said once per arm (the caller's latch).
    const reason = e instanceof PerpKeystoreError ? e.reason : "io";
    return {
      ok: false,
      blocker: "perps-key-pending",
      why: `the Lighter trading key for the sealed public key could not be loaded (${reason}): ${errText(e)}`,
      retryable: reason === "io",
    };
  }

  // ── the signer (KAT at load) and the client ──
  let client: LighterSignerClient;
  try {
    const signer = await d.loadSigner();
    client = signer.createClient({ accountIndex: d.accountIndex, apiKeyIndex, privateKey: pair.privateKey, apiPublicKey: pair.publicKey });
  } catch (e) {
    // The signer did not load, failed its known-answer test, or refused the
    // key: nothing can be signed. Retried on the loader's own backoff (a KAT
    // failure is final there and stays refused).
    return { ok: false, blocker: "perps-venue-unreachable", why: `the Lighter signer is unavailable: ${e instanceof Error ? e.name : "error"} — ${errText(e)}`, retryable: true };
  }

  const auth = createLighterAuth({ client: () => client, now: d.now });
  const nonces = createNonceAllocator({
    agentId: d.agentId,
    accountIndex: d.accountIndex,
    apiKeyIndex,
    store: d.store,
    now: d.now,
    // Read at arm only (rule 9), authenticated so it counts per L1 address.
    venueNextNonce: async () => {
      const r = await auth.withAuth((a) => d.api.nextNonce(d.accountIndex, apiKeyIndex, { auth: a, exit: true }));
      return r.ok ? BigInt(r.value) : null;
    },
  });
  let lastDecimals: ReadonlyMap<number, PerpDecimals> | null = null;
  const feedDecimals = (): ReadonlyMap<number, PerpDecimals> => {
    const m = new Map<number, PerpDecimals>();
    for (const [id, fm] of d.feed()?.markets ?? []) m.set(id, { sizeDecimals: fm.spec.sizeDecimals, priceDecimals: fm.spec.priceDecimals });
    return m;
  };
  const sendContext = new AsyncLocalStorage<StanddownCallContext>();
  const api = guardedStanddownApi(d, sendContext);
  const executor = createLivePerpExecutor({
    agentId: d.agentId,
    epoch: d.epoch,
    accountIndex: d.accountIndex,
    signerClient: () => client,
    api,
    feed: d.feed,
    store: d.store,
    nonces,
    auth,
    now: d.now,
    clockSkewMs: () => d.api.clockSkewMs(),
    sendNotAfterMs: () => sendContext.getStore()?.deadlineMs,
    decimals: () => lastDecimals,
    ...(d.executorTuning?.sleep !== undefined ? { sleep: d.executorTuning.sleep } : {}),
    ...(d.executorTuning?.txPollDelaysMs !== undefined ? { txPollDelaysMs: d.executorTuning.txPollDelaysMs } : {}),
  });
  const handle = {} as LiveHandle & { exitReads: boolean };
  let exitReads = false;
  // The reconciler reads `exitReads` on every call (reconcile.ts flags()), so
  // a getter lets the lane move the whole handle into the exit budget.
  const reconcileDeps = {
    agentId: d.agentId,
    epoch: d.epoch,
    accountIndex: d.accountIndex,
    apiKeyIndex,
    smartAccount: d.smartAccount,
    sealedPubKey: d.sealedPubKey,
    api: d.api,
    auth: () => {
      try {
        return auth.token();
      } catch {
        return null;
      }
    },
    store: d.store,
    now: d.now,
    clockSkewMs: () => d.api.clockSkewMs(),
    resend: (row: PerpOrderRow) => {
      // A shutdown must never execute the entry it is trying to unwind.
      if ((d.standdownOnly || exitReads || sendContext.getStore() !== undefined) &&
          !(row.effect === "cancel" || row.effect === "withdraw" ||
            (row.reduceOnly && (row.effect === "close" || row.effect === "reduce")))) {
        return Promise.resolve({ sent: false, why: "entry replay is disabled during stand-down" });
      }
      return executor.resendPersisted(row);
    },
    get exitReads() {
      return exitReads;
    },
    log,
  };
  const reconciler = createLiveReconciler(reconcileDeps);

  const sendOf = (tx: LiveTxResult): StanddownSend => ({
    status: tx.rowStatus === "executed" ? "executed" : tx.rowStatus === "rejected" || tx.rowStatus === "app-error" ? "rejected" : "submitted",
    detail: tx.detail,
  });
  const refusedSend = (e: unknown): StanddownSend => ({ status: "rejected", detail: errText(e) });

  Object.assign(handle, {
    agentId: d.agentId,
    smartAccount: d.smartAccount,
    accountIndex: d.accountIndex,
    sealedPubKey: d.sealedPubKey,
    executor,
    reconciler,
    auth,
    api: d.api,
    decimals: () => lastDecimals,
    noteReconcile(r: ReconcileResult) {
      if (r.decimals !== null) lastDecimals = r.decimals;
    },
    async keySlot(): Promise<ApiKeySlot> {
      try {
        return apiKeySlotOf(await d.publicApi.apikeys(d.accountIndex, apiKeyIndex));
      } catch {
        return "unread";
      }
    },
    async verifyKey(slot?: ApiKeySlot): Promise<KeyUsableVerdict> {
      const s = slot ?? (await handle.keySlot());
      return verifyKeyUsable({
        apikeysRead: s,
        sealedPubKey: d.sealedPubKey,
        // An auth-gated read the venue answers only for a token OUR private
        // key minted for (account, 16): the proof the key we hold is the one
        // registered (onboard.ts header).
        // Parsed with the reconcile's decimals, or — before the first pass —
        // the feed's: an order on a market neither carries is `malformed`,
        // which verifyKeyUsable reads as "could not check", never a pass.
        authProbe: () => d.api.accountActiveOrders(d.accountIndex, lastDecimals ?? feedDecimals(), { auth: auth.token(), exit: true }),
      });
    },
    async activeOrders(): Promise<VenueOrder[] | null> {
      const dec = lastDecimals ?? feedDecimals();
      try {
        const r = await auth.withAuth((a) => d.api.accountActiveOrders(d.accountIndex, dec, { auth: a, exit: exitReads }));
        return r.ok ? r.value.orders : null;
      } catch {
        return null;
      }
    },
    standdownExecutor(decide: (intent: PerpExitIntent, reason: string) => Promise<void>): StanddownExecutor {
      return {
        async account(): Promise<StanddownAccount | null> {
          const r = await executor.account({ exit: true });
          let read: PerpAccountRead | null = r.ok ? r.read : null;
          if (read === null) {
            // OUR TOKEN REFUSED (an incident: another key at our index) is not
            // the venue unread — the account is public, and the stand-down
            // must see what is still there to say it (its sends will be
            // refused, and the result names what is left).
            try {
              const p = await d.publicApi.account({ by: "index", accountIndex: d.accountIndex }, lastDecimals ?? feedDecimals());
              read = p.ok ? p.value : null;
            } catch {
              read = null;
            }
          }
          if (read === null) return null;
          return lastDecimals === null ? read : { ...read, decimals: lastDecimals };
        },
        async place(intent: PerpExitIntent, ctx: StanddownPlaceContext): Promise<StanddownPlaceResult> {
          return sendContext.run(ctx, async () => {
          // Filed under a decision like every exit (the lane's ensureDecision);
          // a decision that could not be written never stops the close.
          try {
            await decide(intent, `the perps stand-down (${ctx.reason}): close ${intent.market}, attempt ${ctx.attempt}`);
          } catch {
            // an exit is always attemptable (rule 8)
          }
          const review = await executor.review(intent);
          const placed = await executor.place(intent, review, { agentId: d.agentId, decisionId: intent.decisionId ?? null });
          return { status: placed.status, orderRowId: placed.orderRowId, filledBase: placed.filledBase, detail: placed.detail };
          });
        },
        async resolve(orderRowId: string, ctx: StanddownCallContext): Promise<StanddownResolution> {
          return sendContext.run(ctx, async () => {
          // Rule 9: by hash (resolveSubmitted), then the fills behind an
          // executed row (ingestFills finalizes it) — never guessed.
          await reconciler.resolveSubmitted();
          let row = await d.store.getPerpOrder(d.agentId, "live", orderRowId);
          if (row !== null && row.status === "executed") {
            await reconciler.ingestFills();
            row = await d.store.getPerpOrder(d.agentId, "live", orderRowId);
          }
          if (row === null) return { status: "unknown", detail: "the close's row could not be read" };
          switch (row.status) {
            case "filled":
            case "partial":
            case "cancelled":
            case "rejected":
            case "expired":
              return { status: row.status, filledBase: row.filledBase ?? undefined, detail: row.reason ?? undefined };
            case "app-error":
              return { status: "rejected", detail: row.reason ?? "the venue's application refused it" };
            default:
              // submitted, or executed with its fills not read yet: in flight.
              return { status: "submitted" };
          }
          });
        },
        async cancelMarket(marketId: number, ctx: StanddownCallContext): Promise<StanddownSend> {
          try {
            return sendOf(await sendContext.run(ctx, () => executor.cancelMarket(marketId, { reason: `standdown-${ctx.reason}` })));
          } catch (e) {
            return refusedSend(e);
          }
        },
        async cancelAll(ctx: StanddownCallContext): Promise<StanddownSend> {
          try {
            return sendOf(await sendContext.run(ctx, () => executor.cancelAllAccountWide({ acknowledge: "removes-every-resting-stop", reason: `standdown-${ctx.reason}` })));
          } catch (e) {
            return refusedSend(e);
          }
        },
        async requestWithdraw(amountMicro: bigint, freeMicro: bigint, ctx: StanddownCallContext): Promise<StanddownSend> {
          try {
            return sendOf(await sendContext.run(ctx, () => executor.requestWithdraw(amountMicro, freeMicro, { initiator: "standdown", reason: `standdown-${ctx.reason}` })));
          } catch (e) {
            return refusedSend(e);
          }
        },
      };
    },
    standdownReconcile(): StanddownReconcile {
      const verdict = (r: { gaps: string[] }) => ({ ok: r.gaps.length === 0, detail: r.gaps.join("; ") });
      return {
        async resolveSubmitted(ctx) {
          return sendContext.run(ctx, async () => verdict(await reconciler.resolveSubmitted()));
        },
        async reconcileOnce(ctx) {
          return sendContext.run(ctx, async () => {
          const r = await reconciler.reconcileOnce();
          handle.noteReconcile(r);
          return verdict(r);
          });
        },
      };
    },
  });
  Object.defineProperty(handle, "exitReads", {
    get: () => exitReads,
    set: (v: boolean) => {
      exitReads = v === true;
    },
    enumerable: true,
  });
  log(`[perps] live handle open for account ${d.accountIndex}`);
  return { ok: true, handle };
}
