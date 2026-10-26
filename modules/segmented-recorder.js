import { SEGMENT_CONFIG } from "./config.js";
import { createJobHistory } from "./job-history.js";
import { canRetrySegment } from "./segment-job-state.js";
import { segmentedPageCommand } from "./segmented-page-runtime.js";
import { remuxWebmSegments } from "./webm-remux.js";

const PAGE_CHANNEL = "hls-side-panel-segment-recorder-v2";

/** Decodes one base64 runtime payload into independently owned bytes. */
export function decodeBase64Chunk(base64) {
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Validates that a relayed message belongs to a live known segment. */
export function isSegmentMessageForJob(job, message) {
  return (
    !!job &&
    job.jobId === message?.jobId &&
    job.segments.some((segment) => segment.id === message?.segmentId)
  );
}

/** Prevents delayed non-terminal events from regressing a terminal segment. */
export function shouldApplySegmentDetail(currentState, nextState) {
  const terminalStates = new Set(["finished", "failed", "incompatible", "cancelled"]);
  if (!terminalStates.has(currentState)) return true;
  return terminalStates.has(nextState);
}

/** Finalization waits for both the page barrier and every per-segment finish event. */
export function isSegmentJobReadyToFinalize(job) {
  return (
    !!job?.pageFinishedDetail &&
    job.segments?.length > 0 &&
    job.segments.every((segment) => segment.state === "finished")
  );
}

/** Live UI telemetry must not wait behind media writes; terminal events must. */
export function segmentEventNeedsWriteBarrier(eventType) {
  return !["segment-status", "segment-progress"].includes(eventType);
}

/** Returns temporary file handles in media-timeline order. */
export function segmentFilesInTimelineOrder(job) {
  return [...job.segments]
    .sort((left, right) => left.index - right.index)
    .map((segment) => segment.fileHandle);
}

/** Replaces one segment's OPFS writer without touching any sibling segment file. */
export async function resetSegmentWriter(directory, segment) {
  segment.fileHandle = await directory.getFileHandle(`${segment.id}.webm`, { create: true });
  segment.writable = await segment.fileHandle.createWritable();
  await segment.writable.truncate(0);
  segment.writeQueue = Promise.resolve();
  segment.expectedSequence = 0;
  segment.bytes = 0;
  segment.closePromise = null;
}

/** Determines whether a failed finalization needs segment retry or merge-only retry. */
export function classifyMergeFailure(error, segments) {
  if (error?.code === "INVALID_WEBM_SEGMENT" && Number.isInteger(error.segmentIndex)) {
    const segment = [...segments].sort((left, right) => left.index - right.index)[
      error.segmentIndex
    ];
    return {
      state: "retryable",
      incompatibleSegmentIds: segment ? [segment.id] : [],
    };
  }
  if (
    error?.code === "INCOMPATIBLE_WEBM_TRACKS" &&
    Array.isArray(error.incompatibleSegmentIndexes)
  ) {
    return {
      state: "retryable",
      incompatibleSegmentIds: error.incompatibleSegmentIndexes
        .map((index) => [...segments].sort((left, right) => left.index - right.index)[index]?.id)
        .filter(Boolean),
    };
  }
  return { state: "merge_failed", incompatibleSegmentIds: [] };
}

/**
 * Installs a replaceable ISOLATED-world bridge. The ownership check prevents
 * listeners retained by an invalidated extension context from handling events.
 */
export function installSegmentPageBridge({ base64SliceBytes, highWaterChunks, lowWaterChunks }) {
  if (
    !Number.isInteger(base64SliceBytes) ||
    base64SliceBytes <= 0 ||
    !Number.isInteger(highWaterChunks) ||
    highWaterChunks <= 0 ||
    !Number.isInteger(lowWaterChunks) ||
    lowWaterChunks < 0 ||
    lowWaterChunks >= highWaterChunks
  ) {
    throw new Error("Segment bridge flow-control configuration is invalid.");
  }
  const BRIDGE_KEY = "__hlsSidePanelSegmentBridgeV2";
  const CHANNEL = "hls-side-panel-segment-recorder-v2";
  /** Identifies events that must wait for pending chunk relays. */
  const needsWriteBarrier = (eventType) =>
    !["segment-status", "segment-progress"].includes(eventType);
  const previous = window[BRIDGE_KEY];
  if (typeof previous?.listener === "function") {
    window.removeEventListener("message", previous.listener);
  }
  const queues = new Map();
  const pendingBySegment = new Map();
  const failedQueues = new Set();
  const registration = { listener: null };
  /** Encodes transferable chunk bytes for extension messaging. */
  const toBase64 = (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += base64SliceBytes) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + base64SliceBytes));
    }
    return btoa(binary);
  };
  registration.listener = (event) => {
    if (window[BRIDGE_KEY] !== registration) return;
    const data = event.data;
    if (event.source !== window || !data || data.channel !== CHANNEL) return;
    if (data.type === "segment-retry-start") {
      const key = `${data.jobId}:${data.segmentId}`;
      // A retry starts a new stream, so it must not inherit a rejected queue.
      queues.delete(key);
      pendingBySegment.delete(key);
      failedQueues.delete(key);
      return;
    }
    if (data.type === "segment-chunk") {
      const key = `${data.jobId}:${data.segmentId}`;
      const queue = queues.get(key) || Promise.resolve();
      const pending = (pendingBySegment.get(key) || 0) + 1;
      pendingBySegment.set(key, pending);
      // Bound page-side production while extension writes drain in order.
      if (pending >= highWaterChunks) {
        window.postMessage(
          {
            channel: CHANNEL,
            type: "segment-flow",
            jobId: data.jobId,
            segmentId: data.segmentId,
            detail: { action: "pause" },
          },
          "*",
        );
      }
      const next = queue
        .then(async () => {
          const bytes = new Uint8Array(await data.blob.arrayBuffer());
          const response = await chrome.runtime.sendMessage({
            type: "HLS_SIDEPANEL_SEGMENT_CHUNK",
            jobId: data.jobId,
            segmentId: data.segmentId,
            sequence: data.sequence,
            base64: toBase64(bytes),
          });
          if (!response?.ok) throw new Error(response?.message || "Segment write failed.");
        })
        .finally(() => {
          const remaining = Math.max(0, (pendingBySegment.get(key) || 1) - 1);
          pendingBySegment.set(key, remaining);
          if (remaining <= lowWaterChunks) {
            window.postMessage(
              {
                channel: CHANNEL,
                type: "segment-flow",
                jobId: data.jobId,
                segmentId: data.segmentId,
                detail: { action: "resume" },
              },
              "*",
            );
          }
        });
      queues.set(key, next);
      next.catch((error) => {
        if (failedQueues.has(key)) return;
        failedQueues.add(key);
        window.postMessage(
          {
            channel: CHANNEL,
            type: "segment-write-failed",
            jobId: data.jobId,
            segmentId: data.segmentId,
            detail: { message: error?.message || String(error) },
          },
          "*",
        );
      });
      return;
    }
    if (
      [
        "segment-status",
        "segment-progress",
        "segment-finished",
        "segment-failed",
        "job-ready",
        "job-recording",
        "job-finished",
        "job-incomplete",
        "job-failed",
        "job-cancelled",
      ].includes(data.type)
    ) {
      const relevantQueues = !needsWriteBarrier(data.type)
        ? []
        : ["segment-finished", "segment-failed"].includes(data.type) && data.segmentId
          ? [queues.get(`${data.jobId}:${data.segmentId}`) || Promise.resolve()]
          : [...queues.entries()]
              .filter(([key]) => key.startsWith(`${data.jobId}:`))
              .map(([, queue]) => queue);
      const requireSuccessfulWrites = ["segment-finished", "job-finished"].includes(data.type);
      // Terminal success crosses the bridge only after all relevant writes succeed.
      const barrier = requireSuccessfulWrites
        ? Promise.all(relevantQueues)
        : Promise.allSettled(relevantQueues);
      barrier
        .then(() =>
          chrome.runtime.sendMessage({
            type: "HLS_SIDEPANEL_SEGMENT_EVENT",
            eventType: data.type,
            jobId: data.jobId,
            segmentId: data.segmentId,
            detail: data.detail || {},
          }),
        )
        .catch(() => {});
    }
  };
  window[BRIDGE_KEY] = registration;
  window.addEventListener("message", registration.listener);
}

