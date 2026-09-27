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

export function HolderLink() {
  const [linked, setLinked] = useState<Linked | null>(null);
  const [reads, setReads] = useState<Reads>(null);
  const [holder, setHolder] = useState("");
  const [challenge, setChallenge] = useState<{ message: string; nonce: string } | null>(null);
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/holder", { method: "PATCH", cache: "no-store" });
      const j = (await r.json()) as { linked?: Linked | null; reads?: Reads };
      setLinked(j.linked ?? null);
      setReads(j.reads ?? null);
    } catch {
      /* an unreadable link is shown as none — never as an error on a settings page */
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Ask the server for the exact bytes this wallet must sign. */
  const start = async () => {
    setError("");
    setNote("");
    setSignature("");
    setBusy(true);
    try {
      const r = await fetch(`/api/holder?holder=${encodeURIComponent(holder.trim())}`, { cache: "no-store" });
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
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? "could not link that wallet");
      setChallenge(null);
      setSignature("");
      setHolder("");
      setNote("Linked. Your tier now reads this wallet's balance.");
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
      setNote("Unlinked. Your tier reads the wallet you sign in with again.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="holder-link">
      {linked ? (
        <div className="holder-linked">
          {reads === "linked" || reads === null ? (
            <p>
              Your tier reads <span className="mono">{linked.address}</span>, proved by a signature from
              that wallet.
            </p>
          ) : (
            <p>
              <span className="mono">{linked.address}</span> is linked but not counting here: a wallet
              can power one merrymen account, and it already powers another. Unlink it there, or link a
              different wallet.
            </p>
          )}
          <button type="button" className="copy-btn" onClick={() => void unlink()} disabled={busy}>
            unlink
          </button>
        </div>
      ) : (
        <p className="mm-hint">
          {reads === "none"
            ? "The wallet you sign in with already powers another merrymen account, so it does not count here. "
            : "By default your tier reads the wallet you sign in with. "}
          If your $MERRYMEN is somewhere else, name that wallet and prove it with a signature from it.
          A wallet can power one merrymen account; your agent&apos;s own account counts too. It stays
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
            Any wallet works — extension, hardware, or a phone. It moves no funds.
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
