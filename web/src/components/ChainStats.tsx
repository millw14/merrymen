"use client";

import { useEffect, useState } from "react";

const RPC = "https://rpc.mainnet.chain.robinhood.com";

async function rpc(method: string): Promise<string | null> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    });
    const j = await res.json();
    return typeof j.result === "string" ? j.result : null;
  } catch {
    return null;
  }
}

export function ChainStats() {
  const [block, setBlock] = useState<string>("—");
  const [gas, setGas] = useState<string>("—");

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [b, g] = await Promise.all([rpc("eth_blockNumber"), rpc("eth_gasPrice")]);
      if (!alive) return;
      if (b) setBlock(parseInt(b, 16).toLocaleString());
      if (g) setGas(`${(parseInt(g, 16) / 1e9).toFixed(3)} gwei`);
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="topstats">
      <span>
        block <b>{block}</b>
      </span>
      <span>
        gas <b>{gas}</b>
      </span>
    </div>
  );
}
