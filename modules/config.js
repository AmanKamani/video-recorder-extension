/** Central operational limits for segmented recording and WebM processing. */
export const SEGMENT_CONFIG = Object.freeze({
  /** Lowest accepted parallel segment count; positive integer, currently one. */
  minSegments: 1,
  /** Highest accepted parallel segment count; positive integer bounded to limit resource use. */
  maxSegments: 15,
  /** Initial segment count shown to users; integer within minSegments..maxSegments. */
  defaultSegments: 1,
  /** MediaRecorder chunk cadence in milliseconds; positive, typically hundreds to low thousands. */
  recorderTimesliceMs: 1000,
  /** Maximum player/HLS preparation wait in milliseconds; positive and long enough for startup. */
  preparationTimeoutMs: 30000,
  /** Maximum seek/reseek wait in milliseconds; positive and tolerant of network buffering. */
  seekTimeoutMs: 15000,
  /** Minimum progress-message interval in milliseconds; positive, with lower values increasing traffic. */
  progressIntervalMs: 250,
  /** Chunk count that pauses producers; positive integer greater than bridgeLowWaterChunks. */
  bridgeHighWaterChunks: 4,
  /** Chunk count at or below which paused producers resume; integer from zero to bridgeHighWaterChunks. */
  bridgeLowWaterChunks: 1,
  /** WebM reader cache capacity in bytes; positive integer trading memory for fewer source reads. */
  webmReadCacheBytes: 4 * 1024 * 1024,
  /** WebM copy/write block size in bytes; positive integer trading memory for throughput. */
  webmCopyChunkBytes: 8 * 1024 * 1024,
  /** Number of completed job records retained; non-negative integer, where zero keeps none. */
  retainedJobHistory: 20,
  /** Frozen quality-lock settings object that keeps segments on merge-compatible dimensions. */
  qualityLock: Object.freeze({
    /** Boolean enabling or disabling rendition locking for segmented recordings. */
    enabled: true,
    /** Target height in pixels when stream metadata cannot advertise a height; positive integer. */
    fallbackHeight: 720,
    /** Allowed absolute width/height difference in pixels; non-negative integer for codec padding. */
    dimensionTolerancePixels: 4,
  }),
  /** Frozen short-range test settings object for exercising segmented capture and merge. */
  temporaryMergeTest: Object.freeze({
    /** Boolean selecting test ranges instead of normal full-duration segmentation. */
    enabled: false,
    /** Number of contiguous test segments; integer within minSegments..maxSegments. */
    segmentCount: 4,
    /** Duration of each test segment in seconds; positive finite number requiring sufficient media. */
    segmentDurationSeconds: 90,
  }),
});
