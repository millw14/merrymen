import { Logo } from "./Logo";

/** Illustrative product workflow; no invented portfolio balances or live metrics. */
export function AgentPreview() {
  return <div className="agent-preview" aria-label="Illustration of the Merrymen agent workflow">
    <div className="preview-bar"><span><Logo size={17} /> YOUR MERRYMAN</span><span>PRODUCT PREVIEW</span></div>
    <div className="preview-agent"><div className="preview-avatar"><Logo size={38} /></div><div><span>Your next move,</span><h2>on your terms.</h2></div></div>
    <div className="preview-chart" aria-hidden><svg viewBox="0 0 480 125" fill="none"><path d="M0 25H480M0 65H480M0 105H480" stroke="currentColor" strokeDasharray="2 7"/><path d="M0 96L24 96L42 77L68 90L92 62L119 70L142 45L169 64L197 59L219 83L241 48L268 54L291 26L313 43L342 32L369 53L392 21L418 30L443 14L480 14" stroke="var(--lime)" strokeWidth="2.5"/><circle cx="443" cy="14" r="5" fill="var(--lime)"/></svg><span>A STRATEGY. A SET OF LIMITS. YOUR CALL.</span></div>
    <div className="preview-controls"><div><span>01 / STRATEGY</span><strong>You choose the approach</strong></div><div><span>02 / PERMISSIONS</span><strong>You set the boundaries</strong></div></div>
    <div className="preview-chat"><span className="preview-chat-label">ASK YOUR AGENT</span><p>“Explain your next move.”</p><div className="preview-answer"><Logo size={15}/><span>Follow its reasoning.<br/>Stay in control.</span><b aria-hidden>↗</b></div></div>
    <div className="preview-footer"><i/> Built around your wallet. Bounded by your rules.</div>
  </div>;
}
