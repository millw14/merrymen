/**
 * THE RECOVERY RELAY — owner withdrawal and permission-revocation submission.
 *
 * Hosted, the browser can SIGN a withdrawal but cannot SUBMIT one: the Pimlico
 * key is a house secret, and `pimlicoBundlerUrl` and `pimlicoPaymasterUrl` are
 * the byte-identical string, so handing it to a browser would hand out
 * house-sponsored gas along with it. This route closes that gap by adding the
 * key server-side and forwarding only withdrawals and exact self-revocations.
 *
 * The engine needs no changes: `recoverFunds` takes `bundlerUrl` as an opaque
 * string, so the browser passes `${origin}/api/bundler/4663` and everything else
 * is the code the CLI already runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR GATES, and the third is the one that matters
 *
 * 1. METHOD ALLOWLIST, deny by default.
 * 2. THE TICKET names WHOSE account may be relayed; `userOp.sender` must equal
 *    it. See recovery-ticket.ts for what that does and does not prove.
 * 3. THE OPERATION MUST BE A WITHDRAWAL OR A SINGLE SELF invalidateNonce CALL. Validating method, sender, entryPoint
 *    and paymaster fields never looks at what the operation DOES — without
 *    isRecoveryShape, any ticket holder could push swaps, approvals or arbitrary
 *    contract calls through app.merrymen.dev as a free transaction service on
 *    the house's bundler account. This is the gate that makes the file's first
 *    sentence true.
 * 4. SPONSORSHIP requires verified historical enrollment, a house policy, the
 *    canonical owner deployment, bounded gas and an actual owner signature on
 *    submission. Client-supplied paymaster policies are never forwarded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* DONE HERE
 *
 * carriesOwnerKey is NOT run on this body, and that is not an oversight. Its
 * RAW_KEY pattern matches any bare 32-byte hex value anywhere in the payload,
 * and a userOpHash is exactly 0x + 64 hex — so every receipt poll would 4xx, the
 * sweep would succeed on chain, and the panel would report a failure on a
 * withdrawal that already moved the money. The stronger guard is the typed
 * schema below: the only accepted fields are a method string, a userOp with a
 * known key set, an entryPoint address and a 32-byte hash. There is no field an
 * owner key could ride in. carriesOwnerKey stays where it belongs, on grant
 * intake.
 *
 * THE UPSTREAM URL IS NEVER ECHOED. viem embeds the full request URL — query
 * string included — in its error metaMessages, which is precisely how a Pimlico
 * key leaks into an error toast. Failures are mapped to {code, message} and
 * scrubbed.
 */

import { NextResponse } from "next/server";
import { pimlicoBundlerUrl, robinhoodChain, robinhoodTestnet, ENTRYPOINT } from "@merrymen/core";
import { readTicket } from "@/lib/recovery-ticket";
import { isRecoveryShape, isPermissionRevocationShape } from "@/lib/recovery-shape";
import { ownerOperationProblem, ownerSignatureValid, ownerSponsorshipStatus, paymasterResult, sponsoredOperationProblem } from "@/lib/owner-sponsorship";
import { getOwnerSponsorshipStore, ownerQuoteDigest } from "@/lib/owner-sponsorship-store";

export const runtime = "nodejs";

/** Everything a withdrawal needs, and nothing else. */
const ALLOWED = new Set([
  "eth_chainId",
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_sendUserOperation",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  // Not optional: the fee oracle exists so the bundler accepts the fees it
  // quoted itself. Without it the send is rejected for underpriced gas.
  "pimlico_getUserOperationGasPrice",
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
]);

/** The two methods that carry an operation, and therefore need it inspected. */
const PM_METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);
const OP_METHODS = new Set(["eth_estimateUserOperationGas", "eth_sendUserOperation", ...PM_METHODS]);

const KNOWN_CHAINS = new Set<number>([robinhoodChain.id, robinhoodTestnet.id]);
const MAX_BODY = 32 * 1024;

