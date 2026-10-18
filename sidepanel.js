const tabSelect = document.getElementById("tabSelect");
const refreshButton = document.getElementById("refreshTabs");
const scanButton = document.getElementById("scan");
const statusEl = document.getElementById("status");
const streamsEl = document.getElementById("streams");
const video = document.getElementById("video");
const logsArea = document.getElementById("logsArea");

// Tab navigation elements
const tabNav = document.getElementById("tabNav");
const tabStreamBtn = document.querySelector('[data-tab="streams"]');
const tabLogsBtn = document.querySelector('[data-tab="logs"]');
const tabContentStreams = document.getElementById("tabStreams");
const tabContentLogs = document.getElementById("tabLogs");

let hls = null;
let scanId = 0;
let selectedButton = null;

// Logging system
let logEntries = [];

// Helper: check if a string is an http/https URL
function isHttpUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

function setStatus(message) {
  statusEl.textContent = message;
  addLog("info", message);
}

function addLog(level, message) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `log-entry level-${level}`;
  entry.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${message}`;
  logsArea.insertBefore(entry, logsArea.firstChild);

  // Keep only last 50 entries
  while (logsArea.children.length > 50) {
    logsArea.removeChild(logsArea.lastChild);
  }

  logEntries.push({ level, message, timestamp });
}

function stopPlayback() {
  if (hls) {
    hls.destroy();
    hls = null;
  }

  video.pause();
  video.removeAttribute("src");
  video.load();
}

function isM3u8(value) {
  try {
    const url = new URL(value);

    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

async function refreshTabs() {
  try {
    const previousId = tabSelect.value;
    const tabs = await chrome.tabs.query({});

    const websiteTabs = tabs.filter(tab => isHttpUrl(tab.url));

    tabSelect.replaceChildren();

    if (!websiteTabs.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No website tabs found";
      tabSelect.appendChild(option);
      setStatus("Open your website in a normal browser tab.");
      return;
    }

    for (const tab of websiteTabs) {
      const option = document.createElement("option");

      option.value = String(tab.id);

      const title = tab.title || tab.url;

      option.textContent =
        `${tab.active ? "● " : ""}${title.slice(0, 70)}`;

      option.title = tab.url;

      tabSelect.appendChild(option);
    }

    const previousTabExists = websiteTabs.some(
      tab => String(tab.id) === previousId
    );

    if (previousTabExists) {
      tabSelect.value = previousId;
    } else {
      const activeTab = websiteTabs.find(tab => tab.active);

      if (activeTab) {
        tabSelect.value = String(activeTab.id);
      } else {
        tabSelect.value = String(websiteTabs[0].id);
      }
    }

    setStatus(
      "Choose the website tab you want to scan, then click Scan."
    );
  } catch (error) {
    setStatus(`Unable to list tabs: ${error.message}`);
  }
}

function switchTab(tabName) {
  // Update tab navigation buttons
  if (tabStreamBtn) {
    tabStreamBtn.classList.toggle("active", tabName === "streams");
  }
  if (tabLogsBtn) {
    tabLogsBtn.classList.toggle("active", tabName === "logs");
  }

  // Update tab content panels
  if (tabContentStreams) {
    tabContentStreams.classList.toggle("active", tabName === "streams");
  }
  if (tabContentLogs) {
    tabContentLogs.classList.toggle("active", tabName === "logs");
  }
}

// Tab click listeners
if (tabStreamBtn) {
  tabStreamBtn.addEventListener("click", () => switchTab("streams"));
}
if (tabLogsBtn) {
  tabLogsBtn.addEventListener("click", () => switchTab("logs"));
}

// Clear logs button
const clearLogsBtn = document.createElement("button");
clearLogsBtn.textContent = "Clear Logs";
clearLogsBtn.style.marginTop = "8px";
clearLogsBtn.style.padding = "6px 12px";
clearLogsBtn.style.background = "#374151";
clearLogsBtn.style.color = "#f9fafb";
clearLogsBtn.style.border = "none";
clearLogsBtn.style.borderRadius = "4px";
clearLogsBtn.style.cursor = "pointer";
clearLogsBtn.addEventListener("click", () => {
  logsArea.innerHTML = "";
  logEntries = [];
  addLog("info", "Logs cleared");
});
document.getElementById("tabLogs").appendChild(clearLogsBtn);

async function getSelectedTab() {
  const tabId = Number(tabSelect.value);

  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error(
      "No website tab selected. Click Refresh tabs."
    );
  }

  const tab = await chrome.tabs.get(tabId);

  if (!isHttpUrl(tab.url)) {
    throw new Error(
      "Select a normal HTTP or HTTPS website tab."
    );
  }

  return tab;
}

async function ensurePagePermission(tab) {
  const url = new URL(tab.url);

  const originPattern = `${url.protocol}//${url.host}/*`;

  const alreadyGranted = await chrome.permissions.contains({
    origins: [originPattern]
  });

  if (alreadyGranted) {
    return true;
  }

  return await chrome.permissions.request({
    origins: [originPattern]
  });
}

