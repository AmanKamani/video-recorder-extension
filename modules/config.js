/** Central operational limits for recording, diagnostics, storage, and WebM processing. */
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
  /** Lowest accepted progress interval in milliseconds; protects the page/side-panel message bridge. */
  minProgressIntervalMs: 50,
  /** Allowed seek difference in seconds when deciding that a requested position is ready. */
  seekToleranceSeconds: 0.35,
  /** Fallback frame-monitor cadence when requestVideoFrameCallback is unavailable. */
  segmentMonitorIntervalMs: 100,
  /** Maximum foreground time without media progress before one segment fails. */
  segmentStallTimeoutMs: 30000,
  /** Cadence of the independent foreground segment-stall watchdog. */
  segmentWatchdogIntervalMs: 1000,
  /** Refresh cadence for recording timers shown in the side panel. */
  recordingTimerRefreshIntervalMs: 250,
  /** Maximum time to wait for manual-recording file finalization. */
  downloadFinalizationTimeoutMs: 12000,
  /** Poll cadence while waiting for manual-recording file finalization. */
  downloadFinalizationPollIntervalMs: 300,
  /** Lifetime of a recently completed manual-recording status message. */
  recentRecordingStatusDurationMs: 15000,
  /** Cadence for reconciling manual-recorder controls with the selected tab. */
  recorderStatusPollIntervalMs: 1000,
  /** Delay before revoking fallback in-memory recording object URLs. */
  objectUrlRevokeDelayMs: 60000,
  /** Byte slice used when converting recording chunks to base64 without argument overflows. */
  base64EncodeSliceBytes: 0x8000,
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
  /** Maximum log entries rendered into the side-panel DOM. */
  visibleLogEntries: 300,
  /** Maximum in-memory log entries retained for copy/export during one panel session. */
  retainedLogEntries: 1000,
  /** Maximum playlist URLs returned by one selected-tab scan. */
  maxDiscoveredPlaylists: 60,
  /** Duration spent observing an injected HLS player before reporting diagnostics. */
  hlsDiagnosticProbeDurationMs: 12000,
  /** Frozen quality-lock settings object that keeps segments on merge-compatible dimensions. */
  qualityLock: Object.freeze({
    /** Boolean enabling or disabling rendition locking for segmented recordings. */
    enabled: true,
    /** Target height in pixels when stream metadata cannot advertise a height; positive integer. */
    fallbackHeight: 720,
    /** Allowed absolute width/height difference in pixels; non-negative integer for codec padding. */
    dimensionTolerancePixels: 4,
    /** Poll cadence while waiting for a requested rendition and decoded dimensions. */
    pollIntervalMs: 100,
  }),
  /** Bounded, non-sensitive diagnostic collection limits. */
  diagnostics: Object.freeze({
    /** Maximum script URLs retained by the site-player environment inspection. */
    maxScriptUrls: 30,
    /** Maximum recent HLS event names retained by the injected-player probe. */
    maxRecentHlsEvents: 100,
    /** Maximum fragment object keys retained in one diagnostic event. */
    maxFragmentKeys: 40,
    /** Maximum compact HLS summary events retained by the injected-player probe. */
    maxSummaryEvents: 30,
    /** Number of media bytes inspected when classifying an HLS sample. */
    hlsSampleBytes: 512,
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
