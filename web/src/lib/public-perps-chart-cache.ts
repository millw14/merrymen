/**
 * Coalesce only PUBLIC venue reads. Owner-scoped ledger fills never enter this
 * cache and every HTTP response remains private/no-store.
 */
export function createPublicReadCache<T>(capacity = 32) {
  const entries = new Map<string, { expiresAt: number; promise: Promise<T | null> }>();
  return {
    read(key: string, nowMs: number, ttlMs: number, loader: () => Promise<T | null>, ttlForValue?: (value: T) => number): Promise<T | null> {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > nowMs) return cached.promise;
      const entry = {
        expiresAt: nowMs + ttlMs,
        promise: Promise.resolve(null) as Promise<T | null>,
      };
      entry.promise = Promise.resolve().then(loader).catch(() => null).then((value) => {
        // Outages get a short shared cooldown, not a whole candle period.
        if (value === null) entry.expiresAt = Math.min(entry.expiresAt, nowMs + 30_000);
        else if (ttlForValue) entry.expiresAt = Math.min(entry.expiresAt, nowMs + ttlForValue(value));
        return value;
      });
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
      return entry.promise;
    },
  };
}
