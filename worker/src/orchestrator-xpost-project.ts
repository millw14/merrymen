/** A public, creator-published description for one ledger-verified token. Read only. */
import { createPublicClient, http, type PublicClient } from "viem";
import { readTokenMeta, sanitizeMeta } from "./venues/pons-meta";

export interface PublicProjectDescription {
  token: string;
  chainId: number;
  description: string;
}

type Dependencies = { client: PublicClient; readMeta: typeof readTokenMeta; budgetMs: number };
const MAINNET = 4663;
const BUDGET_MS = 3000;

/** No ticker lookup, websites, owner instructions or private trading reason. */
export async function readPublicProjectDescription(
  token: string,
  chainId: number,
  overrides: Partial<Dependencies> = {},
): Promise<PublicProjectDescription | null> {
  if (chainId !== MAINNET || !/^0x[0-9a-fA-F]{40}$/.test(token) || /^0x0{40}$/i.test(token)) return null;
  const address = token.toLowerCase() as `0x${string}`;
  const client = overrides.client ?? createPublicClient({ transport: http(process.env.MERRYMEN_RPC_MAINNET ?? "https://rpc.mainnet.chain.robinhood.com", { timeout: 1200, retryCount: 0 }) });
  const readMeta = overrides.readMeta ?? readTokenMeta;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        if (await client.getChainId() !== chainId) return null;
        const meta = (await readMeta(client, [address])).get(address);
        if (!meta || meta.token.toLowerCase() !== address) return null;
        const description = sanitizeMeta(meta.description.normalize("NFKC"), 180).replace(/[«»]/g, " ").trim();
        // Keep the writer's existing no-figures/no-addresses input boundary.
        if (!description || /\p{N}|https?:|www\.|[@#]/u.test(description)) return null;
        return { token: address, chainId, description };
      })().catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), overrides.budgetMs ?? BUDGET_MS); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
