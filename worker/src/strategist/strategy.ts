/**
 * The LLM strategist as a Strategy: cron-gated decision points, not per-tick
 * chatter. Between decision windows it proposes nothing; at each window it
 * builds sanitized signals from the snapshot, asks the driver, and runs the
 * answer through parse → validate → convert. A driver failure or garbage
 * output degrades to "no trades this window" — never to a crash, never to an
 * unvalidated intent.
 */

import { randomUUID } from "node:crypto";
import type { TradeIntent } from "../policy";
import type { Snapshot, Strategy, Tick } from "../strategies/types";
import type { Why } from "../strategies/reasons";
import { parseProposals, proposalsToIntents, type StrategistUniverse } from "./proposals";
import type { ProposalDriver, Signals } from "./driver";
import { runDesk, type DeskLink, type DeskPeer, type DeskWorld } from "./desk";
import type { LlmCreds } from "../llm";

/** A decision the strategist made this window — survivor (linked to an intent via
 * its id) or drop (dropped_rule set). Deliberately store-agnostic: index.ts adds
 * agent_id and persists it, so this module stays DB-free and unit-testable. */
export interface StrategistDecision {
  id: string;
  source: "strategist";
  strategy: string;
  provider?: string;
  model?: string;
  symbol?: string;
  action?: string;
  size_usdg?: number;
  reason?: string;
  dropped_rule?: string;
  signals_json?: string;
}

export interface LlmStrategistConfig {
  driver: ProposalDriver;
  universe: StrategistUniverse;
  /**
   * The curve legs available RIGHT NOW, re-read each decision.
   *
   * A function rather than a field because `universe` is built once at
   * strategy construction while a curve leg carries this tick's RESERVES —
   * the input a slippage floor is derived from. Freezing them at startup
   * would size every future trade against a curve as it looked when the
   * worker booted, on a venue whose p99 move over four minutes is 1,546 bps.
   *
   * Optional: absent means no curve venue, which is exactly how every
   * existing caller behaves.
   */
  curveLegsNow?: () => {
    legs: ReadonlyMap<string, import("./proposals").CurveLeg>;
    tokens: ReadonlyMap<string, `0x${string}`>;
    slippageBps: number;
    /** How far one buy may move the curve, bps. Travels with the legs. */
    maxImpactBps: number;
  } | null;
  /**
   * Sell a holding outright once it is this far below what it cost, in bps.
   * 0 = off, and 0 is the default.
   *
   * A FLOOR, NOT A VIEW. It runs on every tick rather than at the decision
   * window, needs no model call, and can only ever ADD a sell — it never
   * suppresses or delays one the model wanted to make. It exists because the
   * strategy an owner actually runs had no mechanical exit of any kind: every
   * stop in this repo belonged to trencher, and reaching it meant abandoning
   * the strategist entirely.
   */
  stopLossBps?: number;
  /**
   * Sell a holding outright once it is this far ABOVE what it cost, in bps.
   * 0 = off, and 0 is the default.
   *
   * THE SETTING EXISTED AND THIS STRATEGY NEVER RECEIVED IT. `takeProfitBps`
   * has been in settings, on the UI, and in agents' own descriptions of
   * themselves to their owners — and registry.ts forwarded it only to
   * steady-basket. An owner on the strategist had a floor, no ceiling, and an
   * agent that said otherwise.
   */
  takeProfitBps?: number;
  /** Minimum ms between model calls — decisions are windows, ticks are not. */
  decisionIntervalMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Where dropped proposals and reasons get reported (worker event log). */
  onNote?: (level: "ok" | "warn", message: string) => void;
  /** Persist each decision (survivor + drop). When set, survivors get a stamped
   * decisionId; when absent (e.g. backtest) no ids are minted. Provider/model
   * label which brain reasoned, for later per-model attribution. */
  onDecision?: (d: StrategistDecision) => void | Promise<void>;
  provider?: string;
  model?: string;
  /**
   * RESEARCH INSTEAD OF GUESSING.
   *
   * When present the window runs a bounded tool loop — the model can pull
   * depth, check what a position cost, and read back its own last decisions
   * before it commits — and finishes by submitting a view in its own words.
   * Absent, the old one-shot driver runs exactly as before.
   *
   * It costs up to maxSteps model calls instead of one, which is why it is
   * opt-in: the scout consumed a whole day's shared token allowance once and
   * took user chat down with it.
   */
  desk?: {
    creds: LlmCreds;
    /** The agent's own recent decisions and what became of them. */
    recall: () => Promise<string>;
    /** What a position cost, so the model can tell a winner from a loser. */
    basisFor?: (symbol: string) => Promise<string | null>;
    /** Pages the model may ask for BY INDEX. Re-read each window. */
    links?: () => DeskLink[];
    /** Desks this owner wired in. Absent or empty hides the tool entirely. */
    peers?: () => DeskPeer[];
    readPeer?: (index: number) => Promise<string>;
    /** Fetch one offered link. Index-addressed; never a model-supplied URL. */
    readLink?: (index: number) => Promise<string>;
    maxSteps?: number;
  };
}

