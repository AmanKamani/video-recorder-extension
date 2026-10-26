import { formatMediaTime } from "./segment-ranges.js";
import { SEGMENT_CONFIG } from "./config.js";
import { canRetrySegment } from "./segment-job-state.js";

/** Converts an internal state name into a display label. */
const labelState = (state) =>
  String(state || "preparing").replace(/^\w/, (letter) => letter.toUpperCase());

/** Describes the canonical decoded lock and notes differing manifest dimensions. */
const formatQualityLock = (job) => {
  if (!job?.quality?.locked) return "";
  const canonical = job.quality;
  const advertised = job.segments?.[0]?.quality || {};
  const actualWidth = Number(canonical.decodedWidth);
  const actualHeight = Number(canonical.decodedHeight);
  const advertisedWidth = Number(advertised.width);
  const advertisedHeight = Number(advertised.height);
  if (actualWidth > 0 && actualHeight > 0) {
    const actual = `${actualWidth}×${actualHeight} locked`;
    const differs =
      advertisedWidth > 0 &&
      advertisedHeight > 0 &&
      (advertisedWidth !== actualWidth || advertisedHeight !== actualHeight);
    return differs ? `${actual} (advertised ${advertisedWidth}×${advertisedHeight})` : actual;
  }
  return `${canonical.targetHeight}p locked`;
};

/** Normalizes a segment slider value to a supported whole number. */
export function normalizeSegmentCount(value) {
  return Math.max(
    SEGMENT_CONFIG.minSegments,
    Math.min(
      SEGMENT_CONFIG.maxSegments,
      Math.round(Number(value) || SEGMENT_CONFIG.defaultSegments),
    ),
  );
}

/** Accepts only persisted booleans, otherwise retaining the configured default. */
export function normalizeQualityLockPreference(value, configuredDefault) {
  return typeof value === "boolean" ? value : !!configuredDefault;
}

/** Formats wall-clock time for a parallel recording and freezes it after recording. */
export function getSegmentedTimerText(job, now = Date.now()) {
  if (!job?.startedAt) return "00:00";
  const end = job.recordingEndedAt || (job.state === "recording" ? now : job.startedAt);
  return formatMediaTime(Math.max(0, end - job.startedAt) / 1000);
}

/** Reports whether the selected tab's segmented job must lock configuration controls. */
export function isSegmentJobBusy(job) {
  return ["recording", "merging", "repairing"].includes(job?.state);
}

/** Selects the managed recorder after Apply, or inherently for multiple segments. */
export function usesManagedRecorder(segmentCount, managedApplied) {
  return !!managedApplied || Number(segmentCount) > 1;
}

/** Converts a controller snapshot into safe, display-only segment rows. */
export function buildSegmentRenderModel(job) {
  return (job?.segments || [])
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((segment) => ({
      id: segment.id,
      title: `Segment ${segment.index + 1}`,
      range: `${formatMediaTime(segment.startTime)} → ${formatMediaTime(segment.endTime)}`,
      duration: formatMediaTime(segment.duration),
      progress: Math.max(0, Math.min(1, Number(segment.progress) || 0)),
      percent: Math.round(Math.max(0, Math.min(1, Number(segment.progress) || 0)) * 100),
      state: labelState(segment.state),
      error: segment.error || null,
      canRetry: canRetrySegment(job?.state, segment.state),
    }));
}

