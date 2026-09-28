"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * LINK A WALLET THAT HOLDS $MERRYMEN, BY PROVING YOU CONTROL IT.
 *
 * "it can happen that you don't own tokens in your privy based wallet and you
 * have them somewhere else… the app should have the possibility to define the
 * holder address if it's not the 'default' privy wallet address."
 *
 * TWO WAYS TO SIGN, AND THE SECOND IS NOT A FALLBACK. An injected wallet in
 * this browser is the quick path. But the whole premise of this feature is that
 * the tokens are somewhere ELSE — which in practice means a hardware wallet, a
 * phone, or an account this browser has never seen. So the message is always
 * shown in full and a signature can always be pasted back. That path works from
 * any wallet on any device, and it is the one this was actually built for.
 *
 * NOTHING HERE IS TRUSTED. The address is recovered from the signature by
 * /api/holder; this component cannot assert who signed, only carry the bytes.
 */

interface Linked {
  address: string;
  at: number;
}

/** Which wallet the tier reads, per /api/holder PATCH; null when the server could not tell. */
type Reads = "linked" | "login" | "none" | null;

/**
 * Why the linked wallet does or does not count, per /api/holder PATCH (the
 * same claims read as `reads`); null when the server could not tell.
 */
export type ProofStanding = "counting" | "claimed-elsewhere" | "unclaimed" | null;

/**
 * THE LINKED WALLET, AND THE TRUTH ABOUT WHETHER IT COUNTS.
 *
 * "Not counting" has two causes with opposite remedies, and one sentence for
 * both sent people the wrong way. A proof with NO claim — linked before claims
 * existed and not yet backfilled, or left behind by an unlink or re-link that
 * failed half-way — belongs to nobody else: signing once more is the whole
 * fix. Telling that owner it "already powers another account — unlink it
 * there" pointed at an account that did not exist. Only a claim held by
 * another account is "powers another", and even then the wallet's own
 * signature moves it here (once in any 24 hours). Unknown says only what is known.
 */
export function LinkedWallet({
  address,
  standing,
  busy,
  onRelink,
  onUnlink,
}: {
  address: string;
  standing: ProofStanding;
  busy: boolean;
  onRelink: () => void;
  onUnlink: () => void;
}) {
  const relink = (
    <button type="button" className="copy-btn" onClick={onRelink} disabled={busy}>
      link it again
    </button>
  );
  return (
    <div className="holder-linked">
      {standing === "counting" ? (
        <p>
          Your tier reads <span className="mono">{address}</span>, proved by a signature from that wallet.
        </p>
      ) : standing === "unclaimed" ? (
        <p>
          <span className="mono">{address}</span> is linked but not counting yet. Link it again — one more
          signature from it — and it counts here.
        </p>
      ) : standing === "claimed-elsewhere" ? (
        <p>
          <span className="mono">{address}</span> is linked but not counting here: it powers another merrymen
          account right now, and a wallet powers one at a time. Link it again with a fresh signature from it to
          move it here — a wallet can move once every 24 hours, and can always come back to the account it last left — or
          link a different wallet.
        </p>
      ) : (
        <p>
          <span className="mono">{address}</span> is linked, proved by a signature from that wallet.
        </p>
      )}
      {(standing === "unclaimed" || standing === "claimed-elsewhere") && relink}
      <button type="button" className="copy-btn" onClick={onUnlink} disabled={busy}>
        unlink
      </button>
    </div>
  );
}

/**
 * WHAT AN UNLINK LEAVES THE TIER READING — said from the PATCH that follows
 * it, never assumed.
 *
 * It used to say "Your tier reads the wallet you sign in with again" every
 * time. When another account holds the claim on that login wallet (it was
 * linked or moved there), the tier reads NO wallet — and the hint above said
 * so in the same breath. `none` says what is true and what brings it back:
 * the login wallet's own signature from this account, which the once-a-day
 * limit never refuses. Unknown (the read failed) claims nothing.
 */
export function unlinkedNote(reads: Reads): string {
  if (reads === "login") return "Unlinked. Your tier reads the wallet you sign in with again.";
  if (reads === "none") {
    return (
      "Unlinked. The wallet you sign in with powers another merrymen account right now, so your tier reads no " +
      "wallet here. To bring it back, link it below with a signature from it."
    );
  }
  return "Unlinked.";
}

