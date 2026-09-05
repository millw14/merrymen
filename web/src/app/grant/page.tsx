"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, formatEther, http } from "viem";
import { Info } from "@/components/Info";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  explorerFor,
  grantHasNativeSwap,
  grantHasV4,
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
  loadGrant,
  previewOwnerAccount,
  readFunding,
  refusalMessage,
  restoreAgentWallet,
  type Funding,
  type Grant,
  type GrantCaps,
  type OwnerPreview,
  type SavedWallet,
} from "@/lib/session";
import { canStart } from "@/lib/can-start";
// QUARANTINED, not fixed. This page moves real money, holds owner private keys
// and is 1,750 lines of signature and recovery logic — the last place to
// restyle during a redesign. It keeps the sheets it was written against, and
// they no longer reach anything else.
import "@/styles/tokens.css";
import "@/styles/shell.css";
import "@/styles/legacy.css";
import "@/styles/legacy-console.css";
import "./grant.css";

const DEFAULTS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
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

/**
 * VERIFY AN ADAPTER ADDRESS BEFORE IT IS SEALED, not after.
 *
 * WHY THIS IS NOT PARANOIA. Sealing an adapter does two things, and the second
 * is easy to miss: `allowedSpenders()` appends the address to the spender ONE_OF
 * of EVERY approve permission in the grant (packages/core/src/wall.ts), and the
 * non-USDG approves pass `null` as the amount condition — which wall.ts itself
 * calls "a standing licence to move every share the agent holds". So one wrong
 * or stale value typed into one dashboard field becomes an unbounded pull target
 * across the whole token book, sealed into a signature, unseen.
 *
 * The worker already checks this — and too late. Its `eth_getCode` gate runs at
 * ARM time, which is after the owner has signed, after the grant is stored, and
 * after the only cheap moment to say no has passed. The cost of catching it
 * there is a wasted re-sign; the cost of not catching it at all is the paragraph
 * above.
 *
 * TWO CHECKS, because they fail differently:
 *   1. code exists at the address on THIS chain — catches a typo, an address
 *      from the other chain, an EOA pasted by mistake, and a contract that was
 *      never actually deployed;
 *   2. the code answers the shape we expect — `tradeExactIn` is present. Catches
 *      a real, live, wrong contract, which check 1 waves straight through. The
 *      deploy script performs the same ABI check for the same reason.
 *
 * REFUSES RATHER THAN SEALING SOMETHING UNVERIFIED. Returning `undefined` on
 * failure would mint a grant with no curve route, quietly — the owner would
 * think they had sealed it and find out at the first trade. Throwing puts the
 * failure where the owner is already looking.
 */
async function verifiedAdapter(
  address: `0x${string}` | undefined,
  chainId: number,
  onStatus: (s: string) => void,
): Promise<`0x${string}` | undefined> {
  if (!address) return undefined;
  onStatus("checking the curve adapter before sealing it…");
  const chain = chainId === robinhoodTestnet.id ? robinhoodTestnet : robinhoodChain;
  const client = createPublicClient({ chain, transport: http() });

  let code: string;
  try {
    code = (await client.getCode({ address })) ?? "0x";
  } catch (e) {
    throw new Error(
      `Could not check the curve adapter ${address} on ${chain.name}: ${
        e instanceof Error ? e.message : String(e)
      }. Refusing to seal an address nobody has verified — it would become an approved spender for every token in this grant.`,
    );
  }
  if (!code || code === "0x") {
    throw new Error(
      `No contract at ${address} on ${chain.name}. That is usually an address from the other chain, ` +
        `a typo, or a deploy that never happened. Sealing it would make it an approved spender for every ` +
        `token in this grant, so nothing is signed. Fix it at /settings and try again.`,
    );
  }

  // SHAPE CHECK. A live contract at the right address on the right chain can
  // still be the wrong contract entirely, and check 1 cannot tell.
  try {
    await client.readContract({
      address,
      abi: PONS_SELFTRADE_ABI,
      functionName: "tradeExactIn",
      args: [
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        0n,
        0n,
        0n,
      ],
    });
  } catch (e) {
    // A REVERT IS A PASS. The call is deliberately invalid — zero addresses, zero
    // amount, a deadline in 1970 — so the real adapter MUST reject it. What we
    // are testing is that it rejected it as that function rather than failing to
    // find one. viem reports a missing function differently from a revert, and
    // only the former disqualifies the address.
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|not found|returned no data|function.*selector/i.test(msg)) {
      throw new Error(
        `The contract at ${address} on ${chain.name} is not a PonsSelfTrade adapter — it has no ` +
          `tradeExactIn function. Sealing it would make the wrong contract an approved spender for every ` +
          `token in this grant, so nothing is signed.`,
      );
    }
  }

  onStatus("curve adapter verified.");
  return address;
}

