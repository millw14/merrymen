"use client";

import { useState } from "react";
import { listSavedWallets } from "@/lib/session";
import { isAddr, normalizeAddr } from "@/lib/address";
import { planFromBrowser, sweepFromBrowser, redact, type BrowserWallet } from "@/lib/recover-client";
import { usePrivyOwner } from "@/terminal/usePrivyOwner";

/**
 * "Get my money out" — the one-click counterpart to `merrymen recover`.
 *
 * Funds sit in a counterfactual smart account, not a plain wallet, so users
 * can't reach them by importing the owner key into MetaMask. This sweeps the
 * balance to any address they control, signed by the owner (sudo) key — works
 * even after a kill switch. For an active agent the server signs with the key in
 * grant.json (nothing typed); after a kill, the user pastes their backed-up key.
 */

interface Balance {
  symbol: string;
  amount: string;
}
/**
 * A holding in the account's class vault — a SEPARATE contract, so it appears
 * in no `Balance`. `token` rather than `symbol` is the key because a class
 * token's symbol is frequently unreadable and falls back to a short address,
 * which is not unique.
 */
interface ClassHolding {
  token: string;
  symbol: string;
  amount: string;
}
interface Ctx {
  hasStoredKey: boolean;
  hasBundler: boolean;
  chainId?: number;
  explorer?: string;
  smartAccount?: string;
  ownerAddress?: string;
  balances?: Balance[];
  /** The class vault's contents, and the vault itself. Absent is not empty. */
  classHoldings?: ClassHolding[];
  classVault?: string | null;
  /** Labels whose balance could not be READ. Never conflate with "not held". */
  unreadable?: string[];
  error?: string;
  /** The server's explanation. Was returned, parsed, and never rendered. */
  detail?: string;
  /** Hosted: the server cannot sweep, the browser must. */
  clientSide?: boolean;
}
interface PlanRes {
  smartAccount: string;
  ownerAddress: string;
  explorer: string;
  chainId: number;
  balances: Balance[];
  /** The class vault's contents, and the vault itself. Absent is not empty. */
  classHoldings?: ClassHolding[];
  classVault?: string | null;
  /** Labels whose balance could not be READ. Never conflate with "not held". */
  unreadable?: string[];
  error?: string;
}
interface SweepRes {
  /** NULL when nothing moved. Typed nullable because it IS nullable — as a bare
   * string, tsc waved through a success block that rendered /tx/null. */
  txHash: string | null;
  to: string;
  smartAccount: string;
  explorer: string;
  balances: Balance[];
  /** Held, but refused to transfer. Non-empty means nothing was swept. */
  skipped?: { symbol: string; reason: string }[];
  unreadable?: string[];
  error?: string;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const isKey = (v: string) => /^0x[0-9a-fA-F]{64}$/.test(v.trim());
const MAINNET = 4663;
const TESTNET = 46630;

/**
 * @param initialOwnerKey The key this browser ALREADY holds, when it holds one.
 *
 * Asking a person to paste a key the page can read from its own localStorage is
 * not security, it is friction — and friction on the exit is the worst place to
 * put it. A user who could not find this flow imported his key into MetaMask
 * instead, saw an empty address, and concluded his money was gone.
 *
 * Left optional and defaulting to empty so /home keeps working exactly as it
 * did: that page is reachable while signed out and on a machine that never had
 * the wallet, which is the case the paste field exists for.
 */
export function RecoverPanel({ initialOwnerKey = "" }: { initialOwnerKey?: string } = {}) {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);

  const [ownerKey, setOwnerKey] = useState(initialOwnerKey);
  /**
   * The signed-in embedded wallet, or null for a browser-key wallet.
   *
   * Null is the legacy path unchanged — every branch below falls back to the
   * pasted/stored key exactly as before, so this cannot alter recovery for a
   * wallet that has a key.
   */
  const privyOwner = usePrivyOwner();
  const [chainId, setChainId] = useState<number>(MAINNET);
  const [plan, setPlan] = useState<PlanRes | null>(null);

  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<null | "checking" | "sweeping">(null);
  const [result, setResult] = useState<SweepRes | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function expand() {
    setOpen(true);
    if (ctx || loadingCtx) return;
    setLoadingCtx(true);
    try {
      const r = await fetch("/api/recover");
      setCtx((await r.json()) as Ctx);
    } catch {
      setCtx({ hasStoredKey: false, hasBundler: false, error: "couldn't reach the recovery service" });
    }
    setLoadingCtx(false);
  }

