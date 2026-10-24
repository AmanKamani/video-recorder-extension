import test from "node:test";
import assert from "node:assert/strict";

import { calculateSegmentRanges, formatMediaTime } from "../modules/segment-ranges.js";
import { SEGMENT_CONFIG } from "../modules/config.js";

test("splits a VOD timeline into contiguous equal ranges with an exact final boundary", () => {
  const ranges = calculateSegmentRanges(10, 3);

  assert.equal(ranges.length, 3);
  assert.deepEqual(
    ranges.map(({ id, index }) => ({ id, index })),
    [
      { id: "segment-1", index: 0 },
      { id: "segment-2", index: 1 },
      { id: "segment-3", index: 2 },
    ],
  );
  assert.equal(ranges[0].startTime, 0);
  assert.equal(ranges[2].endTime, 10);
  assert.equal(ranges[0].endTime, ranges[1].startTime);
  assert.equal(ranges[1].endTime, ranges[2].startTime);
  assert.ok(Math.abs(ranges[0].duration - 10 / 3) < Number.EPSILON * 10);
});

test("supports the configured maximum split without gaps or overlaps", () => {
  const ranges = calculateSegmentRanges(83.125, SEGMENT_CONFIG.maxSegments);

  assert.equal(ranges.length, SEGMENT_CONFIG.maxSegments);
  for (let index = 1; index < ranges.length; index += 1) {
    assert.equal(ranges[index - 1].endTime, ranges[index].startTime);
  }
  assert.equal(ranges.at(-1).endTime, 83.125);
});

test("rejects timelines and counts that cannot represent finite VOD segments", () => {
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => calculateSegmentRanges(duration, 2), /finite VOD duration/i);
  }
  for (const count of [0, 1.5, SEGMENT_CONFIG.maxSegments + 1]) {
    assert.throws(
      () => calculateSegmentRanges(60, count),
      new RegExp(`between 1 and ${SEGMENT_CONFIG.maxSegments}`, "i"),
    );
  }
});

test("formats media timestamps without changing calculation precision", () => {
  assert.equal(formatMediaTime(0), "00:00");
  assert.equal(formatMediaTime(65.9), "01:05");
  assert.equal(formatMediaTime(3661), "01:01:01");
});
