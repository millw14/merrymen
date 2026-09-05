import { createPublicClient, http } from "viem";
import { robinhoodChain, robinhoodTestnet, PONS_SELFTRADE_ABI } from "@merrymen/core";

export async function verifiedAdapter(
  address: `0x${string}` | undefined,
  chainId: number,
  onStatus: (s: string) => void,
): Promise<`0x${string}` | undefined> {
  if (!address) return undefined;
  onStatus("checking the curve adapter before sealing it…");
  const chain = chainId === robinhoodTestnet.id ? robinhoodTestnet : robinhoodChain;
  const client = createPublicClient({ chain, transport: http() });

  let code: string;
  try {
    code = (await client.getCode({ address })) ?? "0x";
  } catch (e) {
    throw new Error(
      `Could not check the curve adapter ${address} on ${chain.name}: ${
        e instanceof Error ? e.message : String(e)
      }. Refusing to seal an address nobody has verified — it would become an approved spender for every token in this grant.`,
    );
  }
  if (!code || code === "0x") {
    throw new Error(
      `No contract at ${address} on ${chain.name}. That is usually an address from the other chain, ` +
        `a typo, or a deploy that never happened. Sealing it would make it an approved spender for every ` +
        `token in this grant, so nothing is signed. Fix it at /settings and try again.`,
    );
  }

  // SHAPE CHECK. A live contract at the right address on the right chain can
  // still be the wrong contract entirely, and check 1 cannot tell.
  try {
    await client.readContract({
      address,
      abi: PONS_SELFTRADE_ABI,
      functionName: "tradeExactIn",
      args: [
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        0n,
        0n,
        0n,
      ],
    });
  } catch (e) {
    // A REVERT IS A PASS. The call is deliberately invalid — zero addresses, zero
    // amount, a deadline in 1970 — so the real adapter MUST reject it. What we
    // are testing is that it rejected it as that function rather than failing to
    // find one. viem reports a missing function differently from a revert, and
    // only the former disqualifies the address.
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|not found|returned no data|function.*selector/i.test(msg)) {
      throw new Error(
        `The contract at ${address} on ${chain.name} is not a PonsSelfTrade adapter — it has no ` +
          `tradeExactIn function. Sealing it would make the wrong contract an approved spender for every ` +
          `token in this grant, so nothing is signed.`,
      );
    }
  }

  onStatus("curve adapter verified.");
  return address;
}
