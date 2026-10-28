/** Exact input/output formatting. Never round raw financial amounts via Number. */
export function solanaUnits(value: string, decimals: number, allowZero = false): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 40) throw new Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`This amount supports at most ${decimals} decimal places.`);
  const raw = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if ((!allowZero && raw === 0n) || raw > 18_446_744_073_709_551_615n) throw new Error("Enter a positive amount within the supported range.");
  return raw.toString();
}
export function displaySolanaAmount(raw: string, decimals = 6): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^-?(0|[1-9][0-9]*)$/.test(raw)) throw new Error("Invalid raw token amount.");
  const signed = BigInt(raw), value = signed < 0n ? -signed : signed, base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${signed < 0n ? "-" : ""}${value / base}${fraction ? `.${fraction}` : ""}`;
}
/**
 * A raw amount from a server answer, displayed, or null when it is missing or
 * not a raw integer. For optional status fields: one malformed value must hide
 * that line, never throw and blank the whole Solana screen.
 */
export function displaySolanaAmountOrNull(raw: unknown, decimals = 6): string | null {
  return typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) && raw.length <= 40 ? displaySolanaAmount(raw, decimals) : null;
}
