"use client";

import Link from "next/link";
import { TRENCHER_FACTORY } from "@/lib/trencher-permission";
import { verifiedAdapter } from "@/lib/verified-adapter";
import { revokeFromBrowser } from "@/lib/revoke-client";
import { stopAgent } from "@/lib/stop-agent";
import { markPermissionForReplacement, needsPermissionReplacement } from "@/lib/permission-replacement";
import { loadRecoveryGrants, saveRecoveryGrant, trustedSavedGrant } from "@/lib/saved-grant-binding";
import { MAX_USDG_UI, isWallTooWide } from "@merrymen/core";
import { parseAmount, type AmountField } from "@/lib/parse-amount";
import { fullDateTime } from "@/lib/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, erc20Abi, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Info } from "@/components/Info";
import { FormPage as AppShell, FormHeading as PageHeader } from "../FormPage";
import {
  explorerFor,
  grantTrencher,
  TRENCHER_VAULT_ABI,
  CASH,
  grantPonsAdapter,
  grantPonsClassVault,
  isValidCustomToken,
  robinhoodChain,
  robinhoodTestnet,
  tokenCoverage,
  TRADEABLE_V2,
  uncoveredBasketSymbols,
  type CustomToken,  PONS_SELFTRADE_ABI,
} from "@merrymen/core";
import {
  clearGrant,
  createAgentWallet,
  FAUCET_URL,
  listSavedWallets,
  isPrivyOwned,
  loadGrant,
  previewOwnerAccount,
  preflightAgentGrant,
  readFunding,
  refusalMessage,
  restoreAgentWallet,
  createPrivyOwnedWallet,
  type Funding,
  type Grant,
  type GrantCaps,
  type OwnerPreview,
  type SavedWallet,
} from "@/lib/session";
import { SignOut } from "../SignOut";
import { fetchAccountForSession } from "../account-session";
import { conceptTooltip } from "@merrymen/core";
import { V4PermissionLine } from "../V4PermissionLine";
import { canStart } from "@/lib/can-start";
import { usePrivyOwner } from "@/terminal/usePrivyOwner";
import { RESIGN_ANCHOR, SIGNED_IN_EVENT, SIGNED_IN_RELOAD_KEY, shouldJumpToResign, shouldReloadAfterSignIn } from "@/lib/resign-anchor";
// QUARANTINED, not fixed. This page moves real money, holds owner private keys
// and is 1,750 lines of signature and recovery logic — the last place to
// restyle during a redesign. It keeps the sheets it was written against, and
// they no longer reach anything else.

const DEFAULTS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

/**
 * THE SMALLEST EACH CAP MAY BE SEALED AT, and why a floor exists at all.
 *
 * Every one of these is a number that, at zero, makes the agent permanently
 * unable to act — and a signature cannot be edited afterwards. `maxDrawdownPct:
 * 0` is the sharpest: policy.ts then computes `0bps >= 0bps` and refuses every
 * non-exit intent for the life of the grant.
 *
 * The ceiling is deliberately absent. A cap is the owner's own limit on their
 * own money and they may set it as high as they like; the floor exists only to
 * stop them signing a permission that permits nothing.
 */
const CAP_FLOOR: Record<keyof GrantCaps, number> = {
  perTradeUsdg: 1,
  dailyUsdg: 1,
  expiryDays: 1,
  maxDrawdownPct: 1,
  maxOpsPerDay: 1,
};

/**
 * THE SHAPE OF EACH CAP AS A TYPED FIELD: precision, floor, ceiling.
 *
 * This replaces `clampCap`, which did `Number(raw)` and fell back to the
 * floor on anything unreadable. Two things were wrong with that, and both cost
 * money rather than convenience:
 *
 *   `Number("")` is 0, and 0 IS finite — so the `!Number.isFinite` guard never
 *   fired on an empty field. `Math.max(1, Math.floor(0))` then sealed a cap of
 *   ONE USDG into a signature that cannot be edited for the life of the grant,
 *   with no error and nothing on screen to notice.
 *
 *   `Math.floor` applied to every cap, so a 10.50 per-trade limit was signed
 *   as 10 — an edit to a number the owner was in the middle of reading.
 *
 * Money keeps its cents; days, trades and percent are whole by construction.
 * The expiry ceiling is the signer's own, so a value that parses here cannot be
 * refused later by the thing being signed.
 */
const CAP_FIELDS: Record<keyof GrantCaps, AmountField> = {
  perTradeUsdg: { maxDecimals: 2, min: CAP_FLOOR.perTradeUsdg, max: MAX_USDG_UI },
  dailyUsdg: { maxDecimals: 2, min: CAP_FLOOR.dailyUsdg, max: MAX_USDG_UI },
  expiryDays: { maxDecimals: 0, min: CAP_FLOOR.expiryDays, max: 90 },
  maxDrawdownPct: { maxDecimals: 0, min: CAP_FLOOR.maxDrawdownPct, max: 50 },
  maxOpsPerDay: { maxDecimals: 0, min: CAP_FLOOR.maxOpsPerDay, max: 10_000 },
};

/** One-click cap presets — pick a temperament, tweak if you like, ride. */
const PRESETS: { id: string; icon: string; label: string; blurb: string; caps: GrantCaps }[] = [
  {
    id: "scout",
    icon: "shield",
    label: "cautious · the scout",
    blurb: "dip a toe — tiny trades, tight leash",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 },
  },
  {
    id: "outlaw",
    icon: "target",
    label: "balanced · the outlaw",
    blurb: "the sensible default",
    caps: DEFAULTS,
  },
  {
    id: "warlord",
    icon: "bolt",
    label: "bold · the warlord",
    blurb: "bigger arrows, wider walls",
    caps: { perTradeUsdg: 200, dailyUsdg: 2000, expiryDays: 30, maxDrawdownPct: 15, maxOpsPerDay: 96 },
  },
];

/** Inline line-icons — real vector marks in place of emoji, themed by currentColor. */
function GI({ d, size = 15 }: { d: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    shield: <path d="M12 3 20 6v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z" />,
    target: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3.5" />
      </>
    ),
    bolt: <path d="M13 2 5 13h5l-1 9 9-12h-5l1-8z" />,
    tree: (
      <>
        <path d="M12 3 6 13h3l-3.5 5h13L18 13h3z" />
        <path d="M12 18v3" />
      </>
    ),
    coin: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    scroll: (
      <>
        <path d="M6 3h11a2 2 0 0 1 2 2v13a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5.5" />
        <path d="M9 8h7M9 12h7M9 16h4" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: "-0.15em", flex: "none" }}
      aria-hidden="true"
    >
      {paths[d]}
    </svg>
  );
}

const sameCaps = (a: GrantCaps, b: GrantCaps) =>
  (Object.keys(a) as (keyof GrantCaps)[]).every((k) => a[k] === b[k]);

const BACKUP_KEY = "merrymen.grant.backedup.v1";
const TESTNET = robinhoodTestnet.id; // 46630 — the sandbox

/** Adapter verification uses the canonical allowlist before signing permissions. */

const MAINNET = robinhoodChain.id; // 4663 — real funds

/**
 * WHICH CHAIN THE PAGE WAS ASKED TO OPEN ON, from `?chain=`.
 *
 * A banner elsewhere says "Re-sign on Robinhood Chain" and, until this existed,
 * opened a screen that pinned its selector to the testnet grant being replaced
 * — so the obvious control here read "re-sign this key (free)" and minted
 * another testnet grant. The owner re-signed, the banner came back, and he
 * reported the product as broken. The button's promise now arrives with it.
 *
 * A QUERY RATHER THAN A PROP, because the descriptor cannot survive the trip:
 * `pathForScreen` flattens `{kind:"grant"}` to the string "/grant" and the
 * screen is re-hydrated from `usePathname()`, which carries no query — and the
 * phone's route is a full page load besides, where props do not exist at all.
 *
 * IT ONLY PRE-SELECTS. Everything downstream is unchanged: the move is still an
 * explicit ticked checkbox (derived from `chainId !== grant.chainId`), the
 * mainnet acknowledgement is still required, the button still renames itself to
 * "move to Robinhood Chain & re-sign", and the change line still lists the move. A
 * link cannot sign anything; it can only open the form on the right page.
 *
 * Unrecognised values are ignored rather than trusted — this comes from a URL,
 * so it is input, and the fallback is the behaviour that was already correct.
 */
function requestedChain(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("chain");
  const id = Number(raw);
  return id === MAINNET || id === TESTNET ? id : null;
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function chainLabel(id: number): string {
  return id === TESTNET ? `testnet · ${TESTNET}` : `mainnet · ${MAINNET}`;
}

function CopyBtn({ value, label = "copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked — user can select manually */
        }
      }}
    >
      {done ? "copied ✓" : label}
    </button>
  );
}

/**
 * One agent account this browser holds the key for, with what is actually in it.
 *
 * Exists because "I sent funds and now I can't see them" is the worst thing this
 * product can do to someone, and it was reachable by design: the page only ever
 * showed the CURRENT grant's address, and only once past a backup gate that a
 * desynced wallet never reaches. The money was never lost — the account is
 * on-chain and the key is in localStorage — but nothing on screen said so.
 *
 * Reads the balance directly from the chain, so it is true regardless of what
 * the server thinks about this grant.
 */
function WalletRow({ w }: { w: SavedWallet }) {
  const [bal, setBal] = useState<Funding | null>(null);
  const [failed, setFailed] = useState(false);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    let alive = true;
    readFunding(w.smartAccount, w.chainId)
      .then((f) => alive && setBal(f))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [w.smartAccount, w.chainId]);

  const empty = bal !== null && bal.gasWei === 0n && bal.usdgUnits === 0n;
  return (
    <div className="saved-wallet">
      <div className="sw-head">
        <span className="rk">
          {w.current ? "current" : "previous"} · {chainLabel(w.chainId)}
        </span>
        <CopyBtn value={w.smartAccount} label="copy address" />
      </div>
      <span className="rv mono" style={{ wordBreak: "break-all" }}>
        {w.smartAccount}
      </span>
      <div className="sw-bal mono">
        {failed
          ? "couldn't read the balance — check your connection"
          : bal === null
            ? "reading the chain…"
            : `${formatEther(bal.gasWei)} ETH · ${bal.usdg.toFixed(2)} USDG`}
        {empty && <span className="sw-empty"> — nothing here</span>}
      </div>
      {w.ownerKey ? (
        <>
          <button className="copy-btn" onClick={() => setShowKey((v) => !v)}>
            {showKey ? "hide recovery key" : "show recovery key"}
          </button>
          {showKey && (
            <>
              <span className="rv mono" style={{ wordBreak: "break-all" }}>
                {w.ownerKey}
              </span>
              <div className="sw-note">
                <CopyBtn value={w.ownerKey} label="copy key" /> This key controls the account above and
                everything in it. Anyone who reads it can take the funds — save it somewhere private, and
                never paste it into a site that asks for it.
              </div>
            </>
          )}
        </>
      ) : (
        <div className="sw-note">
          No recovery key is stored for this wallet in this browser.
        </div>
      )}
    </div>
  );
}

