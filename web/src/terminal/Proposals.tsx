import { useCallback, useEffect, useState } from "react";
import type { Proposal, ProposalsResponse } from "@/app/api/proposals/route";
import { compactUsd } from "../lib/format";

/**
 * THE BASKET AS IT STANDS, WHICH IS NOT THE SAME AS THE BASKET THEY TYPED.
 *
 * `values.basketSymbols` is only set once an owner has EDITED their basket.
 * For everyone else it is undefined and the agent trades `defaults` — the
 * ~24-symbol equity basket — implicitly. Reading `values.basketSymbols ?? []`
 * therefore did not read "no basket", it read "the default basket" as empty,
 * and the read-modify-write below then PUT an explicit basket containing only
 * the coin just approved. Approving one memecoin silently narrowed the agent's
 * whole universe to that memecoin, for every owner who had never opened the
 * basket editor — which is most of them, because the default is the point.
 *
 * The same "absent is not empty" rule the rest of this repo is built on. An
 * unset basket is a question nobody answered, and the answer is the default.
 */
const basketNow = (s: {
  values?: { basketSymbols?: unknown[] };
  defaults?: { basketSymbols?: unknown[] };
}): string[] => (s.values?.basketSymbols ?? s.defaults?.basketSymbols ?? []) as string[];

/** Which proposal set the owner folded away. One key: only one set is live at a time. */
const FOLD_KEY = "merrymen.proposals.folded.v1";

/**
 * YOUR AGENT ASKING FOR SOMETHING.
 *
 * THE CIRCULARITY. A discovered coin is unpriceable because it is not watched,
 * and it cannot be watched until somebody adds it by hand: open Settings, paste
 * an address, find its symbol and decimals, save, go to the basket, add the
 * symbol, then re-sign. The scout finds coins every ten minutes and every one
 * of them dies at the wall as `asset-allowlist`, while the owner never learns
 * the fix was theirs to make.
 *
 * ── WHY THIS IS ONE TAP AND THEN THE RE-SIGN, RATHER THAN ONE TAP ─────────
 *
 * It would be easy to make this button sign. It would also be the exact hole
 * Wallet.tsx documents having already closed once:
 *
 *   "This button used to call renewKey() directly with `disabled={renewing}` as
 *    its only guard — which became a hole the moment the panel below gained a
 *    chain move: tick 'move to real money' down there, scroll up, press this,
 *    and you re-signed onto mainnet with no acknowledgement and no change diff,
 *    under a banner promising 'the same caps'. Duplicating the guard would work
 *    until the next guard is added to one copy and not the other. ONE SIGNING
 *    CONTROL, ONE SET OF CONDITIONS, and everything else points at it."
 *
 * So this does the half that needs no signature — writing the token into
 * settings and its symbol into the basket, both authenticated as the tenant —
 * and then points at the one signing control, which already re-reads settings
 * at click time precisely so a just-added token is covered.
 *
 * That is the honest floor, not a compromise to be optimised away later. A
 * re-sign is a real authorisation: it re-seals the permission around the WHOLE
 * token list, and the owner is entitled to see the control that does it.
 *
 * ── AND WHAT APPROVING ACTUALLY MEANS ────────────────────────────────────
 *
 * Two separate facts, both said out loud on the card, because neither is
 * obvious and both are how somebody ends up surprised:
 *
 *   1. `grantTokens` is minted from ALL of `customTokens` with no per-token
 *      opt-in (session.ts:403), so re-signing for one coin re-authorises every
 *      coin already in settings. The count comes from the route.
 *   2. A coin still on its launch curve has NO POOL. The wall can cover the
 *      token and a swap still has nowhere to route — TokenCards calls these
 *      "two different noes" and puts the curve one first, because "add it to a
 *      grant" is advice that does not work there.
 */

type State =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ok"; body: ProposalsResponse };

