/**
 * Document CSP. A fresh nonce authorizes Next's bootstrap and our locale boot
 * script; strict-dynamic carries that trust to chunks and the Stripe SDK they
 * load. Production permits neither arbitrary inline scripts nor eval.
 *
 * Inline styles remain necessary for React and Privy's styled components.
 * HTTPS connections remain open for owner-selected RPC/bundler providers; this
 * policy is a script execution boundary, not a complete data-egress allowlist.
 * Local installs also support owner-configured HTTP RPCs and websocket URLs.
 */
export function documentPolicy(nonce: string, options: { development: boolean; hosted: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https: wss:${!options.hosted || options.development ? " http: ws:" : ""}`,
    "frame-src 'self' https://auth.privy.io https://*.privy.io https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
