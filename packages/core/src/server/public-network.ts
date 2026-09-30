/** Node-only outbound transport. Do not export this through the client core barrel. */
import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { IncomingMessage } from "node:http";
import { isPublicAddress, safeFetchUrl } from "../safe-url";

export type Address = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<Address[]>;
const systemLookup: Lookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** The optional resolver is a test seam; URLs can never select the resolver. */
export async function resolvePublicAddress(url: URL, resolve: Lookup = systemLookup): Promise<Address> {
  if (!safeFetchUrl(url.href)) throw new Error("refused outbound URL");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolve(hostname);
  if (!addresses.length || addresses.some((a) => !isIP(a.address) || !isPublicAddress(a.address))) {
    throw new Error("refused non-public DNS answer");
  }
  return addresses[0]!;
}

/** The TCP destination is an IP; TLS identity and HTTP Host remain the URL host. */
export function pinnedHttpsOptions(url: URL, address: Address, signal: AbortSignal): RequestOptions {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return {
    protocol: "https:", hostname: address.address, family: address.family,
    port: url.port || 443, path: `${url.pathname}${url.search}`, method: "GET",
    agent: false, signal, rejectUnauthorized: true,
    servername: isIP(hostname) ? "" : hostname,
    checkServerIdentity: (_host, cert) => checkServerIdentity(hostname, cert),
    headers: { host: url.host, "accept-encoding": "identity", "user-agent": "merrymen-image-proxy" },
  };
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    // Attach a rejection handler even when cancellation already happened: DNS
    // itself cannot be cancelled and may still reject after its caller leaves.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  accept?: (response: IncomingMessage) => boolean;
}
export interface PublicFetchDependencies {
  lookup?: Lookup;
  request?: typeof httpsRequest;
}

/** Follow validated redirects, pin every dial, and stop reading at the byte cap. */
export async function fetchPublicHttps(raw: string | URL, options: PublicFetchOptions, deps: PublicFetchDependencies = {}) {
  let url = safeFetchUrl(String(raw));
  if (!url) throw new Error("refused outbound URL");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("invalid byte cap");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("outbound request timed out")), options.timeoutMs);
  const { signal } = controller;
  try {
    for (let redirects = 0; ; redirects++) {
      const address = await abortable(resolvePublicAddress(url, deps.lookup), signal);
      signal.throwIfAborted();
      const current = url;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = (deps.request ?? httpsRequest)(pinnedHttpsOptions(current, address, signal), resolve);
        req.once("error", reject);
        req.end();
      });
      try {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (redirects >= (options.maxRedirects ?? 4) || !response.headers.location) throw new Error("invalid redirect");
          const next = safeFetchUrl(new URL(response.headers.location, current).href);
          if (!next) throw new Error("refused redirect URL");
          url = next;
          continue;
        }
        if (options.accept && !options.accept(response)) throw new Error("refused response");
        // Refuse an origin that ignores identity encoding, so the byte cap also
        // bounds the body the downstream consumer decodes.
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding.toLowerCase() !== "identity") throw new Error("refused content encoding");
        const declared = response.headers["content-length"];
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > options.maxBytes)) throw new Error("response too large");
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > options.maxBytes) throw new Error("response too large");
          chunks.push(bytes);
        }
        return { status, headers: response.headers, body: Buffer.concat(chunks, length), url: current };
      } finally {
        response.destroy();
      }
    }
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
