import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readTheses } from "./read-theses";

test("profile posts resolve mixed-case accounts and retain posts older than the global feed", async () => {
  const raw = new DatabaseSync(":memory:"); const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, mode TEXT);
      CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, size_usdg REAL, source TEXT, reason TEXT, dropped_rule TEXT, hold_kind TEXT, at INTEGER);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, status TEXT, reject_rule TEXT);
      CREATE TABLE posts(decision_id TEXT, body TEXT);
      INSERT INTO agents VALUES ('0xABC','SirSendIt',NULL,'live');`);
    await db.prepare("INSERT INTO decisions VALUES ('d','0xABC','hold','USAR',NULL,'brain','Watching the price range before entering.',NULL,NULL,?)").run(Math.floor(Date.now()/1000)-172800);
    const identities = async () => [{tenant:'0x1' as const, slug:'ems76d3cncwbt3dz', accounts:['0xabc' as const], createdAt:1, updatedAt:1}];
    const settings = async () => ({ strategy: 'trencher' as const, trencherFastEnabled: true, groqApiKey: 'must-not-be-public' });
    const global = await readTheses({}, fn => fn(db), identities, settings);
    assert.equal(global.theses.length, 0);
    const profile = await readTheses({agentSlug:'ems76d3cncwbt3dz'}, fn => fn(db), identities, settings);
    assert.equal(profile.theses.length, 1);
    assert.equal(profile.theses[0].symbol, 'USAR');
    assert.equal(profile.theses[0].slug, 'ems76d3cncwbt3dz');
    assert.equal(profile.theses[0].trencher, true);
    assert.ok(!JSON.stringify(profile).includes('must-not-be-public'));
    const switched = await readTheses({agentSlug:'ems76d3cncwbt3dz'}, fn => fn(db), identities, async () => ({ strategy: 'steady-basket', trencherFastEnabled: true }));
    assert.equal(switched.theses[0].trencher, false, 'an inactive saved toggle does not identify the current strategy');
    const unavailable = await readTheses({agentSlug:'ems76d3cncwbt3dz'}, fn => fn(db), identities, async () => { throw new Error('unavailable'); });
    assert.equal(unavailable.theses.length, 1);
    assert.equal(unavailable.theses[0].trencher, false);
    assert.equal((await readTheses({agentSlug:'another-agent'}, fn => fn(db), identities)).theses.length, 0);
  } finally { raw.close(); }
});