const MAINNET = robinhoodChain.id; // 4663 — real funds

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

    Raising a cap is a free, instant re-sign from the panel further down, so
    the cost of starting small is one click later. The cost of starting large
    is not symmetric.
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
    in practice mode, so "watch it work before risking anything" survives the
    flip instead of being deleted by it. Do not restore this default without
    also reverting that.

    Practice stays on the menu, one click away, and the real-money
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
  /** {hosted,address} from /api/auth/session. null until it resolves. */
  const [session, setSession] = useState<{ hosted: boolean; address: `0x${string}` | null } | null>(null);
  /** Every agent account this browser holds a key for — current and superseded. */
  const [savedWallets, setSavedWallets] = useState<SavedWallet[]>([]);
  const [reArming, setReArming] = useState(false);
  // ── restore: bring an already-funded wallet back with its owner key ──────
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [restoreKey, setRestoreKey] = useState("");
  const [preview, setPreview] = useState<OwnerPreview | null>(null);
  const [previewFunding, setPreviewFunding] = useState<Funding | null>(null);
  const [previewing, setPreviewing] = useState(false);
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
  const [autoConvert, setAutoConvert] = useState<boolean>(false);
  // The basket matters here for the same reason: /settings offers every registry
  // symbol, but only the ones sealed into the signature can be sold.
  const [basketSymbols, setBasketSymbols] = useState<string[]>([]);

  useEffect(() => {
    const stored = loadGrant();
    setGrant(stored);
    setSavedWallets(listSavedWallets());
    // The chain selector FOLLOWS the loaded grant. renewKey now signs on the
    // SELECTED chain (so the page cannot lie), which makes this sync load-
    // bearing: without it the selector defaults to testnet, and a mainnet
    // owner clicking "renew (free)" would silently re-sign their real-money
    // wallet onto the sandbox — the same silent-chain bug, mirrored. The caps
    // follow for the same reason: the form should open showing what the
    // current key actually carries.
    if (stored) {
      setChainId(stored.chainId);
      setCaps(stored.caps);
    }
    setBackedUp(localStorage.getItem(BACKUP_KEY) === "1");
    fetch("/api/grants")
      .then((r) => (r.ok ? r.json() : { exists: false }))
      .then((s: { exists?: boolean; gasSponsored?: boolean | null }) => {
        setServerArmed(!!s.exists);
        setGasSponsored(s.gasSponsored === true);
      })
      .catch(() => setServerArmed(null));
    // THE ONLY TRUSTWORTHY hosted signal on the client. isHostedMode() reads
    // process.env, which Next does not inline into the browser bundle, so it is
    // false in every browser regardless of how the server is configured. Left
    // null until this resolves, and creating is blocked meanwhile — signing with
    // the wrong assumption mints a grant the server will refuse.
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { hosted?: boolean; address?: string | null } | null) =>
        setSession(s ? { hosted: !!s.hosted, address: (s.address ?? null) as `0x${string}` | null } : null),
      )
      .catch(() => setSession(null));
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { values?: { customTokens?: unknown[]; basketSymbols?: string[]; v4AdapterAddress?: string; ponsAdapterAddress?: string; autoConvertEnabled?: boolean }; defaults?: { basketSymbols?: string[] } } | null) => {
        const list = (v?.values?.customTokens ?? []).filter(isValidCustomToken);
        setCustomTokens(list as CustomToken[]);
        setBasketSymbols(v?.values?.basketSymbols ?? v?.defaults?.basketSymbols ?? []);
        const a = v?.values?.v4AdapterAddress;
        setV4Adapter(typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined);
        const pa = v?.values?.ponsAdapterAddress;
        setPonsAdapter(typeof pa === "string" && /^0x[0-9a-fA-F]{40}$/.test(pa) ? (pa as `0x${string}`) : undefined);
        setAutoConvert(!!v?.values?.autoConvertEnabled);
      })
      .catch(() => {
        setCustomTokens([]);
        setBasketSymbols([]);
      });
  }, []);

  /** Re-push the stored grant so the worker obeys it again (undo a desync). */
  async function reArm() {
    const stored = loadGrant();
    if (!stored) return;
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

  const set = (k: keyof GrantCaps) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCaps((c) => ({ ...c, [k]: Number(e.target.value) }));

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

  const isMainnet = chainId === MAINNET;
  // Mainnet is real money — the create button stays locked until the user
  // explicitly owns that (keys are plaintext-local; caps are the seatbelt).
  const createBlocked = isMainnet && !mainnetAck;

  async function onCreate() {
    setError(null);
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
      const { local: g, handoff } = await createAgentWallet({
        caps,
        onStatus: setStatus,
        chainId,
        extraTokens: customTokens,
        v4AdapterAddress: v4Adapter,
        ponsAdapterAddress: await verifiedAdapter(ponsAdapter, chainId, setStatus),
        hostedAs: session.hosted ? (session.address ?? undefined) : undefined,
      });
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
    setError(null);
    setPreview(null);
    setPreviewFunding(null);
    const key = restoreKey.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      setError("that isn't an owner key — expected 0x followed by 64 hex characters.");
      return;
    }
    setPreviewing(true);
    try {
      const p = await previewOwnerAccount(key as `0x${string}`, chainId);
      setPreview(p);
      setPreviewFunding(await readFunding(p.smartAccount, chainId).catch(() => null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setPreviewing(false);
  }

  /** Re-arm the funded account with a fresh session key under the caps above. */
  async function onRestore() {
    setError(null);
    setStatus("starting…");
    try {
      const { local: g, handoff } = await restoreAgentWallet(restoreKey.trim() as `0x${string}`, {
        caps,
        onStatus: setStatus,
        chainId,
        extraTokens: customTokens,
        v4AdapterAddress: v4Adapter,
        ponsAdapterAddress: await verifiedAdapter(ponsAdapter, chainId, setStatus),
        hostedAs: session?.hosted ? (session.address ?? undefined) : undefined,
      });
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

  /**
   * One-click key renewal: re-sign the SAME wallet (same owner key, same caps,
   * same address, same funds) with a fresh session key and a fresh expiry.
   * A grant is a local signature — nothing goes on-chain, no gas is spent, and
   * it works in paper and live mode alike. This exists so expiry never forces
   * anyone through discard/restore.
   *
   * It is ALSO how a newly-added token becomes tradable: the tradable set is
   * sealed into the signed key, so the current `customTokens` are baked in here.
   */
  const [renewing, setRenewing] = useState(false);
  async function renewKey() {
    if (!grant?.demoOwnerPrivateKey) return;
    setError(null);
    setRenewing(true);
    try {
      // FETCH SETTINGS AT CLICK TIME, not from mount state. This is the exact
      // button an owner presses right after saving a new token or the adapter
      // address in /settings — and the mount-time fetch predates that save, so
      // re-signing from stale state silently sealed a wall WITHOUT the thing
      // they just added, with nothing failing until the first no-exit reject.
      let freshTokens = customTokens;
      let freshAdapter = v4Adapter;
      let freshPons = ponsAdapter;
      try {
        const r = await fetch("/api/settings");
        if (r.ok) {
          const v = (await r.json()) as {
            values?: { customTokens?: unknown[]; v4AdapterAddress?: string; ponsAdapterAddress?: string };
          };
          freshTokens = (v?.values?.customTokens ?? []).filter(isValidCustomToken) as CustomToken[];
          const a = v?.values?.v4AdapterAddress;
          freshAdapter = typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined;
          const pa = v?.values?.ponsAdapterAddress;
          freshPons = typeof pa === "string" && /^0x[0-9a-fA-F]{40}$/.test(pa) ? (pa as `0x${string}`) : undefined;
          setCustomTokens(freshTokens);
          setV4Adapter(freshAdapter);
          setPonsAdapter(freshPons);
        }
      } catch {
        /* unreachable settings: sign with what the page already had, as before */
      }
      // The SELECTED chain and the CURRENT caps — not the old grant's. The old
      // behaviour reused grant.chainId and grant.caps, so renewing while the
      // selector showed mainnet silently re-signed on testnet, and any cap the
      // owner had just edited in the form was ignored. What the page shows is
      // what gets signed, or the page is lying.
      const { local: g, handoff } = await restoreAgentWallet(grant.demoOwnerPrivateKey, {
        caps,
        onStatus: setStatus,
        chainId,
        extraTokens: freshTokens,
        v4AdapterAddress: freshAdapter,
        ponsAdapterAddress: await verifiedAdapter(freshPons, chainId, setStatus),
        hostedAs: session?.hosted ? (session.address ?? undefined) : undefined,
      });
      setGrant(g);
      // Same correction as create/restore: report what the server said, so a
      // renewed key that the server refused doesn't read as a renewed agent.
      setServerArmed(handoff.ok);
      if (!handoff.ok) setError(handoff.error ?? "the server refused the renewed grant");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setRenewing(false);
  }

  function confirmBackup() {
    localStorage.setItem(BACKUP_KEY, "1");
    setBackedUp(true);
  }

  function discard() {
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
    clearGrant();
    // Also destroy the worker-side handoff — otherwise the "discarded" grant
    // stays armed and the worker keeps trading on it (kill-switch semantics).
    void fetch("/api/grants", { method: "DELETE" }).catch(() => {});
    localStorage.removeItem(BACKUP_KEY);
    setGrant(null);
    setBackedUp(false);
    setReveal(false);
    setAck(false);
    setMainnetAck(false);
    setFunding(null);
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
      ? [`chain ${grant.chainId === MAINNET ? "mainnet" : "practice"} → ${chainId === MAINNET ? "mainnet" : "practice"}`, ...capChanges]
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
  const RAIL = ["Choose", "Back up", "Fund", "Ride"] as const;
  const KICKS = ["Step one · set the wall", "Step two · back up the key", "Step three · fund the account"];

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
        title="Grant"
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
        {/* ─── desync banner: browser has a wallet the server no longer holds ── */}
        {desynced && (
          <div className="grant-panel desync-panel">
            <h1 className="grant-title">this wallet isn&apos;t active</h1>
            <p className="grant-sub">
              Your browser still has this wallet, but the worker no longer holds its grant — so the
              dashboard shows no merryman and it won&apos;t trade. This happens after a{" "}
              <b>kill switch</b> or a <code>merrymen kill</code> — or because the server refused the
              grant, in which case the reason is below. Re-arm it to make the band obey it again, or
              discard it and start fresh.
            </p>
            {/* THE REASON, ON THE SCREEN THAT REPORTS THE PROBLEM. The shared
                error line lives inside the create panel (it is nested under
                `!grant || switching`), so once a grant exists it cannot render —
                which is every desync. A refusal here was therefore invisible no
                matter which path produced it, and pressing re-arm looked like a
                button that did nothing. */}
            {error && <div className="grant-error mono">{error}</div>}
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
              <button className="grant-btn" onClick={() => void reArm()} disabled={reArming} style={{ flex: 1 }}>
                {reArming ? "re-arming…" : "re-arm this wallet"}
              </button>
              <button className="btn-kill" onClick={discard} style={{ flex: 1 }}>
                discard &amp; start fresh
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
            <p className="grant-sub">
              Each agent wallet has its own address. These are ones this browser made earlier — if you
              funded a wallet and the balance above looks wrong, the money is at one of these, and the
              key to it is here.
            </p>
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
            {switching && grant && (
              <div className="switch-note">
                You&apos;re running <span className="mono">{short(grant.smartAccount)}</span> right
                now. Restoring another wallet makes <b>that</b> one the active agent instead — your
                current wallet is <b>archived on this machine with its owner key</b>, so nothing is
                lost and you can switch back or sweep it anytime.
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
                  setMode("create");
                  setError(null);
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
                  No wallet to connect. merrymen makes a fresh wallet and gives <b>you</b> the key.
                  You set the spending limits below — and the blockchain itself{" "}
                  <Info>
                    Not honor-system limits. The size of each trade, how many it may make, how long
                    the key lives and where value may land are sealed into the signature your
                    account contract checks, so a hacked agent cannot exceed them. The daily total
                    and the drawdown breaker are different — those are counted by the software on
                    your machine. The summary below the sliders spells out which is which.
                  </Info>{" "}
                  enforces the important ones — the summary below says exactly which.
                </>
              ) : (
                <>
                  Already funded a merrymen wallet? Paste its <b>owner key</b> and the very same
                  account comes back{" "}
                  <Info>Your smart-account address is derived from the owner key, so the same key always reproduces the same account — with the funds still in it. Restoring signs a fresh session key; it moves nothing on-chain.</Info>{" "}
                  — same address, same funds — armed with a fresh session key under the caps you set
                  below. This is the way back in after a kill switch or a new machine.
                </>
              )}
            </p>

            <div className="chain-choice">
              <button
                type="button"
                className={`chain-card ${!isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(TESTNET)}
              >
                <span className="chain-card-title"><GI d="tree" size={16} /> Practice (testnet)</span>
                <span className="chain-card-body">
                  Your band trades a simulated book at real live prices. Nothing routes on-chain and
                  USDG sent here won&apos;t show up — so don&apos;t fund it. Best place to watch it
                  work before risking anything.
                </span>
              </button>
              <button
                type="button"
                className={`chain-card danger ${isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(MAINNET)}
              >
                <span className="chain-card-title"><GI d="coin" size={16} /> Real money (mainnet)</span>
                <span className="chain-card-body">
                  The real Robinhood Chain — real funds, real trades. Only when you&apos;re ready.
                </span>
              </button>
            </div>

            {isMainnet && (
              <div className="mainnet-warning">
                <b>This is real money.</b> Your owner &amp; session keys are generated and stored in
                plain text on <b>this machine</b> (~/.merrymen and this browser) — anyone with
                access to it controls the funds. There is no recovery service and no undo. Your
                caps below are the seatbelt: start small, raise them as trust grows.
                <label className="ack-row" style={{ marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={mainnetAck}
                    onChange={(e) => setMainnetAck(e.target.checked)}
                  />
                  <span>
                    I understand — real funds, keys stored locally in plain text, and my caps are my
                    protection.
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
                  onChange={(e) => setRestoreKey(e.target.value)}
                  autoComplete="off"
                />
                <button className="copy-btn" onClick={() => void checkOwnerKey()} disabled={previewing}>
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
                  onClick={() => setCaps(p.caps)}
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
                  <input type="number" min={1} value={caps.perTradeUsdg} onChange={set("perTradeUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">most it can spend in a day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.dailyUsdg} onChange={set("dailyUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">
                  auto-expire the agent after{" "}
                  <Info>A safety timer. After this many days the agent&apos;s key stops working on its own — so a forgotten agent can&apos;t trade forever.</Info>
                </span>
                <span className="field-input">
                  <input type="number" min={1} max={90} value={caps.expiryDays} onChange={set("expiryDays")} />
                  <span className="field-unit">days</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">most trades per day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.maxOpsPerDay} onChange={set("maxOpsPerDay")} />
                  <span className="field-unit">trades</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">
                  stop if it&apos;s down by{" "}
                  <Info>A circuit breaker. If the account drops this far from its best value, the agent stops trading automatically to stem the bleeding.</Info>
                </span>
                <span className="field-input">
                  <input type="number" min={1} max={50} value={caps.maxDrawdownPct} onChange={set("maxDrawdownPct")} />
                  <span className="field-unit">%</span>
                </span>
              </label>
            </div>

            <div className="grant-summary">
              <b>In plain English:</b> on {isMainnet ? "real money" : "practice"}, this agent can trade
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
              <b>What the chain itself enforces:</b> the per-trade cap, the expiry, and the fact
              that value can only land back in your own account. Those the agent cannot exceed no
              matter what happens to the software. The <b>daily total</b>, the{" "}
              <b>drawdown breaker</b> and the <b>trades-per-day</b> count are counters kept by
              merrymen, so a tampered-with agent could ignore all three — which is why the lever
              that bounds a loss is the <b>per-trade cap</b> and a <b>short expiry</b>, not the
              daily figure.
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
                    : `Create my agent (${isMainnet ? "real money" : "practice"})`)}
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
                  if they mattered. Your funds are untouched either way.
                </p>
                <button
                  className="grant-btn"
                  onClick={() => void onRestore()}
                  disabled={status !== null || createBlocked || !preview}
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
            {error && <div className="grant-error mono">{error}</div>}

            <div className="grant-note">
              {mode === "create"
                ? "The keys are made right here in your browser so you can save them yourself — nobody else ever sees them."
                : "Your owner key never leaves this browser — it's used to re-derive your account and sign the new session key locally. Restoring moves no funds and costs no gas."}
            </div>
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
                  {reveal
                    ? (grant.demoOwnerPrivateKey ??
                      "couldn't read your owner key — don't fund this account, and tell us")
                    : "•".repeat(40)}
                </span>
              </div>
              <div className="key-actions">
                <button className="copy-btn" onClick={() => setReveal((r) => !r)}>
                  {reveal ? "hide" : "reveal"}
                </button>
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
              your account: <span className="mono">{short(grant.smartAccount)}</span> · session key
              (worker-only, capped): <span className="mono">{short(grant.sessionKeyAddress)}</span>
              <br />
              This key controls the account, but its <i>own</i> address (
              <span className="mono">{short(grant.owner)}</span>) is different — that&apos;s the
              address MetaMask shows if you import the key. You fund and recover the{" "}
              <b>account</b> address, not the key&apos;s address.
            </div>
          </div>
        )}

        {/* ─── phase 3: fund the account ───────────────────────────────── */}
        {grant && backedUp && !desynced && !switching && (
          <div className="grant-panel">
            {/* Tokens added in settings after this key was signed. The wall can't
                widen without a signature — that's the point — so say it plainly
                and put the fix one click away. */}
            {uncoveredNames.length > 0 && grant.demoOwnerPrivateKey && (
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
                Re-signing fixes it: same wallet, same funds, same caps, free and instant.
                <button
                  className="grant-btn"
                  style={{ marginTop: 10, width: "100%" }}
                  onClick={() => void renewKey()}
                  disabled={renewing}
                >
                  {renewing ? "re-signing…" : `re-sign to cover ${uncoveredNames.join(", ")}`}
                </button>
              </div>
            )}
            {/* Key expiry — renewal is one click, free (a local signature; no
                gas, nothing moves, same wallet). Applies in paper AND live mode. */}
            {(() => {
              const secsLeft = grant.expiresAt - Math.floor(Date.now() / 1000);
              if (secsLeft > 3 * 86_400 || !grant.demoOwnerPrivateKey) return null;
              const expired = secsLeft <= 0;
              return (
                <div className={expired ? "renew-note expired" : "renew-note"}>
                  {expired ? (
                    <><GI d="clock" size={13} /> <b>Your agent&apos;s key has expired</b> — it stopped trading (the safety timer did its job). Your funds are untouched.</>
                  ) : (
                    <><GI d="clock" size={13} /> <b>Your agent&apos;s key expires in {Math.max(1, Math.ceil(secsLeft / 86_400))} day{secsLeft > 86_400 ? "s" : ""}.</b></>
                  )}{" "}
                  Re-signing is free and instant — same wallet, same funds, nothing sent
                  on-chain. The new key is signed against <b>today&apos;s wall</b>, so its
                  permissions can differ from the old one&apos;s.
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
                    re-sign the key (free) →
                  </button>
                </div>
              );
            })()}
            <h1 className="grant-title">fund your account</h1>
            <p className="grant-sub">
              {grantIsTestnet ? (
                <>
                  Send <b>testnet gas (ETH)</b> to the account address below — that&apos;s the only
                  thing worth sending here. <b>Don&apos;t send USDG:</b> merrymen only knows the
                  mainnet token addresses, so testnet USDG reads 0 and is never traded. Practice
                  trades a simulated book instead.
                </>
              ) : autoConvert ? (
                <>
                  Send <b>ETH</b> to the account address below — we&apos;ll swap surplus to <b>USDG</b> and keep a gas reserve. <b>Real funds</b> — double-check the address and start with a small test amount first.{" "}
                  <span style={{ opacity: 0.7 }}>Or send USDG directly — both work on the same address.</span>
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

            <div className="paper-note mono" style={{ marginBottom: 14 }}>
              <GI d="scroll" size={14} /> <b>Already riding.</b> Your band is trading in <b>paper mode</b> right now — real
              live prices, simulated fills — so you can watch it work before funding anything. Head
              to the <Link href="/">dashboard</Link> to see it.{" "}
              {grantIsTestnet
                ? "On practice there's nothing to fund for live trading — testnet has no trading venues, and testnet USDG won't even show up below. Faucet gas is still worth grabbing if you want to watch a real UserOp land. Going live means a mainnet wallet plus a bundler key in settings."
                : "Fund the account below only when you're ready for live trades."}
            </div>

            <div className="fund-addr mono">
              <span className="rk">account address · {chainLabel(grant.chainId)}</span>
              <span className="rv" style={{ wordBreak: "break-all" }}>{grant.smartAccount}</span>
              <CopyBtn value={grant.smartAccount} label="copy address" />
            </div>

            <div className="grant-note" style={{ marginTop: 12 }}>
              <b>This is a smart-account address, not a MetaMask wallet.</b>{" "}
              <Info>An ERC-4337 smart account. Your owner key controls it, but the key&apos;s own address (what MetaMask derives when you import it) is different — so MetaMask shows an empty wallet, not this account. That&apos;s expected.</Info>{" "}
              Your owner key controls it, but that key&apos;s <i>own</i> address is different — import
              the key into MetaMask and you&apos;ll see an empty wallet, not these funds. To move the
              money out anytime — even after a kill switch — run{" "}
              <span className="mono">merrymen recover</span>, which sweeps the balance to any address
              you choose.
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
                      ? "lets a UserOp land — no real swaps on testnet"
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
                    ? "not tracked on practice — merrymen only knows the mainnet USDG address"
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
                    gas landed —{" "}
                    {session?.hosted ? (
                      <>your band is <b>already riding</b></>
                    ) : (
                      <>run <b>merrymen start</b> and the band rides</>
                    )}{" "}
                    its <b>paper book</b>: live prices, simulated fills. testnet has no trading
                    venues, so no real swap can route here, and the USDG line above stays blank
                    whatever you send.
                  </>
                ) : usdgFunded ? (
                  <>
                    {/* Hosted has nothing to start: the orchestrator spawns a worker
                        per tenant on its own clock. Telling a hosted owner to run a
                        CLI they never installed is the first instruction the product
                        gives them, and it does not apply. */}
                    funded — {session?.hosted ? <>your band is <b>already riding</b></> : <>run <b>merrymen start</b> and your band rides</>}. balances
                    refresh here every few seconds.
                  </>
                ) : (
                  <>
                    gas landed — still waiting on <b>USDG</b>, the agent&apos;s trading capital.
                    until it arrives the band stays on its paper book.
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
                  no USDG it runs in practice mode, which is exactly what somebody
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
                waiting for the first deposit to land… this panel updates automatically.
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
                <span className="rv">{new Date(grant.expiresAt * 1000).toLocaleString()}</span>
              </div>
            </div>

            <div className="caps" style={{ justifyContent: "center", marginTop: 14 }}>
              <span className="cap">max <b>{grant.caps.perTradeUsdg} USDG</b>/trade</span>
              <span className="cap"><b>{grant.caps.dailyUsdg} USDG</b>/day</span>
              <span className="cap"><b>{grant.caps.maxOpsPerDay}</b> ops/day</span>
              <span className="cap">breaker <b>{grant.caps.maxDrawdownPct}%</b></span>
            </div>

            {/*
              WHAT THIS SIGNATURE ACTUALLY CARRIES.
              Until now nothing anywhere showed an owner the capabilities sealed into their own
              key. That mattered once the wall changed: a key signed earlier carries permissions a
              key signed today does not, both are valid, and the only way to tell them apart was to
              read the JSON. Capability drift you cannot see is capability drift you cannot act on.
            */}
            <div className="grant-summary" style={{ marginTop: 14 }}>
              <b>What this key carries.</b> A grant is a signature, so it is frozen at the moment it
              was signed — re-signing is the only way to change it.
              <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                <li>
                  <b>Stock list</b> —{" "}
                  {grant.grantFeatures?.includes(TRADEABLE_V2)
                    ? "the full tradeable set."
                    : "the legacy three (QQQ, NVDA, TSLA) only. Re-sign below to widen it."}
                </li>
                <li>
                  <b>USDG out</b> — none. No withdrawal address is registered, so the key you are about
                  to sign carries no transfer permission at all; moving money out is the owner
                  key&apos;s job (<code>merrymen recover</code>). Wallets signed before this changed keep
                  the free-form transfer permission they were signed with.
                </li>
                <li>
                  <b>ETH → USDG convert</b> —{" "}
                  {grantHasNativeSwap(grant) ? (
                    "granted. With auto-convert on in settings, surplus ETH converts to USDG automatically — a percent of the balance stays as gas. Money only ever lands in your own account."
                  ) : (
                    <>
                      not granted. Keys signed before this was added cannot run auto-convert — the
                      wall refuses the swap. <b>Re-sign below</b> to carry it (free, funds untouched);
                      until then, send USDG directly or convert manually via <code>merrymen recover</code>.
                    </>
                  )}
                </li>
                <li>
                  <b>Uniswap v4</b> —{" "}
                  {grantHasV4(grant) ? (
                    <span style={{ color: "var(--red)" }}>
                      granted, and worth removing. Keys signed before this was changed carry a
                      Permit2 + UniversalRouter pair whose recipient the chain cannot check, because
                      a v4 swap hides it inside opaque calldata. A tampered agent could send your
                      non-USDG tokens anywhere. <b>Re-signing below</b> issues it without the pair
                      — same wallet, same funds, same address, and free.
                    </span>
                  ) : (
                    "not granted. Swaps route through Uniswap v3, where the chain pins the recipient to your own account."
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
            <div id="resign" className="grant-summary" style={{ marginTop: 14 }}>
              <b>Re-sign this key.</b> Free, instant, and nothing is sent on-chain — it is a
              signature, not a transaction. <b>Same wallet, same address, same funds:</b> your
              balances are held by the account, not by the key, so they do not move.
              <br />
              <br />
              What changes is the key itself. The new one is signed against <b>today&apos;s wall</b>,
              so its permissions can differ from the old one&apos;s — the list above says what the
              current key carries, and anything it names as worth removing goes away here. The caps
              below are sealed into the signature too, so this is the moment to change them; the old
              key stops working as soon as the new one is armed.
              {grant.demoOwnerPrivateKey ? (
                <>
                  <div className="grant-fields" style={{ marginTop: 12 }}>
                    <label className="field">
                      <span className="field-label">most it can spend on one trade</span>
                      <span className="field-input">
                        <input type="number" min={1} value={caps.perTradeUsdg} onChange={set("perTradeUsdg")} />
                        <span className="field-unit">USDG</span>
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">most it can spend in a day</span>
                      <span className="field-input">
                        <input type="number" min={1} value={caps.dailyUsdg} onChange={set("dailyUsdg")} />
                        <span className="field-unit">USDG</span>
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">most trades per day</span>
                      <span className="field-input">
                        <input type="number" min={1} value={caps.maxOpsPerDay} onChange={set("maxOpsPerDay")} />
                        <span className="field-unit">trades</span>
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">auto-expire the agent after</span>
                      <span className="field-input">
                        <input type="number" min={1} max={90} value={caps.expiryDays} onChange={set("expiryDays")} />
                        <span className="field-unit">days</span>
                      </span>
                    </label>
                  </div>
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
                          <>Move this key to <b>practice (testnet {TESTNET})</b> — it will stop being able to trade.</>
                        ) : (
                          <>Move this key to <b>real money (mainnet {MAINNET})</b>. Practice mode cannot trade at all: every token merrymen knows is a mainnet deployment, so a testnet balance reads as zero and every route is refused.</>
                        )}
                      </span>
                    </label>
                  </div>
                  {chainId === MAINNET && grant.chainId !== MAINNET && (
                    <div className="mainnet-warning" style={{ marginTop: 10 }}>
                      <b>This is real money.</b> Your owner &amp; session keys are stored in plain
                      text in this browser — anyone with access to it controls the funds. There is
                      no recovery service and no undo. The caps above are the seatbelt: start small.
                      <br />
                      <br />
                      Your account address does not change, so anything already sitting at{" "}
                      <span className="mono">{short(grant.smartAccount)}</span> on mainnet stays
                      there. Practice balances stay behind on testnet, where they were never worth
                      anything.
                      <label className="ack-row" style={{ marginTop: 10 }}>
                        <input
                          type="checkbox"
                          checked={mainnetAck}
                          onChange={(e) => setMainnetAck(e.target.checked)}
                        />
                        <span>
                          I understand — real funds, keys stored locally in plain text, and my caps
                          are my protection.
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
                  <button
                    className="grant-btn"
                    style={{ marginTop: 10, width: "100%" }}
                    onClick={() => void renewKey()}
                    disabled={renewing || (chainId === MAINNET && grant.chainId !== MAINNET && !mainnetAck)}
                  >
                    {renewing
                      ? "re-signing…"
                      : chainId !== grant.chainId
                        ? chainId === MAINNET
                          ? "move to real money & re-sign"
                          : "move to practice & re-sign"
                        : "re-sign this key (free)"}
                  </button>
                </>
              ) : (
                <p className="field-lead" style={{ marginTop: 12 }}>
                  This browser does not hold the owner key for {short(grant.smartAccount)}, and
                  re-signing needs it. Use <b>switch to another wallet</b> below and paste the key
                  in, or run <code>merrymen recover</code> to sweep the funds somewhere you control.
                </p>
              )}
            </div>

            <div className="grant-actions">
              <Link href="/" className="grant-btn" style={{ textAlign: "center", textDecoration: "none" }}>
                back to the band
              </Link>
              <button
                className="copy-btn"
                style={{ padding: "10px 16px" }}
                onClick={() => {
                  setSwitching(true);
                  setMode("restore");
                  setError(null);
                }}
              >
                switch to another wallet
              </button>
              <button className="btn-kill" style={{ padding: "10px 16px" }} onClick={discard}>
                discard &amp; start over
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </AppShell>
  );
}
