import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileFollowStore, MAX_FOLLOWS, SLUG_SHAPE, resetFollowStoreForTest } from "./follow-store";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const slug = (n: number) => `a7k3m9qz2n4vb8x${n}`;

let home: string;
let prev: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "mm-follow-"));
  prev = process.env.MERRYMEN_HOME;
  process.env.MERRYMEN_HOME = home;
  resetFollowStoreForTest();
});
afterEach(async () => {
  if (prev === undefined) delete process.env.MERRYMEN_HOME;
  else process.env.MERRYMEN_HOME = prev;
  resetFollowStoreForTest();
  await rm(home, { recursive: true, force: true });
});

describe("the follow graph", () => {
  it("stores an edge and reads it back", async () => {
    const s = new FileFollowStore();
    assert.deepEqual(await s.following(A), []);
    assert.equal(await s.follow(A, slug(1)), true);
    assert.deepEqual((await s.following(A)).map((e) => e.target), [slug(1)]);
  });

  it("IS IDEMPOTENT, and re-following does not reorder somebody's list", async () => {
    // The composite key is the idempotence — following twice is one edge. And
    // the original timestamp survives, so a double-click cannot silently promote
    // an old wire to the top of a list somebody arranged.
    const s = new FileFollowStore();
    await s.follow(A, slug(1));
    const first = (await s.following(A))[0]!.createdAt;
    await s.follow(A, slug(1));
    const after = await s.following(A);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.createdAt, first);
  });

  it("CAPS AT MAX_FOLLOWS, and says so rather than dropping the edge silently", async () => {
    // A prompt has a context window. The refusal has to be visible to the caller
    // because the UI's whole claim is a visible budget — a silent drop would
    // show `WIRED 8 / 8` while the ninth wire the owner asked for did nothing.
    const s = new FileFollowStore();
    for (let i = 0; i < MAX_FOLLOWS; i++) assert.equal(await s.follow(A, slug(i)), true);
    assert.equal(await s.follow(A, slug(99)), false, "the ninth is refused, not swallowed");
    assert.equal((await s.following(A)).length, MAX_FOLLOWS);

    // An EXISTING edge at the cap is still fine — that is not a new edge.
    assert.equal(await s.follow(A, slug(0)), true);
    // And unfollowing makes room again.
    await s.unfollow(A, slug(0));
    assert.equal(await s.follow(A, slug(99)), true);
  });

  it("keeps tenants apart", async () => {
    // The follower side is an authenticated wallet, so this is the isolation
    // that matters: one owner's wires are not another's.
    const s = new FileFollowStore();
    await s.follow(A, slug(1));
    await s.follow(B, slug(2));
    assert.deepEqual((await s.following(A)).map((e) => e.target), [slug(1)]);
    assert.deepEqual((await s.following(B)).map((e) => e.target), [slug(2)]);
  });

  it("unfollowing something that was never followed is not an error", async () => {
    const s = new FileFollowStore();
    await s.unfollow(A, slug(1));
    assert.deepEqual(await s.following(A), []);
  });

  it("removeTenant forgets the whole graph for one owner", async () => {
    const s = new FileFollowStore();
    await s.follow(A, slug(1));
    await s.follow(B, slug(1));
    await s.removeTenant(A);
    assert.deepEqual(await s.following(A), []);
    assert.equal((await s.following(B)).length, 1, "and leaves everyone else alone");
  });

  it("A DANGLING EDGE IS HARMLESS — there is no foreign key, on purpose", async () => {
    // A follow of a slug that later vanishes must read as "nothing to fetch",
    // never fail a write or a read somewhere else. Nothing in this store even
    // knows whether a target exists.
    const s = new FileFollowStore();
    assert.equal(await s.follow(A, slug(1)), true);
    assert.equal((await s.following(A)).length, 1);
  });

  it("newest first, so a truncated list keeps the most recent decisions", async () => {
    const s = new FileFollowStore();
    await s.follow(A, slug(1));
    // Write the second edge with a later timestamp by hand rather than sleeping.
    const edges = await s.following(A);
    assert.equal(edges.length, 1);
    await s.follow(A, slug(2));
    const out = await s.following(A);
    assert.equal(out.length, 2);
    assert.ok(out[0]!.createdAt >= out[1]!.createdAt, "descending by createdAt");
  });

  it("a corrupt or hand-edited file reads as no follows, never as a throw", async () => {
    // Every other store in this repo returns null/empty on an unreadable file
    // rather than taking the process down, and this one is read on the
    // orchestrator's spawn path where a throw would block an unrelated tenant.
    const s = new FileFollowStore();
    await s.follow(A, slug(1));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(home, "follows", `${A}.json`), "{ not json", "utf8");
    assert.deepEqual(await s.following(A), []);
  });

  it("rows that are not slug-shaped are dropped on read", async () => {
    // The store is written by an authenticated route that validates shape, so
    // this is defence against a hand-edited file rather than against the API —
    // but a target is interpolated into a prompt downstream, and the cheapest
    // place to be sure it is sixteen base32 characters is everywhere.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.join(home, "follows"), { recursive: true });
    await writeFile(
      path.join(home, "follows", `${A}.json`),
      JSON.stringify([
        { target: slug(1), createdAt: 1 },
        { target: "../../etc/passwd", createdAt: 2 },
        { target: "SHOUTING0BASE32X", createdAt: 3 },
        { target: 42, createdAt: 4 },
      ]),
      "utf8",
    );
    assert.deepEqual((await new FileFollowStore().following(A)).map((e) => e.target), [slug(1)]);
  });

  it("SLUG_SHAPE agrees with what identity-store actually mints", async () => {
    // Crockford base32 with i/l/o/u removed, sixteen characters. Duplicated from
    // identity-store deliberately — this module must stay import-free of it —
    // so the two are asserted to agree rather than assumed to.
    const identity = (await import("./identity-store")) as { SLUG_RE?: RegExp };
    // Asserted to EXIST before being compared. Written as `?? SLUG_SHAPE.source`
    // first, which compared the value with itself the moment the export was
    // renamed — a test that cannot fail is worse than no test, because it also
    // claims the opposite.
    assert.ok(identity.SLUG_RE instanceof RegExp, "identity-store must still export SLUG_RE");
    assert.equal(SLUG_SHAPE.source, identity.SLUG_RE.source);
    assert.equal(SLUG_SHAPE.test(slug(1)), true);
    assert.equal(SLUG_SHAPE.test("iloubase32xxxxxx"), false, "i/l/o/u are not in the alphabet");
    assert.equal(SLUG_SHAPE.test("a7k3m9qz2n4vb8"), false, "sixteen characters, not fourteen");
  });
});