async function scanSelectedTab() {
  const currentScan = ++scanId;

  scanButton.disabled = true;
  streamsEl.replaceChildren();
  selectedButton = null;

  try {
    const tab = await getSelectedTab();

    setStatus("Checking website access...");

    const granted = await ensurePagePermission(tab);

    if (!granted) {
      throw new Error(
        "Website permission was denied. Allow access and try again."
      );
    }

    setStatus("Scanning the selected website...");

    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },

      func: () => {
        const resources =
          performance.getEntriesByType("resource");

        const urls = resources
          .map(resource => resource.name)
          .filter(name => {
            try {
              const url = new URL(name);

              return (
                ["http:", "https:"].includes(url.protocol) &&
                url.pathname.toLowerCase().endsWith(".m3u8")
              );
            } catch {
              return false;
            }
          });

        return [...new Set(urls)];
      }
    });

    if (currentScan !== scanId) {
      return;
    }

    const urls = results?.[0]?.result || [];

    if (!urls.length) {
      setStatus(
        "No .m3u8 playlists found. Start or resume the video " +
        "in the selected tab, wait a few seconds, and scan again."
      );
      return;
    }

    setStatus(
      `${urls.length} playlist(s) found. Select one to play.`
    );

    for (const url of urls) {
      const button = document.createElement("button");

      button.className = "stream";
      button.textContent = url;
      button.title = "Play this playlist";

      button.addEventListener("click", () => {
        if (selectedButton) {
          selectedButton.classList.remove("selected");
        }

        selectedButton = button;
        button.classList.add("selected");
        setStatus("Playlist selected. Use Analyze Selected HLS or Test Site HLS Player.");
      });

      streamsEl.appendChild(button);
    }
  } catch (error) {
    setStatus(
      `Could not scan this tab: ${error.message || error}`
    );
  } finally {
    if (currentScan === scanId) {
      scanButton.disabled = false;
    }
  }
}

async function ensureStreamPermission(urlString) {
  const url = new URL(urlString);

  const originPattern = `${url.protocol}//${url.host}/*`;

  const alreadyGranted = await chrome.permissions.contains({
    origins: [originPattern]
  });

  if (alreadyGranted) {
    return true;
  }

  return await chrome.permissions.request({
    origins: [originPattern]
  });
}

