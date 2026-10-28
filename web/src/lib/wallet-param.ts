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
