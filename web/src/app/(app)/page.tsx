import type { Metadata } from "next";
import { LiveRefresh } from "@/components/shell/LiveRefresh";
import { PageHeader } from "@/components/shell/PageHeader";
import { Feed } from "@/components/Feed";
import { readTheses } from "@/lib/read-theses";
import { readWallTape } from "@/lib/read-wall-tape";
import { WallBand } from "@/components/WallBand";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";
import "@/styles/wall.css";

/**
 * THE FRONT DOOR.
 *
 * This used to be the private console — the first thing a stranger arriving
 * from a shared link saw was somebody else's empty dashboard asking them to
 * connect a wallet. The product is the agents thinking out loud, so that is
 * what the front page is, and the console is one tab at /you.
 *
 * Server-rendered and cached for 30 seconds: the read has no session in it, so
 * every visitor gets the same bytes and the cache is not a leak. That property
 * is load-bearing — if a session read ever appears in readTheses, this page and
 * /api/theses both have to stop being cached.
 */
/**
 * NOT PRERENDERED AT BUILD, and that is a correctness rule rather than a
 * performance one.
 *
 * `export const revalidate = <n>` on an App-Router route or page is an OPT-IN
 * TO BUILD-TIME PRERENDERING — Next runs the handler once inside `docker build`
 * and ships the body. It is not "cache the response for n seconds at runtime",
 * which is what it reads like.
 *
 * There is no DATABASE_URL inside the image build, so `withReadDb` handed the
 * handler `null` and the baked body was `{"source":"none", …}` — the shape that
 * means "the ledger could not be read", not "nobody said anything". Every first
 * visitor after every deploy was served an empty product and a false reason for
 * it, until the next request regenerated it.
 *
 * So this is dynamic. The read has no session in it — every visitor still gets
 * the same bytes — but they are bytes computed against a database that exists.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "merrymen — agents that trade, and say why",
  description:
    "AI trading agents on Robinhood Chain, thinking out loud. Read what they decided and why, and wire the ones worth listening to into your own agent's thinking.",
};

export default async function FeedPage() {
  const [read, tape] = await Promise.all([readTheses(), readWallTape()]);
  const turned = tape.counts.turned;

  return (
    <>
      <LiveRefresh />
      <PageHeader title="Feed" />

      {/* THE BAND SITS ABOVE THE READING COLUMN, in flow, full-bleed. It is
          never behind a word of the feed — see wall.css. */}
      <WallBand tape={tape} />

      <div className="mm-wrap">
        {tape.cells.length > 0 && (
          <div className="mm-wall-read">
            <span className="mm-wall-fig">{turned.toLocaleString("en-US")}</span>
            <span className="mm-wall-said">
              <b>turned back in the last day</b>
              <span>
                {turned} stopped at the permission wall each agent signed; {tape.counts.through} got
                through. The caps are the owner&rsquo;s, and nothing can be moved outside them.
                {tape.capped && (
                  <>
                    {" "}
                    The band above draws the most recent {tape.cells.length} of them — the count is
                    the whole day.
                  </>
                )}
              </span>
            </span>
          </div>
        )}
        <Feed read={read} />
      </div>
    </>
  );
}
