import { readWalletParam } from "../lib/wallet-param";

/** A malformed wallet selector never opens the default Spot mutation screen. */
export function terminalWallet(pathname: string, search: string): "spot" | "perps" | "invalid" {
  if (pathname === "/perps") return "perps";
  const params = new URLSearchParams(search);
  if (pathname === "/create") {
    const wallet = readWalletParam({ url: `https://terminal.invalid${pathname}?${params}` });
    if (wallet === null) return "invalid";
    const values = params.getAll("for");
    if ([...params.keys()].some(key => key.toLowerCase() === "for" && key !== "for")) return "invalid";
    if (values.length > 1 || values.length === 1 && values[0] !== "perps" && values[0] !== "spot") return "invalid";
    if (values[0] && params.has("wallet") && values[0] !== wallet) return "invalid";
    if (values[0] === "perps") return "perps";
  }
  if (["/settings", "/grant", "/withdraw", "/deposit", "/create"].includes(pathname)) {
    return readWalletParam({ url: `https://terminal.invalid${pathname}?${params}` }) ?? "invalid";
  }
  return "spot";
}
