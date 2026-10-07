import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART, SAMPLE_ENTRIES, SAMPLE_TICKS, sampleDomain, sampleTime, sampleXY } from "./chart-model";

test("sample entry markers use the matching timestamp and price tick", () => {
  const domain = sampleDomain(SAMPLE_TICKS);
  for (const entry of SAMPLE_ENTRIES) {
    const tick = SAMPLE_TICKS.find((point) => point.at === entry.at);
    assert.ok(tick, `missing chart tick for ${entry.agent}`);
    assert.equal(tick.price, entry.price);
    assert.deepEqual(sampleXY(entry.at, entry.price, domain), sampleXY(tick.at, tick.price, domain));
    const { x, y } = sampleXY(entry.at, entry.price, domain);
    assert.ok(x >= CHART.left && x <= CHART.width - CHART.right);
    assert.ok(y >= CHART.top && y <= CHART.height - CHART.bottom);
  }
  assert.equal(sampleTime(SAMPLE_ENTRIES[0]!.at), "09:35");
  assert.equal(sampleTime(SAMPLE_ENTRIES[1]!.at), "11:00");
});

test("time and price axes map independently and in the correct directions", () => {
  const domain = sampleDomain(SAMPLE_TICKS);
  assert.equal(sampleXY(domain.minTime, domain.minPrice, domain).x, CHART.left);
  assert.equal(sampleXY(domain.maxTime, domain.minPrice, domain).x, CHART.width - CHART.right);
  assert.equal(sampleXY(domain.minTime, domain.maxPrice, domain).y, CHART.top);
  assert.equal(sampleXY(domain.minTime, domain.minPrice, domain).y, CHART.height - CHART.bottom);
  assert.ok(sampleXY(SAMPLE_TICKS[0]!.at, SAMPLE_TICKS[0]!.price, domain).x < sampleXY(SAMPLE_TICKS[1]!.at, SAMPLE_TICKS[1]!.price, domain).x);
});
