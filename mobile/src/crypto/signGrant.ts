import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  GRANT_V4,
  GRANT_V4_ADAPTER,
  GRANT_PONS_ADAPTER,
  GRANT_PONS_CLASS,
  resolveClassVault,
  TRADEABLE_V2,
  buildWallPolicies,
  buildCallPermissions,
  wallShape,
  wallSignable,
  WALL_POLICY_FLAG,
  robinhoodChain,
  usableExtraTokens,
  officialCoinTokens,
  ponsAdapterForSigning,
  assertDerivedAccount,
  type CustomToken,
  type GrantCaps,
  type StoredGrant,
} from "@merrymen/core";
import { accountFromMnemonic } from "./mnemonic";
import { isMock } from "@/net/api";

/**
 * Sign a grant on the phone.
 *
 * THE ONE RULE: the owner key never leaves this device. It is derived from the
 * mnemonic in memory, used to build the sudo validator, and dropped. What comes
 * out is a serialized SESSION account — capped on-chain, self-expiring, revocable
 * — and that is the only thing safe to hand to a server.
 *
 * This deliberately does NOT mirror the dashboard's session.ts, which puts
 * `demoOwnerPrivateKey` on the grant object and POSTs the whole thing to
 * /api/grants. On a self-hosted install that is a localhost round trip to a 0600
 * file on the same machine, so it is not a leak. From a phone talking to a hosted
 * API it would upload the owner key to someone else's server, which would make the
 * product's central claim false. So the field is simply absent here.
 *
 * The policy set itself comes from packages/core so the phone and the dashboard
 * sign the IDENTICAL wall — see packages/core/src/wall.ts, pinned by
 * worker/src/wall.test.ts.
 */

export type SignProgress = (step: string) => void;

export interface SignedGrant {
  /** Safe to transmit: capped, expiring, and useless outside its policies. */
  grant: Omit<StoredGrant, "demoOwnerPrivateKey">;
  /** The session key, which the worker needs in order to act. Not the owner key. */
  sessionPrivateKey: `0x${string}`;
}

