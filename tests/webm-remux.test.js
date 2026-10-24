import test from "node:test";
import assert from "node:assert/strict";

import { inspectWebmSegment, remuxWebmSegments } from "../modules/webm-remux.js";
import { readElement, readVint } from "../modules/webm-ebml.js";
import { createMemoryFileHandle, makeWebmFixture } from "./webm-fixtures.js";

test("inspects track compatibility and rejects incompatible codecs before writing", async () => {
  const vp8 = await inspectWebmSegment(makeWebmFixture({ codecId: "V_VP8" }));
  const vp9 = await inspectWebmSegment(makeWebmFixture({ codecId: "V_VP9" }));

  assert.deepEqual(vp8.tracks, [{ number: 1, type: 1, codecId: "V_VP8" }]);
  assert.notDeepEqual(vp8.tracks, vp9.tracks);

  const destination = createMemoryFileHandle();
  await assert.rejects(
    () =>
      remuxWebmSegments({
        sources: [makeWebmFixture({ codecId: "V_VP8" }), makeWebmFixture({ codecId: "V_VP9" })],
        ranges: [
          { startTime: 0, endTime: 1, duration: 1 },
          { startTime: 1, endTime: 2, duration: 1 },
        ],
        destinationHandle: destination,
      }),
    (error) => {
      assert.match(error.message, /incompatible WebM tracks/i);
      assert.deepEqual(error.incompatibleSegmentIndexes, [0, 1]);
      assert.equal(error.code, "INCOMPATIBLE_WEBM_TRACKS");
      return true;
    },
  );
  assert.equal((await destination.getFile()).size, 0);
});

test("attributes incompatibility to the outlier rather than always blaming later segments", async () => {
  await assert.rejects(
    () =>
      remuxWebmSegments({
        sources: [
          makeWebmFixture({ codecId: "V_VP9" }),
          makeWebmFixture({ codecId: "V_VP8" }),
          makeWebmFixture({ codecId: "V_VP8" }),
        ],
        ranges: [
          { startTime: 0, endTime: 1, duration: 1 },
          { startTime: 1, endTime: 2, duration: 1 },
          { startTime: 2, endTime: 3, duration: 1 },
        ],
        destinationHandle: createMemoryFileHandle(),
      }),
    (error) => {
      assert.deepEqual(error.incompatibleSegmentIndexes, [0]);
      return true;
    },
  );
});

test("attributes a structurally invalid WebM to its source segment", async () => {
  await assert.rejects(
    () =>
      remuxWebmSegments({
        sources: [makeWebmFixture(), new Blob([new Uint8Array([1, 2, 3])])],
        ranges: [
          { startTime: 0, endTime: 1, duration: 1 },
          { startTime: 1, endTime: 2, duration: 1 },
        ],
        destinationHandle: createMemoryFileHandle(),
      }),
    (error) => {
      assert.equal(error.code, "INVALID_WEBM_SEGMENT");
      assert.equal(error.segmentIndex, 1);
      return true;
    },
  );
});

test("rejects matching codec IDs with different codec initialization data", async () => {
  await assert.rejects(
    () =>
      remuxWebmSegments({
        sources: [
          makeWebmFixture({ codecPrivateBytes: [1, 2] }),
          makeWebmFixture({ codecPrivateBytes: [1, 3] }),
        ],
        ranges: [
          { startTime: 0, endTime: 1, duration: 1 },
          { startTime: 1, endTime: 2, duration: 1 },
        ],
        destinationHandle: createMemoryFileHandle(),
      }),
    (error) => {
      assert.equal(error.code, "INCOMPATIBLE_WEBM_TRACKS");
      return true;
    },
  );
});

