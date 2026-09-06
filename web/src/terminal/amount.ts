/** Accept a positive dollar amount with at most two decimal places. */
export function validAmount(value: string): boolean {
  return (
    /^\d+(?:\.\d{1,2})?$/.test(value) &&
    Number(value) > 0 &&
    Number.isSafeInteger(Math.round(Number(value) * 100))
  );
}
