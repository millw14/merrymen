import assert from "node:assert/strict";
import { test } from "node:test";
import { runFundingIntent } from "./perps-funding-intent";
const hash = `0x${"12".repeat(32)}` as const;
function setup() {
 const data = new Map<string, string>();
 let sends = 0, prepared = 0;
 const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
 const args = { storage, key: "fund", source: "spot", target: "perps", amountMicro: "1234567",
  prepare: async () => { prepared++; return { hash, send: async () => { sends++; assert.equal(JSON.parse(data.get("fund")!).state, "submitting"); return hash; } }; },
  receipt: async () => "pending" as const };
 return { args, data, count: () => ({ sends, prepared }) };
}
test("journal is durable before submission and reopening only checks the existing operation", async () => {
 const s = setup();
 assert.deepEqual(await runFundingIntent(s.args), { hash, status: "submitted" });
 assert.deepEqual(await runFundingIntent({ ...s.args, receipt: async () => "confirmed" }), { hash, status: "confirmed" });
 assert.deepEqual(s.count(), { sends: 1, prepared: 1 });
});
test("a lost bundler response remains pending across a reload, without rebroadcast", async () => {
 const s = setup(); let sends = 0;
 const args = { ...s.args, prepare: async () => ({ hash, send: async () => { sends++; throw new Error("connection lost"); } }) };
 assert.equal((await runFundingIntent(args)).status, "submitted");
 await runFundingIntent(args);
 assert.equal(sends, 1);
 assert.equal(JSON.parse(s.data.get("fund")!).state, "submitting");
});
test("storage failure cannot broadcast; different amount cannot reuse pending confirmation", async () => {
 const s = setup();
 await assert.rejects(runFundingIntent({ ...s.args, storage: { ...s.args.storage, setItem: () => { throw new Error("quota"); } } }), /quota/);
 assert.equal(s.count().sends, 0);
 await runFundingIntent(s.args);
 await assert.rejects(runFundingIntent({ ...s.args, amountMicro: "999" }), /previous funding/);
 assert.equal(s.count().sends, 1);
});
test("a failed receipt is never confirmed or automatically resent", async () => {
 const s = setup();
 await assert.rejects(runFundingIntent({ ...s.args, receipt: async () => "reverted" }), /reverted/);
 assert.equal(s.count().sends, 1);
 assert.equal(JSON.parse(s.data.get("fund")!).state, "reverted");
});

test("failed checks after an owner prompt never journal a transfer that cannot be broadcast", async () => {
 const s = setup();
 await assert.rejects(runFundingIntent({ ...s.args, prepare: async () => { throw new Error("login changed after signing"); } }), /login changed/);
 assert.equal(s.data.has("fund"), false);
 assert.equal(s.count().sends, 0);
});
