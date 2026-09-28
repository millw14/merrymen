"use client";

import { useState } from "react";
import { ENERGY } from "@merrymen/core";
import { count, usd } from "@/lib/format";
import { meterBar, type EnergyRemedies, type EnergyView } from "./energy-view";

/**
 * THE AGENT'S ENERGY, ON THE DESK — drawn from the worker's own report.
 *
 * WHY IT IS NOT THE NOTICE SLOT. The worker also writes one dated warn event
 * the first time a day's allowance runs out, and that is what iOS and Android
 * show. But a standing condition cannot be carried by a log line: the event
 * ages out of the feed's forty-row window, and a newer warn covers it. So the
 * desk renders the CONDITION from AgentStatus.energy (the agents row), true on
 * first paint, and the screen drops the same sentence from the notice slot
 * while this says it (Agent.tsx, ENERGY_NOTICE_PREFIX).
 *
 * THREE VOLUMES, because they are three different amounts of news:
 *   - low and not yet spent: one quiet line. Most agents without $MERRYMEN
 *     sit here permanently; it must never hide anything more important.
 *   - unread: the same quiet line, saying it is OUR read that failed — never
 *     that they hold nothing.
 *   - spent: the full panel, with every remedy and "or change nothing".
 *
 * WHAT IT MUST NEVER SAY. Nothing about the token's price, where it is going,
 * or returns: $MERRYMEN here is capacity and nothing else (token.ts STANCE).
 * No fee or tax percentage either — the token's own tax is set by its owner
 * and can change without a line of our code changing.
 *
 * THE ADDRESS IS PRINTED IN FULL, next to a copy button — never shortened,
 * never retyped by the model. One wrong character and the tokens are gone.
 * And it is offered only when tokens sent there would count (energyRemedies).
 *
 * "ASK ME" ONLY FILLS THE COMPOSER. It puts a request in the owner's own box
 * and sends nothing: the agent then proposes `get-energy`, the owner reads the
 * card with the amount on it, and only their click places anything.
 */
export function EnergyNote({
  view,
  remedies,
  account,
  estimateUsdg,
  onDeposit,
  onAsk,
  onResign,
}: {
  view: EnergyView;
  remedies: EnergyRemedies;
  /** The agent's account, in full — grant.smartAccount. */
  account: string | null;
  /** The worker's estimate of the USDG that would buy today's shortfall; null = unknown. */
  estimateUsdg: number | null;
  onDeposit: () => void;
  /** Fill the composer with a request. Must never send or propose anything itself. */
  onAsk: () => void;
  onResign: () => void;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");
  if (view.kind === "none") return null;
  const full = count(ENERGY.fullTokens);

  if (!view.spent) {
    if (view.kind === "unread") {
      return (
        <section className="desk-energy" role="status">
          <p>
            I couldn&apos;t read the $MERRYMEN balances yet, so I&apos;m on the reduced allowance
            until I can. That&apos;s our read failing, not your wallet.
          </p>
        </section>
      );
    }
    const reviews = view.reviews;
    const entries = view.entries;
    const used = [
      reviews ? `${count(reviews.used)} of ${count(reviews.allowed)} AI reviews` : null,
      entries ? `${count(entries.used)} of ${count(entries.allowed)} new trades` : null,
    ].filter(Boolean);
    const bars = [
      { label: "AI reviews used today", bar: meterBar(reviews) },
      { label: "New trades used today", bar: meterBar(entries) },
    ].filter((b) => b.bar !== null);
    return (
      <section className="desk-energy" role="status">
        <p>
          Low energy: without {full} $MERRYMEN between your wallet and my account I run on about a
          tenth of a standard day{used.length > 0 ? ` — ${used.join(" and ")} used today` : ""}. It
          resets at 00:00 UTC.
        </p>
        {/* NO BAR AGAINST AN ALLOWANCE NOBODY READ — the You screen's rule. */}
        {bars.map((b) => (
          <progress key={b.label} aria-label={b.label} value={b.bar!.used} max={b.bar!.allowed} />
        ))}
        <button type="button" onClick={onDeposit}>
          How to top up →
        </button>
      </section>
    );
  }

  const copyAddress = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopy("copied");
    } catch {
      setCopy("error");
    }
  };

  return (
    <section className="desk-energy spent" role="status">
      <strong>Energy spent for today — I pick up again at 00:00 UTC.</strong>
      <p>
        Without {full} $MERRYMEN between your wallet and my account I get about a tenth of a standard
        day&apos;s AI reviews and new trades. Stop-losses, take-profits and your own orders still run; my own
        AI reviews — including of my open positions — are paced along with the rest.
      </p>
      {view.kind === "unread" ? (
        <p>I couldn&apos;t read the $MERRYMEN balances — that&apos;s our read failing, not your wallet.</p>
      ) : view.total !== null ? (
        <p>
          {view.noWallet ? "My account holds" : "You and I hold"} {count(view.total)} $MERRYMEN — {count(view.short)} short.
        </p>
      ) : null}
      {remedies.sendToAgent && account ? (
        <>
          <p>Send $MERRYMEN on Robinhood Chain to my account:</p>
          <code className="funding-address">{account}</code>
          <button type="button" onClick={() => void copyAddress()}>
            {copy === "copied" ? "Address copied" : "Copy address"}
          </button>
          {copy === "error" && <p role="alert">Could not copy. Select the address above to copy it.</p>}
          {remedies.usdg === "ready" && (
            <>
              <p>
                Or send USDG to that address and ask me to get my $MERRYMEN — you&apos;ll confirm the
                amount first
                {estimateUsdg !== null ? ` (about ${usd(estimateUsdg)} of USDG at the pool's current rate)` : ""}.
              </p>
              <button type="button" onClick={onAsk}>
                Ask me to get it
              </button>
            </>
          )}
          {remedies.usdg === "paper" && (
            <p>
              I&apos;m in Paper mode, so I won&apos;t spend real USDG on it — send $MERRYMEN, or turn
              on Live trading first.
            </p>
          )}
          {remedies.usdg === "resign" && (
            <>
              <p>My key can&apos;t buy it yet — re-sign my permission (free) first.</p>
              <button type="button" onClick={onResign}>
                Re-sign my permission →
              </button>
            </>
          )}
        </>
      ) : remedies.usdg === "not-mainnet" ? (
        <p>
          My account is on another network, so $MERRYMEN sent to it would not count — keep {full} on
          Robinhood Chain in your own wallet instead.
        </p>
      ) : (
        <p>Keep $MERRYMEN on Robinhood Chain in your own wallet — it counts.</p>
      )}
      <p>Or change nothing — I carry on at this pace.</p>
    </section>
  );
}
