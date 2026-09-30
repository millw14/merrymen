import { useState } from "react";
import { agentNameForSlug, DEFAULT_AGENT_NAME } from "@merrymen/core";

/**
 * "NAME YOUR AGENT", ONE TAP, ON THE AGENT'S OWN HEADER.
 *
 * Every agent that never reached the name field is "Robin", and nothing in the
 * terminal ever said so — the owner saw their agent's name and had no reason
 * to think a dozen others wore it too. This offers the name its slug would
 * have been given at signup (packages/core agent-name.ts), so the owner who
 * taps it gets the same name the grants route gives new agents.
 *
 * AN OFFER, NEVER AN ACTION TAKEN FOR THEM. Existing agents are not renamed
 * behind their owners' backs; this is where an owner decides to. "Choose my
 * own" goes to Settings, where the name field is; "Keep Robin" is for an owner
 * who meant it, and is remembered in this browser so they are not asked on
 * every visit.
 *
 * NEVER A SILENT REFUSAL. The save goes through /api/settings, which applies
 * the same name rule as the soul, and whatever it says back is shown here.
 */

const KEEP_KEY = (slug: string | null) => `merrymen.keep-name.${slug ?? "unlinked"}`;

function kept(slug: string | null): boolean {
  try {
    return localStorage.getItem(KEEP_KEY(slug)) === "1";
  } catch {
    return false;
  }
}

export function NameChip({
  name,
  nameSource,
  slug,
  onSettings,
}: {
  name: string;
  /** Where the feed read the name. See below. */
  nameSource: "settings" | "ledger" | "fallback" | null;
  slug: string | null;
  onSettings: () => void;
}) {
  const [state, setState] = useState<{ kind: "offer" } | { kind: "saving" } | { kind: "saved"; name: string } | { kind: "error"; why: string }>({
    kind: "offer",
  });
  const [keep, setKeep] = useState(() => kept(slug));

  // Only the stock name is offered a new one. Once the feed carries the saved
  // name this renders nothing, which is how the chip leaves.
  //
  // AND ONLY A STOCK NAME THAT WAS READ. The feed also answers "Robin" when it
  // could not read the settings store or the ledger, so an agent its owner
  // named "Shogun" could be offered a generated name here, and one tap would
  // overwrite Shogun. A fallback, or a feed that does not say, offers nothing.
  if (name !== DEFAULT_AGENT_NAME || keep) return null;
  if (nameSource !== "settings" && nameSource !== "ledger") return null;
  const suggestion = slug ? agentNameForSlug(slug) : null;

  if (state.kind === "saved") {
    return (
      <p className="meta" role="status">
        Named {state.name}. It answers to it from its next tick.
      </p>
    );
  }

  const save = async (agentName: string) => {
    setState({ kind: "saving" });
    try {
      const put = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!put.ok) {
        const j = (await put.json().catch(() => null)) as { errors?: string[]; error?: string } | null;
        throw new Error(j?.errors?.join(" ") || j?.error || `that was refused (${put.status})`);
      }
      setState({ kind: "saved", name: agentName });
    } catch (e) {
      // A thrown fetch is a network failure, not a refusal, and says so.
      const why = e instanceof TypeError ? "The name could not be saved — check your connection and try again." : e instanceof Error ? e.message : "The name could not be saved.";
      setState({ kind: "error", why });
    }
  };

  const keepIt = () => {
    try {
      localStorage.setItem(KEEP_KEY(slug), "1");
    } catch {
      /* this browser will ask again next visit; nothing worse */
    }
    setKeep(true);
  };

  return (
    <div className="asks name-chip" role="group" aria-label="Name your agent">
      {suggestion ? (
        <>
          <button type="button" className="ask-chip" disabled={state.kind === "saving"} onClick={() => void save(suggestion)}>
            {`Name your agent: ${suggestion}`}
          </button>
          <button type="button" className="ask-chip" onClick={onSettings}>
            Choose my own
          </button>
        </>
      ) : (
        // No public id yet, so no seed for a suggestion — the name field is
        // the only honest offer.
        <button type="button" className="ask-chip" onClick={onSettings}>
          Name your agent
        </button>
      )}
      <button type="button" className="ask-chip" onClick={keepIt}>
        {`Keep ${DEFAULT_AGENT_NAME}`}
      </button>
      {state.kind === "error" && (
        <p className="meta" role="alert">
          {state.why}
        </p>
      )}
    </div>
  );
}
