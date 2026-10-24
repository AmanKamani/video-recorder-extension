import test from "node:test";
import assert from "node:assert/strict";

import {
  createSegmentJobState,
  getAggregateTransition,
  updateSegmentState,
} from "../modules/segment-job-state.js";
import * as segmentJobState from "../modules/segment-job-state.js";

const ranges = [
  { id: "segment-1", index: 0, startTime: 0, endTime: 30, duration: 30 },
  { id: "segment-2", index: 1, startTime: 30, endTime: 60, duration: 30 },
];

test("becomes ready and mergeable only after every segment reaches the required barrier", () => {
  let job = createSegmentJobState({ jobId: "job-a", tabId: 7, ranges });
  job = updateSegmentState(job, "segment-1", "ready");
  assert.equal(getAggregateTransition(job), "preparing");
  job = updateSegmentState(job, "segment-2", "ready");
  assert.equal(getAggregateTransition(job), "ready");

  job = updateSegmentState(job, "segment-1", "recording");
  job = updateSegmentState(job, "segment-2", "recording");
  assert.equal(getAggregateTransition(job), "recording");
  job = updateSegmentState(job, "segment-1", "finished");
  assert.equal(getAggregateTransition(job), "recording");
  job = updateSegmentState(job, "segment-2", "finished");
  assert.equal(getAggregateTransition(job), "merging");
});

test("one failed segment fails the aggregate job and preserves its diagnostic", () => {
  const initial = createSegmentJobState({ jobId: "job-a", tabId: 7, ranges });
  const failed = updateSegmentState(initial, "segment-2", "failed", {
    error: "MediaRecorder stopped unexpectedly",
  });

  assert.equal(getAggregateTransition(failed), "retryable");
  assert.equal(failed.error.segmentId, "segment-2");
  assert.match(failed.error.message, /unexpectedly/);
  assert.equal(initial.segments[1].state, "preparing");
});

test("retries failed and incompatible segments without resetting finished segments", () => {
  let job = createSegmentJobState({ jobId: "job-a", tabId: 7, ranges });
  job = updateSegmentState(job, "segment-1", "ready");
  job = updateSegmentState(job, "segment-2", "ready");
  job = updateSegmentState(job, "segment-1", "recording");
  job = updateSegmentState(job, "segment-2", "recording");
  job = updateSegmentState(job, "segment-1", "finished");
  job = updateSegmentState(job, "segment-2", "failed", { error: "stalled" });
  assert.equal(job.state, "retryable");

  job = updateSegmentState(job, "segment-2", "recording", { error: null, progress: 0 });
  assert.equal(job.state, "recording");
  assert.equal(job.segments[0].state, "finished");
  job = updateSegmentState(job, "segment-2", "finished");
  assert.equal(job.state, "merging");

  job = updateSegmentState(job, "segment-2", "incompatible", { error: "track mismatch" });
  assert.equal(job.state, "retryable");
  job = updateSegmentState(job, "segment-2", "recording", { error: null, progress: 0 });
  assert.equal(job.state, "recording");
});

test("rejects stale segment IDs and illegal state transitions", () => {
  const job = createSegmentJobState({ jobId: "job-a", tabId: 7, ranges });

  assert.throws(() => updateSegmentState(job, "missing", "ready"), /unknown segment/i);
  assert.throws(() => updateSegmentState(job, "segment-1", "finished"), /cannot transition/i);
});

test("jobs in different tabs retain independent state", () => {
  const first = updateSegmentState(
    createSegmentJobState({ jobId: "job-a", tabId: 7, ranges }),
    "segment-1",
    "ready",
  );
  const second = createSegmentJobState({ jobId: "job-b", tabId: 8, ranges });

  assert.equal(first.segments[0].state, "ready");
  assert.equal(second.segments[0].state, "preparing");
  assert.notEqual(first.jobId, second.jobId);
});

test("allows retry as soon as one segment fails while its job is still recording", () => {
  assert.equal(typeof segmentJobState.canRetrySegment, "function");
  assert.equal(segmentJobState.canRetrySegment("recording", "failed"), true);
  assert.equal(segmentJobState.canRetrySegment("retryable", "failed"), true);
  assert.equal(segmentJobState.canRetrySegment("retryable", "incompatible"), true);
  assert.equal(segmentJobState.canRetrySegment("completed", "failed"), false);
  assert.equal(segmentJobState.canRetrySegment("recording", "finished"), false);
});
