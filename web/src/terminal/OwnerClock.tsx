"use client";

import { useEffect } from "react";
import { noteMe } from "./groupchat";

/**
 * TELLS THE ROOM WHAT TIME IT IS FOR THIS OWNER, AND DRAWS NOTHING.
 *
 * An agent in the group chat goes quiet at night in its OWNER's time zone, and
 * the only honest source for that zone is the owner's own browser. Guessing is
 * worse than not knowing: an unknown zone means "never sleeps" (docs/groupchat.md),
 * while a guessed one invents a fact about where somebody lives — and "UTC for
 * everyone" would put the whole room to sleep at once.
 *
 * ONCE PER ACCOUNT PER BROWSER SESSION. Mounted in Providers, so it runs on any
 * page — and Providers sits outside the shell that knows who is signed in, so
 * it asks `/api/auth/session` first (read-only, the shell polls it too). A
 * visitor is never sent the POST at all: the route answers a signed-out POST
 * 401, which was a console error on every page load for every visitor. What is
 * remembered is "sent:<account>:<zone>", so a second owner signing in on the
 * same tab is sent too, and a laptop that crossed a border mid-session reports
 * its new zone.
 *
 * SIGN-IN HAPPENS IN THE PAGE, with no reload and nothing that tells this
 * component. While nobody is signed in it looks again once a minute (only while
 * the tab is showing — the shell's own poll pauses the same way) and on every
 * return to the tab, so an owner who signs in and stays is captured within a
 * minute instead of "never sleeps" until their next reload. The server ignores
 * a browser zone whenever the owner picked one themselves, so a traveller's
 * browser never overrides a choice they made.
 *
 * SILENT ON EVERY FAILURE. This is a background courtesy; an owner must never
 * see an error about a request they did not make. Self-hosted installs have no
 * room and are remembered as such for the session, so they are not asked again.
 *
 * The zone goes to OUR server only, over a private no-store route, and is never
 * shown in the room: rule 3 of the contract lists the owner's time zone among
 * the things that must not reach it. The answer — the owner's own settings —
 * is handed to the room's store, so its sleep panel is current if it is open.
 */
const KEY = "merrymen.groupchat.tz.v1";
/** Visibility flips constantly (every tab switch, every pane show); one ask a minute is plenty. */
const MIN_GAP_MS = 60_000;

function zone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz ? tz : null;
  } catch {
    return null;
  }
}

function remembered(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(value: string): void {
  try {
    sessionStorage.setItem(KEY, value);
  } catch {
    /* no session storage: it is asked again next page load, which is harmless */
  }
}

/** Who is signed in: an account, nobody (null), or no room on this install ("unsupported"). */
async function whoIsSignedIn(): Promise<string | null | "unsupported"> {
  const res = await fetch("/api/auth/session", { cache: "no-store" });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { hosted?: unknown; address?: unknown } | null;
  if (body?.hosted === false) return "unsupported";
  return typeof body?.address === "string" && body.address ? body.address.toLowerCase() : null;
}

export function OwnerClock(): null {
  useEffect(() => {
    let alive = true;
    let busy = false;
    let lastAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    /** Nobody signed in yet: look again in a minute. */
    const later = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!alive) return;
        if (hidden()) later();
        else void send();
      }, MIN_GAP_MS);
    };

    const send = async () => {
      const tz = zone();
      if (!alive || !tz || busy) return;
      if (remembered() === "unsupported") return;
      if (Date.now() - lastAt < MIN_GAP_MS) return;
      busy = true;
      lastAt = Date.now();
      try {
        const who = await whoIsSignedIn();
        if (!alive) return;
        if (who === "unsupported") {
          remember("unsupported");
          return;
        }
        if (!who) {
          later();
          return;
        }
        const sent = `sent:${who}:${tz}`;
        if (remembered() === sent) return;
        const res = await fetch("/api/groupchat/me", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tz, source: "browser" }),
          cache: "no-store",
        });
        if (res.status === 404) {
          remember("unsupported");
          return;
        }
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { signedIn?: unknown } | null;
        if (body?.signedIn === true) {
          remember(sent);
          noteMe(body);
        }
      } catch {
        // Silent (see the header), and tried again in a minute.
        if (alive) later();
      } finally {
        busy = false;
      }
    };
    void send();
    const onVisible = () => {
      if (!hidden()) void send();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
