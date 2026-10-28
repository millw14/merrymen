import type { LiveAgent } from "./live";
import { performanceOf } from "./agent-performance";

/** One board row: the agent, its place among ranked live returns, and that return (null when it is not ranked). */
export interface BoardRow {
  agent: LiveAgent;
  /** 1-based among ranked live returns; 0 for a row that is not ranked. Board prints it only where `ret` is not null. */
  rank: number;
  ret: number | null;
}

const figure = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/**
 * THE BOARD'S ORDER, decided here and nowhere else.
 *
 * Ranked live returns first, highest first: they alone carry a rank number.
 * Then every row that shows a return without being ranked, highest first:
 * a paper book's change since its first recorded valuation, which stays
 * outside live rankings and is never numbered among them. Then the rows with
 * no return to show (No trades yet, Awaiting first valuation, gas cost not
 * yet recorded, unavailable), in the order the server sent them.
 *
 * "Shows a return" is what the row prints (performanceOf): a state such as
 * No trades yet stands in for the figure, so a book that never traded is not
 * sorted as 0.0% among books that traded and broke even.
 *
 * Before, only the live rank ordered the board. With no live return ranked
 * (every live book waiting on its gas cost), every row tied and kept the
 * server's order, live books first, so the Home preview's five rows showed no
 * figure at all while fifty-one paper books had one further down.
 */
export function boardOrder(agents: readonly LiveAgent[]): BoardRow[] {
  const rows = agents.map((agent, at) => {
    const ret = figure(agent.pnlBps);
    const performance = performanceOf(agent);
    const shown = ret ?? (performance.state === null ? figure(performance.bps) : null);
    return { agent, at, ret, shown, group: ret !== null ? 0 : shown !== null ? 1 : 2 };
  });
  rows.sort((a, b) => a.group - b.group || (a.group < 2 ? b.shown! - a.shown! : 0) || a.at - b.at);
  let ranked = 0;
  return rows.map(({ agent, ret }) => ({ agent, ret, rank: ret === null ? 0 : ++ranked }));
}