async function playStream(url) {
  stopPlayback();

  if (!isM3u8(url)) {
    setStatus("Invalid HLS playlist URL.");
    addLog("error", `Invalid HLS playlist URL: ${url}`);
    return;
  }

  try {
    setStatus("Checking stream-host permission...");

    const granted = await ensureStreamPermission(url);

    if (!granted) {
      setStatus("Stream-host permission was denied.");
      addLog("error", "Stream-host permission was denied");
      return;
    }

    if (typeof Hls === "undefined") {
      setStatus(
        "hls.min.js is missing. Place the browser build " +
        "beside sidepanel.html and reload the extension."
      );
      addLog("error", "hls.min.js is missing");
      return;
    }

    if (!Hls.isSupported()) {
      setStatus("HLS playback through hls.js is not supported.");
      addLog("error", "HLS playback not supported by this browser");
      return;
    }

    setStatus("Loading playlist...");

    hls = new Hls({xhrSetup: (xhr) => {
      xhr.withCredentials = true;
    }});

    hls.on(Hls.Events.KEY_LOADED, (_, data) => {
      const key = data.frag?.decryptdata?.key;

      console.log("Key byte length:", key?.byteLength);
      console.log(
        "Key is 16 bytes:",
        key?.byteLength === 16
      );
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStatus("Playlist loaded. Press Play.");
      addLog("info", "Manifest parsed successfully");
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      const isParsingError =
        data.details === Hls.ErrorDetails.FRAG_PARSING_ERROR;

      if (!data.fatal && !isParsingError) {
        return;
      }

      const diagnostic = {
        type: data.type,
        details: data.details,
        fatal: data.fatal,
        reason: data.reason || "Not provided",
        underlyingError:
          data.error?.message ||
          data.err?.message ||
          data.error?.toString?.() ||
          data.err?.toString?.() ||
          "No underlying error message",
        stack:
          data.error?.stack ||
          data.err?.stack ||
          "No stack trace",
        fragmentUrl: data.frag?.url || "Unknown",
        fragmentType: data.frag?.type || "Unknown",
        level: data.frag?.level ?? "Unknown"
      };

      console.error("HLS diagnostic:", diagnostic);
      addLog("error", JSON.stringify(diagnostic, null, 2));
      setStatus(
        `Playback error: ${diagnostic.details}\n` +
        `Reason: ${diagnostic.reason}\n` +
        `Check the Logs tab and browser Console.`
      );
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    addLog("info", `Started playing stream: ${url}`);
  } catch (error) {
    setStatus(`Could not play stream: ${error.message || error}`);
    addLog("error", `Could not play stream: ${error.message || error}`);
  }
}

// Override console.log to capture logs in the extension
const originalConsoleLog = console.log;
const originalConsoleWarning = console.warning;
const originalConsoleError = console.error;

console.log = function(...args) {
  originalConsoleLog.apply(console, args);
  addLog("info", Array.from(args).join(" "));
};

console.warning = function(...args) {
  originalConsoleWarning.apply(console, args);
  addLog("warning", Array.from(args).join(" "));
};

console.error = function(...args) {
  originalConsoleError.apply(console, args);
  addLog("error", Array.from(args).join(" "));
};

refreshButton.addEventListener("click", refreshTabs);
scanButton.addEventListener("click", scanSelectedTab);
refreshTabs();


/*********** APPROACH 1 START */

const inspectPlayerButton = document.createElement("button");
inspectPlayerButton.textContent = "Inspect Site Player";
inspectPlayerButton.style.marginTop = "8px";
scanButton.insertAdjacentElement("afterend", inspectPlayerButton);

inspectPlayerButton.addEventListener("click", async () => {
  inspectPlayerButton.disabled = true;

  try {
    const tab = await getSelectedTab();

    const granted = await ensurePagePermission(tab);
    if (!granted) {
      throw new Error("Website access was not granted.");
    }

    setStatus("Inspecting the site's player...");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const videos = [...document.querySelectorAll("video")];

        return {
          pageUrl: location.origin,
          hlsGlobal: typeof window.Hls,
          hlsVersion: window.Hls?.version ?? null,
          cryptoGlobal: typeof window.cjs,
          apkIdAvailable: typeof window.apkId === "string",
          apkIdLength:
            typeof window.apkId === "string"
              ? window.apkId.length
              : null,
          base64Helper:
            typeof window.convertArrayToBase64,
          videos: videos.map((video, index) => ({
            index,
            src: video.currentSrc
              ? new URL(video.currentSrc, location.href).origin
              : null,
            paused: video.paused,
            readyState: video.readyState,
            hasMediaKeys: !!video.mediaKeys
          })),
          scriptCount: document.scripts.length
        };
      }
    });

    const info = results?.[0]?.result;    
    const libraryInfo = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const H = window.Hls;
        const config = H?.DefaultConfig;

        return {
          constructorName: H?.name ?? null,
          isSupported: typeof H?.isSupported === "function"
            ? H.isSupported()
            : null,
          eventNames: H?.Events
            ? Object.keys(H.Events).filter(k =>
                ["ERROR", "MANIFEST_PARSED", "KEY_LOADING",
                "KEY_LOADED", "FRAG_PARSING_ERROR"].includes(k)
              )
            : [],
          defaultLoader: config?.loader?.name ?? null,
          defaultFragmentLoader: config?.fLoader?.name ?? null,
          defaultPlaylistLoader: config?.pLoader?.name ?? null,
          scriptUrls: [...document.scripts]
            .map(s => s.src)
            .filter(Boolean)
            .filter(src => /hls|player|video/i.test(src))
            .slice(0, 30),
          videoCount: document.querySelectorAll("video").length
        };
      }
    });

    addLog(
      "info",
      "HLS library details: " +
        JSON.stringify(libraryInfo?.[0]?.result ?? {}, null, 2)
    );

    

    if (!info) {
      throw new Error("The page returned no diagnostic results.");
    }

    addLog("info", "Site-player diagnostic results:");
    addLog("info", JSON.stringify(info, null, 2));

    
    const loaderCheck = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const H = window.Hls;
        const loaderSource =
          H?.DefaultConfig?.loader?.toString() ?? "";

        return {
          loaderName: H?.DefaultConfig?.loader?.name ?? null,
          loaderSourceLength: loaderSource.length,
          mentionsApkId: loaderSource.includes("apkId"),
          mentionsConvertArrayToBase64:
            loaderSource.includes("convertArrayToBase64"),
          mentionsKEY_LOADING: loaderSource.includes("KEY_LOADING"),
          configKeys: H?.DefaultConfig
            ? Object.keys(H.DefaultConfig).filter(k =>
                /loader|decrypt|worker/i.test(k)
              )
            : []
        };
      }
    });

    addLog(
      "info",
      "Custom loader check: " +
        JSON.stringify(loaderCheck?.[0]?.result ?? {}, null, 2)
    );


    setStatus(
      "Inspection complete. Open the Logs tab and share the diagnostic results."
    );
  } catch (error) {
    setStatus(`Player inspection failed: ${error.message || error}`);
  } finally {
    inspectPlayerButton.disabled = false;
  }
});

