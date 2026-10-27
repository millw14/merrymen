import { isGrantPurpose, type GrantPurpose } from "@merrymen/core";

/**
 * WHICH OF A LOGIN'S TWO WALLETS A REQUEST IS ABOUT: `?wallet=spot|perps`.
 *
 * ABSENT IS SPOT, so every client written before Perps keeps reaching the
 * account it always reached. A value that names no wallet, an empty one, or
 * more than one is null, and the route refuses it rather than guessing.
 *
 * NOT `?purpose=`, the perps branch's name for it. DELETE /api/grants already
 * reads `purpose` from its body, for what a stop is for (`delete-agent`,
 * `permission-replacement`), and one word meaning two things is how a stop
 * meant for one wallet lands on the other.
 */
export const WALLET_PARAM = "wallet";

export function readWalletParam(req: Pick<Request, "url">): GrantPurpose | null {
  const values = new URL(req.url).searchParams.getAll(WALLET_PARAM);
  if (values.length === 0) return "spot";
  return values.length === 1 && isGrantPurpose(values[0]) ? values[0] : null;
}

/**
 * THE ONE WAY A CLIENT NAMES A WALLET IN A URL: `walletUrl("/api/x", wallet)`.
 *
 * SPOT LEAVES THE URL EXACTLY AS IT WAS, byte for byte, so every request a Spot
 * screen makes is the request it made before Perps existed (absent is Spot,
 * readWalletParam). Perps adds `wallet=perps`, beside any query the URL
 * already carries and in place of any `wallet=` it already names, so a URL can
 * never name two wallets (which readWalletParam refuses).
 *
 * Here and not built by hand at each call site, because a hand-built `?` on a
 * URL that already has a query, or a `wallet=` set twice, is a request for no
 * wallet at all. And NOT `?purpose=`: see WALLET_PARAM.
 *
 * A path stays a path (a client's `/api/...`); an absolute URL stays absolute.
 */
export function walletUrl(url: string, wallet: GrantPurpose): string {
  if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
  if (wallet === "spot") return url;
  const base = "http://wallet-url.invalid";
  const parsed = new URL(url, base);
  parsed.searchParams.set(WALLET_PARAM, wallet);
  return parsed.origin === base ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href;
}
