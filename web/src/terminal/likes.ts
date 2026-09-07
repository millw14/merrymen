/**
 * LIKES, ONCE PER PAGE — not once per <Feed>.
 *
 * TWO FEEDS MOUNT AT THE SAME TIME. `App.tsx` renders the feed tab, and
 * `Desktop.tsx` keeps a compact one in the sidebar rail — mounted whether or
 * not its panel is the visible section, because `hidden` hides an element and
 * does not unmount it. That is the same shape as the duplicate `AccountEntry`
 * this shell just stopped mounting on phones: work that runs where nobody can
 * see it.
 *
 * Per-component state would therefore have meant two polls of every like route
 * and, worse, TWO ANSWERS: a heart filled in the sidebar and empty in the body,
 * for the same post, because each copy kept its own optimistic set.
 *
 * So the state is module-scoped and components subscribe to it, the same
 * `useSyncExternalStore` shape `App.tsx` already uses for the desktop media
 * query. One fetch, one poll, one truth — and the poll runs only while at least
 * one feed is mounted.
 *
 * WHAT IS NOT HERE. No count ever reaches an agent: this module is browser-only
 * presentation, the store behind it lives under `web/src` where the worker
 * cannot import it, and `PublicThesis` carries no id and no number. See
 * `lib/like-fence.test.ts`, which pins all three.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

export interface LikesState {
  /** post id → how many wallets. Absent means zero, once `read` is true. */
  counts: Record<string, number>;
  /** Post ids this reader has liked. */
  mine: Set<string>;
  /**
   * Whether the counts were read at all. False means the store did not answer,
   * and a zero must not be shown in its place — "nobody liked this" and "we
   * could not ask" are different claims and only one is about the post.
   */
  read: boolean;
  /** True once the session answer is in. */
  signedIn: boolean;
  /**
   * Whether THIS reader's own likes could be read.
   *
   * Separate from `signedIn` because they are different facts and collapsing
   * them told a signed-in reader they were signed out whenever the store was
   * down — a false claim about them, with a remedy (sign in again) that could
   * not work. Starts true: nothing has failed yet, and the button is disabled
   * on `signedIn` until the first answer arrives anyway.
   */
  mineRead: boolean;
  /**
   * False on a self-hosted install, where `/api/likes` 404s: one operator, one
   * settings file, nobody for a like to be attributed to. Distinct from
   * `signedIn: false`, which is a hosted visitor who could sign in.
   */
  supported: boolean;
}

/** How often other people's likes are pulled, against a route cached for 20s. */
const POLL_MS = 60_000;

let state: LikesState = {
  counts: {},
  mine: new Set(),
  read: false,
  signedIn: false,
  mineRead: true,
  supported: true,
};

const listeners = new Set<() => void>();
let mounted = 0;
let timer: number | null = null;
let started = false;

function set(next: Partial<LikesState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function pullCounts(): Promise<void> {
  return fetch("/api/like-counts", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ counts: Record<string, number>; read: boolean }>) : null))
    .then((j) => {
      // The route's own `read` flag, not the fetch succeeding: it answers 200
      // with `read: false` when the store would not open.
      if (j) set({ counts: j.counts, read: j.read });
    })
    .catch(() => {});
}

/**
 * When the session answer was last asked for.
 *
 * THROTTLED, because the trigger is `visibilitychange` and that is not a rare
 * event: every tab switch, every window focus, and — measured in the in-app
 * browser pane — every time the pane itself is shown or hidden. Unthrottled, a
 * session read fired dozens of times a minute for an answer that changes when
 * somebody signs in or out.
 */
let lastMineAt = 0;
const MINE_MIN_GAP_MS = 30_000;