/** Two decimals is plenty for a dollar figure the model reasons about, and it
 * keeps long floats out of a prompt with a fixed token budget. */
const round2 = (n: number) => Math.round(n * 100) / 100;

function buildSignals(snap: Snapshot, universe: StrategistUniverse, at: Date, stopLossBps = 0): Signals {
  // ── WHAT THE MODEL IS ALLOWED TO NAME ─────────────────────────────────
  //
  // BOTH VENUES, and it used to be one. `tradableSymbols` and the price list
  // were derived from `universe.legs` alone, while curve legs live in a
  // separate map — so a bonding-curve memecoin was never offered to the model
  // and its price was filtered out of the prompt. Supplying `curveLegsNow` was
  // therefore still inert: the converter could finally build a curve trade, and
  // nothing ever asked for one.
  //
  // The two maps stay SEPARATE downstream, deliberately. `proposalsToIntents`
  // checks `curveLegs` before `legs`, and a curve token placed in `legs` would
  // be routed to the swap router — an operation against a pool that does not
  // exist. This union is for what the model may SAY, not for how a trade is
  // built.
  const tradable = new Set([...universe.legs.keys(), ...(universe.curveTokens?.keys() ?? [])]);
  return {
    cashUsdg: Number(snap.cashUsdg) / 1e6,
    vaultUsdg: Number(snap.vaultUsdg) / 1e6,
    equityUsdg:
      Number(snap.cashUsdg + snap.vaultUsdg) / 1e6 +
      [...snap.holdings.values()].reduce((s, h) => s + Number(h.valueUsdg) / 1e6, 0),
    // WHAT IT IS WORTH, AND WHAT IT COST. The second number is new, and without
    // it the model was being asked to decide whether to sell while structurally
    // unable to tell a winner from a loser.
    //
    // OMITTED, NOT ZEROED, when the ledger has no basis. `costUsdg: 0` says the
    // whole position is profit; absent says we do not know what it cost, which
    // is the truth and is a thing the model can reason about ("I cannot tell if
    // I am up on this") instead of a number it would act on.
    holdings: [...snap.holdings.entries()].map(([symbol, h]) => {
      const cost = h.costUsdg ?? null;
      return {
        symbol,
        valueUsdg: round2(Number(h.valueUsdg) / 1e6),
        priceStale: h.priceStale,
        ...(cost === null
          ? {}
          : {
              costUsdg: round2(Number(cost) / 1e6),
              // Stated rather than left as arithmetic. A stale price makes this
              // a number about a market that closed, and `priceStale` beside it
              // is what says so.
              pnlUsdg: round2(Number(h.valueUsdg - cost) / 1e6),
            }),
      };
    }),
    prices: [...snap.prices.entries()]
      .filter(([symbol]) => tradable.has(symbol))
      .map(([symbol, p]) => ({
        symbol,
        usd: Number(p.price8) / 1e8,
        stale: p.stale,
      })),
    tradableSymbols: [...tradable],
    // Absent when no floor is armed — never 0, which would read as a floor at
    // break-even rather than as no floor at all.
    ...(stopLossBps > 0 ? { stopLossBps } : {}),
    maxPerActionUsdg: Number(universe.maxPerActionUsdg) / 1e6,
    utcHour: at.getUTCHours(),
    utcDay: at.getUTCDay(),
    // Only for symbols the model may actually trade. Depth on something outside
    // the universe is noise it cannot act on, and it costs prompt budget.
    // Omitted entirely rather than sent empty: an empty array reads as "no
    // liquidity anywhere", which is a much stronger claim than "not read yet".
    ...(() => {
      const rows = [...(snap.depth?.entries() ?? [])]
        .filter(([symbol]) => universe.legs.has(symbol))
        .map(([symbol, d]) => ({
          symbol,
          buyUsdg: round2(d.buyUsdg),
          sellUsdg: round2(d.sellUsdg),
          supportUsd: d.supportUsd === null ? null : round2(d.supportUsd),
          resistanceUsd: d.resistanceUsd === null ? null : round2(d.resistanceUsd),
        }));
      return rows.length > 0 ? { depth: rows } : {};
    })(),
  };
}

