/**
 * PROVING YOU OWN THE X ACCOUNT YOU TYPED.
 *
 * `xHandle` has always been display metadata — `packages/core/src/settings.ts`
 * says it "renders disclaimed and never as a link", because we store what the
 * owner typed and nothing checks they own it. That rule is right for an
 * UNVERIFIED handle: a link makes merrymen vouch for an association it never
 * checked, and lets an agent impersonate anyone by typing their name.
 *
 * This route is how a handle stops being unverified. Same three-step shape as
 * /api/holder, which proves a wallet: issue a nonce, the owner does something
 * only the owner could do, we check it and store a proof. Only a stored proof
 * makes the handle a link anywhere in the product.
 *
 * WHAT THE OWNER DOES: posts a public tweet containing the nonce. We then read
 * that tweet's author from X's own syndication endpoint — the one that backs
 * embedded tweets — which needs no API key, no developer app and no paid tier.
 * If the author is the claimed handle and the text carries the nonce, the
 * person who posted it controls the account.
 *
 * THREE HONEST LIMITS, written here rather than discovered:
 *
 *   The endpoint is UNDOCUMENTED. It can change or start refusing us. So a
 *   fetch failure is "we could not check" — a 503 — and never "you do not own
 *   this". Those have different remedies and only one of them is the reader's.
 *
 *   A PROTECTED ACCOUNT cannot be read at all, so its owner cannot prove a
 *   handle this way. They are told that, rather than being told they failed.
 *
 *   THE PROOF IS POINT-IN-TIME. Deleting the tweet afterwards does not
 *   un-verify the handle, exactly as /api/holder records `at` and never
 *   re-checks a balance. What was true when we looked is what we recorded.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";
import { consumeChallengeNonce, issueChallengeNonce, requestOrigin, tenantOf } from "@/lib/auth";
import { normaliseXHandle } from "@/lib/x-handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireTenant(req: Request): `0x${string}` | null {
  if (!isHostedMode()) return null;
  return tenantOf(req);
}

/**
 * The sentence the owner posts. Names the product and the nonce, nothing else.
 *
 * NOT EXPORTED, and that is a Next constraint rather than a style choice. A
 * route module may only export route handlers plus a fixed set of config names
 * (`runtime`, `dynamic`, …); Next generates a type that maps every OTHER export
 * to `never` and typechecks the module against it. So exporting a helper here
 * fails the build with an error that names `.next/types/...`, points at
 * generated code, and says nothing about the line that caused it.
 *
 * It had been failing CI on every push for eight commits — and because
 * Typecheck runs before Test in the workflow, the whole test suite had not run
 * in CI once in that window. Nothing imported this symbol; the export was
 * simply never needed. If something outside this route ever does need it, it
 * moves to `@/lib/x-handle` rather than being exported from here again.
 */
function xProofMessage(nonce: string): string {
  return `Verifying my merrymen agent. ${nonce}`;
}

/**
 * A tweet id from whatever the owner pasted — a full URL or the bare number.
 *
 * Deliberately strict: ids are digits, and accepting anything else here would
 * put user text into the URL we fetch.
 */
export function tweetIdFrom(raw: string): string | null {
  const s = raw.trim();
  const direct = /^\d{5,25}$/.exec(s);
  if (direct) return direct[0];
  const inUrl = /(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d{5,25})/i.exec(s);
  return inUrl ? inUrl[1]! : null;
}

/** GET — the nonce to post, and the exact words to post it in. */
export async function GET(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) {
    return NextResponse.json(
      { error: isHostedMode() ? "not signed in" : "self-hosted: set xHandle in settings instead" },
      { status: isHostedMode() ? 401 : 400 },
    );
  }
  const handle = normaliseXHandle(new URL(req.url).searchParams.get("handle"));
  if (!handle) {
    return NextResponse.json(
      { error: "x handle: letters, numbers and underscores, up to 15 characters" },
      { status: 400 },
    );
  }
  const nonce = issueChallengeNonce(requestOrigin(req));
  return NextResponse.json({ handle, nonce, message: xProofMessage(nonce) });
}

interface Syndicated {
  user?: { screen_name?: string };
  text?: string;
}

/** POST — check the tweet, and store the proof if it holds. */
export async function POST(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) {
    return NextResponse.json({ error: "not signed in" }, { status: isHostedMode() ? 401 : 400 });
  }

  let body: { handle?: string; nonce?: string; tweet?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request body" }, { status: 400 });
  }

  const handle = normaliseXHandle(body.handle);
  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  const tweetId = typeof body.tweet === "string" ? tweetIdFrom(body.tweet) : null;
  if (!handle) return NextResponse.json({ error: "that is not an x handle" }, { status: 400 });
  if (!tweetId) {
    return NextResponse.json({ error: "paste the link to your post, or its id" }, { status: 400 });
  }
  // SPENT BEFORE THE FETCH, so one nonce cannot be replayed against a race.
  if (!consumeChallengeNonce(nonce, requestOrigin(req))) {
    return NextResponse.json(
      { error: "that code has expired or was already used — start again" },
      { status: 401 },
    );
  }

  let post: Syndicated;
  try {
    const res = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=merrymen`,
      { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } },
    );
    if (!res.ok) {
      // A MISSING POST IS NOT A FAILED PROOF WE CAN ATTRIBUTE. It is deleted,
      // protected, or we are being refused — and we cannot tell which.
      return NextResponse.json(
        {
          error:
            "we couldn't read that post. It may be deleted, or from a protected account, " +
            "or X may be refusing us right now. That last one is ours, not yours.",
        },
        { status: 503 },
      );
    }
    post = (await res.json()) as Syndicated;
  } catch {
    return NextResponse.json(
      { error: "we couldn't reach X to check that post. Try again shortly — this one is ours." },
      { status: 503 },
    );
  }

  const author = normaliseXHandle(post.user?.screen_name ?? null);
  const text = typeof post.text === "string" ? post.text : "";

  if (!author || author.toLowerCase() !== handle.toLowerCase()) {
    return NextResponse.json(
      { error: `that post is by @${author ?? "someone else"}, not @${handle}` },
      { status: 400 },
    );
  }
  if (!nonce || !text.includes(nonce)) {
    return NextResponse.json(
      { error: "that post doesn't contain your code — post the exact message shown" },
      { status: 400 },
    );
  }

  const store = getSettingsStore();
  const stored = (await store.get(tenant)) ?? {};
  await store.put(tenant, {
    ...stored,
    xHandle: handle,
    xProof: { handle, at: Date.now() },
  });
  return NextResponse.json({ ok: true, handle });
}

/** DELETE — unlink. Drops the proof AND the handle it vouched for. */
export async function DELETE(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const store = getSettingsStore();
  const stored = (await store.get(tenant)) ?? {};
  const { xProof: _gone, ...rest } = stored;
  await store.put(tenant, { ...rest, xHandle: undefined });
  return NextResponse.json({ ok: true });
}

/** PATCH — what is proven for this account right now. */
export async function PATCH(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) return NextResponse.json({ handle: null, at: null });
  const stored = (await getSettingsStore().get(tenant)) ?? {};
  const proof = stored.xProof;
  const handle = normaliseXHandle(proof?.handle ?? null);
  return NextResponse.json({ handle, at: handle ? (proof?.at ?? null) : null });
}
