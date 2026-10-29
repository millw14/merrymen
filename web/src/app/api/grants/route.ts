/**
 * Dev-mode grant handoff + agent status.
 * POST: browser saves a signed grant → .data/grant.json (worker picks it up).
 * GET: full agent status — grant, live balances from the grant chain, worker heartbeat.
 * DELETE: discard the grant file (localStorage cleared client-side).
 * Replaced by Supabase (encrypted, per-user) once persistence lands.
 *
 * TWO WALLETS PER LOGIN (`?wallet=spot|perps`, absent is Spot; perps slice 5b).
 * POST makes or renews the wallet it names, and only while MERRYMEN_PERPS is
 * paper for a Perps one; GET answers for the wallet it names, whatever
 * MERRYMEN_PERPS says, so an owner can always see a Perps wallet they hold;
 * DELETE's kill names no wallet and stops every one.
 */

import { webChainRead } from "@/lib/chain-read";
import { readGrantBalancesFrom, type GrantBalances } from "@/lib/grant-balances";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { writeFileAtomic } from "@merrymen/atomic-write";
import { homePaths, merrymenHome, purposeHome } from "@merrymen/home";
import { createPublicClient } from "viem";
import {
  accountsMatch,
  carriesOwnerKey,
  chainForId,
  derivationUnreachable,
  duplicateWallPermissions,
  isHostedMode,
  isRobinhoodChainId,
  publicGrantView,
  robinhoodChain,
  type Derivation,
  type EnergyStatus,
  type PerpsReport,
  type PublicGrantView,
  type StoredGrant,
  GRANT_PERP_LIGHTER,
  grantPurpose,
  type GrantPurpose,
} from "@merrymen/core";
import { requestOrigin, tenantOf, verifyGrantBinding } from "@/lib/auth";
import { checkCanonicalWall, type WallVerdict } from "@/lib/canonical-wall";
import { privyTokenOf, verifyPrivyToken } from "@/lib/privy";
import { withReadDb } from "@/lib/ledger";
import { readAgentEnergy } from "@/lib/agent-energy";
import { readAgentPerps } from "@/lib/agent-perps";
import { perpsCreationAllowed, perpsWalletRefused } from "@/lib/perps-enabled";
import { NO_STORE_HEADERS, walletUnknown } from "@/lib/route-guard";
import { assertIndependentWallets, getGrantStore, GrantReplacementConflict, GrantWalletConflict } from "@merrymen/grant-store";
import { getIdentityStore } from "@merrymen/identity-store";
import { getSettingsStore } from "@merrymen/settings-store";
import { ledgerHasAgent, mintAndNameAgent } from "@/lib/first-name";
import { deriveKernelAccountAddress } from "@/lib/derive-account";
import { archiveCurrentGrant, GrantArchiveError, removeSelfHostedGrant } from "@/lib/grant-archive";
import { stopLocalSolanaForKill, stopSolanaForKill } from "../../../../../worker/src/solana-kill";
import { perpsHalf, stopLocalPerpsForKill, stopLocalPerpsGrantForRenewal, stopPerpsForKill, type PerpsHalf } from "../../../../../worker/src/perps-kill";
import { readWalletParam, WALLET_PARAM } from "@/lib/wallet-param";
import { readFleetRecoveryView, type FleetRecoveryView } from "../../../../../worker/src/fleet-recovery";
import { readPerpsWallets } from "../../../../../worker/src/perps-wallets";
import { resolveConfig } from "../../../../../worker/src/settings";
import { errorText } from "../../../../../worker/src/redact-urls";
import { workerStale as workerStaleOf } from "@/terminal/worker-stale";

const DATA_DIR = merrymenHome();
const GRANT_FILE = homePaths.grant();
const HEARTBEAT_FILE = homePaths.heartbeat();

/** A well-formed 0x EVM address. The archive (lib/grant-archive.ts) keeps its own
 * copy of this check, since it builds a filename from the address. */
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * BODY LIMITS. A grant is a serialized permission plus a few fields; partner
 * activation (lib/partner-enrollment.ts) carries the same grant in at most
 * 256 KiB, with the permission itself capped at 240,000 characters. Nothing a
 * signer makes comes close. The kill switch's body is a few named fields.
 * Every check below parses or scans the whole payload, so it is bounded first.
 */
const GRANT_BODY_MAX_BYTES = 256 * 1024;
const GRANT_DELETE_BODY_MAX_BYTES = 8 * 1024;

/**
 * The body as text, or null when it is larger than `limit` bytes. Counted
 * while it streams, so an oversized body is never held in memory whole; the
 * declared length is refused first as the cheap case.
 */
