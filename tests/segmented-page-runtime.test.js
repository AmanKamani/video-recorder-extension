import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSafeStreamMetadata,
  calculateFixedTestRanges,
  calculateSegmentProgress,
  clampOverlayPosition,
  deriveTargetHeight,
  getRecorderStateAction,
  getTransientRecordingState,
  isCurrentSegmentJob,
  selectLevelForHeight,
  shouldStopAtBoundary,
} from "../modules/segmented-page-runtime.js";
import * as segmentedPageRuntime from "../modules/segmented-page-runtime.js";

test("builds detailed stream metadata without retaining URLs, keys, or media payloads", () => {
  const metadata = buildSafeStreamMetadata({
    hlsVersion: "1.6.0",
    duration: 180,
    videoWidth: 1920,
    videoHeight: 1080,
    levels: [
      {
        name: "1080p",
        width: 1920,
        height: 1080,
        bitrate: 5_000_000,
        videoCodec: "avc1.640028",
        url: "https://cdn.example/video.m3u8?token=secret",
        details: { live: false, totalduration: 180, fragments: [{ url: "secret.ts" }] },
      },
    ],
    audioTracks: [{ id: 2, name: "English", lang: "en", default: true, url: "secret-audio.m3u8" }],
    subtitleTracks: [{ id: 3, name: "English", lang: "en", forced: false }],
    quality: { locked: true, targetHeight: 1080 },
  });

  assert.equal(metadata.levels[0].height, 1080);
  assert.equal(metadata.levels[0].details.fragmentCount, 1);
  assert.equal(metadata.audioTracks[0].lang, "en");
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
});

test("derives the highest advertised stream height and falls back to configured 720p", () => {
  assert.equal(
    deriveTargetHeight(
      [{ height: 480 }, { attrs: { RESOLUTION: "1280x720" } }, { height: 1080 }],
      720,
    ),
    1080,
  );
  assert.equal(deriveTargetHeight([{ bitrate: 2_000_000 }], 720), 720);
});

test("selects the closest HLS level to the locked target height", () => {
  const levels = [{ height: 360 }, { attrs: { RESOLUTION: "1280x720" } }, { height: 1080 }];
  assert.equal(selectLevelForHeight(levels, 720), 1);
  assert.equal(selectLevelForHeight([{ bitrate: 1_000_000 }], 720), -1);
});

test("accepts one through the configured maximum as managed segment counts", () => {
  assert.equal(typeof segmentedPageRuntime.isManagedSegmentCount, "function");
  assert.equal(segmentedPageRuntime.isManagedSegmentCount(1, 15), true);
  assert.equal(segmentedPageRuntime.isManagedSegmentCount(15, 15), true);
  assert.equal(segmentedPageRuntime.isManagedSegmentCount(0, 15), false);
  assert.equal(segmentedPageRuntime.isManagedSegmentCount(16, 15), false);
});

test("accepts codec padding near the locked rendition but rejects another quality", () => {
  assert.equal(typeof segmentedPageRuntime.matchesLockedQualityDimensions, "function");
  const matchesLockedQualityDimensions = segmentedPageRuntime.matchesLockedQualityDimensions;
  const quality = { width: 1920, height: 1080 };
  assert.equal(matchesLockedQualityDimensions(1920, 1082, quality, 4), true);
  assert.equal(matchesLockedQualityDimensions(1920, 1080, quality, 4), true);
  assert.equal(matchesLockedQualityDimensions(1280, 720, quality, 4), false);
  assert.equal(matchesLockedQualityDimensions(0, 0, quality, 4), false);
});

test("allows the canonical segment to replace an inaccurate advertised width", () => {
  const matches = segmentedPageRuntime.matchesLockedQualityDimensions;
  const advertised = { width: 1280, height: 720 };

  assert.equal(matches(1152, 720, advertised, 4, false), true);
  assert.equal(matches(1152, 720, advertised, 4, true), false);

  const canonicalDecoded = { width: 1152, height: 720 };
  assert.equal(matches(1152, 720, canonicalDecoded, 4, true), true);
  assert.equal(matches(1280, 720, canonicalDecoded, 4, true), false);
});

