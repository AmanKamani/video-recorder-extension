/** Returns whether a media position has reached a segment's exclusive end boundary. */
export function shouldStopAtBoundary(currentTime, endTime) {
  return Number.isFinite(currentTime) && Number.isFinite(endTime) && currentTime >= endTime;
}

/** Calculates bounded progress within one media-time range. */
export function calculateSegmentProgress(currentTime, startTime, endTime) {
  const duration = endTime - startTime;
  if (!(duration > 0)) return 0;
  return Math.max(0, Math.min(1, (currentTime - startTime) / duration));
}

/** Rejects events from page jobs that have been replaced. */
export function isCurrentSegmentJob(job, jobId) {
  return !!job && !!jobId && job.jobId === jobId;
}

/** Background tabs are allowed to recover before a stalled segment is failed. */
export function isSegmentStalled(lastProgressAt, now, timeoutMs, pageHidden) {
  return !pageHidden && now - lastProgressAt > timeoutMs;
}

/** Limits cross-context progress traffic while preserving terminal updates. */
export function shouldEmitProgressUpdate(lastEmitAt, now, intervalMs, force = false) {
  return force || !lastEmitAt || now - lastEmitAt >= intervalMs;
}

/** Derives the user-visible state while the lifecycle remains recording. */
export function getTransientRecordingState(flowPaused, bufferingPaused) {
  if (flowPaused) return "writing";
  if (bufferingPaused) return "buffering";
  return "recording";
}

/** Returns the MediaRecorder transition needed to match the current playback pause reasons. */
export function getRecorderStateAction(recorderState, flowPaused, bufferingPaused) {
  const shouldPause = flowPaused || bufferingPaused;
  if (shouldPause && recorderState === "recording") return "pause";
  if (!shouldPause && recorderState === "paused") return "resume";
  return null;
}

/** Clamps a dragged overlay rectangle to the visible viewport. */
export function clampOverlayPosition(rect, viewportWidth, viewportHeight) {
  return {
    left: Math.max(0, Math.min(rect.left, Math.max(0, viewportWidth - rect.width))),
    top: Math.max(0, Math.min(rect.top, Math.max(0, viewportHeight - rect.height))),
  };
}

/** Builds short contiguous ranges used only by the temporary merge test mode. */
export function calculateFixedTestRanges(totalDuration, segmentCount, segmentDuration) {
  const requiredDuration = segmentCount * segmentDuration;
  if (!Number.isFinite(totalDuration) || totalDuration < requiredDuration) {
    throw new Error(
      `Temporary test mode requires a video of at least ${requiredDuration} seconds.`,
    );
  }
  return Array.from({ length: segmentCount }, (_, index) => ({
    id: `segment-${index + 1}`,
    index,
    startTime: index * segmentDuration,
    endTime: (index + 1) * segmentDuration,
    duration: segmentDuration,
  }));
}