async function readGrantBody(req: Request, limit: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
const tooLarge = () => NextResponse.json({ error: "That request is too large. Nothing was saved." }, { status: 413 });

export interface AgentStatus {
  exists: boolean;
  /** Authenticated owner's source hold; independent of saved balances or old worker status. */
  recovery?: FleetRecoveryView | null;
  /** Hosted GET only: the authenticated tenant this status was read for. */
  tenant?: `0x${string}` | null;
  /**
   * Hosted `?wallet=perps` only, with `exists` false: the Perps store holds a
   * record it will not show (one stopped for a renewal whose POST has not
   * landed, or one it cannot read). Its owner is the login (perps-owner), and
   * a Spot grant is still held to it (assertIndependentWallets reads the
   * record raw), so the Wallet screen's restore asks this too
   * (restore-perps-owner.ts).
   */
  stored?: true;
  grant?: Omit<StoredGrant, "serialized" | "demoSessionPrivateKey" | "demoOwnerPrivateKey">;
  /** Decimal strings as read from the chain; null for any read that failed. */
  balances?: GrantBalances;
  workerAliveAt?: number | null;
  /**
   * TRUE WHEN NEITHER HEARTBEAT SOURCE COULD BE READ — no file and the ledger
   * read failed or there is no database. `workerAliveAt` is null then too, but
   * it means "could not tell", not "never heard from", and the chat must not
   * tell an owner whose agent may be trading that it has not started.
   * Absent whenever a source answered.
   */
  heartbeatUnread?: true;
  /**
   * HAS THE WORKER STOPPED REPORTING? `workerAliveAt` older than the watchdog's
   * window for this owner's tick — never shorter than one order's run, which
   * the mirrored row can lag the file by — plus a margin for the mirror.
   *
   * DECIDED HERE, by this server's clock — never by the browser's, which would
   * judge a server timestamp by however wrong that laptop's clock is — and by
   * the one rule the MCP tools already state (terminal/worker-stale.ts).
   *
   * NULL IS "NEVER HEARD FROM", which is not stale and not fresh: a new agent
   * waiting for its first tick has not stopped. Absent on an older server, and
   * a client reads that as null.
   */
  workerStale?: boolean | null;
  /** "paper" (simulated fills), "live" (signing), or "idle" — from the heartbeat. */
  mode?: "paper" | "live" | "idle" | null;
  /**
   * Is somebody else paying this agent's TRADING gas?
   *
   * REPORTED BY THE WORKER, never computed here. Sponsorship is worker config —
   * sponsorGasEnabled AND a bundler key — and hosted this service is a different
   * container with a different environment. docs/hosted-deploy.md says the web
   * service needs no bundler key, so a local answer would read false on a
   * correctly configured fleet and tell every sponsored owner to go send ETH;
   * and if the two ever drifted the other way it would promise covered fees
   * while the child refused every trade. Same reasoning as `mode` above.
   *
   * null/absent means the agent has not said yet, which is not the same as no.
   * WITHDRAWAL IS NEVER SPONSORED, whatever this says.
   */
  gasSponsored?: boolean | null;
  /**
   * WHAT IS STOPPING THIS AGENT TRADING FOR REAL, as the child resolved it.
   *
   * One of the `RefuseRule` names — `no-gas`, `wrong-chain`, `dead-policy`,
   * `no-cash`, `not-armed`, `no-executor` — or null.
   *
   * REPORTED BY THE WORKER, never computed here, for exactly the reasons
   * `gasSponsored` above gives: the verdict depends on this child's own
   * balances, chain and executor, and a second guess from another container
   * would eventually disagree with the process that actually refuses trades.
   *
   * NULL IS TWO ANSWERS and a screen must render neither as a blocker: the
   * agent has never beaten, or it is trading for real. `mode` and
   * `workerAliveAt` are what separate those.
   */
  liveBlocker?: string | null;
  /**
   * THIS AGENT'S ENERGY — how much it may start on its own today, and why.
   *
   * REPORTED BY THE WORKER, never computed here: the process that throttles is
   * the only one that knows its own counters and whether it could read the
   * $MERRYMEN balances it throttles on (packages/core/src/energy.ts).
   *
   * NULL IS "NOT SAID YET", NEVER ZERO. No report, an old ledger without the
   * column, or a value that is not the v1 shape are all null, and a screen
   * renders that as "I can't see my energy" — never as an empty allowance, and
   * never as a balance of 0 that sends somebody to buy what they already hold.
   */
  energy?: EnergyStatus | null;
}

/**
 * GET /api/grants?wallet=perps: the Perps wallet's status, the Spot answer's
 * shape with three differences.
 *
 * - `grant` is core's publicGrantView, an ALLOWLIST of addresses, caps, times,
 *   markers and public keys: never the session key, the owner key, the
 *   serialized permission, the binding's nonce, DID or signatures. Spot keeps
 *   main's denylist view (decision D3): its saved-grant and renewal code reads
 *   the binding, and changes with its own client.
 * - `perps` is the worker's report of the Perps book (lib/agent-perps.ts),
 *   null when not said or unreadable, never an empty book.
 * - no `energy`: a Perps wallet buys none (its paper wall is empty, D5).
 */
export interface PerpsWalletStatus extends Omit<AgentStatus, "grant" | "energy"> {
  grant?: PublicGrantView;
  perps?: PerpsReport | null;
}

export async function POST(req: Request) {
  let text: string | null;
  try { text = await readGrantBody(req, GRANT_BODY_MAX_BYTES); }
  catch { return NextResponse.json({ error: "not a grant" }, { status: 400 }); }
  if (text === null) return tooLarge();
  let grant: StoredGrant;
  try { grant = JSON.parse(text) as StoredGrant; }
  catch { return NextResponse.json({ error: "not a grant" }, { status: 400 }); }
  if (!grant?.serialized || !isAddr(grant?.smartAccount)) {
    return NextResponse.json({ error: "not a grant" }, { status: 400 });
  }

  // ── A GRANT THAT CAN NEVER BE INSTALLED ──────────────────────────────────
  //
  // Checked BEFORE anything else, and for every mode, because it is the one
  // defect that makes an agent look perfectly healthy while being unable to
  // execute a single operation. Kernel's CallPolicy refuses a repeated
  // (callType, target, selector), so such a grant reverts at validation —
  // `AA23 duplicate permissionHash` — before any policy is consulted, with
  // nothing in the message naming the wall or the trade.
  //
  // THE CASE THIS IS WRITTEN AGAINST is not a malicious payload. The wall is
  // built in the signing client, so an owner with a tab open from before a
  // deploy seals the OLD wall; the server stored it happily and the agent
  // spent hours refusing every trade. Three re-signs were spent before the
  // client, rather than the chain, was suspected. One check here turns that
  // into one sentence at signing time.
  //
  // REFUSED, NOT REPAIRED: the permissions sit inside the signed payload, so
  // de-duplicating them would store something the owner never signed — the
  // same reasoning as the zero-cap refusal below.
  const duplicates = duplicateWallPermissions(grant.serialized);
  if (duplicates.length > 0) {
    return NextResponse.json(
      {
        error:
          "this permission lists the same contract and function twice, and the account contract refuses to " +
          "install it — the agent would be unable to make any trade at all. It usually means the page was " +
          "open from before an update: reload and sign again.",
        duplicates,
      },
      { status: 400 },
    );
  }

  // ── A GRANT FOR A CHAIN THIS PRODUCT DOES NOT RUN ON ─────────────────────
  //
  // Nothing checked chainId before, and what reads it downstream (chainForId,
  // the derivation, the balance reads) turns any id but the testnet into
  // mainnet: a grant naming chain 1, a Solana grant or one with no chainId at
  // all was accepted and read as Robinhood Chain. Every grant our signers make
  // carries 4663 or 46630 (chain.id), so this refuses only what they never
  // send. For every mode, before the hosted checks read the id, and pure, so
  // it burns no nonce.
  if (!isRobinhoodChainId(grant.chainId)) {
    const named = grant.chainId === undefined ? "names no chain" : `is for chain ${JSON.stringify(grant.chainId).slice(0, 64)}`;
    return NextResponse.json(
      {
        error: `this grant ${named}, and Merrymen only runs on Robinhood Chain (4663) and its testnet (46630). Nothing was saved.`,
        code: "unsupported_chain",
      },
      { status: 400 },
    );
  }

  // A FEATURE LIST THAT IS NOT A LIST is refused by name before anything reads
  // it. The perps refusal below asks `.includes`, which a number or an object
  // does not have (a 500) and a string answers by substring; neither is a
  // grant a signer mints.
  if (
    grant.grantFeatures != null &&
    (!Array.isArray(grant.grantFeatures) || grant.grantFeatures.some((f) => typeof f !== "string"))
  ) {
    return NextResponse.json({ error: "grant features must be a list of names" }, { status: 400 });
  }

  // WHICH WALLET (?wallet=; absent is Spot), AND THE GRANT MUST AGREE. Pure,
  // every mode, before anything is read or stored: a grant only ever lands
  // in the wallet it names (grantPurpose: absent is Spot).
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was saved.");
  let named: GrantPurpose;
  try { named = grantPurpose(grant); }
  catch { return NextResponse.json({ error: "this grant names a wallet this server does not know. Nothing was saved." }, { status: 400 }); }
  if (named !== wallet) {
    return NextResponse.json(
      { error: `this grant is for your ${named} wallet, but the request is for your ${wallet} wallet. Nothing was saved.`, code: "wallet-mismatch" },
      { status: 400 },
    );
  }
  // A PERPS WALLET IS MADE OR RENEWED ONLY WHERE PAPER PERPS ARE ON (decision
  // D1): MERRYMEN_PERPS=paper, read through the one parser the worker and the
  // orchestrator use (perps-enabled.ts), so the web never makes a wallet the
  // deployment's workers would refuse to run. Anything else — unset, off, a
  // typo, and `live`, which this build reads as off — refuses creation AND
  // renewal here, every mode, before anything is read or stored; DELETE
  // refuses a renewal's first step (its permission-replacement stop) the same
  // way, so a renewal that cannot finish never starts. An owner who
  // already holds one still sees it (GET) and stops it (every kill); a gate
  // that switches a capability off never stands between an owner and that.
  if (wallet === "perps" && !perpsCreationAllowed()) return perpsWalletNotOffered("Nothing was saved.");
  // ROBINHOOD CHAIN MAINNET ONLY. The Perps wallet exists for Lighter, which
  // has no test network, and the testnet chain id would derive (and later be
  // killed and recovered) somewhere no Perps worker ever runs. Pure, before
  // anything is read; the canonical wall says it again for every door.
  if (wallet === "perps" && grant.chainId !== robinhoodChain.id) {
    return NextResponse.json(
      {
        error: `A Perps wallet exists only on Robinhood Chain (${robinhoodChain.id}), and this grant is for chain ${JSON.stringify(grant.chainId)}. Nothing was saved.`,
        code: "perps-chain",
        ownerFacing: true,
      },
      { status: 400 },
    );
  }

  // PERPETUALS ARE NOT TAKEN BY THIS SERVER YET (perps slice 1). The signers can
  // carry a Lighter key and the canonical wall can rebuild one, but nothing here
  // can mint, seal, hold or stand down a key, so a grant naming one is refused
  // exactly as a perps-off server refuses a new opt-in. Every mode, before
  // anything is read or stored. Replaced by perp-custody's acceptIncomingPerp
  // when keygen lands.
  if (
    grant.grantFeatures?.includes(GRANT_PERP_LIGHTER) ||
    grant.perp !== undefined ||
    grant.perpRecovery !== undefined
  ) {
    return NextResponse.json(
      {
        error:
          "perpetuals are not offered for this agent on this server yet, so no new Lighter key can be made or sealed. Sign again without perpetuals.",
        code: "perp-not-offered",
        ownerFacing: true,
      },
      { status: 403 },
    );
  }

  if (isHostedMode()) {
    // ── the hosted custody boundary ──────────────────────────────────────
    // On a public URL the server must NEVER become custodian of an owner key,
    // and must never let one tenant install a grant under another's account.
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    // REJECT any owner-key material — the named field, a raw 32-byte key, or a
    // mnemonic hiding anywhere in the payload. This is the single most important
    // check in the whole hosted migration: pass it and one DB dump drains
    // everyone. carriesOwnerKey is the shared definition (packages/core).
    if (carriesOwnerKey(grant)) {
      return NextResponse.json(
        { error: "this grant carries an owner key — hosted grants must be session-key-only" },
        { status: 422 },
      );
    }

    // AUTHORIZE ON THE SESSION ADDRESS, never on the self-declared grant.owner.
    // A tenant that could claim someone else's account would hijack their agent
    // id and ledger partition (the DB keys every table on smart_account).
    //
    // `owner` is a key the BROWSER generated, so it can never equal the tenant —
    // requiring that was why every hosted grant was refused. The claim is proved
    // instead by two signatures over one server-issued nonce: the wallet
    // authorizes this exact (owner, account, chain) pair, and the owner key
    // co-signs the same text. The second is what makes it unforgeable — without
    // it both remaining checks are functions of PUBLIC addresses, so anyone
    // could authorize anyone else's pair and squat their partition.
    if (!isAddr(grant.owner)) {
      return NextResponse.json({ error: "grant owner is not an address" }, { status: 400 });
    }
    // ── A PERPS WALLET IS OWNED BY THE WALLET YOU SIGN IN WITH (decision D4) ──
    //
    // The grant store refuses any other owner for a Perps wallet (grant-store
    // toRecord, `perps-owner`): never a key generated in a browser, which main
    // stopped making for real money. The only binding that proves owner equals
    // login is `privy-did-owner-v1` (the legacy one refuses a key that signs
    // twice), so in v1 paper only a login with an embedded wallet has a Perps
    // wallet. Asked HERE, by name and before the nonce is spent, rather than
    // left to the store to throw after the binding and the derivation: the
    // owner learns why, and the claim costs nothing.
    if (wallet === "perps" && grant.owner.toLowerCase() !== tenant.toLowerCase()) {
      return NextResponse.json(
        {
          error:
            "A Perps wallet must be owned by the wallet you sign in with, not a key made in the browser, so for now " +
            "only a login with an embedded wallet can have one. Nothing was saved.",
          code: "perps-owner",
          ownerFacing: true,
        },
        { status: 403 },
      );
    }
    // ── A CAP OF ZERO PERMITS NOTHING, AND A SIGNATURE CANNOT BE EDITED ────
    //
    // `maxDrawdownPct: 0` makes policy.ts compute `0bps >= 0bps` and refuse
    // every non-exit intent for the life of the grant; a zero per-trade or
    // daily cap refuses every trade outright; zero ops or zero days is an agent
    // that is finished before it starts. None of it is recoverable without a
    // re-sign, and one agent on the fleet is stuck in exactly that state.
    //
    // The browser clamps too. This is the second gate, because the clamp there
    // is a UI convenience and this route accepts a POST from anywhere — and
    // because a bricked grant is the one mistake nothing downstream can undo.
    // REFUSED RATHER THAN REPAIRED: the caps are inside the signed payload, so
    // "fixing" one here would store something the owner did not sign.
    const zeroCap = (["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"] as const).find(
      (k) => !Number.isFinite(grant.caps?.[k]) || Number(grant.caps?.[k]) < 1,
    );
    if (zeroCap) {
      return NextResponse.json(
        {
          error:
            `${zeroCap} is ${String(grant.caps?.[zeroCap])}, which permits nothing — and a signature cannot be ` +
            `edited afterwards, so this grant would be unusable forever. Set it to at least 1 and sign again.`,
        },
        { status: 400 },
      );
    }

    // ── THE SERVER STORES THE MERRYMEN WALL, OR NOTHING ──────────────────
    //
    // Every check above is about WHO is asking and whether the caps are
    // usable. None of them looked at what the permission actually permits —
    // and the worker trusts this payload's metadata about exactly that:
    // `grantFeatures` opens routes in its mirror (limitsFromGrant), a
    // `transfer` marker dated before the withdrawal allowlist is read as a
    // free-form-recipient transfer (grantHasTransfer), and `grantTokens` and
    // the sealed adapters say what it may sell and call. A tenant could post a
    // hand-built permission carrying a USDG `transfer`, the Rialto target or
    // the v4 UniversalRouter, and it was stored as-is. The site's terms say the
    // session key has no transfer permission; this is what makes that true of
    // everything this route accepts, not only of what our signers produce.
    //
    // The same rebuild-and-compare partner enrollment has always done
    // (canonical-wall.ts): the canonical wall is rebuilt from this grant's own
    // caps, times, tokens and sealed addresses and compared byte for byte with
    // what the worker would install, and any marker the wall does not mint is
    // refused.
    //
    // BEFORE THE BINDING, because it is pure: a refusal here costs no RPC and
    // burns no single-use nonce.
    //
    // A STALE CLIENT IS REFUSED TOO, deliberately. The wall is built in the
    // signing client, so a tab open from before a deploy that changed wall.ts
    // seals the OLD wall — which is no longer what this server, or the worker's
    // mirror, believes a grant permits. Everything per-owner (tokens, adapters,
    // vaults, Trencher scope) is read from the grant itself, so only a change
    // to wall.ts can cause this, and the remedy is the one the duplicate
    // refusal above already gives: reload and sign again.
    //
    // A PERPS GRANT IS CHECKED AGAINST THE PERPS WALL (its signed purpose
    // reaches the rebuild), which in this build is empty (decision D5).
    const wall = checkCanonicalWall(grant as unknown as Record<string, unknown>);
    if (!wall.ok) return wallRefused(wall);

    const binding = grant.binding;
    // Version-agnostic presence check. WHICH signatures a claim needs is the
    // validator's decision, not this route's — demanding a walletSignature here
    // would hard-code the legacy model into a route that is about to serve two.
    if (!binding?.nonce || !binding.ownerSignature) {
      return NextResponse.json(
        { error: "this grant isn't linked to your login — create it again from a signed-in browser" },
        { status: 403 },
      );
    }
    // A CLAIM MAY NOT CARRY EVIDENCE ITS OWN VERSION DOES NOT USE. `did` is
    // only meaningful under `privy-did-owner-v1`; arriving on a legacy claim it
    // is unverified client text that would be persisted verbatim and read back
    // later as though the server had checked it.
    if (binding.version === "privy-did-owner-v1" && typeof binding.did !== "string") {
      return NextResponse.json(
        { error: "this grant claims a privy binding but names no identity" },
        { status: 400 },
      );
    }
    if (binding.did !== undefined && binding.version !== "privy-did-owner-v1") {
      return NextResponse.json(
        { error: "this grant carries an identity its binding version does not verify" },
        { status: 400 },
      );
    }
    // ── the privy arm needs a VERIFIED token, and this is where it is read ──
    //
    // verifyGrantBinding holds no Privy credential and does no token
    // verification: it is handed the DID or it refuses. So a grant declaring
    // `privy-did-owner-v1` must arrive with its access token, and a deployment
    // that cannot verify one cannot accept the binding — which is the correct
    // failure, not a fallback to the legacy check.
    let verifiedDid: string | null = null;
    if (binding.version === "privy-did-owner-v1") {
      const token = await verifyPrivyToken(privyTokenOf(req));
      if (!token.ok) return NextResponse.json({ error: token.why }, { status: 401 });
      verifiedDid = token.identity.did;
    }

    const bound = await verifyGrantBinding({
      origin: requestOrigin(req),
      tenant,
      nonce: binding.nonce,
      owner: grant.owner,
      smartAccount: grant.smartAccount,
      chainId: grant.chainId,
      // THE WALLET IS IN THE SIGNED TEXT. A Perps claim signs "Account
      // purpose: perps" and a Spot claim the text it always signed, and the
      // text is rebuilt with the wallet THIS REQUEST names (the grant agrees
      // with it, checked above). So a binding made for one wallet, replayed
      // onto the other's grant, recovers to nobody and is refused here, with
      // its nonce unspent.
      purpose: wallet,
      walletSignature: binding.walletSignature,
      ownerSignature: binding.ownerSignature,
      // PASSED THROUGH UNVALIDATED, ON PURPOSE. verifyGrantBinding is the one
      // place that decides which security model a claim was made under, and it
      // refuses anything it does not recognise. Omitting this — which an
      // earlier revision of this file did — makes the whole dispatch
      // unreachable: every claim resolves to the default, so a grant declaring
      // `privy-did-owner-v1` would be verified under LEGACY rules instead of
      // refused, which is precisely the downgrade the versioning exists to stop.
      version: binding.version,
      did: binding.did,
      verifiedDid,
    });
    if (!bound.ok) {
      return NextResponse.json({ error: bound.why }, { status: 403 });
    }

    // FIRST CLAIM WINS. Two tenants must never share a smart account, because
    // every ledger table keys on it — they would silently write into one
    // partition. Possession of the owner key is already proved above, so this is
    // not a security boundary so much as a collision guard, and it fails safe:
    // an unreadable store refuses rather than allowing a possible collision.
    // The Spot store answers for BOTH wallets' claims (grant-store
    // tenantForAccount), so a Perps grant is asked here too, without the
    // Perps store being touched before anything is written to it.
    try {
      const holder = await getGrantStore("spot").tenantForAccount(grant.smartAccount);
      if (holder && holder !== tenant) {
        return NextResponse.json(
          { error: "this agent account is already linked to a different login" },
          { status: 409 },
        );
      }
    } catch {
      return NextResponse.json(
        // Written for the owner, so it is marked as such: a 5xx body is not
        // shown to them otherwise (terminal/request-json.ts).
        { error: "couldn't check this account's ownership — please try again", ownerFacing: true },
        { status: 503 },
      );
    }

    // FIRST-ARM IDENTITY PROOF. owner == tenant above only proves the CLAIMED
    // owner is this wallet — it says nothing about smartAccount, which the client
    // supplied as free JSON. A tenant could keep grant.owner == their own wallet
    // yet point grant.smartAccount at SOMEONE ELSE'S account and squat its ledger
    // partition (every table keys on smart_account). So recompute the
    // counterfactual Kernel address from the owner and require it to match the
    // claimed account. deserializePermissionAccount elsewhere reads accountAddress
    // straight from the grant; THIS is the check that makes that address earned.
    // Fail CLOSED: if derivation can't be verified (bad chain id, RPC hiccup),
    // refuse rather than trust the client — a rejected honest grant is retried, a
    // trusted dishonest one is not undoable.
    //
    // THE COMPARISON TAKES THE RESULT, NOT THE ADDRESS. The derivation is a
    // live eth_call that can answer 0x0000...0000 without throwing, and if the
    // browser answered the same zero the two would MATCH — the fault would make
    // this check pass rather than fail. accountsMatch refuses a failed
    // derivation before any equality is computed. See packages/core/derivation.
    //
    // AT THE WALLET THIS REQUEST NAMES. One owner key holds two accounts, Spot
    // at Kernel index 0 and Perps at index 1 (accountIndexForPurpose), so a
    // Perps grant must name the owner's index-1 address: its index-0 (Spot)
    // account submitted under wallet=perps is refused here, as is anyone
    // else's. Derived at "spot" for every wallet, every honest Perps grant
    // would be refused; skipped for Perps, a tenant could point a Perps grant
    // at any account and claim its ledger partition.
    const derivation = await derivationRefusal(grant, wallet);
    if (derivation) return derivation;

    // Persist to the per-tenant store, keyed on the authenticated tenant. The
    // store seals the session key at rest and refuses (again, defence in depth)
    // any grant carrying an owner key or whose owner isn't this tenant. It is
    // the WALLET'S store: a Perps grant never lands in the Spot one.
    try {
      await getGrantStore(wallet).put(tenant, grant);
    } catch (e) {
      return storeRefused(e);
    }

    // NO PUBLIC IDENTITY FOR A PERPS WALLET (decision D2, docs/perps.md rule
    // 17). The Perps account never joins the login's public identity: no slug
    // is minted or extended for it, and nothing is named after it, so no public
    // read (profile, board, search, follow) can ever resolve to it, and a
    // reader added later cannot leak it by walking the identity's accounts.
    // The orchestrator keeps the same rule (orchestrator.ts writeGrantForChild).
    // read-agent.ts and public-feed.ts filter Perps wallets as a backstop.
    if (wallet === "perps") return NextResponse.json({ ok: true });

    // MINT THE PUBLIC ID HERE, and only here.
    //
    // This is the one place in the codebase where an authenticated tenant and a
    // DERIVATION-VERIFIED smart account exist together — the counterfactual
    // address was re-derived and checked a few lines above, so neither value is
    // taken on trust. The identity is keyed on the tenant, so a re-grant appends
    // the new account and leaves the slug (and every link and follow edge
    // pointing at it) exactly where it was.
    //
    // BEST EFFORT ON PURPOSE. The grant is already durably stored and the money
    // path is done; failing the request now would tell the owner their agent was
    // not created when it was.
    //
    // The backfill for an agent that misses this is in the ORCHESTRATOR, in
    // writeGrantForChild — not "a later read", which is what this comment used
    // to claim and which was never built. It could not be a read: the public
    // routes are cached and unauthenticated, and an anonymous GET that mints
    // identities is a write nobody asked for.
    //
    // THE IDENTITY IS READ BEFORE IT IS ENSURED, and a new agent with no name
    // gets its slug's name — see mintAndNameAgent, which a test runs with a
    // fake identity store. Best effort: it never throws.
    await mintAndNameAgent({
      tenant,
      account: grant.smartAccount,
      identities: () => getIdentityStore(),
      settings: {
        get: () => getSettingsStore("spot").get(tenant),
        put: (s) => getSettingsStore("spot").put(tenant, s),
      },
      ledgerHasAgent: (account) => ledgerHasAgent((fn) => withReadDb(fn, "spot"), account),
      // "Has this login held an account before?" counts Spot accounts only, so
      // a Perps wallet on record can never make the Spot agent look re-granted.
      perpsWallets: () => perpsWalletsOnRecord(),
    });
    return NextResponse.json({ ok: true });
  }

  // A SELF-HOSTED PERPS WALLET lives in its own home (accounts/perps).
  if (wallet === "perps") return selfHostedPerpsIntake(grant);

  // THE OTHER WALLET'S grant.json, held to the store's rules: the same owner
  // key, a different account, no perpetuals left on Spot. An install with no
  // Perps wallet reads nothing here and is exactly what it was.
  const other = await otherLocalWalletRefusal(grant, "spot");
  if (other) return other;

  await mkdir(DATA_DIR, { recursive: true });
  // Keep the outgoing wallet (and its owner key) before this one replaces it.
  //
  // BEST-EFFORT, deliberately: archiving must never block arming a grant. A
  // failure is said loudly, because the grant it failed to keep is about to be
  // replaced.
  const kept = await archiveCurrentGrant("spot");
  if (kept.kind === "failed") {
    console.error(`[grants] the outgoing grant was NOT archived (${kept.why}) — replacing grant.json anyway; its owner key is not in ~/.merrymen/grants/`);
  }
  // grant.json holds the owner + session PRIVATE KEYS — owner-only perms (0600),
  // set on the temp file before it is renamed in.
  //
  // REPLACED WHOLE. The worker re-reads grant.json every tick, and a read that
  // raced writeFile's truncate got null — which an armed worker takes for the
  // kill switch (syncGrant). And it is fsynced before the rename: self-hosted
  // this file is the only copy of the new owner key, and a crash after a
  // truncate-then-write could leave it empty.
  await writeFileAtomic(GRANT_FILE, JSON.stringify(grant, null, 2), 0o600);
  return NextResponse.json({ ok: true });
}

/** A canonical-wall refusal (canonical-wall.ts), as both deployments answer it. */
function wallRefused(wall: Extract<WallVerdict, { ok: false }>): NextResponse {
  return NextResponse.json(
    {
      error:
        `${wall.why}. This service only accepts the Merrymen permission wall. If this page was open ` +
        `from before an update, reload it and sign again.`,
      code: wall.code,
    },
    { status: wall.status },
  );
}

/**
 * IS THIS GRANT'S ACCOUNT THE OWNER'S OWN, AT THE WALLET'S INDEX? Null when it
 * is; otherwise the refusal: 503 when the derivation could not be made (never a
 * pass), 403 when it was made and names another account.
 *
 * A live eth_call (deriveKernelAccountAddress: the EntryPoint's
 * getSenderAddress for the owner's Kernel account at accountIndexForPurpose),
 * compared through accountsMatch, which refuses a failed derivation before any
 * equality is computed, so two faults can never agree.
 */
async function derivationRefusal(grant: StoredGrant, wallet: GrantPurpose): Promise<NextResponse | null> {
  let derived: Derivation;
  try {
    derived = await deriveKernelAccountAddress(grant.owner as `0x${string}`, grant.chainId, wallet);
  } catch (e) {
    // A live eth_call: its error is viem's, and names the RPC URL with its key.
    derived = derivationUnreachable(errorText(e));
  }
  if (!derived.ok) {
    // `zero` and `malformed` are the chain answering wrongly, not the client
    // claiming wrongly — 503 so an honest grant is retried rather than told
    // its account is a forgery.
    return NextResponse.json({ error: derived.why }, { status: 503 });
  }
  const match = accountsMatch(derived, grant.smartAccount);
  if (!match.ok) {
    return NextResponse.json({ error: match.why }, { status: 403 });
  }
  return null;
}

/**
 * WHAT A STORE WRITE THAT REFUSED SAYS. Nothing was stored in any of them: the
 * store decides inside the write, under its lock (grant-store.ts).
 *
 * - A stopped session key, or a full replacement history: 409, the store's own
 *   sentence.
 * - The other wallet's owner, an account another login holds, a Spot grant
 *   still carrying perpetuals, or a Perps owner who is not the login: 409, with
 *   the store's code.
 * - Anything else — the other wallet's grant could not be read or verified, the
 *   lock was busy, the database answered an error — is the service failing,
 *   not the owner: 503, a fixed sentence, retried. Never a 500, and never the
 *   error's own text, which can name the database it came from.
 */
function storeRefused(e: unknown): NextResponse {
  if (e instanceof GrantReplacementConflict) return NextResponse.json({ error: e.message, ownerFacing: true }, { status: 409 });
  if (e instanceof GrantWalletConflict) return NextResponse.json({ error: e.message, code: e.code, ownerFacing: true }, { status: 409 });
  console.error(`[grants] a grant could not be stored: ${errorText(e)}`);
  return NextResponse.json(
    { error: "Your permission could not be saved. Please try again.", ownerFacing: true },
    { status: 503 },
  );
}

/**
 * The accounts the fleet has on record as Perps wallets (perps-wallets.ts), for
 * the naming count, or null when that record cannot be read. No ledger to read
 * names nobody: self-hosted, and a fleet that has never run a Perps worker.
 */
async function perpsWalletsOnRecord(): Promise<ReadonlySet<string> | null> {
  try {
    return await withReadDb(async (db) => (db ? readPerpsWallets(db) : new Set<string>()), "spot");
  } catch {
    return null;
  }
}

/** A wallet's grant.json on a self-hosted install: Spot's where it always was, Perps's in accounts/perps. */
function localGrantFile(wallet: GrantPurpose): string {
  return wallet === "spot" ? GRANT_FILE : path.join(purposeHome(wallet), "grant.json");
}

/**
 * THE OTHER WALLET, SELF-HOSTED. Hosted, the grant store holds a tenant's two
 * wallets to three rules inside its write (grant-store assertIndependentWallets):
 * the same owner key, different accounts, and no perpetuals left on a Spot
 * grant beside a Perps wallet. Self-hosted each wallet's grant.json is written
 * here, so the same rules are asked of the other wallet's file, by the same
 * function. Null when they hold, or when there is no other wallet.
 *
 * A file that is there but cannot be read, parsed or verified as the other
 * wallet's refuses with 503: it is exactly the grant the rules are about.
 *
 * NOT ATOMIC WITH THE WRITE. Two tabs posting both wallets' first grants at
 * once can each pass against nothing (decision D7 defers the self-hosted
 * writer lock, cli/grant-lock.mjs); an install has one owner at a keyboard.
 */
async function otherLocalWalletRefusal(grant: StoredGrant, wallet: GrantPurpose): Promise<NextResponse | null> {
  const otherWallet: GrantPurpose = wallet === "spot" ? "perps" : "spot";
  const unreadable = NextResponse.json(
    { error: `Your ${otherWallet} wallet's permission could not be read, so this one could not be checked against it and was not saved. Your ${otherWallet} wallet was not changed.`, ownerFacing: true },
    { status: 503 },
  );
  let other: StoredGrant;
  try {
    other = JSON.parse((await readFile(localGrantFile(otherWallet), "utf8")).replace(/^\ufeff/, "")) as StoredGrant;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : unreadable;
  }
  try {
    if (grantPurpose(other) !== otherWallet) return unreadable;
    assertIndependentWallets(grant, other);
    return null;
  } catch (e) {
    if (e instanceof GrantWalletConflict) return NextResponse.json({ error: e.message, code: e.code, ownerFacing: true }, { status: 409 });
    return unreadable;
  }
}

/**
 * A SELF-HOSTED PERPS WALLET'S GRANT, into its own home ($MERRYMEN_HOME/
 * accounts/perps, purposeHome): checked as hosted checks one, then the
 * outgoing Perps grant archived and grant.json replaced whole, as Spot's is.
 * Every refusal lands before anything is written.
 *
 * - THE WALL, as hosted (canonical-wall.ts): the Perps wall, empty in this
 *   build (D5). Self-hosted Spot is not asked this; a Perps wallet is, because
 *   its account is a mainnet account and a paper product must not hold a key
 *   that can spend its real USDG, whoever built the grant.
 * - THE OTHER WALLET: the Spot grant.json, if any, has the same owner key and
 *   a different account (otherLocalWalletRefusal).
 * - THE INDEX-1 DERIVATION (decision D8): the account must be the owner's own
 *   Kernel account at the Perps index. Nothing else ties a self-hosted Perps
 *   grant to its owner: without it, an owner's Spot account (or anyone's)
 *   could be relabelled Perps whenever no Spot grant.json is there to compare
 *   it with. A live eth_call, so it FAILS CLOSED: an RPC that cannot answer is
 *   a 503 with nothing written, never a pass.
 */
async function selfHostedPerpsIntake(grant: StoredGrant): Promise<NextResponse> {
  const wall = checkCanonicalWall(grant as unknown as Record<string, unknown>);
  if (!wall.ok) return wallRefused(wall);
  if (!isAddr(grant.owner)) return NextResponse.json({ error: "grant owner is not an address" }, { status: 400 });
  const other = await otherLocalWalletRefusal(grant, "perps");
  if (other) return other;
  const derivation = await derivationRefusal(grant, "perps");
  if (derivation) return derivation;

  const home = purposeHome("perps");
  await mkdir(home, { recursive: true, mode: 0o700 });
  // The outgoing Perps grant (and its owner key) kept in the Perps home's own
  // archive, accounts/perps/grants/, best effort as Spot's is.
  const kept = await archiveCurrentGrant("perps");
  if (kept.kind === "failed") {
    console.error(`[grants] the outgoing Perps grant was NOT archived (${kept.why}) — replacing its grant.json anyway; its owner key is not in ~/.merrymen/accounts/perps/grants/`);
  }
  // Owner-only, synced and renamed in whole: the worker re-reads it every tick.
  await writeFileAtomic(localGrantFile("perps"), JSON.stringify(grant, null, 2), 0o600);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  // WHICH WALLET a permission replacement stops (?wallet=; absent is Spot). A
  // kill names none: it stops every wallet, and a request that names one for
  // it is refused as ambiguous, as an unqualified DELETE is (below).
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was deleted.");
  const walletNamed = new URL(req.url).searchParams.has(WALLET_PARAM);
  if (isHostedMode()) {
    // The kill switch is per-tenant and authenticated. It forgets the server's
    // session key; the wallet and its funds stay reachable via the owner key
    // the browser still holds (client-side recovery). Nothing to archive here
    // — the server never held the owner key to begin with.
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    // A tab can switch logins while the owner's stop request is in flight.
    const text = await readGrantBody(req, GRANT_DELETE_BODY_MAX_BYTES).catch(() => "");
    if (text === null) return NextResponse.json({ error: "That request is too large. Nothing was deleted." }, { status: 413 });
    let body: { expectedTenant?: unknown; purpose?: unknown; expectedAccount?: unknown; expectedSession?: unknown } | null;
    try { body = JSON.parse(text) as typeof body; } catch { body = null; }
    if (body?.expectedTenant !== undefined &&
        (typeof body.expectedTenant !== "string" || body.expectedTenant.toLowerCase() !== tenant.toLowerCase())) {
      return NextResponse.json({ error: "The signed-in account changed. Check the account before stopping it." }, { status: 409 });
    }
    // Old renewal tabs used an unqualified DELETE. Refuse that ambiguous
    // request instead of silently treating a permission update as a discard.
    if (body?.purpose !== "permission-replacement" && body?.purpose !== "delete-agent") {
      return NextResponse.json({ error: "Reload your wallet before stopping or renewing. Nothing was deleted.", ownerFacing: true }, { status: 400 });
    }
    if (body?.purpose === "permission-replacement") {
      // A PERPS RENEWAL IS REFUSED WHOLE, ITS FIRST STEP INCLUDED (decision D1).
      // A permission replacement exists only to be followed by the new grant's
      // POST, and while MERRYMEN_PERPS is not paper that POST is refused
      // (perpsCreationAllowed, above). Accepting the stop anyway would leave a
      // stopped Perps wallet nobody can renew until perps is back on: a refused
      // request that changed persistent state. So it is refused here, before
      // the store is asked anything. The kill (delete-agent, below) is not a
      // renewal and stays reachable whatever the lever says.
      if (wallet === "perps" && !perpsCreationAllowed()) return perpsRenewalNotOffered();
      if (!isAddr(body.expectedAccount) || (body.expectedSession !== undefined && !isAddr(body.expectedSession))) {
        return NextResponse.json({ error: "The permission being replaced could not be identified. Reload your wallet and try again." }, { status: 400 });
      }
      try {
        const state = await getGrantStore(wallet).stopForReplacement(tenant, body.expectedAccount, body.expectedSession);
        if (state === "changed") return NextResponse.json({ error: "Your permission changed in another tab. Reload your wallet before replacing it." }, { status: 409 });
        return NextResponse.json({ ok: true, replacement: true, state });
      } catch {
        return NextResponse.json({ error: "The service could not confirm the replacement stop. Your wallet was kept; try again.", ownerFacing: true }, { status: 503 });
      }
    }
    if (walletNamed) return killNamesWallet();
    // The Solana strategy and the Perps wallet are stopped whatever happens to the Robinhood
    // grant: a store that throws here still leaves the owner's autonomous Solana trading off and
    // their Perps grant revoked. Neither half waits on the other.
    let removal: unknown = null;
    try { await getGrantStore("spot").remove(tenant); } catch (e) { removal = e ?? new Error("grant removal failed"); }
    const solana = await solanaStopped(() => stopSolanaForKill(tenant));
    const perps = await perpsHalf(() => stopPerpsForKill(tenant));
    if (removal !== null) throw removal;
    return killed(solana, perps);
  }
  // A SELF-HOSTED RENEWAL STOPS THE WALLET IT NAMES, NOT THE OTHER ONE. Every
  // self-hosted DELETE has always removed grant.json, renewals too (the new grant
  // is posted straight after), so the body was never read. It is now, only so a
  // renewal leaves the other wallet's grant alone: neither wallet's authority
  // reaches the other. Anything but a readable permission replacement, an
  // unreadable or oversized body included, is the kill it always was. Read before
  // the wallet is judged: a renewal may name its wallet, as it may hosted, and
  // only a kill that names one is refused.
  let renewal = false;
  try {
    const text = await readGrantBody(req, GRANT_DELETE_BODY_MAX_BYTES);
    renewal = text !== null && (JSON.parse(text) as { purpose?: unknown } | null)?.purpose === "permission-replacement";
  } catch { /* a kill */ }
  if (walletNamed && !renewal) return killNamesWallet();
  // As hosted: the stop that begins a Perps renewal is refused with the renewal
  // while perps is not paper, before grant.json is archived or removed.
  if (renewal && wallet === "perps") return perpsCreationAllowed() ? selfHostedPerpsRenewalStop() : perpsRenewalNotOffered();
  // The kill switch destroys the session key, NOT the wallet — archived first.
  // The web's Start over removes it the same way, from /api/grants/discard.
  // The local Solana strategy and the local Perps wallet are stopped first, whatever happens to
  // the Robinhood grant: an archive it cannot write keeps grant.json (and pauses trading
  // instead), and must never leave autonomous Solana trading or a Perps grant behind a
  // "paused" answer.
  const solana = await solanaStopped(() => stopLocalSolanaForKill());
  const perps: PerpsHalf = renewal ? { state: "none" } : await perpsHalf(() => stopLocalPerpsForKill());
  try {
    await removeSelfHostedGrant("spot");
  } catch (e) {
    if (e instanceof GrantArchiveError) {
      return NextResponse.json({ error: `${e.message}${solana ? " Your Solana strategy was stopped." : " Your Solana strategy could not be stopped either: try the kill again."}${perpsAfterKeptGrant(perps)}`,
        paused: e.paused, solana: solana ? "stopped" : "not-stopped", ...(perps.state === "none" ? {} : { perps: perps.state }) }, { status: 409 });
    }
    throw e;
  }
  return killed(solana, perps);
}

/**
 * No Perps wallet is made or renewed on this server: MERRYMEN_PERPS is not
 * paper (perpsCreationAllowed). One that exists is still shown (GET) and
 * stopped by every kill; only a renewal, its first step included, is refused.
 *
 * THE SHARED REFUSAL (perps-enabled.ts perpsWalletRefused), as `walletUnknown`
 * is route-guard.ts's: this route kept copies of its own, which answered the
 * same refusal in another shape — a 400 with no `code` where /api/settings,
 * /api/orders and /api/paper-reset answer `wallet-unknown`, and a 403 without
 * `private, no-store` — so a client that reads the code read three routes
 * right and this one, the first the desk asks, wrong. One helper each, one
 * shape on every wallet-aware route; only the sentence is this route's.
 */
function perpsWalletNotOffered(nothing: string): NextResponse {
  return perpsWalletRefused(nothing);
}
/** The stop that begins a Perps renewal, refused with the renewal it begins (D1). */
function perpsRenewalNotOffered(): NextResponse {
  return perpsWalletNotOffered("Your Perps wallet cannot be renewed until they are, so its permission was not stopped. Nothing was changed; Kill all agents still stops it.");
}
/**
 * A self-hosted Perps renewal's first step, as hosted's stopForReplacement of the
 * Perps grant: the Perps home's grant.json archived, then removed. Nothing of the
 * Spot wallet's, or Solana's, is touched. The new Perps grant is posted straight
 * after (POST ?wallet=perps), which archives nothing more: this already kept it.
 */
async function selfHostedPerpsRenewalStop(): Promise<NextResponse> {
  // The grant alone: a renewal keeps the wallet trading, so its paper strategy stays as the owner set it.
  const perps = await perpsHalf(() => stopLocalPerpsGrantForRenewal());
  if (perps.state === "not-stopped") {
    return NextResponse.json(
      { error: `Your Perps wallet's permission could not be stopped for renewal.${perps.why ? ` ${perps.why}` : ""} Nothing else was changed; try again.`, ownerFacing: true },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, replacement: true, state: perps.state === "stopped" ? "stopped" : "absent" });
}

/** "Kill all agents" stops every wallet; a kill naming one is a client that means something else. */
function killNamesWallet(): NextResponse {
  return NextResponse.json(
    { error: "Kill all agents stops every wallet and cannot be aimed at one. Reload and try again. Nothing was deleted.", ownerFacing: true },
    { status: 400 },
  );
}

/**
 * "Kill all agents" stops autonomous Solana trading too: the strategy is turned
 * off with a revision bump that fences any admission already in flight. True
 * when it is off (or there was none), false when it could not be stopped.
 */
async function solanaStopped(stop: () => Promise<unknown>): Promise<boolean> {
  try { await stop(); return true; } catch { return false; }
}
/** What the Perps half did, said after a Robinhood grant the kill had to keep. */
function perpsAfterKeptGrant(perps: PerpsHalf): string {
  if (perps.state === "stopped") return " Your Perps wallet's grant was revoked.";
  if (perps.state === "not-stopped" && perps.left === "paper") return " Your Perps wallet's practice perpetuals could not be switched off: try the kill again.";
  if (perps.state === "not-stopped") return " Your Perps wallet's grant could not be revoked either: try the kill again.";
  return "";
}

/** What a failed Perps half left undone, as the kill's sentence names it. */
function perpsLeft(perps: PerpsHalf): string {
  return perps.left === "paper"
    ? "your Perps wallet's practice perpetuals could not be switched off yet"
    : "your Perps wallet's grant could not be revoked yet";
}
/**
 * A kill that could not stop the Solana strategy or revoke the Perps grant is reported
 * incomplete, never as done. A retry is safe. An owner with neither sees exactly what
 * they always saw.
 */
function killed(solana: boolean, perps: PerpsHalf): NextResponse {
  const perpsDown = perps.state === "not-stopped";
  if (!solana || perpsDown) {
    const what = !solana && perpsDown ? `your Solana strategy could not be stopped and ${perpsLeft(perps)}`
      : !solana ? "your Solana strategy could not be stopped yet" : perpsLeft(perps);
    return NextResponse.json({ error: `Kill incomplete: your Robinhood Chain agent is stopped, but ${what}.${perps.why ? ` ${perps.why}` : ""} Try the kill again.`,
      ownerFacing: true, solana: solana ? "stopped" : "not-stopped", ...(perps.state === "none" ? {} : { perps: perps.state }) }, { status: 503 });
  }
  return NextResponse.json(perps.state === "stopped" ? { ok: true, perps: "stopped" } : { ok: true });
}

/**
 * The tick this owner's worker runs on, which sets how long a silence has to
 * be before it means "stopped"; null when it cannot be read, and `freshWithin`
 * answers null with the default tick.
 *
 * READ FOR THE CALLER, as the orders route reads it: hosted, this container's
 * own settings are the house's and say nothing about this tenant's cadence;
 * self-hosted they are the worker's own. A failed read is the default, never
 * the house's tick — a shorter window from the wrong owner would call a healthy
 * agent stopped.
 */
async function tickSecondsFor(hostedTenant: `0x${string}` | null | undefined, wallet: GrantPurpose): Promise<number | null> {
  try {
    // THE WALLET'S OWN TICK. Hosted, each wallet's settings are its own store
    // (getSettingsStore(wallet)). Self-hosted, this process's settings are the
    // Spot worker's, and the Perps worker's are not read here: the default,
    // which is never shorter than one order's run (worker-stale.ts).
    const tick = hostedTenant ? (await getSettingsStore(wallet).get(hostedTenant))?.tickSeconds
      : wallet === "spot" ? resolveConfig().tickSeconds : null;
    return typeof tick === "number" && Number.isFinite(tick) && tick > 0 ? tick : null;
  } catch {
    return null;
  }
}

/**
 * EVERY GET ANSWER IS PER-USER AND NEVER STORED — `{exists:false}` included.
 * Next adds no Cache-Control to a dynamic route handler, so without this a
 * browser or proxy may keep one owner's status (their account, caps, balances)
 * on disk. Both wallets; the api/agents/[slug]/own precedent.
 */
function statusResponse(status: AgentStatus | PerpsWalletStatus): NextResponse {
  return NextResponse.json(status, { headers: NO_STORE_HEADERS });
}

export async function GET(req: Request) {
  // THE WALLET THE REQUEST NAMES, and only that one's: a Perps read is answered
  // from the Perps store, home and ledger and never with the Spot wallet's
  // status, nor the other way round. ANSWERED WHATEVER MERRYMEN_PERPS SAYS
  // (decision D1): an owner must always be able to see, and so stop, a Perps
  // wallet they hold, on a server that no longer makes them.
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was read.");
  let grant: StoredGrant;
  const hostedTenant = isHostedMode() ? tenantOf(req) : undefined;
  const perpsUnread = () => NextResponse.json(
    { error: "Couldn't read your Perps wallet. Please try again.", ownerFacing: true },
    { status: 503, headers: NO_STORE_HEADERS },
  );
  if (hostedTenant !== undefined) {
    if (!hostedTenant) return statusResponse({ exists: false, tenant: null });
    let g: StoredGrant | null;
    if (wallet === "spot") g = await getGrantStore("spot").get(hostedTenant);
    else {
      // Keyed on the verified tenant, as Spot's is. A store that cannot answer
      // is "could not read", never "no Perps wallet": that answer would hide
      // a wallet the owner may need to stop.
      try {
        g = await getGrantStore("perps").get(hostedTenant);
        // A RECORD THE STORE HOLDS BUT WILL NOT SHOW is not "no Perps
        // wallet" to the same-owner rule, which still holds a Spot grant to
        // it: said as `stored` (AgentStatus).
        if (!g && await getGrantStore("perps").hasStoredGrant(hostedTenant)) {
          return statusResponse({ exists: false, tenant: hostedTenant, stored: true });
        }
      } catch {
        return perpsUnread();
      }
    }
    if (!g) return statusResponse({ exists: false, tenant: hostedTenant });
    grant = g;
  } else {
    try {
      // A Perps file is read as the POST reads it (otherLocalWalletRefusal):
      // a leading BOM stripped, and only a file that is not there is "no
      // Perps wallet". One there that cannot be read or parsed is "could not
      // read", as hosted: the Wallet screen's restore asks this before it
      // stops anything, and the POST refuses that file after the stop.
      const text = await readFile(localGrantFile(wallet), "utf8");
      grant = JSON.parse(wallet === "perps" ? text.replace(/^\ufeff/, "") : text) as StoredGrant;
    } catch (e) {
      if (wallet === "perps" && (e as NodeJS.ErrnoException).code !== "ENOENT") return perpsUnread();
      return statusResponse({ exists: false });
    }
  }
  // A PERPS ANSWER IS ABOUT A PERPS GRANT. The store refuses to hand out the
  // other wallet's record; a self-hosted file is checked here, so a grant.json
  // in the Perps home that names Spot (or nothing it knows) is never shown as
  // the Perps wallet.
  if (wallet === "perps") {
    let named: GrantPurpose | null = null;
    try { named = grantPurpose(grant); } catch { /* names no wallet */ }
    if (named !== "perps") {
      return NextResponse.json(
        { error: "Your Perps wallet's permission could not be verified. Nothing was changed.", ownerFacing: true },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
  }

  const chain = chainForId(grant.chainId);
  const client = createPublicClient({ chain, transport: webChainRead() });

  // A READ THAT FAILED IS NULL, NOT ZERO — see grant-balances.ts. Zero here
  // is what told funded owners to "Add funds" whenever the node was slow. The
  // calls themselves live there too, where a test runs them against a client
  // that refuses.
  const balances = await readGrantBalancesFrom(client, grant.smartAccount);

  let workerAliveAt: number | null = null;
  let mode: AgentStatus["mode"] = null;
  let gasSponsored: boolean | null = null;
  let liveBlocker: string | null = null;
  let heartbeatRead = false;
  try {
    // Hosted status must come from this authenticated account, never a web-service file.
    if (hostedTenant !== undefined) throw new Error("Hosted heartbeat is account-scoped.");
    // Self-hosted, each wallet's worker beats in its own home.
    const hb = JSON.parse(await readFile(wallet === "spot" ? HEARTBEAT_FILE : path.join(purposeHome(wallet), "heartbeat.json"), "utf8")) as {
      at: number;
      mode?: AgentStatus["mode"];
      sponsorGas?: boolean;
    };
    workerAliveAt = hb.at;
    heartbeatRead = true;
    mode = hb.mode ?? null;
    // Absent on a heartbeat written before this field existed — unknown, not no.
    gasSponsored = hb.sponsorGas ?? null;
  } catch {
    // no heartbeat file — worker never ran, or (hosted) it beats somewhere
    // this process cannot see. Fall through to the ledger.
  }

  // HOSTED READS THE LEDGER, because the file above is in this service's own
  // MERRYMEN_HOME and the worker writes into its tenant's — different
  // directories, different containers. Every hosted tenant reported IDLE
  // regardless of what their agent was doing, which made the LIVE/PAPER chip
  // decorative exactly where it matters most.
  //
  // The file still wins when present: self-hosted it is the same worker on the
  // same disk, so it is fresher than a mirror that runs on its own clock.
  if (workerAliveAt === null) {
    try {
      const row = await withReadDb(async (db) =>
        db
          ? ((await db
              .prepare("SELECT mode, beat_at, sponsor_gas, live_blocker FROM agents WHERE smart_account = ?")
              .get(grant.smartAccount)) as
              | {
                  mode?: string | null;
                  beat_at?: number | null;
                  sponsor_gas?: number | null;
                  live_blocker?: string | null;
                }
              | undefined)
          : null,
        // The wallet's own ledger: self-hosted, a Perps worker writes its home's.
        wallet,
      );
      // undefined is a ledger that answered with no row; null is no ledger.
      if (row !== null) heartbeatRead = true;
      if (row?.beat_at) {
        workerAliveAt = Number(row.beat_at);
        mode = (row.mode as AgentStatus["mode"]) ?? null;
        // Nullable at the source, so distinguish 'has not said' from 'no'.
        gasSponsored =
          row.sponsor_gas === null || row.sponsor_gas === undefined ? null : Number(row.sponsor_gas) === 1;
        liveBlocker = row.live_blocker ?? null;
      }
    } catch {
      // an unreadable ledger is an unknown mode, not a claim about one
    }
  }

  // ENERGY IS READ ON ITS OWN, OUTSIDE THE BRANCH ABOVE. That branch runs only
  // when there is no heartbeat file, and self-hosted there always is one — so a
  // column read inside it would never reach a self-hosted owner at all. The
  // report is the child's own and lives only on the agents row, on both
  // deployments. Best effort: an unreadable report is null, never an error.
  // A Perps wallet has no energy to report: its wall carries no energy buy (D5).
  const energy = wallet === "spot" ? await readAgentEnergy(grant.smartAccount) : null;

  // AFTER BOTH HEARTBEAT SOURCES, so it judges whichever one answered: the
  // file self-hosted, the mirrored row hosted. See terminal/worker-stale.ts.
  // Never heard from is null whatever the tick, so that costs no settings read.
  const workerStale = workerAliveAt === null ? null
    : workerStaleOf(workerAliveAt, Math.floor(Date.now() / 1000), await tickSecondsFor(hostedTenant, wallet));

  let recovery: FleetRecoveryView | null = null;
  if (hostedTenant) {
    try {
      recovery = await withReadDb(db => {
        if (!db) throw new Error("Hosted recovery ledger is unavailable.");
        return readFleetRecoveryView(db,
          { tenant: hostedTenant, smartAccount: grant.smartAccount, chainId: grant.chainId }, workerAliveAt);
      }, wallet);
    } catch {
      return NextResponse.json({ error: "Couldn't confirm this agent's recovery status. Please try again.", ownerFacing: true }, { status: 503, headers: NO_STORE_HEADERS });
    }
  }

  // Never echo key material to the browser: the serialized session account, the
  // session key, AND the generated owner key (which custodies the funds).
  const { serialized: _s, demoSessionPrivateKey: _k, demoOwnerPrivateKey: _o, ...publicGrant } = grant;

  const status: AgentStatus = {
    exists: true,
    // From the verified cookie, never a browser-declared owner or grant field.
    ...(hostedTenant !== undefined ? { tenant: hostedTenant } : {}),
    grant: publicGrant,
    balances,
    workerAliveAt,
    ...(heartbeatRead ? {} : { heartbeatUnread: true as const }),
    workerStale,
    mode,
    gasSponsored,
    liveBlocker,
    energy,
    ...(hostedTenant ? { recovery } : {}),
  };
  if (wallet === "spot") return statusResponse(status);

  // ── THE PERPS WALLET'S ANSWER (PerpsWalletStatus) ───────────────────────
  //
  // THE GRANT THROUGH core's publicGrantView, AN ALLOWLIST, and only here
  // (decision D3): addresses, caps, times, markers and public keys, copied by
  // shape. Never the session key, the owner key, the serialized permission,
  // nor the binding's nonce, DID or signatures — a field nobody listed is
  // simply not shown. Spot keeps the denylist view above until its own client
  // stops needing the binding.
  //
  // THE BOOK AS ITS WORKER REPORTED IT (agent-perps.ts), from the Perps
  // account's own row, read outside the heartbeat branch for energy's reason.
  // Null is "not said or unreadable", never an empty book. Paper fields only:
  // nothing in this build reads a venue, a key, a stand-down or a recovery.
  const { grant: _denylisted, energy: _noEnergy, ...shared } = status;
  return statusResponse({ ...shared, grant: publicGrantView(grant), perps: await readAgentPerps(grant.smartAccount) });
}