export function makeLlmStrategist(cfg: LlmStrategistConfig): Strategy {
  const now = cfg.now ?? Date.now;
  const note = cfg.onNote ?? (() => {});
  const name = `llm-strategist(${cfg.driver.name})`;
  let lastDecisionAt: number | null = null;
  /**
   * Symbols whose floor sell is already on its way.
   *
   * Without this the same position is re-proposed on every tick for the one or
   * two ticks a fill takes to land, and the agent sells the same holding twice.
   * Cleared when the holding leaves the book, which is what "it filled" looks
   * like from here.
   */
  const floorFired = new Set<string>();

  return {
    name,
    async tick(snap: Snapshot): Promise<TradeIntent[] | Tick> {
      if (!snap.sequencerUp) return [];
      const t = now();

      // ── THE FLOOR, BEFORE THE DECISION WINDOW ─────────────────────────
      //
      // ABOVE the interval guard on purpose. A model is consulted every
      // `decisionIntervalMs` — half an hour by default — and a stop that only
      // ran then would be a stop with a thirty-minute blind spot, which on this
      // chain is most of a move. This runs every tick, needs no model call, and
      // costs nothing when it does not fire.
      //
      // IT CAN ONLY EVER ADD A SELL. It never suppresses, reorders or delays a
      // model decision; on a window tick it returns before the model is asked
      // only when it actually fires, and what it emits is a swap into cash,
      // which the wall exempts from the per-trade, daily and ops caps and from
      // the drawdown breaker. So it cannot be the thing that stops an exit.
      //
      // BUILT DIRECTLY, NOT THROUGH proposalsToIntents, and that is the point:
      // that boundary clamps to the strategist ceiling, and a floor that can be
      // clamped to 10 USDG cannot exit a position worth more than 10 USDG —
      // which is precisely the position a stop is for.
      //
      // A STOP FROM ENTRY, NOT A TRAILING ONE. It measures against cost basis,
      // so it will not catch a position that ran up and gave it all back to
      // break-even. Saying so here because the difference matters and the name
      // "stop loss" invites the other reading.
      // A GRADED LEVEL, ONE FLAT PERMISSION. `cfg.stopLossBps` decides WHETHER
      // a floor is armed at all and remains the level for anything ungraded;
      // `h.stopFloorBps` decides only WHERE, for the positions that carry a
      // grade stamped at their own entry. An owner who has armed nothing must
      // not acquire a stop because a grade happened to be computable, which is
      // why the guard below reads the owner's number and not the holding's.
      for (const [symbol, h] of snap.holdings) {
        if (!cfg.stopLossBps || cfg.stopLossBps <= 0) break;
        if (floorFired.has(symbol)) continue;
        // A stale price is last session's number, not a loss. An absent cost is
        // not a gain and not a loss — the same rule steady-basket already uses,
        // because reading null as zero would make every holding look like a
        // total loss and sell the entire book.
        if (h.priceStale) continue;
        const cost = h.costUsdg ?? null;
        if (cost === null || cost <= 0n) continue;
        if (snap.pausedTokens.has(h.token.toLowerCase())) continue;
        // A stamped floor of zero or less is not a floor; fall back rather than
        // let a bad row disarm a position the owner armed.
        const level = h.stopFloorBps && h.stopFloorBps > 0 ? h.stopFloorBps : cfg.stopLossBps;
        const lossBps = Number(((cost - h.valueUsdg) * 10_000n) / cost);
        if (lossBps < level) continue;
        floorFired.add(symbol);
        return {
          intents: [
            {
              kind: "swap",
              target: cfg.universe.swapRouter,
              sellToken: h.token,
              buyToken: cfg.universe.usdg,
              sellAmountRaw: h.rawBalance,
              notionalUsdg: h.valueUsdg,
            },
          ],
          why: [
            {
              code: "stop-floor",
              symbol,
              lossBps,
              usdgRaw: h.valueUsdg,
              costRaw: cost,
              // Carried only when this position's level was NOT the owner's own
              // number, so the ordinary sentence stays exactly as it was and a
              // graded one explains itself.
              ...(level === cfg.stopLossBps ? {} : { floorBps: level, floorWhy: h.stopFloorWhy ?? null }),
            },
          ],
        };
      }

      // ── AND THE CEILING, WHICH THIS STRATEGY NEVER HAD ────────────────
      //
      // `takeProfitBps` has existed as a setting, been shown in the UI, and
      // been described by agents to their owners in chat — and `registry.ts`
      // never forwarded it to this strategy. Only steady-basket read it. So an
      // owner running the strategist had a floor, no ceiling, and an agent that
      // told them otherwise: "my take-profit is set at 2000 basis points, so
      // I'll sell if a holding rises 20% above its cost", about a rule that did
      // not exist here.
      //
      // Same shape as the floor above and for the same reasons: above the
      // decision window so it does not inherit a thirty-minute blind spot,
      // built directly so the strategist ceiling cannot clamp an exit, measured
      // against cost rather than a peak. NOT graded — a grade is about how much
      // room a position needs to be wrong in, and a profit is not being wrong.
      for (const [symbol, h] of snap.holdings) {
        if (!cfg.takeProfitBps || cfg.takeProfitBps <= 0) break;
        if (floorFired.has(symbol)) continue;
        if (h.priceStale) continue;
        const cost = h.costUsdg ?? null;
        if (cost === null || cost <= 0n) continue;
        if (snap.pausedTokens.has(h.token.toLowerCase())) continue;
        if (h.valueUsdg <= cost) continue;
        const gainBps = Number(((h.valueUsdg - cost) * 10_000n) / cost);
        if (gainBps < cfg.takeProfitBps) continue;
        floorFired.add(symbol);
        return {
          intents: [
            {
              kind: "swap",
              target: cfg.universe.swapRouter,
              sellToken: h.token,
              buyToken: cfg.universe.usdg,
              sellAmountRaw: h.rawBalance,
              notionalUsdg: h.valueUsdg,
            },
          ],
          why: [{ code: "take-profit", symbol, gainBps, usdgRaw: h.valueUsdg, costRaw: cost }],
        };
      }
      // A holding that has left the book has filled (or been sold another way),
      // so the latch is released and the floor can arm again if it returns.
      for (const s of [...floorFired]) if (!snap.holdings.has(s)) floorFired.delete(s);

      if (lastDecisionAt !== null && t - lastDecisionAt < cfg.decisionIntervalMs) return [];
      lastDecisionAt = t;

      // ── THE UNIVERSE THIS WINDOW ACTUALLY HAS ───────────────────────
      //
      // Built HERE, above the driver call, and used for BOTH halves. It used to
      // be assembled after the model had already answered, which made it
      // decorative twice over:
      //
      //   THE CEILING. `cfg.universe.maxPerActionUsdg` comes from settings
      //   (llmMaxActionUsdg, default 50) while the wall enforces the per-trade
      //   cap sealed into the SIGNATURE (default preset: 10). So the model was
      //   told it could spend 50, proposed 50, and every action died at
      //   `per-trade-cap` — on every agent minted with the default preset, on
      //   every window, for the life of the grant. Settings cannot fix it: the
      //   cap is in the signature. `min()` can only ever TIGHTEN, so this needs
      //   no re-signing and cannot raise what anybody may spend.
      //
      //   THE CURVE LEGS. `buildSignals` derives `tradableSymbols` and `prices`
      //   from `universe.legs`, so a curve symbol merged in afterwards was
      //   never offered to the model at all — the proposal it could not have
      //   made was then dropped as "not in the tradable universe".
      //
      // Merged per window rather than at construction because the reserves are
      // this tick's; see the curve note on curveLegsNow.
      const curve = cfg.curveLegsNow?.() ?? null;
      const universeNow: StrategistUniverse = {
        ...cfg.universe,
        maxPerActionUsdg:
          cfg.universe.maxPerActionUsdg < snap.perTradeCapUsdg
            ? cfg.universe.maxPerActionUsdg
            : snap.perTradeCapUsdg,
        ...(curve
          ? {
              curveLegs: curve.legs,
              curveTokens: curve.tokens,
              slippageBps: curve.slippageBps,
              // The same ceiling both swap branches and the chat producer use.
              // Absent means unchecked, so it travels with the legs or not at all.
              maxImpactBps: curve.maxImpactBps,
            }
          : {}),
      };

      const signals = buildSignals(snap, universeNow, new Date(t), cfg.stopLossBps ?? 0);

      // THE VIEW, when the desk ran. Empty on the one-shot path, and empty
      // whenever the desk failed to finish — an unfinished session is not a
      // decision and must not be published as one.
      let thesis = "";
      let actions: import("./proposals").ProposedAction[];
      let malformed = 0;

      if (cfg.desk) {
        const desk = cfg.desk;
        // Composed HERE, per window, because look_up answers about THIS tick:
        // the price, its provenance, the depth and the holding all come from the
        // signals just built. A world fixed at construction would answer every
        // future window with the book as it looked when the worker booted.
        const world: DeskWorld = {
          async lookUp(symbol: string) {
            const p = signals.prices.find((x) => x.symbol === symbol);
            const h = signals.holdings.find((x) => x.symbol === symbol);
            const d = signals.depth?.find((x) => x.symbol === symbol);
            const lines = [`${symbol}:`];
            lines.push(
              p
                ? `  price ${p.usd} USD${p.stale ? " (STALE — the market is shut)" : ""}`
                : `  no price — this symbol is not priced right now, which is not the same as worthless`,
            );
            lines.push(h ? `  you hold ${h.valueUsdg} USDG of it` : `  you hold none of it`);
            const basis = await desk.basisFor?.(symbol).catch(() => null);
            if (basis) lines.push(`  ${basis}`);
            lines.push(
              d
                ? `  depth: ${d.buyUsdg} USDG buyable / ${d.sellUsdg} USDG sellable before moving it 0.5%` +
                  `${d.supportUsd === null ? "" : `, support near ${d.supportUsd}`}` +
                  `${d.resistanceUsd === null ? "" : `, resistance near ${d.resistanceUsd}`}`
                : `  depth: not read — unknown, not zero`,
            );
            return lines.join("\n");
          },
          recall: desk.recall,
          ...(desk.readLink ? { readLink: desk.readLink } : {}),
          ...(desk.readPeer ? { readPeer: desk.readPeer } : {}),
        };
        const r = await runDesk({
          creds: desk.creds,
          signals,
          world,
          links: desk.links?.(),
          peers: desk.peers?.(),
          maxSteps: desk.maxSteps,
          note,
        });
        actions = r.actions;
        thesis = r.thesis;
        note("ok", `desk: ${r.steps} model call(s), ${actions.length} action(s) proposed`);
      } else {
        let raw: unknown;
        try {
          raw = await cfg.driver.propose(signals);
        } catch (e) {
          note("warn", `strategist driver failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
        const parsed = parseProposals(raw);
        actions = parsed.actions;
        malformed = parsed.malformed;
        if (malformed > 0) note("warn", `strategist emitted ${malformed} malformed action(s) — dropped`);
      }

      const { intents, accepted, rejected } = proposalsToIntents(actions, universeNow, snap);

      // Journal the decision BEFORE the intent leaves for the policy wall: every
      // survivor gets a decisionId stamped onto its intent (so the resulting trade
      // links back), every drop is recorded with its reason. This is the join key
      // that makes "did that reasoning make money" answerable later.
      if (cfg.onDecision) {
        const signalsJson = JSON.stringify(signals);
        const base = { source: "strategist" as const, strategy: name, provider: cfg.provider, model: cfg.model, signals_json: signalsJson };
        for (let i = 0; i < intents.length; i++) {
          const intent = intents[i];
          const a = accepted[i];
          if (!intent || !a) continue; // parallel arrays — invariant, but keep TS + runtime safe
          const id = randomUUID();
          intent.decisionId = id;
          await cfg.onDecision({ ...base, id, symbol: a.symbol, action: a.action, size_usdg: a.sizeUsdg, reason: a.reason });
        }
        for (const r of rejected) {
          await cfg.onDecision({ ...base, id: randomUUID(), dropped_rule: r });
        }
        // THE VIEW ITSELF, as its own row.
        //
        // Without this a window where the agent decided to do NOTHING left no
        // trace anywhere: a hold never becomes an intent, never becomes a
        // rejection, and never reaches the note loop — so an agent that
        // reasoned its way to 'stay flat, and here is why' was silent. This is
        // the row that lets it speak without trading, and it carries no symbol
        // or action because it is about the book, not about one name.
        if (thesis) {
          await cfg.onDecision({ ...base, id: randomUUID(), reason: thesis });
        }
      }

      if (thesis) note("ok", `strategist: ${thesis}`);
      for (const r of rejected) note("warn", `strategist proposal dropped: ${r}`);
      for (const a of actions) {
        if (a.action !== "hold" && a.reason) {
          note("ok", `strategist: ${a.action} ${a.sizeUsdg} USDG ${a.symbol} — ${a.reason}`);
        }
      }

      // ── AND WHEN IT PROPOSED NOTHING, SAY SO ────────────────────────────
      //
      // THE HOLE `all-legs-stale` WAS WRITTEN TO CLOSE, LEFT OPEN ON THE RAIL
      // THAT MATTERS MORE. This returned a bare `TradeIntent[]`, so the `idle`
      // field the basket uses was not even representable here — and a window
      // where the model looked at the book and held everything wrote zero
      // decision rows, zero events and zero log lines. Byte-for-byte identical
      // to a window that never opened, to a model call that failed and was
      // retried, and to a healthy agent between decision intervals. On the
      // strategy that is supposed to BE the autonomous buy/sell path.
      //
      // Counts only — no prose, no symbols — so it publishes by the same rule
      // as every other `Why`. The model's own words already have their own
      // path: `thesis` becomes a decision row above, capped and scanned.
      //
      // Not reported when a `thesis` was written: that row IS the agent saying
      // what it decided, and two rows for one silence is the duplication the
      // de-duplication upstream exists to avoid.
      const held = actions.filter((a) => a.action === "hold").length;
      const idle: Why | undefined =
        intents.length === 0 && !thesis && (actions.length > 0 || rejected.length > 0)
          ? { code: "model-held", held, considered: actions.length, dropped: rejected.length }
          : undefined;
      return idle ? { intents, why: intents.map(() => null), idle } : intents;
    },
  };
}
