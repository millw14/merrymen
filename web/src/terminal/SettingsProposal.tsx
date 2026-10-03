"use client";
/**
 * TELL YOUR AGENT HOW TO WORK — AND APPROVE WHAT THAT CHANGES, IN ONE TAP.
 *
 * Asked for by an owner: "a user should be able to tell their agent how they
 * want it to work and it converts that into settings then just asks for a
 * button's approval". This is the top of the Settings page doing exactly that,
 * for every setting the page has, and the landing spot for the "Review &
 * approve" button the agent sends from Telegram (or proposes in Chat) when a
 * change is one only the dashboard may make.
 *
 * TWO WAYS IN, ONE PANEL:
 *   - typed here: read in the browser by packages/core's catalog
 *     (understandSettingsText), no model and no network until Approve;
 *   - a link (?propose=…): the agent's proposal, decoded and re-validated
 *     against the same catalog.
 *
 * A LINK IS A SUGGESTION, NEVER AN INSTRUCTION. It is unsigned — a worker has
 * no secret the web shares — so anyone could write one. Nothing changes until
 * the owner, signed in, reads the diff and taps Approve; real-money and safety
 * changes carry their warning; secrets are never carried at all. Approve calls
 * the same PUT /api/settings the Save button does, with only these keys, bound
 * to this owner, so every bound the route enforces still applies.
 */
import { useEffect, useMemo, useState } from "react";
import {
  PROPOSAL_PARAM,
  buildProposal,
  catalogEntry,
  decodeProposalLink,
  formatCatalogValue,
  riskWarning,
  understandSettingsText,
  type Proposal,
} from "@merrymen/core";

export interface SettingsProposalProps {
  /** The saved values, as GET /api/settings returned them. */
  values: Readonly<Record<string, unknown>>;
  /** The defaults, so a never-saved setting reads as what it really is. */
  defaults: Readonly<Record<string, unknown>>;
  /** The account the page was loaded for; sent with the save so it binds to them. */
  owner: string | null;
  /** Tickers a basket may name. */
  symbols: readonly string[];
  hosted: boolean;
  /** After a successful approval, so the page can re-read what is saved. */
  onApplied: () => void;
}

const EXAMPLES = ["each buy $20, stop loss 8%", "be more careful", "only trade stocks", "message me once an hour", "hunt memecoins"];

const shown = (key: string, v: unknown) => {
  const e = catalogEntry(key);
  return e ? formatCatalogValue(e, v) : String(v ?? "not set");
};

/**
 * WHAT THE AGENT IS DOING, IN FIVE LINES.
 *
 * The page below has every dial; most owners want to know a handful of things
 * — is this real money, what does it buy, how much at a time, when does it
 * sell — and had to read a long form to find them. Every value is rendered by
 * the catalog's own formatter, the same words the chat uses.
 */
export function glanceLines(v: Readonly<Record<string, unknown>>): string[] {
  const money = v.liveTradingEnabled ? "Real money: on" : v.paperTradingEnabled ? "Real money: off — practising with simulated cash" : "Real money: off";
  const buys = v.assetMode === "stocks" ? "stocks only" : v.assetMode === "crypto" ? "crypto only" : "stocks and crypto";
  return [
    money,
    `Strategy: ${shown("strategy", v.strategy)} · buys ${buys}`,
    `Each buy: ${shown("buyPerTickUsdg", v.buyPerTickUsdg)} · stop loss: ${shown("strategistStopLossBps", v.strategistStopLossBps)} · take profit: ${shown("takeProfitBps", v.takeProfitBps)}`,
    `Launchpad buying: ${v.classSnipeEnabled && Number(v.classPerEntryUsdg) > 0 ? "on" : "off"} · new-coin scanning: ${shown("discoveryEnabled", v.discoveryEnabled)}`,
    `Telegram trade messages: ${Number(v.telegramNotifyEveryMin) > 0 ? `one summary every ${v.telegramNotifyEveryMin} min` : "one per trade"}`,
  ];
}