/** Outcome: Not able to find the decoding logic in the existing file */
/*********** APPROACH 1 OVER */

/*********** APPROACH 2 START - create video player inside the website and play the video there */

const testCustomPlayerButton = document.createElement("button");
testCustomPlayerButton.textContent = "Test Site HLS Player";
scanButton.insertAdjacentElement("afterend", testCustomPlayerButton);

testCustomPlayerButton.addEventListener("click", async () => {
  const playlistUrl = selectedButton?.textContent?.trim();

  if (!playlistUrl || !isM3u8(playlistUrl)) {
    setStatus("First scan and select an HLS playlist.");
    return;
  }

  testCustomPlayerButton.disabled = true;

  try {
    const tab = await getSelectedTab();

    setStatus("Testing the site's HLS player on the page...");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [playlistUrl],
      func: async (url) => {
        // Clean up a previous test instance, if any.
        window.__hlsSidePanelProbe?.hls?.destroy();
        window.__hlsSidePanelProbe?.video?.remove();

        const state = {
          events: [],
          fatalError: null,
          manifestParsed: false,
          keyLoaded: false,
          fragmentParsed: false
        };

        window.__hlsSidePanelProbe = { state, hls: null, video: null };

        const video = document.createElement("video");
        video.controls = true;
        video.playsInline = true;
        video.style.cssText =
          "position:fixed;right:12px;bottom:12px;width:360px;" +
          "max-width:45vw;z-index:2147483647;background:#000;" +
          "border:2px solid #2563eb;border-radius:8px";

        video.title = "Temporary HLS diagnostic player";
        document.body.appendChild(video);

        const H = window.Hls;

        if (typeof H !== "function" || !H.isSupported()) {
          state.fatalError = "Page HLS constructor unavailable or unsupported.";
          return state;
        }

        const hls = new H();
        window.__hlsSidePanelProbe.hls = hls;
        window.__hlsSidePanelProbe.video = video;

        const record = (name, data) => {
          state.events.push({
            name,
            details: data?.details ?? null,
            fatal: data?.fatal ?? false
          });
          if (state.events.length > 30) state.events.shift();
        };

        hls.on(H.Events.MANIFEST_PARSED, (_, data) => {
          state.manifestParsed = true;
          record("MANIFEST_PARSED", data);
        });

        hls.on(H.Events.KEY_LOADED, (_, data) => {
          state.keyLoaded = true;
          record("KEY_LOADED", {
            details: `key length: ${data?.frag?.decryptdata?.key?.length ?? "unknown"}`
          });
        });

        hls.on(H.Events.FRAG_PARSED, (_, data) => {
          state.fragmentParsed = true;
          record("FRAG_PARSED", data);
        });

        hls.on(H.Events.ERROR, (_, data) => {
          record("ERROR", data);
          if (data?.fatal) {
            state.fatalError = data.details || data.type || "Fatal HLS error";
          }
        });

        hls.loadSource(url);
        hls.attachMedia(video);

        // Give the test time to load the playlist, key and initial segments.
        await new Promise(resolve => setTimeout(resolve, 12000));

        return {
          manifestParsed: state.manifestParsed,
          keyLoaded: state.keyLoaded,
          fragmentParsed: state.fragmentParsed,
          fatalError: state.fatalError,
          events: state.events,
          videoReadyState: video.readyState,
          videoError: video.error?.message ?? null
        };
      }
    });

    const testResult = results?.[0]?.result ?? {};
    addLog(
      "info",
      "Site HLS test: " + JSON.stringify(testResult, null, 2)
    );

    if (testResult.manifestParsed && !testResult.fatalError && testResult.videoReadyState > 0) {
      setRecordingStatus(
        "Site player is ready. Play the temporary video, then start recording.",
        "success"
      );
      startRecordingButton.disabled = false;
      removeSitePlayerButton.disabled = false;
    } else {
      setRecordingStatus(
        "The site-player test did not confirm playback. Check Logs before recording.",
        "error"
      );
      startRecordingButton.disabled = true;
      removeSitePlayerButton.disabled = false;
    }

    setStatus(
      "Site HLS test finished. Check Logs for key and fragment results."
    );
  } catch (error) {
    setStatus(`Site HLS test failed: ${error.message || error}`);
  } finally {
    testCustomPlayerButton.disabled = false;
  }
});