/** Owns the segmented-mode controls and accessible progress list. */
export function createSegmentUi({
  countInput = document.getElementById("segmentCount"),
  countValue = document.getElementById("segmentCountValue"),
  countHint = document.getElementById("segmentCountHint"),
  applyButton = document.getElementById("applySegmentCount"),
  qualityLockInput = document.getElementById("segmentQualityLock"),
  list = document.getElementById("segmentList"),
  summary = document.getElementById("segmentSummary"),
  injectButton = document.getElementById("injectSitePlayer"),
  startButton = document.getElementById("startRecording"),
  stopButton = document.getElementById("stopRecording"),
  removeButton = document.getElementById("removeSitePlayer"),
  onApply = () => {},
  onQualityLockChange = () => {},
  onRetrySegment = () => {},
} = {}) {
  const testMode = SEGMENT_CONFIG.temporaryMergeTest;
  let modeCount = testMode.enabled
    ? testMode.segmentCount
    : normalizeSegmentCount(countInput?.value);
  let pendingCount = modeCount;
  let busy = false;
  let managedApplied = false;
  const rowsById = new Map();
  const retryingIds = new Set();
  if (qualityLockInput) qualityLockInput.checked = SEGMENT_CONFIG.qualityLock.enabled;

  if (countInput) {
    countInput.min = String(SEGMENT_CONFIG.minSegments);
    countInput.max = String(SEGMENT_CONFIG.maxSegments);
    countInput.disabled = testMode.enabled;
  }
  if (countHint) {
    countHint.textContent = testMode.enabled
      ? `Temporary test mode: ${testMode.segmentCount} segments × ${testMode.segmentDurationSeconds} seconds. Apply to prepare.`
      : `Choose 1–${SEGMENT_CONFIG.maxSegments}, then apply to prepare managed VOD segment players.`;
  }

  /** Reflects the unapplied segment count in its controls. */
  const renderPendingCount = () => {
    if (countInput) countInput.value = String(pendingCount);
    if (countValue) countValue.textContent = String(pendingCount);
    if (applyButton) applyButton.disabled = busy;
  };

  /** Applies the active segment count and corresponding control labels. */
  const setMode = (count) => {
    modeCount = testMode.enabled ? testMode.segmentCount : normalizeSegmentCount(count);
    pendingCount = modeCount;
    if (countInput) countInput.dataset.appliedCount = String(modeCount);
    renderPendingCount();
    const managed = usesManagedRecorder(modeCount, managedApplied);
    const multiple = modeCount > 1;
    if (injectButton) {
      injectButton.hidden = multiple;
      injectButton.disabled = multiple || busy;
    }
    if (startButton) {
      startButton.dataset.managedRecording = String(managed);
      startButton.textContent = managed
        ? multiple
          ? "Start All Segments (Choose File)"
          : "Start Segment (Choose File)"
        : "Start Recording (Choose File)";
    }
    if (stopButton) {
      stopButton.dataset.managedRecording = String(managed);
      stopButton.textContent = managed ? "Stop Entire Job" : "Stop & Download";
    }
    if (removeButton)
      removeButton.textContent = managed
        ? multiple
          ? "Remove Segment Players"
          : "Remove Segment Player"
        : "Remove Player";
    if (summary && !managed) summary.textContent = "Manual injected-player recording mode.";
    if (list && !managed) {
      list.replaceChildren();
      rowsById.clear();
    }
  };

  /** Switches between managed segment recording and manual injected-player recording. */
  const setManagedMode = (enabled) => {
    managedApplied = !!enabled;
    setMode(modeCount);
  };

  /** Incrementally renders one job snapshot into stable segment rows. */
  const renderJob = (job) => {
    if (!list || !summary) return;
    if (!job) {
      list.replaceChildren();
      rowsById.clear();
      summary.textContent = usesManagedRecorder(modeCount, managedApplied)
        ? "Select a playlist and apply to prepare managed segment players."
        : "Manual injected-player recording mode.";
      return;
    }
    const qualityLock = formatQualityLock(job);
    summary.textContent = `${job.segments.length} segment${
      job.segments.length === 1 ? "" : "s"
    } · ${labelState(job.state)}${qualityLock ? ` · ${qualityLock}` : ""}`;
    const items = buildSegmentRenderModel(job);
    const activeIds = new Set(items.map((item) => item.id));
    // Remove only stale rows so active progress elements keep their DOM identity.
    for (const [id, refs] of rowsById) {
      if (activeIds.has(id)) continue;
      refs.row.remove();
      rowsById.delete(id);
    }
    for (const item of items) {
      let refs = rowsById.get(item.id);
      if (!refs) {
        // Create each row once; subsequent telemetry updates mutate its cached nodes.
        const row = document.createElement("article");
        const heading = document.createElement("div");
        heading.className = "segment-row-heading";
        const title = document.createElement("strong");
        const state = document.createElement("span");
        const actions = document.createElement("div");
        actions.className = "segment-row-actions";
        const retryButton = document.createElement("button");
        retryButton.type = "button";
        retryButton.className = "segment-retry-button icon-button";
        const icon = document.createElement("i");
        icon.className = "fa-solid fa-rotate";
        icon.setAttribute("aria-hidden", "true");
        retryButton.append(icon);
        retryButton.addEventListener("click", () => {
          retryingIds.add(item.id);
          retryButton.disabled = true;
          Promise.resolve(onRetrySegment(item.id))
            .catch(() => {})
            .finally(() => {
              retryingIds.delete(item.id);
              retryButton.disabled = false;
            });
        });
        actions.append(state, retryButton);
        heading.append(title, actions);
        const timing = document.createElement("div");
        timing.className = "segment-timing";
        const progress = document.createElement("progress");
        progress.max = 1;
        const percent = document.createElement("span");
        percent.className = "segment-percent";
        const error = document.createElement("div");
        error.className = "segment-error";
        row.append(heading, timing, progress, percent, error);
        refs = { row, title, state, retryButton, timing, progress, percent, error };
        rowsById.set(item.id, refs);
      }
      refs.row.className = `segment-row segment-state-${item.state.toLowerCase()}`;
      // User- and page-derived labels stay inert by using textContent exclusively.
      refs.title.textContent = item.title;
      refs.state.textContent = item.state;
      refs.retryButton.hidden = !item.canRetry;
      refs.retryButton.disabled = retryingIds.has(item.id);
      refs.retryButton.title = `Retry ${item.title}`;
      refs.retryButton.setAttribute("aria-label", `Retry ${item.title}`);
      refs.timing.textContent = `${item.range} · duration ${item.duration}`;
      refs.progress.value = item.progress;
      refs.progress.setAttribute("aria-label", `${item.title} progress`);
      refs.percent.textContent = `${item.percent}%`;
      refs.error.textContent = item.error || "";
      refs.error.hidden = !item.error;
      list.append(refs.row);
    }
  };

  /** Enables or disables controls while an asynchronous action is pending. */
  const setBusy = (nextBusy) => {
    busy = nextBusy;
    if (countInput) countInput.disabled = busy || testMode.enabled;
    if (applyButton) applyButton.disabled = busy;
    if (qualityLockInput) qualityLockInput.disabled = busy;
    if (injectButton) injectButton.disabled = modeCount > 1 || busy;
  };

  if (countInput) {
    countInput.addEventListener("input", () => {
      pendingCount = normalizeSegmentCount(countInput.value);
      renderPendingCount();
    });
  }
  if (applyButton) {
    applyButton.addEventListener("click", () => {
      managedApplied = true;
      setMode(pendingCount);
      onApply(modeCount, qualityLockInput?.checked ?? SEGMENT_CONFIG.qualityLock.enabled);
    });
  }
  if (qualityLockInput) {
    qualityLockInput.addEventListener("change", () =>
      onQualityLockChange(qualityLockInput.checked),
    );
  }
  setMode(modeCount);

  return {
    /** Returns the currently applied segment count. */
    getCount: () => modeCount,
    /** Returns the edited segment count before it is applied. */
    getPendingCount: () => pendingCount,
    /** Reports whether controls belong to the managed segment recorder. */
    isManagedMode: () => usesManagedRecorder(modeCount, managedApplied),
    /** Returns the current quality-lock preference. */
    isQualityLockEnabled: () => qualityLockInput?.checked ?? SEGMENT_CONFIG.qualityLock.enabled,
    /** Updates the quality-lock control from a persisted value. */
    setQualityLockEnabled: (value) => {
      if (qualityLockInput) {
        qualityLockInput.checked = normalizeQualityLockPreference(
          value,
          SEGMENT_CONFIG.qualityLock.enabled,
        );
      }
    },
    setMode,
    setManagedMode,
    renderJob,
    setBusy,
    /** Clears the rendered job while preserving the selected mode. */
    reset: () => {
      managedApplied = false;
      setMode(modeCount);
      renderJob(null);
    },
  };
}
