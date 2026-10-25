import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSegmentRenderModel,
  getSegmentedTimerText,
  normalizeSegmentCount,
} from "../modules/segment-ui.js";
import * as segmentUi from "../modules/segment-ui.js";
import { SEGMENT_CONFIG } from "../modules/config.js";

test("normalizes slider values to the supported whole-number range", () => {
  assert.equal(normalizeSegmentCount("4"), 4);
  assert.equal(normalizeSegmentCount(0), 1);
  assert.equal(normalizeSegmentCount(SEGMENT_CONFIG.maxSegments + 2), SEGMENT_CONFIG.maxSegments);
  assert.equal(normalizeSegmentCount(3.7), 4);
});

test("uses a stored quality-lock boolean and otherwise keeps the configured default", () => {
  assert.equal(typeof segmentUi.normalizeQualityLockPreference, "function");
  const normalizeQualityLockPreference = segmentUi.normalizeQualityLockPreference;
  assert.equal(normalizeQualityLockPreference(false, true), false);
  assert.equal(normalizeQualityLockPreference(true, false), true);
  assert.equal(normalizeQualityLockPreference(undefined, true), true);
  assert.equal(normalizeQualityLockPreference("false", true), true);
});

test("shows running wall time and freezes it after segmented recording ends", () => {
  assert.equal(getSegmentedTimerText({ state: "recording", startedAt: 1_000 }, 66_000), "01:05");
  assert.equal(
    getSegmentedTimerText({ state: "merging", startedAt: 1_000, recordingEndedAt: 31_000 }, 90_000),
    "00:30",
  );
  assert.equal(getSegmentedTimerText({ state: "ready" }, 90_000), "00:00");
});

test("derives busy controls from the selected tab's own segmented job", () => {
  assert.equal(typeof segmentUi.isSegmentJobBusy, "function");
  assert.equal(segmentUi.isSegmentJobBusy(null), false);
  assert.equal(segmentUi.isSegmentJobBusy({ state: "ready" }), false);
  assert.equal(segmentUi.isSegmentJobBusy({ state: "recording" }), true);
  assert.equal(segmentUi.isSegmentJobBusy({ state: "merging" }), true);
  assert.equal(segmentUi.isSegmentJobBusy({ state: "repairing" }), true);
});

test("builds timestamp, duration, progress, and state labels for every segment", () => {
  const model = buildSegmentRenderModel({
    state: "recording",
    segments: [
      {
        id: "segment-1",
        index: 0,
        startTime: 0,
        endTime: 65,
        duration: 65,
        progress: 0.5,
        state: "recording",
      },
      {
        id: "segment-2",
        index: 1,
        startTime: 65,
        endTime: 130,
        duration: 65,
        progress: 1,
        state: "finished",
      },
    ],
  });

  assert.deepEqual(model[0], {
    id: "segment-1",
    title: "Segment 1",
    range: "00:00 → 01:05",
    duration: "01:05",
    progress: 0.5,
    percent: 50,
    state: "Recording",
    error: null,
    canRetry: false,
  });
  assert.equal(model[1].state, "Finished");
  assert.equal(model[1].percent, 100);
});

test("surfaces a failed segment reason without exposing unrelated job internals", () => {
  const model = buildSegmentRenderModel({
    state: "retryable",
    segments: [
      {
        id: "segment-1",
        index: 0,
        startTime: 0,
        endTime: 10,
        duration: 10,
        progress: 0.2,
        state: "failed",
        error: "Network stopped",
      },
    ],
  });

  assert.equal(model[0].state, "Failed");
  assert.equal(model[0].error, "Network stopped");
  assert.equal(model[0].canRetry, true);
});

test("offers row retry for incompatible segments but not completed segments", () => {
  const model = buildSegmentRenderModel({
    state: "retryable",
    segments: [
      { id: "segment-1", index: 0, state: "finished", progress: 1 },
      { id: "segment-2", index: 1, state: "incompatible", progress: 1 },
    ],
  });
  assert.equal(model[0].canRetry, false);
  assert.equal(model[1].canRetry, true);
  assert.equal(
    buildSegmentRenderModel({
      state: "recording",
      segments: [{ id: "segment-3", index: 2, state: "failed", progress: 0.3 }],
    })[0].canRetry,
    true,
  );
});

test("updates an existing segment row instead of rebuilding the list", () => {
  // Models only the DOM ownership operations needed to verify row identity across renders.
  class FakeElement {
    constructor() {
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.parent = null;
      this.hidden = false;
      this.disabled = false;
      this.textContent = "";
      this.className = "";
    }
    append(...children) {
      for (const child of children) {
        if (child.parent) {
          child.parent.children = child.parent.children.filter((item) => item !== child);
        }
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...children);
    }
    addEventListener() {}
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    remove() {
      if (this.parent) {
        this.parent.children = this.parent.children.filter((item) => item !== this);
      }
      this.parent = null;
    }
  }
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() };
  try {
    const list = new FakeElement();
    const summary = new FakeElement();
    const ui = segmentUi.createSegmentUi({
      countInput: null,
      countValue: null,
      countHint: null,
      applyButton: null,
      qualityLockInput: null,
      list,
      summary,
      injectButton: null,
      startButton: null,
      stopButton: null,
      removeButton: null,
    });
    const job = {
      state: "recording",
      segments: [
        {
          id: "segment-1",
          index: 0,
          startTime: 0,
          endTime: 10,
          duration: 10,
          progress: 0.1,
          state: "recording",
        },
      ],
    };
    ui.renderJob(job);
    const firstRow = list.children[0];
    job.segments[0].progress = 0.5;
    ui.renderJob(job);

    assert.equal(list.children.length, 1);
    assert.equal(list.children[0], firstRow);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