/**
 * IS THERE ACTUALLY A PAYMASTER, or just a field set to zero?
 *
 * The first version refused any of these fields that was not undefined, null,
 * "0x" or "" — which is wrong, because a client with NO paymaster still emits
 * the gas-limit fields as `0x0`. A zero gas limit is not sponsorship; it is the
 * absence of it, spelled out. That refusal turned a perfectly good withdrawal
 * into a 403 and cost a user their first attempt.
 *
 * So each field is judged by what it actually means:
 *   paymaster            — an ADDRESS. Absent, or the zero address, means none.
 *   paymasterData        — BYTES. Empty means none.
 *   paymasterAndData     — the packed 0.6-era form. Empty means none.
 *   *GasLimit            — NUMBERS. Zero means none.
 *
 * Real paymaster fields require the additional sponsorship gates below.
 */
function paymasterOn(op: Record<string, unknown>): string | null {
  const empty = (v: unknown) =>
    v === undefined || v === null || v === "" || v === "0x";
  const zeroNum = (v: unknown) => {
    if (empty(v)) return true;
    try {
      return BigInt(v as string | number | bigint) === 0n;
    } catch {
      return false; // unparseable is not provably zero — treat as present
    }
  };
  const addr = op.paymaster;
  if (!empty(addr) && !/^0x0{40}$/i.test(String(addr))) return "paymaster";
  for (const f of ["paymasterData", "paymasterAndData"] as const) {
    if (!empty(op[f])) return f;
  }
  for (const f of ["paymasterVerificationGasLimit", "paymasterPostOpGasLimit"] as const) {
    if (!zeroNum(op[f])) return f;
  }
  return null;
}

function scrub(s: string): string {
  let out = s.replace(/apikey=[^&\s"']+/gi, "apikey=<redacted>").replace(/api\.pimlico\.io\S*/gi, "<bundler>");
  for (const secret of [process.env.MERRYMEN_BUNDLER_API_KEY, process.env.MERRYMEN_SPONSORSHIP_POLICY_ID]) {
    if (secret) out = out.split(secret).join("<redacted>");
  }
  return out;
}

/**
 * REFUSE IN THE PROTOCOL THE CALLER IS SPEAKING.
 *
 * This returned HTTP 4xx with a JSON body, and viem collapsed every one of
 * them to `HTTP request failed` — so a user watching their own withdrawal fail
 * saw a transport error and no reason, and the server logged nothing at all. I
 * was blind to my own gate.
 *
 * A JSON-RPC endpoint should answer with a JSON-RPC error: viem then surfaces
 * `message` the same way it surfaces a bundler's own rejection, which is
 * exactly what this is. HTTP status stays 200 because the HTTP request
 * succeeded — it is the CALL that was refused.
 *
 * Codes are in the JSON-RPC application range (-32000 block), which is what a
 * bundler uses for its own refusals.
 *
 * -32099 AND NOT -32001, WHICH SWALLOWED THE REASON. viem maps the low codes to
 * its own error classes with FIXED text: -32001 becomes ResourceNotFoundRpcError,
 * whose message is "Requested resource not found." So a class-vault sweep that
 * this relay refused for a precise, stated reason reached the owner as a
 * four-word string about a missing resource, and diagnosing it took a decode of
 * the callData and a read of this file.
 *
 * -32099 is inside the same implementation-defined range and is mapped by
 * nothing, so the message written here is the message the caller sees. A
 * refusal that cannot say why is barely better than a hang.
 */
function refuse(id: unknown, message: string, code = -32_099) {
  // Logged so the next failure is diagnosable from the server rather than from
  // a screenshot of a phone.
  console.warn(`[relay] refused: ${message}`);
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? 1, error: { code, message } });
}

/** For the few failures that really are transport-level. */
const bad = (status: number, message: string) => NextResponse.json({ error: message }, { status });