test("builds three contiguous one-minute ranges for temporary merge testing", () => {
  assert.deepEqual(calculateFixedTestRanges(7200, 3, 60), [
    { id: "segment-1", index: 0, startTime: 0, endTime: 60, duration: 60 },
    { id: "segment-2", index: 1, startTime: 60, endTime: 120, duration: 60 },
    { id: "segment-3", index: 2, startTime: 120, endTime: 180, duration: 60 },
  ]);
  assert.throws(() => calculateFixedTestRanges(120, 3, 60), /at least 180 seconds/i);
});

test("keeps a dragged overlay inside the viewport", () => {
  assert.deepEqual(
    clampOverlayPosition({ left: -20, top: 900, width: 300, height: 200 }, 1000, 800),
    { left: 0, top: 600 },
  );
  assert.deepEqual(
    clampOverlayPosition({ left: 250, top: 100, width: 300, height: 200 }, 1000, 800),
    { left: 250, top: 100 },
  );
});

test("stops a segment at or beyond its assigned media end", () => {
  assert.equal(shouldStopAtBoundary(19.999, 20), false);
  assert.equal(shouldStopAtBoundary(20, 20), true);
  assert.equal(shouldStopAtBoundary(20.01, 20), true);
});

test("clamps progress to the segment range", () => {
  assert.equal(calculateSegmentProgress(10, 10, 20), 0);
  assert.equal(calculateSegmentProgress(15, 10, 20), 0.5);
  assert.equal(calculateSegmentProgress(25, 10, 20), 1);
});

test("accepts events only for the current page job", () => {
  assert.equal(isCurrentSegmentJob({ jobId: "job-a" }, "job-a"), true);
  assert.equal(isCurrentSegmentJob({ jobId: "job-a" }, "job-b"), false);
  assert.equal(isCurrentSegmentJob(null, "job-a"), false);
});

test("does not fail a stalled player while its recording tab is hidden", () => {
  assert.equal(typeof segmentedPageRuntime.isSegmentStalled, "function");
  assert.equal(segmentedPageRuntime.isSegmentStalled(1_000, 40_000, 30_000, true), false);
  assert.equal(segmentedPageRuntime.isSegmentStalled(1_000, 40_000, 30_000, false), true);
  assert.equal(segmentedPageRuntime.isSegmentStalled(20_000, 40_000, 30_000, false), false);
});

test("throttles progress events while always allowing a final boundary update", () => {
  assert.equal(typeof segmentedPageRuntime.shouldEmitProgressUpdate, "function");
  const shouldEmitProgressUpdate = segmentedPageRuntime.shouldEmitProgressUpdate;
  assert.equal(shouldEmitProgressUpdate(1_000, 1_100, 250, false), false);
  assert.equal(shouldEmitProgressUpdate(1_000, 1_250, 250, false), true);
  assert.equal(shouldEmitProgressUpdate(1_000, 1_001, 250, true), true);
  assert.equal(shouldEmitProgressUpdate(0, 1_001, 250, false), true);
});

test("reports buffering and write-pressure pauses without changing lifecycle state", () => {
  assert.equal(getTransientRecordingState(false, false), "recording");
  assert.equal(getTransientRecordingState(false, true), "buffering");
  assert.equal(getTransientRecordingState(true, false), "writing");
  assert.equal(getTransientRecordingState(true, true), "writing");
});

test("reconciles delayed MediaRecorder pause and resume transitions", () => {
  assert.equal(getRecorderStateAction("recording", false, true), "pause");
  assert.equal(getRecorderStateAction("paused", false, false), "resume");
  assert.equal(getRecorderStateAction("paused", true, false), null);
  assert.equal(getRecorderStateAction("recording", false, false), null);
  assert.equal(getRecorderStateAction("inactive", false, true), null);
});
