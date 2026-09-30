import { keccak256, stringToHex, type Address, type Hex } from "viem";

export interface PartnerEnrollmentSettings {
  name: string;
  strategy: "steady-basket" | "llm-strategist";
  basket_symbols: string[];
  live_trading_enabled: boolean;
}
export interface PartnerEnrollmentClaim {
  v: 1;
  app_id: string;
  app_name: string;
  agent_id: string;
  external_user_id: string;
  owner: Address;
  smart_account: Address;
  chain_id: number;
  grant_hash: Hex;
  settings: PartnerEnrollmentSettings;
  scopes: string[];
  nonce: string;
  expires_at: number;
}

/** Stable JSON shared by browsers and the runtime; rejects non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Expected a JSON value");
}

export function partnerGrantDigest(grant: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(grant)));
}

/** The owner signs both app consent and the exact grant/settings being installed. */
export function partnerEnrollmentMessage(claim: PartnerEnrollmentClaim): string {
  return [
    "Authorize my Merryman in another app",
    "",
    `App: ${JSON.stringify(claim.app_name)} (${claim.app_id})`,
    `App user: ${JSON.stringify(claim.external_user_id)}`,
    `Merryman: ${claim.agent_id}`,
    `Owner: ${claim.owner.toLowerCase()}`,
    `Agent wallet: ${claim.smart_account.toLowerCase()}`,
    `Chain ID: ${claim.chain_id}`,
    `Permission grant hash: ${claim.grant_hash}`,
    `Settings: ${canonicalJson(claim.settings)}`,
    `App access: ${claim.scopes.join(", ")}`,
    "",
    "I authorize this app to view my agent's status and, if listed above, chat using my private portfolio and trading history.",
    "I authorize Merrymen to install this signed session permission and run my agent within it. My owner key stays in my wallet.",
    claim.settings.live_trading_enabled
      ? "LIVE TRADING: I authorize automatic trading with real funds under this permission."
      : "PAPER TRADING: simulated fills only; this authorization does not enable real trading.",
    `Expires: ${claim.expires_at}`,
    `Nonce: ${claim.nonce}`,
  ].join("\n");
}
