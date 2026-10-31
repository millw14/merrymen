import type { PerpsPilotSnapshot } from "./pilot-store";

/** A shared read per parent, never a database request per worker. */
export const PERPS_PILOT_REFRESH_MS = 3_000;
export const PERPS_PILOT_MAX_AGE_MS = 15_000;
export const PERPS_PILOT_READ_TIMEOUT_MS = 2_000;

type Snapshot = { owners: ReadonlySet<string>; revision: number; startedAt: number; fingerprint: string };
export type PerpsPilotSnapshotReader = () => Promise<PerpsPilotSnapshot>;

/**
 * Entry permission is a short-lived positive proof. Neither the last good
 * snapshot nor environment variables substitute for an unavailable store.
 * The clock is independent of roster/settings reads, which may hang.
 */
export class PerpsPilotAdmission {
  private current: Snapshot | null = null;
  private accepted: Pick<Snapshot, "revision" | "fingerprint"> | null = null;
  private pending: { result: Promise<boolean>; expire: () => void } | null = null;
  private nextReadAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly maxAgeMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: {
    read: PerpsPilotSnapshotReader;
    /** Restrictive only: callers must not enable workers from this callback. */
    onRestriction: () => void;
    now?: () => number;
    refreshMs?: number;
    maxAgeMs?: number;
    timeoutMs?: number;
  }) {
    this.now = options.now ?? (() => performance.now());
    this.refreshMs = options.refreshMs ?? PERPS_PILOT_REFRESH_MS;
    this.maxAgeMs = options.maxAgeMs ?? PERPS_PILOT_MAX_AGE_MS;
    this.timeoutMs = options.timeoutMs ?? PERPS_PILOT_READ_TIMEOUT_MS;
    if (![this.refreshMs, this.maxAgeMs, this.timeoutMs].every(n => Number.isFinite(n) && n > 0))
      throw new Error("Invalid paper-pilot refresh timing.");
  }

  private invalidate(): void {
    if (!this.current) return;
    this.current = null;
    try { this.options.onRestriction(); } catch { /* Permission is already unavailable. */ }
  }

  private fresh(): boolean {
    if (this.current && (this.now() < this.current.startedAt || this.now() - this.current.startedAt >= this.maxAgeMs))
      this.invalidate();
    return this.current !== null;
  }

  /** Synchronous, including the expiry check at the final fork/write boundary. */
  allowed(owner: string): boolean {
    return this.fresh() && /^0x[0-9a-f]{40}$/i.test(owner) && this.current!.owners.has(owner.toLowerCase());
  }

  /** Bind async settings reads and delivered entry permission to this proof. */
  revision(): number | null {
    return this.fresh() ? this.current!.revision : null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, Math.min(250, this.refreshMs));
    this.timer.unref();
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    // Resolve any startup waiter now. Its physical query remains the single
    // in-flight read until it settles, and can never repopulate this cache.
    this.pending?.expire();
    this.invalidate();
  }

  /** Force only bypasses the frequency limit, never physical singleflight. */
  refresh(force = false): Promise<boolean> {
    this.fresh();
    if (this.pending) return this.pending.result;
    const startedAt = this.now();
    if (!force && startedAt < this.nextReadAt) return Promise.resolve(this.current !== null);
    this.nextReadAt = startedAt + this.refreshMs;
    const generation = this.generation;
    let settled = false;
    let resolve!: (value: boolean) => void;
    const result = new Promise<boolean>(done => { resolve = done; });
    const expire = () => {
      if (settled) return;
      settled = true;
      this.invalidate();
      resolve(false);
    };
    const pending = { result, expire };
    this.pending = pending;
    const deadline = setTimeout(expire, this.timeoutMs);
    // This deadline is intentionally referenced: an awaited initial read must
    // finish even in a process whose only other timer is the unref'd watcher.
    void Promise.resolve().then(this.options.read).then(raw => {
      if (settled || generation !== this.generation) return;
      const age = this.now() - startedAt;
      if (age < 0 || age >= this.timeoutMs || age >= this.maxAgeMs) { expire(); return; }
      const snapshot = this.validate(raw, startedAt);
      // A revoke followed by re-admission between polls leaves the same owner
      // set, but must invalidate settings read before that permission change.
      const changed = !this.current || this.current.revision !== snapshot.revision || this.current.fingerprint !== snapshot.fingerprint;
      this.accepted = { revision: snapshot.revision, fingerprint: snapshot.fingerprint };
      this.current = snapshot;
      settled = true;
      if (this.pending === pending) this.pending = null;
      // A changed cohort is enforced synchronously before refresh resolves.
      if (changed) {
        try { this.options.onRestriction(); } catch { this.current = null; }
      }
      resolve(this.current !== null);
    }).catch(() => {
      if (this.pending === pending) this.pending = null;
      expire();
    }).finally(() => {
      clearTimeout(deadline);
      if (this.pending === pending) this.pending = null;
    });
    return result;
  }

  private validate(raw: PerpsPilotSnapshot, startedAt: number): Snapshot {
    if (!raw || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.owners) || raw.owners.length > 100)
      throw new Error("Unreadable paper-pilot snapshot.");
    const owners = new Set<string>();
    for (const owner of raw.owners) {
      if (typeof owner !== "string" || !/^0x[0-9a-f]{40}$/.test(owner) || owners.has(owner))
        throw new Error("Unreadable paper-pilot owner.");
      owners.add(owner);
    }
    const fingerprint = [...owners].sort().join(",");
    if (this.accepted && (raw.revision < this.accepted.revision ||
      (raw.revision === this.accepted.revision && fingerprint !== this.accepted.fingerprint)))
      throw new Error("Paper-pilot snapshot revision regressed.");
    return { owners, revision: raw.revision, startedAt, fingerprint };
  }
}
