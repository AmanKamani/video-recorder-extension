const SEGMENT_TRANSITIONS = Object.freeze({
  preparing: new Set(["ready", "failed", "cancelled"]),
  ready: new Set(["recording", "failed", "cancelled"]),
  recording: new Set(["finished", "failed", "cancelled"]),
  finished: new Set(["incompatible"]),
  failed: new Set(["recording"]),
  incompatible: new Set(["recording"]),
  cancelled: new Set(),
});

/** Creates an immutable-value job snapshot from calculated ranges. */
export function createSegmentJobState({ jobId, tabId, ranges }) {
  if (!jobId || !Number.isInteger(tabId) || !Array.isArray(ranges) || !ranges.length) {
    throw new Error("A job ID, tab ID, and at least one range are required.");
  }
  return {
    jobId,
    tabId,
    state: "preparing",
    error: null,
    createdAt: Date.now(),
    segments: ranges.map((range) => ({
      ...range,
      state: "preparing",
      progress: 0,
      error: null,
    })),
  };
}

/** Returns a new job snapshot after validating one segment state transition. */
export function updateSegmentState(job, segmentId, nextState, patch = {}) {
  const index = job.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) throw new Error(`Unknown segment: ${segmentId}`);
  const current = job.segments[index];
  if (!SEGMENT_TRANSITIONS[current.state]?.has(nextState)) {
    throw new Error(`Cannot transition ${segmentId} from ${current.state} to ${nextState}.`);
  }

  const segment = {
    ...current,
    ...patch,
    id: current.id,
    state: nextState,
  };
  const segments = job.segments.map((item, itemIndex) => (itemIndex === index ? segment : item));
  const error =
    nextState === "failed"
      ? {
          segmentId,
          message: patch.error || patch.message || "Segment failed.",
        }
      : job.error;
  const updated = { ...job, segments, error };
  return { ...updated, state: getAggregateTransition(updated) };
}

/** Derives the aggregate state from all segment states. */
export function getAggregateTransition(job) {
  if (job.segments.some((segment) => segment.state === "cancelled")) return "cancelled";
  if (job.segments.every((segment) => segment.state === "finished")) return "merging";
  if (job.segments.every((segment) => segment.state === "ready")) return "ready";
  if (job.segments.some((segment) => segment.state === "recording")) return "recording";
  if (job.segments.some((segment) => ["failed", "incompatible"].includes(segment.state))) {
    return "retryable";
  }
  if (job.segments.some((segment) => segment.state === "finished")) return "recording";
  return "preparing";
}

/** Allows a failed segment to be retried before the rest of its job finishes. */
export function canRetrySegment(jobState, segmentState) {
  return (
    ["recording", "retryable"].includes(jobState) &&
    ["failed", "incompatible"].includes(segmentState)
  );
}
