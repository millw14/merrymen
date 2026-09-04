import { useState } from "react";

export function Deposit({ onBack }: { onBack: () => void }) {
  const [amt, setAmt] = useState("100");
  const [done, setDone] = useState(false);

  return (
    <div className="sheet">
      <button type="button" className="back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <label className="amt">
        <span>$</span>
        <input
          inputMode="decimal"
          value={amt}
          onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))}
          aria-label="Amount"
        />
      </label>
      {done ? (
        <p className="meta">On the way.</p>
      ) : (
        <button type="button" className="fund solid full" onClick={() => setDone(true)}>
          Send
        </button>
      )}
    </div>
  );
}
