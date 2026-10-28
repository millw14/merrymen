/** Owner-only derived outcome counts; deliberately separate from public peers. */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OWN_LEARNING_ROWS, type OwnOutcomeLearning } from "./own-outcome-learning";

export const OWN_LEARNING_MAX_AGE_SEC = 300;
const FILE = ".own-learning.json";
const MAX_BYTES = 4_096;
export interface OwnLearningScope { account: string; chainId: number; expiresAt: number; epoch: number }

export function writeOwnOutcomeLearningFile(home: string, snapshot: OwnOutcomeLearning, expiresAt: number): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = path.join(home, `${FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...snapshot, expiresAt }), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path.join(home, FILE));
}

/** No arbitrary strings survive this boundary, even from a malformed file. */
export function readOwnOutcomeLearningFile(home: string, scope: OwnLearningScope, nowSec: number): OwnOutcomeLearning | null {
  try {
    const file = path.join(home, FILE);
    if (statSync(file).size > MAX_BYTES) return null;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const s = value as Record<string, unknown>;
    if (!/^0x[0-9a-f]{40}$/i.test(scope.account) || !Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 ||
        !Number.isSafeInteger(nowSec) || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= nowSec ||
        s.version !== 1 || typeof s.account !== "string" || s.account.toLowerCase() !== scope.account.toLowerCase() ||
        s.chainId !== scope.chainId || s.expiresAt !== scope.expiresAt ||
        !Number.isSafeInteger(scope.epoch) || scope.epoch < 0 || s.epoch !== scope.epoch ||
        !Number.isSafeInteger(s.at) || Number(s.at) > nowSec || nowSec - Number(s.at) > OWN_LEARNING_MAX_AGE_SEC ||
        !Number.isSafeInteger(s.epoch) || Number(s.epoch) < 0 ||
        (s.status !== "ready" && s.status !== "unavailable") ||
        !["none", "identity", "history-limit", "unreadable"].includes(String(s.reason))) return null;
    const counts = ["closed", "wins", "losses", "flat", "costFlips", "excluded", "open", "unresolved"] as const;
    for (const key of counts) if (!Number.isSafeInteger(s[key]) || Number(s[key]) < 0 || Number(s[key]) > OWN_LEARNING_ROWS) return null;
    if (Number(s.wins) + Number(s.losses) + Number(s.flat) !== s.closed || Number(s.costFlips) > Number(s.losses)) return null;
    for (const key of ["returnPct", "costDragPct"] as const) {
      if (s.closed === 0 ? s[key] !== null : typeof s[key] !== "number" || !Number.isFinite(s[key]) || Math.abs(Number(s[key])) > 1_000_000) return null;
    }
    if (Number(s.costDragPct) < 0 || (s.status === "ready") !== (s.reason === "none") || (s.status === "unavailable" && counts.some((key) => s[key] !== 0))) return null;
    return { version: 1, account: scope.account.toLowerCase(), chainId: scope.chainId, epoch: Number(s.epoch), at: Number(s.at),
      status: s.status, reason: s.reason as OwnOutcomeLearning["reason"],
      closed: Number(s.closed), wins: Number(s.wins), losses: Number(s.losses), flat: Number(s.flat), costFlips: Number(s.costFlips),
      excluded: Number(s.excluded), open: Number(s.open), unresolved: Number(s.unresolved),
      returnPct: s.returnPct as number | null, costDragPct: s.costDragPct as number | null };
  } catch { return null; }
}
