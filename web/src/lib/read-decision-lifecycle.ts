import { readDecisionLifecycle, type DecisionLifecycle } from "../../../worker/src/decision-lifecycle";
import { getIdentityStore } from "../../../worker/src/identity-store";
import { isProvenance } from "../../../worker/src/provenance";
import { getSettingsStore } from "../../../worker/src/settings-store";
import { classifyDrop, publishableThesis, rejectRuleLabel } from "../../../worker/src/thesis-policy";
import { withReadDb } from "./ledger";

type Identity = { tenant: `0x${string}`; accounts: readonly string[] };

/**
 * Public lifecycle prose follows the same policy as the public feed — and so
 * do its figures.
 *
 * D1: a book that is not public publishes no dollars, and a size is dollars.
 * This route spread every trade row as it was read, so /api/decision/<id>
 * served `amount_usdg`, `fill_cash_usdg`, the filled quantity and
 * `realized_pnl_usdg` for every book — the P&L, the size and the holding the
 * feed withholds, one request away from any post's id. It now reads the
 * author's `publicBook` the way read-theses does (only an explicit `true`,
 * and an unreadable setting is private) and hands it to the gate, which
 * decides the decision's size and reason, and to `publicTrade`, which decides
 * the trade's figures. A price is not a holding and stays.
 */
export async function readPublicDecisionLifecycle(
  id: string,
  readDb: typeof withReadDb = withReadDb,
  identities: () => Promise<readonly Identity[]> = () => getIdentityStore().all(),
  settings: (tenant: `0x${string}`) => Promise<unknown> = (tenant) => getSettingsStore().get(tenant),
) {
  try {
    return await readDb(async (db) => {
      if (!db) return null;
      const life = await readDecisionLifecycle(db, id);
      if (!life || !/^0x[0-9a-f]{40}$/i.test(life.decision.agent_id)) return null;
      const owner = await db.prepare("SELECT name, x_handle, mode FROM agents WHERE LOWER(smart_account) = LOWER(?) LIMIT 1")
        .get(life.decision.agent_id) as { name: string; x_handle: string | null; mode: string } | undefined;
      if (!owner || !["live", "paper"].includes(owner.mode)) return null;
      const bookPublic = await publicBookOf(life.decision.agent_id, identities, settings);
      const last = life.trades.at(-1);
      const thesis = publishableThesis({
        ...life.decision,
        ...owner,
        status: last?.status,
        reject_rule: last?.reject_rule,
        post: life.post?.body,
        last_at: life.decision.at,
        public_book: bookPublic,
      });
      if (!thesis) return null;
      const d = life.decision;
      return {
        decision: {
          id: d.id,
          agent_id: d.agent_id,
          source: d.source,
          provenance: isProvenance(d.provenance) ? d.provenance : null,
          action: thesis.action,
          symbol: thesis.symbol,
          size_usdg: thesis.sizeUsdg,
          reason: thesis.reason,
          dropped_rule: d.dropped_rule ? classifyDrop(d.dropped_rule) : null,
          hold_kind: d.hold_kind === "MODEL_HOLD" || d.hold_kind === "GATE_FORCED_HOLD" ? d.hold_kind : null,
          at: d.at,
        },
        paper: thesis.paper,
        outcome: thesis.outcome,
        outcomeText: thesis.outcomeText,
        // A raw rejection can contain an address or model-written text. Keep a
        // recognized machine rule only; expose the policy's wording separately.
        trades: life.trades.map((t) => publicTrade(t, bookPublic)),
        post: life.post && thesis.post ? { body: thesis.post, created_at: life.post.created_at } : null,
      };
    });
  } catch {
    // Missing, unpublished and unreadable decisions have the same public shape.
    return null;
  }
}

/**
 * WHETHER THE AUTHOR'S OWNER MADE THE BOOK PUBLIC — the one settings bit that
 * leaves, read the way read-theses reads it. Anything but an explicit `true`,
 * and any failure to read it, is private: the default that publishes less.
 */
async function publicBookOf(
  account: string,
  identities: () => Promise<readonly Identity[]>,
  settings: (tenant: `0x${string}`) => Promise<unknown>,
): Promise<boolean> {
  try {
    const mine = (await identities()).find((i) => i.accounts.some((a) => a.toLowerCase() === account.toLowerCase()));
    if (!mine) return false;
    return ((await settings(mine.tenant)) as { publicBook?: unknown } | null)?.publicBook === true;
  } catch {
    return false;
  }
}

/**
 * One trade as a stranger may see it. For a book that is not public, the
 * figures a size, a holding or a P&L can be read from are null — the amount,
 * the cash the fill moved, the quantity it filled and the P&L it booked. The
 * fill's PRICE stays, as the feed's entry price does.
 */
function publicTrade(t: DecisionLifecycle["trades"][number], bookPublic: boolean) {
  const label = rejectRuleLabel(t.reject_rule);
  const hash = (value: string | null) => value && /^0x[0-9a-f]{64}$/i.test(value) ? value : null;
  const dollars = bookPublic
    ? {}
    : { amount_usdg: null, fill_cash_usdg: null, fill_qty_raw: null, realized_pnl_usdg: null };
  return {
    ...t,
    ...dollars,
    reject_rule: label ? t.reject_rule : null,
    rejection: t.status === "rejected" ? label ?? "execution was refused" : null,
    user_op_hash: hash(t.user_op_hash),
    tx_hash: hash(t.tx_hash),
  };
}