export function Proposals({ onResign }: { onResign: () => void }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  /** Which token is mid-write, so one card can be busy without freezing the rest. */
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  /**
   * Which proposal set the owner has folded away, and this view's override.
   *
   * Read once on mount rather than at render: localStorage throws in a private
   * window and on a browser set to block site data, and a panel that crashes
   * the chat screen because it could not remember a fold is a far worse trade
   * than a panel that opens when it should have stayed shut.
   */
  const [foldedSig, setFoldedSig] = useState<string | null>(null);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setFoldedSig(localStorage.getItem(FOLD_KEY));
    } catch {
      /* no memory of folds here; the panel simply opens */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/proposals", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ProposalsResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((body) => alive && setState({ kind: "ok", body }))
      .catch(() => alive && setState({ kind: "failed" }));
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Add the coin to settings and to the basket, in ONE authenticated write.
   *
   * SETTINGS AND BASKET TOGETHER, because they mean different things and the
   * owner just said both. registry.ts: "adding a token in settings means 'know
   * about this', putting its symbol in the basket means 'trade it'… deliberately
   * NOT automatic — a token added to be tracked must not start being bought on
   * its own." Approving a proposal IS the owner saying both, deliberately, about
   * one named coin. What stays automatic-free is that nothing did this without
   * them.
   *
   * READ-MODIFY-WRITE against settings read at click time, not at mount: an
   * owner may have changed their basket in another tab, and a stale list would
   * silently drop it.
   */
  const approve = useCallback(async (p: Proposal) => {
    setError("");
    setAdding(p.token);
    try {
      const cur = await fetch("/api/settings", { cache: "no-store" });
      if (!cur.ok) throw new Error("could not read your settings");
      const settings = (await cur.json()) as {
        values?: { customTokens?: unknown[]; basketSymbols?: unknown[] };
        defaults?: { basketSymbols?: unknown[] };
      };
      const values = settings.values ?? {};
      const tokens = (values.customTokens ?? []) as { symbol: string; address: string; decimals: number }[];
      const basket = basketNow(settings);

      const already = tokens.some((t) => String(t.address).toLowerCase() === p.token.toLowerCase());
      const nextTokens = already
        ? tokens
        : [...tokens, { symbol: p.symbol, address: p.token, decimals: p.decimals }];
      const nextBasket = basket.includes(p.symbol) ? basket : [...basket, p.symbol];

      const put = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customTokens: nextTokens, basketSymbols: nextBasket }),
      });
      if (!put.ok) {
        const j = (await put.json().catch(() => null)) as { errors?: string[] } | null;
        throw new Error(j?.errors?.join(" ") ?? `settings refused it (${put.status})`);
      }
      setAdded((prev) => new Set(prev).add(p.token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  }, []);

  /**
   * ADD EVERY COIN AT ONCE — one click, then one signature.
   *
   * The re-sign was ALREADY all-at-once: minting seals `grantTokens` from the
   * WHOLE custom-token list, so signing after five adds costs exactly one
   * signature. The adds were not — one button per coin, each disabled while
   * another was in flight — so five vetted coins meant five reads, five writes
   * and five decisions before the single signature that actually mattered.
   *
   * That is the honest answer to "a human shouldn't be needed all the time".
   * The wall can only ever widen by a signature the owner alone can make, so
   * nothing here removes a human — it removes the four round-trips that were
   * never the point, and leaves the one that is.
   *
   * ONE READ, ONE WRITE. Not a loop over `approve`: five sequential
   * read-modify-writes against the same document race each other, and the last
   * writer wins with a list built from a stale read — which would silently drop
   * coins the owner just approved.
   */
  const approveAll = useCallback(async (list: Proposal[]) => {
    setError("");
    setAdding("all");
    try {
      const cur = await fetch("/api/settings", { cache: "no-store" });
      if (!cur.ok) throw new Error("could not read your settings");
      const settings = (await cur.json()) as {
        values?: { customTokens?: unknown[]; basketSymbols?: unknown[] };
        defaults?: { basketSymbols?: unknown[] };
      };
      const values = settings.values ?? {};
      const tokens = (values.customTokens ?? []) as { symbol: string; address: string; decimals: number }[];
      const basket = basketNow(settings);

      const nextTokens = [...tokens];
      const nextBasket = [...basket];
      for (const p of list) {
        if (!nextTokens.some((t) => String(t.address).toLowerCase() === p.token.toLowerCase())) {
          nextTokens.push({ symbol: p.symbol, address: p.token, decimals: p.decimals });
        }
        if (!nextBasket.includes(p.symbol)) nextBasket.push(p.symbol);
      }

      const put = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customTokens: nextTokens, basketSymbols: nextBasket }),
      });
      if (!put.ok) {
        const j = (await put.json().catch(() => null)) as { errors?: string[] } | null;
        throw new Error(j?.errors?.join(" ") ?? `settings refused it (${put.status})`);
      }
      // Marked added only after the write the server accepted — an optimistic
      // tick on a refused PUT tells an owner their coin is covered when the one
      // thing standing between them and a trade is that it is not.
      setAdded((prev) => {
        const next = new Set(prev);
        for (const p of list) next.add(p.token);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  }, []);

  if (state.kind === "loading") return null;
  // A PROPOSAL PANEL THAT CANNOT LOAD SAYS NOTHING, rather than an error strip
  // above a working chat. Nothing is wrong with the agent, and nothing here is
  // something the owner has to act on.
  if (state.kind === "failed") return null;

  const { proposals, why, covered } = state.body;
  // Every "nothing to show" case is genuinely nothing to show — the four names
  // exist so the ROUTE can be honest, not so this panel can lecture somebody
  // about their scout on a screen they opened to talk to their agent.
  if (why !== "ok" || !proposals.length) return null;

  /**
   * COLLAPSED UNTIL ASKED FOR, and this is a layout fix as much as a copy one.
   *
   * This panel lives inside the chat screen's grid, which on a phone is a FIXED
   * height with the conversation on the only flexible row. Measured at 375px:
   * the conversation gets 394px with no banner and 220px with this one — so
   * opening a screen to talk to your agent gave you a quarter of the phone for
   * the talking and the rest to a panel you had already read. Reported as "the
   * 'your agent found 5 coins it wants to trade' just blocks the way".
   *
   * COLLAPSED, NEVER DISMISSED. The reflex is to add a close button, and it is
   * wrong here: the whole point of this panel is that the agent has found
   * something it CANNOT TRADE until the owner re-signs, and a banner somebody
   * closed is a fact nobody ever acts on. So the summary line stays — one row
   * instead of a screenful — and it says how many and whether any are already
   * waiting on a signature. Nothing is hidden; it is folded.
   *
   * AND IT REMEMBERS PER SET. `sig` is the proposal set itself, so folding it
   * away keeps it folded while the agent keeps proposing the same coins, and a
   * genuinely new find opens again. Somebody who folds this at breakfast should
   * not have it reopen every four minutes; somebody whose agent finds something
   * new should see it.
   */
  const sig = proposals.map((p) => p.token).join(",");
  const openByDefault = !foldedSig || foldedSig !== sig;
  const open = openOverride ?? openByDefault;

  if (!open) {
    return (
      <section className="proposals folded" aria-label="Coins your agent wants to trade">
        <button type="button" className="proposals-peek" onClick={() => setOpenOverride(true)}>
          <span>
            {proposals.length} coin{proposals.length === 1 ? "" : "s"} your agent wants to trade
            {added.size > 0 ? ` · ${added.size} waiting on your signature` : ""}
          </span>
          <span aria-hidden="true">Review</span>
        </button>
      </section>
    );
  }

  return (
    <section className="proposals" aria-label="Coins your agent wants to trade">
      <div className="proposals-head">
        <h3>
          Your agent found {proposals.length === 1 ? "a coin" : `${proposals.length} coins`} it wants to trade
        </h3>
        <button
          type="button"
          className="proposals-fold"
          onClick={() => {
            setOpenOverride(false);
            setFoldedSig(sig);
            try {
              localStorage.setItem(FOLD_KEY, sig);
            } catch {
              /* a browser that refuses storage folds for this view only */
            }
          }}
        >
          Fold away
        </button>
      </div>
      <p className="proposals-note">
        It can watch these already. It cannot trade them until your signed permission covers
        them — that is the wall doing its job, and only you can widen it.
      </p>
      {/* ONE CLICK FOR THE LOT, then the one signature that was always the
          point. Hidden once there is nothing left to add, and while a single
          add is in flight, so the two controls can never race the same
          document. */}
      {proposals.length > 1 && proposals.some((p) => !added.has(p.token)) && (
        <button
          type="button"
          className="proposal-add-all"
          disabled={adding !== null}
          onClick={() => approveAll(proposals.filter((p) => !added.has(p.token)))}
        >
          {adding === "all"
            ? "adding…"
            : `Add all ${proposals.filter((p) => !added.has(p.token)).length} to my watchlist`}
        </button>
      )}

      <ol className="proposal-list">
        {proposals.map((p) => (
          <li key={p.token} className="proposal">
            <div className="proposal-top">
              <b>{p.symbol}</b>
              <span className="pips" aria-label={`conviction ${p.conviction} of 5`}>
                {"▮".repeat(Math.max(1, Math.min(5, p.conviction)))}
              </span>
              {/* THE CURVE CASE FIRST, and it is not a footnote: covering the
                  token does not give a swap anywhere to route. */}
              {p.onCurve && <span className="proposal-chip">on its launch curve</span>}
            </div>
            <p className="proposal-why">{p.reason}</p>
            <p className="proposal-figs mono">
              <span>fdv {compactUsd(p.fdvUsd)}</span>
              <span>24h {compactUsd(p.volume24hUsd)}</span>
              <span>{p.buyers24h === null ? "—" : `${p.buyers24h} buyers`}</span>
            </p>
            {p.onCurve && (
              <p className="proposal-caveat">
                No pool yet. Approving lets your agent hold it, but a normal swap has nowhere to
                route until it graduates.
              </p>
            )}

            {added.has(p.token) ? (
              <p className="proposal-done" role="status">
                Added to your watchlist and basket. It is <b>not tradable yet</b> — your permission
                still has to cover it.
              </p>
            ) : (
              <button
                type="button"
                className="proposal-add"
                disabled={adding !== null}
                onClick={() => void approve(p)}
              >
                {adding === p.token ? "adding…" : p.watched ? `Add ${p.symbol} to the basket` : `Add ${p.symbol}`}
              </button>
            )}
          </li>
        ))}
      </ol>

      {error && (
        <p className="proposals-error" role="alert">
          {error}
        </p>
      )}

      {added.size > 0 && (
        <div className="proposals-next">
          <p>
            {/* THE SECOND FACT, said before they sign rather than after. */}
            One more step, and it is the one that matters: re-sign your trading permission so it
            covers {added.size === 1 ? "this coin" : "these coins"}. Re-signing is free and nothing
            moves on-chain — but it re-seals the permission around{" "}
            <b>every token in your settings</b>
            {covered > 0 ? ` (${covered} today)` : ""}, not only what you just added.
          </p>
          <button type="button" className="proposal-resign" onClick={onResign}>
            Re-sign my permission →
          </button>
        </div>
      )}
    </section>
  );
}
