/** Local wallet discovery. A file in one wallet home cannot select the other wallet. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
export async function recoveryWallets(home) {
  const wallets = [], unread = [], seen = new Set();
  for (const purpose of ["spot", "perps"]) {
    const walletHome = purpose === "spot" ? home : path.join(home, "accounts", "perps");
    const read = async (file, active) => {
      try {
        const g = JSON.parse(await readFile(file, "utf8"));
        const actual = g?.purpose === undefined ? "spot" : g.purpose;
        if (actual !== purpose || !/^0x[0-9a-fA-F]{40}$/.test(g?.smartAccount ?? "") ||
            !Number.isSafeInteger(g?.chainId) || g.chainId <= 0) throw new Error("invalid wallet");
        const id = `${purpose}:${g.chainId}:${g.smartAccount.toLowerCase()}`;
        if (!seen.has(id)) { seen.add(id); wallets.push({ g, purpose, home: walletHome, active }); }
      } catch (e) { if (e?.code !== "ENOENT") unread.push({ purpose, file }); }
    };
    await read(path.join(walletHome, "grant.json"), true);
    const archive = path.join(walletHome, "grants");
    try {
      for (const entry of (await readdir(archive)).sort()) if (entry.endsWith(".json")) await read(path.join(archive, entry), false);
    } catch (e) { if (e?.code !== "ENOENT") unread.push({ purpose, file: archive }); }
  }
  return { wallets, unread };
}