export function HolderLink() {
  const [linked, setLinked] = useState<Linked | null>(null);
  const [reads, setReads] = useState<Reads>(null);
  const [standing, setStanding] = useState<ProofStanding>(null);
  const [holder, setHolder] = useState("");
  const [challenge, setChallenge] = useState<{ message: string; nonce: string } | null>(null);
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  /** Re-read the link; answers which wallet the tier reads now (null when that is unknown). */
  const refresh = useCallback(async (): Promise<Reads> => {
    try {
      const r = await fetch("/api/holder", { method: "PATCH", cache: "no-store" });
      const j = (await r.json()) as { linked?: Linked | null; reads?: Reads; proof?: ProofStanding };
      setLinked(j.linked ?? null);
      setReads(j.reads ?? null);
      setStanding(j.proof ?? null);
      return j.reads ?? null;
    } catch {
      /* an unreadable link is shown as none — never as an error on a settings page */
      return null;
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Ask the server for the exact bytes this wallet must sign. */
  const start = async (address: string = holder.trim()) => {
    setError("");
    setNote("");
    setSignature("");
    setBusy(true);
    try {
      const r = await fetch(`/api/holder?holder=${encodeURIComponent(address)}`, { cache: "no-store" });
      const j = (await r.json()) as { message?: string; nonce?: string; error?: string };
      if (!r.ok || !j.message || !j.nonce) throw new Error(j.error ?? "could not start");
      setChallenge({ message: j.message, nonce: j.nonce });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Sign with an injected wallet, if this browser has one.
   *
   * `personal_sign` with the address second is the ordering every injected
   * wallet expects. A rejection here is not an error worth shouting about —
   * the paste box below still works, and somebody may simply have picked the
   * wrong account in their extension.
   */
  const signHere = async () => {
    if (!challenge) return;
    const eth = (globalThis as { ethereum?: { request(a: { method: string; params?: unknown[] }): Promise<unknown> } })
      .ethereum;
    if (!eth) {
      setNote("No wallet extension found here — sign the message elsewhere and paste it below.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await eth.request({ method: "eth_requestAccounts" });
      const sig = (await eth.request({
        method: "personal_sign",
        params: [challenge.message, holder.trim().toLowerCase()],
      })) as string;
      setSignature(String(sig));
      setNote("Signed. Submit it below to finish linking.");
    } catch (e) {
      setError(
        e instanceof Error && /reject|denied/i.test(e.message)
          ? "That request was rejected in your wallet."
          : "Your wallet could not sign that — check it is set to the wallet you named, or paste a signature below.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!challenge) return;
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/holder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holder: holder.trim(), signature: signature.trim(), nonce: challenge.nonce }),
      });
      const j = (await r.json()) as { error?: string; moved?: boolean };
      if (!r.ok) throw new Error(j.error ?? "could not link that wallet");
      setChallenge(null);
      setSignature("");
      setHolder("");
      // `moved`: the wallet's own signature took it from another account,
      // where it no longer counts. The server never says which account.
      setNote(
        j.moved
          ? "Linked. This wallet moved here from another merrymen account, where it no longer counts. Your tier now reads its balance."
          : "Linked. Your tier now reads this wallet's balance.",
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/holder", { method: "DELETE" });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      // A refused unlink must not read as done: the wallet would still be
      // held by this account, and unavailable to the one it was meant for.
      if (!r.ok) throw new Error(j.error ?? "could not unlink that wallet");
      setNote(unlinkedNote(await refresh()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="holder-link">
      {linked ? (
        <LinkedWallet
          address={linked.address}
          standing={standing}
          busy={busy}
          onRelink={() => {
            // The same wallet, signed for again: claims it if nobody holds
            // it, or moves it here from the account that does.
            setHolder(linked.address);
            void start(linked.address);
          }}
          onUnlink={() => void unlink()}
        />
      ) : (
        <p className="mm-hint">
          {reads === "none"
            ? "The wallet you sign in with powers another merrymen account right now, so it does not count here. To bring it back, link it below with a signature from it. "
            : "By default your tier reads the wallet you sign in with. "}
          If your $MERRYMEN is somewhere else, name that wallet and prove it with a signature from it.
          A wallet powers one merrymen account at a time: signing for it here moves it from any other
          account. It can move once every 24 hours, and can always come back to the account it last left or to the
          account that signs in with it. Your agent&apos;s own account counts too. The wallet stays
          read-only — it is never a spend key and never joins your agent&apos;s permission.
        </p>
      )}

      {!challenge && (
        <div className="holder-row">
          <input
            className="mm-input mono"
            placeholder="0x… the wallet holding $MERRYMEN"
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
          />
          <button
            type="button"
            className="copy-btn"
            disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(holder.trim())}
            onClick={() => void start()}
          >
            {linked ? "link a different wallet" : "link this wallet"}
          </button>
        </div>
      )}

      {challenge && (
        <div className="holder-challenge">
          <p className="mm-hint">
            Sign this exact message with <span className="mono">{holder.trim().toLowerCase()}</span>.
            Any wallet works — extension, hardware, or a phone. It moves no funds. If this wallet
            powers another merrymen account, signing moves it here.
          </p>
          <textarea className="mm-input mono" readOnly rows={9} value={challenge.message} />
          <div className="holder-row">
            <button type="button" className="copy-btn" disabled={busy} onClick={() => void signHere()}>
              sign with my wallet
            </button>
            <button
              type="button"
              className="copy-btn"
              onClick={() => void navigator.clipboard?.writeText(challenge.message).catch(() => {})}
            >
              copy message
            </button>
            <button type="button" className="copy-btn" onClick={() => setChallenge(null)} disabled={busy}>
              cancel
            </button>
          </div>
          <input
            className="mm-input mono"
            placeholder="0x… paste the signature"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
          />
          <button
            type="button"
            className="grant-btn"
            disabled={busy || !signature.trim()}
            onClick={() => void submit()}
          >
            {busy ? "checking…" : "finish linking"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mm-danger">
          {error}
        </p>
      )}
      {note && !error && (
        <p role="status" className="mm-hint">
          {note}
        </p>
      )}
    </div>
  );
}