  /**
   * HOSTED: the server holds no owner key and says so. Do the work here.
   *
   * The panel used to fetch that refusal, drop it on the floor, and fall
   * through to a paste-a-key form whose button POSTed to a route that 403s
   * before it even parses the body. A user with money in the account saw an
   * empty form and one red line.
   */
  function browserWallet(): BrowserWallet | null {
    // A PRIVY-OWNED AGENT HAS NO KEY, AND ASKING FOR ONE STRANDS IT.
    //
    // Its owner is an embedded wallet whose key is never exported — the point of
    // it — so this form used to demand something that does not exist and the
    // account could not be recovered at all. `usePrivyOwner` hands back a viem
    // LocalAccount that signs without exposing anything, which is the same
    // signer minting already uses for this owner.
    if (privyOwner) {
      const saved = (() => {
        try {
          return listSavedWallets().find(
            (w) => w.smartAccount.toLowerCase() === (smartAccount ?? "").toLowerCase(),
          );
        } catch {
          return undefined;
        }
      })();
      if (!smartAccount) return null;
      return {
        smartAccount: smartAccount as `0x${string}`,
        ownerAccount: privyOwner.account,
        chainId: saved?.chainId ?? chainId,
        grantTokens: (saved as { grantTokens?: string[] } | undefined)?.grantTokens,
      };
    }
    const key = ownerKey.trim();
    if (!isKey(key)) return null;
    // Prefer the stored wallet, so grantTokens (and therefore the sweep list)
    // comes from what the wall actually covers rather than the builtin floor.
    const saved = (() => {
      try {
        return listSavedWallets().find(
          (w) => (w.ownerKey ?? "").toLowerCase() === key.toLowerCase(),
        );
      } catch {
        return undefined;
      }
    })();
    if (!saved) return null;
    return {
      smartAccount: saved.smartAccount,
      ownerKey: key as `0x${string}`,
      chainId: saved.chainId ?? chainId,
      grantTokens: (saved as { grantTokens?: string[] }).grantTokens,
    };
  }

  async function checkInBrowser() {
    setError(null);
    const w = browserWallet();
    if (!w) {
      setError(
        "this browser doesn't hold that wallet, so it can't withdraw here. Use `merrymen recover` on the machine with your key.",
      );
      return;
    }
    setBusy("checking");
    try {
      const b = await planFromBrowser(w);
      setPlan({
        smartAccount: b.smartAccount,
        chainId: w.chainId,
        // TokenBalance already carries the display string as `amount`, and the
        // panel renders exactly that shape — so pass it through rather than
        // rebuilding it and losing `note` along the way.
        balances: b.balances,
      } as unknown as PlanRes);
      // The one thing that stops a sweep dead, said BEFORE they press it.
      if (b.needsGas) {
        setError(
          `this account has no ETH, and a withdrawal is an on-chain operation it has to pay for. Send a little ETH to ${b.smartAccount} and try again — a few dollars is plenty.`,
        );
      }
    } catch (e) {
      setError(redact(e, w.ownerKey));
    }
    setBusy(null);
  }

  async function sweepInBrowser() {
    setError(null);
    if (!isAddr(to)) {
      setError("enter a valid destination address (0x + 40 hex).");
      return;
    }
    const w = browserWallet();
    if (!w) {
      setError("this browser doesn't hold that wallet.");
      return;
    }
    const list = balances.map((b) => `${b.amount} ${b.symbol}`).join(", ") || "the balance";
    if (
      !window.confirm(
        `Sweep ${list} to ${normalizeAddr(to)}?\n\nThis is real and irreversible. The account keeps a little ETH to pay for gas.`,
      )
    ) {
      return;
    }
    setBusy("sweeping");
    try {
      const r = await sweepFromBrowser(w, normalizeAddr(to) as `0x${string}`);
      setResult(r as unknown as SweepRes);
    } catch (e) {
      setError(redact(e, w.ownerKey));
    }
    setBusy(null);
  }

