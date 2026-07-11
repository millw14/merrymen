/** Grant shapes shared by web (issuer) and worker (consumer). */

export interface GrantCaps {
  perTradeUsdg: number;
  dailyUsdg: number;
  expiryDays: number;
  maxDrawdownPct: number;
  maxOpsPerDay: number;
}

export interface StoredGrant {
  smartAccount: `0x${string}`;
  owner: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  /** ZeroDev serialized permission account — everything the worker needs to act. */
  serialized: string;
  caps: GrantCaps;
  grantedAt: number;
  expiresAt: number;
  chainId: number;
  /** TESTNET ONLY — production signers live in a TEE, never serialized. */
  demoSessionPrivateKey: `0x${string}`;
  /**
   * TESTNET ONLY — the generated owner key that controls the account. When the
   * wallet is created in-browser (no external wallet connected) this is the ONLY
   * way to recover funds, so the UI forces the user to back it up before
   * funding. Absent when an external wallet (MetaMask) was the owner.
   */
  demoOwnerPrivateKey?: `0x${string}`;
}