test("remaps equivalent audio and video track numbers while logging each allocation", async () => {
  const audio = { type: 2, codecId: "A_OPUS", codecPrivateBytes: [1, 2] };
  const video = { type: 1, codecId: "V_VP9" };
  // The second recording swaps numeric IDs while preserving the same semantic audio/video tracks.
  const first = makeWebmFixture({
    tracks: [
      { number: 1, ...audio },
      { number: 2, ...video },
    ],
    clusters: [
      {
        timecode: 0,
        blocks: [
          { timecode: 0, trackNumber: 1 },
          { timecode: 100, trackNumber: 2 },
        ],
      },
    ],
  });
  const second = makeWebmFixture({
    tracks: [
      { number: 1, ...video },
      { number: 2, ...audio },
    ],
    clusters: [
      {
        timecode: 0,
        blocks: [
          { timecode: 0, trackNumber: 2 },
          { timecode: 100, trackNumber: 1 },
        ],
      },
    ],
  });
  const destination = createMemoryFileHandle();
  const logs = [];

  await remuxWebmSegments({
    sources: [first, second],
    ranges: [
      { startTime: 0, endTime: 1, duration: 1 },
      { startTime: 1, endTime: 2, duration: 1 },
    ],
    destinationHandle: destination,
    log: (message) => logs.push(message),
  });

  const inspection = await inspectWebmSegment(await destination.getFile());
  assert.deepEqual(
    inspection.tracks.map(({ number, type, codecId }) => ({ number, type, codecId })),
    [
      { number: 1, type: 2, codecId: "A_OPUS" },
      { number: 2, type: 1, codecId: "V_VP9" },
    ],
  );
  const blockTracks = [];
  for (const cluster of inspection.clusters) {
    let offset = cluster.element.dataStart;
    while (offset < cluster.element.end) {
      const child = await readElement(inspection.reader, offset, cluster.element.end);
      if (child.id === 0xa3n) {
        blockTracks.push(Number((await readVint(inspection.reader, child.dataStart)).value));
      }
      offset = child.end;
    }
  }
  assert.deepEqual(blockTracks, [1, 2, 1, 2]);
  assert.equal(
    logs.some((message) => /Segment 1 WebM tracks: #1 audio A_OPUS, #2 video V_VP9/.test(message)),
    true,
  );
  assert.equal(
    logs.some((message) =>
      /Segment 2 WebM tracks: #1 video V_VP9, #2 audio A_OPUS; remap #1→#2, #2→#1/.test(message),
    ),
    true,
  );
});

test("rejects differing track timing metadata and ambiguous duplicate tracks", async () => {
  const ranges = [
    { startTime: 0, endTime: 1, duration: 1 },
    { startTime: 1, endTime: 2, duration: 1 },
  ];
  // Keep the codec constant while varying an otherwise opaque track-level timing element.
  await assert.rejects(
    () =>
      remuxWebmSegments({
        sources: [
          makeWebmFixture({
            tracks: [
              {
                number: 1,
                type: 1,
                codecId: "V_VP9",
                extraElements: [{ id: "56AA", payload: [1] }],
              },
            ],
          }),
          makeWebmFixture({
            tracks: [
              {
                number: 1,
                type: 1,
                codecId: "V_VP9",
                extraElements: [{ id: "56AA", payload: [2] }],
              },
            ],
          }),
        ],
        ranges,
        destinationHandle: createMemoryFileHandle(),
      }),
    /incompatible WebM tracks/i,
  );

  // Identical semantic signatures make a one-to-one canonical number mapping ambiguous.
  const duplicateTracks = [
    { number: 1, type: 1, codecId: "V_VP9" },
    { number: 2, type: 1, codecId: "V_VP9" },
  ];
  await assert.rejects(
    () =>
      remuxWebmSegments({
        sources: [
          makeWebmFixture({ tracks: duplicateTracks }),
          makeWebmFixture({ tracks: duplicateTracks }),
        ],
        ranges,
        destinationHandle: createMemoryFileHandle(),
      }),
    /incompatible WebM tracks/i,
  );
});

test("remuxes compatible segments in order and drops blocks at the end boundary", async () => {
  // Each fixture includes a packet exactly at its exclusive duration boundary.
  const first = makeWebmFixture({
    clusters: [{ timecode: 0, blocks: [0, 400, 1000] }],
  });
  const second = makeWebmFixture({
    clusters: [{ timecode: 0, blocks: [0, 500, 1000] }],
  });
  const destination = createMemoryFileHandle();

  const result = await remuxWebmSegments({
    sources: [first, second],
    ranges: [
      { startTime: 0, endTime: 1, duration: 1 },
      { startTime: 1, endTime: 2, duration: 1 },
    ],
    destinationHandle: destination,
  });
  const inspection = await inspectWebmSegment(await destination.getFile());

  assert.equal(result.blocksDropped, 2);
  assert.equal(result.clustersWritten, 2);
  assert.deepEqual(
    inspection.clusters.map((cluster) => cluster.timecode),
    [0, 1000],
  );
  assert.equal(result.durationMs, 2000);
});

test("rejects unsupported BlockGroup input before opening the destination", async () => {
  const destination = createMemoryFileHandle();

  await assert.rejects(
    () =>
      remuxWebmSegments({
        sources: [makeWebmFixture({ blockGroups: true })],
        ranges: [{ startTime: 0, endTime: 1, duration: 1 }],
        destinationHandle: destination,
      }),
    /BlockGroup/i,
  );
  assert.equal((await destination.getFile()).size, 0);
});

test("remuxes MediaRecorder WebM files containing consecutive unknown-sized Clusters", async () => {
  // Consecutive streaming Clusters rely on the next Cluster ID to terminate the previous one.
  const source = makeWebmFixture({
    unknownSizedClusters: true,
    clusters: [
      { timecode: 0, blocks: [0, 400] },
      { timecode: 1000, blocks: [0, 400] },
    ],
  });
  const destination = createMemoryFileHandle();

  const result = await remuxWebmSegments({
    sources: [source],
    ranges: [{ startTime: 0, endTime: 2, duration: 2 }],
    destinationHandle: destination,
  });
  const inspection = await inspectWebmSegment(await destination.getFile());

  assert.equal(result.clustersWritten, 2);
  assert.deepEqual(
    inspection.clusters.map((cluster) => cluster.timecode),
    [0, 1000],
  );
});
