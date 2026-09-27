import type { Metadata } from "next";
import Link from "next/link";
import { TokenCA } from "@/components/TokenCA";

export const metadata: Metadata = {
  title: "$MERRYMEN — energy and the Merry Circle",
  description:
    "What holding $MERRYMEN does: full daily energy for a hosted agent, a lower platform fee, a holder tier, a vote on the roadmap, and a bonus strategy pack. Utility only.",
};

/**
 * Utility only. No price, no returns, no buyback/burn. On the hosted service the
 * token buys CAPACITY (energy) as well as perks — say so plainly (token.ts
 * STANCE). Tier numbers mirror packages/core/src/token.ts and energy's
 * packages/core/src/energy.ts (the single sources of truth the dashboard reads
 * on-chain); keep them in sync.
 */
const TIERS = [
  {
    emoji: "🌱",
    name: "Villager of Sherwood",
    min: "10,000",
    discount: "10% off",
    perks: ["10% off the platform performance fee", "Circle badge in your dashboard", "1× vote on the roadmap"],
  },
  {
    emoji: "🏹",
    name: "Merry Man",
    min: "100,000",
    discount: "25% off",
    perks: [
      "25% off the platform performance fee",
      "The bonus strategy pack (Even Keel + Dip Hunter)",
      "3× vote on the roadmap",
      "Priority in the queue",
    ],
  },
  {
    emoji: "👑",
    name: "Lord of Sherwood",
    min: "1,000,000",
    discount: "50% off",
    perks: [
      "50% off the platform performance fee — the lowest we offer",
      "Every bonus strategy + early access to new ones",
      "10× vote on the roadmap",
      "First look at features before they ship",
    ],
  },
];

export default function TokenPage() {
  return (
    <div className="wrap" style={{ maxWidth: 820, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Energy and the Merry Circle</h1>
        <p className="doc-lead">
          What <strong>$MERRYMEN</strong> does — and, just as importantly, what it doesn&apos;t.
        </p>

        <div className="callout">
          <strong>$MERRYMEN is your agent&apos;s energy.</strong> When the hosted service gates energy (an
          operator switch, off until it is turned on), an agent runs at full strength while your wallet
          and its own account hold 100,000 $MERRYMEN between them.
          Without it, it still runs — on about a tenth of a normal day of paid AI reviews and new trades
          it opens on its own, resetting at 00:00 UTC. Stop-losses, take-profits and your own orders are
          never limited; its own AI reviews, including of its open positions, are paced with the rest.
          merrymen stays open source and self-hostable, and a self-hosted install is
          never gated. There is no price talk, no promise of returns, no buyback or burn here. Just
          utility you can verify on-chain.
        </div>

        <h2>Energy: how to top up</h2>
        <p>
          Send $MERRYMEN on Robinhood Chain to your agent&apos;s account (or keep it in your own linked
          wallet — both count). Or send the agent USDG and ask it in chat to get its $MERRYMEN: you
          confirm the most it may spend, and it sizes the buy to cover what is missing, with a small
          margin for price movement (at least $1.00), over one pinned Uniswap route (USDG → VIRTUAL →
          $MERRYMEN), inside the limits you signed. The pool fees and the token&apos;s own tax are paid
          out of the USDG. Its key can buy $MERRYMEN into its
          own account and can never sell or send it; only your owner key moves it out.
        </p>

        <h2>The one that matters: a lower fee</h2>
        <p>
          merrymen charges a performance fee — and only ever on <em>profit above your high-water
          mark</em> (never on your deposit, never on a loss, never on merely recovering a past peak).
          Holding $MERRYMEN lowers that fee by your tier&apos;s discount. It&apos;s applied to the real
          accrual in the worker and shown live in your dashboard&apos;s Merry Circle panel — so the perk
          is in the ledger, not just on this page.
        </p>

        <div className="tier-grid">
          {TIERS.map((t) => (
            <div key={t.name} className="tier-card">
              <div className="tier-emoji">{t.emoji}</div>
              <div className="tier-name">{t.name}</div>
              <div className="tier-min">
                {t.min}+ <span className="tier-sym">$MERRYMEN</span>
              </div>
              <div className="tier-discount">{t.discount} fees</div>
              <ul className="tier-perks">
                {t.perks.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <h2>A say in where the band rides</h2>
        <p>
          Holders steer the roadmap — which stock tokens join the basket, which strategies ship next,
          and how the fee parameters are set. Your tier is your vote weight. Open proposals and how
          voting works live on the{" "}
          <Link className="link" href="/governance">
            governance page
          </Link>
          .
        </p>

        <h2>The bonus strategy pack</h2>
        <p>
          Merry Man tier and up unlock holder-only strategies, on top of every free one:
        </p>
        <ul>
          <li>
            <strong>Even Keel</strong> — keeps your basket at equal weight, trimming what&apos;s run
            ahead and topping up what&apos;s lagged, to harvest mean reversion instead of only ever
            buying.
          </li>
          <li>
            <strong>Dip Hunter</strong> — concentrates each tick&apos;s budget on the one basket token
            that&apos;s fallen furthest below its recent high.
          </li>
        </ul>
        <p>
          They&apos;re selectable by anyone but only <em>run</em> for holders — the worker checks your
          tier each tick. The free strategies (steady-basket, weekend-gap, the LLM strategist, and any
          you write yourself) are never gated.
        </p>

        <h2>How to join</h2>
        <ol>
          <li>Hold $MERRYMEN in any wallet you control on Robinhood Chain.</li>
          <li>
            In the dashboard, open the <strong>Merry Circle</strong> panel and paste that wallet
            address (or set <code className="inline">holderAddress</code> in settings).
          </li>
          <li>
            That&apos;s it — merrymen reads the balance <strong>read-only</strong> to set your tier. It
            never asks for, and never touches, that wallet&apos;s keys.
          </li>
        </ol>

        <h2>The token, on-chain</h2>
        <p>
          $MERRYMEN lives on Robinhood Chain — the same chain the agents trade — and was launched via
          Virtuals. Verify it yourself:
        </p>
        <div style={{ margin: "16px 0 8px" }}>
          <TokenCA />
        </div>

        <div className="callout danger" style={{ marginTop: 32 }}>
          Nothing here is financial advice or a solicitation to buy anything. $MERRYMEN is a utility
          token for perks and access; it is not an investment, and no return is promised or implied.
          Digital assets are volatile and can lose all value. See the{" "}
          <Link className="link" href="/terms">
            terms
          </Link>
          .
        </div>
      </article>
    </div>
  );
}
