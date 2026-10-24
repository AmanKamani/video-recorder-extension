import test from "node:test";
import assert from "node:assert/strict";

import { createJobHistory, sanitizeJobSummary } from "../modules/job-history.js";

/** Creates an in-memory chrome.storage-compatible area for history tests. */
function createStorageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    async get(key) {
      return { [key]: values[key] };
    },
    async set(update) {
      Object.assign(values, structuredClone(update));
    },
  };
}

test("removes secrets, media values, and signed URL parameters from persisted summaries", () => {
  const sanitized = sanitizeJobSummary({
    jobId: "job-a",
    pageUrl: "https://example.com/course/1?token=secret#player",
    playlistUrl: "https://cdn.example/video.m3u8?signature=secret",
    cookie: "session=secret",
    key: new Uint8Array([1, 2, 3]),
    error: "Failed https://cdn.example/video.m3u8?signature=secret",
  });

  assert.equal(sanitized.pageUrl, "https://example.com/course/1");
  assert.equal("playlistUrl" in sanitized, false);
  assert.equal("cookie" in sanitized, false);
  assert.equal("key" in sanitized, false);
  assert.equal(sanitized.error, "Failed https://cdn.example/video.m3u8");
});

test("retains only the newest bounded history entries", async () => {
  const history = createJobHistory({ storageArea: createStorageArea(), limit: 2 });
  await history.append({ jobId: "job-1", state: "failed" });
  await history.append({ jobId: "job-2", state: "completed" });
  await history.append({ jobId: "job-3", state: "failed" });

  assert.deepEqual(
    (await history.list()).map((entry) => entry.jobId),
    ["job-3", "job-2"],
  );
});

test("recovers from corrupt stored history", async () => {
  const history = createJobHistory({
    storageArea: createStorageArea({ hlsSegmentJobHistoryV1: { version: 99 } }),
    limit: 2,
  });

  assert.deepEqual(await history.list(), []);
});
