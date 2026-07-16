import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Governance — the Merry Circle",
  description:
    "How $MERRYMEN holders steer the merrymen roadmap: tier-weighted signalling on which tokens join the basket, which strategies ship, and how fees are set.",
};

const WEIGHTS = [
  { emoji: "🌱", name: "Villager of Sherwood", weight: "1× vote" },
  { emoji: "🏹", name: "Merry Man", weight: "3× vote" },
  { emoji: "👑", name: "Lord of Sherwood", weight: "10× vote" },
];

// Illustrative open proposals — the kind of thing holders decide. Not a live tally.
const PROPOSALS = [
  {
    tag: "Basket",
    title: "Add a token to the default basket",
    body: "Which Robinhood-Chain stock token should join the default equal-weight basket next — e.g. NVDA, TSLA, or an ETF like SPY?",
  },
  {
    tag: "Strategy",
    title: "Promote a community strategy to a builtin",
    body: "Which well-tested community strategy should ship as a first-class builtin (or as the next Merry Circle bonus strategy)?",
  },
  {
    tag: "Parameters",
    title: "Tune the tier thresholds & discounts",
    body: "Should the Circle tier thresholds or their fee discounts change as the holder base grows?",
  },
];

export default function GovernancePage() {
  return (
    <div className="wrap" style={{ maxWidth: 820, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Governance</h1>
        <p className="doc-lead">
          The band rides where the Circle points it. $MERRYMEN holders steer the roadmap; your tier is
          your weight.
        </p>

        <div className="callout">
          <strong>Straight about the mechanism:</strong> governance today is a <em>signalling</em>{" "}
          process, not binding on-chain execution. Proposals are posted here and in the holders&apos;
          channel; holders weigh in by tier; the maintainers publish the result and ship it. Moving
          the tally fully on-chain (Snapshot-style, read from your balance) is on the roadmap — and
          this page will say so the day it changes.
        </div>

        <h2>What holders decide</h2>
        <ul>
          <li>
            <strong>The basket</strong> — which stock tokens make up the default equal-weight universe.
          </li>
          <li>
            <strong>Strategies</strong> — which community strategies get promoted to builtins, and
            what joins the Merry Circle bonus pack.
          </li>
          <li>
            <strong>Parameters</strong> — tier thresholds, fee discounts, and other tunables in{" "}
            <code className="inline">packages/core</code>.
          </li>
        </ul>

        <h2>Vote weight by tier</h2>
        <div className="tier-grid">
          {WEIGHTS.map((w) => (
            <div key={w.name} className="tier-card compact">
              <div className="tier-emoji">{w.emoji}</div>
              <div className="tier-name">{w.name}</div>
              <div className="tier-discount">{w.weight}</div>
            </div>
          ))}
        </div>
        <p style={{ marginTop: 8 }}>
          Weight is read from the $MERRYMEN balance at your holder wallet — verifiable, not
          self-reported. See the tiers in full on the{" "}
          <Link className="link" href="/token">
            token page
          </Link>
          .
        </p>

        <h2>Open proposals</h2>
        <p>Examples of what&apos;s on the table. Each round runs for a set window, then results ship.</p>
        <div className="gov-list">
          {PROPOSALS.map((p) => (
            <div key={p.title} className="gov-item">
              <span className="gov-tag">{p.tag}</span>
              <div>
                <div className="gov-title">{p.title}</div>
                <p className="gov-body">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

        <h2>How to take part</h2>
        <ol>
          <li>Hold $MERRYMEN and set your holder wallet in the dashboard&apos;s Merry Circle panel.</li>
          <li>
            Join the discussion on{" "}
            <a className="link" href="https://x.com/MerrymenAI" target="_blank" rel="noreferrer">
              X
            </a>{" "}
            and in the holders&apos; channel, and weigh in on the open round.
          </li>
          <li>Results and the reasoning behind each decision are published back here.</li>
        </ol>

        <div className="callout danger" style={{ marginTop: 32 }}>
          Participation in governance is a community perk, not an investment, and confers no share of
          revenue, profit, or ownership. Nothing here is financial advice. See the{" "}
          <Link className="link" href="/terms">
            terms
          </Link>
          .
        </div>
      </article>
    </div>
  );
}
