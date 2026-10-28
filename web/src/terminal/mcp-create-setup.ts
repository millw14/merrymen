import { AGENT_NAME_RE, DEFAULT_BASKET_SYMBOLS, RISK_PROFILES, STOCK_TOKENS, normalizeAgentName } from "@merrymen/core";
import { requestJson, RequestError, UNREACHABLE } from "./request-json";

const ID = /^prp_[0-9a-f]{32}$/;
const STRATEGIES = new Set(["steady-basket", "weekend-gap", "llm-strategist", "trencher", "even-keel", "dip-hunter"]);
const STOCK_SYMBOLS = new Set(STOCK_TOKENS.map(token => token.symbol.toUpperCase()));
const RISK_KEYS = ["strategistStopLossBps", "takeProfitBps", "buyPerTickUsdg", "llmMaxActionUsdg", "slippageBps"] as const;
const KEYS = new Set<string>(["agentName", "strategy", "basketSymbols", "assetMode", ...RISK_KEYS]);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export interface McpCreateSetup {
  id: string;
  owner: string;
  requestedBy: string;
  expiresAt: number;
  name: string;
  strategy: string;
  assetMode: "all" | "stocks" | "crypto";
  basket: string[];
  riskLevel: string | null;
  riskSettings: Record<string, number>;
}

/** Display data only. A pending review must pass approveMcpCreateSetup before it can be used to create a wallet. */
export interface McpCreateReview extends McpCreateSetup {
  status: "awaiting_approval" | "applied";
  bindingHash: string;
}

export function mcpSetupRequest(search: string): { id: string | null; invalid: boolean } {
  const ids = new URLSearchParams(search).getAll("proposal");
  return ids.length === 0 ? { id: null, invalid: false }
    : ids.length === 1 && ID.test(ids[0]!) ? { id: ids[0]!, invalid: false }
      : { id: null, invalid: true };
}

export async function loadMcpCreateSetup(id:string,owner:string):Promise<McpCreateSetup> {
  return approvedMcpSetup(await readMcpCreateSetup(id),id,owner);
}

export async function loadMcpCreateReview(id:string,owner:string):Promise<McpCreateReview> {
  return reviewMcpCreateSetup(await readMcpCreateSetup(id),id,owner);
}

async function readMcpCreateSetup(id:string):Promise<unknown> {
  try {
    return await requestJson<unknown>(`/api/mcp/approvals/${encodeURIComponent(id)}`);
  } catch(e) {
    if(e instanceof RequestError){
      if(e.status===401)throw new Error("Sign in again to continue your Merryman setup.");
      if(e.status===403||e.status===404)throw new Error("This setup is no longer available to your signed-in account or assistant connection. Return to your assistant to reconnect and prepare a fresh setup.");
      if(e.status===410)throw new Error("This approved setup expired. Ask your assistant for a fresh setup.");
    }
    throw e;
  }
}

function sameReview(current:McpCreateReview,review:McpCreateReview):void {
  if(current.bindingHash!==review.bindingHash)throw new Error("This setup changed. Reload and review it again before signing.");
}

/** This API uses OAuth-style error descriptions; preserve its bounded owner-facing explanation. */
async function decideMcpCreateRequest(review:McpCreateReview,decision:"approve"|"reject"):Promise<unknown> {
  let response:Response;
  try{
    response=await fetch(`/api/mcp/approvals/${encodeURIComponent(review.id)}`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({decision,hash:review.bindingHash}),
      credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(20_000),
    });
  }catch{throw new RequestError(UNREACHABLE,0);}
  const data:unknown=await response.json().catch(()=>null);
  if(!response.ok){
    const description=object(data)?.error_description;
    throw new RequestError(typeof description==="string"&&description.trim()?description.slice(0,600):`Could not ${decision==="approve"?"approve":"decline"} this setup (${response.status}). Try again.`,response.status);
  }
  return data;
}

/** Called only by an explicit owner action, never by a loader or render effect. */
export async function approveMcpCreateSetup(review:McpCreateReview):Promise<McpCreateReview> {
  let current=await loadMcpCreateReview(review.id,review.owner);
  sameReview(current,review);
  if(current.status==="awaiting_approval"){
    const result=await decideMcpCreateRequest(review,"approve");
    // A successful HTTP response alone is not an approval. Check its actual
    // owner-bound, applied creation result before allowing any further work.
    approvedMcpSetup(result,review.id,review.owner);
    sameReview(reviewMcpCreateSetup(result,review.id,review.owner),review);
    // Recheck connection standing after the decision, as the existing setup
    // handoff did. A revoked connection may not progress to signing.
    current=await loadMcpCreateReview(review.id,review.owner);
    sameReview(current,review);
  }
  if(current.status!=="applied")throw new Error("Your setup is not approved yet. Review it again before signing.");
  return current;
}

