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
import type { Snapshot, Strategy } from "../strategies/types";
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
  } | null;
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

function buildSignals(snap: Snapshot, universe: StrategistUniverse, at: Date): Signals {
  return {
    cashUsdg: Number(snap.cashUsdg) / 1e6,
    vaultUsdg: Number(snap.vaultUsdg) / 1e6,
    equityUsdg:
      Number(snap.cashUsdg + snap.vaultUsdg) / 1e6 +
      [...snap.holdings.values()].reduce((s, h) => s + Number(h.valueUsdg) / 1e6, 0),
    holdings: [...snap.holdings.entries()].map(([symbol, h]) => ({
      symbol,
      valueUsdg: Number(h.valueUsdg) / 1e6,
      priceStale: h.priceStale,
    })),
    prices: [...snap.prices.entries()]
      .filter(([symbol]) => universe.legs.has(symbol))
      .map(([symbol, p]) => ({
        symbol,
        usd: Number(p.price8) / 1e8,
        stale: p.stale,
      })),
    tradableSymbols: [...universe.legs.keys()],
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

  return {
    name,
    async tick(snap: Snapshot): Promise<TradeIntent[]> {
      if (!snap.sequencerUp) return [];
      const t = now();
      if (lastDecisionAt !== null && t - lastDecisionAt < cfg.decisionIntervalMs) return [];
      lastDecisionAt = t;

      const signals = buildSignals(snap, cfg.universe, new Date(t));

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

      // Merged HERE, not at construction, so the reserves are this tick's.
      const curve = cfg.curveLegsNow?.() ?? null;
      const universeNow: StrategistUniverse = curve
        ? {
            ...cfg.universe,
            curveLegs: curve.legs,
            curveTokens: curve.tokens,
            slippageBps: curve.slippageBps,
          }
        : cfg.universe;
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
      return intents;
    },
  };
}