const requestTicket = (req: Request) => readTicket(req.headers.get("cookie")?.match(/(?:^|;\s*)merrymen_recovery=([^;]+)/)?.[1]);

async function reserveQuote(owner: string, op: Record<string, unknown>, chainId: number): Promise<string | null> {
  try {
    return await getOwnerSponsorshipStore().reserve(owner, ownerQuoteDigest(op, chainId))
      ? null : "this owner's daily sponsored recovery allowance is exhausted; retry after the UTC day resets";
  } catch { return "the owner gas budget could not be reserved; retry before continuing"; }
}

export async function GET(req: Request, ctx: { params: Promise<{ chainId: string }> }) {
  const chainId = Number((await ctx.params).chainId);
  if (!KNOWN_CHAINS.has(chainId)) return bad(400, "unknown chain");
  const ticket = requestTicket(req);
  if (!ticket || ticket.chainId !== chainId) return bad(401, "sign a recovery challenge for this account and chain first");
  return NextResponse.json(await ownerSponsorshipStatus(ticket), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ chainId: string }> }) {
  const chainId = Number((await ctx.params).chainId);
  if (!KNOWN_CHAINS.has(chainId)) return bad(400, "unknown chain");

  // From the cookie the ticket route set. A header would need the browser to
  // reach inside viem's transport to add one, which means patching global
  // fetch — not something to do around a money path.
  const ticket = requestTicket(req);
  if (!ticket) return bad(401, "no valid recovery ticket — sign the challenge first");
  if (ticket.chainId !== chainId) return bad(401, "this ticket is for a different chain");

  const raw = await req.text();
  if (raw.length > MAX_BODY) return bad(413, "request too large");

  let rpc: { method?: unknown; params?: unknown; id?: unknown };
  try {
    rpc = JSON.parse(raw) as typeof rpc;
  } catch {
    return bad(400, "malformed request");
  }
  // A batch would let one allowed request fan out into N upstream calls.
  if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) return bad(400, "batched or non-object requests are not relayed");

  const method = typeof rpc.method === "string" ? rpc.method : "";
  if (!ALLOWED.has(method)) {
    return refuse(rpc.id, `this relay does not forward ${method || "that method"}`);
  }

  let params = Array.isArray(rpc.params) ? rpc.params : [];
  const isPaymaster = PM_METHODS.has(method);

  if (OP_METHODS.has(method)) {
    const op = params[0] as Record<string, unknown> | undefined;
    if (!op || typeof op !== "object" || Array.isArray(op)) return refuse(rpc.id, "missing user operation");
    if (params.length !== (isPaymaster ? 4 : 2)) return refuse(rpc.id, "unexpected operation parameters");
    const malformed = ownerOperationProblem(op, false);
    if (malformed) return refuse(rpc.id, malformed);

    const sender = typeof op.sender === "string" ? op.sender.toLowerCase() : "";
    if (sender !== ticket.smartAccount.toLowerCase()) {
      return refuse(rpc.id, "this ticket does not cover that account");
    }

    const entryPoint = typeof params[1] === "string" ? params[1].toLowerCase() : "";
    if (entryPoint !== ENTRYPOINT.v07.toLowerCase()) {
      return refuse(rpc.id, `only EntryPoint v0.7 is relayed, not ${entryPoint || "(none given)"}`);
    }

    const callData = typeof op.callData === "string" ? (op.callData as `0x${string}`) : "0x";
    const shape = isRecoveryShape(callData, { classVaults: ticket.classVaults });
    if (!shape.ok && !isPermissionRevocationShape(callData, ticket.smartAccount)) {
      return refuse(rpc.id, `this relay only carries withdrawals or permission revocation for your own account — ${shape.why}`);
    }

    if (isPaymaster || paymasterOn(op)) {
      const status = await ownerSponsorshipStatus(ticket);
      if (!status.gasSponsored) return refuse(rpc.id, status.reason ?? "owner gas sponsorship is unavailable");
      const problem = sponsoredOperationProblem(op, ticket, method === "eth_sendUserOperation");
      if (problem) return refuse(rpc.id, problem);
      if (method === "eth_sendUserOperation" && !(await ownerSignatureValid(op, ticket))) {
        return refuse(rpc.id, "the sponsored operation needs this owner's signature over its final fields");
      }
      if (isPaymaster) {
        if (typeof params[2] !== "string" || !/^0x[0-9a-f]+$/i.test(params[2]) || BigInt(params[2]) !== BigInt(chainId)) {
          return refuse(rpc.id, "paymaster chain does not match the recovery ticket");
        }
        // The house policy is mandatory, server-held, and cannot be overridden
        // by browser context (including token-paymaster or alternate-policy modes).
        params = [op, ENTRYPOINT.v07, `0x${chainId.toString(16)}`, { sponsorshipPolicyId: process.env.MERRYMEN_SPONSORSHIP_POLICY_ID!.trim() }];
      }
    }
  } else if (method === "eth_getUserOperationReceipt" || method === "eth_getUserOperationByHash") {
    if (params.length !== 1 || typeof params[0] !== "string" || !/^0x[0-9a-f]{64}$/i.test(params[0])) return refuse(rpc.id, "expected one user operation hash");
  } else if (params.length !== 0) {
    return refuse(rpc.id, "unexpected RPC parameters");
  }

  const key = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!key) return bad(503, "this deployment has no bundler configured");

  // A final paymaster authorization can be submitted through another bundler.
  // Reserve before issuing it, not just before this relay's send. Timeouts and
  // all other uncertain outcomes keep the reservation; an exact retry reuses it.
  if (method === "pm_getPaymasterData") {
    const refusal = await reserveQuote(ticket.sponsorship!.owner, params[0] as Record<string, unknown>, chainId);
    if (refusal) return refuse(rpc.id, refusal);
  }

  let upstream: Response;
  try {
    upstream = await fetch(pimlicoBundlerUrl(chainId, key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Rebuilt from validated fields — never the caller's raw bytes, so
      // nothing unexamined is forwarded.
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return bad(502, scrub(`the bundler did not answer: ${e instanceof Error ? e.message : String(e)}`));
  }

  const text = await upstream.text();
  if (isPaymaster && upstream.ok) {
    let envelope: { result?: unknown; error?: unknown };
    try { envelope = JSON.parse(text); } catch { return refuse(rpc.id, "the gas sponsor returned an unreadable quote"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return refuse(rpc.id, "the gas sponsor returned an unreadable quote");
    if (!envelope.error) {
      const result = paymasterResult(envelope.result, method === "pm_getPaymasterStubData");
      if (!result) return refuse(rpc.id, "the gas sponsor returned an invalid or excessive quote");
      // isFinal belongs to the paymaster response, never to a UserOperation.
      const combined = { ...(params[0] as Record<string, unknown>), ...result };
      delete combined.isFinal;
      const bounded = sponsoredOperationProblem(combined, ticket, false);
      if (bounded) return refuse(rpc.id, bounded);
      // ERC-7677 allows a stub to declare itself final. That response is already
      // spendable via another bundler, so it needs a reservation before release.
      if (method === "pm_getPaymasterStubData" && (envelope.result as { isFinal?: unknown }).isFinal === true) {
        const refusal = await reserveQuote(ticket.sponsorship!.owner, combined, chainId);
        if (refusal) return refuse(rpc.id, refusal);
      }
      return NextResponse.json({ jsonrpc: "2.0", id: rpc.id ?? 1, result });
    }
  }
  if (!upstream.ok || text.includes('"error"')) {
    console.warn(`[relay] ${method} -> ${upstream.status} ${scrub(text).slice(0, 300)}`);
  } else {
    console.log(`[relay] ${method} -> ok`);
  }
  // Pass the JSON-RPC envelope through so viem can read a result or an error
  // normally — but scrubbed, because an upstream error can quote the URL.
  return new NextResponse(scrub(text), {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
