/**
 * Dev-mode grant handoff + agent status.
 * POST: browser saves a signed grant → .data/grant.json (worker picks it up).
 * GET: full agent status — grant, live balances from the grant chain, worker heartbeat.
 * DELETE: discard the grant file (localStorage cleared client-side).
 * Replaced by Supabase (encrypted, per-user) once persistence lands.
 */

import { webChainRead } from "@/lib/chain-read";
import { readGrantBalancesFrom, type GrantBalances } from "@/lib/grant-balances";
import { mkdir, readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { writeFileAtomic } from "@merrymen/atomic-write";
import { homePaths, merrymenHome } from "@merrymen/home";
import { createPublicClient } from "viem";
import {
  accountsMatch,
  carriesOwnerKey,
  chainForId,
  derivationUnreachable,
  duplicateWallPermissions,
  isHostedMode,
  type Derivation,
  type EnergyStatus,
  type StoredGrant,
} from "@merrymen/core";
import { requestOrigin, tenantOf, verifyGrantBinding } from "@/lib/auth";
import { checkCanonicalWall } from "@/lib/canonical-wall";
import { privyTokenOf, verifyPrivyToken } from "@/lib/privy";
import { withReadDb } from "@/lib/ledger";
import { readAgentEnergy } from "@/lib/agent-energy";
import { getGrantStore } from "@merrymen/grant-store";
import { getIdentityStore } from "@merrymen/identity-store";
import { getSettingsStore } from "@merrymen/settings-store";
import { ledgerHasAgent, mintAndNameAgent } from "@/lib/first-name";
import { deriveKernelAccountAddress } from "@/lib/derive-account";
import { archiveCurrentGrant, GrantArchiveError, removeSelfHostedGrant } from "@/lib/grant-archive";

const DATA_DIR = merrymenHome();
const GRANT_FILE = homePaths.grant();
const HEARTBEAT_FILE = homePaths.heartbeat();

/** A well-formed 0x EVM address. The archive (lib/grant-archive.ts) keeps its own
 * copy of this check, since it builds a filename from the address. */
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

export interface AgentStatus {
  exists: boolean;
  /** Hosted GET only: the authenticated tenant this status was read for. */
  tenant?: `0x${string}` | null;
  grant?: Omit<StoredGrant, "serialized" | "demoSessionPrivateKey" | "demoOwnerPrivateKey">;
  /** Decimal strings as read from the chain; null for any read that failed. */
  balances?: GrantBalances;
  workerAliveAt?: number | null;
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

export async function POST(req: Request) {
  const grant = (await req.json()) as StoredGrant;
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
    const wall = checkCanonicalWall(grant as unknown as Record<string, unknown>);
    if (!wall.ok) {
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
    try {
      const holder = await getGrantStore().tenantForAccount(grant.smartAccount);
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
    let derived: Derivation;
    try {
      derived = await deriveKernelAccountAddress(grant.owner as `0x${string}`, grant.chainId);
    } catch (e) {
      derived = derivationUnreachable(e instanceof Error ? e.message : String(e));
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

    // Persist to the per-tenant store, keyed on the authenticated tenant. The
    // store seals the session key at rest and refuses (again, defence in depth)
    // any grant carrying an owner key or whose owner isn't this tenant.
    try {
      await getGrantStore().put(tenant, grant);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "store failed" }, { status: 500 });
    }

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
        get: () => getSettingsStore().get(tenant),
        put: (s) => getSettingsStore().put(tenant, s),
      },
      ledgerHasAgent: (account) => ledgerHasAgent(withReadDb, account),
    });
    return NextResponse.json({ ok: true });
  }

  await mkdir(DATA_DIR, { recursive: true });
  // Keep the outgoing wallet (and its owner key) before this one replaces it.
  //
  // BEST-EFFORT, deliberately: archiving must never block arming a grant. A
  // failure is said loudly, because the grant it failed to keep is about to be
  // replaced.
  const kept = await archiveCurrentGrant();
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

export async function DELETE(req: Request) {
  if (isHostedMode()) {
    // The kill switch is per-tenant and authenticated. It forgets the server's
    // session key; the wallet and its funds stay reachable via the owner key
    // the browser still holds (client-side recovery). Nothing to archive here
    // — the server never held the owner key to begin with.
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    // A tab can switch logins while the owner's stop request is in flight.
    const body = await req.json().catch(() => null) as { expectedTenant?: unknown } | null;
    if (body?.expectedTenant !== undefined &&
        (typeof body.expectedTenant !== "string" || body.expectedTenant.toLowerCase() !== tenant.toLowerCase())) {
      return NextResponse.json({ error: "The signed-in account changed. Check the account before stopping it." }, { status: 409 });
    }
    await getGrantStore().remove(tenant);
    return NextResponse.json({ ok: true });
  }
  // The kill switch destroys the session key, NOT the wallet — archived first.
  // The web's Start over removes it the same way, from /api/grants/discard.
  try {
    await removeSelfHostedGrant();
  } catch (e) {
    if (e instanceof GrantArchiveError) return NextResponse.json({ error: e.message, paused: e.paused }, { status: 409 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  let grant: StoredGrant;
  const hostedTenant = isHostedMode() ? tenantOf(req) : undefined;
  if (hostedTenant !== undefined) {
    if (!hostedTenant) return NextResponse.json({ exists: false, tenant: null } satisfies AgentStatus);
    const g = await getGrantStore().get(hostedTenant);
    if (!g) return NextResponse.json({ exists: false, tenant: hostedTenant } satisfies AgentStatus);
    grant = g;
  } else {
    try {
      grant = JSON.parse(await readFile(GRANT_FILE, "utf8")) as StoredGrant;
    } catch {
      return NextResponse.json({ exists: false } satisfies AgentStatus);
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
  try {
    const hb = JSON.parse(await readFile(HEARTBEAT_FILE, "utf8")) as {
      at: number;
      mode?: AgentStatus["mode"];
      sponsorGas?: boolean;
    };
    workerAliveAt = hb.at;
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
          : undefined,
      );
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
  const energy = await readAgentEnergy(grant.smartAccount);

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
    mode,
    gasSponsored,
    liveBlocker,
    energy,
  };
  return NextResponse.json(status);
}
