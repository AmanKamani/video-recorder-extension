/**
 * Recording controller for HLS Side Panel Pro.
 * Owns per-tab MediaRecorder commands, incremental file writes, refresh-guard
 * lifecycle coordination, WebM repair, status rendering, and completion messages.
 * The selected-tab and permission helpers are injected from the side-panel app.
 */
export function createRecorderController({
  tabSelect,
  injectButton,
  getSelectedTab,
  ensurePagePermission,
  isHttpUrl,
  addLog,
  setStatus,
  repairWebmFile,
}) {
  const recordingStatusEl = document.getElementById("recordingStatus");
  const recordingTimerEl = document.getElementById("recordingTimer");
  const startRecordingButton = document.getElementById("startRecording");
  const stopRecordingButton = document.getElementById("stopRecording");
  const removeSitePlayerButton = document.getElementById("removeSitePlayer");

  // Bridge chunk data from the page's MAIN world to the extension side panel.
  // The queue preserves chunk order and waits for each disk write acknowledgement.
  async function installNotificationBridge(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        if (window.__hlsSidePanelFileBridgeInstalledV1) return;
        window.__hlsSidePanelFileBridgeInstalledV1 = true;
        let bridgeQueue = Promise.resolve();

        // Encodes chunk bytes for runtime messaging, processing them in smaller slices to avoid large argument lists.
        const toBase64 = (bytes) => {
          let binary = "";
          const step = 0x8000;
          for (let offset = 0; offset < bytes.length; offset += step) {
            binary += String.fromCharCode(
              ...bytes.subarray(offset, Math.min(offset + step, bytes.length)),
            );
          }
          return btoa(binary);
        };

        // Receives chunk messages from the page recorder bridge and queues them for file writing.
        window.addEventListener("message", (event) => {
          if (event.source !== window) return;
          const data = event.data;
          if (!data || data.channel !== "hls-side-panel-file-recorder-v1" || data.type !== "chunk")
            return;
          if (!(data.blob instanceof Blob) || !data.sessionId) return;

          bridgeQueue = bridgeQueue
            .then(async () => {
              const bytes = new Uint8Array(await data.blob.arrayBuffer());
              const acknowledgement = await chrome.runtime.sendMessage({
                type: "HLS_SIDEPANEL_RECORDING_CHUNK",
                sessionId: data.sessionId,
                sequence: data.sequence,
                base64: toBase64(bytes),
              });
              if (!acknowledgement?.ok) {
                throw new Error(
                  acknowledgement?.message || "The recording chunk could not be written to disk.",
                );
              }
            })
            .catch((error) => {
              console.error("HLS Side Panel Pro chunk bridge failed:", error?.message || error);
            });
        });

        // This distinct event avoids duplicate completion handling by an older bridge
        // that may still be installed in an already-open course tab.
        window.addEventListener("hls-side-panel-recording-stream-finished", (event) => {
          let detail = {};
          try {
            detail = JSON.parse(String(event.detail || "{}"));
          } catch (_) {}
          bridgeQueue = bridgeQueue
            .then(async () => {
              await chrome.runtime.sendMessage({
                type: "HLS_SIDEPANEL_RECORDING_FINISHED",
                detail,
              });
            })
            .catch((error) => {
              console.error(
                "HLS Side Panel Pro completion bridge failed:",
                error?.message || error,
              );
            });
        });

        // Keep the legacy in-memory recorder's completion path working.
        if (!window.__hlsSidePanelNotificationBridgeInstalled) {
          window.__hlsSidePanelNotificationBridgeInstalled = true;
          // Handles the final recording event and begins WebM repair/finalization.
          window.addEventListener("hls-side-panel-recording-finished", (event) => {
            let detail = {};
            try {
              detail = JSON.parse(String(event.detail || "{}"));
            } catch (_) {}
            chrome.runtime
              .sendMessage({
                type: "HLS_SIDEPANEL_RECORDING_FINISHED",
                detail,
              })
              .catch(() => {});
          });
        }
      },
    });
  }

  let recorderUiBusy = false;
  let recordingStartedAt = null;
  let recordingTimerInterval = null;
  let lastRecordingDurationMs = 0;
  const fileRecordingSessions = new Map();

  /** Formats elapsed milliseconds as a human-readable minutes-and-seconds timer. */
  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0
      ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;
  }

  /** Displays a recorder message and marks it as idle, working, recording, success, or error. */
  function setRecordingStatus(message, state = "idle") {
    if (recordingStatusEl) {
      recordingStatusEl.textContent = message;
      recordingStatusEl.dataset.state = state;
    }
  }

  /** Refreshes the timer using the current recording start timestamp. */
  function updateRecordingTimer() {
    if (recordingStartedAt === null) return;
    recordingTimerEl.textContent = formatDuration(Date.now() - recordingStartedAt);
  }

  /** Starts the UI timer that displays elapsed recording time. */
  function startRecordingTimer() {
    recordingStartedAt = Date.now();
    recordingTimerEl.textContent = "00:00";
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = setInterval(updateRecordingTimer, 250);
  }

  /** Stops the UI timer and clears its interval handle. */
  function stopRecordingTimer() {
    if (recordingStartedAt !== null) {
      lastRecordingDurationMs = Date.now() - recordingStartedAt;
    }
    recordingStartedAt = null;
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
    recordingTimerEl.textContent = formatDuration(lastRecordingDurationMs);
  }

  // Run recorder/player actions in the target page's MAIN world. Recording state
  // remains page-scoped so switching tabs does not stop another tab's session.
  async function executeOnSelectedPage(action, explicitTabId = null, actionOptions = {}) {
    const tab = explicitTabId ? await chrome.tabs.get(explicitTabId) : await getSelectedTab();
    const url = new URL(tab.url);
    const originPattern = `${url.protocol}//${url.host}/*`;

    // Status polling runs during initialization and every second. It must never
    // request permission, because that can reopen Chrome's permission prompt
    // repeatedly without a user click. Only explicit actions may request access.
    if (action === "status") {
      const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
      if (!hasPermission) {
        return {
          ok: false,
          permissionMissing: true,
          playerPresent: false,
          recording: false,
          recorderState: "inactive",
        };
      }
    } else {
      const granted = await ensurePagePermission(tab);
      if (!granted) throw new Error("Website access was not granted.");
      await installNotificationBridge(tab.id);
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [action, actionOptions],
      func: async (action, actionOptions = {}) => {
        const probe = window.__hlsSidePanelProbe;
        const video = probe?.video;

        // Warn before this tab unloads while its MediaRecorder is active.
        // The listener lives in the page's MAIN world and is scoped to this tab.
        const refreshGuardKey = "__hlsSidePanelRecordingGuardV1";
        // Adds a beforeunload warning while this tab has an active recording.
        const enableRecordingGuard = () => {
          if (window[refreshGuardKey]?.active) return;
          // Warns before a refresh or navigation can interrupt an active recording.
          // Prevents accidental refresh/navigation from silently interrupting an active recording.
          const handler = (event) => {
            event.preventDefault();
            event.returnValue = "";
            return "";
          };
          // Registers the refresh/navigation guard for this recording session.
          window.addEventListener("beforeunload", handler);
          window[refreshGuardKey] = { active: true, handler };
        };
        // Removes the beforeunload warning after the recording is stopped or finalized.
        const disableRecordingGuard = () => {
          const guard = window[refreshGuardKey];
          if (!guard) return;
          try {
            window.removeEventListener("beforeunload", guard.handler);
          } catch (_) {}
          try {
            delete window[refreshGuardKey];
          } catch (_) {
            window[refreshGuardKey] = null;
          }
        };

        if (action === "cleanup") {
          if (!probe || !video) {
            return { ok: true, message: "No temporary player was present." };
          }
          if (probe.recording?.recorder?.state === "recording") {
            return { ok: false, message: "Stop the recording before removing the player." };
          }
          try {
            probe.hls?.destroy();
          } catch (_) {}
          try {
            video.pause();
          } catch (_) {}
          try {
            video.removeAttribute("src");
            video.load();
          } catch (_) {}
          video.remove();
          try {
            delete window.__hlsSidePanelProbe;
          } catch (_) {
            window.__hlsSidePanelProbe = null;
          }
          return { ok: true, message: "Temporary site player removed." };
        }

        // Status must work even after cleanup removed the player/global probe.
        // This lets the side panel clear stale success UI and re-enable Inject.
        if (action === "status") {
          const playerPresent = !!video?.isConnected;
          return {
            ok: true,
            playerPresent,
            recording: playerPresent && !!probe?.recording,
            recorderState: playerPresent
              ? (probe?.recording?.recorder?.state ?? "inactive")
              : "inactive",
            startedAt: playerPresent ? (probe?.recording?.startedAt ?? null) : null,
            lastRecording: playerPresent ? (probe?.lastRecording ?? null) : null,
            videoEnded: playerPresent && !!video?.ended,
            videoPaused: playerPresent ? (video?.paused ?? true) : true,
          };
        }

        if (!video) {
          return {
            ok: false,
            message: "No temporary player found. Select a playlist and click Inject Player first.",
          };
        }

        if (action === "start") {
          if (probe.recording?.recorder?.state === "recording") {
            return { ok: false, message: "Recording is already running." };
          }
          if (
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            video.paused ||
            video.ended
          ) {
            return {
              ok: false,
              message: "Play the temporary site player first, then start recording.",
            };
          }
          if (typeof video.captureStream !== "function") {
            return { ok: false, message: "This browser does not support video.captureStream()." };
          }
          if (typeof MediaRecorder === "undefined") {
            return { ok: false, message: "MediaRecorder is not supported." };
          }

          const storageMode = actionOptions.storageMode || "file";
          const sessionId = actionOptions.sessionId || null;
          if (storageMode === "file" && !sessionId) {
            return { ok: false, message: "Missing direct-to-file recording session." };
          }

          const stream = video.captureStream();
          const tracks = stream.getTracks();
          if (!tracks.some((track) => track.kind === "video")) {
            tracks.forEach((track) => track.stop());
            return { ok: false, message: "No video track is available to record." };
          }

          const mimeTypes = [
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm",
          ];
          const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
          if (!mimeType) {
            tracks.forEach((track) => track.stop());
            return { ok: false, message: "No supported WebM recording format was found." };
          }

          const chunks = storageMode === "memory" ? [] : null;
          const recorder = new MediaRecorder(stream, { mimeType });
          const recording = {
            recorder,
            chunks,
            stream,
            startedAt: Date.now(),
            downloadStarted: false,
            stopReason: "manual",
            autoStopHandler: null,
            storageMode,
            sessionId,
            filename: actionOptions.filename || null,
            chunkSequence: 0,
          };

          // Receives each encoded MediaRecorder chunk and forwards it to the configured storage path.
          // Receives periodic encoded chunks; each chunk is sent to the file writer or retained for the fallback path.
          recorder.ondataavailable = (event) => {
            if (!event.data || event.data.size === 0) return;
            if (recording.storageMode === "file") {
              // Blob is structured-cloned to the isolated-world bridge; no full-recording
              // chunk array or large final Blob is created in the page.
              window.postMessage(
                {
                  channel: "hls-side-panel-file-recorder-v1",
                  type: "chunk",
                  sessionId: recording.sessionId,
                  sequence: recording.chunkSequence++,
                  blob: event.data,
                },
                "*",
              );
            } else {
              recording.chunks.push(event.data);
            }
          };
          // Logs MediaRecorder errors so recording failures can be diagnosed.
          // Reports encoder failures from the page recorder to the browser console.
          recorder.onerror = (event) => {
            console.error(
              "HLS Side Panel Pro recording error:",
              event.error?.message || "Unknown error",
            );
          };
          // Finalizes the recording session after MediaRecorder stops and reports the outcome to the extension.
          // Finalizes the fallback in-memory recording and triggers its WebM download.
          recorder.onstop = () => {
            // Recording has stopped; normal navigation is allowed again.
            disableRecordingGuard();
            if (recording.autoStopHandler) {
              video.removeEventListener("ended", recording.autoStopHandler);
            }
            tracks.forEach((track) => track.stop());
            const durationMs = Date.now() - recording.startedAt;
            const finishedAt = Date.now();

            if (recording.storageMode === "file") {
              probe.lastRecording = {
                bytes: null,
                mimeType: recorder.mimeType,
                durationMs,
                finishedAt,
                reason: recording.stopReason,
                filename: recording.filename,
                streamedToFile: true,
              };
              probe.recording = null;
              window.dispatchEvent(
                new CustomEvent("hls-side-panel-recording-stream-finished", {
                  detail: JSON.stringify({
                    ok: true,
                    reason: recording.stopReason,
                    durationMs,
                    filename: recording.filename,
                    sessionId: recording.sessionId,
                    pageTitle: document.title || location.hostname,
                    streamedToFile: true,
                  }),
                }),
              );
              console.info(
                "WebM recording chunks streamed to the selected file:",
                recording.filename,
              );
              return;
            }

            const blob = new Blob(recording.chunks, { type: recorder.mimeType });
            if (!blob.size) {
              console.error("Recording ended but produced an empty file.");
              probe.recording = null;
              window.dispatchEvent(
                new CustomEvent("hls-side-panel-recording-finished", {
                  detail: JSON.stringify({
                    ok: false,
                    reason: recording.stopReason,
                    message: "Recording produced an empty file.",
                  }),
                }),
              );
              return;
            }

            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const safeTabTitle =
              (document.title || "video")
                .replace(/[^a-z0-9-_ ]/gi, "")
                .trim()
                .slice(0, 60) || "video";
            const downloadUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = downloadUrl;
            link.download = `${safeTabTitle}-recording-${stamp}.webm`;
            link.style.display = "none";
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
            recording.downloadStarted = true;
            probe.lastRecording = {
              bytes: blob.size,
              mimeType: recorder.mimeType,
              durationMs,
              finishedAt,
              reason: recording.stopReason,
              filename: link.download,
            };
            probe.recording = null;
            window.dispatchEvent(
              new CustomEvent("hls-side-panel-recording-finished", {
                detail: JSON.stringify({
                  ok: true,
                  reason: recording.stopReason,
                  bytes: blob.size,
                  durationMs,
                  filename: link.download,
                  pageTitle: document.title || location.hostname,
                }),
              }),
            );
            console.info(
              "WebM recording download triggered:",
              blob.size,
              "bytes",
              "reason:",
              recording.stopReason,
            );
          };

          // Stops the recorder automatically when the temporary video ends naturally.
          // Stops the recorder when playback reaches the end of the temporary player.
          recording.autoStopHandler = () => {
            if (recorder.state === "recording") {
              recording.stopReason = "ended";
              console.info("Video ended; automatically stopping WebM recording.");
              recorder.stop();
            }
          };
          // Automatically stops recording when the temporary video reaches the end.
          // Ensures the end-of-video handler runs once for this recording.
          video.addEventListener("ended", recording.autoStopHandler, { once: true });
          probe.recording = recording;
          recorder.start(1000);
          enableRecordingGuard();
          return {
            ok: true,
            message:
              "Recording started with incremental file writes. Refresh warning enabled for this tab.",
            mimeType,
            storageMode,
            filename: recording.filename,
            audioTracks: tracks.filter((track) => track.kind === "audio").length,
            videoTracks: tracks.filter((track) => track.kind === "video").length,
          };
        }

        if (action === "stop") {
          const recording = probe.recording;
          if (!recording || recording.recorder.state !== "recording") {
            return { ok: false, message: "There is no active recording." };
          }
          recording.stopReason = "manual";
          recording.recorder.stop();
          return { ok: true, message: "Recording stopped. Preparing WebM download…" };
        }

        return { ok: false, message: "Unknown recording action." };
      },
    });

    const result = results?.[0]?.result;
    if (!result) throw new Error("The website did not return a result.");
    return result;
  }

  /** Waits for the selected tab’s recording session to finish writing and repairing its WebM file. */
  async function waitForDownloadFinalization(tabId, timeoutMs = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const state = await executeOnSelectedPage("status", tabId);
        const fileWritePending = [...fileRecordingSessions.values()].some(
          (session) => session.tabId === tabId,
        );
        if (state.ok && !state.recording && !fileWritePending) return true;
      } catch (_) {
        // The user may have navigated away while the recorder was finalizing.
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  /** Reconciles button enabled/disabled states with the selected tab’s player and recording state. */
  async function syncRecorderControls() {
    if (recorderUiBusy) return;
    try {
      const tab = await getSelectedTab();
      const state = await executeOnSelectedPage("status", tab.id);
      if (state.permissionMissing) {
        // Do not prompt from background polling; access is requested only by a
        // deliberate user action such as Scan, Inject Player, or Analyze HLS.
        injectButton.disabled = false;
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = true;
        removeSitePlayerButton.disabled = true;
        recordingStartedAt = null;
        recordingTimerEl.textContent = "00:00";
        setRecordingStatus(
          "Click Grant access & scan selected tab to allow website access.",
          "idle",
        );
        return;
      }
      const isRecording = state.recording && state.recorderState === "recording";
      // Inject and Remove are mutually exclusive for the selected tab.
      // An existing player means Inject is unavailable and Remove is available.
      injectButton.disabled = !!state.playerPresent || isRecording;
      startRecordingButton.disabled = !state.playerPresent || isRecording;
      stopRecordingButton.disabled = !isRecording;
      removeSitePlayerButton.disabled = !state.playerPresent || isRecording;
      if (isRecording && state.startedAt) {
        recordingStartedAt = state.startedAt;
        recordingTimerEl.textContent = formatDuration(Date.now() - state.startedAt);
        setRecordingStatus(
          `Recording in this tab · ${tab.title || tab.url} · refresh warning active`,
          "recording",
        );
      } else if (state.playerPresent) {
        recordingStartedAt = null;
        recordingTimerEl.textContent = state.lastRecording?.durationMs
          ? formatDuration(state.lastRecording.durationMs)
          : "00:00";
        if (state.lastRecording && state.lastRecording.finishedAt) {
          const age = Date.now() - state.lastRecording.finishedAt;
          if (age < 15000) {
            setRecordingStatus(
              `Last recording saved (${state.lastRecording.reason === "ended" ? "video ended" : "stopped manually"}).`,
              "success",
            );
          } else {
            setRecordingStatus(
              "Player ready. Play this tab's video, then start recording.",
              "idle",
            );
          }
        } else {
          setRecordingStatus(
            "Player ready. Play this tab's video, then start recording.",
            "success",
          );
        }
      } else {
        recordingStartedAt = null;
        recordingTimerEl.textContent = "00:00";
        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = true;
        removeSitePlayerButton.disabled = true;
        setRecordingStatus(
          "Player removed. Select this tab's playlist and click Inject Player to inject it again.",
          "idle",
        );
      }
    } catch (_) {
      injectButton.disabled = false;
      startRecordingButton.disabled = true;
      stopRecordingButton.disabled = true;
      removeSitePlayerButton.disabled = true;
      recordingStartedAt = null;
      recordingTimerEl.textContent = "00:00";
      setRecordingStatus(
        "Select a website tab with page access, then click Inject Player.",
        "idle",
      );
    }
  }

  // Repairs MediaRecorder WebM files in-place after recording. It adds a Duration
  // element when missing and builds a Cues index from video keyframes, using bounded
  // reads/writes so the entire recording is never loaded into RAM.
  // Receive chunk acknowledgements and completion notifications from the background
  // bridge. Each file writer has its own ordered write queue and error state.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "HLS_SIDEPANEL_RECORDING_CHUNK_PANEL") {
      const session = fileRecordingSessions.get(message.sessionId);
      if (!session) {
        sendResponse({
          ok: false,
          message:
            "No active file writer exists for this recording. Keep the side panel open while recording.",
        });
        return;
      }
      session.writeQueue = session.writeQueue.then(async () => {
        if (session.error) throw new Error(session.error);
        const binary = atob(message.base64 || "");
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await session.writable.write(bytes);
        session.bytes += bytes.byteLength;
      });
      session.writeQueue
        .then(() => sendResponse({ ok: true, bytesWritten: session.bytes }))
        .catch(async (error) => {
          session.error = error?.message || String(error);
          addLog(
            "error",
            `Tab ${session.tabId}: writing recording to disk failed: ${session.error}`,
          );
          if (Number(tabSelect.value) === session.tabId)
            setRecordingStatus(`File write failed: ${session.error}`, "error");
          try {
            await executeOnSelectedPage("stop", session.tabId);
          } catch (_) {}
          sendResponse({ ok: false, message: session.error });
        });
      return true;
    }

    if (message?.type === "HLS_SIDEPANEL_RECORDING_FINISHED_PANEL") {
      const detail = message.detail || {};
      const session = detail.sessionId ? fileRecordingSessions.get(detail.sessionId) : null;
      if (!session) {
        sendResponse({ ok: true, detail });
        return;
      }
      session.finalizing = true;
      (async () => {
        await session.writeQueue;
        let finalDetail = { ...detail, filename: session.filename, bytes: session.bytes };
        if (detail.ok !== false && !session.error && session.bytes > 0) {
          await session.writable.close();
          finalDetail.savedToFile = true;
          addLog(
            "info",
            `Tab ${session.tabId}: recording bytes flushed to ${session.filename} (${session.bytes.toLocaleString()} bytes).`,
          );
          try {
            const repair = await repairWebmFile(
              session.fileHandle,
              detail.durationMs || 0,
              (message) => addLog("info", `Tab ${session.tabId}: ${message}`),
            );
            finalDetail.webmRepair = repair;
            if (repair.ok) {
              const repairedFile = await session.fileHandle.getFile();
              finalDetail.bytes = repairedFile.size;
              addLog(
                "info",
                `Tab ${session.tabId}: WebM seek metadata repair completed (${repairedFile.size.toLocaleString()} bytes).`,
              );
            } else {
              addLog(
                "warning",
                `Tab ${session.tabId}: WebM metadata repair skipped: ${repair.message}`,
              );
            }
          } catch (repairError) {
            finalDetail.webmRepair = {
              ok: false,
              message: repairError?.message || String(repairError),
            };
            addLog(
              "warning",
              `Tab ${session.tabId}: WebM metadata repair failed; the original recording was retained where possible: ${finalDetail.webmRepair.message}`,
            );
          }
        } else {
          try {
            await session.writable.abort();
          } catch (_) {}
          finalDetail.ok = false;
          finalDetail.message =
            session.error ||
            detail.message ||
            (session.bytes === 0
              ? "No media chunks were written; the output file was not saved."
              : "Recording did not complete successfully.");
        }
        fileRecordingSessions.delete(session.sessionId);
        if (Number(tabSelect.value) === session.tabId) {
          if (finalDetail.ok) {
            setRecordingStatus(
              `Saved ${session.filename} (${(session.bytes / (1024 * 1024)).toFixed(1)} MB).`,
              "success",
            );
            recordingStartedAt = null;
            recordingTimerEl.textContent = formatDuration(detail.durationMs || 0);
          } else {
            setRecordingStatus(`Recording save failed: ${finalDetail.message}`, "error");
          }
        }
        sendResponse({ ok: finalDetail.ok !== false, detail: finalDetail });
        syncRecorderControls();
      })().catch(async (error) => {
        const failure = error?.message || String(error);
        try {
          await session.writable.abort();
        } catch (_) {}
        fileRecordingSessions.delete(session.sessionId);
        sendResponse({
          ok: false,
          detail: { ...detail, ok: false, filename: session.filename, message: failure },
        });
      });
      return true;
    }
  });

  // Opens a save-file picker and starts direct-to-file recording for the selected website tab.
  startRecordingButton.addEventListener("click", async () => {
    recorderUiBusy = true;
    startRecordingButton.disabled = true;
    setRecordingStatus("Choose a destination file…", "working");
    let sessionId = null;
    let writable = null;
    try {
      if (typeof window.showSaveFilePicker !== "function") {
        throw new Error(
          "Direct-to-file recording requires a desktop Chromium browser with File System Access support. Please update Chrome and reopen the extension.",
        );
      }

      // Invoke the picker synchronously from this click handler to preserve user activation.
      const tabId = Number(tabSelect.value);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Select a website tab first.");
      const tabLabel = tabSelect.selectedOptions?.[0]?.textContent || "course-video";
      const safeTitle =
        tabLabel
          .replace(/[^a-z0-9-_ ]/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 48) || "course-video";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const suggestedName = `${safeTitle}-recording-${stamp}.webm`;
      const fileHandlePromise = window.showSaveFilePicker({
        suggestedName,
        types: [{ description: "WebM video", accept: { "video/webm": [".webm"] } }],
      });
      const fileHandle = await fileHandlePromise;
      writable = await fileHandle.createWritable();
      const tab = await chrome.tabs.get(tabId);
      if (!isHttpUrl(tab.url))
        throw new Error("The selected tab is no longer a normal website tab.");

      sessionId = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const session = {
        sessionId,
        tabId: tab.id,
        tabTitle: tab.title || tab.url,
        filename: fileHandle.name || suggestedName,
        fileHandle,
        writable,
        writeQueue: Promise.resolve(),
        bytes: 0,
        startedAt: null,
        error: null,
        finalizing: false,
      };
      fileRecordingSessions.set(sessionId, session);

      const result = await executeOnSelectedPage("start", tab.id, {
        storageMode: "file",
        sessionId,
        filename: session.filename,
      });
      if (!result.ok) throw new Error(result.message);
      session.startedAt = Date.now();
      recordingStartedAt = session.startedAt;
      recordingTimerEl.textContent = "00:00";
      setRecordingStatus(
        `Recording to file · ${session.filename} · ${result.audioTracks} audio / ${result.videoTracks} video track(s) · refresh warning active`,
        "recording",
      );
      addLog(
        "info",
        `Tab ${tab.id}: recording to ${session.filename}; chunks will be written incrementally to disk. Refresh warning enabled for this tab.`,
      );
    } catch (error) {
      if (sessionId) fileRecordingSessions.delete(sessionId);
      if (writable) {
        try {
          await writable.abort();
        } catch (_) {}
      }
      if (error?.name === "AbortError") {
        setRecordingStatus("Save dialog cancelled; recording was not started.", "idle");
        addLog("info", "Recording cancelled in the file picker.");
      } else {
        setRecordingStatus(error.message || String(error), "error");
        addLog("error", `Could not start direct-to-file recording: ${error.message || error}`);
      }
    } finally {
      recorderUiBusy = false;
      await syncRecorderControls();
    }
  });

  // Stops the active recording and waits for its file to be finalized.
  stopRecordingButton.addEventListener("click", async () => {
    recorderUiBusy = true;
    stopRecordingButton.disabled = true;
    setRecordingStatus("Stopping recorder and finalizing the file…", "working");
    try {
      const tab = await getSelectedTab();
      const result = await executeOnSelectedPage("stop", tab.id);
      if (!result.ok) throw new Error(result.message);
      addLog("info", result.message);
      const finalized = await waitForDownloadFinalization(tab.id);
      setRecordingStatus(
        finalized
          ? "Recording file finalized for this tab."
          : "Recorder stopped. Check the selected file and Logs.",
        finalized ? "success" : "working",
      );
      if (finalized) addLog("info", `Recording from tab ${tab.id} finalized.`);
    } catch (error) {
      setRecordingStatus(error.message, "error");
      addLog("error", `Could not stop recording cleanly: ${error.message}`);
    } finally {
      recorderUiBusy = false;
      await syncRecorderControls();
    }
  });

  // Removes the temporary player from the selected page when no recording is active.
  removeSitePlayerButton.addEventListener("click", async () => {
    recorderUiBusy = true;
    removeSitePlayerButton.disabled = true;
    setRecordingStatus("Removing temporary player…", "working");
    try {
      const tab = await getSelectedTab();
      const result = await executeOnSelectedPage("cleanup", tab.id);
      if (!result.ok) throw new Error(result.message);
      setRecordingStatus(result.message, "idle");
      addLog("info", `Tab ${tab.id}: ${result.message}`);
    } catch (error) {
      setRecordingStatus(error.message, "error");
      addLog("error", `Could not remove player: ${error.message}`);
    } finally {
      recorderUiBusy = false;
      await syncRecorderControls();
    }
  });

  // Keep the selected tab's timer fresh and reconcile UI state with the page's
  // per-tab recorder state. Recording sessions in other tabs remain independent.
  setInterval(() => {
    if (recordingStartedAt !== null)
      recordingTimerEl.textContent = formatDuration(Date.now() - recordingStartedAt);
    syncRecorderControls();
  }, 1000);

  // Initialize button state for a new side-panel instance, including reopen-after-recording.
  setRecordingStatus("Select a playlist and click Inject Player to set up this tab.", "idle");
  if (injectButton) injectButton.disabled = false;
  startRecordingButton.disabled = true;
  stopRecordingButton.disabled = true;
  removeSitePlayerButton.disabled = true;
  syncRecorderControls();

  return { setRecordingStatus, syncRecorderControls, installNotificationBridge };
}
