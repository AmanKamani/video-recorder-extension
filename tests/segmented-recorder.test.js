import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeBase64Chunk,
  isSegmentJobReadyToFinalize,
  isSegmentMessageForJob,
  segmentEventNeedsWriteBarrier,
  segmentFilesInTimelineOrder,
  shouldApplySegmentDetail,
} from "../modules/segmented-recorder.js";
import * as segmentedRecorder from "../modules/segmented-recorder.js";

test("decodes relayed segment bytes without sharing mutable buffers", () => {
  const bytes = decodeBase64Chunk("AQID");
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("rejects stale jobs and unknown segments", () => {
  const job = {
    jobId: "job-a",
    segments: [{ id: "segment-1" }, { id: "segment-2" }],
  };
  assert.equal(isSegmentMessageForJob(job, { jobId: "job-a", segmentId: "segment-2" }), true);
  assert.equal(isSegmentMessageForJob(job, { jobId: "job-b", segmentId: "segment-2" }), false);
  assert.equal(isSegmentMessageForJob(job, { jobId: "job-a", segmentId: "segment-9" }), false);
});

test("does not let delayed progress regress a terminal segment state", () => {
  assert.equal(shouldApplySegmentDetail("finished", "recording"), false);
  assert.equal(shouldApplySegmentDetail("failed", "recording"), false);
  assert.equal(shouldApplySegmentDetail("incompatible", "recording"), false);
  assert.equal(shouldApplySegmentDetail("recording", "recording"), true);
  assert.equal(shouldApplySegmentDetail("finished", "finished"), true);
});

test("waits for every segment finish event before finalizing an acknowledged page job", () => {
  const job = {
    pageFinishedDetail: { durationMs: 120000 },
    segments: [{ state: "finished" }, { state: "recording" }],
  };
  assert.equal(isSegmentJobReadyToFinalize(job), false);

  job.segments[1].state = "finished";
  assert.equal(isSegmentJobReadyToFinalize(job), true);
  assert.equal(isSegmentJobReadyToFinalize({ ...job, pageFinishedDetail: null }), false);
});

test("relays live segment status immediately while preserving terminal write barriers", () => {
  assert.equal(segmentEventNeedsWriteBarrier("segment-status"), false);
  assert.equal(segmentEventNeedsWriteBarrier("segment-progress"), false);
  assert.equal(segmentEventNeedsWriteBarrier("segment-finished"), true);
  assert.equal(segmentEventNeedsWriteBarrier("segment-failed"), true);
  assert.equal(segmentEventNeedsWriteBarrier("job-finished"), true);
});

test("orders temporary segment handles by timeline rather than completion order", () => {
  const job = {
    segments: [
      { id: "segment-2", index: 1, fileHandle: { name: "second.webm" } },
      { id: "segment-1", index: 0, fileHandle: { name: "first.webm" } },
    ],
  };
  assert.deepEqual(
    segmentFilesInTimelineOrder(job).map((handle) => handle.name),
    ["first.webm", "second.webm"],
  );
});

test("reinstalling the page bridge deactivates the stale extension-context listener", () => {
  assert.equal(typeof segmentedRecorder.installSegmentPageBridge, "function");
  // Tracks listener replacement without requiring a browser window implementation.
  const listeners = new Set();
  const fakeWindow = {
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
    postMessage() {},
  };
  const originalWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    segmentedRecorder.installSegmentPageBridge();
    const firstListener = [...listeners][0];
    segmentedRecorder.installSegmentPageBridge();

    assert.equal(listeners.size, 1);
    assert.notEqual([...listeners][0], firstListener);
    assert.doesNotThrow(() =>
      firstListener({
        source: fakeWindow,
        data: {
          channel: "hls-side-panel-segment-recorder-v2",
          type: "segment-progress",
        },
      }),
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("resetting one segment writer truncates only that segment file", async () => {
  assert.equal(typeof segmentedRecorder.resetSegmentWriter, "function");
  const files = new Map();
  // Emulates persistent file handles while exposing the current bytes for assertions.
  const makeHandle = (name) => {
    let bytes = new Uint8Array([1, 2, 3]);
    return {
      name,
      async getFile() {
        return new Blob([bytes]);
      },
      async createWritable() {
        return {
          async truncate(size) {
            bytes = bytes.slice(0, size);
          },
          async write(next) {
            bytes = new Uint8Array(next);
          },
          async close() {},
          async abort() {},
        };
      },
    };
  };
  const directory = {
    async getFileHandle(name) {
      if (!files.has(name)) files.set(name, makeHandle(name));
      return files.get(name);
    },
  };
  const first = { id: "segment-1" };
  const second = { id: "segment-2" };
  second.fileHandle = await directory.getFileHandle("segment-2.webm");

  await segmentedRecorder.resetSegmentWriter(directory, first);

  assert.equal((await first.fileHandle.getFile()).size, 0);
  assert.equal((await second.fileHandle.getFile()).size, 3);
  assert.equal(first.expectedSequence, 0);
  assert.equal(first.bytes, 0);
});

test("suppresses segment-finished relay when its final chunk write fails", async () => {
  // Couples a minimal page bridge with a failing runtime relay to exercise write ordering.
  const listeners = new Set();
  const posted = [];
  const sent = [];
  const fakeWindow = {
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
    postMessage(message) {
      posted.push(message);
    },
  };
  const originalWindow = globalThis.window;
  const originalChrome = globalThis.chrome;
  globalThis.window = fakeWindow;
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (message.type === "HLS_SIDEPANEL_SEGMENT_CHUNK") {
          throw new Error("writer failed");
        }
        return { ok: true };
      },
    },
  };
  try {
    segmentedRecorder.installSegmentPageBridge();
    const listener = [...listeners][0];
    const base = {
      source: fakeWindow,
      data: {
        channel: "hls-side-panel-segment-recorder-v2",
        jobId: "job-a",
        segmentId: "segment-1",
      },
    };
    listener({
      ...base,
      data: {
        ...base.data,
        type: "segment-chunk",
        sequence: 0,
        blob: new Blob([new Uint8Array([1, 2, 3])]),
      },
    });
    listener({ ...base, data: { ...base.data, type: "segment-finished", detail: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(
      sent.some((message) => message.eventType === "segment-finished"),
      false,
    );
    assert.equal(
      posted.some((message) => message.type === "segment-write-failed"),
      true,
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test("classifies track mismatches for segment retry and other failures for merge retry", () => {
  assert.equal(typeof segmentedRecorder.classifyMergeFailure, "function");
  const segments = [{ id: "segment-1" }, { id: "segment-2" }];
  const mismatch = Object.assign(new Error("mismatch"), {
    code: "INCOMPATIBLE_WEBM_TRACKS",
    incompatibleSegmentIndexes: [1],
  });
  assert.deepEqual(segmentedRecorder.classifyMergeFailure(mismatch, segments), {
    state: "retryable",
    incompatibleSegmentIds: ["segment-2"],
  });
  assert.deepEqual(segmentedRecorder.classifyMergeFailure(new Error("disk busy"), segments), {
    state: "merge_failed",
    incompatibleSegmentIds: [],
  });
  const invalid = Object.assign(new Error("truncated"), {
    code: "INVALID_WEBM_SEGMENT",
    segmentIndex: 0,
  });
  assert.deepEqual(segmentedRecorder.classifyMergeFailure(invalid, segments), {
    state: "retryable",
    incompatibleSegmentIds: ["segment-1"],
  });
});
