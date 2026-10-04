"use client";

import { useCallback, useEffect, useState } from "react";
import { useT, type Vars } from "../lib/i18n";
import { EN, type MessageKey } from "../lib/messages/en";

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
  const t = useT();
  const relink = (
    <button type="button" className="copy-btn" onClick={onRelink} disabled={busy}>
      {t("settings.holder.linkItAgain")}
    </button>
  );
  return (
    <div className="holder-linked">
      {standing === "counting" ? (
        <p>
          {t("settings.holder.tierReadsProved", { address })}
        </p>
      ) : standing === "unclaimed" ? (
        <p>
          {t("settings.holder.linkedNotCounting", { address })}
        </p>
      ) : standing === "claimed-elsewhere" ? (
        <p>
          {t("settings.holder.powersAnother", { address })}
        </p>
      ) : (
        <p>
          {t("settings.holder.linkedProved", { address })}
        </p>
      )}
      {(standing === "unclaimed" || standing === "claimed-elsewhere") && relink}
      <button type="button" className="copy-btn" onClick={onUnlink} disabled={busy}>
        {t("settings.holder.unlinkBtn")}
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
export function unlinkedNote(reads: Reads, t: (key: MessageKey, vars?: Vars) => string = (key) => EN[key]): string {
  if (reads === "login") return t("settings.holder.unlinkedLogin");
  if (reads === "none") {
    return t("settings.holder.unlinkedNone");
  }
  return t("settings.holder.unlinkedPlain");
}

export function HolderLink() {
  const t = useT();
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
      if (!r.ok || !j.message || !j.nonce) throw new Error(j.error ?? t("settings.holder.couldNotStart"));
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
      setNote(t("settings.holder.noExtension"));
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
      setNote(t("settings.holder.signedSubmitBelow"));
    } catch (e) {
      setError(
        e instanceof Error && /reject|denied/i.test(e.message)
          ? t("settings.holder.rejectedInWallet")
          : t("settings.holder.couldNotSign"),
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
      if (!r.ok) throw new Error(j.error ?? t("settings.holder.couldNotLink"));
      setChallenge(null);
      setSignature("");
      setHolder("");
      // `moved`: the wallet's own signature took it from another account,
      // where it no longer counts. The server never says which account.
      setNote(
        j.moved
          ? t("settings.holder.linkedMovedHere")
          : t("settings.holder.linkedReadsBalance"),
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
      if (!r.ok) throw new Error(j.error ?? t("settings.holder.couldNotUnlink"));
      setNote(unlinkedNote(await refresh(), t));
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
            ? t("settings.holder.powersAnotherIntro")
            : t("settings.holder.defaultReadsLogin")}
          {t("settings.holder.somewhereElse")}
        </p>
      )}

      {!challenge && (
        <div className="holder-row">
          <input
            className="mm-input mono"
            placeholder={t("settings.holder.addressPlaceholder")}
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
          />
          <button
            type="button"
            className="copy-btn"
            disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(holder.trim())}
            onClick={() => void start()}
          >
            {linked ? t("settings.holder.linkDifferent") : t("settings.holder.linkThis")}
          </button>
        </div>
      )}

      {challenge && (
        <div className="holder-challenge">
          <p className="mm-hint">
            {t("settings.holder.signExactMessage", { address: holder.trim().toLowerCase() })}
          </p>
          <textarea className="mm-input mono" readOnly rows={9} value={challenge.message} />
          <div className="holder-row">
            <button type="button" className="copy-btn" disabled={busy} onClick={() => void signHere()}>
              {t("settings.holder.signWithWallet")}
            </button>
            <button
              type="button"
              className="copy-btn"
              onClick={() => void navigator.clipboard?.writeText(challenge.message).catch(() => {})}
            >
              {t("settings.holder.copyMessage")}
            </button>
            <button type="button" className="copy-btn" onClick={() => setChallenge(null)} disabled={busy}>
              {t("settings.holder.cancelBtn")}
            </button>
          </div>
          <input
            className="mm-input mono"
            placeholder={t("settings.holder.signaturePlaceholder")}
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
          />
          <button
            type="button"
            className="grant-btn"
            disabled={busy || !signature.trim()}
            onClick={() => void submit()}
          >
            {busy ? t("settings.holder.checkingState") : t("settings.holder.finishLinking")}
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
