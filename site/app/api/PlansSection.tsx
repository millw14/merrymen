import { EXPLORER } from "../../lib/chain";
import { TOKEN, group, paymentsReady, priceLabel, type PlansView } from "../../lib/developer-billing";

/**
 * The public Plans section (#plans), signed in or not.
 *
 * No hooks, so the /api page renders it on the server from GET /plans and the
 * console re-renders it with the same data. Copy rules: prices, requests and
 * rates only. No fiat amounts, no "value", nothing about what paying does to
 * the token: what leaves a developer's wallet is a payment for API capacity.
 */
export function PlansSection({ plans }: { plans: PlansView }) {
  const ready = paymentsReady(plans), days = plans.period_days;
  // What the gateway does now: with billing off (or unknown) nothing is counted; only enforce
  // puts an account's keys in one per-minute bucket (off and observe keep one per key).
  const counted = plans.source === "live" && plans.billing.mode !== "off", shared = plans.billing.enforced;
  return <section id="plans" className="dev-section" aria-labelledby="plans-title">
    <div className="dev-section-heading"><div><p className="dev-eyebrow">02 / PLANS</p><h2 id="plans-title">Start free. Grow into a plan.</h2></div><span className="dev-pill">{ready ? `PER ${days} DAYS` : "PAID PLANS COMING SOON"}</span></div>
    <p className="dev-description">{counted ? <>Every API request counts toward your plan; <code>/meta</code> is free.</> : <>Once plans open, every API request counts toward your plan; <code>/meta</code> stays free.</>} Paid plans are paid in $MERRYMEN on Robinhood Chain from the wallet you sign in with.</p>
    <div className="dev-plans">{plans.plans.map(plan => <article className="dev-plan" key={plan.id} aria-label={`${plan.name} plan`}>
      <h3>{plan.name}</h3>
      <p className="dev-plan-price">{priceLabel(plan)}<small>{plan.price_raw === "0" ? "no payment" : `per ${days} days`}</small></p>
      <ul><li><strong>{group(plan.requests)}</strong> requests per {days} days</li><li><strong>{plan.rpm}</strong> requests a minute, shared by your keys{shared ? "" : " once quotas are enforced"}</li></ul>
    </article>)}</div>
    {ready
      ? <div className="dev-plans-cta"><a className="dev-primary" href="#api-keys">Choose a plan ↗</a><span>Sign in, create your developer account, then pick a plan in your workspace.</span></div>
      // Billing on but nowhere to pay yet: the workspace already lets a plan be chosen, so do not say nothing can happen.
      : plans.source === "live" && plans.billing.mode !== "off"
        ? <p className="dev-plans-note" role="note">Paid plans are coming soon. Until payments open there is nothing to send; a plan chosen in your workspace waits until it can be paid.</p>
        : <p className="dev-plans-note" role="note">Paid plans are coming soon. Until they open, nothing is charged and there is nothing to send.{plans.source === "fallback" ? " These are the published plans; live details could not be loaded just now." : ""}</p>}
    {ready && !plans.billing.enforced && <p className="dev-plans-note" role="note">Requests are counted against each plan but not yet refused when a plan runs out.</p>}
    <p className="dev-small-print">API plans are paid, unlike the Merry Circle, which you join by holding. Paying moves MERRYMEN out of your wallet, and Merry Circle tiers and hosted energy follow the balance you hold. <a href={`${EXPLORER}/token/${TOKEN.address}`} target="_blank" rel="noreferrer">$MERRYMEN token contract ↗</a></p>
  </section>;
}