export function SettingsProposal(props: SettingsProposalProps) {
  const current = useMemo(() => ({ ...props.defaults, ...props.values }), [props.defaults, props.values]);
  const [text, setText] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [fromLink, setFromLink] = useState(false);
  const [status, setStatus] = useState<"idle" | "applying" | "applied">("idle");
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[]>([]);

  // THE AGENT'S LINK, ONCE, after the saved values are in hand: a diff against
  // defaults would show changes that are not changes.
  useEffect(() => {
    let param: string | null = null;
    try {
      param = new URLSearchParams(window.location.search).get(PROPOSAL_PARAM);
    } catch {
      return;
    }
    if (!param) return;
    const changes = decodeProposalLink(param);
    setFromLink(true);
    setProposal(buildProposal(changes, current, { symbols: props.symbols, hosted: props.hosted }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const understand = () => {
    setError(null);
    setStatus("idle");
    setApplied([]);
    setFromLink(false);
    setProposal(buildProposal(understandSettingsText(text), current, { symbols: props.symbols, hosted: props.hosted }));
  };

  const clearLink = () => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(PROPOSAL_PARAM)) {
        url.searchParams.delete(PROPOSAL_PARAM);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      /* nothing to clear */
    }
  };

  const dismiss = () => {
    setProposal(null);
    setError(null);
    clearLink();
  };

  const approve = async () => {
    if (!proposal?.rows.length) return;
    setStatus("applying");
    setError(null);
    const body: Record<string, unknown> = Object.fromEntries(proposal.rows.map((r) => [r.key, r.after]));
    if (props.owner) body.owner = props.owner;
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; errors?: string[]; error?: string; ignored?: string[] };
      if (!res.ok || !j.ok) {
        setStatus("idle");
        setError(j.errors?.join(" ") || j.error || "Nothing was saved. Try again, or change it below.");
        return;
      }
      const ignored = new Set(j.ignored ?? []);
      setApplied(proposal.rows.filter((r) => !ignored.has(r.key)).map((r) => `${r.label}: ${r.afterText}`));
      setStatus("applied");
      setProposal(null);
      clearLink();
      props.onApplied();
    } catch {
      setStatus("idle");
      setError("Couldn't reach the server — nothing was saved.");
    }
  };

  const rows = proposal?.rows ?? [];
  const refused = proposal?.refused ?? [];
  const nothing = proposal !== null && !rows.length && !refused.length;

  return (
    <section className="mm-wrap" aria-labelledby="tell-your-agent" style={{ marginBottom: 16 }}>
      <div className="mm-section" id="tell-your-agent">Tell your agent how to work</div>
      <p className="mm-hint" style={{ marginTop: 0 }}>
        Say it in your own words and approve the changes in one tap. This works in Telegram and in Chat too — just tell
        your agent.
      </p>
      <ul className="mm-hint" aria-label="At a glance" style={{ margin: "0 0 10px", paddingLeft: 18 }}>
        {glanceLines(current).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          understand();
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          aria-label="Tell your agent how to work"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`e.g. “${EXAMPLES[0]}”`}
          style={{ flex: "1 1 260px", minWidth: 0 }}
        />
        <button className="mm-btn" type="submit" disabled={!text.trim()}>
          Show me the changes
        </button>
      </form>
      <div className="mm-chips" aria-label="Examples" style={{ marginTop: 8 }}>
        {EXAMPLES.slice(1).map((ex) => (
          <button key={ex} type="button" className="mm-chip" onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>

      {status === "applied" && applied.length > 0 && (
        <p role="status" className="mm-note">
          ✓ Saved — {applied.join(" · ")}. It takes effect within a minute.
        </p>
      )}

      {nothing && (
        <p role="status" className="mm-note">
          I couldn&apos;t find a setting to change in that. Try something like “each buy $20, stop loss 8%”, or ask your
          agent in Chat.
        </p>
      )}

      {proposal && (rows.length > 0 || refused.length > 0) && (
        <div className="mm-hint" role="region" aria-label="Proposed changes" style={{ border: "1px solid currentColor", borderRadius: 8, padding: 12 }}>
          <b>{fromLink ? "Your agent suggested these changes" : rows.length === 1 ? "Here's the change" : `Here are the ${rows.length} changes`}</b>
          {fromLink && (
            <p style={{ margin: "4px 0 0" }}>
              Check each one before approving — anyone can make a link like this, and nothing changes until you tap
              Approve.
            </p>
          )}
          {rows.length > 0 && (
            <ul style={{ margin: "8px 0", paddingLeft: 18 }}>
              {rows.map((r) => {
                const warn = riskWarning(r.risk, r.after);
                return (
                  <li key={r.key} data-key={r.key}>
                    <b>{r.label}</b>: {r.beforeText} → <b>{r.afterText}</b>
                    {warn && <div className="mm-danger">⚠️ {warn}</div>}
                  </li>
                );
              })}
            </ul>
          )}
          {refused.length > 0 && (
            <ul style={{ margin: "8px 0", paddingLeft: 18 }} aria-label="Not included">
              {refused.map((r, i) => (
                <li key={`${r.phrase}-${i}`}>
                  <b>{r.phrase}</b> — {r.reason}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="mm-danger">
              {error}
            </p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {rows.length > 0 && (
              <button className="mm-btn" type="button" onClick={approve} disabled={status === "applying"}>
                {status === "applying" ? "Saving…" : rows.length === 1 ? "Approve" : `Approve all ${rows.length}`}
              </button>
            )}
            <button className="mm-btn" type="button" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
