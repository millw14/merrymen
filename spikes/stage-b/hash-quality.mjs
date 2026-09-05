/**
 * The decisive test the previous run could not make: on rosters that share NO
 * tenants with today's fleet, is any hash intrinsically better at spreading
 * addresses, or is djb2's win on the current 22 pure luck of the draw?
 *
 * If the mean max-in-window is the same for all of them, then selecting a hash
 * on today's roster is selecting a lottery ticket that has already been drawn.
 */
import { randomBytes } from "node:crypto";
import { HASHES, offsetMsFor } from "./offset.mjs";

const P = 240_000;
const W = 8_000;
const N = 22;
const TRIALS = 20_000;

function maxInWindow(offs, w) {
  let best = 0;
  for (const a of offs) {
    let n = 0;
    for (const b of offs) if (((b - a) % P + P) % P < w) n++;
    if (n > best) best = n;
  }
  return best;
}

const names = Object.keys(HASHES).filter((n) => n !== "bytesum");
const sum = Object.fromEntries(names.map((n) => [n, 0]));
const hist = Object.fromEntries(names.map((n) => [n, new Map()]));

for (let t = 0; t < TRIALS; t++) {
  // A real EOA is a keccak slice — uniformly random 20 bytes. Draw the same way.
  const roster = Array.from({ length: N }, () => "0x" + randomBytes(20).toString("hex"));
  for (const n of names) {
    const m = maxInWindow(roster.map((a) => offsetMsFor(HASHES[n], a, P)), W);
    sum[n] += m;
    hist[n].set(m, (hist[n].get(m) ?? 0) + 1);
  }
}

console.log(`${TRIALS.toLocaleString()} independent random rosters of ${N} addresses, ${P / 1000}s period, ${W / 1000}s window\n`);
console.table(
  names.map((n) => {
    const row = { hash: n, mean_max_in_8s: +(sum[n] / TRIALS).toFixed(4) };
    for (const k of [2, 3, 4, 5, 6, 7]) row[`P(=${k})`] = `${(((hist[n].get(k) ?? 0) / TRIALS) * 100).toFixed(1)}%`;
    return row;
  }),
);
console.log(
  "\nIf these rows are identical within noise, no hash here is 'better' — they are all\n" +
    "uniform, and the spread a fleet gets is a draw, not a property of the function.",
);