/** Reads a rendition height from normalized HLS fields or its resolution attribute. */
function advertisedLevelHeight(level) {
  const direct = Number(level?.height);
  if (direct > 0) return direct;
  const resolution = String(level?.attrs?.RESOLUTION || "");
  const match = resolution.match(/^\d+x(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

/** Chooses the highest advertised stream height or a configured fallback. */
export function deriveTargetHeight(levels, fallbackHeight) {
  const heights = (levels || []).map(advertisedLevelHeight).filter((height) => height > 0);
  return heights.length ? Math.max(...heights) : fallbackHeight;
}

/** Finds the rendition whose advertised height is closest to the locked target. */
export function selectLevelForHeight(levels, targetHeight) {
  let selectedIndex = -1;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < (levels || []).length; index += 1) {
    const height = advertisedLevelHeight(levels[index]);
    if (!(height > 0)) continue;
    const distance = Math.abs(height - targetHeight);
    if (distance < selectedDistance) {
      selectedIndex = index;
      selectedDistance = distance;
    }
  }
  return selectedIndex;
}

/** Accepts small codec-padding differences while rejecting a different rendition. */
export function matchesLockedQualityDimensions(
  videoWidth,
  videoHeight,
  quality,
  tolerancePixels = 0,
) {
  const actualWidth = Number(videoWidth);
  const actualHeight = Number(videoHeight);
  const expectedWidth = Number(quality?.width);
  const expectedHeight = Number(quality?.height);
  const tolerance = Math.max(0, Number(tolerancePixels) || 0);
  if (!(actualHeight > 0)) return false;
  if (expectedHeight > 0 && Math.abs(actualHeight - expectedHeight) > tolerance) return false;
  if (expectedWidth > 0) {
    if (!(actualWidth > 0) || Math.abs(actualWidth - expectedWidth) > tolerance) return false;
  }
  return true;
}

/** Builds a serializable diagnostic snapshot without stream URLs or media/key payloads. */
export function buildSafeStreamMetadata({
  hlsVersion,
  duration,
  videoWidth,
  videoHeight,
  levels = [],
  audioTracks = [],
  subtitleTracks = [],
  quality = null,
}) {
  /** Converts finite numeric metadata to numbers and all other values to null. */
  const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  /** Selects serializable, non-sensitive fields from an HLS track. */
  const trackMetadata = (track, index) => ({
    index,
    id: track?.id ?? null,
    name: track?.name ?? null,
    lang: track?.lang ?? null,
    groupId: track?.groupId ?? null,
    default: track?.default ?? null,
    autoselect: track?.autoselect ?? null,
    forced: track?.forced ?? null,
    channels: track?.channels ?? null,
    audioCodec: track?.audioCodec ?? null,
  });
  return {
    hlsVersion: hlsVersion || null,
    durationSeconds: finite(duration),
    mediaDimensions: {
      width: finite(videoWidth),
      height: finite(videoHeight),
    },
    quality,
    levels: levels.map((level, index) => ({
      index,
      name: level?.name ?? null,
      width: finite(level?.width),
      height: finite(level?.height),
      bitrate: finite(level?.bitrate),
      averageBitrate: finite(level?.averageBitrate),
      frameRate: finite(level?.frameRate),
      videoCodec: level?.videoCodec ?? null,
      audioCodec: level?.audioCodec ?? null,
      codecSet: level?.codecSet ?? null,
      channels: level?.channels ?? null,
      hdrRange: level?.hdrRange ?? null,
      details: level?.details
        ? {
            live: !!level.details.live,
            totalDuration: finite(level.details.totalduration),
            targetDuration: finite(level.details.targetduration),
            averageTargetDuration: finite(level.details.averagetargetduration),
            startSequence: finite(level.details.startSN),
            endSequence: finite(level.details.endSN),
            fragmentCount: Array.isArray(level.details.fragments)
              ? level.details.fragments.length
              : null,
          }
        : null,
    })),
    audioTracks: audioTracks.map(trackMetadata),
    subtitleTracks: subtitleTracks.map(trackMetadata),
  };
}

/**
 * Self-contained MAIN-world command. Chrome serializes this function, so every
 * browser-page dependency intentionally lives inside the function body.
 */
export async function segmentedPageCommand(command, options = {}) {
  const GLOBAL_KEY = "__hlsSidePanelSegmentJobV1";
  const CHANNEL = "hls-side-panel-segment-recorder-v2";
  const existing = window[GLOBAL_KEY];
  // This command is serialized into the page's MAIN world, so these helpers must
  // remain self-contained instead of closing over the equivalent module exports.
  /** Decides whether enough time has elapsed to publish another progress update. */
  const shouldEmitProgress = (lastEmitAt, now, intervalMs, force = false) =>
    force || !lastEmitAt || now - lastEmitAt >= intervalMs;
  /** Maps independent flow-control and media-buffering pauses to a display state. */
  const transientRecordingState = (flowPaused, bufferingPaused) => {
    if (flowPaused) return "writing";
    if (bufferingPaused) return "buffering";
    return "recording";
  };
  /** Chooses the MediaRecorder transition required by the active pause reasons. */
  const recorderStateAction = (recorderState, flowPaused, bufferingPaused) => {
    const shouldPause = flowPaused || bufferingPaused;
    if (shouldPause && recorderState === "recording") return "pause";
    if (!shouldPause && recorderState === "paused") return "resume";
    return null;
  };
  /** Publishes a job-scoped event from the page world to the extension bridge. */
  const emit = (type, detail = {}) => {
    window.postMessage(
      {
        channel: CHANNEL,
        type,
        jobId: detail.jobId || window[GLOBAL_KEY]?.jobId || options.jobId,
        segmentId: detail.segmentId || null,
        detail,
      },
      "*",
    );
  };
  /** Produces the serializable public view of a page-world recording job. */
  const snapshot = (job) => ({
    ok: true,
    exists: !!job,
    jobId: job?.jobId || null,
    state: job?.state || "idle",
    duration: job?.duration || null,
    quality: job?.quality || null,
    streamMetadata: job?.streamMetadata || null,
    error: job?.error || null,
    segments:
      job?.segments?.map((segment) => ({
        id: segment.id,
        index: segment.index,
        startTime: segment.startTime,
        endTime: segment.endTime,
        duration: segment.duration,
        state: segment.state,
        progress: segment.progress,
        quality: segment.quality || null,
        error: segment.error || null,
      })) || [],
  });
  /** Commits a durable segment lifecycle state and updates its overlay controls. */
  const setSegmentUi = (segment, state, progress = segment.progress || 0) => {
    segment.state = state;
    segment.progress = Math.max(0, Math.min(1, progress));
    if (segment.statusEl) segment.statusEl.textContent = state;
    if (segment.progressEl) segment.progressEl.value = segment.progress;
    if (segment.progressTextEl) {
      segment.progressTextEl.textContent = `${Math.round(segment.progress * 100)}%`;
    }
  };
  /** Displays a transient recording substate without replacing the lifecycle state. */
  const setTransientSegmentUi = (segment, state, progress = segment.progress || 0) => {
    segment.progress = Math.max(0, Math.min(1, progress));
    if (segment.statusEl) segment.statusEl.textContent = state;
    if (segment.progressEl) segment.progressEl.value = segment.progress;
    if (segment.progressTextEl) {
      segment.progressTextEl.textContent = `${Math.round(segment.progress * 100)}%`;
    }
  };
  /** Releases all media, HLS, DOM, timer, and message resources owned by a job. */
  const destroyJob = (job) => {
    if (!job) return;
    for (const segment of job.segments || []) {
      try {
        segment.video?.pause();
      } catch (_) {}
      try {
        if (segment.recorder?.state && segment.recorder.state !== "inactive") {
          segment.recorder.stop();
        }
      } catch (_) {}
      try {
        segment.stream?.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      try {
        segment.hls?.destroy();
      } catch (_) {}
      if (segment.waitingHandler) {
        segment.video?.removeEventListener("waiting", segment.waitingHandler);
      }
      if (segment.playingHandler) {
        segment.video?.removeEventListener("playing", segment.playingHandler);
      }
      try {
        segment.video?.remove();
      } catch (_) {}
    }
    try {
      job.overlay?.remove();
    } catch (_) {}
    clearInterval(job.watchdogInterval);
    if (job.unloadHandler) window.removeEventListener("beforeunload", job.unloadHandler);
    if (job.visibilityHandler) {
      document.removeEventListener("visibilitychange", job.visibilityHandler);
    }
    if (job.bridgeFailureHandler) window.removeEventListener("message", job.bridgeFailureHandler);
    if (job.flowHandler) window.removeEventListener("message", job.flowHandler);
    if (window[GLOBAL_KEY] === job) delete window[GLOBAL_KEY];
  };

  if (command === "status") return snapshot(existing);
  if (command === "cleanup") {
    if (existing?.state === "recording") {
      return { ok: false, message: "Stop the segmented recording before removing its players." };
    }
    destroyJob(existing);
    return { ok: true, message: "Segment players removed." };
  }
  if (command === "stop") {
    if (!existing || existing.jobId !== options.jobId || existing.state !== "recording") {
      return { ok: false, message: "No matching segmented recording is active." };
    }
    existing.state = "cancelled";
    clearInterval(existing.watchdogInterval);
    for (const segment of existing.segments) {
      try {
        segment.video.pause();
      } catch (_) {}
      if (segment.state === "recording") {
        setSegmentUi(segment, "cancelled", segment.progress);
        try {
          segment.recorder.requestData();
          segment.recorder.stop();
        } catch (_) {}
      }
    }
    if (existing.unloadHandler) window.removeEventListener("beforeunload", existing.unloadHandler);
    emit("job-cancelled", { jobId: existing.jobId, message: "Recording cancelled by the user." });
    return { ok: true, message: "All segment recorders were stopped." };
  }

  if (command === "prepare") {
    if (existing?.state === "recording") {
      return { ok: false, message: "A segmented recording is already active in this tab." };
    }
    const singleProbe = window.__hlsSidePanelProbe;
    if (singleProbe?.recording?.recorder?.state === "recording") {
      return { ok: false, message: "Stop the single-player recording before using segments." };
    }
    try {
      singleProbe?.hls?.destroy();
      singleProbe?.video?.remove();
      if (singleProbe) delete window.__hlsSidePanelProbe;
    } catch (_) {}
    destroyJob(existing);
    const {
      jobId,
      playlistUrl,
      segmentCount,
      maxSegments = 8,
      lockQuality = true,
      fallbackQualityHeight = 720,
      qualityDimensionTolerancePixels = 4,
      fixedSegmentDurationSeconds = null,
      preparationTimeoutMs = 30000,
    } = options;
    if (
      !jobId ||
      !playlistUrl ||
      !Number.isInteger(segmentCount) ||
      segmentCount < 2 ||
      segmentCount > maxSegments
    ) {
      return {
        ok: false,
        message: `A playlist, job ID, and segment count from 2 to ${maxSegments} are required.`,
      };
    }
    const HlsConstructor = window.Hls;
    if (typeof HlsConstructor !== "function" || !HlsConstructor.isSupported()) {
      return { ok: false, message: "The website's HLS player is unavailable or unsupported." };
    }

    const overlay = document.createElement("section");
    overlay.id = "hls-side-panel-segment-grid";
    overlay.style.cssText =
      "position:fixed;top:12px;right:12px;width:min(760px,80vw);max-height:80vh;" +
      "overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(260px,1fr));gap:8px;" +
      "padding:10px;background:#111827ee;border:2px solid #2563eb;border-radius:10px;" +
      "z-index:2147483647;color:#f9fafb;font:12px Arial,sans-serif";
    const overlayHeader = document.createElement("header");
    overlayHeader.style.cssText =
      "grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;" +
      "gap:8px;cursor:move;user-select:none;padding:2px 2px 6px";
    const overlayTitle = document.createElement("strong");
    overlayTitle.textContent = `HLS recording segments (${segmentCount})`;
    const minimizeButton = document.createElement("button");
    minimizeButton.type = "button";
    minimizeButton.title = "Minimize segment players";
    minimizeButton.setAttribute("aria-label", "Minimize segment players");
    minimizeButton.textContent = "−";
    minimizeButton.style.cssText =
      "width:28px;height:24px;padding:0;border:0;border-radius:4px;background:#374151;" +
      "color:#fff;cursor:pointer;font:700 16px Arial";
    overlayHeader.append(overlayTitle, minimizeButton);
    overlay.appendChild(overlayHeader);
    document.body.appendChild(overlay);
    const job = {
      jobId,
      state: "preparing",
      duration: null,
      error: null,
      overlay,
      segments: [],
      terminalEmitted: false,
      mimeType: null,
      unloadHandler: null,
      minimized: false,
    };
    window[GLOBAL_KEY] = job;

    minimizeButton.addEventListener("click", () => {
      job.minimized = !job.minimized;
      for (const segment of job.segments) segment.card.hidden = job.minimized;
      overlay.style.gridTemplateColumns = job.minimized
        ? "minmax(220px,1fr)"
        : "repeat(2,minmax(260px,1fr))";
      overlay.style.width = job.minimized ? "260px" : "min(760px,80vw)";
      minimizeButton.textContent = job.minimized ? "+" : "−";
      minimizeButton.title = job.minimized ? "Restore segment players" : "Minimize segment players";
      minimizeButton.setAttribute("aria-label", minimizeButton.title);
      if (overlay.style.left) {
        const rect = overlay.getBoundingClientRect();
        overlay.style.left = `${Math.max(
          0,
          Math.min(rect.left, Math.max(0, window.innerWidth - rect.width)),
        )}px`;
        overlay.style.top = `${Math.max(
          0,
          Math.min(rect.top, Math.max(0, window.innerHeight - rect.height)),
        )}px`;
      }
    });

    overlayHeader.addEventListener("pointerdown", (event) => {
      if (event.target === minimizeButton || event.button !== 0) return;
      const initial = overlay.getBoundingClientRect();
      const offsetX = event.clientX - initial.left;
      const offsetY = event.clientY - initial.top;
      overlay.style.right = "auto";
      overlayHeader.setPointerCapture(event.pointerId);
      /** Repositions the overlay while constraining it to the current viewport. */
      const move = (moveEvent) => {
        const width = overlay.offsetWidth;
        const height = overlay.offsetHeight;
        const left = Math.max(
          0,
          Math.min(moveEvent.clientX - offsetX, Math.max(0, window.innerWidth - width)),
        );
        const top = Math.max(
          0,
          Math.min(moveEvent.clientY - offsetY, Math.max(0, window.innerHeight - height)),
        );
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
      };
      /** Ends overlay dragging and removes its pointer listeners. */
      const finish = () => {
        overlayHeader.removeEventListener("pointermove", move);
        overlayHeader.removeEventListener("pointerup", finish);
        overlayHeader.removeEventListener("pointercancel", finish);
      };
      overlayHeader.addEventListener("pointermove", move);
      overlayHeader.addEventListener("pointerup", finish);
      overlayHeader.addEventListener("pointercancel", finish);
    });

    /** Creates one segment's hidden player, status card, and mutable runtime record. */
    const createCard = (index) => {
      const card = document.createElement("article");
      card.style.cssText =
        "background:#1f2937;border:1px solid #4b5563;border-radius:7px;padding:8px";
      const title = document.createElement("strong");
      title.textContent = `Segment ${index + 1}`;
      const rangeEl = document.createElement("div");
      rangeEl.style.cssText = "margin:4px 0;color:#cbd5e1";
      rangeEl.textContent = "Calculating range…";
      const video = document.createElement("video");
      video.controls = true;
      video.playsInline = true;
      video.muted = true;
      video.style.cssText = "display:block;width:100%;max-height:210px;background:#000";
      const statusRow = document.createElement("div");
      statusRow.style.cssText = "display:flex;justify-content:space-between;margin-top:5px";
      const statusEl = document.createElement("span");
      statusEl.textContent = "preparing";
      const progressTextEl = document.createElement("span");
      progressTextEl.textContent = "0%";
      statusRow.append(statusEl, progressTextEl);
      const progressEl = document.createElement("progress");
      progressEl.max = 1;
      progressEl.value = 0;
      progressEl.style.width = "100%";
      card.append(title, rangeEl, video, statusRow, progressEl);
      overlay.appendChild(card);
      return {
        id: `segment-${index + 1}`,
        index,
        video,
        card,
        rangeEl,
        statusEl,
        progressEl,
        progressTextEl,
        state: "preparing",
        progress: 0,
        sequence: 0,
      };
    };

    /** Waits for usable media data and optionally verifies a requested seek position. */
    const waitForReady = (segment, seekTime = null) =>
      new Promise((resolve, reject) => {
        if (segment.error) {
          reject(new Error(segment.error));
          return;
        }
        let settled = false;
        const timeout = setTimeout(
          () => finish(new Error(`Segment ${segment.index + 1} preparation timed out.`)),
          preparationTimeoutMs,
        );
        /** Settles preparation exactly once and detaches all readiness listeners. */
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          segment.rejectPreparation = null;
          segment.video.removeEventListener("loadedmetadata", onMedia);
          segment.video.removeEventListener("canplay", onMedia);
          segment.video.removeEventListener("seeked", onMedia);
          if (error) reject(error);
          else resolve();
        };
        /** Rechecks duration, seek position, and decoded-data readiness after media events. */
        const onMedia = () => {
          if (!Number.isFinite(segment.video.duration) || segment.video.duration <= 0) return;
          if (seekTime !== null && Math.abs(segment.video.currentTime - seekTime) > 0.35) {
            try {
              segment.video.currentTime = seekTime;
            } catch (_) {}
            return;
          }
          if (segment.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish();
        };
        segment.video.addEventListener("loadedmetadata", onMedia);
        segment.video.addEventListener("canplay", onMedia);
        segment.video.addEventListener("seeked", onMedia);
        /** Allows fatal HLS errors to reject the active preparation wait. */
        segment.rejectPreparation = (error) => finish(error);
        onMedia();
      });

    /** Attaches an HLS instance and routes fatal loading errors into the job lifecycle. */
    const attachHls = (segment) => {
      const hls = new HlsConstructor();
      segment.hls = hls;
      hls.on(HlsConstructor.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          const error = data.details || data.type || "Fatal HLS error";
          segment.error = error;
          if (typeof job.onFatalError === "function") job.onFatalError(segment, new Error(error));
          else if (typeof segment.rejectPreparation === "function") {
            segment.rejectPreparation(new Error(error));
          }
        }
      });
      hls.on(HlsConstructor.Events.MEDIA_ATTACHED, () => hls.loadSource(playlistUrl));
      hls.attachMedia(segment.video);
    };

    /** Reads a rendition height from normalized HLS fields or its resolution attribute. */
    const getLevelHeight = (level) => {
      const direct = Number(level?.height);
      if (direct > 0) return direct;
      const match = String(level?.attrs?.RESOLUTION || "").match(/^\d+x(\d+)$/i);
      return match ? Number(match[1]) : 0;
    };
    /** Selects the highest advertised height, falling back to decoded or configured height. */
    const chooseTargetHeight = (segment) => {
      const heights = (segment.hls?.levels || [])
        .map(getLevelHeight)
        .filter((height) => height > 0);
      if (heights.length) return Math.max(...heights);
      return Number(segment.video.videoHeight) || fallbackQualityHeight;
    };
    /** Pins one segment to the rendition nearest the shared target height. */
    const lockSegmentQuality = (segment, targetHeight) => {
      if (!lockQuality) return null;
      const levels = segment.hls?.levels || [];
      let levelIndex = -1;
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < levels.length; index += 1) {
        const height = getLevelHeight(levels[index]);
        if (!(height > 0)) continue;
        const nextDistance = Math.abs(height - targetHeight);
        if (nextDistance < distance) {
          levelIndex = index;
          distance = nextDistance;
        }
      }
      if (levelIndex < 0 && segment.hls?.currentLevel >= 0) {
        levelIndex = segment.hls.currentLevel;
      }
      if (levelIndex < 0 && levels.length === 1) levelIndex = 0;
      if (levelIndex < 0 && levels.length > 1) {
        levelIndex = levels.reduce(
          (best, level, index) =>
            Number(level?.bitrate || 0) > Number(levels[best]?.bitrate || 0) ? index : best,
          0,
        );
      }
      if (levelIndex < 0) return null;
      try {
        segment.hls.autoLevelCapping = levelIndex;
        segment.hls.loadLevel = levelIndex;
        segment.hls.nextLevel = levelIndex;
        segment.hls.currentLevel = levelIndex;
      } catch (_) {}
      const level = levels[levelIndex] || {};
      const quality = {
        levelIndex,
        width: Number(level.width) || null,
        height: getLevelHeight(level) || Number(segment.video.videoHeight) || targetHeight,
        bitrate: Number(level.bitrate) || null,
      };
      segment.quality = quality;
      return quality;
    };
    /** Waits until HLS selection and decoded dimensions both reflect the locked rendition. */
    const waitForLockedQuality = async (segment, quality, seekTime) => {
      if (!quality) return;
      /** Verifies decoded dimensions against the selected rendition within tolerance. */
      const dimensionsMatch = () => {
        const actualWidth = Number(segment.video.videoWidth);
        const actualHeight = Number(segment.video.videoHeight);
        const expectedWidth = Number(quality.width);
        const expectedHeight = Number(quality.height);
        const tolerance = Math.max(0, Number(qualityDimensionTolerancePixels) || 0);
        if (!(actualHeight > 0)) return false;
        if (expectedHeight > 0 && Math.abs(actualHeight - expectedHeight) > tolerance) return false;
        if (expectedWidth > 0) {
          if (!(actualWidth > 0) || Math.abs(actualWidth - expectedWidth) > tolerance) return false;
        }
        return true;
      };
      try {
        await segment.video.play();
      } catch (error) {
        throw new Error(
          `Segment ${segment.index + 1} could not start quality preparation: ${
            error?.message || error
          }`,
        );
      }
      try {
        await new Promise((resolve, reject) => {
          const startedAt = Date.now();
          /** Polls HLS level and decoded-frame convergence until success or timeout. */
          const check = () => {
            if (segment.error) {
              clearInterval(interval);
              reject(new Error(segment.error));
              return;
            }
            const correctLevel =
              segment.hls.currentLevel === quality.levelIndex ||
              segment.hls.loadLevel === quality.levelIndex;
            if (correctLevel && dimensionsMatch() && segment.video.readyState >= 2) {
              clearInterval(interval);
              resolve();
            } else if (Date.now() - startedAt >= preparationTimeoutMs) {
              clearInterval(interval);
              reject(
                new Error(
                  `Segment ${segment.index + 1} could not lock to ${
                    quality.height || fallbackQualityHeight
                  }p (target level ${quality.levelIndex}, current level ${
                    segment.hls.currentLevel
                  }, load level ${segment.hls.loadLevel}, decoded ${Number(
                    segment.video.videoWidth,
                  )}x${Number(segment.video.videoHeight)}).`,
                ),
              );
            }
          };
          const interval = setInterval(check, 100);
          check();
        });
      } finally {
        segment.video.pause();
      }
      await waitForReady(segment, seekTime);
    };
    /** Captures serializable stream diagnostics without media payloads or source URLs. */
    const collectStreamMetadata = (segment) => {
      /** Converts finite numeric metadata to numbers and all other values to null. */
      const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
      /** Selects serializable, non-sensitive fields from an HLS track. */
      const trackMetadata = (track, index) => ({
        index,
        id: track?.id ?? null,
        name: track?.name ?? null,
        lang: track?.lang ?? null,
        groupId: track?.groupId ?? null,
        default: track?.default ?? null,
        autoselect: track?.autoselect ?? null,
        forced: track?.forced ?? null,
        channels: track?.channels ?? null,
        audioCodec: track?.audioCodec ?? null,
      });
      return {
        hlsVersion: HlsConstructor.version || null,
        durationSeconds: finite(job.duration),
        mediaDimensions: {
          width: finite(segment.video.videoWidth),
          height: finite(segment.video.videoHeight),
        },
        quality: job.quality,
        levels: (segment.hls?.levels || []).map((level, index) => ({
          index,
          name: level?.name ?? null,
          width: finite(level?.width),
          height: finite(getLevelHeight(level)),
          bitrate: finite(level?.bitrate),
          averageBitrate: finite(level?.averageBitrate),
          frameRate: finite(level?.frameRate),
          videoCodec: level?.videoCodec ?? null,
          audioCodec: level?.audioCodec ?? null,
          codecSet: level?.codecSet ?? null,
          channels: level?.channels ?? null,
          hdrRange: level?.hdrRange ?? null,
          details: level?.details
            ? {
                live: !!level.details.live,
                totalDuration: finite(level.details.totalduration),
                targetDuration: finite(level.details.targetduration),
                averageTargetDuration: finite(level.details.averagetargetduration),
                startSequence: finite(level.details.startSN),
                endSequence: finite(level.details.endSN),
                fragmentCount: Array.isArray(level.details.fragments)
                  ? level.details.fragments.length
                  : null,
              }
            : null,
        })),
        audioTracks: (segment.hls?.audioTracks || []).map(trackMetadata),
        subtitleTracks: (segment.hls?.subtitleTracks || []).map(trackMetadata),
        segmentPlayers: job.segments.map((item) => ({
          segmentId: item.id,
          startTime: item.startTime,
          endTime: item.endTime,
          lockedLevel: item.quality?.levelIndex ?? null,
          width: item.quality?.width ?? null,
          height: item.quality?.height ?? null,
          bitrate: item.quality?.bitrate ?? null,
        })),
      };
    };

    try {
      for (let index = 0; index < segmentCount; index += 1) {
        const segment = createCard(index);
        job.segments.push(segment);
        attachHls(segment);
      }
      await waitForReady(job.segments[0]);
      const duration = job.segments[0].video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Segmented recording supports finite VOD streams only.");
      }
      const fixedDuration =
        Number.isFinite(fixedSegmentDurationSeconds) && fixedSegmentDurationSeconds > 0
          ? fixedSegmentDurationSeconds
          : null;
      const recordingDuration = fixedDuration ? fixedDuration * segmentCount : duration;
      if (duration < recordingDuration) {
        throw new Error(
          `Temporary test mode requires a video of at least ${recordingDuration} seconds.`,
        );
      }
      const targetHeight = lockQuality
        ? chooseTargetHeight(job.segments[0])
        : Number(job.segments[0].video.videoHeight) || null;
      const hasAdvertisedHeight = (job.segments[0].hls?.levels || []).some(
        (level) => getLevelHeight(level) > 0,
      );
      job.quality = {
        locked: !!lockQuality,
        targetHeight,
        fallbackUsed:
          !!lockQuality && !hasAdvertisedHeight && !(Number(job.segments[0].video.videoHeight) > 0),
      };
      job.duration = recordingDuration;
      for (const segment of job.segments) {
        segment.startTime = fixedDuration
          ? fixedDuration * segment.index
          : (duration * segment.index) / segmentCount;
        segment.endTime = fixedDuration
          ? fixedDuration * (segment.index + 1)
          : segment.index === segmentCount - 1
            ? duration
            : (duration * (segment.index + 1)) / segmentCount;
        segment.duration = segment.endTime - segment.startTime;
        segment.rangeEl.textContent = `${segment.startTime.toFixed(2)}s → ${segment.endTime.toFixed(2)}s`;
      }
      await Promise.all(
        job.segments.map(async (segment) => {
          await waitForReady(segment);
          const quality = lockSegmentQuality(segment, targetHeight);
          await waitForReady(segment, segment.startTime);
          await waitForLockedQuality(segment, quality, segment.startTime);
          if (segment.error) throw new Error(segment.error);
          segment.video.pause();
          setSegmentUi(segment, "ready", 0);
          emit("segment-status", {
            jobId,
            segmentId: segment.id,
            state: "ready",
            startTime: segment.startTime,
            endTime: segment.endTime,
            duration: segment.duration,
            progress: 0,
          });
        }),
      );
      job.streamMetadata = collectStreamMetadata(job.segments[0]);
      job.state = "ready";
      /** Fails a prepared job when HLS reports a fatal error before recording starts. */
      job.onFatalError = (segment, error) => {
        if (job.state !== "ready") return;
        job.state = "failed";
        job.error = error?.message || String(error);
        for (const item of job.segments) {
          try {
            item.video.pause();
          } catch (_) {}
          setSegmentUi(item, item === segment ? "failed" : "cancelled", item.progress);
        }
        emit("job-failed", {
          jobId,
          segmentId: segment?.id || null,
          message: job.error,
        });
      };
      emit("job-ready", {
        jobId,
        duration: recordingDuration,
        segments: snapshot(job).segments,
      });
      return snapshot(job);
    } catch (error) {
      job.state = "failed";
      job.error = error?.message || String(error);
      emit("job-failed", { jobId, message: job.error });
      destroyJob(job);
      return { ok: false, message: job.error };
    }
  }

  if (command === "retry-segment") {
    const job = existing;
    const segment = job?.segments?.find((item) => item.id === options.segmentId);
    if (
      !job ||
      job.jobId !== options.jobId ||
      job.state === "cancelled" ||
      !segment ||
      !["failed", "finished", "incompatible"].includes(segment.state) ||
      typeof job.startSegment !== "function"
    ) {
      return { ok: false, message: "The selected segment is not available for retry." };
    }
    job.state = "recording";
    job.error = null;
    job.terminalEmitted = false;
    segment.sequence = 0;
    segment.error = null;
    segment.progress = 0;
    emit("segment-retry-start", { jobId: job.jobId, segmentId: segment.id });
    job.ensureWatchdog();
    if (job.visibilityHandler) {
      document.removeEventListener("visibilitychange", job.visibilityHandler);
      document.addEventListener("visibilitychange", job.visibilityHandler);
    }
    if (job.unloadHandler) {
      window.removeEventListener("beforeunload", job.unloadHandler);
      window.addEventListener("beforeunload", job.unloadHandler);
    }
    await job.startSegment(segment);
    emit("job-recording", { jobId: job.jobId, segments: snapshot(job).segments });
    return { ...snapshot(job), mimeType: job.mimeType };
  }

  if (command === "start") {
    const job = existing;
    if (!job || job.jobId !== options.jobId || job.state !== "ready") {
      return { ok: false, message: "The matching segment players are not ready." };
    }
    const mimeTypes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return { ok: false, message: "No supported WebM recording format was found." };
    job.mimeType = mimeType;

    job.timesliceMs = options.timesliceMs || 1000;
    job.progressIntervalMs = Math.max(50, Number(options.progressIntervalMs) || 250);
    const terminalStates = new Set(["finished", "failed", "incompatible"]);
    /** Emits one job terminal result only after every segment reaches a terminal state. */
    const maybeCompletePass = () => {
      // This is the terminal barrier: no job-level completion may race ahead of
      // a segment recorder's final dataavailable/onstop sequence.
      if (job.segments.some((segment) => !terminalStates.has(segment.state))) return;
      clearInterval(job.watchdogInterval);
      job.watchdogInterval = null;
      if (job.terminalEmitted) return;
      job.terminalEmitted = true;
      if (job.segments.every((segment) => segment.state === "finished")) {
        job.state = "finished";
        if (job.unloadHandler) window.removeEventListener("beforeunload", job.unloadHandler);
        if (job.visibilityHandler) {
          document.removeEventListener("visibilitychange", job.visibilityHandler);
        }
        emit("job-finished", { jobId: job.jobId, durationMs: Math.round(job.duration * 1000) });
        return;
      }
      job.state = "retryable";
      const failedSegments = job.segments.filter((segment) => segment.state === "failed");
      emit("job-incomplete", {
        jobId: job.jobId,
        failedSegmentIds: failedSegments.map((segment) => segment.id),
        message: `${failedSegments.length} segment${failedSegments.length === 1 ? "" : "s"} must be retried.`,
      });
    };
    /** Finalizes a deferred failure after the recorder has flushed and stopped. */
    const finishFailedSegment = (segment) => {
      if (!segment.failure) return;
      const message = segment.failure;
      segment.failure = null;
      segment.error = message;
      setSegmentUi(segment, "failed", segment.progress);
      emit("segment-failed", {
        jobId: job.jobId,
        segmentId: segment.id,
        state: "failed",
        progress: segment.progress,
        message,
      });
      maybeCompletePass();
    };
    /** Records a segment failure and stops its recorder before publishing terminal state. */
    const failSegment = (segment, error, allowFinished = false) => {
      if (
        !segment ||
        (segment.state !== "recording" && !(allowFinished && segment.state === "finished")) ||
        segment.failure
      ) {
        return;
      }
      if (segment.state === "finished") {
        job.state = "recording";
        job.terminalEmitted = false;
      }
      segment.failure = error?.message || String(error);
      try {
        segment.video.pause();
      } catch (_) {}
      try {
        // Preserve MediaRecorder ordering: request the last blob and let onstop
        // convert the deferred failure into a terminal segment state.
        if (segment.recorder?.state === "recording") segment.recorder.requestData();
        if (segment.recorder?.state && segment.recorder.state !== "inactive") {
          segment.recorder.stop();
          return;
        }
      } catch (_) {}
      try {
        segment.stream?.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      finishFailedSegment(segment);
    };
    /** Converts asynchronous extension-writer failures into page segment failures. */
    job.bridgeFailureHandler = (event) => {
      const data = event.data;
      if (
        event.source !== window ||
        data?.channel !== CHANNEL ||
        data?.type !== "segment-write-failed" ||
        data?.jobId !== job.jobId
      ) {
        return;
      }
      const segment = job.segments.find((item) => item.id === data.segmentId) || null;
      failSegment(
        segment,
        new Error(data.detail?.message || "A segment could not be written."),
        true,
      );
    };
    window.addEventListener("message", job.bridgeFailureHandler);
    job.onFatalError = failSegment;
    /** Publishes buffering/writing display state without changing lifecycle state. */
    const reportTransientState = (segment) => {
      if (job.state !== "recording" || segment.state !== "recording") return;
      const state = transientRecordingState(segment.flowPaused, segment.bufferingPaused);
      setTransientSegmentUi(segment, state, segment.progress);
      emit("segment-status", {
        jobId: job.jobId,
        segmentId: segment.id,
        state,
        progress: segment.progress,
        currentTime: segment.video.currentTime,
      });
    };
    /** Reconciles MediaRecorder pause state from independent flow and buffering flags. */
    const reconcileRecorderState = (segment) => {
      // Either pause source can arrive first; deriving the action from both flags
      // prevents one source from resuming while the other still requires a pause.
      const action = recorderStateAction(
        segment.recorder?.state,
        segment.flowPaused,
        segment.bufferingPaused,
      );
      if (!action) return;
      try {
        segment.recorder[action]();
      } catch (error) {
        failSegment(segment, error);
      }
    };
    /** Pauses capture state when the media element starts buffering. */
    const handleWaiting = (segment) => {
      if (job.state !== "recording" || segment.state !== "recording") return;
      segment.bufferingPaused = true;
      reconcileRecorderState(segment);
      reportTransientState(segment);
    };
    /** Clears the buffering pause once playback has actually resumed. */
    const handlePlaying = (segment) => {
      if (job.state !== "recording" || segment.state !== "recording") return;
      segment.bufferingPaused = false;
      reconcileRecorderState(segment);
      reportTransientState(segment);
    };
    for (const segment of job.segments) {
      if (segment.waitingHandler) {
        segment.video.removeEventListener("waiting", segment.waitingHandler);
      }
      if (segment.playingHandler) {
        segment.video.removeEventListener("playing", segment.playingHandler);
      }
      /** Routes this segment's waiting event through the shared buffering handler. */
      segment.waitingHandler = () => handleWaiting(segment);
      /** Routes this segment's playing event through the shared buffering handler. */
      segment.playingHandler = () => handlePlaying(segment);
      segment.video.addEventListener("waiting", segment.waitingHandler);
      segment.video.addEventListener("playing", segment.playingHandler);
    }
    /** Applies writer backpressure messages to playback and recorder state. */
    job.flowHandler = (event) => {
      const data = event.data;
      if (
        event.source !== window ||
        data?.channel !== CHANNEL ||
        data?.type !== "segment-flow" ||
        data?.jobId !== job.jobId
      ) {
        return;
      }
      const segment = job.segments.find((item) => item.id === data.segmentId);
      if (!segment || segment.state !== "recording") return;
      if (data.detail?.action === "pause" && !segment.flowPaused) {
        segment.flowPaused = true;
        try {
          segment.video.pause();
        } catch (_) {}
        reconcileRecorderState(segment);
        reportTransientState(segment);
      } else if (data.detail?.action === "resume" && segment.flowPaused) {
        segment.flowPaused = false;
        // Keep the recorder paused until a real playing event confirms that the
        // resumed media element is producing frames again.
        segment.bufferingPaused = true;
        try {
          segment.video.play().catch((error) => failSegment(segment, error));
        } catch (error) {
          failSegment(segment, error);
        }
        reportTransientState(segment);
      }
    };
    window.addEventListener("message", job.flowHandler);

    /** Marks a successfully stopped recorder as finished and checks the terminal barrier. */
    const finishSegment = (segment) => {
      if (job.state !== "recording" || segment.state !== "recording") return;
      segment.video.pause();
      setSegmentUi(segment, "finished", 1);
      emit("segment-finished", {
        jobId: job.jobId,
        segmentId: segment.id,
        state: "finished",
        progress: 1,
      });
      maybeCompletePass();
    };

    /** Tracks progress, detects stalls, and stops capture at the segment boundary. */
    const monitor = (segment, generation) => {
      // A generation token invalidates callbacks left behind by a prior retry,
      // preventing an old frame/timer callback from mutating the new attempt.
      if (
        job.state !== "recording" ||
        segment.state !== "recording" ||
        segment.monitorGeneration !== generation
      ) {
        return;
      }
      if (segment.lastObservedTime !== segment.video.currentTime) {
        segment.lastObservedTime = segment.video.currentTime;
        segment.lastProgressAt = Date.now();
      } else if (
        !segment.flowPaused &&
        !document.hidden &&
        Date.now() - (segment.lastProgressAt || Date.now()) > 30000
      ) {
        failSegment(segment, new Error(`Segment ${segment.index + 1} stopped making progress.`));
        return;
      }
      const progress = Math.max(
        0,
        Math.min(1, (segment.video.currentTime - segment.startTime) / segment.duration),
      );
      const reachedBoundary = segment.video.currentTime >= segment.endTime || segment.video.ended;
      const now = Date.now();
      if (
        shouldEmitProgress(segment.lastProgressEmitAt, now, job.progressIntervalMs, reachedBoundary)
      ) {
        segment.lastProgressEmitAt = now;
        const state = transientRecordingState(segment.flowPaused, segment.bufferingPaused);
        setTransientSegmentUi(segment, state, progress);
        emit("segment-progress", {
          jobId: job.jobId,
          segmentId: segment.id,
          state,
          progress,
          currentTime: segment.video.currentTime,
        });
      }
      if (reachedBoundary) {
        segment.video.pause();
        try {
          // requestData precedes stop so the boundary-adjacent bytes are queued
          // before onstop advances the segment through the terminal barrier.
          segment.recorder.requestData();
        } catch (_) {}
        segment.recorder.stop();
        return;
      }
      if (typeof segment.video.requestVideoFrameCallback === "function") {
        segment.video.requestVideoFrameCallback(() => monitor(segment, generation));
      } else {
        setTimeout(() => monitor(segment, generation), 100);
      }
    };
    /** Seeks, captures, records, and monitors one segment attempt. */
    const startSegment = async (segment) => {
      try {
        if (typeof segment.video.captureStream !== "function") {
          throw new Error("This browser does not support video.captureStream().");
        }
        segment.monitorGeneration = (segment.monitorGeneration || 0) + 1;
        segment.failure = null;
        segment.error = null;
        segment.flowPaused = false;
        segment.bufferingPaused = true;
        segment.sequence = 0;
        segment.lastProgressEmitAt = 0;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Segment ${segment.index + 1} retry seek timed out.`)),
            30000,
          );
          /** Resolves the retry seek once the target has decoded current data. */
          const ready = () => {
            if (
              Math.abs(segment.video.currentTime - segment.startTime) <= 0.35 &&
              segment.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            ) {
              clearTimeout(timeout);
              segment.video.removeEventListener("seeked", ready);
              segment.video.removeEventListener("canplay", ready);
              resolve();
            }
          };
          segment.video.addEventListener("seeked", ready);
          segment.video.addEventListener("canplay", ready);
          segment.video.currentTime = segment.startTime;
          ready();
        });
        const stream = segment.video.captureStream();
        if (!stream.getVideoTracks().length) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error(`Segment ${segment.index + 1} has no video track.`);
        }
        segment.stream = stream;
        segment.recorder = new MediaRecorder(stream, { mimeType });
        /** Serializes each non-empty recorder chunk for the extension writer. */
        segment.recorder.ondataavailable = (event) => {
          if (!event.data?.size) return;
          window.postMessage(
            {
              channel: CHANNEL,
              type: "segment-chunk",
              jobId: job.jobId,
              segmentId: segment.id,
              sequence: segment.sequence++,
              blob: event.data,
            },
            "*",
          );
        };
        /** Routes MediaRecorder errors into the segment failure lifecycle. */
        segment.recorder.onerror = (event) =>
          failSegment(segment, event.error || new Error("MediaRecorder failed."));
        /** Rechecks pause reasons after MediaRecorder confirms a pause. */
        segment.recorder.onpause = () => reconcileRecorderState(segment);
        /** Rechecks pause reasons after MediaRecorder confirms a resume. */
        segment.recorder.onresume = () => reconcileRecorderState(segment);
        /** Releases capture tracks and finalizes success or deferred failure. */
        segment.recorder.onstop = () => {
          segment.stream?.getTracks().forEach((track) => track.stop());
          if (segment.failure) finishFailedSegment(segment);
          else finishSegment(segment);
        };
        setSegmentUi(segment, "recording", 0);
        setTransientSegmentUi(segment, "buffering", 0);
        segment.video.controls = false;
        segment.lastObservedTime = segment.video.currentTime;
        segment.lastProgressAt = Date.now();
        segment.recorder.start(job.timesliceMs);
        reconcileRecorderState(segment);
        reportTransientState(segment);
        await segment.video.play();
        handlePlaying(segment);
        monitor(segment, segment.monitorGeneration);
      } catch (error) {
        if (segment.state !== "recording") setSegmentUi(segment, "recording", 0);
        failSegment(segment, error);
      }
    };
    /** Starts the shared stall watchdog once for the active recording pass. */
    const ensureWatchdog = () => {
      if (job.watchdogInterval) return;
      // Frame callbacks can be throttled or absent; this independent watchdog
      // catches true foreground stalls while ignoring backpressure and hidden tabs.
      job.watchdogInterval = setInterval(() => {
        if (job.state !== "recording") return;
        const stalled = job.segments.find(
          (segment) =>
            segment.state === "recording" &&
            !segment.flowPaused &&
            !document.hidden &&
            Date.now() - segment.lastProgressAt > 30000,
        );
        if (stalled) {
          failSegment(stalled, new Error(`Segment ${stalled.index + 1} stopped making progress.`));
        }
      }, 1000);
    };
    job.failSegment = failSegment;
    job.startSegment = startSegment;
    job.ensureWatchdog = ensureWatchdog;
    job.state = "recording";
    job.terminalEmitted = false;
    ensureWatchdog();
    /** Restarts foreground playback and resets stall baselines after tab throttling. */
    job.visibilityHandler = () => {
      if (document.hidden || job.state !== "recording") return;
      const now = Date.now();
      for (const segment of job.segments) {
        if (segment.state !== "recording" || segment.flowPaused) continue;
        segment.lastProgressAt = now;
        segment.lastObservedTime = segment.video.currentTime;
        segment.video.play().catch((error) => failSegment(segment, error));
      }
    };
    document.addEventListener("visibilitychange", job.visibilityHandler);
    try {
      /** Warns before navigation while page-world recorders own active media state. */
      job.unloadHandler = (event) => {
        event.preventDefault();
        event.returnValue = "";
        return "";
      };
      window.addEventListener("beforeunload", job.unloadHandler);
      await Promise.all(job.segments.map((segment) => startSegment(segment)));
      emit("job-recording", { jobId: job.jobId, segments: snapshot(job).segments });
      return { ...snapshot(job), mimeType };
    } catch (error) {
      for (const segment of job.segments) {
        if (segment.state === "recording") failSegment(segment, error);
      }
      return { ok: false, message: error?.message || String(error) };
    }
  }

  return { ok: false, message: `Unknown segmented recorder command: ${command}` };
}
