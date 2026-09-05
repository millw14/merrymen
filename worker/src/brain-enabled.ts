/**
 * WHICH AGENTS MAY THINK — an allowlist, not a boolean.
 *
 * Shadow Brain starts at ONE agent. Not because the code cannot handle more,
 * but because nobody has watched it spend anything in production yet, and this
 * fleet's one real incident was an unwatched background feature emptying a
 * shared allowance. An allowlist makes expanding a deliberate act with a name
 * attached; a boolean makes it a typo.
 *
 * Prefix matching, comma separated, `all` accepted — the exact shape
 * `MERRYMEN_RECONCILE_SHADOW` already uses, so an operator who has enabled one
 * shadow feature already knows how to enable this one. Reusing a convention is
 * worth more than a marginally better one nobody remembers.
 *
 * EMPTY MEANS OFF. A missing variable is not "everyone" — the failure direction
 * for a feature that spends money has to be silence.
 */
export function shadowBrainEnabledFor(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MERRYMEN_BRAIN_SHADOW ?? "").trim();
  if (!raw) return false;
  const want = id.trim().toLowerCase();
  if (!want) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => p === "all" || want.startsWith(p));
}
