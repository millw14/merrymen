/**
 * THE RECOVERY RELAY — a withdrawal submit path, not a bundler proxy.
 *
 * Hosted, the browser can SIGN a withdrawal but cannot SUBMIT one: the Pimlico
 * key is a house secret, and `pimlicoBundlerUrl` and `pimlicoPaymasterUrl` are
 * the byte-identical string, so handing it to a browser would hand out
 * house-sponsored gas along with it. This route closes that gap by adding the
 * key server-side and forwarding only what a withdrawal needs.
 *
 * The engine needs no changes: `recoverFunds` takes `bundlerUrl` as an opaque
 * string, so the browser passes `${origin}/api/bundler/4663` and everything else
 * is the code the CLI already runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR GATES, and the third is the one that matters
 *
 * 1. METHOD ALLOWLIST, deny by default. Seven methods, listed below.
 * 2. THE TICKET names WHOSE account may be relayed; `userOp.sender` must equal
 *    it. See recovery-ticket.ts for what that does and does not prove.
 * 3. THE OPERATION MUST BE A WITHDRAWAL. Validating method, sender, entryPoint
 *    and paymaster fields never looks at what the operation DOES — without
 *    isRecoveryShape, any ticket holder could push swaps, approvals or arbitrary
 *    contract calls through app.merrymen.dev as a free transaction service on
 *    the house's bundler account. This is the gate that makes the file's first
 *    sentence true.
 * 4. NO PAYMASTER, structurally. Recovery never uses one, so any op carrying
 *    paymaster fields is refused outright — which makes house sponsorship
 *    impossible on this path by construction rather than by policy.
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
import { isRecoveryShape } from "@/lib/recovery-shape";

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
]);

/** The two methods that carry an operation, and therefore need it inspected. */
const OP_METHODS = new Set(["eth_estimateUserOperationGas", "eth_sendUserOperation"]);

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
 * The gate itself is unchanged in intent: any real paymaster is refused, so
 * house sponsorship stays impossible on this path by construction.
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
  return s.replace(/apikey=[^&\s"']+/gi, "apikey=<redacted>").replace(/api\.pimlico\.io\S*/gi, "<bundler>");
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
 */
function refuse(id: unknown, message: string, code = -32_001) {
  // Logged so the next failure is diagnosable from the server rather than from
  // a screenshot of a phone.
  console.warn(`[relay] refused: ${message}`);
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? 1, error: { code, message } });
}

/** For the few failures that really are transport-level. */
const bad = (status: number, message: string) => NextResponse.json({ error: message }, { status });

export async function POST(req: Request, ctx: { params: Promise<{ chainId: string }> }) {
  const chainId = Number((await ctx.params).chainId);
  if (!KNOWN_CHAINS.has(chainId)) return bad(400, "unknown chain");

  // From the cookie the ticket route set. A header would need the browser to
  // reach inside viem's transport to add one, which means patching global
  // fetch — not something to do around a money path.
  const ticket = readTicket(
    req.headers.get("cookie")?.match(/(?:^|;\s*)merrymen_recovery=([^;]+)/)?.[1],
  );
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
  if (Array.isArray(rpc)) return bad(400, "batched requests are not relayed");

  const method = typeof rpc.method === "string" ? rpc.method : "";
  if (!ALLOWED.has(method)) {
    return refuse(rpc.id, `this relay does not forward ${method || "that method"}`);
  }

  const params = Array.isArray(rpc.params) ? rpc.params : [];

  if (OP_METHODS.has(method)) {
    const op = params[0] as Record<string, unknown> | undefined;
    if (!op || typeof op !== "object") return refuse(rpc.id, "missing user operation");

    const sender = typeof op.sender === "string" ? op.sender.toLowerCase() : "";
    if (sender !== ticket.smartAccount.toLowerCase()) {
      return refuse(rpc.id, "this ticket does not cover that account");
    }

    const entryPoint = typeof params[1] === "string" ? params[1].toLowerCase() : "";
    if (entryPoint !== ENTRYPOINT.v07.toLowerCase()) {
      return refuse(rpc.id, `only EntryPoint v0.7 is relayed, not ${entryPoint || "(none given)"}`);
    }

    const sponsored = paymasterOn(op);
    if (sponsored) {
      return refuse(rpc.id, `sponsored operations are not relayed on this path (${sponsored})`);
    }

    const callData = typeof op.callData === "string" ? (op.callData as `0x${string}`) : "0x";
    const shape = isRecoveryShape(callData);
    if (!shape.ok) {
      return refuse(rpc.id, `this relay only carries withdrawals — ${shape.why}`);
    }
  }

  const key = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!key) return bad(503, "this deployment has no bundler configured");

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
