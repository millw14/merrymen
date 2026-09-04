import { useState } from "react";

export function Limits({
  perTrade,
  perDay,
  onSave,
  onBack,
}: {
  perTrade: string;
  perDay: string;
  onSave: (trade: string, day: string) => void;
  onBack: () => void;
}) {
  const [trade, setTrade] = useState(perTrade);
  const [day, setDay] = useState(perDay);

  return (
    <div className="sheet">
      <button type="button" className="back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <label className="amt sm">
        <span>$</span>
        <input
          inputMode="decimal"
          value={trade}
          onChange={(e) => setTrade(e.target.value.replace(/[^\d.]/g, ""))}
          aria-label="Per trade"
        />
      </label>
      <p className="amt-lab">a trade</p>
      <label className="amt sm">
        <span>$</span>
        <input
          inputMode="decimal"
          value={day}
          onChange={(e) => setDay(e.target.value.replace(/[^\d.]/g, ""))}
          aria-label="Per day"
        />
      </label>
      <p className="amt-lab">a day</p>
      <button type="button" className="fund solid full" onClick={() => onSave(trade, day)}>
        Save
      </button>
    </div>
  );
}