/** Coordinates segmented page jobs, OPFS writes, remuxing, repair, and persisted history. */
export function createSegmentedRecorderController({
  tabSelect,
  getSelectedTab,
  ensurePagePermission,
  getSelectedPlaylist,
  isM3u8,
  addLog,
  setStatus,
  repairWebmFile,
  onJobUpdate = () => {},
  remux = remuxWebmSegments,
  history = createJobHistory(),
}) {
  const jobsByTab = new Map();
  const preparationGenerationByTab = new Map();
  let eventQueue = Promise.resolve();

  /** Emits a cloneable UI snapshot without live file-system handles. */
  const notifyUpdate = (job) => {
    if (job)
      onJobUpdate(
        structuredClone({
          ...job,
          outputHandle: undefined,
          opfsRoot: undefined,
          opfsDirectory: undefined,
          segments: job.segments.map((segment) => ({
            id: segment.id,
            index: segment.index,
            startTime: segment.startTime,
            endTime: segment.endTime,
            duration: segment.duration,
            state: segment.state,
            progress: segment.progress,
            quality: segment.quality || null,
            error: segment.error || null,
          })),
        }),
      );
  };

  /** Installs the isolated-world relay in one tab. */
  async function installBridge(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: installSegmentPageBridge,
      args: [
        {
          base64SliceBytes: SEGMENT_CONFIG.base64EncodeSliceBytes,
          highWaterChunks: SEGMENT_CONFIG.bridgeHighWaterChunks,
          lowWaterChunks: SEGMENT_CONFIG.bridgeLowWaterChunks,
        },
      ],
    });
  }

  /** Executes one segmented runtime command in the page's main world. */
  async function execute(tabId, command, options = {}) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: segmentedPageCommand,
      args: [command, options],
    });
    return results?.[0]?.result || { ok: false, message: "The page returned no result." };
  }

  /** Prepares a fresh segmented job for the currently selected tab. */
  async function prepareSelectedTab(
    segmentCount,
    { lockQuality = SEGMENT_CONFIG.qualityLock.enabled } = {},
  ) {
    const tab = await getSelectedTab();
    const effectiveSegmentCount = SEGMENT_CONFIG.temporaryMergeTest.enabled
      ? SEGMENT_CONFIG.temporaryMergeTest.segmentCount
      : segmentCount;
    const generation = (preparationGenerationByTab.get(tab.id) || 0) + 1;
    preparationGenerationByTab.set(tab.id, generation);
    const playlistUrl = getSelectedPlaylist();
    if (!playlistUrl || !isM3u8(playlistUrl)) {
      throw new Error("Scan this tab and select an HLS playlist before preparing segments.");
    }
    if (!(await ensurePagePermission(tab))) throw new Error("Website access was not granted.");
    await installBridge(tab.id);
    // Ignore preparation resumed after a newer request replaced it.
    if (preparationGenerationByTab.get(tab.id) !== generation) {
      throw new Error("Segment preparation was superseded by a newer request.");
    }
    const previous = jobsByTab.get(tab.id);
    if (previous && ["recording", "merging", "repairing"].includes(previous.state)) {
      throw new Error("This tab already has an active segmented recording.");
    }
    if (previous) await removeTemporaryFiles(previous);
    const jobId = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const result = await execute(tab.id, "prepare", {
      jobId,
      playlistUrl,
      segmentCount: effectiveSegmentCount,
      maxSegments: SEGMENT_CONFIG.maxSegments,
      lockQuality,
      fallbackQualityHeight: SEGMENT_CONFIG.qualityLock.fallbackHeight,
      qualityDimensionTolerancePixels: SEGMENT_CONFIG.qualityLock.dimensionTolerancePixels,
      qualityPollIntervalMs: SEGMENT_CONFIG.qualityLock.pollIntervalMs,
      seekToleranceSeconds: SEGMENT_CONFIG.seekToleranceSeconds,
      fixedSegmentDurationSeconds: SEGMENT_CONFIG.temporaryMergeTest.enabled
        ? SEGMENT_CONFIG.temporaryMergeTest.segmentDurationSeconds
        : null,
      preparationTimeoutMs: SEGMENT_CONFIG.preparationTimeoutMs,
    });
    // The page response can arrive after another preparation has taken ownership.
    if (preparationGenerationByTab.get(tab.id) !== generation) {
      throw new Error("Segment preparation was superseded by a newer request.");
    }
    if (!result.ok) throw new Error(result.message);
    const job = {
      jobId,
      tabId: tab.id,
      tabTitle: tab.title || tab.url,
      pageUrl: tab.url,
      state: "ready",
      duration: result.duration,
      quality: result.quality || null,
      streamMetadata: result.streamMetadata || null,
      error: null,
      finalizing: false,
      pageFinishedDetail: null,
      segments: result.segments.map((segment) => ({
        ...segment,
        writeQueue: Promise.resolve(),
        writable: null,
        fileHandle: null,
        expectedSequence: 0,
        bytes: 0,
      })),
    };
    jobsByTab.set(tab.id, job);
    addLog(
      "info",
      `Tab ${tab.id}: prepared ${effectiveSegmentCount} managed recording segment${
        effectiveSegmentCount === 1 ? "" : "s"
      }${job.quality?.locked ? ` with quality locked near ${job.quality.targetHeight}p` : ""}.`,
    );
    if (job.streamMetadata) {
      addLog(
        "info",
        `Tab ${tab.id}: safe HLS stream metadata:\n${JSON.stringify(job.streamMetadata, null, 2)}`,
      );
    }
    notifyUpdate(job);
    return job;
  }

  /** Creates one OPFS directory and writer per segment. */
  async function createTemporaryWriters(job) {
    const root = await navigator.storage.getDirectory();
    const directoryName = `hls-segments-${job.jobId}`;
    const directory = await root.getDirectoryHandle(directoryName, { create: true });
    job.opfsRoot = root;
    job.opfsDirectory = directory;
    job.opfsDirectoryName = directoryName;
    for (const segment of job.segments) {
      await openSegmentWriter(job, segment);
    }
  }

  /** Opens a clean OPFS writer for a segment recording attempt. */
  async function openSegmentWriter(job, segment) {
    await resetSegmentWriter(job.opfsDirectory, segment);
  }

  /** Drains queued writes and closes a segment writer exactly once. */
  async function closeSegmentWriter(segment) {
    if (segment.closePromise) return segment.closePromise;
    if (!segment.writable) return;
    // Share one close operation across racing finish and finalization paths.
    segment.closePromise = (async () => {
      await segment.writeQueue;
      const writable = segment.writable;
      await writable.close();
      if (segment.writable === writable) segment.writable = null;
    })();
    try {
      await segment.closePromise;
    } finally {
      segment.closePromise = null;
    }
  }

  /** Drains settled work and aborts a segment writer during failure cleanup. */
  async function abortSegmentWriter(segment) {
    try {
      await segment.writeQueue;
    } catch (_) {}
    try {
      await segment.writable?.abort();
    } catch (_) {}
    segment.writable = null;
    segment.closePromise = null;
  }

  /** Starts all prepared segments after acquiring the destination file. */
  async function startSelectedJob() {
    const tabId = Number(tabSelect.value);
    const job = jobsByTab.get(tabId);
    if (!job || job.state !== "ready") throw new Error("All segment players must be ready first.");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suggestedName = `segmented-recording-${stamp}.webm`;
    const outputHandle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "WebM video", accept: { "video/webm": [".webm"] } }],
    });
    job.outputHandle = outputHandle;
    job.filename = outputHandle.name || suggestedName;
    try {
      await createTemporaryWriters(job);
      job.state = "recording";
      job.startedAt = Date.now();
      job.recordingEndedAt = null;
      for (const segment of job.segments) {
        segment.state = "recording";
        segment.progress = 0;
        segment.error = null;
      }
      notifyUpdate(job);
      const result = await execute(job.tabId, "start", {
        jobId: job.jobId,
        timesliceMs: SEGMENT_CONFIG.recorderTimesliceMs,
        progressIntervalMs: SEGMENT_CONFIG.progressIntervalMs,
        minProgressIntervalMs: SEGMENT_CONFIG.minProgressIntervalMs,
        seekTimeoutMs: SEGMENT_CONFIG.seekTimeoutMs,
        seekToleranceSeconds: SEGMENT_CONFIG.seekToleranceSeconds,
        segmentMonitorIntervalMs: SEGMENT_CONFIG.segmentMonitorIntervalMs,
        segmentStallTimeoutMs: SEGMENT_CONFIG.segmentStallTimeoutMs,
        segmentWatchdogIntervalMs: SEGMENT_CONFIG.segmentWatchdogIntervalMs,
      });
      if (!result.ok) throw new Error(result.message);
      for (const segment of job.segments) {
        if (segment.state !== "recording") continue;
        const pageSegment = result.segments?.find((item) => item.id === segment.id);
        segment.state = pageSegment?.state || "recording";
        segment.progress = pageSegment?.progress || 0;
        segment.error = pageSegment?.error || null;
      }
      addLog("info", `Tab ${job.tabId}: all ${job.segments.length} segments started.`);
      notifyUpdate(job);
      return job;
    } catch (error) {
      await failJob(job, error?.message || String(error));
      throw error;
    }
  }

  /** Removes a job's OPFS workspace and clears retained handles. */
  async function removeTemporaryFiles(job) {
    try {
      if (job.opfsRoot && job.opfsDirectoryName) {
        await job.opfsRoot.removeEntry(job.opfsDirectoryName, { recursive: true });
      }
      job.opfsDirectory = null;
      job.opfsDirectoryName = null;
      for (const segment of job.segments || []) {
        segment.fileHandle = null;
        segment.writable = null;
      }
    } catch (error) {
      addLog("warning", `Could not remove temporary segment files: ${error?.message || error}`);
    }
  }

  /** Moves an active job to a terminal failure state and closes its writers. */
  async function failJob(job, message, segmentId = null, state = "failed") {
    if (!job || ["completed", "failed", "cancelled"].includes(job.state)) return;
    if (job.startedAt && !job.recordingEndedAt) job.recordingEndedAt = Date.now();
    job.state = state;
    job.error = { segmentId, message };
    for (const segment of job.segments) {
      if (!["finished", "failed"].includes(segment.state)) {
        segment.state = segment.id === segmentId ? "failed" : "cancelled";
      }
      await abortSegmentWriter(segment);
    }
    await history.append({
      jobId: job.jobId,
      tabId: job.tabId,
      pageUrl: job.pageUrl,
      pageTitle: job.tabTitle,
      segmentCount: job.segments.length,
      state,
      failedSegmentId: segmentId,
      error: message,
    });
    addLog("error", `Tab ${job.tabId}: segmented recording ${state}: ${message}`);
    setStatus(`Segmented recording ${state}: ${message}`);
    notifyUpdate(job);
  }

  /** Closes, remuxes, repairs, and copies a completed segmented recording. */
  async function finalizeJob(job, detail = {}) {
    if (job.finalizing || !["recording", "merge_failed"].includes(job.state)) return;
    job.finalizing = true;
    job.recordingEndedAt = Date.now();
    job.state = "merging";
    notifyUpdate(job);
    try {
      for (const segment of job.segments) {
        await closeSegmentWriter(segment);
      }
      const ranges = [...job.segments]
        .sort((left, right) => left.index - right.index)
        .map(({ startTime, endTime, duration }) => ({ startTime, endTime, duration }));
      const mergedHandle = await job.opfsDirectory.getFileHandle("merged-final.webm", {
        create: true,
      });
      const merge = await remux({
        sources: segmentFilesInTimelineOrder(job),
        ranges,
        destinationHandle: mergedHandle,
        log: (message) => addLog("info", `Tab ${job.tabId}: ${message}`),
      });
      job.state = "repairing";
      notifyUpdate(job);
      const repair = await repairWebmFile(
        mergedHandle,
        detail.durationMs || Math.round(job.duration * 1000),
        (message) => addLog("info", `Tab ${job.tabId}: ${message}`),
      );
      if (!repair.ok) throw new Error(repair.message);
      const mergedFile = await mergedHandle.getFile();
      const output = await job.outputHandle.createWritable();
      try {
        for (
          let offset = 0;
          offset < mergedFile.size;
          offset += SEGMENT_CONFIG.webmCopyChunkBytes
        ) {
          const bytes = new Uint8Array(
            await mergedFile
              .slice(offset, Math.min(mergedFile.size, offset + SEGMENT_CONFIG.webmCopyChunkBytes))
              .arrayBuffer(),
          );
          await output.write(bytes);
        }
        await output.close();
      } catch (error) {
        try {
          await output.abort();
        } catch (_) {}
        throw error;
      }
      const finalFile = await job.outputHandle.getFile();
      job.state = "completed";
      job.bytes = finalFile.size;
      job.segments.forEach((segment) => {
        segment.state = "finished";
        segment.progress = 1;
      });
      await removeTemporaryFiles(job);
      await history.append({
        jobId: job.jobId,
        tabId: job.tabId,
        pageUrl: job.pageUrl,
        pageTitle: job.tabTitle,
        segmentCount: job.segments.length,
        ranges,
        state: "completed",
        filename: job.filename,
        bytes: finalFile.size,
      });
      await chrome.runtime.sendMessage({
        type: "HLS_SIDEPANEL_SEGMENT_FINALIZED",
        detail: {
          ok: true,
          jobId: job.jobId,
          tabId: job.tabId,
          pageTitle: job.tabTitle,
          filename: job.filename,
          bytes: finalFile.size,
          durationMs: merge.durationMs,
        },
      });
      addLog("info", `Tab ${job.tabId}: merged recording saved as ${job.filename}.`);
      setStatus(`Merged recording saved: ${job.filename}`);
      notifyUpdate(job);
    } catch (error) {
      job.finalizing = false;
      job.recordingEndedAt ||= Date.now();
      job.error = { segmentId: null, message: error?.message || String(error) };
      const failure = classifyMergeFailure(error, job.segments);
      if (failure.state === "retryable") {
        for (const segmentId of failure.incompatibleSegmentIds) {
          const segment = job.segments.find((item) => item.id === segmentId);
          if (!segment) continue;
          segment.state = error.code === "INVALID_WEBM_SEGMENT" ? "failed" : "incompatible";
          segment.error =
            error.code === "INVALID_WEBM_SEGMENT"
              ? "This segment is not a valid complete WebM and must be recorded again."
              : "This segment has incompatible WebM tracks and must be recorded again.";
        }
        job.state = "retryable";
        addLog(
          "error",
          `Tab ${job.tabId}: ${error.message} Affected: ${failure.incompatibleSegmentIds
            .map((segmentId) => {
              const segment = job.segments.find((item) => item.id === segmentId);
              return `Segment ${(segment?.index ?? 0) + 1}`;
            })
            .join(", ")}.\n${JSON.stringify(error.trackLayouts, null, 2)}`,
        );
        setStatus("Retry the incompatible segment, then merging will resume automatically.");
      } else {
        job.state = "merge_failed";
        addLog("error", `Tab ${job.tabId}: merge failed and can be retried: ${job.error.message}`);
        setStatus(`Merge failed: ${job.error.message}`);
      }
      await history.append({
        jobId: job.jobId,
        tabId: job.tabId,
        pageUrl: job.pageUrl,
        pageTitle: job.tabTitle,
        segmentCount: job.segments.length,
        state: job.state,
        error: job.error.message,
      });
      notifyUpdate(job);
    }
  }

  /** Validates and serializes one relayed media chunk into its OPFS file. */
  async function handleChunk(message) {
    const job = [...jobsByTab.values()].find((candidate) => candidate.jobId === message.jobId);
    if (!isSegmentMessageForJob(job, message) || job.state !== "recording") {
      return { ok: false, message: "No active writer exists for this segment." };
    }
    const segment = job.segments.find((item) => item.id === message.segmentId);
    if (message.sequence !== segment.expectedSequence) {
      const messageText = `Expected chunk ${segment.expectedSequence}, received ${message.sequence}.`;
      return { ok: false, message: messageText };
    }
    segment.expectedSequence += 1;
    const bytes = decodeBase64Chunk(message.base64);
    segment.writeQueue = segment.writeQueue.then(async () => {
      await segment.writable.write(bytes);
      segment.bytes += bytes.byteLength;
    });
    try {
      await segment.writeQueue;
      return { ok: true, bytesWritten: segment.bytes };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  /** Applies one ordered page event to controller state and lifecycle work. */
  async function handleEvent(message) {
    const job = [...jobsByTab.values()].find((candidate) => candidate.jobId === message.jobId);
    if (!job) return;
    const segment = job.segments.find((item) => item.id === message.segmentId);
    if (
      segment &&
      message.detail &&
      shouldApplySegmentDetail(segment.state, message.detail.state)
    ) {
      // Delayed telemetry cannot overwrite a terminal state from an earlier event.
      if (typeof message.detail.progress === "number") segment.progress = message.detail.progress;
      if (
        message.detail.state &&
        !["segment-finished", "segment-failed"].includes(message.eventType)
      ) {
        segment.state = message.detail.state;
      }
    }
    if (message.eventType === "segment-finished" && segment) {
      try {
        await closeSegmentWriter(segment);
        segment.state = "finished";
        segment.progress = 1;
        segment.error = null;
      } catch (error) {
        await abortSegmentWriter(segment);
        segment.state = "failed";
        segment.error = error?.message || String(error);
        job.state = job.segments.some(
          (item) => item.id !== segment.id && item.state === "recording",
        )
          ? "recording"
          : "retryable";
        job.error = { segmentId: segment.id, message: segment.error };
      }
      notifyUpdate(job);
      if (isSegmentJobReadyToFinalize(job)) {
        // Segment and page completion may arrive in either order; consume once both exist.
        const detail = job.pageFinishedDetail;
        job.pageFinishedDetail = null;
        await finalizeJob(job, detail);
      }
    } else if (message.eventType === "segment-failed" && segment) {
      segment.state = "failed";
      segment.error = message.detail?.message || "The segment failed.";
      notifyUpdate(job);
      segment.abortPromise = abortSegmentWriter(segment).finally(() => {
        segment.abortPromise = null;
      });
      await segment.abortPromise;
    } else if (message.eventType === "job-incomplete") {
      if (job.segments.some((item) => item.state === "recording")) {
        return;
      }
      const reportedFailures = new Set(message.detail?.failedSegmentIds || []);
      if (
        reportedFailures.size &&
        !job.segments.some(
          (item) =>
            reportedFailures.has(item.id) && ["failed", "incompatible"].includes(item.state),
        )
      ) {
        return;
      }
      job.state = "retryable";
      job.recordingEndedAt = Date.now();
      job.error = {
        segmentId: message.detail?.failedSegmentIds?.[0] || null,
        message: message.detail?.message || "One or more segments must be retried.",
      };
      addLog("warning", `Tab ${job.tabId}: ${job.error.message}`);
      setStatus(job.error.message);
      notifyUpdate(job);
    } else if (message.eventType === "job-finished") {
      if (job.state !== "recording") return;
      job.pageFinishedDetail = message.detail || {};
      if (isSegmentJobReadyToFinalize(job)) {
        // The page barrier is retained until every segment writer has finished.
        const detail = job.pageFinishedDetail;
        job.pageFinishedDetail = null;
        await finalizeJob(job, detail);
      } else {
        notifyUpdate(job);
      }
    } else if (message.eventType === "job-failed") {
      await failJob(job, message.detail?.message || "A segment failed.", message.segmentId);
    } else if (message.eventType === "job-cancelled") {
      job.stopping = false;
      await failJob(job, message.detail?.message || "Recording cancelled.", null, "cancelled");
    } else {
      notifyUpdate(job);
    }
  }

  /** Restarts one failed segment while unaffected segments continue or remain finished. */
  async function retrySegment(segmentId) {
    const job = jobsByTab.get(Number(tabSelect.value));
    const segment = job?.segments.find((item) => item.id === segmentId);
    if (!job || !segment || job.stopping || !canRetrySegment(job.state, segment.state)) {
      throw new Error("This segment is not available for retry.");
    }
    if (segment.retrying) throw new Error("This segment retry is already starting.");
    segment.retrying = true;
    try {
      // Wait for failure cleanup before immediately replacing the segment writer.
      if (segment.abortPromise) await segment.abortPromise;
      await openSegmentWriter(job, segment);
      // Recheck ownership because stop or cleanup may win while the writer opens.
      if (
        job.stopping ||
        jobsByTab.get(job.tabId) !== job ||
        ["cancelled", "failed"].includes(job.state)
      ) {
        throw new Error("The segmented job is no longer available for retry.");
      }
      segment.state = "recording";
      segment.progress = 0;
      segment.error = null;
      job.state = "recording";
      job.error = null;
      job.pageFinishedDetail = null;
      job.recordingEndedAt = null;
      notifyUpdate(job);
      const result = await execute(job.tabId, "retry-segment", {
        jobId: job.jobId,
        segmentId,
        timesliceMs: SEGMENT_CONFIG.recorderTimesliceMs,
      });
      if (!result.ok) throw new Error(result.message);
    } catch (error) {
      await abortSegmentWriter(segment);
      if (
        job.stopping ||
        jobsByTab.get(job.tabId) !== job ||
        ["cancelled", "failed"].includes(job.state)
      ) {
        throw error;
      }
      segment.state = "failed";
      segment.error = error?.message || String(error);
      job.state = job.segments.some((item) => item.id !== segment.id && item.state === "recording")
        ? "recording"
        : "retryable";
      job.error = { segmentId, message: segment.error };
      notifyUpdate(job);
      throw error;
    } finally {
      segment.retrying = false;
    }
    addLog("info", `Tab ${job.tabId}: retrying Segment ${segment.index + 1}.`);
    return job;
  }

  /** Repeats finalization without rerecording completed segment files. */
  async function retryMergeSelectedJob() {
    const job = jobsByTab.get(Number(tabSelect.value));
    if (!job || job.state !== "merge_failed") {
      throw new Error("No failed merge is available to retry.");
    }
    await finalizeJob(job, { durationMs: Math.round(job.duration * 1000) });
    return job;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "HLS_SIDEPANEL_SEGMENT_CHUNK_PANEL") {
      handleChunk(message).then(sendResponse);
      return true;
    }
    if (message?.type === "HLS_SIDEPANEL_SEGMENT_EVENT_PANEL") {
      // Serialize lifecycle events so finish barriers and retries observe stable state.
      const operation = (eventQueue = eventQueue.catch(() => {}).then(() => handleEvent(message)));
      operation
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: error?.message || String(error) }));
      return true;
    }
  });

  /** Requests an orderly stop for the selected recording job. */
  async function stopSelectedJob() {
    const job = jobsByTab.get(Number(tabSelect.value));
    if (!job || job.state !== "recording") throw new Error("No segmented recording is active.");
    if (job.stopping) throw new Error("The segmented recording is already stopping.");
    job.stopping = true;
    try {
      const result = await execute(job.tabId, "stop", { jobId: job.jobId });
      if (!result.ok) job.stopping = false;
      return result;
    } catch (error) {
      job.stopping = false;
      throw error;
    }
  }

  /** Removes page players and temporary files for an inactive selected job. */
  async function cleanupSelectedTab() {
    const tabId = Number(tabSelect.value);
    // Supersede preparation that may still be waiting on permission, bridge
    // installation, or the page command for this tab.
    preparationGenerationByTab.set(tabId, (preparationGenerationByTab.get(tabId) || 0) + 1);
    const job = jobsByTab.get(tabId);
    if (
      job &&
      (["recording", "merging", "repairing"].includes(job.state) ||
        job.segments.some((segment) => segment.retrying))
    ) {
      throw new Error("Stop the segmented job before removing its players.");
    }
    const result = await execute(tabId, "cleanup", { jobId: job?.jobId });
    if (result.ok) {
      if (job) await removeTemporaryFiles(job);
      jobsByTab.delete(tabId);
      onJobUpdate(null, tabId);
    }
    return result;
  }

  /** Republishes the selected tab's current controller snapshot. */
  async function syncSelectedTab() {
    const tabId = Number(tabSelect.value);
    const job = jobsByTab.get(tabId) || null;
    if (job) notifyUpdate(job);
    else onJobUpdate(null, tabId);
    return job;
  }

  /** Resolves job state when its source tab closes or navigates away. */
  async function handleTabUnavailable(tabId, reason = "The website tab was closed or navigated.") {
    const job = jobsByTab.get(tabId);
    if (!job) return;
    if (["merging", "repairing", "merge_failed", "completed"].includes(job.state)) return;
    if (["preparing", "ready", "recording"].includes(job.state)) {
      await failJob(job, reason);
    } else if (job.state === "retryable") {
      job.error = {
        segmentId: job.error?.segmentId || null,
        message: `${reason} Completed files were retained, but failed segments need the original page.`,
      };
      notifyUpdate(job);
    }
  }

  return {
    prepareSelectedTab,
    startSelectedJob,
    stopSelectedJob,
    retrySegment,
    retryMergeSelectedJob,
    cleanupSelectedTab,
    syncSelectedTab,
    handleTabUnavailable,
    /** Returns the live controller job associated with a tab. */
    getJobForTab: (tabId) => jobsByTab.get(tabId) || null,
  };
}
