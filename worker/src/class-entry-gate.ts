/**
 * THE CLASS ROUTE'S ENTRY GATE, AND WHAT IT SAYS WHEN IT CLOSES.
 *
 * Under a tripped breaker the tick stops asking the class route for entries:
 * every one would be a buy the wall refuses, and the exits are never withheld.
 * That gate said nothing. The strategy's own breaker reason is raised only by
 * a strategy that has legs to buy (steady-basket reports it only when
 * `legs.length > 0`), so an agent whose class route is the buyer and whose
 * strategy has no legs — Crypto only over an equities basket, with a Pons vault
 * sealed in — went silent under the breaker with no reason on any surface: the
 * exact symptom the idle channel's breaker warning exists to end.
 *
 * So the gate decides both halves in one place: whether class entries are
 * proposed this tick, and the idle reason the tick hands the owner. Under a
 * tripped breaker that reason is the breaker's whenever anything would have
 * bought — the same Why, so it rides the same warning (idle-notice.ts) and
 * never becomes a post.
 */
import type { AssetMode } from "../../packages/core/src/index";
import type { IdleChannel } from "./idle-notice";
import type { Why } from "./strategies/reasons";
import { breakerIdle, breakerTripped, type Snapshot, type Tick } from "./strategies/types";

/**
 * Would the class route look for an entry at all? The same first gates
 * proposeClassEntries returns NO_CLASS on (index.ts), from the same inputs, so
 * the idle reason does not claim a route the proposer would not have run.
 * Paper cannot simulate a class fill; stocks-only excludes a route whose every
 * entry is a launchpad coin; and without a vault sealed into the signature
 * there is no route. The switch and the size are NOT here: those say do not
 * buy, not do not look, and the breaker is still why nothing is bought.
 */
export function classRouteLooks(s: { paper: boolean; assetMode: AssetMode; vault: string | null | undefined }): boolean {
  return !s.paper && s.assetMode !== "stocks" && !!s.vault;
}

export function classEntryGate(input: {
  snap: Pick<Snapshot, "drawdown">;
  /** classRouteLooks, for this tick. */
  routeLooks: boolean;
  /** The strategy's own idle reason, if it gave one. */
  idle: Why | null | undefined;
  /**
   * TODAY'S ENERGY still allows a new trade (worker/src/energy.ts). False only
   * while the gate is enforcing on a low-energy agent whose new trades for the
   * UTC day are used up; absent means yes, which is every existing caller.
   *
   * It closes the ENTRIES and says nothing of its own: the owner hears about
   * energy once a day through its own dated notice, not through the idle
   * channel, which would restate a non-breaker warning every ten minutes.
   */
  entriesOpen?: boolean;
}): { propose: boolean; idle: Why | null | undefined } {
  if (!breakerTripped(input.snap)) return { propose: input.entriesOpen !== false, idle: input.idle };
  // TRIPPED, THE BREAKER'S REASON WINS over any other a strategy gave. Not
  // every builtin ranks it first: even-keel says its feeds are stale, and
  // dip-hunter that the cash is short of one buy or the day's count is spent,
  // before either reads the brake — so an owner was told, at ok and as a
  // public post, "Add funds or lower the size per trade", which would not have
  // bought anything: the wall refuses every buy until the book recovers. A
  // reason the strategy gave means it would have bought; with none, only a
  // class route that would have looked is a buyer the breaker stopped.
  return { propose: false, idle: input.idle || input.routeLooks ? breakerIdle(input.snap) : undefined };
}

/**
 * THE TICK'S IDLE WRITE AND THE CLASS ROUTE'S ENTRY GATE, AS ONE CALL.
 *
 * main() ran the gate, handed the idle channel the gate's reason, and asked
 * the class route for entries only when the gate allowed it — three argument
 * lists no test could reach, so reverting any of them left every test green.
 * This is those lines: main() calls it where the idle write was, and calls
 * `entries` where the class entries are proposed, after the exits, which
 * spend the tick's budget first.
 *
 * The breaker as this tick measured it goes to the channel too, so a trip the
 * owner was told about is taken down on the tick it measures clear.
 */
export async function idleAndClassGate(input: {
  channel: Pick<IdleChannel, "tell">;
  agentId: string;
  strategyName: string;
  snap: Pick<Snapshot, "drawdown">;
  /** classRouteLooks, for this tick. */
  routeLooks: boolean;
  /** The strategy's own idle reason, if it gave one. */
  idle: Why | null | undefined;
  /** modeEmptiedFact, for this tick. */
  modeEmptied: string | null;
  /** See classEntryGate. Absent means yes. */
  entriesOpen?: boolean;
}): Promise<{ entries(propose: () => Promise<Tick>): Promise<Tick> }> {
  const gate = classEntryGate({
    snap: input.snap,
    routeLooks: input.routeLooks,
    idle: input.idle,
    ...(input.entriesOpen === undefined ? {} : { entriesOpen: input.entriesOpen }),
  });
  await input.channel.tell({
    agentId: input.agentId,
    strategyName: input.strategyName,
    idle: gate.idle,
    modeEmptied: input.modeEmptied,
    drawdown: input.snap.drawdown,
  });
  return {
    // Not while the breaker is tripped: every class entry is a buy the wall
    // would refuse. Nor once today's energy for new trades is used up. The
    // exits are never withheld.
    entries: async (propose) => (gate.propose ? propose() : { intents: [], why: [] }),
  };
}