/*********** APPROACH 2 OVER */


/****** Recording controls: sidebar-managed WebM recording */

const recordingStatusEl = document.getElementById("recordingStatus");
const recordingTimerEl = document.getElementById("recordingTimer");
const startRecordingButton = document.getElementById("startRecording");
const stopRecordingButton = document.getElementById("stopRecording");
const removeSitePlayerButton = document.getElementById("removeSitePlayer");

let recordingStartedAt = null;
let recordingTimerInterval = null;
let lastRecordingDurationMs = 0;

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = value => String(value).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function setRecordingStatus(message, state = "idle") {
  if (recordingStatusEl) {
    recordingStatusEl.textContent = message;
    recordingStatusEl.dataset.state = state;
  }
}

function updateRecordingTimer() {
  if (recordingStartedAt === null) return;
  recordingTimerEl.textContent = formatDuration(Date.now() - recordingStartedAt);
}

function startRecordingTimer() {
  recordingStartedAt = Date.now();
  recordingTimerEl.textContent = "00:00";
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(updateRecordingTimer, 250);
}

function stopRecordingTimer() {
  if (recordingStartedAt !== null) {
    lastRecordingDurationMs = Date.now() - recordingStartedAt;
  }
  recordingStartedAt = null;
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;
  recordingTimerEl.textContent = formatDuration(lastRecordingDurationMs);
}

