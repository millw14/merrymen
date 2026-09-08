/**
 * `cost_basis.cost_usdg` AS A DOLLAR FIGURE — the units are not the ones the
 * name suggests.
 *
 * The column is a decimal string of the worker's `bigint` cost in MICRO-USDG,
 * because that is the unit the whole basis arithmetic is done in and a text
 * column is the only lossless way to carry a bigint through SQLite and Postgres
 * alike. Every other money column a page reads — `value_usdg`, `equity_usdg`,
 * `amount_usdg` — is a REAL in whole USDG.
 *
 * So `Number(row.cost_usdg)` is off by a factor of a million, and it reads as a
 * position that cost $8,332,500 and is now worth $8.32: every holding down
 * 99.99%, on the public agent page and the token page, forever. It is the same
 * failure venues/pons-price.ts records against itself — "carrying the 8dp number
 * under a 6dp name would let a $250 curve clear a $25,000 floor" — and the same
 * remedy: convert once, in one named place, so the two units cannot be confused
 * again by anyone reading a row.
 *
 * NULL SURVIVES AS NULL. A holding with no basis on record is one whose entry
 * price is unknown; zero would say it was free, and the return computed from it
 * would be infinite rather than absent.
 */
export function basisUsdg(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const micro = Number(raw);
  if (!Number.isFinite(micro) || micro <= 0) return null;
  return micro / 1e6;
}

/*
 * NO IMPORTS, ON PURPOSE.
 *
 * This began inside `lib/ledger.ts`, which opens a database and therefore
 * cannot be reached from a browser bundle or from a plain test runner — so the
 * one conversion three surfaces need would have been importable by two of them.
 * `thesis-policy.ts` records the same discipline for the same reason: a module
 * with no imports is one every reader can share, and that is what stops a second
 * copy of the rule appearing.
 */