export async function signGrant(args: {
  mnemonic: string;
  caps: GrantCaps;
  extraTokens?: readonly CustomToken[];
  /**
   * The deployed V4SelfSwap adapter to seal into the wall, or absent for no
   * v4 route. The phone has no /settings fetch wired yet, so onboarding
   * passes nothing and phone grants honestly carry no adapter marker — the
   * lockstep rule: the marker is minted by the permission, never ahead of it.
   */
  v4AdapterAddress?: `0x${string}`;
  /**
   * The deployed PonsSelfTrade adapter to seal into the wall, or absent for no
   * bonding-curve route. A SECOND, SEPARATE opt-in from the v4 adapter. Like
   * its sibling above, the phone passes nothing today, so phone grants
   * honestly carry no Pons marker -- the marker is minted by the permission,
   * never ahead of it.
   */
  ponsAdapterAddress?: `0x${string}`;
  /**
   * The deployed PonsClassVaultFactory, or absent for no class route.
   *
   * A FACTORY, NOT A VAULT. The vault is per-account, salted with the smart
   * account this call is about to derive, so nobody upstream could name it.
   * Resolved below from the account, by the same core helper the dashboard
   * calls — two signers, one vault. Like its two siblings above, the phone
   * passes nothing today, so phone grants honestly carry no class marker.
   */
  ponsClassVaultFactory?: `0x${string}`;
  rpcUrl?: string;
  onProgress?: SignProgress;
}): Promise<SignedGrant> {
  // A DEMO BUILD MUST NOT MINT A FUNDABLE ACCOUNT.
  //
  // `isMock` used to gate only what the screens DISPLAY — the feed and the
  // Telegram card. It never reached here, and there is no testnet path: the
  // chain below is Robinhood Chain 4663, mainnet, unconditionally. So a demo
  // build generated a real key, derived a real mainnet smart account, showed
  // the owner its address, and then reported a portfolio that was entirely
  // invented. Anyone who funded that address had put real money somewhere the
  // app was lying about, with one small chip as the only warning.
  //
  // The guard lives at the signing chokepoint rather than on the screen,
  // because the screen is reachable by deep link (`merrymen://onboarding/grant`)
  // and a UI-only check would be routed around rather than enforced.
  //
  // Deliberately NOT applied to recovery: sweeping funds out is the escape
  // hatch, and blocking it would strand anyone who reached this state before
  // the guard existed. Close the trap, keep the exit.
  if (isMock) {
    throw new Error(
      "This is a demo build — it reads generated data, so it will not sign a real permission wall. " +
        "Install a build configured for your own agent to do that.",
    );
  }

  const say = args.onProgress ?? (() => {});
  const chain = robinhoodChain;
  const publicClient = createPublicClient({
    chain,
    transport: http(args.rpcUrl ?? chain.rpcUrls.default.http[0]),
  });
  const entryPoint = getEntryPoint("0.7");

  say("deriving your key");
  const ownerAccount = accountFromMnemonic(args.mnemonic);

  say("building the sudo validator");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  say("minting a session key");
  const sessionPrivateKey = generatePrivateKey();
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(sessionPrivateKey) });

  // The address BEFORE the wall, because the wall pins value to it. The Kernel
  // address derives from the sudo validator alone — the permission plugin is
  // enabled at UserOp time and does not affect it — so this is knowable now,
  // and asserted identical below.
  say("deriving your account");
  const sudoOnlyAccount = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });

  // BEFORE THE WALL PINS VALUE TO IT. createKernelAccount resolves this with a
  // live getSenderAddress eth_call and answers the zero address, without
  // throwing, when the Kernel factory does not respond on this chain. The wall
  // below would then pin its swap recipient and vault receiver to zero, the
  // assertion further down would be satisfied by two zeros, and the phone would
  // seal a grant for an account nobody owns. Identical guard to
  // web/src/lib/session.ts - the two signers must refuse the same things.
  assertDerivedAccount(sudoOnlyAccount.address, "the smart account could not be derived");

  say("assembling the wall");
  // Uniswap v4 is OFF — see WallOptions.allowUniswapV4. Kept in lockstep with
  // the GRANT_V4 marker below, and identical to web/src/lib/session.ts: the
  // phone and the dashboard must seal the same wall or the worker cannot tell
  // what a signature actually carries.
  const allowUniswapV4: boolean = false;

  // THE CLASS VAULT, from the account derived immediately above — its owner and
  // its CREATE2 salt, so this is the first moment the address exists to be
  // asked for. Throws rather than falling back if the factory cannot be read;
  // identical helper, identical refusal, on both signers.
  let ponsClassVaultAddress: `0x${string}` | undefined;
  if (args.ponsClassVaultFactory) {
    say("locating your class vault");
    ponsClassVaultAddress = await resolveClassVault(
      publicClient,
      args.ponsClassVaultFactory,
      sudoOnlyAccount.address,
    );
  }

  /**
   * The platform's official listings, plus whatever the caller passed, plus the
   * chain's deployed Pons adapter when the caller named none.
   *
   * THE PHONE NEEDS THIS MORE THAN THE BROWSER DOES, not less. The web signer
   * can at least read /settings; this file's own note records that "the phone
   * passes nothing today, so phone grants honestly carry no Pons marker", and
   * `onboarding/grant.tsx` passes three fields with no tokens and no adapter. So
   * without a default resolved HERE, a phone-signed grant can never reach a
   * curve — and the owner's only symptom is an agent that never trades when the
   * equity market is shut.
   *
   * Both defaults are signing-time only. The worker trades whatever address the
   * signature sealed, never the constant.
   */
  const sealedTokens = [...officialCoinTokens(chain.id), ...(args.extraTokens ?? [])];
  const sealedPonsAdapter = ponsAdapterForSigning(chain.id, args.ponsAdapterAddress);

  const wallOpts = {
    extraTokens: sealedTokens,
    allowUniswapV4,
    v4AdapterAddress: args.v4AdapterAddress,
    ponsAdapterAddress: sealedPonsAdapter,
    ponsClassVaultAddress,
    // Rides with the vault. buildWallPolicies THROWS on a vault without a
    // factory — two of three class permissions is a key that can reach a vault
    // it can never create, and a CALL to a codeless address succeeds silently.
    ponsClassVaultFactoryAddress: args.ponsClassVaultFactory,
  };

  // CAN THIS WALL EVER BE INSTALLED? The same question the other signer asks,
  // through the same function, over the same permission objects — because a cap
  // only one signer enforces is not a cap. Both signers already move in lockstep
  // on what they MINT (signer-lockstep.test.ts); this is the same rule applied
  // to what they REFUSE.
  const signable = wallSignable(wallShape(buildCallPermissions(args.caps, sudoOnlyAccount.address, wallOpts)));
  if (!signable.ok) throw new Error(signable.why);

  const { policies, now, expiresAt } = buildWallPolicies({
    caps: args.caps,
    smartAccount: sudoOnlyAccount.address,
    ...wallOpts,
  });

  say("attaching the permissions");
  const permissionValidator = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    signer: sessionSigner,
    policies,
    // Execute, but never sign — the same flag the dashboard signs with. Both
    // read it from core so the two signers cannot drift, exactly like the
    // permission list itself. See WALL_POLICY_FLAG in packages/core/src/wall.ts.
    flag: WALL_POLICY_FLAG,
  });

  say("deriving the smart account");
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator, regular: permissionValidator },
  });

  // Same premise check the dashboard makes: the wall's recipient pins are only
  // correct while the permission plugin leaves the address alone. Fail before
  // sealing, never after.
  assertDerivedAccount(account.address, "the permissioned account could not be derived");
  if (account.address.toLowerCase() !== sudoOnlyAccount.address.toLowerCase()) {
    throw new Error(
      `refusing to sign: the permission plugin changed the account address ` +
        `(${sudoOnlyAccount.address} → ${account.address}), so the wall's recipient pins are wrong.`,
    );
  }

  say("signing");
  const serialized = await serializePermissionAccount(account, sessionPrivateKey);

  return {
    grant: {
      smartAccount: account.address,
      // The owner's ADDRESS, which is public. Not the key.
      owner: ownerAccount.address,
      sessionKeyAddress: sessionSigner.account.address,
      serialized,
      caps: args.caps,
      grantedAt: now,
      expiresAt,
      chainId: chain.id,
      // Tells the worker what this signature actually carries, rather than
      // letting it infer capabilities from a constant that may have moved since.
      // Kept in step with web/src/lib/session.ts — two signers, one wall.
      // No "transfer": this signer registers no withdrawal address either, so
      // the wall carries no transfer permission and claiming one would make the
      // off-chain mirror looser than the chain. See the note in session.ts.
      grantFeatures: [
        TRADEABLE_V2,
        ...(allowUniswapV4 ? [GRANT_V4] : []),
        ...(args.v4AdapterAddress ? [GRANT_V4_ADAPTER] : []),
        ...(sealedPonsAdapter ? [GRANT_PONS_ADAPTER] : []),
        // From the RESOLVED VAULT, never from `args.ponsClassVaultFactory` —
        // the factory is the request, the vault address is the evidence. See
        // the same line in web/src/lib/session.ts.
        ...(ponsClassVaultAddress ? [GRANT_PONS_CLASS] : []),
      ],
      ...(args.v4AdapterAddress ? { v4AdapterAddress: args.v4AdapterAddress.toLowerCase() } : {}),
      ...(sealedPonsAdapter ? { ponsAdapterAddress: sealedPonsAdapter.toLowerCase() } : {}),
      ...(ponsClassVaultAddress
        ? {
            ponsClassVaultAddress: ponsClassVaultAddress.toLowerCase(),
            // Both, or the worker has a marker and a vault it cannot create.
            ponsClassVaultFactoryAddress: args.ponsClassVaultFactory!.toLowerCase(),
          }
        : {}),
      grantTokens: usableExtraTokens(sealedTokens).map((t) => t.address.toLowerCase()),
      demoSessionPrivateKey: sessionPrivateKey,
    },
    sessionPrivateKey,
  };
}
