import type { Db } from "./db";
import { decisionResearchEnabledFor } from "./decision-research";
import { readOwnOutcomeLearning } from "./own-outcome-learning";
import { writeOwnOutcomeLearningFile } from "./own-outcome-learning-file";

interface GrantScope { smartAccount: string; chainId: number; expiresAt: number }

/** Derived owner evidence only. Never modifies accounting, a grant, or risk. */
export async function materializeOwnOutcomeLearning(options: {
  db: Db;
  home: string;
  readGrant: () => Promise<GrantScope | null>;
  nowSec: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { db, home, readGrant, nowSec, env = process.env } = options;
  // The default fleet path spends no database reads and creates no new file.
  if (!env.MERRYMEN_DECISION_RESEARCH_ACCOUNTS?.trim()) return;
  const grant = await readGrant();
  if (!grant || !decisionResearchEnabledFor(grant.smartAccount, env) || grant.expiresAt <= nowSec) return;
  const snapshot = await readOwnOutcomeLearning(db, grant.smartAccount, grant.chainId, nowSec);
  const latest = await readGrant();
  if (!latest || latest.smartAccount.toLowerCase() !== grant.smartAccount.toLowerCase() || latest.chainId !== grant.chainId ||
      latest.expiresAt !== grant.expiresAt || latest.expiresAt <= nowSec || !decisionResearchEnabledFor(latest.smartAccount, env)) return;
  writeOwnOutcomeLearningFile(home, snapshot, grant.expiresAt);
}