async function executeOnSelectedPage(action) {
  const tab = await getSelectedTab();
  const granted = await ensurePagePermission(tab);
  if (!granted) throw new Error("Website access was not granted.");

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [action],
    func: async action => {
      const probe = window.__hlsSidePanelProbe;
      const video = probe?.video;

      if (action === "cleanup") {
        if (!probe || !video) {
          return { ok: true, message: "No temporary player was present." };
        }
        if (probe.recording?.recorder?.state === "recording") {
          return { ok: false, message: "Stop the recording before removing the player." };
        }
        try { probe.hls?.destroy(); } catch (_) {}
        try { video.pause(); } catch (_) {}
        try { video.removeAttribute("src"); video.load(); } catch (_) {}
        video.remove();
        try { delete window.__hlsSidePanelProbe; } catch (_) {
          window.__hlsSidePanelProbe = null;
        }
        return { ok: true, message: "Temporary site player removed." };
      }

      if (!video) {
        return {
          ok: false,
          message: "No temporary player found. Select a playlist and click Test Site HLS Player first."
        };
      }

      if (action === "status") {
        return {
          ok: true,
          playerPresent: !!video.isConnected,
          recording: !!probe.recording,
          recorderState: probe.recording?.recorder?.state ?? "inactive"
        };
      }

      if (action === "start") {
        if (probe.recording?.recorder?.state === "recording") {
          return { ok: false, message: "Recording is already running." };
        }
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.paused || video.ended) {
          return {
            ok: false,
            message: "Play the temporary site player first, then start recording."
          };
        }
        if (typeof video.captureStream !== "function") {
          return { ok: false, message: "This browser does not support video.captureStream()." };
        }
        if (typeof MediaRecorder === "undefined") {
          return { ok: false, message: "MediaRecorder is not supported." };
        }

        const stream = video.captureStream();
        const tracks = stream.getTracks();
        if (!tracks.some(track => track.kind === "video")) {
          tracks.forEach(track => track.stop());
          return { ok: false, message: "No video track is available to record." };
        }

        const mimeTypes = [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm"
        ];
        const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
        if (!mimeType) {
          tracks.forEach(track => track.stop());
          return { ok: false, message: "No supported WebM recording format was found." };
        }

        const chunks = [];
        const recorder = new MediaRecorder(stream, { mimeType });
        const recording = { recorder, chunks, stream, startedAt: Date.now(), downloadStarted: false };

        recorder.ondataavailable = event => {
          if (event.data?.size > 0) chunks.push(event.data);
        };
        recorder.onerror = event => {
          console.error("HLS Side Panel Pro recording error:", event.error?.message || "Unknown error");
        };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          if (!blob.size) {
            console.error("Recording ended but produced an empty file.");
            tracks.forEach(track => track.stop());
            probe.recording = null;
            return;
          }

          const downloadUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = downloadUrl;
          link.download = `hls-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
          link.style.display = "none";
          document.body.appendChild(link);
          link.click();
          link.remove();

          setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
          tracks.forEach(track => track.stop());
          recording.downloadStarted = true;
          probe.lastRecording = {
            bytes: blob.size,
            mimeType: recorder.mimeType,
            durationMs: Date.now() - recording.startedAt
          };
          probe.recording = null;
          console.info("WebM recording download triggered:", blob.size, "bytes");
        };

        probe.recording = recording;
        recorder.start(1000);
        return {
          ok: true,
          message: "Recording started.",
          mimeType,
          audioTracks: tracks.filter(track => track.kind === "audio").length,
          videoTracks: tracks.filter(track => track.kind === "video").length
        };
      }

      if (action === "stop") {
        const recording = probe.recording;
        if (!recording || recording.recorder.state !== "recording") {
          return { ok: false, message: "There is no active recording." };
        }
        recording.recorder.stop();
        return { ok: true, message: "Recording stopped. Preparing WebM download…" };
      }

      return { ok: false, message: "Unknown recording action." };
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error("The website did not return a result.");
  return result;
}

async function waitForDownloadFinalization(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await executeOnSelectedPage("status");
      if (state.ok && !state.recording) return true;
    } catch (_) {
      // The user may have navigated away while the recorder was finalizing.
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

startRecordingButton.addEventListener("click", async () => {
  startRecordingButton.disabled = true;
  setRecordingStatus("Starting recorder…", "working");
  try {
    const result = await executeOnSelectedPage("start");
    if (!result.ok) throw new Error(result.message);
    lastRecordingDurationMs = 0;
    startRecordingTimer();
    stopRecordingButton.disabled = false;
    removeSitePlayerButton.disabled = true;
    testCustomPlayerButton.disabled = true;
    setRecordingStatus(
      `Recording WebM · ${result.audioTracks} audio track(s), ${result.videoTracks} video track(s)`,
      "recording"
    );
    addLog("info", `Recording started (${result.mimeType}; audio tracks: ${result.audioTracks}; video tracks: ${result.videoTracks}).`);
  } catch (error) {
    startRecordingButton.disabled = false;
    setRecordingStatus(error.message, "error");
    addLog("error", `Could not start recording: ${error.message}`);
  }
});

stopRecordingButton.addEventListener("click", async () => {
  stopRecordingButton.disabled = true;
  setRecordingStatus("Stopping recorder and preparing download…", "working");
  try {
    const result = await executeOnSelectedPage("stop");
    if (!result.ok) throw new Error(result.message);
    stopRecordingTimer();
    addLog("info", result.message);

    const finalized = await waitForDownloadFinalization();
    startRecordingButton.disabled = false;
    removeSitePlayerButton.disabled = false;
    testCustomPlayerButton.disabled = false;
    setRecordingStatus(
      finalized
        ? `WebM download triggered · duration ${formatDuration(lastRecordingDurationMs)}`
        : `Recorder stopped · duration ${formatDuration(lastRecordingDurationMs)}. Check Chrome downloads.`,
      finalized ? "success" : "working"
    );
    if (finalized) addLog("info", "Recorder finalized and the WebM download was triggered.");
  } catch (error) {
    stopRecordingTimer();
    startRecordingButton.disabled = false;
    removeSitePlayerButton.disabled = false;
    testCustomPlayerButton.disabled = false;
    setRecordingStatus(error.message, "error");
    addLog("error", `Could not stop recording cleanly: ${error.message}`);
  }
});

removeSitePlayerButton.addEventListener("click", async () => {
  removeSitePlayerButton.disabled = true;
  setRecordingStatus("Removing temporary player…", "working");
  try {
    const result = await executeOnSelectedPage("cleanup");
    if (!result.ok) throw new Error(result.message);
    setRecordingStatus(result.message, "idle");
    startRecordingButton.disabled = true;
    stopRecordingButton.disabled = true;
    testCustomPlayerButton.disabled = false;
    addLog("info", result.message);
  } catch (error) {
    setRecordingStatus(error.message, "error");
    addLog("error", `Could not remove temporary player: ${error.message}`);
    removeSitePlayerButton.disabled = false;
  }
});

// A newly created diagnostic player becomes available after the test finishes.
// Keep controls safe if the extension panel is closed/reopened during a recording.
setRecordingStatus("Run Test Site HLS Player and start playback first.", "idle");
startRecordingButton.disabled = true;
stopRecordingButton.disabled = true;
removeSitePlayerButton.disabled = true;

/** Recording controls end */

/******** Direct-download feasibility analysis (read-only diagnostics) ********/
const analyzeHlsButton = document.getElementById("analyzeHls");
const hlsAnalysisStatus = document.getElementById("hlsAnalysisStatus");
const hlsAnalysisDetails = document.getElementById("hlsAnalysisDetails");

function setHlsAnalysisStatus(message, state = "idle") {
  if (!hlsAnalysisStatus) return;
  hlsAnalysisStatus.textContent = message;
  hlsAnalysisStatus.dataset.state = state;
}

function safeJson(value) {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

if (analyzeHlsButton) {
  analyzeHlsButton.addEventListener("click", async () => {
    const playlistUrl = selectedButton?.textContent?.trim();
    if (!playlistUrl || !isM3u8(playlistUrl)) {
      setHlsAnalysisStatus("Scan the page and select an HLS playlist first.", "error");
      return;
    }

    analyzeHlsButton.disabled = true;
    setHlsAnalysisStatus("Inspecting playlists from the extension context...", "working");
    hlsAnalysisDetails.hidden = true;
    hlsAnalysisDetails.textContent = "";

    try {
      const tab = await getSelectedTab();
      if (!await ensurePagePermission(tab)) throw new Error("Website permission was not granted.");
      if (!await ensureStreamPermission(playlistUrl)) throw new Error("Stream-host permission was not granted.");

      // Fetch from the extension page, not the website's MAIN world. Host permissions
      // can authorize cross-origin requests that page-world fetch rejects with CORS.
      const sanitizeUrl = (value) => {
        try { const u = new URL(value); return `${u.origin}${u.pathname}`; }
        catch { return String(value).split("?")[0].split("#")[0]; }
      };
      const fetchText = async (url) => {
        const response = await fetch(url, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${sanitizeUrl(url)}`);
        return { text: await response.text(), status: response.status, contentType: response.headers.get("content-type") || "" };
      };
      const parseAttrs = (line) => {
        const result = {};
        const raw = line.slice(line.indexOf(":") + 1);
        const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
        let m;
        while ((m = regex.exec(raw))) {
          let value = m[2].trim();
          if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
          result[m[1]] = value;
        }
        return result;
      };
      const parsePlaylist = (url, text, meta) => {
        const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const variants = [], renditions = [], segments = [];
        let pendingVariant = null, currentKey = null, initMap = null;
        let totalDuration = 0, targetDuration = null, mediaSequence = null;
        for (const line of lines) {
          if (line.startsWith("#EXT-X-STREAM-INF:")) pendingVariant = parseAttrs(line);
          else if (line.startsWith("#EXT-X-MEDIA:")) {
            const a = parseAttrs(line);
            renditions.push({ type: a.TYPE || null, groupId: a["GROUP-ID"] || null,
              name: a.NAME || null, language: a.LANGUAGE || null, default: a.DEFAULT || null,
              uri: a.URI ? new URL(a.URI, url).href : null });
          } else if (line.startsWith("#EXT-X-KEY:")) {
            const a = parseAttrs(line);
            currentKey = { method: a.METHOD || null, keyFormat: a.KEYFORMAT || "identity",
              keyUri: a.URI ? new URL(a.URI, url).href : null, hasExplicitIv: !!a.IV };
          } else if (line.startsWith("#EXT-X-MAP:")) {
            const a = parseAttrs(line); initMap = a.URI ? new URL(a.URI, url).href : null;
          } else if (line.startsWith("#EXT-X-TARGETDURATION:")) targetDuration = Number(line.split(":")[1]) || null;
          else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSequence = Number(line.split(":")[1]) || 0;
          else if (line.startsWith("#EXTINF:")) {
            const duration = Number(line.slice(8).split(",")[0]) || 0;
            segments.push({ duration, uri: null, key: currentKey }); totalDuration += duration;
          } else if (!line.startsWith("#") && pendingVariant) {
            variants.push({ bandwidth: Number(pendingVariant.BANDWIDTH) || null,
              averageBandwidth: Number(pendingVariant["AVERAGE-BANDWIDTH"]) || null,
              resolution: pendingVariant.RESOLUTION || null, codecs: pendingVariant.CODECS || null,
              audioGroup: pendingVariant.AUDIO || null, uri: new URL(line, url).href });
            pendingVariant = null;
          } else if (!line.startsWith("#") && segments.length && !segments[segments.length - 1].uri) {
            segments[segments.length - 1].uri = new URL(line, url).href;
          }
        }
        const extensions = {};
        for (const seg of segments) {
          if (!seg.uri) continue;
          let ext = "(no extension)";
          try { const path = new URL(seg.uri).pathname; if (path.includes(".")) ext = path.slice(path.lastIndexOf(".")).toLowerCase(); } catch {}
          extensions[ext] = (extensions[ext] || 0) + 1;
        }
        return { url: sanitizeUrl(url), httpStatus: meta.status, contentType: meta.contentType,
          playlistType: variants.length ? "master" : "media", targetDuration, mediaSequence,
          variantCount: variants.length,
          variants: variants.map(v => ({ ...v, uri: sanitizeUrl(v.uri) })).sort((a,b)=>(b.bandwidth||0)-(a.bandwidth||0)),
          renditions: renditions.map(r => ({...r, uri: r.uri ? sanitizeUrl(r.uri) : null})),
          segmentCount: segments.filter(x=>x.uri).length,
          totalDurationSeconds: Math.round(totalDuration*1000)/1000,
          segmentExtensions: extensions, hasInitMap: !!initMap, initMapUri: initMap ? sanitizeUrl(initMap) : null,
          encryption: currentKey ? { method: currentKey.method, keyFormat: currentKey.keyFormat,
            keyUri: currentKey.keyUri ? sanitizeUrl(currentKey.keyUri) : null, hasExplicitIv: currentKey.hasExplicitIv } : { method: "none detected" },
          _variants: variants, _segments: segments, _key: currentKey };
      };
      const report = { selectedPlaylist: sanitizeUrl(playlistUrl),
        note: "Metadata only. Key bytes, cookies, and signed query parameters are not included.", playlists: [] };
      const masterMeta = await fetchText(playlistUrl);
      const master = parsePlaylist(playlistUrl, masterMeta.text, masterMeta);
      report.playlists.push(master);
      const toInspect = [];
      if (master.playlistType === "master" && master._variants.length) {
        const variant = [...master._variants].sort((a,b)=>(b.bandwidth||0)-(a.bandwidth||0))[0];
        const variantMeta = await fetchText(variant.uri);
        const video = parsePlaylist(variant.uri, variantMeta.text, variantMeta);
        video.selectedVariant = { bandwidth: variant.bandwidth, resolution: variant.resolution, codecs: variant.codecs };
        report.playlists.push(video); toInspect.push(video);
        const audio = master.renditions.find(r => r.type === "AUDIO" && r.uri && (!variant.audioGroup || r.groupId === variant.audioGroup));
        if (audio) {
          const audioMeta = await fetchText(audio.uri);
          const audioPlaylist = parsePlaylist(audio.uri, audioMeta.text, audioMeta);
          audioPlaylist.trackType = "audio"; report.playlists.push(audioPlaylist); toInspect.push(audioPlaylist);
        }
      } else toInspect.push(master);

      for (const playlist of toInspect) {
        const seg = playlist._segments.find(s => s.uri);
        if (seg) {
          try {
            const response = await fetch(seg.uri, { credentials: "include", cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const sample = new Uint8Array(await response.arrayBuffer()).slice(0, 512);
            playlist.firstSegmentProbe = { httpStatus: response.status,
              contentType: response.headers.get("content-type") || "", sampleBytesRead: sample.length,
              tsSyncPatternDetected: [0,188,376].every(o=>sample.length>o && sample[o]===0x47),
              firstBytesAscii: Array.from(sample.slice(0,12)).map(b=>b>=32&&b<=126?String.fromCharCode(b):".").join("."),
              url: sanitizeUrl(seg.uri), note: "Encrypted media may not reveal its container signature." };
          } catch (e) { playlist.firstSegmentProbe = { error: String(e?.message || e) }; }
        }
        if (playlist._key?.keyUri) {
          try {
            const response = await fetch(playlist._key.keyUri, { credentials: "include", cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buffer = await response.arrayBuffer();
            playlist.keyResponseProbe = { httpStatus: response.status,
              contentType: response.headers.get("content-type") || "", bytesObserved: buffer.byteLength,
              expectedRawAes128KeyBytes: 16, appearsWrappedOrCustom: buffer.byteLength > 0 && buffer.byteLength !== 16 };
          } catch (e) { playlist.keyResponseProbe = { error: String(e?.message || e) }; }
        }
      }
      for (const playlist of report.playlists) { delete playlist._variants; delete playlist._segments; delete playlist._key; }
      hlsAnalysisDetails.textContent = safeJson(report);
      hlsAnalysisDetails.hidden = false;
      addLog("info", "Direct HLS analysis: " + safeJson(report));
      const media = report.playlists.filter(p => p.playlistType === "media");
      const segments = media.reduce((sum,p)=>sum+(p.segmentCount||0),0);
      setHlsAnalysisStatus(`Analysis complete: ${media.length} media playlist(s), ${segments} segment(s) across tracks.`, "success");
      setStatus("HLS analysis complete. Review Direct Download Analysis and Logs.");
    } catch (error) {
      const message = error?.message || String(error);
      setHlsAnalysisStatus(`Analysis failed: ${message}`, "error");
      addLog("error", `Direct HLS analysis failed: ${message}`);
    } finally { analyzeHlsButton.disabled = false; }
  });
}