function pullMine(): Promise<void> {
  lastMineAt = Date.now();
  return fetch("/api/likes", { cache: "no-store" })
    .then(async (r) => {
      // 404 is the hosted-only surface saying this install has no likes at all.
      // Not an error, and not a signed-out state.
      if (r.status === 404) {
        set({ supported: false });
        return;
      }
      if (!r.ok) {
        set({ mineRead: false });
        return;
      }
      const j = (await r.json()) as { liked: string[]; signedIn?: boolean; read?: boolean };
      if (j.read === false) {
        // The session was read; the STORE was not. Keeping `signedIn` untouched
        // is the whole point — reporting this as signed-out tells a reader who
        // is signed in to go and sign in.
        set({ mineRead: false });
        return;
      }
      // THE ROUTE SAYS SO; a 200 does not. It answers 200 with an empty list
      // for a signed-OUT hosted visitor on purpose, so inferring "signed in"
      // from the status would enable a button that 401s on click.
      set({ mine: new Set(j.liked), signedIn: j.signedIn === true, mineRead: true });
    })
    .catch(() => set({ mineRead: false }));
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  mounted += 1;
  if (!started) {
    started = true;
    void pullCounts();
    void pullMine();
  }
  if (timer === null) timer = window.setInterval(() => void pullCounts(), POLL_MS);
  return () => {
    listeners.delete(fn);
    mounted -= 1;
    // The poll stops when the last feed goes away; `started` deliberately does
    // NOT reset, so navigating back to the feed re-renders what we already know
    // instead of blanking to zero while a refetch is in flight.
    if (mounted <= 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => state;
/**
 * The server has no session and no store; rendering `supported: true` there and
 * correcting it on the client is what every other read in this shell does. The
 * constant identity matters — a fresh object per call makes React loop.
 */
const SERVER: LikesState = {
  counts: {},
  mine: new Set(),
  read: false,
  signedIn: false,
  mineRead: true,
  supported: true,
};
const serverSnapshot = () => SERVER;

/**
 * Cast or withdraw a like.
 *
 * Optimistic on BOTH halves, and rolled back together — a heart that fills
 * while the number stays put reads as a broken button.
 */
function toggle(postId: string, on: boolean): void {
  const mine = new Set(state.mine);
  if (on) mine.add(postId);
  else mine.delete(postId);
  set({
    mine,
    counts: { ...state.counts, [postId]: Math.max(0, (state.counts[postId] ?? 0) + (on ? 1 : -1)) },
  });
  void fetch("/api/likes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postId, on }),
  })
    .then((r) =>
      r.ok
        ? (r.json() as Promise<{ liked: string[]; read?: boolean; refused?: string }>)
        : Promise.reject(new Error(String(r.status))),
    )
    .then((j) => {
      // A 200 THAT SAYS IT DID NOT WRITE IS A FAILURE. `read: false` comes back
      // with an empty `liked`, and trusting it would erase every like this
      // reader has as well as leaving the optimistic +1 standing.
      if (j.read === false || j.refused) throw new Error(j.refused ?? "unwritten");
      set({ mine: new Set(j.liked), mineRead: true });
    })
    .catch(() => {
      const back = new Set(state.mine);
      if (on) back.delete(postId);
      else back.add(postId);
      set({
        mine: back,
        counts: { ...state.counts, [postId]: Math.max(0, (state.counts[postId] ?? 0) + (on ? -1 : 1)) },
      });
    });
}

export interface LikesView {
  counts: Record<string, number>;
  mine: Set<string>;
  read: boolean;
  /** False when this reader's own likes could not be read — see LikesState. */
  mineRead: boolean;
  /** Null while signed out: a like needs a wallet to be attributed to. */
  onLike: ((postId: string, on: boolean) => void) | null;
}

/** The shared state, or null where likes are not a thing on this install. */
export function useLikes(): LikesView | null {
  const s = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const onLike = useCallback((postId: string, on: boolean) => toggle(postId, on), []);
  // A reader who signs in or out mid-session gets the right answer without a
  // reload: the session route is re-asked whenever the tab comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastMineAt < MINE_MIN_GAP_MS) return;
      void pullMine();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  if (!s.supported) return null;
  return {
    counts: s.counts,
    mine: s.mine,
    read: s.read,
    mineRead: s.mineRead,
    // Signed in AND readable. Offering the button while the store is down would
    // accept a click that cannot be stored.
    onLike: s.signedIn && s.mineRead ? onLike : null,
  };
}

/** Test seam: forget everything, so a test can start from a known state. */
export function resetLikesForTest(): void {
  state = { counts: {}, mine: new Set(), read: false, signedIn: false, mineRead: true, supported: true };
  listeners.clear();
  mounted = 0;
  started = false;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}
