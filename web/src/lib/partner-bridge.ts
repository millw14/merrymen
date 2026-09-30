import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface PartnerPrincipal {
  app_id: string;
  key_id: string;
  name: string;
  scopes: string[];
}
export class PartnerError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const SCOPES = new Set(["read:agents", "read:theses", "read:market", "read:book", "read:trades", "write:agents", "chat:agents"]);

/** A short-lived signature over the exact method, path, principal and raw body.
 * The app never trusts a client-supplied wallet, cookie or partner id here. */
export async function verifyPartnerRequest(req: Request, rawBody: string, path: string, options: {
  secret?: string;
  now?: number;
  consumeNonce: (nonce: string, expiresAt: number) => Promise<boolean>;
}): Promise<PartnerPrincipal> {
  const secret = options.secret ?? process.env.MERRYMEN_PARTNER_BRIDGE_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new PartnerError(503, "upstream_unavailable", "Partner runtime is not configured");
  const encoded = req.headers.get("x-merrymen-partner-context") ?? "";
  const signature = req.headers.get("x-merrymen-partner-signature") ?? "";
  const refused = () => new PartnerError(401, "unauthorized", "Invalid gateway request");
  if (!encoded || encoded.length > 2048 || !/^[a-zA-Z0-9_-]+$/.test(encoded) || !/^[a-f0-9]{64}$/.test(signature)) throw refused();
  const digest = createHash("sha256").update(rawBody).digest("hex");
  const expected = createHmac("sha256", secret).update(`${req.method}\n${path}\n${encoded}\n${digest}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw refused();
  let value: PartnerPrincipal & { v: number; iat: number; nonce: string };
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw refused(); }
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (!value || value.v !== 1 || !/^[a-zA-Z0-9_-]{12,64}$/.test(value.app_id) ||
      !/^[0-9a-hjkmnp-tv-z]{12}$/.test(value.key_id) || typeof value.name !== "string" || value.name.length > 64 ||
      !Array.isArray(value.scopes) || value.scopes.length > SCOPES.size || value.scopes.some(s => !SCOPES.has(s)) ||
      !Number.isSafeInteger(value.iat) || Math.abs(now - value.iat) > 60 || !/^[a-f0-9]{36}$/.test(value.nonce)) throw refused();
  if (!await options.consumeNonce(value.nonce, value.iat + 61)) throw new PartnerError(401, "unauthorized", "Gateway request expired or already used");
  return { app_id: value.app_id, key_id: value.key_id, name: value.name, scopes: value.scopes };
}

export function requirePartnerScope(partner: PartnerPrincipal, scope: string): void {
  if (!partner.scopes.includes(scope)) throw new PartnerError(403, "forbidden_scope", `This key does not carry ${scope}`);
}

export async function readPartnerBody(req: Request, limit = 32_768): Promise<string> {
  if (Number(req.headers.get("content-length")) > limit) throw new PartnerError(413, "bad_request", "Request body is too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new PartnerError(413, "bad_request", "Request body is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export function objectBody(raw: string): Record<string, unknown> {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new PartnerError(400, "bad_request", "Body must be JSON"); }
  if (!body || Array.isArray(body) || typeof body !== "object") throw new PartnerError(400, "bad_request", "Body must be an object");
  return body as Record<string, unknown>;
}

export function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new PartnerError(400, "bad_request", "Body contains unsupported fields");
}

export function partnerAppOrigin(): string {
  const u = new URL(process.env.MERRYMEN_PUBLIC_ORIGIN || "https://app.merrymen.dev");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("Invalid app origin");
  return u.origin;
}