export async function declineMcpCreateSetup(review:McpCreateReview):Promise<void> {
  const current=await loadMcpCreateReview(review.id,review.owner);
  sameReview(current,review);
  if(current.status!=="awaiting_approval")throw new Error("This setup has already been decided. Reload to check its status.");
  const result=object(await decideMcpCreateRequest(review,"reject"));
  if(result?.id!==review.id||result.status!=="rejected"||result.binding_hash!==review.bindingHash)throw new Error("Could not confirm your decline. Reload to check its status.");
}

/** A pending proposal may be displayed alongside limits, but grants no authority. */
export function reviewMcpCreateSetup(value:unknown,id:string,owner:string,nowMs=Date.now()):McpCreateReview {
  const v=object(value);
  if(!v||(v.status!=="awaiting_approval"&&v.status!=="applied")||typeof v.binding_hash!=="string"||!/^[0-9a-f]{64}$/.test(v.binding_hash))throw new Error("This setup is not available for review. Return to your assistant for a fresh setup.");
  const setup=v.status==="applied"?approvedMcpSetup(value,id,owner,nowMs):setupFields(value,id,owner,nowMs);
  return {...setup,status:v.status,bindingHash:v.binding_hash};
}

/** Only the owner-authenticated approval response can supply a setup. URL fields never supply settings. */
export function approvedMcpSetup(value: unknown, id: string, owner: string, nowMs = Date.now()): McpCreateSetup {
  const v=object(value);
  if(v?.status!=="applied"||object(v.result)?.setup_only!==true)throw new Error("This setup is not approved for your current account, or it has expired. Return to your assistant for a new setup.");
  return setupFields(value,id,owner,nowMs);
}

function setupFields(value:unknown,id:string,owner:string,nowMs:number):McpCreateSetup {
  const v = object(value);
  const b = object(v?.binding);
  const s = object(b?.settings);
  const refused = () => new Error("This setup is not approved for your current account, or it has expired. Return to your assistant for a new setup.");
  if (!ID.test(id) || v?.id !== id || v.kind !== "agent_draft" || b?.purpose !== "create") throw refused();
  if (!/^0x[0-9a-f]{40}$/i.test(owner) || typeof b.tenant !== "string" || b.tenant.toLowerCase() !== owner.toLowerCase()) throw refused();
  if (typeof v.expires_at !== "number" || !Number.isFinite(v.expires_at) || v.expires_at * 1000 <= nowMs || b.expires_at !== v.expires_at) throw refused();
  if (!s || Object.keys(s).some(key => !KEYS.has(key))) throw refused();
  if (typeof s.agentName !== "string" || normalizeAgentName(s.agentName) !== s.agentName || !AGENT_NAME_RE.test(s.agentName)) throw refused();
  if (typeof s.strategy !== "string" || !STRATEGIES.has(s.strategy)) throw refused();
  if (s.assetMode !== undefined && !["all", "stocks", "crypto"].includes(String(s.assetMode))) throw refused();
  if (s.basketSymbols !== undefined && (!Array.isArray(s.basketSymbols) || s.basketSymbols.length < 1 || s.basketSymbols.length > 10 || s.basketSymbols.some(x => typeof x !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._$-]{0,15}$/.test(x)))) throw refused();
  // Older approved drafts can omit their basket. The stock default would be
  // excluded by crypto-only mode, and this handoff skips market selection.
  // Custom-token membership remains the owner approval's responsibility.
  if (s.strategy !== "trencher" && s.assetMode === "crypto" && (!Array.isArray(s.basketSymbols) || s.basketSymbols.every(symbol => STOCK_SYMBOLS.has(symbol.toUpperCase())))) {
    throw new Error("Crypto-only setup needs an explicit basket containing at least one crypto token. Return to your assistant to choose a crypto basket or another asset mode and prepare a fresh setup.");
  }
  const level = b.risk_level;
  if (level !== null && level !== "careful" && level !== "balanced" && level !== "bold") throw refused();
  const riskSettings: Record<string, number> = {};
  for (const key of RISK_KEYS) {
    if (s[key] === undefined) continue;
    if (!level || s[key] !== RISK_PROFILES[level].settings[key]) throw refused();
    riskSettings[key] = s[key] as number;
  }
  return {
    id, owner: owner.toLowerCase(), requestedBy: typeof v.requested_by === "string" ? v.requested_by : "your assistant",
    expiresAt: v.expires_at, name: s.agentName, strategy: s.strategy,
    assetMode: s.strategy === "trencher" ? "crypto" : (s.assetMode as McpCreateSetup["assetMode"] | undefined) ?? "all",
    basket: s.strategy === "trencher" ? [] : (s.basketSymbols as string[] | undefined) ?? [...DEFAULT_BASKET_SYMBOLS],
    riskLevel: level, riskSettings,
  };
}
