/**
 * TELEGRAM GROUPS ARE SAVED BY THE ROUTE THAT IS THE ONLY WRITER OF THE STORE.
 *
 * docs/tg-groups.md "Settings": `telegramGroupsEnabled`,
 * `telegramGroupCoinsEnabled` and `telegramGroupsChattiness` are dashboard-only
 * — the chat refuses them — so this PUT is the one way an owner changes them.
 * A key this route has no branch for comes back {ok:true, ignored:[key]} and
 * changes nothing, and both switches default ON: a missing entry would mean an
 * owner's "stop looking at coins people post" read "Changes saved" while the
 * bot kept looking. Driven through the real PUT, hosted, against the sealed
 * tenant store, the way spec-coverage.test.ts does it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { projectSettings } from "@/lib/services/settings-view";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { HOSTED_FORBIDDEN_SETTING_FIELDS, SECRET_SETTING_KEYS, SETTINGS_DEFAULTS, TELEGRAM_GROUPS_CHATTINESS } from "@merrymen/core";

const TENANT = "0xdddddddddddddddddddddddddddddddddddddddd";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let PUT: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-tg-groups-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // After the env: the route resolves its paths when it loads.
  ({ PUT, GET } = await import("./route"));
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(async () => {
  await getSettingsStore().put(TENANT, { strategy: "trencher" });
});

const cookie = () => `mm_session=${mintSession(TENANT)}`;

async function put(body: Record<string, unknown>) {
  const res = await PUT(new Request("https://app.example.test/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: cookie() },
    body: JSON.stringify({ ...body, owner: TENANT }),
  }));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; ignored?: string[] } };
}
const stored = async () => ((await getSettingsStore().get(TENANT)) ?? {}) as Record<string, unknown>;

describe("PUT /api/settings — the two Telegram groups switches", () => {
  for (const key of ["telegramGroupsEnabled", "telegramGroupCoinsEnabled"] as const) {
    it(`${key}: false is stored — OFF is reachable for a switch that defaults on — and true too`, async () => {
      for (const value of [false, true]) {
        const res = await put({ [key]: value });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.ignored, undefined, `${key} came back ignored: the route has no branch for it`);
        assert.equal((await stored())[key], value);
      }
      assert.equal((await stored()).strategy, "trencher", "nothing else moves");
    });

    it(`${key}: a string or number is refused, not coerced, and nothing is written`, async () => {
      // "false" is truthy to any reader that forgets `=== true`.
      for (const bad of ["false", "true", 0, 1, "off"]) {
        const res = await put({ [key]: bad });
        assert.equal(res.status, 400, `accepted ${JSON.stringify(bad)}`);
        assert.deepEqual(res.body.errors, [`${key}: must be true or false`]);
        assert.equal(key in (await stored()), false, `a refused ${JSON.stringify(bad)} stored something`);
      }
    });

    it(`${key}: null clears back to the default`, async () => {
      await put({ [key]: false });
      const res = await put({ [key]: null });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(key in (await stored()), false);
    });
  }
});

describe("PUT /api/settings — telegramGroupsChattiness", () => {
  it("every level core names is stored, never ignored", async () => {
    for (const level of TELEGRAM_GROUPS_CHATTINESS) {
      const res = await put({ telegramGroupsChattiness: level });
      assert.equal(res.status, 200, `${level}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.ignored, undefined, `${level} came back ignored`);
      assert.equal((await stored()).telegramGroupsChattiness, level);
    }
  });

  it("a level it does not know is REFUSED with a named error, not ignored and not stored", async () => {
    // The worker would silently resolve an unknown level to "normal", so
    // storing one would leave the screen showing a level that is not in force.
    await put({ telegramGroupsChattiness: "quiet" });
    for (const bad of ["loud", "CHATTY", "Quiet", " normal", "normal ", 1, true, ["chatty"], { level: "chatty" }]) {
      const res = await put({ telegramGroupsChattiness: bad });
      assert.equal(res.status, 400, `accepted ${JSON.stringify(bad)}`);
      assert.deepEqual(res.body.errors, ["telegramGroupsChattiness: must be quiet, normal or chatty"]);
      assert.equal((await stored()).telegramGroupsChattiness, "quiet", `a refused ${JSON.stringify(bad)} replaced the stored level`);
    }
  });

  it("null or empty clears back to the default", async () => {
    for (const clear of [null, ""]) {
      await put({ telegramGroupsChattiness: "chatty" });
      const res = await put({ telegramGroupsChattiness: clear });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal("telegramGroupsChattiness" in (await stored()), false, `${JSON.stringify(clear)} did not clear`);
    }
  });

  it("a bad level refuses the whole save — the switches beside it are not half-applied", async () => {
    const res = await put({ telegramGroupsEnabled: false, telegramGroupCoinsEnabled: false, telegramGroupsChattiness: "rowdy" });
    assert.equal(res.status, 400);
    const s = await stored();
    assert.equal("telegramGroupsEnabled" in s, false);
    assert.equal("telegramGroupCoinsEnabled" in s, false);
  });
});

describe("the three together, as the Settings screen saves them", () => {
  it("all three land in one save, and GET reads them back with core's defaults beside them", async () => {
    const res = await put({ telegramGroupsEnabled: false, telegramGroupCoinsEnabled: false, telegramGroupsChattiness: "quiet" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ignored, undefined);
    const s = await stored();
    assert.equal(s.telegramGroupsEnabled, false);
    assert.equal(s.telegramGroupCoinsEnabled, false);
    assert.equal(s.telegramGroupsChattiness, "quiet");

    const view = (await (await GET(new Request("https://app.example.test/api/settings", { headers: { cookie: cookie() } }))).json()) as {
      values: Record<string, unknown>;
      defaults: Record<string, unknown>;
    };
    assert.equal(view.values.telegramGroupsEnabled, false);
    assert.equal(view.values.telegramGroupCoinsEnabled, false);
    assert.equal(view.values.telegramGroupsChattiness, "quiet");
    assert.equal(view.defaults.telegramGroupsEnabled, true);
    assert.equal(view.defaults.telegramGroupCoinsEnabled, true);
    assert.equal(view.defaults.telegramGroupsChattiness, "normal");
  });

  it("are a tenant's to set hosted: not stripped as house keys, not masked as secrets", () => {
    for (const k of ["telegramGroupsEnabled", "telegramGroupCoinsEnabled", "telegramGroupsChattiness"]) {
      assert.ok(!(HOSTED_FORBIDDEN_SETTING_FIELDS as readonly string[]).includes(k), `${k} would be silently stripped hosted`);
      assert.ok(!(SECRET_SETTING_KEYS as readonly string[]).includes(k), `${k} would be masked`);
    }
    assert.equal(SETTINGS_DEFAULTS.telegramGroupsChattiness, "normal");
  });

  it("the web room's reserved name is not a key here — the reserved spelling is refused as unknown", async () => {
    // telegramGroupsChattiness is spelled with "Groups" so the worker's
    // boundary test never trips on it. The other spelling is not a setting.
    const wrong = ["telegram", "Group", "Chattiness"].join("");
    const res = await put({ [wrong]: "chatty" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.ignored, [wrong]);
    assert.equal(wrong in (await stored()), false);
  });
});

describe("the settings view other surfaces read (lib/services/settings-view.ts)", () => {
  it("lists the three under telegram, with core's defaults for keys never stored", () => {
    const v = projectSettings({})!;
    assert.equal(v.telegram.groupsEnabled, true, "absent reads as on — the default is on");
    assert.equal(v.telegram.groupCoinsEnabled, true);
    assert.equal(v.telegram.groupsChattiness, null, "never stored: the worker's default applies");
  });

  it("reads what the owner stored", () => {
    const v = projectSettings({ telegramGroupsEnabled: false, telegramGroupCoinsEnabled: false, telegramGroupsChattiness: "chatty" })!;
    assert.equal(v.telegram.groupsEnabled, false);
    assert.equal(v.telegram.groupCoinsEnabled, false);
    assert.equal(v.telegram.groupsChattiness, "chatty");
  });

  it("a level the worker would not honour is shown as null, never passed through", () => {
    for (const bad of ["loud", "CHATTY", 3, true, { level: "quiet" }]) {
      assert.equal(projectSettings({ telegramGroupsChattiness: bad })!.telegram.groupsChattiness, null, JSON.stringify(bad));
    }
  });

  it("still carries nothing secret from the Telegram block", () => {
    const v = projectSettings({ telegramBotToken: "123456:SECRET", telegramAllowlist: [42], telegramGroupsEnabled: true })!;
    const raw = JSON.stringify(v);
    assert.equal(raw.includes("SECRET"), false);
    assert.equal(raw.includes("42"), false);
  });
});
