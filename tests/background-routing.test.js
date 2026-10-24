import test from "node:test";
import assert from "node:assert/strict";

import { toSegmentPanelMessage } from "../modules/segment-message-routing.js";

test("routes segment chunks without losing job, segment, sequence, or bytes", () => {
  assert.deepEqual(
    toSegmentPanelMessage({
      type: "HLS_SIDEPANEL_SEGMENT_CHUNK",
      jobId: "job-a",
      segmentId: "segment-2",
      sequence: 4,
      base64: "AQI=",
    }),
    {
      type: "HLS_SIDEPANEL_SEGMENT_CHUNK_PANEL",
      jobId: "job-a",
      segmentId: "segment-2",
      sequence: 4,
      base64: "AQI=",
    },
  );
});

test("routes progress and terminal events as panel events", () => {
  assert.deepEqual(
    toSegmentPanelMessage({
      type: "HLS_SIDEPANEL_SEGMENT_EVENT",
      eventType: "job-finished",
      jobId: "job-a",
      segmentId: null,
      detail: { durationMs: 1000 },
    }),
    {
      type: "HLS_SIDEPANEL_SEGMENT_EVENT_PANEL",
      eventType: "job-finished",
      jobId: "job-a",
      segmentId: null,
      detail: { durationMs: 1000 },
    },
  );
});

test("does not route unrelated messages", () => {
  assert.equal(toSegmentPanelMessage({ type: "OTHER" }), null);
});
