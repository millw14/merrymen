"use client";

import { useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";

const SETUP_PROMPT = "Set up a practice Merryman for me. Check my setup first and reuse anything already prepared. Send me one link to review the setup and sign in Merrymen, then check whether it is running.";

/** The text stays visible and selectable when clipboard access is unavailable. */
function CopyField({ label, value, action }: { label: string; value: string; action: string }) {
  const labelId = useId();
  const valueRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      const element = valueRef.current;
      if (element) {
        element.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied("manual");
    }
  }

  return (
    <div className="grok-copy-field">
      <span id={labelId} className="grok-field-label">{label}</span>
      <div className="grok-copy-row">
        <code ref={valueRef} tabIndex={0} aria-labelledby={labelId}>{value}</code>
        <button className="btn btn-ghost" type="button" aria-label={action} onClick={() => void copy()}>
          {copied === "copied" ? <><Icon name="check" size={15} /> Copied</> : action}
        </button>
      </div>
      <span className="grok-copy-status" role="status" aria-live="polite">
        {copied === "copied" ? `${label} copied.` : copied === "manual" ? "Automatic copy is unavailable. The text is selected; copy it or select it manually." : ""}
      </span>
    </div>
  );
}

export function GrokQuickStart({ server }: { server: string }) {
  return (
    <section className="grok-quick-start" id="setup" aria-labelledby="grok-quick-title">
      <header className="grok-quick-heading">
        <div className="tag"><span className="n">01</span> — get connected</div>
        <h2 id="grok-quick-title">Three steps. Then just ask.</h2>
        <p>Connect your account once. Come back to the same chat whenever you need a check-in.</p>
      </header>
      <ol className="grok-quick-steps">
        <li>
          <span className="grok-step-number" aria-hidden>1</span>
          <div className="grok-step-title"><h3>Add Merrymen to Grok.</h3><p>A one-time manual step.</p></div>
          <div className="grok-step-body">
            <p>Open <strong>Plugins → Connectors → New Connector → Custom</strong>. Enter these details, then choose <strong>Add Connector</strong>.</p>
            <div className="grok-connection-fields">
              <CopyField label="Name" value="Merrymen" action="Copy name" />
              <CopyField label="Server URL" value={server} action="Copy address" />
            </div>
            <a className="grok-text-link" href="https://grok.com/connectors" target="_blank" rel="noopener noreferrer">
              Open Grok connectors <Icon name="arrow" size={16} />
              <span className="grok-sr-only"> (opens in a new tab)</span>
            </a>
            <p className="grok-quick-note">This opens settings. Asking chat to find Merrymen does not install it.</p>
          </div>
        </li>
        <li>
          <span className="grok-step-number" aria-hidden>2</span>
          <div className="grok-step-title"><h3>Make it yours.</h3><p>Your account. Your permissions.</p></div>
          <div className="grok-step-body">
            <p>Sign in to Merrymen with email or X, or create your account. Choose which Merryman and permissions to share with Grok.</p>
            <p>Want to create one from chat? Allow <strong>Prepare agent setups and suggest setting changes</strong> on the consent page.</p>
            <p className="grok-quick-note">That permission prepares proposals. You still approve the setup and wallet limits yourself.</p>
          </div>
        </li>
        <li>
          <span className="grok-step-number" aria-hidden>3</span>
          <div className="grok-step-title"><h3>Start the conversation.</h3><p>Try practice first.</p></div>
          <div className="grok-step-body">
            <p>Return to Grok and send this message. Follow its Merrymen link to review your setup and sign, then ask Grok to check the result.</p>
            <CopyField label="First message" value={SETUP_PROMPT} action="Copy setup prompt" />
            <p className="grok-quick-note">A connection or draft is only the start. The fresh status check tells you whether your Merryman is running.</p>
          </div>
        </li>
      </ol>
    </section>
  );
}