  async function checkPasted() {
    setError(null);
    if (!isKey(ownerKey)) {
      setError("that isn't a 32-byte owner key (0x + 64 hex chars).");
      return;
    }
    setBusy("checking");
    try {
      const r = await fetch("/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "plan", ownerKey: ownerKey.trim(), chainId }),
      });
      const j = (await r.json()) as PlanRes;
      if (!r.ok || j.error) setError(j.error ?? "couldn't read that wallet.");
      else setPlan(j);
    } catch {
      setError("couldn't reach the recovery service.");
    }
    setBusy(null);
  }

  // HOSTED: the server told us it cannot sweep. Do it here instead of showing
  // its refusal as though the user had done something wrong.
  const clientSide = ctx?.clientSide === true;

  // Balances/addresses come from the pasted-key plan if present, else the GET ctx.
  const balances = plan?.balances ?? ctx?.balances ?? [];
  // MONEY THE ACCOUNT DOES NOT HOLD. A class position sits in a separate
  // PonsClassVault contract, so it is in no `balances` entry — and this panel
  // never mentioned the vault at all. The engine has always swept it
  // (recover.ts:591-638); the screen simply did not say so, which on a
  // withdrawal confirmation is the difference between consent and a surprise.
  const classHoldings = plan?.classHoldings ?? ctx?.classHoldings ?? [];
  const classVault = plan?.classVault ?? ctx?.classVault ?? null;
  const smartAccount = plan?.smartAccount ?? ctx?.smartAccount;
  const explorer = plan?.explorer ?? ctx?.explorer;
  const activeChain = plan?.chainId ?? ctx?.chainId ?? chainId;
  // CAN THIS WITHDRAWAL BE SUBMITTED AT ALL?
  //
  // Hosted, the answer is always yes: the relay holds the house bundler key, and
  // that is the entire reason it exists. `ctx.hasBundler` describes the SERVER’s
  // own key, which hosted is deliberately absent — so reading it alone told a
  // hosted owner to add a Pimlico key in settings, a field the hosted settings
  // route silently strips, and then disabled the button so they could not proceed
  // even if they ignored the advice. A dead end dressed as an instruction.
  const canSubmit = clientSide || (ctx?.hasBundler ?? false);
  // Do we know what's in the account yet? (stored-key ctx, or a checked paste.)
  const known = !!(plan || (ctx?.hasStoredKey && ctx));
  // "Empty" is a CLAIM, and it may only be made when everything was actually
  // read. Saying an account is empty because an RPC blinked is how somebody
  // concludes their money is gone.
  const unreadable = (ctx?.unreadable ?? plan?.unreadable ?? []) as string[];
  // A vault holding is something to recover, so it cannot be "empty" either.
  const empty = known && balances.length === 0 && classHoldings.length === 0 && unreadable.length === 0;
  const blind = known && balances.length === 0 && classHoldings.length === 0 && unreadable.length > 0;

  async function sweep() {
    setError(null);
    if (!isAddr(to)) {
      setError("enter a valid destination address (0x + 40 hex).");
      return;
    }
    // GROUPED BY CUSTODY, not flattened. The vault is emptied by a first
    // operation and the account by a second; one comma-separated list cannot
    // show an owner that a whole contract is being drained.
    const lines: string[] = [];
    if (classHoldings.length) {
      lines.push("CLASS VAULT" + (classVault ? ` ${classVault}` : ""));
      for (const h of classHoldings) lines.push(`  ${h.amount} ${h.symbol}`);
      lines.push("");
    }
    if (balances.length) {
      lines.push(`SMART ACCOUNT ${smartAccount ?? ""}`.trimEnd());
      for (const b of balances) lines.push(`  ${b.amount} ${b.symbol}`);
      lines.push("");
    }
    lines.push("DESTINATION", `  ${normalizeAddr(to)}`);
    const list =
      [...classHoldings.map((h) => `${h.amount} ${h.symbol}`), ...balances.map((b) => `${b.amount} ${b.symbol}`)].join(
        ", ",
      ) || "the balance";
    if (
      !window.confirm(
        `Sweep:\n\n${lines.join("\n")}\n\nThis is real and irreversible. The account keeps a little ETH to pay for gas.`,
      )
    ) {
      return;
    }
    setBusy("sweeping");
    try {
      const body: Record<string, unknown> = { mode: "sweep", to: normalizeAddr(to) };
      if (plan) {
        body.ownerKey = ownerKey.trim();
        body.chainId = chainId;
      }
      const r = await fetch("/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as SweepRes;
      if (!r.ok || j.error) setError(j.error ?? "recovery failed.");
      else setResult(j);
    } catch {
      setError("couldn't reach the recovery service.");
    }
    setBusy(null);
  }

  return (
    <div className="panel recover-panel">
      <div className="section-title">recover funds</div>

      {!open ? (
        <>
          <p className="recover-sub">
            Your money lives in a smart account, not a MetaMask wallet — so importing the owner key
            won&apos;t show it. Sweep it back to any address you control, anytime (even after a kill).
          </p>
          <button className="recover-btn" onClick={() => void expand()}>
            🏹 recover my funds
          </button>
        </>
      ) : loadingCtx ? (
        <p className="recover-sub">reading your account…</p>
      ) : result ? (
        <div className="recover-done">
          {result.txHash ? (
            <>
              <p className="recover-sub">
                <b>Recovered ✓</b> — {result.balances.map((b) => `${b.amount} ${b.symbol}`).join(", ")} sent to{" "}
                <span className="mono">{short(result.to)}</span>.
              </p>
              {result.skipped?.length ? (
                <p className="recover-sub">
                  Left behind, because they refused to transfer:{" "}
                  {result.skipped.map((s) => s.symbol).join(", ")}.
                </p>
              ) : null}
              <a className="recover-btn" href={`${result.explorer}/tx/${result.txHash}`} target="_blank" rel="noreferrer">
                view the transaction ↗
              </a>
            </>
          ) : (
            /* NOTHING MOVED — and this used to render as "Recovered ✓" with a
               link to /tx/null, which reads as explorer lag rather than as
               failure. A false success claim on the escape hatch is the worst
               place in the product to have one: the owner walks away believing
               their money is out. */
            <>
              <p className="recover-sub">
                <b>Nothing moved.</b> Every token in this account refused to transfer, so no
                transaction was sent — your funds are still where they were.
              </p>
              {result.skipped?.length ? (
                <ul className="recover-sub">
                  {result.skipped.map((s) => (
                    <li key={s.symbol}>
                      <span className="mono">{s.symbol}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <>
          {/* Killed/expired: no stored key — ask for the backed-up one. */}
          {ctx && !ctx.hasStoredKey && !plan && privyOwner && (
            <p className="recover-sub">
              Recovery will be authorised by your signed-in wallet. There is no key to enter — your
              embedded wallet signs it, and merrymen never sees it.
            </p>
          )}
          {ctx && !ctx.hasStoredKey && !plan && !privyOwner && (
            <>
              <p className="recover-sub">
                Enter the recovery key you saved when creating this wallet.
              </p>
              <input
                className="recover-input mono"
                type="password"
                placeholder="owner key (0x…)"
                value={ownerKey}
                onChange={(e) => setOwnerKey(e.target.value)}
                autoComplete="off"
              />
            </>
          )}
          {/* THE CHAIN PICKER AND THE CHECK BUTTON BELONG TO BOTH PATHS.
              Nested inside the key branch above, a Privy-owned agent got the
              "no key needed" sentence and then no way to do anything — the
              screen said recovery was authorised by their wallet and offered
              them nothing to press. */}
          {ctx && !ctx.hasStoredKey && !plan && (
            <>
              <div className="recover-chain">
                <label>
                  <input type="radio" checked={chainId === MAINNET} onChange={() => setChainId(MAINNET)} /> mainnet · 4663
                </label>
                <label>
                  <input type="radio" checked={chainId === TESTNET} onChange={() => setChainId(TESTNET)} /> testnet · 46630
                </label>
              </div>
              <button className="recover-btn" onClick={() => void (clientSide ? checkInBrowser() : checkPasted())} disabled={busy !== null}>
                {busy === "checking" ? "reading the wallet…" : "check what's in it"}
              </button>
            </>
          )}

          {/* Balances known — show them and the sweep form. */}
          {known && (
            <>
              {smartAccount && (
                <p className="recover-sub">
                  account{" "}
                  {explorer ? (
                    <a className="mono" href={`${explorer}/address/${smartAccount}`} target="_blank" rel="noreferrer">
                      {short(smartAccount)} ↗
                    </a>
                  ) : (
                    <span className="mono">{short(smartAccount)}</span>
                  )}{" "}
                  · chain {activeChain}
                </p>
              )}

              {empty ? (
                <p className="recover-sub">This account is empty — nothing to recover.</p>
              ) : blind ? (
                /* NOT "empty". Every balance read failed, which is a different
                   fact — and telling someone their account is empty because an
                   RPC blinked is how they conclude their money is gone. */
                <p className="recover-sub">
                  Nothing found — but {unreadable.join(", ")} could not be read. That is NOT a zero
                  balance. Check the RPC and try again before concluding anything.
                </p>
              ) : (
                <>
                  {classHoldings.length > 0 && (
                    <>
                      <p className="recover-sub">
                        <strong>Class vault</strong>
                        {classVault ? <> · <span className="mono">{short(classVault)}</span></> : null}
                      </p>
                      <div className="recover-holdings mono">
                        {classHoldings.map((h) => (
                          <span key={h.token} className="recover-hold">
                            {h.amount} {h.symbol}
                          </span>
                        ))}
                      </div>
                      <p className="recover-sub">
                        Held in a separate contract, not in the account. Recovery empties it into the
                        account first, then moves everything in a second operation.
                      </p>
                    </>
                  )}
                  {balances.length > 0 && classHoldings.length > 0 && (
                    <p className="recover-sub">
                      <strong>Smart account</strong>
                    </p>
                  )}
                  <div className="recover-holdings mono">
                    {balances.map((b) => (
                      <span key={b.symbol} className="recover-hold">
                        {b.amount} {b.symbol}
                      </span>
                    ))}
                  </div>

                  {!canSubmit && (
                    <p className="recover-warn">
                      Recovery sends an on-chain transaction, so it needs your bundler key. Add a free
                      Pimlico key in <a href="/settings">settings</a>, then come back.
                    </p>
                  )}

                  <input
                    className="recover-input mono"
                    type="text"
                    placeholder="send to… (an address you control, e.g. MetaMask)"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    autoComplete="off"
                  />
                  {/* A DISABLED BUTTON THAT EXPLAINS ITSELF.
                      Silence here cost a user his whole attempt: he had done
                      everything right and the only feedback was a button that
                      would not press. */}
                  {to.trim().length > 0 && !isAddr(to) && (
                    <p className="recover-warn">
                      That doesn&rsquo;t look like an address yet — it should be 40 characters of
                      hex, with or without the <code>0x</code>. Paste the receiving address from
                      your wallet or exchange.
                    </p>
                  )}
                  <button
                    className="recover-btn go"
                    onClick={() => void (clientSide ? sweepInBrowser() : sweep())}
                    disabled={busy !== null || !canSubmit || !isAddr(to)}
                  >
                    {busy === "sweeping" ? "signing & sending (up to a minute)…" : "recover funds →"}
                  </button>
                </>
              )}
            </>
          )}

          {error && <p className="recover-err mono">{error}</p>}

          <p className="recover-note">
            Signed by your <b>owner key</b> (not the capped session key), so it works after a kill and
            isn&apos;t bound by trade limits. Same engine as <span className="mono">merrymen recover</span>.
          </p>
        </>
      )}
    </div>
  );
}