export default function GrantPage() {
  /*
    THE SCOUT, not the outlaw. Caps are sealed into the signature BEFORE the
    account has any money in it, so the default cannot be sized to capital
    nobody has deposited yet. The outlaw's 50/trade x 48 ops is a four-figure
    ceiling to hand someone who has not yet seen the thing trade once.

    Start conservatively. Raising a cap later requires an owner-authorized
    revocation transaction and a replacement signature.
  */
  const [caps, setCaps] = useState<GrantCaps>(PRESETS[0]!.caps);
  /*
    MAINNET BY DEFAULT, because the old default produced an agent that could
    never trade. preflight.ts classifies a non-4663 grant as a hard BLOCKER for
    a reason that is not a policy choice: every token and router address
    merrymen knows is a mainnet deployment, so on testnet a balance reads as
    zero and every route is refused. The most common outcome of the old default
    was a user who did everything right and got an agent that does nothing —
    and a new user on a faucet asking "how to do leave testnet?", which is what
    prompted this.

    This only became safe once paper mode was keyed on capability rather than
    on a missing bundler key: a new mainnet grant with no funds is now genuinely
    on paper, so "watch it work before risking anything" survives the
    flip instead of being deleted by it. Do not restore this default without
    also reverting that.

    Paper stays on the menu, one click away, and the real-money
    acknowledgement is untouched.
  */
  const [chainId, setChainId] = useState<number>(MAINNET);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [ack, setAck] = useState(false);
  const [funding, setFunding] = useState<Funding | null>(null);
  // Reported by the worker on the heartbeat; this page cannot resolve it (the
  // browser has no env, and hosted the web service is not the process that
  // decides). Read off the /api/grants response this page already fetches.
  const [gasSponsored, setGasSponsored] = useState(false);
  // Whether the SERVER still holds this grant (grant.json). null = still checking.
  // The browser copy and the server file can desync — a kill switch or CLI kill
  // deletes the server file but not this localStorage — so the dashboard shows
  // "no merryman" while this page would happily show a wallet the worker ignores.
  const [serverArmed, setServerArmed] = useState<boolean | null>(null);
  const [accountReadFailed, setAccountReadFailed] = useState(false);
  const [accountReadVersion, setAccountReadVersion] = useState(0);
  const accountReadGeneration = useRef(0);
  /** {hosted,address} from /api/auth/session. null until it resolves. */
  const [session, setSession] = useState<{ hosted: boolean; address: `0x${string}` | null } | null>(null);
  /** Every agent account this browser holds a key for — current and superseded. */
  const [savedWallets, setSavedWallets] = useState<SavedWallet[]>([]);
  const [reArming, setReArming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // ── restore: bring an already-funded wallet back with its owner key ──────
  const [mode, setMode] = useState<"create" | "restore">("restore");
  const [restoreKey, setRestoreKey] = useState("");
  const [restoreRevocationAck, setRestoreRevocationAck] = useState(false);
  const [preview, setPreview] = useState<OwnerPreview | null>(null);
  const [previewFunding, setPreviewFunding] = useState<Funding | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const restorePreviewGeneration = useRef(0);
  useEffect(() => {
    ++restorePreviewGeneration.current;
    setPreview(null);
    setPreviewFunding(null);
    setPreviewing(false);
    setRestoreRevocationAck(false);
    return () => { ++restorePreviewGeneration.current; };
  }, [chainId]);
  // Swapping the ACTIVE wallet for another one you own. Without this you'd have
  // to "discard" a funded wallet just to reach the restore tab — the exact scary
  // click that strands people. Switching archives the outgoing wallet instead.
  const [switching, setSwitching] = useState(false);
  // Owner-added tokens from settings. These are NOT tradable by virtue of being
  // listed — the tradable set lives inside the signed session key, so listing a
  // token only takes effect when a grant covering it is signed here.
  const [customTokens, setCustomTokens] = useState<CustomToken[]>([]);
  // The deployed V4SelfSwap for this install, read from /settings. Sealed into
  // the wall at signing — which is why it is read here and not at trade time.
  const [v4Adapter, setV4Adapter] = useState<`0x${string}` | undefined>(undefined);
  const [ponsAdapter, setPonsAdapter] = useState<`0x${string}` | undefined>(undefined);
  /** The class-vault FACTORY. Each account’s own vault is derived from it at sign time. */
  const [classFactory, setClassFactory] = useState<`0x${string}` | undefined>(undefined);
  const [autonomousTrencher, setAutonomousTrencher] = useState(false);
  useEffect(() => { setAutonomousTrencher(!!grantTrencher(grant)); }, [grant]);
  // The basket matters here for the same reason: /settings offers every registry
  // symbol, but only the ones sealed into the signature can be sold.
  const [basketSymbols, setBasketSymbols] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    const generation = ++accountReadGeneration.current;
    const stored = loadGrant();
    setSavedWallets(listSavedWallets());
    // The chain selector FOLLOWS the loaded grant. renewKey now signs on the
    // SELECTED chain (so the page cannot lie), which makes this sync load-
    // bearing: without it the selector defaults to testnet, and a mainnet
    // owner clicking "renew (free)" would silently re-sign their real-money
    // wallet onto the sandbox — the same silent-chain bug, mirrored. The caps
    // follow for the same reason: the form should open showing what the
    // current key actually carries.
    if (stored) {
      setChainId(requestedChain() ?? stored.chainId);
      setCaps(stored.caps);
      setCapText({});
    }
    setBackedUp(localStorage.getItem(BACKUP_KEY) === "1");
    void fetchAccountForSession(null)
      .then(async (result) => {
        if (!active || generation !== accountReadGeneration.current) return;
        if (result.kind !== "ready") throw result.kind === "changed" ? new Error("Account changed while loading.") : result.error;
        const { session: verifiedSession } = result.account;
        const s = result.account.status as { exists: boolean; gasSponsored?: boolean | null; grant?: Grant };
        // A browser's saved key may belong to a different hosted login. Keep it
        // for recovery, but never display or sign it as this tenant's agent.
        const matchesServerGrant = stored && s.grant?.smartAccount?.toLowerCase() === stored.smartAccount.toLowerCase() &&
          s.grant.chainId === stored.chainId &&
          (!s.grant.sessionKeyAddress || !stored.sessionKeyAddress || s.grant.sessionKeyAddress.toLowerCase() === stored.sessionKeyAddress.toLowerCase());
        // Another browser may have replaced a permission for this same account.
        // Adopt the current server grant, retaining the old full key for recovery.
        let trustedStored = s.exists ? (matchesServerGrant ? stored : null) : (!verifiedSession.hosted ? stored : null);
        if (!s.exists && !trustedStored) {
          // Stopping deliberately deletes the server grant. Historical signed
          // bindings preserve this tenant's renewal path across a refresh;
          // an address or DID merely claimed in localStorage is insufficient.
          for (const candidate of [stored, ...loadRecoveryGrants()]) {
            if (await trustedSavedGrant(candidate, verifiedSession, window.location.origin)) {
              trustedStored = candidate;
              break;
            }
          }
        }
        if (!active || generation !== accountReadGeneration.current) return;
        setGrant(trustedStored);
        if (trustedStored && !s.exists) {
          setChainId(requestedChain() ?? trustedStored.chainId);
          setCaps(trustedStored.caps);
          setCapText({});
          setBackedUp(true);
        }
        setSession({ hosted: verifiedSession.hosted, address: verifiedSession.address as `0x${string}` | null });
        setServerArmed(s.exists);
        setAccountReadFailed(false);
        if (s.exists && !trustedStored) {
          /**
           * A SECOND BROWSER IS NOT A LOST WALLET.
           *
           * Signing in from incognito, a phone, or any machine that did not
           * mint the agent left this screen with `grant === null`, so it fell
           * to `restore` — a panel that asks for the owner PRIVATE KEY. For a
           * Privy-owned agent there is no such key to paste: the owner is the
           * embedded wallet behind their login, and merrymen never holds it.
           * So the one screen that changes trading limits offered the single
           * thing that account can never do, and re-signing was unreachable
           * from anywhere but the original browser. A tester got out by hand-
           * writing the server's grant into localStorage — which works, and is
           * a trap: see below.
           *
           * Nothing secret is needed to re-sign. `renewKey` uses the smart
           * account, the caps and the chain, and takes its signature from the
           * Privy owner, which travels with the login. All three are in this
           * response already.
           *
           * NEVER WRITTEN TO localStorage. `merrymen.grant.v1` is the browser's
           * own full-fat copy — session key, and on a legacy agent the OWNER
           * key, which is the smart account's sudo validator and is not bound
           * by the wall. `/api/grants` strips all three
           * (`grants/route.ts`), so persisting what comes back would replace
           * the only copy of those keys with an object that has none. This
           * lives in React state for the life of the screen and nowhere else.
           */
          /**
           * ADOPTED FOR DISPLAY WHATEVER THE BINDING SAYS — and this is the
           * half the first fix got wrong, which is why the report came back.
           *
           * It gated adoption on `binding.version === "privy-did-owner-v1"`,
           * as though the question were "how is this agent bound". It is not.
           * READING your own agent needs no owner at all: the address, the
           * balances, the caps and the expiry are the server's answer to a
           * request it already authenticated. The owner only decides whether
           * this browser can SIGN, and `resignBy` below is the one place that
           * decides it.
           *
           * So the gate refused three cohorts that had every right to see
           * their agent — a legacy grant, a grant whose binding does not
           * verify, and, the one the reporters are almost certainly in, a
           * grant minted BEFORE `binding` existed at all, where `.version` is
           * undefined and the check reads false. Each of them landed on a form
           * asking for a private key, having asked to look at their wallet.
           *
           * What that costs is exactly what was reported: an owner in a second
           * browser could not read their own limits, let alone change them,
           * and the way out was pasting the server's grant into localStorage
           * by hand from a console — which works, and is a trap, because the
           * server's copy has the session key stripped out and writing it over
           * the real one destroys what it replaces.
           *
           * NEVER WRITTEN TO localStorage — the paragraph above is why. State
           * for the life of the screen, and nowhere else.
          */
          if (s.grant) {
            // Retain a proven legacy owner while adopting the current public
            // permission. Never copy the stale serialized grant/session secret.
            let currentGrant = s.grant;
            if (stored?.demoOwnerPrivateKey && stored.smartAccount.toLowerCase() === s.grant.smartAccount.toLowerCase()) {
              try {
                const owner = privateKeyToAccount(stored.demoOwnerPrivateKey as `0x${string}`);
                if (owner.address.toLowerCase() === s.grant.owner.toLowerCase()) {
                  currentGrant = { ...s.grant, demoOwnerPrivateKey: stored.demoOwnerPrivateKey };
                }
              } catch { /* A mismatched or invalid saved key cannot authorize this grant. */ }
            }
            setGrant(currentGrant);
            // THE SAME INTENT ON THE OTHER ARM. This branch serves a hosted
            // Privy owner signed in from any browser that did not mint the
            // agent — which is most of them — so an intent applied only to the
            // localStorage arm above would miss exactly the cohort that cannot
            // re-sign any other way.
            setChainId(requestedChain() ?? s.grant.chainId);
            setCaps(s.grant.caps);
            setCapText({});
            // NOTHING TO WRITE DOWN *HERE*, which is not the same as backed
            // up. A Privy agent has no owner key in any browser; a legacy one
            // has it in the browser that minted it and not in this one. Either
            // way this screen cannot show a key, so gating it behind "I have
            // saved my key" blocks the page on a task it cannot offer.
            setBackedUp(true);
          } else {
            // `exists` with no grant body: the server knows of an agent it
            // could not hand back. Restore is the only honest offer.
            setMode("restore");
          }
        }
        setGasSponsored(s.gasSponsored === true);
      })
      .catch(() => { if (active && generation === accountReadGeneration.current) { setServerArmed(null); setSession(null); setGrant(null); setAccountReadFailed(true); } });
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { values?: { customTokens?: unknown[]; basketSymbols?: string[]; v4AdapterAddress?: string; ponsAdapterAddress?: string; ponsClassVaultFactory?: string }; defaults?: { basketSymbols?: string[] } } | null) => {
        const list = (v?.values?.customTokens ?? []).filter(isValidCustomToken);
        setCustomTokens(list as CustomToken[]);
        setBasketSymbols(v?.values?.basketSymbols ?? v?.defaults?.basketSymbols ?? []);
        const a = v?.values?.v4AdapterAddress;
        setV4Adapter(typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined);
        const pa = v?.values?.ponsAdapterAddress;
        setPonsAdapter(typeof pa === "string" && /^0x[0-9a-fA-F]{40}$/.test(pa) ? (pa as `0x${string}`) : undefined);
        // THE STATION THAT WAS MISSING. `classFactory` was declared, typed into
        // this very response shape, threaded into all three signing calls — and
        // never assigned, so `setClassFactory` appeared exactly once in the
        // file: its own declaration. Every grant signed here carried
        // `ponsClassVaultFactory: undefined`, session.ts skipped the whole vault
        // block, no GRANT_PONS_CLASS marker was minted, and the worker's class
        // route returned at `if (!vault)` on every tick forever. The feature
        // was unreachable from the only screen that can reach it.
        const cf = v?.values?.ponsClassVaultFactory;
        setClassFactory(typeof cf === "string" && /^0x[0-9a-fA-F]{40}$/.test(cf) ? (cf as `0x${string}`) : undefined);
      })
      .catch(() => {
        setCustomTokens([]);
        setBasketSymbols([]);
      });
    return () => { active = false; };
  }, [accountReadVersion]);

  async function verifyCurrentAccount() {
    const expected = session;
    const generation = accountReadGeneration.current;
    if (serverArmed === null || !expected) throw new Error("We couldn't confirm this account. Try again after it reloads.");
    const result = await fetchAccountForSession(expected);
    const freshGrant = result.kind === "ready" ? result.account.status.grant as { smartAccount?: string; chainId?: number; sessionKeyAddress?: string } | undefined : undefined;
    if (generation !== accountReadGeneration.current || result.kind !== "ready" ||
        (grant && result.account.status.exists &&
          (freshGrant?.smartAccount?.toLowerCase() !== grant.smartAccount.toLowerCase() ||
           freshGrant?.chainId !== grant.chainId ||
           (freshGrant?.sessionKeyAddress && grant.sessionKeyAddress && freshGrant.sessionKeyAddress.toLowerCase() !== grant.sessionKeyAddress.toLowerCase())))) {
      accountReadGeneration.current++;
      setServerArmed(null);
      setSession(null);
      setGrant(null);
      setAccountReadFailed(true);
      throw new Error("This account changed. Check the wallet again before signing or discarding.");
    }
    return result.account;
  }

  /** Re-push the stored grant so the worker obeys it again (undo a desync). */
  async function reArm() {
    try { await verifyCurrentAccount(); } catch (e) { setError(e instanceof Error ? e.message : "Could not confirm this account."); return; }
    const stored = loadGrant();
    if (stored && needsPermissionReplacement(stored)) {
      setError("This saved permission was selected for revocation and cannot be re-armed. Review and renew below; your owner recovery access is kept.");
      return;
    }
    if (!stored?.serialized) {
      // THE BUTTON THAT DID NOTHING, second edition. Re-arming re-POSTs the
      // browser's own grant, and this browser may be holding an ADOPTED one —
      // read from the server for display and re-signing, with the session key
      // stripped out. There is nothing here to push back. Silent return was
      // this panel's original bug; say it instead, and point at the control
      // that does work from here.
      setError(
        "this browser doesn't hold a copy of the signed key — it's reading your agent from the server. " +
          "Re-sign the key below instead, which arms the worker with a fresh one.",
      );
      return;
    }
    // STRIP THE OWNER KEY BEFORE RE-POSTING. loadGrant() reads the localStorage
    // copy, and that one ALWAYS carries demoOwnerPrivateKey — it is the root of
    // client-side recovery. Posting it verbatim tripped the hosted owner-key
    // refusal every single time, so the desync panel's only escape button could
    // never work on the hosted service no matter how correct the grant was.
    const { demoOwnerPrivateKey: _ownerKey, ...g } = stored;
    setReArming(true);
    setError(null);
    try {
      const r = await fetch("/api/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Explicit, matching the mint-time POST. This is fetch's default for a
        // same-origin request, so it is not a fix — it just stops the two grant
        // POSTs looking like they disagree about whether auth matters.
        credentials: "same-origin",
        body: JSON.stringify(g),
      });
      if (r.ok) {
        setServerArmed(true);
      } else {
        // The button that did nothing. `if (r.ok)` with no else meant a refusal
        // left the banner up, re-enabled the button, and said NOTHING — so the
        // only feedback was "press it again", forever. Show what the server said.
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(refusalMessage(r.status, body.error));
      }
    } catch {
      setError("couldn't reach the server to re-arm this wallet.");
    }
    setReArming(false);
  }

  // Poll the account's on-chain balances (on the GRANT's chain) at the fund step.
  const refreshFunding = useCallback(async (addr: `0x${string}`, forChain: number) => {
    try {
      setFunding(await readFunding(addr, forChain));
    } catch {
      /* transient RPC error — keep the last reading */
    }
  }, []);

  useEffect(() => {
    if (!grant || !backedUp) return;
    refreshFunding(grant.smartAccount, grant.chainId);
    const id = setInterval(() => refreshFunding(grant.smartAccount, grant.chainId), 8000);
    return () => clearInterval(id);
  }, [grant, backedUp, refreshFunding]);

  /**
   * A CAP THAT CANNOT BE SIGNED AS ZERO.
   *
   * `min={1}` on the input is advisory — it styles the spinner and it is what a
   * browser validates on FORM SUBMIT, which this is not. Clearing the field, or
   * typing a 0, produced `Number("") === NaN` or a literal 0 and sealed it.
   *
   * AND A SIGNATURE CANNOT BE EDITED. An agent signed with `maxDrawdownPct: 0`
   * is bricked permanently: policy.ts computes `0bps >= 0bps` and refuses every
   * non-exit intent for the life of the grant, so the account cannot trade, and
   * no amount of funding, gas or re-configuring reaches it. Only a re-sign
   * does. One agent on the fleet is in exactly that state right now, rejecting
   * with `drawdown-breaker — 0bps >= 0bps` on every tick.
   *
   * THIS TIGHTENS THE RAIL. It removes a way to seal a permission that makes
   * the agent unusable; it cannot widen one, because every bound below is the
   * floor, never the ceiling.
   */
  /**
   * WHAT THE OWNER TYPED, HELD AS TEXT UNTIL IT READS AS A NUMBER.
   *
   * The inputs below are `type="text"` and not `type="number"`, and that is
   * the load-bearing part. A number input hands JavaScript an EMPTY STRING for
   * anything its own locale cannot parse, so a comma keystroke arrived here
   * indistinguishable from a cleared field — and the old handler turned both
   * into the floor. The raw text has to survive long enough to be read.
   *
   * `caps` only moves on a clean read, so a half-typed value never becomes the
   * number that would be signed, and the summary underneath keeps showing the
   * last figure the owner actually chose.
   */
  const [capText, setCapText] = useState<Partial<Record<keyof GrantCaps, string>>>({});
  const [capError, setCapError] = useState("");
  const capShown = (k: keyof GrantCaps) => capText[k] ?? String(caps[k]);
  // Validate every displayed cap, including an invalid legacy grant loaded
  // untouched. Raw edits also cannot renew using a last-valid hidden number.
  const capsInputInvalid = (Object.keys(CAP_FIELDS) as (keyof GrantCaps)[]).some(key =>
    !parseAmount(capShown(key), CAP_FIELDS[key]).ok,
  );
  const set = (k: keyof GrantCaps) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setCapText((t) => ({ ...t, [k]: raw }));
    const r = parseAmount(raw, CAP_FIELDS[k]);
    if (r.ok) {
      setCaps((c) => ({ ...c, [k]: r.value }));
      setCapError("");
      return;
    }
    setCapError(
      r.reason === "ambiguous"
        ? `That reads as either ${r.readings.join(" or ")} — which did you mean?`
        : r.reason === "out-of-range"
          ? `Enter a number between ${r.min} and ${r.max}.`
          : r.reason === "empty"
            ? "This limit needs a number."
            : "That is not a number I can read.",
    );
  };

  // Tokens listed in settings that THIS signature doesn't actually cover.
  // Settings can't reach into an already-signed key, so the gap is real: without
  // a re-sign the agent would watch the token and then revert at the wall when
  // it tried to sell. Better to say so here than to discover it as a failed op.
  const uncoveredNames = grant
    ? [
        ...uncoveredBasketSymbols(basketSymbols, grant),
        ...tokenCoverage(customTokens, grant).uncovered.map((t) => t.symbol),
      ]
    : [];

  /**
   * TOKENS THE OWNER ADDED AND NEVER PUT IN THE BASKET.
   *
   * A different problem from `uncoveredNames`, with a different remedy, and the
   * panel below promised the wrong one for it: "Re-signing fixes it: same
   * wallet, same funds, same caps, free and instant." For a token that is not in
   * the basket, re-signing fixes NOTHING — the grant will cover it and no
   * strategy will ever propose it, because `legsForUniverse` intersects the
   * watch set with `basketSymbols`. An owner who followed that sentence signed,
   * waited, and came back to ask why his agent still only traded stocks.
   */
  const watchedNotTraded = customTokens
    .map((t) => t.symbol)
    .filter((sym) => !basketSymbols.includes(sym));

  const isMainnet = chainId === MAINNET;
  // Mainnet is real money — the create button stays locked until the user
  // explicitly acknowledges real funds and the owner-key custody risk.
  const createBlocked = isMainnet && !mainnetAck;
  const restoreCurrentGrant = preview && grant?.smartAccount.toLowerCase() === preview.smartAccount.toLowerCase() ? grant : null;
  const restoreNetworks = [...(restoreCurrentGrant && restoreCurrentGrant.chainId !== chainId ? [restoreCurrentGrant.chainId] : []), chainId];

  async function onCreate() {
    if (status !== null || createBlocked) return;
    setError(null);
    if (!grant && !switching) {
      window.location.href = "/create";
      return;
    }
    // Refuse rather than mint something the server will throw away. /grant is
    // reachable directly — the connect step lives in the /app rail — so someone
    // can land here signed out, and hosted binding needs a wallet AND a session.
    if (session === null) {
      setError("still checking your session — give it a second and try again.");
      return;
    }
    if (session.hosted && !session.address) {
      setError("Sign in with your wallet first — a hosted agent is linked to the wallet you sign in with.");
      return;
    }
    setStatus("starting…");
    try {
      await verifyCurrentAccount();
      if (chainId === MAINNET && privyOwner) {
        for (const candidate of [grant, loadGrant(), ...loadRecoveryGrants()]) {
          if (candidate?.owner.toLowerCase() === privyOwner.account.address.toLowerCase() &&
              await trustedSavedGrant(candidate, session, window.location.origin)) {
            setSwitching(false);
            setGrant(candidate);
            setBackedUp(true);
            setError("This signing wallet already owns this account. Review and renew its existing permission below instead of creating another grant.");
            setStatus(null);
            return;
          }
        }
      }
      const options = {
        caps,
        onStatus: setStatus,
        chainId,
        extraTokens: customTokens,
        v4AdapterAddress: v4Adapter,
        ponsAdapterAddress: await verifiedAdapter(ponsAdapter, chainId, setStatus),
        ponsClassVaultFactory: classFactory,
        hostedAs: session.hosted ? (session.address ?? undefined) : undefined,
      };
      if (chainId === MAINNET && !privyOwner) {
        throw new Error("New mainnet wallets require your signed-in embedded owner wallet. Sign in to create one; existing recovery keys can still restore their original wallets.");
      }
      const { local: g, handoff } = chainId === MAINNET
        ? await createPrivyOwnedWallet(privyOwner!.account, privyOwner!.did, options)
        : await createAgentWallet(options);
      setGrant(g);
      // Take the ARMED state from what the server actually said. This used to be
      // left at whatever the mount-time fetch found — which is `false` on a first
      // visit, because there was no grant yet — so a brand-new wallet dropped
      // straight into the "this wallet isn't active" desync panel even when the
      // handoff had succeeded. The panel is for a wallet the server has genuinely
      // forgotten, not for one it just accepted.
      setServerArmed(handoff.ok);
      if (!handoff.ok) setError(handoff.error ?? "the server refused this grant");
      setStatus(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Which account does this owner key control, and what's in it? Read-only. */
  async function checkOwnerKey() {
    const generation = ++restorePreviewGeneration.current;
    setError(null);
    setPreview(null);
    setPreviewFunding(null);
    setRestoreRevocationAck(false);
    const key = restoreKey.trim();
    const selectedChain = chainId;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      setError("that isn't an owner key — expected 0x followed by 64 hex characters.");
      return;
    }
    setPreviewing(true);
    try {
      const p = await previewOwnerAccount(key as `0x${string}`, selectedChain);
      if (generation !== restorePreviewGeneration.current) return;
      const balance = await readFunding(p.smartAccount, selectedChain).catch(() => null);
      if (generation !== restorePreviewGeneration.current) return;
      setPreview(p);
      setPreviewFunding(balance);
    } catch (e) {
      if (generation === restorePreviewGeneration.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation === restorePreviewGeneration.current) setPreviewing(false);
    }
  }

  /** Invalidate earlier permissions before restoring an owner-authorized grant. */
  async function onRestore() {
    if (status !== null || !preview || !restoreRevocationAck || createBlocked) return;
    const ownerKey = restoreKey.trim() as `0x${string}`;
    const expectedAccount = preview.smartAccount as `0x${string}`;
    const selectedChain = chainId;
    const previousGrant = grant?.smartAccount.toLowerCase() === expectedAccount.toLowerCase() ? grant : null;
    setError(null);
    setRenewed(false);
    setStatus("starting…");
    try {
      await verifyCurrentAccount();
      const options = {
        caps,
        onStatus: setStatus,
        chainId: selectedChain,
        extraTokens: customTokens,
        v4AdapterAddress: v4Adapter,
        ponsAdapterAddress: await verifiedAdapter(ponsAdapter, selectedChain, setStatus),
        ponsClassVaultFactory: classFactory,
        hostedAs: session?.hosted ? (session.address ?? undefined) : undefined,
        expectAccount: expectedAccount,
      };
      // The preview account is immutable for this operation; a changed input
      // cannot revoke one wallet and then sign for another.
      if (previousGrant) {
        saveRecoveryGrant(previousGrant);
        markPermissionForReplacement(previousGrant);
        setReplacementRequired(true);
      }
      await stopAgent(session?.hosted ? session.address : undefined);
      setServerArmed(false);
      // A network move leaves funds and copied session keys on the old chain.
      // Both chains must confirm revocation before replacement can overwrite it.
      if (previousGrant && previousGrant.chainId !== selectedChain) {
        await revokeFromBrowser({ ownerKey, smartAccount: expectedAccount, chainId: previousGrant.chainId }, setStatus);
      }
      await revokeFromBrowser({ ownerKey, smartAccount: expectedAccount, chainId: selectedChain }, setStatus);
      const { local: g, handoff } = await restoreAgentWallet(ownerKey, options);
      // They just pasted the owner key, so it's demonstrably backed up — skip the
      // backup gate and drop them straight into the funded/manage view.
      localStorage.setItem(BACKUP_KEY, "1");
      setBackedUp(true);
      setGrant(g);
      setRestoreKey("");
      setPreview(null);
      setSwitching(false); // the restored wallet IS the active one now
      // Was an unconditional `true` — the mirror of the create bug: it claimed the
      // worker had the grant whether or not the server took it, so a refusal was
      // reported as a live agent.
      setServerArmed(handoff.ok);
      if (!handoff.ok) setError(handoff.error ?? "the server refused this grant");
      setStatus(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Replace permissions only after owner-authorized on-chain revocation confirms. */
  const [renewing, setRenewing] = useState(false);
  const [renewed, setRenewed] = useState(false);
  const [renewalAck, setRenewalAck] = useState(false);
  const [replacementRequired, setReplacementRequired] = useState(false);
  useEffect(() => {
    setReplacementRequired(grant ? needsPermissionReplacement(grant) : false);
  }, [grant]);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [revokeAck, setRevokeAck] = useState(false);
  const renewalFocus = useRef<"complete" | "form" | null>(null);
  useEffect(() => {
    if (!renewalFocus.current) return;
    const target = document.getElementById(renewalFocus.current === "complete" ? "renewal-complete" : RESIGN_ANCHOR);
    renewalFocus.current = null;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [renewed]);
  const privyOwner = usePrivyOwner();
  /**
   * CAN THIS BROWSER RE-SIGN THIS AGENT, and by which owner.
   *
   * Two owners, one control. A legacy agent re-signs from the owner key in this
   * browser's localStorage; a Privy agent re-signs from the embedded wallet,
   * which merrymen never holds and never can. Both land in `renewKey` below, so
   * there is still exactly ONE signing control with one set of conditions —
   * the thing this file already learned the hard way.
   *
   * A PRIVY AGENT HAD NO RE-SIGN AT ALL until now: this returned early on the
   * missing owner key, and the panel rendered a dead end telling the owner to
   * paste a key that does not exist for their account. Since `CreateAgent`
   * mints Privy-owned agents whenever the beta flag is on, that was the cohort
   * least able to widen its own wall — and widening it is the only way a coin
   * an agent found becomes a coin it can trade.
   */
  const resignBy: "owner-key" | "privy" | null = grant?.demoOwnerPrivateKey
    ? "owner-key"
    : isPrivyOwned(grant) && privyOwner
      ? "privy"
      : null;

  function ownerWallet(forChain = grant!.chainId) {
    return {
      smartAccount: grant!.smartAccount as `0x${string}`,
      chainId: forChain,
      ...(resignBy === "privy" ? { ownerAccount: privyOwner!.account } : { ownerKey: grant!.demoOwnerPrivateKey as `0x${string}` }),
    };
  }

  async function stopOrRevoke(revoke: boolean) {
    if (!grant || securityBusy || renewing || (revoke && (!resignBy || !revokeAck))) return;
    setSecurityBusy(true);
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      try { saveRecoveryGrant(grant); } catch (e) {
        if (revoke) throw e;
        setSecurityError("Browser recovery details could not be saved. Keep this page open to manage this wallet after stopping.");
      }
      if (revoke) {
        markPermissionForReplacement(grant);
        setReplacementRequired(true);
      }
      // A service outage must not veto the owner’s separate on-chain authority.
      try {
        await verifyCurrentAccount();
        await stopAgent(session?.hosted ? session.address : undefined);
        setServerArmed(false);
        setSecurityMessage("Stop request accepted. The worker stops on its next check; earlier session keys are not yet revoked on-chain.");
      } catch (e) {
        if (!revoke) throw e;
        setSecurityError(`The service stop was not confirmed: ${e instanceof Error ? e.message : String(e)}. On-chain revocation is being attempted separately.`);
      }
      if (revoke) {
        const result = await revokeFromBrowser(ownerWallet(), setSecurityMessage);
        setSecurityMessage(`Earlier permissions on ${chainLabel(grant.chainId)} are revoked on-chain. Transaction: ${result.transactionHash}. Your wallet and withdrawal access are kept.`);
        setRevokeAck(false);
      }
    } catch (e) {
      setSecurityError(e instanceof Error ? e.message : "Could not confirm this action. Your wallet was kept.");
    } finally {
      setSecurityBusy(false);
    }
  }

  async function renewKey() {
    if (!grant || !resignBy || renewing || securityBusy || !renewalAck || capsInputInvalid ||
        (chainId === MAINNET && grant.chainId !== MAINNET && !mainnetAck)) return;
    let stopped = false;
    let revoked = false;
    let preflightPassed = false;
    setError(null);
    setRenewed(false);
    setStatus("checking your permission…");
    setRenewing(true);
    try {
      await verifyCurrentAccount();
      const priorTrencher = grantTrencher(grant);
      if (priorTrencher && (!autonomousTrencher || chainId !== grant.chainId || (TRENCHER_FACTORY && TRENCHER_FACTORY.toLowerCase() !== priorTrencher.factory))) {
        const client = createPublicClient({chain: grant.chainId === MAINNET ? robinhoodChain : robinhoodTestnet, transport: http()});
        const code = await client.getCode({address:priorTrencher.vault});
        if (code && code !== "0x") {
          const [held,cash] = await Promise.all([
            client.readContract({address:priorTrencher.vault,abi:TRENCHER_VAULT_ABI,functionName:"tokens"}),
            client.readContract({address:CASH.USDG,abi:erc20Abi,functionName:"balanceOf",args:[priorTrencher.vault]}),
          ]);
          if (held.length || cash > 0n) throw new Error("Close or recover your Trencher vault positions and cash before removing or changing this permission. Your current key has not been replaced.");
        }
      }
      if (autonomousTrencher && !TRENCHER_FACTORY) throw new Error("The verified Trencher deployment is unavailable; your existing permission has not been replaced.");
      // FETCH SETTINGS AT CLICK TIME, not from mount state. This is the exact
      // button an owner presses right after saving a new token or the adapter
      // address in /settings — and the mount-time fetch predates that save, so
      // re-signing from stale state silently sealed a wall WITHOUT the thing
      // they just added, with nothing failing until the first no-exit reject.
      let freshTokens: CustomToken[];
      let freshAdapter: `0x${string}` | undefined;
      let freshPons: `0x${string}` | undefined;
      let freshClassFactory: `0x${string}` | undefined;
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        if (!r.ok) throw new Error("settings unavailable");
        const body: unknown = await r.json();
        if (!body || typeof body !== "object" || !("values" in body) ||
            !body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
          throw new Error("invalid settings response");
        }
        const v = body.values as Record<string, unknown>;
        if (v.customTokens !== undefined &&
            (!Array.isArray(v.customTokens) || !v.customTokens.every(isValidCustomToken))) {
          throw new Error("invalid custom tokens");
        }
        const addressSetting = (value: unknown): `0x${string}` | undefined => {
          if (value === undefined || value === "") return undefined;
          if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
            throw new Error("invalid adapter settings");
          }
          return value as `0x${string}`;
        };
        freshTokens = (v.customTokens ?? []) as CustomToken[];
        freshAdapter = addressSetting(v.v4AdapterAddress);
        freshPons = addressSetting(v.ponsAdapterAddress);
        freshClassFactory = addressSetting(v.ponsClassVaultFactory);
        setCustomTokens(freshTokens);
        setV4Adapter(freshAdapter);
        setPonsAdapter(freshPons);
        setClassFactory(freshClassFactory);
      } catch {
        // An unavailable response is not an empty settings record: signing
        // stale mount state could silently leave out the adapter just saved.
        throw new Error("Could not refresh your trading settings. Retry when settings are available.");
      }
      // The SELECTED chain and the CURRENT caps — not the old grant's. The old
      // behaviour reused grant.chainId and grant.caps, so renewing while the
      // selector showed mainnet silently re-signed on testnet, and any cap the
      // owner had just edited in the form was ignored. What the page shows is
      // what gets signed, or the page is lying.
      const options = {
        caps,
        onStatus: setStatus,
        chainId,
        extraTokens: freshTokens,
        v4AdapterAddress: freshAdapter,
        ponsAdapterAddress: await verifiedAdapter(freshPons, chainId, setStatus),
        ponsClassVaultFactory: freshClassFactory,
        trencherFactory: autonomousTrencher && TRENCHER_FACTORY && /^0x[0-9a-fA-F]{40}$/.test(TRENCHER_FACTORY) ? TRENCHER_FACTORY as `0x${string}` : undefined,
        hostedAs: session?.hosted ? (session.address ?? undefined) : undefined,
        /**
         * THE ACCOUNT WE ARE RE-SIGNING, stated so the signer can refuse.
         *
         * A re-sign and a brand-new agent are the same call with a different
         * owner. For the owner-key path that cannot diverge — the key comes out
         * of THIS grant. For Privy it very much can: `usePrivyOwner` returns
         * whichever embedded wallet is connected right now, so a different
         * login in the same browser derives a different account, mints a second
         * agent, and leaves this one's funds exactly where they are, with
         * nothing failing anywhere. mintGrant refuses instead.
         */
        expectAccount: grant.smartAccount as `0x${string}`,
      };
      // Check the canonical replacement before any persistent mutation, stop,
      // or revocation. This produces no key/signature to reuse after revoking.
      await preflightAgentGrant(
        resignBy === "privy" ? privyOwner!.account : privateKeyToAccount(grant.demoOwnerPrivateKey as `0x${string}`),
        options,
      );
      preflightPassed = true;
      // Invalidate first: a new grant signed before this receipt would carry
      // the old enable nonce and be invalidated along with the old permission.
      // Preserve only public recovery inputs for an adopted second-browser grant.
      saveRecoveryGrant(grant);
      markPermissionForReplacement(grant);
      setReplacementRequired(true);
      await stopAgent(session?.hosted ? session.address : undefined);
      stopped = true;
      await revokeFromBrowser(ownerWallet(), setStatus);
      if (chainId !== grant.chainId) await revokeFromBrowser(ownerWallet(chainId), setStatus);
      revoked = true;
      // TWO OWNERS, ONE CONTROL. Everything above — the fresh settings, the
      // selected chain, the current caps, the adapter verification — is shared;
      // only where the signature comes from differs.
      const { local: g, handoff } =
        resignBy === "privy"
          ? await createPrivyOwnedWallet(privyOwner!.account, privyOwner!.did, options)
          : await restoreAgentWallet(grant.demoOwnerPrivateKey as `0x${string}`, options);
      setGrant(g);
      // Same correction as create/restore: report what the server said, so a
      // renewed key that the server refused doesn't read as a renewed agent.
      setServerArmed(handoff.ok);
      if (!handoff.ok) setError(handoff.error ?? "the server refused the renewed grant");
      if (handoff.ok) renewalFocus.current = "complete";
      setRenewed(handoff.ok);
      setRenewalAck(false);
    } catch (e) {
      if (stopped) setServerArmed(false);
      setError(`${revoked ? "Earlier permissions were revoked, but a replacement was not activated. " : stopped ? "The service accepted the stop request. " : !preflightPassed ? "This attempt kept your existing permission unchanged. " : ""}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStatus(null);
      setRenewing(false);
    }
  }

  function confirmBackup() {
    localStorage.setItem(BACKUP_KEY, "1");
    setBackedUp(true);
  }

  async function discard() {
    if (discarding) return;
    // Discarding forgets THIS wallet's keys from the browser. If it still holds
    // funds, those funds don't move — they stay in the smart account, reachable
    // only with the owner key. Make the user acknowledge that before they can
    // strand money by starting over (exactly the trap that loses funded wallets).
    if ((funding?.usdgUnits ?? 0n) > 0n) {
      const amt = funding ? funding.usdg.toFixed(2) : "some";
      const okToDrop = window.confirm(
        `This wallet still holds ${amt} USDG.\n\n` +
          `Discarding it here does NOT move the funds — they stay in the smart account and can ` +
          `only be reached with THIS wallet's owner key. Back that key up first, or sweep the ` +
          `funds out now by running:  merrymen recover\n\n` +
          `Discard anyway?`,
      );
      if (!okToDrop) return;
    }
    /**
     * AND SAY WHAT "START OVER" ACTUALLY DOES, WHICH IS LESS THAN IT SOUNDS.
     *
     * Reported: "Should positions and trades also become empty when starting
     * over in paper mode?" — followed by "They still appear", with a portfolio
     * showing two positions and five trades beside a freshly seeded $1,000.
     *
     * They do, and the reason is not a stale cache. An account signed in with
     * X is derived from the wallet behind that login, and that owner does not
     * change when this button is pressed — so the next agent resolves to THE
     * SAME smart account, and the same account has the same book. What is
     * discarded is the signed key, not the history. (An account made from a
     * browser-generated owner key does get a new address, because a new key is
     * generated with it, which is why this reads as inconsistent.)
     *
     * Clearing the book is worker-side work: the ledger the portfolio reads is
     * mirrored from the child every tick, so deleting rows anywhere above the
     * child is undone within a minute — which is why this said so BEFORE the
     * click rather than letting somebody conclude the reset silently failed.
     *
     * IT NOW ASKS THE WORKER TO DO IT. The practice reset, queued with the
     * discard below, is the one command the child can act on, and the child
     * REFUSES IT ON THE LIVE RAIL: real positions and trades are never deleted
     * by anything here. On paper it puts the paper cash back, drops the
     * simulated positions, and closes the old fills into a new accounting
     * epoch — kept on disk for forensics, counted toward nothing. Queued
     * unconditionally because only the worker knows which rail it is on; this
     * screen would be guessing.
     */
    if (grant && !grant.demoOwnerPrivateKey) {
      const okToKeepHistory = window.confirm(
        `Starting over forgets the signed key, and your account address does not change.\n\n` +
          `It comes from the login you signed in with, so the next agent lands on the same ` +
          `address.\n\n` +
          `If you are on PAPER, the paper book restarts: cash back to the starting stake, ` +
          `positions cleared, and earlier paper trades kept on file but no longer counted.\n\n` +
          `If you are trading for REAL, nothing is deleted — your positions, trades and P&L stay ` +
          `exactly as they are.\n\nStart over anyway?`,
      );
      if (!okToKeepHistory) return;
    }
    // Destroy the worker-side handoff — otherwise the "discarded" grant stays
    // armed and the worker keeps trading on it (kill-switch semantics) — AND
    // ask for the paper book to be restarted. The reset is best-effort and
    // unconditional: only the worker knows which rail it is on (or, while its
    // book is held, the orchestrator, which asks the ledger), and each refuses
    // a live agent outright, so nothing real can be cleared.
    //
    // ONE REQUEST, SENT NOW, WITH keepalive. The reset finds its agent through
    // the grant this discards, so the two cannot simply be fired side by side
    // (the DELETE won that race in production and the reset answered 401,
    // 2026-09-21T16:24:24Z), and a DELETE held back until the reset answered
    // was never sent at all by a tab closed in the meantime, with this page
    // already forgetting the grant it would need to try again. The server
    // orders the two instead (/api/grants/discard, lib/start-over.ts): the
    // account is read, the grant removed as DELETE /api/grants removes it,
    // then the reset queued. keepalive, so closing the tab straight after
    // pressing this still delivers the kill.
    const discardedGrant = loadGrant();
    setDiscarding(true);
    setError(null);
    try {
      const res = await fetch("/api/grants/discard", { method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedTenant: session?.hosted ? session.address : undefined }) });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? `The server did not discard the grant (${res.status}). Your wallet is still saved here; try again.`);
        return;
      }
    } catch {
      setError("The server could not confirm the kill. Your wallet is still saved here; check the connection and try again.");
      return;
    } finally {
      setDiscarding(false);
    }
    // Another tab or a wallet switch can save a newer grant while the server
    // answers. This response is not permission to clear that wallet or backup.
    const currentGrant = loadGrant();
    if (currentGrant?.smartAccount !== discardedGrant?.smartAccount || currentGrant?.serialized !== discardedGrant?.serialized) {
      setError("The saved wallet changed while the kill was pending. The newer wallet and its backup were kept; check its status before trying again.");
      return;
    }
    try {
      clearGrant();
      localStorage.removeItem(BACKUP_KEY);
    } catch (e) {
      setServerArmed(false);
      setError(`The service accepted the stop, but browser cleanup failed. Your recovery data was kept. ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setRenewed(false);
    setGrant(null);
    setBackedUp(false);
    setReveal(false);
    setAck(false);
    setMainnetAck(false);
    setFunding(null);
    // AND THE CHAIN, WHICH THIS FORGOT — the bug a tester walked into.
    //
    // "Start over" left `chainId` and `caps` holding whatever the discarded
    // wallet had, including a testnet selection made from the checkbox below.
    // Since the mount effect only assigns them `if (stored)`, and there is no
    // stored grant after a discard, the next re-sign sealed a chain nobody had
    // chosen on this screen — reported as "it goes to the Backup page and
    // chooses mainnet mode", and in the mirror case as a key signed for 46630
    // while the worker trades 4663, which the chat then reports as "funds sent
    // here will sit unused".
    //
    // A start-over that leaves the two things a signature seals behind is not
    // one. Both go back to the same defaults a first-time owner gets.
    setChainId(MAINNET);
    setCaps(PRESETS[0]!.caps);
    setCapText({});
  }

  /**
   * Which caps the form now differs from the SIGNED ones, in words.
   *
   * The re-sign panel lets caps be edited in place, and an owner who tweaked a
   * number and scrolled away should not discover the change by reading a
   * receipt later. Derived from `grant.caps` rather than from a snapshot of the
   * form, so it stays true no matter how the edit was made — including a preset
   * click higher up the page.
   */
  const capChanges = grant
    ? (
        [
          ["per-trade", caps.perTradeUsdg, grant.caps.perTradeUsdg, "USDG"],
          ["daily", caps.dailyUsdg, grant.caps.dailyUsdg, "USDG"],
          ["trades/day", caps.maxOpsPerDay, grant.caps.maxOpsPerDay, ""],
          ["expiry", caps.expiryDays, grant.caps.expiryDays, "days"],
          ["breaker", caps.maxDrawdownPct, grant.caps.maxDrawdownPct, "%"],
        ] as const
      )
        .filter(([, now, was]) => now !== was)
        .map(([label, now, was, unit]) => `${label} ${was}${unit && ` ${unit}`} → ${now}${unit && ` ${unit}`}`)
    : [];
  const capsEdited = capChanges.length > 0;
  /**
   * Every difference the re-sign would introduce, chain included.
   *
   * The chain move is the biggest change available on this panel and it was the
   * one the notice did not mention — so it leads.
   */
  const allChanges =
    grant && chainId !== grant.chainId
      ? [`chain ${grant.chainId === MAINNET ? "Robinhood Chain" : "testnet"} → ${chainId === MAINNET ? "Robinhood Chain" : "testnet"}`, ...capChanges]
      : capChanges;
  const anyChange = allChanges.length > 0;

  const gasFunded = (funding?.gasWei ?? 0n) > 0n;
  // CAN IT ACTUALLY START? Not the same question as 'does it hold ETH' once a
  // sponsor pays the fee. Through the shared rule rather than a fourth local
  // spelling of it — the console and the settings checklist ask it too, and
  // this page is the one that tells a new owner they are done.
  const canTrade = canStart({
    balances: {
      ethWei: String(funding?.gasWei ?? 0n),
      cashUsdg: String(funding?.usdgUnits ?? 0n),
    },
    gasSponsored,
  });
  const usdgFunded = (funding?.usdgUnits ?? 0n) > 0n;
  // Once a grant exists, the truth is what's IN it — not the selector state.
  const activeChainId = grant ? grant.chainId : chainId;
  const grantIsTestnet = (grant?.chainId ?? TESTNET) === TESTNET;
  // This browser thinks it has a wallet, but the server/worker no longer holds
  // its grant — the wallet is inert until re-armed (or should be discarded).
  const desynced = grant !== null && serverArmed === false;

  // Which step the wizard is on, derived from the SAME state that gates the
  // phases below — presentation only, no logic changed. -1 = the desync recovery
  // panel (its own screen, off the numbered track).
  const wizStep = desynced ? -1 : !grant || switching ? 0 : !backedUp ? 1 : 2;

  // ARRIVING AT /grant#resign — from the Telegram "Sign now" button or a
  // dashboard banner. The section below renders only once the grant has
  // loaded, long after the browser's own jump to the anchor gave up, so the
  // owner landed at the top of the page. Scroll there ourselves, once, the
  // first time it exists (resign-anchor.ts says why only once).
  const resignJumped = useRef(false);
  useEffect(() => {
    const present = document.getElementById(RESIGN_ANCHOR) !== null;
    if (!shouldJumpToResign(window.location.hash, resignJumped.current, present)) return;
    resignJumped.current = true;
    // Instant, like a real anchor jump: a smooth scroll is driven by animation
    // frames, which a hidden tab or an in-app browser may never deliver.
    document.getElementById(RESIGN_ANCHOR)?.scrollIntoView({ block: "start" });
  }, [wizStep, grant, serverArmed, replacementRequired]);

  // SIGNED IN ON THIS SCREEN. It loads the grant once, on mount, as whoever
  // was signed in then — so an owner who opened a "Sign now" link signed out
  // (Telegram's in-app browser usually is), then signed in here, kept seeing
  // the restore form. Load again as them; the hash survives the reload, so the
  // jump above then lands on the section they came for.
  // Guarded against a reload loop — resign-anchor.ts `shouldReloadAfterSignIn`.
  const hasGrantRef = useRef(false);
  hasGrantRef.current = grant !== null;
  useEffect(() => {
    // Returning from another tab may mean the hosted cookie now belongs to a
    // different owner. Remove the old signing surface before re-reading it.
    const revalidate = () => {
      accountReadGeneration.current++;
      setServerArmed(null);
      setSession(null);
      setGrant(null);
      setAccountReadFailed(false);
      setAccountReadVersion((n) => n + 1);
    };
    const visible = () => { if (document.visibilityState === "visible") revalidate(); };
    window.addEventListener(SIGNED_IN_EVENT, revalidate);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener(SIGNED_IN_EVENT, revalidate);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    const again = () => {
      let lastAt: number | null = null;
      try {
        lastAt = Number(sessionStorage.getItem(SIGNED_IN_RELOAD_KEY) ?? 0);
      } catch {
        lastAt = null;
      }
      if (!shouldReloadAfterSignIn(hasGrantRef.current, lastAt, Date.now())) return;
      try {
        sessionStorage.setItem(SIGNED_IN_RELOAD_KEY, String(Date.now()));
      } catch {
        return; // cannot remember that we reloaded, so do not
      }
      window.location.reload();
    };
    window.addEventListener(SIGNED_IN_EVENT, again);
    return () => window.removeEventListener(SIGNED_IN_EVENT, again);
  }, []);
  const RAIL = ["Wallet", "Backup", "Funds", "Ready"] as const;
  const KICKS = ["Step one · set the wall", "Step two · back up the key", "Step three · fund the account"];

  // An HTTP error cannot establish that the server discarded this wallet.
  // Hide server actions until the authenticated status is known, but keep
  // locally saved recovery keys available during an outage. They need no DB.
  if (serverArmed === null) return <AppShell><PageHeader title="Wallet & permissions" />
    <section className="grant-shell" role="status">
      {accountReadFailed ? <><h1>Couldn&rsquo;t check your agent</h1><p>We can&rsquo;t confirm this wallet&rsquo;s status right now.</p>
        <button className="flow-secondary" type="button" onClick={() => { accountReadGeneration.current++; setAccountReadFailed(false); setAccountReadVersion((n) => n + 1); }}>Try again</button></>
        : <p>Checking your agent…</p>}
      {securityMessage && <p role="status">{securityMessage}</p>}
      {securityError && <p role="alert">{securityError}</p>}
      {savedWallets.length > 0 && <div className="saved-wallets">
        <h2>Wallets saved in this browser</h2>
        <p>These recovery keys are stored on this device and remain available while the service is down.</p>
        {savedWallets.map((w) => <WalletRow key={w.smartAccount} w={w} />)}
      </div>}
    </section>
  </AppShell>;

  return (
    /*
     * CHROME ONLY. Every class, every sheet and every warning on this page is
     * untouched — this commit gives it the rail, the tape, the tab bar and the
     * search, and nothing else.
     *
     * That restraint is deliberate. A sibling investigation proved by mutation
     * that seventeen regressions to this page's signing flow pass the entire
     * test suite, including deleting the disabled guard that stands between a
     * reader and an unacknowledged real-funds signature. Renaming its classes
     * is a five-hundred-line diff on a file that mints owner keys, and it does
     * not belong in the same change as adding a navigation bar.
     */
    <AppShell>
      <PageHeader
        title="Wallet & permissions"
        /* THE CHAIN INDICATOR MOVES, IT DOES NOT GO. Its markup and its
           classes are exactly as they were; only its parent changed. On a
           page that seals spending caps, which chain they are being sealed
           for is the one fact that must never be lost in a layout change. */
        right={
          <span className={`gw-chain ${activeChainId === MAINNET ? "mainnet" : ""}`}>
            <span className="dot" />
            {chainLabel(activeChainId)}
          </span>
        }
      />
      <div className="sc-root gw">
        <div className="gw-grid" aria-hidden="true" />

      {wizStep >= 0 && (
        <>
          <nav className="gw-rail" aria-label="Setup progress">
            {RAIL.map((label, i) => {
              const s = i < wizStep ? "done" : i === wizStep ? "on" : "todo";
              return (
                <span key={label} className={`gw-node ${s}`}>
                  <span className="gw-dot">{i < wizStep ? "✓" : i === RAIL.length - 1 ? "→" : String(i + 1).padStart(2, "0")}</span>
                  <span className="gw-label">{label}</span>
                </span>
              );
            })}
          </nav>
          {wizStep <= 2 && <span className="gw-kick">{KICKS[wizStep]}</span>}
        </>
      )}

        <div className="grant-shell">
        {grant && !switching && <section id="permission-security" className="grant-summary" style={{ marginBottom: 16 }}>
          <h2>Stop or revoke permissions</h2>
          <p>Stopping this service needs no wallet signature. Revocation is a separate owner-authorized transaction on {chainLabel(grant.chainId)} that invalidates earlier session keys, including copies. Your account and recovery access stay available.</p>
          <button className="copy-btn" disabled={securityBusy || renewing} onClick={() => void stopOrRevoke(false)}>Stop agent now</button>
          {resignBy ? <>
            <label className="ack-row" style={{ marginTop: 12 }}><input type="checkbox" checked={revokeAck} disabled={securityBusy || renewing} onChange={e => setRevokeAck(e.target.checked)} /><span>I understand revocation uses ETH for network fees on this network and stops all earlier permissions for this account.</span></label>
            <button className="grant-btn" disabled={securityBusy || renewing || !revokeAck} onClick={() => void stopOrRevoke(true)}>{securityBusy ? "Checking…" : "Stop & revoke on-chain"}</button>
          </> : <p>Sign in as the owner or restore the recovery key to revoke on-chain. You can still stop the service now.</p>}
          {securityMessage && <p role="status">{securityMessage}</p>}
          {securityError && <p role="alert">{securityError}</p>}
        </section>}
        {/* ─── WHO YOU ARE SIGNED IN AS, AND THE WAY OUT ──────────────────────
            This page is titled "Wallet & permissions" and is where anyone looking
            to change accounts arrives — it had neither the signed-in address nor
            a sign-out. The owner hit exactly that: "I don't know my tenant/login
            wallet address offhand" and then "no logout button".

            The address is PUBLIC — it is the tenant id, already on every log line
            — and it is the one fact that says which account you are operating.
            It is never a key: `session` here is `{hosted, address}` and nothing
            else. `SignOut` ends the Privy session before the server one, which
            is what stops the prove-on-authenticated effect signing you straight
            back in. */}
        {session?.hosted && session.address && (
          <div className="grant-session">
            <span>
              signed in as <code>{session.address}</code>
            </span>
            <SignOut after={() => window.location.reload()} className="flow-secondary" />
          </div>
        )}
        {/* ─── desync banner: browser has a wallet the server no longer holds ── */}
        {desynced && (
          <div className="grant-panel desync-panel">
            <h1 className="grant-title">this wallet isn&apos;t active</h1>
            <p className="grant-sub">
              Trading is inactive. Reconnect this wallet to resume, or choose another wallet.
            </p>
            {/* THE REASON, ON THE SCREEN THAT REPORTS THE PROBLEM. The shared
                error line lives inside the create panel (it is nested under
                `!grant || switching`), so once a grant exists it cannot render —
                which is every desync. A refusal here was therefore invisible no
                matter which path produced it, and pressing re-arm looked like a
                button that did nothing. */}
            {error && <div className="grant-error mono">{error}{isWallTooWide(error) && <> <a href="/settings">Review custom tokens</a></>}</div>}
            {/* WHAT IS ACTUALLY IN IT, and the key to it. A wallet reaches this
                panel precisely when the server won't arm it, which is also when
                someone is most likely to think their money has vanished. The
                account is on-chain and the key is in this browser — show both
                rather than only naming the address. */}
            <div className="saved-wallets">
              {savedWallets
                .filter((w) => w.smartAccount.toLowerCase() === grant!.smartAccount.toLowerCase())
                .map((w) => (
                  <WalletRow key={w.smartAccount} w={w} />
                ))}
            </div>
            <div className="fund-actions" style={{ display: "flex", gap: 10 }}>
              <button className="grant-btn" onClick={() => {
                if (session?.hosted || replacementRequired) document.getElementById(RESIGN_ANCHOR)?.scrollIntoView({ block: "center" });
                else void reArm();
              }} disabled={reArming || renewing || securityBusy} style={{ flex: 1 }}>
                {reArming ? "re-arming…" : session?.hosted || replacementRequired ? "review and renew permission" : "re-arm this wallet"}
              </button>
              <button className="btn-kill" onClick={() => void discard()} disabled={discarding || renewing || securityBusy} style={{ flex: 1 }}>
                {discarding ? "discarding…" : "discard & start fresh"}
              </button>
            </div>
          </div>
        )}

        {/* ─── wallets this browser superseded ─────────────────────────────── */}
        {/* Creating a new agent mints a new owner key, so it lands on a DIFFERENT
            address — the old account keeps whatever was sent to it. Its key is
            archived rather than overwritten, but an archive nothing renders is
            the same as a deletion to the person looking for their money. Always
            visible, on every step, because someone hunting for a missing balance
            should not have to be at the right point in a wizard to find it. */}
        {savedWallets.some((w) => !w.current) && (
          <div className="grant-panel">
            <h2 className="grant-title">wallets you used before</h2>
            <div className="saved-wallets">
              {savedWallets
                .filter((w) => !w.current)
                .map((w) => (
                  <WalletRow key={w.smartAccount} w={w} />
                ))}
            </div>
          </div>
        )}

        {/* ─── phase 1: pick a chain, set caps, create the wallet ────────── */}
        {(!grant || switching) && (
          <div className="grant-panel">
            <fieldset className="grant-renewal-fields" disabled={status !== null || previewing}>
            {switching && grant && (
              <div className="switch-note">
                Restoring replaces your active wallet, <span className="mono">{short(grant.smartAccount)}</span>. You can still access it under saved wallets.
                <button
                  className="copy-btn"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    setSwitching(false);
                    setError(null);
                    setPreview(null);
                    setRestoreKey("");
                  }}
                >
                  ← never mind, keep {short(grant.smartAccount)}
                </button>
              </div>
            )}
            <div className="mode-tabs">
              <button
                type="button"
                className={`mode-tab ${mode === "create" ? "on" : ""}`}
                onClick={() => {
                  window.location.href = "/create";
                }}
              >
                new wallet
              </button>
              <button
                type="button"
                className={`mode-tab ${mode === "restore" ? "on" : ""}`}
                onClick={() => {
                  setMode("restore");
                  setError(null);
                }}
              >
                restore a funded wallet
              </button>
            </div>

            <h1 className="grant-title">
              {mode === "create" ? "Create your agent's wallet" : "Restore your funded wallet"}
            </h1>
            <p className="grant-sub">
              {mode === "create" ? (
                <>
                  Choose a network and set your agent&apos;s trading limits.
                </>
              ) : (
                <>
                  Enter your <b>recovery key</b> to restore your wallet with updated trading limits.{" "}
                </>
              )}
            </p>

            <div className="chain-choice">
              <button
                type="button"
                className={`chain-card ${!isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(TESTNET)}
              >
                <span className="chain-card-title"><GI d="tree" size={16} /> Testnet (46630)</span>
                <span className="chain-card-body">
                  {/* SAID AT THE POINT OF CHOICE, not afterwards in the chat.
                      The hosted worker trades Robinhood Chain, so a key signed
                      for the sandbox cannot trade at all — and an owner only
                      found that out later, from "funds sent here will sit
                      unused". Practice mode on this service is PAPER TRADING,
                      which is a setting and needs no separate chain. */}
                  {session?.hosted
                    ? "Not for this service — your agent trades Robinhood Chain, so a key signed here cannot trade at all. For simulated trading, turn Paper on in Settings instead."
                    : "Simulated trading at live prices. No real deposits needed."}
                </span>
              </button>
              <button
                type="button"
                className={`chain-card danger ${isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(MAINNET)}
              >
                <span className="chain-card-title"><GI d="coin" size={16} /> Robinhood Chain (4663)</span>
                <span className="chain-card-body">
                  The real Robinhood Chain — real funds, real trades. Only when you&apos;re ready.
                </span>
              </button>
            </div>

            {isMainnet && (
              <div className="mainnet-warning">
                This permission allows trading with real funds. Keep your recovery key private and choose limits you’re comfortable with.
                <label className="ack-row" style={{ marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={mainnetAck}
                    onChange={(e) => setMainnetAck(e.target.checked)}
                  />
                  <span>
                    I understand — real funds. Anyone with my owner recovery key can bypass every cap and control my funds.
                  </span>
                </label>
              </div>
            )}

            {mode === "restore" && (
              <div className="restore-box">
                <span className="field-label">your wallet&apos;s owner key</span>
                <input
                  className="restore-input mono"
                  type="password"
                  placeholder="0x… (the key you backed up when you created it)"
                  value={restoreKey}
                  disabled={status !== null}
                  onChange={(e) => { ++restorePreviewGeneration.current; setRestoreKey(e.target.value); setPreview(null); setPreviewFunding(null); setPreviewing(false); setRestoreRevocationAck(false); }}
                  autoComplete="off"
                />
                <button className="copy-btn" onClick={() => void checkOwnerKey()} disabled={previewing || status !== null}>
                  {previewing ? "checking…" : "check this wallet"}
                </button>

                {preview && (
                  <div className="restore-preview mono">
                    <div>
                      <span className="rk">this key controls</span>
                      <span className="rv" style={{ wordBreak: "break-all" }}>{preview.smartAccount}</span>
                    </div>
                    <div>
                      <span className="rk">which holds</span>
                      <span className="rv">
                        {previewFunding
                          ? `${previewFunding.usdg.toFixed(2)} USDG · ${(Number(previewFunding.gasWei) / 1e18).toFixed(5)} ETH`
                          : "…"}
                      </span>
                    </div>
                    <div className="restore-confirm">
                      {previewFunding && previewFunding.usdg > 0
                        ? "✓ Funds found — restore it below and your band rides again."
                        : "This account is empty on this chain. Pick the other chain above, or try your other owner key."}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="preset-row">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset-card ${sameCaps(caps, p.caps) ? "selected" : ""}`}
                  onClick={() => { setCaps(p.caps); setCapText({}); setCapError(""); }}
                >
                  <span className="preset-label"><GI d={p.icon} size={14} /> {p.label}</span>
                  <span className="preset-blurb">{p.blurb}</span>
                  <span className="preset-caps mono">
                    {p.caps.perTradeUsdg}/trade · {p.caps.dailyUsdg}/day · {p.caps.maxDrawdownPct}% breaker ·{" "}
                    {p.caps.expiryDays}d key
                  </span>
                </button>
              ))}
            </div>

            <p className="field-lead">Pick a preset above, or fine-tune the limits:</p>
            <div className="grant-fields">
              <label className="field">
                <span className="field-label">most it can spend on one trade</span>
                <span className="field-input">
                  <input type="text" inputMode="decimal" value={capShown("perTradeUsdg")} onChange={set("perTradeUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">most it can spend in a day</span>
                <span className="field-input">
                  <input type="text" inputMode="decimal" value={capShown("dailyUsdg")} onChange={set("dailyUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">
                  auto-expire the agent after{" "}
                  <Info>A safety timer. After this many days the agent&apos;s key stops working on its own — so a forgotten agent can&apos;t trade forever.</Info>
                </span>
                <span className="field-input">
                  <input type="text" inputMode="numeric" value={capShown("expiryDays")} onChange={set("expiryDays")} />
                  <span className="field-unit">days</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">most trades per day</span>
                <span className="field-input">
                  <input type="text" inputMode="numeric" value={capShown("maxOpsPerDay")} onChange={set("maxOpsPerDay")} />
                  <span className="field-unit">trades</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">
                  stop if it&apos;s down by{" "}
                  <Info>A circuit breaker. If the account drops this far from its best value, the agent stops trading automatically to stem the bleeding.</Info>
                </span>
                <span className="field-input">
                  <input type="text" inputMode="numeric" value={capShown("maxDrawdownPct")} onChange={set("maxDrawdownPct")} />
                  <span className="field-unit">%</span>
                </span>
              </label>
            </div>
            {capError && (
              <p className="grant-cap-error" role="alert">
                {capError}
              </p>
            )}

            <div className="grant-summary">
              On {isMainnet ? "Robinhood Chain" : "the testnet"}, this agent can trade
              at most <b>{caps.perTradeUsdg} USDG</b> per trade, <b>{caps.dailyUsdg} USDG</b> per day,
              and <b>{caps.maxOpsPerDay}</b> trades per day. It stops itself if it&apos;s down{" "}
              <b>{caps.maxDrawdownPct}%</b>, and its key auto-expires in <b>{caps.expiryDays} days</b>.
              <br />
              <br />
              {/*
                This used to read "these limits are enforced by the blockchain — the agent
                literally cannot exceed them", which was true of three of the five. The signed
                key carries an expiry, a per-operation rate limit and a call policy; there is no
                on-chain accumulator for a daily USDG total, and the drawdown breaker is a
                separate contract this signature does not install. Both of those are counters in
                the worker — the process a compromise owns. Saying so costs a sentence and is the
                difference between a promise and a claim.
              */}
              The per-trade limit and expiry are enforced by your wallet. Daily spending, drawdown,
              and trade-count limits depend on the agent software.
              {/*
                The second copy of this sentence. Trades-per-day was corrected on the
                loaded-grant panel, in the README, in WallPanel and in Console — and missed
                here, in the create flow, which is the one place every single user reads it.
                It rested on ZeroDev's rate-limit policy, whose contract has no bytecode on
                Robinhood Chain.
              */}
            </div>

            {mode === "create" ? (
              <button className="grant-btn" onClick={onCreate} disabled={status !== null || createBlocked}>
                {status ??
                  (createBlocked
                    ? "acknowledge the real-funds warning above first"
                    : `Create my agent on ${isMainnet ? "Robinhood Chain" : "the testnet"}`)}
              </button>
            ) : (
              <>
                {/*
                  RESTORE RE-SIGNS THE LIMITS ON SCREEN, and the old ones are not
                  recoverable — they lived in the grant blob this browser lost, not
                  on the chain. So a disk-wipe recovery silently re-signs whatever
                  the form happens to hold.

                  The default is the scout preset, so the silent direction is now
                  NARROWER than most people's previous wall, which is the safe way
                  round. Saying so is still better than relying on that: someone
                  restoring a warlord wallet should know their caps just shrank,
                  and someone who had tighter limits should know to set them again.
                */}
                <p className="field-lead" style={{ marginTop: 12 }}>
                  This signs the limits shown above — <b>{caps.perTradeUsdg} USDG</b> a trade,{" "}
                  <b>{caps.dailyUsdg}</b> a day, key for <b>{caps.expiryDays} days</b>. Your old
                  limits lived in the key you lost, so nothing can read them back; set them here
                  if they mattered. Revocation spends ETH for network fees; it does not move your trading balances.
                </p>
                {preview && <div className="grant-note" data-restore-funding style={{ marginTop: 12 }}>
                  <b>ETH for revocation fees</b>
                  <p>Restore revokes earlier permissions on {restoreNetworks.length > 1 ? "both networks below, starting with the current network" : "the network below"} before signing a replacement. Fund this same account address on {restoreNetworks.length > 1 ? "each network" : "this network"}:</p>
                  <code style={{ display: "block", overflowWrap: "anywhere" }}>{preview.smartAccount}</code>
                  <CopyBtn value={preview.smartAccount} label="copy restore funding address" />
                  <ul>{restoreNetworks.map(network => <li key={network}>
                    <b>{network === MAINNET ? "Robinhood Chain" : "Robinhood Chain testnet"} ({network})</b>: send {network === TESTNET ? "testnet ETH" : "ETH"} for network fees.
                  </li>)}</ul>
                  {restoreNetworks.includes(TESTNET) && <p><a href={FAUCET_URL} target="_blank" rel="noreferrer">Get testnet ETH from the faucet ↗</a>, then send it to the account above on testnet.</p>}
                  <p>Balances do not move between networks. Revocation needs ETH even when trading gas is sponsored; an empty destination account also needs ETH. If you see AA21 or an insufficient-funds error, fund the named network and retry here.</p>
                </div>}
                <label className="ack-row"><input type="checkbox" checked={restoreRevocationAck} disabled={status !== null} onChange={e => setRestoreRevocationAck(e.target.checked)} /><span>I understand restore first stops the service and revokes earlier permissions on {restoreNetworks.map(network => network === MAINNET ? "Robinhood Chain (4663)" : "Robinhood Chain testnet (46630)").join(" and ")}. The account needs ETH for network fees on {restoreNetworks.length > 1 ? "both networks" : "this network"} before a new permission can be signed.</span></label>
                <button
                  className="grant-btn"
                  onClick={() => void onRestore()}
                  disabled={status !== null || createBlocked || !preview || !restoreRevocationAck}
                >
                  {status ??
                    (createBlocked
                      ? "acknowledge the real-funds warning above first"
                      : !preview
                        ? "check your owner key above first"
                        : `Restore & arm ${short(preview.smartAccount)}`)}
                </button>
              </>
            )}
            {error && <div className="grant-error mono">{error}{isWallTooWide(error) && <> <a href="/settings">Review custom tokens</a></>}</div>}
            </fieldset>
          </div>
        )}

        {/* ─── phase 2: back up the owner key (gated) ──────────────────── */}
        {grant && !backedUp && !desynced && !switching && (
          <div className="grant-panel">
            <h1 className="grant-title">back up your owner key</h1>
            <p className="grant-sub">
              This key controls the account and <b>every dollar you fund it with</b>. It lives only
              in this browser. Save it somewhere safe now — if you lose it, the funds are gone. We
              can&apos;t recover it for you.
            </p>

            <div className="key-box mono">
              <div className="key-row">
                <span className="rk">owner key</span>
                <span className="rv" style={{ wordBreak: "break-all" }}>
                  {/* The fallback used to read "(external wallet — no key
                      stored)", which was untrue in the only case that reached
                      it: the key WAS generated here and IS in this browser, the
                      screen just had the server-shaped grant that omits it. A
                      wrong explanation on a backup screen is worse than an
                      honest admission that something is off. */}
                  {/* ABSENCE MEANS TWO DIFFERENT THINGS, and the warning
                      below is only true of one of them. A Privy-owned account
                      HAS no key here by design; telling its owner we could not
                      read it — and to stop funding — describes a failure that
                      did not happen, on the screen where being wrong costs the
                      most. */}
                  {isPrivyOwned(grant)
                    ? "held by your Privy login — merrymen never sees it"
                    : reveal
                      ? (grant.demoOwnerPrivateKey ??
                        "couldn't read your owner key — don't fund this account, and tell us")
                      : "•".repeat(40)}
                </span>
              </div>
              <div className="key-actions">
                {/* Nothing to reveal when there is nothing held here. */}
                {!isPrivyOwned(grant) && (
                  <button className="copy-btn" onClick={() => setReveal((r) => !r)}>
                    {reveal ? "hide" : "reveal"}
                  </button>
                )}
                {grant.demoOwnerPrivateKey && (
                  <CopyBtn value={grant.demoOwnerPrivateKey} label="copy key" />
                )}
              </div>
            </div>

            <label className="ack-row">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I&apos;ve saved my owner key somewhere safe. I understand losing it means losing the funds.</span>
            </label>

            <button className="grant-btn" onClick={confirmBackup} disabled={!ack}>
              I&apos;ve backed it up — fund the account
            </button>

            <div className="grant-note">
              Account: <span className="mono">{short(grant.smartAccount)}</span>
            </div>
          </div>
        )}

        {/* ─── phase 3: fund the account ───────────────────────────────── */}
        {grant && backedUp && (!desynced || replacementRequired || session?.hosted) && !switching && (
          <div className="grant-panel">
            {/* Tokens added in settings after this key was signed. The wall can't
                widen without a signature — that's the point — so say it plainly
                and put the fix one click away. */}
            {/* `resignBy`, not the owner key. A Privy agent's basket can carry
                uncovered tokens exactly like anyone else's — and gating this on
                a key that never exists for them meant the cohort CreateAgent
                mints was never even TOLD its key did not cover its basket. */}
            {uncoveredNames.length > 0 && resignBy && (
              <div className="renew-note">
                <GI d="lock" size={14} /> <b>
                  {uncoveredNames.length === 1
                    ? "One token in your basket isn't"
                    : `${uncoveredNames.length} tokens in your basket aren't`}
                </b>{" "}
                covered by your agent&apos;s current key:{" "}
                <span className="mono">{uncoveredNames.join(", ")}</span>. The tradable list is
                sealed into the signature when you sign it, so neither adding a token nor a new pool
                appearing can widen it.
                <br />
                Your merryman <b>won&apos;t buy {uncoveredNames.length === 1 ? "it" : "them"}</b> until
                you re-sign — buying something it can&apos;t sell back would leave you holding a
                position with no way out, and no cap protects you from that.
                <br />
                Review and renew your permission below; network fees apply to revoking earlier keys.
                {watchedNotTraded.length > 0 && (
                  /* AND WHAT RE-SIGNING WILL NOT FIX. Coverage and selection are
                     two different gates; this panel only ever spoke about the
                     first, so an owner could do exactly what it said and still
                     have an agent that never touches the token. */
                  <>
                    <br />
                    <br />
                    One more thing, and a signature won&apos;t do it:{" "}
                    <b>{watchedNotTraded.join(", ")}</b>{" "}
                    {watchedNotTraded.length === 1 ? "is" : "are"} on your watch list but not in
                    your <b>trading basket</b>, so your agent will follow{" "}
                    {watchedNotTraded.length === 1 ? "it" : "them"} and never buy. Tick{" "}
                    {watchedNotTraded.length === 1 ? "it" : "them"} on in Settings → Trading basket.
                  </>
                )}
                {/*
                  SCROLLS, does not sign — the same correction the expiry prompt
                  below already got, and for the same reason. This button called
                  renewKey() directly with `disabled={renewing}` as its only
                  guard, which is the exact shape that became a hole once the
                  panel below gained a chain move: change the chain down there,
                  come back up here, press this, and you re-sign onto another
                  chain under a banner promising "same wallet, same caps".

                  One signing control, one set of conditions, and everything
                  else points at it. This is one of the things pointing at it.
                */}
                <button
                  className="grant-btn"
                  style={{ marginTop: 10, width: "100%" }}
                  onClick={() => document.getElementById("resign")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                >
                  {`re-sign to cover ${uncoveredNames.join(", ")} →`}
                </button>
              </div>
            )}
            {/* Key renewal first revokes the earlier generation on-chain. */}
            {(() => {
              const secsLeft = grant.expiresAt - Math.floor(Date.now() / 1000);
              // `resignBy`, not the owner key: a Privy agent's key expires on
              // exactly the same clock, and hiding the warning from the one
              // cohort that could not act on it was two problems, not one.
              if (secsLeft > 3 * 86_400 || !resignBy) return null;
              const expired = secsLeft <= 0;
              return (
                <div className={expired ? "renew-note expired" : "renew-note"}>
                  {expired ? (
                    <><GI d="clock" size={13} /> <b>Your agent&apos;s key has expired.</b> Trading is paused.</>
                  ) : (
                    <><GI d="clock" size={13} /> <b>Your agent&apos;s key expires in {Math.max(1, Math.ceil(secsLeft / 86_400))} day{secsLeft > 86_400 ? "s" : ""}.</b></>
                  )}{" "}
                  Review and renew your trading permissions below.
                  {/*
                    SCROLLS, does not sign. This button used to call renewKey()
                    directly with `disabled={renewing}` as its only guard — which
                    became a hole the moment the panel below gained a chain move:
                    tick "move to real money" down there, scroll up, press this,
                    and you re-signed onto mainnet with no acknowledgement and no
                    change diff, under a banner promising "the same caps".

                    Duplicating the guard would work until the next guard is added
                    to one copy and not the other. One signing control, one set of
                    conditions, and everything else points at it.
                  */}
                  <button
                    className="grant-btn"
                    style={{ marginTop: 10, width: "100%" }}
                    onClick={() => document.getElementById("resign")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  >
                    review and renew permission →
                  </button>
                </div>
              );
            })()}
            <h1 className="grant-title">fund your account</h1>
            <p className="grant-sub">
              {grantIsTestnet ? (
                <>
                  Send only <b>testnet ETH</b> to this address. Trades here use simulated funds.
                </>
              ) : (
                <>
                  {gasSponsored ? (
                    <>
                      Send <b>USDG (trading capital)</b> on Robinhood Chain (4663) to the account
                      address below — the network fee on every trade is covered, so USDG is all it
                      needs to start. <b>Real funds</b> — double-check the address and start with a
                      small test amount first.
                    </>
                  ) : (
                    <>
                      Send <b>ETH (for gas)</b> and <b>USDG (trading capital)</b> on Robinhood Chain
                      (4663) to the account address below. <b>Real funds</b> — double-check the
                      address and start with a small test amount first.
                    </>
                  )}
                </>
              )}
            </p>


            <div className="fund-addr mono">
              <span className="rk">account address · {chainLabel(grant.chainId)}</span>
              <span className="rv" style={{ wordBreak: "break-all" }}>{grant.smartAccount}</span>
              <CopyBtn value={grant.smartAccount} label="copy address" />
            </div>

            <div className="grant-note" style={{ marginTop: 12 }}>
              Deposit to the account address above. Use <Link href="/profile">Withdraw in Profile</Link> to move funds out.
            </div>

            <div className="fund-balances">
              <div className={`fund-bal ${gasFunded ? "ok" : ""}`}>
                <span className="fund-bal-k">native gas</span>
                <span className="fund-bal-v mono">
                  {funding ? (Number(funding.gasWei) / 1e18).toFixed(5) : "…"}
                </span>
                <span className="fund-bal-s">
                  {gasFunded
                    ? "funded ✓"
                    : grantIsTestnet
                      ? "testnet network fees"
                      : gasSponsored
                        // Not 'needed to deploy + trade': it is needed for neither.
                        // The one thing it IS still needed for is the way out.
                        ? "covered — only needed to withdraw later"
                        : "needed to deploy + trade"}
                </span>
              </div>
              {/* On testnet this tile reads the MAINNET USDG contract, so it is pinned at 0.00
                  forever no matter what lands. Show a dash + why, not a zero that looks like
                  the deposit vanished. */}
              <div className={`fund-bal ${!grantIsTestnet && usdgFunded ? "ok" : ""}`}>
                <span className="fund-bal-k">USDG</span>
                <span className="fund-bal-v mono">
                  {grantIsTestnet ? "—" : funding ? funding.usdg.toFixed(2) : "…"}
                </span>
                <span className="fund-bal-s">
                  {grantIsTestnet
                    ? "not tracked on the testnet — merrymen only knows the mainnet USDG address"
                    : usdgFunded
                      ? "funded ✓"
                      : "the agent's trading capital"}
                </span>
              </div>
            </div>

            <div className="fund-actions">
              {grantIsTestnet ? (
                <a className="grant-btn" href={FAUCET_URL} target="_blank" rel="noreferrer" style={{ textAlign: "center", textDecoration: "none" }}>
                  open the gas faucet ↗
                </a>
              ) : (
                <a
                  className="grant-btn"
                  href={`${explorerFor(grant.chainId)}/address/${grant.smartAccount}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textAlign: "center", textDecoration: "none" }}
                >
                  view on explorer ↗
                </a>
              )}
              <button className="copy-btn" onClick={() => grant && refreshFunding(grant.smartAccount, grant.chainId)}>
                refresh balances
              </button>
            </div>

            {canTrade ? (
              <div className="fund-ready mono">
                {grantIsTestnet ? (
                  <>
                    Testnet ETH received. {session?.hosted ? "Open your agent to follow paper trades." : <>Run <code>merrymen start</code> to begin paper trading.</>}
                  </>
                ) : usdgFunded ? (
                  <>
                    {/* Hosted has nothing to start: the orchestrator spawns a worker
                        per tenant on its own clock. Telling a hosted owner to run a
                        CLI they never installed is the first instruction the product
                        gives them, and it does not apply. */}
                    Funds received. {session?.hosted ? <>Open your agent.</> : <>Run <code>merrymen start</code> to begin.</>}
                  </>
                ) : (
                  <>
                    ETH received. Add <b>USDG</b> for live trading.
                  </>
                )}
                {/*
                  THE WAY OUT OF STEP THREE.

                  The rail across the top promises CHOOSE → BACK UP → FUND → RIDE,
                  and RIDE was not a place you could get to: funding is an external
                  action with no completion event, so the wizard just sat on step
                  three forever. The only exit was "back to the band" at the very
                  bottom of the page, below the fold, in a row it shares with
                  "switch to another wallet" and a red "discard & start over" — so
                  the nearest thing to a next step looked like one of two ways to
                  throw the wallet away.

                  Shown from the moment GAS lands rather than waiting for capital,
                  because the agent is already doing something at that point: with
                  no USDG it runs on paper, which is exactly what somebody
                  who has just funded gas wants to watch.
                */}
                <Link
                  href="/"
                  className="grant-btn"
                  style={{ marginTop: 12, width: "100%", textAlign: "center", textDecoration: "none", display: "block" }}
                >
                  watch it trade →
                </Link>
              </div>
            ) : (
              <div className="grant-note">
                waiting for the first deposit to land — usually under a minute, sometimes
                a few. this panel checks every few seconds on its own, so leave it open;
                you do not need to refresh.
                {!grantIsTestnet && " (no faucet on mainnet — send from your own wallet or exchange)"}
              </div>
            )}

            <div className="grant-result mono" style={{ marginTop: 18 }}>
              <div>
                <span className="rk">chain</span>
                <span className="rv">{chainLabel(grant.chainId)}</span>
              </div>
              <div>
                <span className="rk">owner</span>
                <span className="rv">{short(grant.owner)}</span>
              </div>
              <div>
                <span className="rk">session key</span>
                <span className="rv">{short(grant.sessionKeyAddress)}</span>
              </div>
              <div>
                <span className="rk">expires</span>
                <span className="rv">{fullDateTime(grant.expiresAt * 1000)}</span>
              </div>
            </div>

            {/*
              FOUR NUMBERS ON ONE LINE, EACH ABLE TO EXPLAIN ITSELF.

              A tester read "breaker 5%" and asked what it meant — reasonably,
              since the row is four pieces of jargon with no way in. Each now
              carries an "i" whose text comes from packages/core/src/explain.ts,
              the same entries the chat answers from, so the hover and the agent
              cannot drift apart into two different explanations of one number.

              The tooltips are not decoration. Two of these four caps are
              enforced by merrymen's own software rather than by the chain, and
              the entries say so — which is the single most important thing an
              owner can know about a row that otherwise reads as four equally
              hard guarantees.
            */}
            <div className="caps caps-row">
              <span className="cap">
                max <b>{grant.caps.perTradeUsdg} USDG</b>/trade
                <Info>{conceptTooltip("Per trade limit")}</Info>
              </span>
              <span className="cap">
                <b>{grant.caps.dailyUsdg} USDG</b>/day
                <Info>{conceptTooltip("Per day limit")}</Info>
              </span>
              <span className="cap">
                <b>{grant.caps.maxOpsPerDay}</b> ops/day
                <Info>{conceptTooltip("daily cap")}</Info>
              </span>
              <span className="cap">
                breaker <b>{grant.caps.maxDrawdownPct}%</b>
                <Info>{conceptTooltip("drawdown breaker")}</Info>
              </span>
            </div>

            {/*
              WHAT THIS SIGNATURE ACTUALLY CARRIES.
              Until now nothing anywhere showed an owner the capabilities sealed into their own
              key. That mattered once the wall changed: a key signed earlier carries permissions a
              key signed today does not, both are valid, and the only way to tell them apart was to
              read the JSON. Capability drift you cannot see is capability drift you cannot act on.
            */}
            <div className="grant-summary" style={{ marginTop: 14 }}>
              <b>Trading permissions</b>
              <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                <li>
                  <b>Stock list</b> —{" "}
                  {grant.grantFeatures?.includes(TRADEABLE_V2)
                    ? "the full tradeable set."
                    : "the legacy three (QQQ, NVDA, TSLA) only. Re-sign below to widen it."}
                </li>
                <li>
                  <b>Withdrawals</b> — use your recovery key in Profile. Renewing removes any older agent transfer permission.
                </li>
                <V4PermissionLine grant={grant} configuredAdapter={v4Adapter} />
                {/*
                  TWO VENUES THIS LIST NEVER MENTIONED. The block above says
                  "capability drift you cannot see is capability drift you
                  cannot act on", and then showed three lines out of five —
                  docs/owner-runbook-pons.md even instructs the owner to check
                  here for the Pons adapter, which was never rendered.

                  The class line matters most: it is the only permission in the
                  wall that lets an agent buy something nobody named, and it
                  puts assets in a contract rather than the account. An owner
                  should not have to read grant.json to find that out.
                */}
                <li>
                  <b>Bonding curves</b> —{" "}
                  {grantPonsAdapter(grant) ? (
                    <>sealed to {short(grantPonsAdapter(grant)!)}.</>
                  ) : (
                    "not granted."
                  )}
                </li>
                <li>
                  <b>Class route</b> —{" "}
                  {grantPonsClassVault(grant) ? (
                    <span style={{ color: "var(--amber, var(--red))" }}>
                      this key may buy tokens you never named, held in your vault at{" "}
                      {short(grantPonsClassVault(grant)!)}. <b>Renew below</b> to remove it.
                    </span>
                  ) : (
                    "not granted."
                  )}
                </li>
              </ul>
            </div>
            {/*
              RE-SIGN ON PURPOSE, not only when the key is nearly dead.

              The only renewal button lived inside the expiry notice, which
              returns null unless the key has under three days left. So an owner
              who wanted to re-sign a HEALTHY key — the exact thing the panel
              above tells them to do, twice, with the words "renew below" — had
              no button to press. The routes that did work were: wait for it to
              nearly expire, add a token it does not cover, or go through a flow
              labelled "switch to another wallet" and paste the owner key back in.

              That gap has a cost beyond awkwardness. The wall changes: a policy
              contract turned out to be undeployed on this chain, and every key
              signed before that fix carries a pointer into empty space. Fixing
              the wall does nothing for a key already signed — re-signing is the
              only remedy, and it was the one thing the page would not let you do.

              Caps are editable here on purpose. They are sealed into the
              signature, so this is the only moment they can change, and offering
              a re-sign that silently keeps the old numbers would send owners
              back through the side door for the other half of the job.
            */}
            <div id="resign" tabIndex={-1} aria-label="Trading permission renewal" className="grant-summary" style={{ marginTop: 14 }}>
              {renewed && !renewing && !error ? (
                <section id="renewal-complete" data-testid="renewal-complete" tabIndex={-1} aria-labelledby="renewal-complete-title" className="grant-renewal-complete">
                  <div role="status">
                    <h2 id="renewal-complete-title">Permission renewed</h2>
                    <p>Earlier permissions were revoked on-chain. The server saved your new permission for <b>{chainLabel(grant.chainId)}</b>.</p>
                    <p>You&apos;re done signing. Open your agent to see whether it has accepted this permission and any remaining setup steps.</p>
                  </div>
                  <Link href="/chat" className="grant-btn" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>View agent status</Link>
                  <button className="copy-btn" style={{ marginTop: 12 }} onClick={() => {
                    setChainId(grant.chainId); setCaps(grant.caps); setCapText({}); setCapError("");
                    setMainnetAck(false); setRenewalAck(false); renewalFocus.current = "form"; setRenewed(false);
                  }}>Edit permissions again</button>
                </section>
              ) : <>
              <b>Renew your permission.</b> First, stop the service and revoke earlier permissions on-chain; then sign a replacement with the limits below. Your account address stays the same.
              <p>Revocation uses ETH for network fees. When moving networks, it runs on both the current and selected networks. Trading stays stopped if revocation or the replacement fails; your recovery access is kept.</p>
              <p>The replacement uses today&apos;s permission rules. Review the network, assets, and limits before continuing. The owner key bypasses these limits and must stay private.</p>
              {resignBy ? (
                <>
                  <fieldset className="grant-renewal-fields" disabled={renewing || securityBusy}>
                  <div className="grant-fields" style={{ marginTop: 12 }}>
                    <label className="field">
                      <span className="field-label">Autonomous Trencher permission</span>
                      <span>
                        <input type="checkbox" checked={autonomousTrencher} disabled={!TRENCHER_FACTORY}
                          onChange={e=>setAutonomousTrencher(e.target.checked)} />
                        Allow my agent to discover and trade new pool tokens without adding each contract.
                      </span>
                      <small>
                        Tokens stay in your trading vault and sale proceeds return to your account. The vault limits buys to $5 each and $25 per 24-hour window; your lower signed limits still apply. A discovered token can lose all its value or become unsellable. This permission does not turn live trading on.
                        {!TRENCHER_FACTORY && " The new vault deployment is not configured yet; this permission is unavailable."}
                      </small>
                    </label>
                    <label className="field">
                      <span className="field-label">most it can spend on one trade</span>
                      <span className="field-input">
                        <input type="text" inputMode="decimal" value={capShown("perTradeUsdg")} onChange={set("perTradeUsdg")} />
                        <span className="field-unit">USDG</span>
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">most it can spend in a day</span>
                      <span className="field-input">
                        <input type="text" inputMode="decimal" value={capShown("dailyUsdg")} onChange={set("dailyUsdg")} />
                        <span className="field-unit">USDG</span>
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">most trades per day</span>
                      <span className="field-input">
                        <input type="text" inputMode="numeric" value={capShown("maxOpsPerDay")} onChange={set("maxOpsPerDay")} />
                        <span className="field-unit">trades</span>
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">auto-expire the agent after</span>
                      <span className="field-input">
                        <input type="text" inputMode="numeric" value={capShown("expiryDays")} onChange={set("expiryDays")} />
                        <span className="field-unit">days</span>
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">drawdown limit</span>
                      <span className="field-input">
                        <input type="text" inputMode="numeric" value={capShown("maxDrawdownPct")}
                          onChange={set("maxDrawdownPct")} disabled={renewing}
                          aria-invalid={!parseAmount(capShown("maxDrawdownPct"), CAP_FIELDS.maxDrawdownPct).ok} />
                        <span className="field-unit">%</span>
                      </span>
                      <small>
                        New buys pause when drawdown is at or above this percentage below the account&apos;s recorded peak. Selling remains allowed by this limit.
                        Raising it allows a larger loss before buys pause; it does not recover losses or reset the peak. Choose a whole percentage from 1 to 50.
                      </small>
                    </label>
                  </div>
                  {capsInputInvalid && <p className="grant-cap-error" role="alert">{capError || "Enter valid limits before signing."}</p>}
                  {/*
                    MOVING A KEY BETWEEN CHAINS, as a first-class action.

                    Testnet cannot trade anything. Every token and router address
                    merrymen knows is a mainnet-4663 deployment (preflight.ts's
                    chain guard says so in as many words), so a grant on 46630 is
                    a rehearsal that can never become a performance. The only way
                    off it was a control labelled "switch to another wallet",
                    which is where the chain picker happens to live — a new user
                    on a faucet asked "how to do leave testnet?" and could not
                    find it, because nothing on the page is called that.

                    Deliberately NOT a silent default. The mount effect pins the
                    selector to the loaded grant precisely so a mainnet owner
                    cannot click renew and land on the sandbox; this keeps that
                    property by making the move an explicit, acknowledged choice
                    with its own button, rather than a selector that could drift.
                  */}
                  <div className="chain-move" style={{ marginTop: 12 }}>
                    <label className="ack-row">
                      <input
                        type="checkbox"
                        checked={chainId !== grant.chainId}
                        onChange={(e) => {
                          setChainId(e.target.checked ? (grant.chainId === MAINNET ? TESTNET : MAINNET) : grant.chainId);
                          setMainnetAck(false);
                        }}
                      />
                      <span>
                        {grant.chainId === MAINNET ? (
                          <>
                            Move this key to <b>the testnet ({TESTNET})</b> — it will stop being
                            able to trade
                            {session?.hosted
                              ? ", and on this service it cannot be used for anything: your agent trades Robinhood Chain. Turn Paper on in Settings instead."
                              : "."}
                          </>
                        ) : (
                          <>Move this key to <b>Robinhood Chain ({MAINNET})</b> — the network your agent trades on.</>
                        )}
                      </span>
                    </label>
                  </div>
                  {chainId === MAINNET && grant.chainId !== MAINNET && (
                    <div className="mainnet-warning" style={{ marginTop: 10 }}>
                      <b>This uses real funds.</b> Anyone with access to the keys saved in this browser can control your funds. Keep your recovery key private.
                      <br />
                      <br />
                      Your account address does not change, so anything already sitting at{" "}
                      <span className="mono">{short(grant.smartAccount)}</span> on mainnet stays
                      there. Testnet balances do not transfer to mainnet.
                      <label className="ack-row" style={{ marginTop: 10 }}>
                        <input
                          type="checkbox"
                          checked={mainnetAck}
                          onChange={(e) => setMainnetAck(e.target.checked)}
                        />
                        <span>
                          I understand — real funds, a recovery key stored in this browser can bypass every cap. I must keep it private.
                        </span>
                      </label>
                    </div>
                  )}
                  {/*
                    Say what is about to change BEFORE it changes, and only when
                    something has. A re-sign that quietly moves a cap the owner
                    edited and forgot is the same class of surprise as one that
                    quietly keeps it.
                  */}
                  {anyChange && (
                    <p className="field-lead" style={{ marginTop: 10 }}>
                      Signing now also changes: {allChanges.join(" · ")}.
                    </p>
                  )}
                  {/*
                    Blocked, not hidden, when a chain move needs its
                    acknowledgement. A button that vanishes leaves the reader
                    wondering what they did wrong; a disabled one sits directly
                    under the checkbox that enables it.
                  */}
                  <div className="grant-note" data-renewal-funding style={{ marginTop: 12 }}>
                    <b>ETH for revocation fees</b>
                    <p>Before continuing, fund this same account address on {chainId !== grant.chainId ? "each network below" : "this network"}:</p>
                    <code style={{ display: "block", overflowWrap: "anywhere" }}>{grant.smartAccount}</code>
                    <CopyBtn value={grant.smartAccount} label="copy revocation funding address" />
                    <ul>
                      {[grant.chainId, ...(chainId !== grant.chainId ? [chainId] : [])].map(network => <li key={network}>
                        <b>{network === MAINNET ? "Robinhood Chain" : "Robinhood Chain testnet"} ({network})</b>: send {network === TESTNET ? "testnet ETH" : "ETH"} for network fees.
                      </li>)}
                    </ul>
                    {(grant.chainId === TESTNET || chainId === TESTNET) && <p><a href={FAUCET_URL} target="_blank" rel="noreferrer">Get testnet ETH from the faucet ↗</a>, then send it to the account above on testnet.</p>}
                    <p>Balances do not move between networks. Revocation needs ETH even when trading gas is sponsored; an empty account on the destination network also needs ETH. If you see AA21 or an insufficient-funds error, fund the named network and retry here.</p>
                  </div>
                  <label className="ack-row" style={{ marginTop: 12 }}><input type="checkbox" checked={renewalAck} onChange={e => setRenewalAck(e.target.checked)} /><span>I authorize revoking earlier permissions on-chain before signing the replacement and understand network fees apply.</span></label>
                  <button
                    className="grant-btn"
                    style={{ marginTop: 10, width: "100%" }}
                    onClick={() => void renewKey()}
                    disabled={renewing || securityBusy || !renewalAck || capsInputInvalid || (chainId === MAINNET && grant.chainId !== MAINNET && !mainnetAck)}
                  >
                    {renewing
                      ? "re-signing…"
                      : chainId !== grant.chainId
                        ? chainId === MAINNET
                          ? "move to Robinhood Chain & re-sign"
                          : "move to the testnet & re-sign"
                        : "revoke earlier permissions & re-sign"}
                  </button>
                  </fieldset>
                  {renewing && <p className="field-lead" role="status">{status ?? "re-signing…"}</p>}
                  {/* A preflight refusal leaves the prior permission unchanged,
                      including any earlier pending revocation/recovery state. */}
                  {error && (
                    <div className="grant-error mono" role="alert">
                      {error}
                      {isWallTooWide(error) && (
                        <p>
                          Lower spending limits do not shrink the permission list. {" "}
                          <a href="/settings">Review custom tokens</a> and follow the changes described above.
                          If it is too large even without custom tokens, the selected trading routes
                          need a narrower permission; contact support before changing those routes.
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="field-lead" style={{ marginTop: 12 }}>
                  {/* TWO DIFFERENT MISSING OWNERS, and the remedies have nothing in
                      common. A legacy agent's key SHOULD be in this browser, so its
                      absence is a problem and pasting it back is the fix. A Privy
                      agent has no key to paste — by design — and the fix is to sign
                      in as the account that owns it. Telling a Privy owner to paste
                      a key is advice that cannot be followed, which is what this
                      panel used to say to the entire Privy cohort. */}
                  {isPrivyOwned(grant) ? (
                    <>
                      Re-signing {short(grant.smartAccount)} needs the login that owns it. This
                      agent is owned by a Privy embedded wallet — there is no key to paste, which
                      is the point of it — so sign in as that account and this control comes back.
                    </>
                  ) : (
                    <>
                      This browser does not hold the owner key for {short(grant.smartAccount)}, and
                      re-signing needs it. Use <b>switch to another wallet</b> below and paste the
                      key in, or run <code>merrymen recover</code> to sweep the funds somewhere you
                      control.
                    </>
                  )}
                </p>
              )}
              </>}
            </div>

            {!renewed && <div className="grant-actions">
              <Link href="/chat" className="grant-btn" style={{ textAlign: "center", textDecoration: "none" }}>View agent status</Link>
            </div>}
            <details className="grant-wallet-options">
              <summary>More wallet options</summary>
              <p>Switch wallets or stop using this permission. Neither option is needed to finish renewing. Discarding stops this service but does not revoke copied session keys on-chain.</p>
              <div className="grant-actions">
              <button
                className="copy-btn"
                style={{ padding: "10px 16px" }}
                disabled={renewing || securityBusy}
                onClick={() => {
                  setRenewed(false);
                  setSwitching(true);
                  setMode("restore");
                  setError(null);
                }}
              >
                switch to another wallet
              </button>
              <button className="btn-kill" style={{ padding: "10px 16px" }} onClick={() => void discard()} disabled={discarding || renewing || securityBusy}>
                {discarding ? "discarding…" : "discard & start over"}
              </button>
              </div>
            </details>
          </div>
        )}
        </div>
      </div>
    </AppShell>
  );
}
