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
let selectedPlaylistTabId = null;
let tabRefreshGeneration = 0;
let followActiveTab = true;

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

async function refreshTabs(preferredTabId = null) {
  const refreshGeneration = ++tabRefreshGeneration;
  const previousId = tabSelect.value;
  try {
    const tabs = await chrome.tabs.query({});
    // A slower, older refresh must never overwrite a newer tab-switch result.
    if (refreshGeneration !== tabRefreshGeneration) return;

    const websiteTabs = tabs.filter(tab => isHttpUrl(tab.url));

    tabSelect.replaceChildren();

    if (!websiteTabs.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No website tabs found";
      tabSelect.appendChild(option);
      selectedButton = null;
      selectedPlaylistTabId = null;
      streamsEl.replaceChildren();
      setStatus("Open your website in a normal browser tab.");
      await syncRecorderControls();
      return;
    }

    for (const tab of websiteTabs) {
      const option = document.createElement("option");
      option.value = String(tab.id);

      const title = tab.title || tab.url;
      let shortUrl = tab.url || "";
      try {
        const parsedUrl = new URL(tab.url);
        shortUrl = `${parsedUrl.hostname}${parsedUrl.pathname}`;
      } catch (_) {}
      shortUrl = shortUrl.slice(0, 58);
      option.textContent = `${tab.active ? "● " : ""}[Tab ${tab.id}] ${title.slice(0, 44)} — ${shortUrl}`;
      option.title = `Tab ID: ${tab.id}\n${tab.title || "Untitled tab"}\n${tab.url || ""}`;
      tabSelect.appendChild(option);
    }

    const exists = id => id !== null && websiteTabs.some(tab => String(tab.id) === String(id));
    const activeTab = websiteTabs.find(tab => tab.active);
    if (exists(preferredTabId)) {
      tabSelect.value = String(preferredTabId);
    } else if (followActiveTab && activeTab) {
      tabSelect.value = String(activeTab.id);
    } else if (exists(previousId)) {
      tabSelect.value = previousId;
    } else if (activeTab) {
      tabSelect.value = String(activeTab.id);
    } else {
      tabSelect.value = String(websiteTabs[0].id);
    }

    // Programmatic .value changes do not fire a change event. Clear all scan
    // results explicitly whenever the selected tab identity changes.
    if (previousId !== tabSelect.value) {
      ++scanId; // invalidate any scan that is still in flight
      selectedButton = null;
      selectedPlaylistTabId = null;
      streamsEl.replaceChildren();
    }

    if (previousId !== tabSelect.value || preferredTabId !== null) {
      setStatus(`Selected Tab ${tabSelect.value}. Scan this tab to discover its playlists.`);
    }
    await syncRecorderControls();
  } catch (error) {
    if (refreshGeneration === tabRefreshGeneration) {
      setStatus(`Unable to list tabs: ${error.message}`);
    }
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
  selectedPlaylistTabId = null;

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
        // Resource Timing is page-local, but it can contain old playlists when
        // a course SPA changes videos without navigating. Keep the most recent
        // occurrence of each URL and return newest-first so the current stream
        // is not buried below historical playlist requests.
        const latestByUrl = new Map();
        for (const resource of performance.getEntriesByType("resource")) {
          const name = resource.name;
          try {
            const url = new URL(name);
            if (!["http:", "https:"].includes(url.protocol) ||
                !url.pathname.toLowerCase().endsWith(".m3u8")) continue;
            const previous = latestByUrl.get(name);
            if (!previous || resource.startTime >= previous.lastSeen) {
              latestByUrl.set(name, { url: name, lastSeen: resource.startTime });
            }
          } catch (_) {}
        }
        return [...latestByUrl.values()]
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .slice(0, 60)
          .map(item => item.url);
      }
    });

    if (currentScan !== scanId) {
      return;
    }
    if (Number(tabSelect.value) !== tab.id) {
      setStatus(`Scan discarded because the selected tab changed. Scan Tab ${tabSelect.value} again.`);
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
      button.dataset.playlistUrl = url;
      button.dataset.tabId = String(tab.id);
      button.title = `Playlist from Tab ${tab.id}; newest resource requests are listed first`;

      button.addEventListener("click", () => {
        if (selectedButton) {
          selectedButton.classList.remove("selected");
        }

        selectedButton = button;
        selectedPlaylistTabId = tab.id;
        button.classList.add("selected");
        setStatus("Playlist selected for this tab. Use Analyze Selected HLS or WebM Recorder > Inject Player.");
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

const testCustomPlayerButton = document.getElementById("injectSitePlayer");
testCustomPlayerButton.textContent = "Inject Player";

testCustomPlayerButton.addEventListener("click", async () => {
  const targetTabId = Number(tabSelect.value);
  const playlistUrl = selectedButton?.dataset?.playlistUrl || selectedButton?.textContent?.trim();

  if (!playlistUrl || !isM3u8(playlistUrl) || selectedPlaylistTabId !== targetTabId ||
      selectedButton?.dataset?.tabId !== String(targetTabId)) {
    setStatus("Scan this tab and select one of its HLS playlists before injecting a player.");
    return;
  }

  testCustomPlayerButton.disabled = true;

  try {
    const tab = await chrome.tabs.get(targetTabId);
    if (Number(tabSelect.value) !== targetTabId) {
      throw new Error("The selected tab changed. Select its playlist and try injecting again.");
    }
    const pagePermission = await ensurePagePermission(tab);
    if (!pagePermission) throw new Error("Website access was not granted.");
    await installNotificationBridge(tab.id);

    setStatus(`Injecting the selected playlist into Tab ${tab.id}...`);

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
        "Player injected. Press Play on this tab, then start recording. You can repeat this on other tabs.",
        "success"
      );
      await syncRecorderControls();
    } else {
      setRecordingStatus(
        "Player injection did not confirm readiness. Check Logs and the page player.",
        "error"
      );
      await syncRecorderControls();
    }

    setStatus(
      "Player injection finished for the selected tab. Select another tab to set up another recording."
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

      const toBase64 = bytes => {
        let binary = "";
        const step = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += step) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
        }
        return btoa(binary);
      };

      window.addEventListener("message", event => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.channel !== "hls-side-panel-file-recorder-v1" || data.type !== "chunk") return;
        if (!(data.blob instanceof Blob) || !data.sessionId) return;

        bridgeQueue = bridgeQueue.then(async () => {
          const bytes = new Uint8Array(await data.blob.arrayBuffer());
          const acknowledgement = await chrome.runtime.sendMessage({
            type: "HLS_SIDEPANEL_RECORDING_CHUNK",
            sessionId: data.sessionId,
            sequence: data.sequence,
            base64: toBase64(bytes)
          });
          if (!acknowledgement?.ok) {
            throw new Error(acknowledgement?.message || "The recording chunk could not be written to disk.");
          }
        }).catch(error => {
          console.error("HLS Side Panel Pro chunk bridge failed:", error?.message || error);
        });
      });

      // This distinct event avoids duplicate completion handling by an older bridge
      // that may still be installed in an already-open course tab.
      window.addEventListener("hls-side-panel-recording-stream-finished", event => {
        let detail = {};
        try { detail = JSON.parse(String(event.detail || "{}")); } catch (_) {}
        bridgeQueue = bridgeQueue.then(async () => {
          await chrome.runtime.sendMessage({
            type: "HLS_SIDEPANEL_RECORDING_FINISHED",
            detail
          });
        }).catch(error => {
          console.error("HLS Side Panel Pro completion bridge failed:", error?.message || error);
        });
      });

      // Keep the legacy in-memory recorder's completion path working.
      if (!window.__hlsSidePanelNotificationBridgeInstalled) {
        window.__hlsSidePanelNotificationBridgeInstalled = true;
        window.addEventListener("hls-side-panel-recording-finished", event => {
          let detail = {};
          try { detail = JSON.parse(String(event.detail || "{}")); } catch (_) {}
          chrome.runtime.sendMessage({
            type: "HLS_SIDEPANEL_RECORDING_FINISHED",
            detail
          }).catch(() => {});
        });
      }
    }
  });
}

let recorderUiBusy = false;
let recordingStartedAt = null;
let recordingTimerInterval = null;
let lastRecordingDurationMs = 0;
const fileRecordingSessions = new Map();

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

async function executeOnSelectedPage(action, explicitTabId = null, actionOptions = {}) {
  const tab = explicitTabId ? await chrome.tabs.get(explicitTabId) : await getSelectedTab();
  const granted = await ensurePagePermission(tab);
  if (!granted) throw new Error("Website access was not granted.");
  await installNotificationBridge(tab.id);

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
      const enableRecordingGuard = () => {
        if (window[refreshGuardKey]?.active) return;
        const handler = event => {
          event.preventDefault();
          event.returnValue = "";
          return "";
        };
        window.addEventListener("beforeunload", handler);
        window[refreshGuardKey] = { active: true, handler };
      };
      const disableRecordingGuard = () => {
        const guard = window[refreshGuardKey];
        if (!guard) return;
        try { window.removeEventListener("beforeunload", guard.handler); } catch (_) {}
        try { delete window[refreshGuardKey]; } catch (_) { window[refreshGuardKey] = null; }
      };

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

      // Status must work even after cleanup removed the player/global probe.
      // This lets the side panel clear stale success UI and re-enable Inject.
      if (action === "status") {
        const playerPresent = !!video?.isConnected;
        return {
          ok: true,
          playerPresent,
          recording: playerPresent && !!probe?.recording,
          recorderState: playerPresent ? (probe?.recording?.recorder?.state ?? "inactive") : "inactive",
          startedAt: playerPresent ? (probe?.recording?.startedAt ?? null) : null,
          lastRecording: playerPresent ? (probe?.lastRecording ?? null) : null,
          videoEnded: playerPresent && !!video?.ended,
          videoPaused: playerPresent ? (video?.paused ?? true) : true
        };
      }

      if (!video) {
        return {
          ok: false,
          message: "No temporary player found. Select a playlist and click Inject Player first."
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

        const storageMode = actionOptions.storageMode || "file";
        const sessionId = actionOptions.sessionId || null;
        if (storageMode === "file" && !sessionId) {
          return { ok: false, message: "Missing direct-to-file recording session." };
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

        const chunks = storageMode === "memory" ? [] : null;
        const recorder = new MediaRecorder(stream, { mimeType });
        const recording = {
          recorder, chunks, stream, startedAt: Date.now(), downloadStarted: false,
          stopReason: "manual", autoStopHandler: null, storageMode, sessionId,
          filename: actionOptions.filename || null, chunkSequence: 0
        };

        recorder.ondataavailable = event => {
          if (!event.data || event.data.size === 0) return;
          if (recording.storageMode === "file") {
            // Blob is structured-cloned to the isolated-world bridge; no full-recording
            // chunk array or large final Blob is created in the page.
            window.postMessage({
              channel: "hls-side-panel-file-recorder-v1",
              type: "chunk",
              sessionId: recording.sessionId,
              sequence: recording.chunkSequence++,
              blob: event.data
            }, "*");
          } else {
            recording.chunks.push(event.data);
          }
        };
        recorder.onerror = event => {
          console.error("HLS Side Panel Pro recording error:", event.error?.message || "Unknown error");
        };
        recorder.onstop = () => {
          // Recording has stopped; normal navigation is allowed again.
          disableRecordingGuard();
          if (recording.autoStopHandler) {
            video.removeEventListener("ended", recording.autoStopHandler);
          }
          tracks.forEach(track => track.stop());
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
              streamedToFile: true
            };
            probe.recording = null;
            window.dispatchEvent(new CustomEvent("hls-side-panel-recording-stream-finished", {
              detail: JSON.stringify({
                ok: true,
                reason: recording.stopReason,
                durationMs,
                filename: recording.filename,
                sessionId: recording.sessionId,
                pageTitle: document.title || location.hostname,
                streamedToFile: true
              })
            }));
            console.info("WebM recording chunks streamed to the selected file:", recording.filename);
            return;
          }

          const blob = new Blob(recording.chunks, { type: recorder.mimeType });
          if (!blob.size) {
            console.error("Recording ended but produced an empty file.");
            probe.recording = null;
            window.dispatchEvent(new CustomEvent("hls-side-panel-recording-finished", {
              detail: JSON.stringify({ ok: false, reason: recording.stopReason, message: "Recording produced an empty file." })
            }));
            return;
          }

          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const safeTabTitle = (document.title || "video").replace(/[^a-z0-9-_ ]/gi, "").trim().slice(0, 60) || "video";
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
            filename: link.download
          };
          probe.recording = null;
          window.dispatchEvent(new CustomEvent("hls-side-panel-recording-finished", {
            detail: JSON.stringify({
              ok: true,
              reason: recording.stopReason,
              bytes: blob.size,
              durationMs,
              filename: link.download,
              pageTitle: document.title || location.hostname
            })
          }));
          console.info("WebM recording download triggered:", blob.size, "bytes", "reason:", recording.stopReason);
        };

        recording.autoStopHandler = () => {
          if (recorder.state === "recording") {
            recording.stopReason = "ended";
            console.info("Video ended; automatically stopping WebM recording.");
            recorder.stop();
          }
        };
        video.addEventListener("ended", recording.autoStopHandler, { once: true });
        probe.recording = recording;
        recorder.start(1000);
        enableRecordingGuard();
        return {
          ok: true,
          message: "Recording started with incremental file writes. Refresh warning enabled for this tab.",
          mimeType,
          storageMode,
          filename: recording.filename,
          audioTracks: tracks.filter(track => track.kind === "audio").length,
          videoTracks: tracks.filter(track => track.kind === "video").length
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
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error("The website did not return a result.");
  return result;
}

async function waitForDownloadFinalization(tabId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await executeOnSelectedPage("status", tabId);
      const fileWritePending = [...fileRecordingSessions.values()].some(session => session.tabId === tabId);
      if (state.ok && !state.recording && !fileWritePending) return true;
    } catch (_) {
      // The user may have navigated away while the recorder was finalizing.
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function syncRecorderControls() {
  if (recorderUiBusy) return;
  try {
    const tab = await getSelectedTab();
    const state = await executeOnSelectedPage("status", tab.id);
    const isRecording = state.recording && state.recorderState === "recording";
    // Inject and Remove are mutually exclusive for the selected tab.
    // An existing player means Inject is unavailable and Remove is available.
    testCustomPlayerButton.disabled = !!state.playerPresent || isRecording;
    startRecordingButton.disabled = !state.playerPresent || isRecording;
    stopRecordingButton.disabled = !isRecording;
    removeSitePlayerButton.disabled = !state.playerPresent || isRecording;
    if (isRecording && state.startedAt) {
      recordingStartedAt = state.startedAt;
      recordingTimerEl.textContent = formatDuration(Date.now() - state.startedAt);
      setRecordingStatus(`Recording in this tab · ${tab.title || tab.url} · refresh warning active`, "recording");
    } else if (state.playerPresent) {
      recordingStartedAt = null;
      recordingTimerEl.textContent = state.lastRecording?.durationMs
        ? formatDuration(state.lastRecording.durationMs) : "00:00";
      if (state.lastRecording && state.lastRecording.finishedAt) {
        const age = Date.now() - state.lastRecording.finishedAt;
        if (age < 15000) {
          setRecordingStatus(`Last recording saved (${state.lastRecording.reason === "ended" ? "video ended" : "stopped manually"}).`, "success");
        } else {
          setRecordingStatus("Player ready. Play this tab's video, then start recording.", "idle");
        }
      } else {
        setRecordingStatus("Player ready. Play this tab's video, then start recording.", "success");
      }
    } else {
      recordingStartedAt = null;
      recordingTimerEl.textContent = "00:00";
      startRecordingButton.disabled = true;
      stopRecordingButton.disabled = true;
      removeSitePlayerButton.disabled = true;
      setRecordingStatus("Player removed. Select this tab's playlist and click Inject Player to inject it again.", "idle");
    }
  } catch (_) {
    testCustomPlayerButton.disabled = false;
    startRecordingButton.disabled = true;
    stopRecordingButton.disabled = true;
    removeSitePlayerButton.disabled = true;
    recordingStartedAt = null;
    recordingTimerEl.textContent = "00:00";
    setRecordingStatus("Select a website tab with page access, then click Inject Player.", "idle");
  }
}

// Repairs MediaRecorder WebM files in-place after recording. It adds a Duration
// element when missing and builds a Cues index from video keyframes, using bounded
// reads/writes so the entire recording is never loaded into RAM.
const WEBM_REPAIR_READ_CACHE = 4 * 1024 * 1024;
const WEBM_REPAIR_COPY_CHUNK = 8 * 1024 * 1024;

class WebmBlobReader {
  constructor(blob) { this.blob = blob; this.cacheStart = -1; this.cache = new Uint8Array(0); }
  async bytes(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.blob.size) throw new Error("Unexpected end of WebM file.");
    if (this.cacheStart <= offset && offset + length <= this.cacheStart + this.cache.length) {
      return this.cache.subarray(offset - this.cacheStart, offset - this.cacheStart + length);
    }
    const start = Math.floor(offset / WEBM_REPAIR_READ_CACHE) * WEBM_REPAIR_READ_CACHE;
    const end = Math.min(this.blob.size, Math.max(start + WEBM_REPAIR_READ_CACHE, offset + length));
    this.cache = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
    this.cacheStart = start;
    if (offset + length > this.cacheStart + this.cache.length) return this.bytes(offset, length);
    return this.cache.subarray(offset - this.cacheStart, offset - this.cacheStart + length);
  }
}

async function webmReadVint(reader, offset, isId = false) {
  const first = (await reader.bytes(offset, 1))[0];
  if (!first) throw new Error("Invalid EBML variable integer.");
  let mask = 0x80, length = 1;
  while (!(first & mask)) { mask >>= 1; length++; if (length > (isId ? 4 : 8)) throw new Error("Invalid EBML variable integer length."); }
  const raw = await reader.bytes(offset, length);
  let value = BigInt(isId ? raw[0] : raw[0] & (mask - 1));
  for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(raw[i]);
  const unknown = !isId && value === ((1n << BigInt(7 * length)) - 1n);
  return { value, length, unknown };
}

async function webmReadElement(reader, offset, parentEnd) {
  const id = await webmReadVint(reader, offset, true);
  const size = await webmReadVint(reader, offset + id.length, false);
  const dataStart = offset + id.length + size.length;
  const end = size.unknown ? parentEnd : dataStart + Number(size.value);
  if (end < dataStart || end > parentEnd) throw new Error("Invalid EBML element bounds.");
  return { id: id.value, offset, idLength: id.length, sizeOffset: offset + id.length, sizeLength: size.length, sizeValue: size.value, unknownSize: size.unknown, dataStart, end };
}

async function webmReadUint(reader, element) {
  const length = element.end - element.dataStart;
  if (length < 1 || length > 8) throw new Error("Invalid EBML integer element.");
  const bytes = await reader.bytes(element.dataStart, length);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function webmEncodeSize(value, requestedLength = 0) {
  const n = BigInt(value);
  let length = requestedLength;
  if (!length) {
    for (length = 1; length <= 8; length++) {
      if (n < ((1n << BigInt(7 * length)) - 1n)) break;
    }
  }
  if (length < 1 || length > 8 || n >= ((1n << BigInt(7 * length)) - 1n)) throw new Error("EBML element size is too large for its existing header.");
  let v = n;
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; }
  out[0] |= 1 << (8 - length);
  return out;
}

function webmEncodeUint(value) {
  let n = BigInt(value);
  let length = 1;
  while (n >= (1n << BigInt(8 * length))) length++;
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}

function webmConcat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function webmElement(idHex, payload) {
  const id = new Uint8Array(idHex.match(/../g).map(part => parseInt(part, 16)));
  return webmConcat([id, webmEncodeSize(payload.length), payload]);
}

function webmMakeDurationElement(durationTicks) {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, durationTicks, false);
  return webmElement("4489", payload);
}

function webmMakeCues(cues) {
  const points = [];
  for (const cue of cues) {
    const cueTime = webmElement("B3", webmEncodeUint(Math.max(0, Math.round(cue.time))));
    const cueTrack = webmElement("F7", webmEncodeUint(cue.track));
    const cuePosition = webmElement("F1", webmEncodeUint(cue.position));
    const trackPositions = webmElement("B7", webmConcat([cueTrack, cuePosition]));
    points.push(webmElement("BB", webmConcat([cueTime, trackPositions])));
  }
  return webmElement("1C53BB6B", webmConcat(points));
}

async function webmFindChild(reader, parent, wantedId) {
  let offset = parent.dataStart;
  while (offset < parent.end) {
    const child = await webmReadElement(reader, offset, parent.end);
    if (child.id === wantedId) return child;
    if (child.end <= offset) throw new Error("Invalid EBML child traversal.");
    offset = child.end;
  }
  return null;
}

async function repairWebmFile(fileHandle, durationMs, log = () => {}) {
  const originalFile = await fileHandle.getFile();
  if (!originalFile.size) return { ok: false, message: "The WebM file is empty." };
  const reader = new WebmBlobReader(originalFile);
  let offset = 0, segment = null, info = null, tracks = null, existingCues = null;
  while (offset < originalFile.size) {
    const element = await webmReadElement(reader, offset, originalFile.size);
    if (element.id === 0x18538067n) { segment = element; break; }
    if (element.end <= offset) throw new Error("Could not locate the WebM Segment.");
    offset = element.end;
  }
  if (!segment) return { ok: false, message: "No WebM Segment was found; original file was left unchanged." };
  if (!segment.unknownSize && segment.end !== originalFile.size) {
    return { ok: false, message: "This WebM has data after its finite Segment; repair was skipped to avoid changing file structure." };
  }
  let childOffset = segment.dataStart;
  while (childOffset < segment.end) {
    const element = await webmReadElement(reader, childOffset, segment.end);
    if (element.id === 0x1549A966n) info = element;
    else if (element.id === 0x1654AE6Bn) tracks = element;
    else if (element.id === 0x1C53BB6Bn) existingCues = element;
    if (element.end <= childOffset) throw new Error("Invalid WebM Segment structure.");
    childOffset = element.end;
  }
  if (!info) return { ok: false, message: "WebM Info metadata was not found; original file was left unchanged." };

  const infoChildren = [];
  childOffset = info.dataStart;
  let timecodeScale = 1000000n, durationElement = null;
  while (childOffset < info.end) {
    const element = await webmReadElement(reader, childOffset, info.end);
    if (element.id === 0x2AD7B1n) timecodeScale = await webmReadUint(reader, element);
    if (element.id === 0x4489n) durationElement = element;
    infoChildren.push(element);
    childOffset = element.end;
  }
  const durationTicks = Math.max(0, Number(durationMs) * 1000000 / Number(timecodeScale || 1000000n));
  let infoReplacement = null;
  let insertionDelta = 0;
  if (durationElement) {
    const size = durationElement.end - durationElement.dataStart;
    if (size !== 4 && size !== 8) return { ok: false, message: "Unsupported existing WebM Duration encoding; original file was left unchanged." };
    const durationPayload = new Uint8Array(size);
    const view = new DataView(durationPayload.buffer);
    if (size === 8) view.setFloat64(0, durationTicks, false);
    else view.setFloat32(0, durationTicks, false);
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    try { await writable.seek(durationElement.dataStart); await writable.write(durationPayload); await writable.close(); }
    catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
  } else {
    if (existingCues) return { ok: false, message: "This WebM already contains Cues but has no Duration. Repair was skipped to avoid invalidating its existing seek index." };
    const oldInfoBytes = new Uint8Array(await originalFile.slice(info.offset, info.end).arrayBuffer());
    const idBytes = oldInfoBytes.slice(0, info.idLength);
    const oldSizeHeaderLength = info.sizeLength;
    const payload = oldInfoBytes.slice(info.idLength + oldSizeHeaderLength);
    const newPayload = webmConcat([payload, webmMakeDurationElement(durationTicks)]);
    const newSize = webmEncodeSize(newPayload.length);
    const newInfoBytes = webmConcat([idBytes, newSize, newPayload]);
    infoReplacement = newInfoBytes;
    insertionDelta = newInfoBytes.length - oldInfoBytes.length;
  }

  const cues = [];
  if (!existingCues) {
    let videoTrack = 1;
    if (tracks) {
      let trackOffset = tracks.dataStart;
      while (trackOffset < tracks.end) {
        const trackEntry = await webmReadElement(reader, trackOffset, tracks.end);
        if (trackEntry.id === 0xAEn) {
          let trackNumber = null, trackType = null, subOffset = trackEntry.dataStart;
          while (subOffset < trackEntry.end) {
            const sub = await webmReadElement(reader, subOffset, trackEntry.end);
            if (sub.id === 0xD7n) trackNumber = Number(await webmReadUint(reader, sub));
            if (sub.id === 0x83n) trackType = Number(await webmReadUint(reader, sub));
            subOffset = sub.end;
          }
          if (trackType === 1 && trackNumber) { videoTrack = trackNumber; break; }
        }
        trackOffset = trackEntry.end;
      }
    }

    childOffset = segment.dataStart;
    while (childOffset < segment.end) {
      const element = await webmReadElement(reader, childOffset, segment.end);
      if (element.id === 0x1F43B675n) {
        let clusterTime = 0, firstKeyframe = null, inner = element.dataStart;
        while (inner < element.end) {
          const sub = await webmReadElement(reader, inner, element.end);
          if (sub.id === 0xE7n) clusterTime = Number(await webmReadUint(reader, sub));
          else if (sub.id === 0xA3n && !firstKeyframe) {
            const trackVint = await webmReadVint(reader, sub.dataStart, false);
            const flagOffset = sub.dataStart + trackVint.length + 2;
            if (flagOffset < sub.end) {
              const blockHead = await reader.bytes(flagOffset, 1);
              if (Number(trackVint.value) === videoTrack && (blockHead[0] & 0x80)) {
                const relativeBytes = await reader.bytes(sub.dataStart + trackVint.length, 2);
                let relative = (relativeBytes[0] << 8) | relativeBytes[1];
                if (relative & 0x8000) relative -= 0x10000;
                firstKeyframe = Math.max(0, clusterTime + relative);
              }
            }
          }
          if (sub.end <= inner) throw new Error("Invalid WebM Cluster structure.");
          inner = sub.end;
        }
        if (firstKeyframe !== null) {
          cues.push({ time: firstKeyframe, track: videoTrack, position: (element.offset - segment.dataStart) + insertionDelta });
        }
      }
      if (element.end <= childOffset) throw new Error("Invalid WebM Segment traversal.");
      childOffset = element.end;
    }
    if (!cues.length) return { ok: false, message: "No video keyframe clusters were found. The original file was left unchanged." };
  }

  const cuesBytes = existingCues ? new Uint8Array(0) : webmMakeCues(cues);
  const finalSize = originalFile.size + insertionDelta + cuesBytes.length;
  const newSegmentSize = segment.unknownSize ? null : segment.sizeValue + BigInt(insertionDelta + cuesBytes.length);
  let segmentSizeBytes = null;
  if (newSegmentSize !== null) segmentSizeBytes = webmEncodeSize(newSegmentSize, segment.sizeLength);

  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    if (infoReplacement) {
      await writable.truncate(finalSize);
      let cursor = originalFile.size;
      while (cursor > info.end) {
        const start = Math.max(info.end, cursor - WEBM_REPAIR_COPY_CHUNK);
        const bytes = new Uint8Array(await originalFile.slice(start, cursor).arrayBuffer());
        await writable.seek(start + insertionDelta);
        await writable.write(bytes);
        cursor = start;
      }
      await writable.seek(info.offset);
      await writable.write(infoReplacement);
    } else {
      await writable.truncate(finalSize);
    }
    if (segmentSizeBytes) {
      await writable.seek(segment.sizeOffset);
      await writable.write(segmentSizeBytes);
    }
    if (cuesBytes.length) {
      await writable.seek(originalFile.size + insertionDelta);
      await writable.write(cuesBytes);
    }
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch (_) {}
    throw error;
  }
  log(`WebM metadata repaired: duration set, ${cues.length} seek cue(s) added${insertionDelta ? `, ${insertionDelta} byte(s) inserted` : ""}.`);
  return { ok: true, durationSet: true, cuesAdded: cues.length, bytesAdded: insertionDelta + cuesBytes.length };
}


startRecordingButton.addEventListener("click", async () => {
  recorderUiBusy = true;
  startRecordingButton.disabled = true;
  setRecordingStatus("Choose a destination file…", "working");
  let sessionId = null;
  let writable = null;
  try {
    if (typeof window.showSaveFilePicker !== "function") {
      throw new Error("Direct-to-file recording requires a desktop Chromium browser with File System Access support. Please update Chrome and reopen the extension.");
    }

    // Invoke the picker synchronously from this click handler to preserve user activation.
    const tabId = Number(tabSelect.value);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Select a website tab first.");
    const tabLabel = tabSelect.selectedOptions?.[0]?.textContent || "course-video";
    const safeTitle = tabLabel.replace(/[^a-z0-9-_ ]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "course-video";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suggestedName = `${safeTitle}-recording-${stamp}.webm`;
    const fileHandlePromise = window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "WebM video", accept: { "video/webm": [".webm"] } }]
    });
    const fileHandle = await fileHandlePromise;
    writable = await fileHandle.createWritable();
    const tab = await chrome.tabs.get(tabId);
    if (!isHttpUrl(tab.url)) throw new Error("The selected tab is no longer a normal website tab.");

    sessionId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const session = {
      sessionId, tabId: tab.id, tabTitle: tab.title || tab.url,
      filename: fileHandle.name || suggestedName, fileHandle, writable,
      writeQueue: Promise.resolve(), bytes: 0, startedAt: null, error: null,
      finalizing: false
    };
    fileRecordingSessions.set(sessionId, session);

    const result = await executeOnSelectedPage("start", tab.id, {
      storageMode: "file", sessionId, filename: session.filename
    });
    if (!result.ok) throw new Error(result.message);
    session.startedAt = Date.now();
    recordingStartedAt = session.startedAt;
    recordingTimerEl.textContent = "00:00";
    setRecordingStatus(`Recording to file · ${session.filename} · ${result.audioTracks} audio / ${result.videoTracks} video track(s) · refresh warning active`, "recording");
    addLog("info", `Tab ${tab.id}: recording to ${session.filename}; chunks will be written incrementally to disk. Refresh warning enabled for this tab.`);
  } catch (error) {
    if (sessionId) fileRecordingSessions.delete(sessionId);
    if (writable) {
      try { await writable.abort(); } catch (_) {}
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

// Write each encoded MediaRecorder chunk to its selected file in order.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "HLS_SIDEPANEL_RECORDING_CHUNK_PANEL") {
    const session = fileRecordingSessions.get(message.sessionId);
    if (!session) {
      sendResponse({ ok: false, message: "No active file writer exists for this recording. Keep the side panel open while recording." });
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
    session.writeQueue.then(() => sendResponse({ ok: true, bytesWritten: session.bytes })).catch(async error => {
      session.error = error?.message || String(error);
      addLog("error", `Tab ${session.tabId}: writing recording to disk failed: ${session.error}`);
      if (Number(tabSelect.value) === session.tabId) setRecordingStatus(`File write failed: ${session.error}`, "error");
      try { await executeOnSelectedPage("stop", session.tabId); } catch (_) {}
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
        addLog("info", `Tab ${session.tabId}: recording bytes flushed to ${session.filename} (${session.bytes.toLocaleString()} bytes).`);
        try {
          const repair = await repairWebmFile(session.fileHandle, detail.durationMs || 0, message =>
            addLog("info", `Tab ${session.tabId}: ${message}`)
          );
          finalDetail.webmRepair = repair;
          if (repair.ok) {
            const repairedFile = await session.fileHandle.getFile();
            finalDetail.bytes = repairedFile.size;
            addLog("info", `Tab ${session.tabId}: WebM seek metadata repair completed (${repairedFile.size.toLocaleString()} bytes).`);
          } else {
            addLog("warning", `Tab ${session.tabId}: WebM metadata repair skipped: ${repair.message}`);
          }
        } catch (repairError) {
          finalDetail.webmRepair = { ok: false, message: repairError?.message || String(repairError) };
          addLog("warning", `Tab ${session.tabId}: WebM metadata repair failed; the original recording was retained where possible: ${finalDetail.webmRepair.message}`);
        }
      } else {
        try { await session.writable.abort(); } catch (_) {}
        finalDetail.ok = false;
        finalDetail.message = session.error || detail.message || (session.bytes === 0
          ? "No media chunks were written; the output file was not saved."
          : "Recording did not complete successfully.");
      }
      fileRecordingSessions.delete(session.sessionId);
      if (Number(tabSelect.value) === session.tabId) {
        if (finalDetail.ok) {
          setRecordingStatus(`Saved ${session.filename} (${(session.bytes / (1024 * 1024)).toFixed(1)} MB).`, "success");
          recordingStartedAt = null;
          recordingTimerEl.textContent = formatDuration(detail.durationMs || 0);
        } else {
          setRecordingStatus(`Recording save failed: ${finalDetail.message}`, "error");
        }
      }
      sendResponse({ ok: finalDetail.ok !== false, detail: finalDetail });
      syncRecorderControls();
    })().catch(async error => {
      const failure = error?.message || String(error);
      try { await session.writable.abort(); } catch (_) {}
      fileRecordingSessions.delete(session.sessionId);
      sendResponse({ ok: false, detail: { ...detail, ok: false, filename: session.filename, message: failure } });
    });
    return true;
  }
});

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
      finalized ? "Recording file finalized for this tab." : "Recorder stopped. Check the selected file and Logs.",
      finalized ? "success" : "working"
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

tabSelect.addEventListener("change", () => {
  // A manual dropdown choice should remain selected until the next browser-tab
  // activation. Playlist URLs are scoped to the tab that exposed them.
  followActiveTab = false;
  ++scanId;
  selectedButton = null;
  selectedPlaylistTabId = null;
  streamsEl.replaceChildren();
  syncRecorderControls();
});
refreshButton.addEventListener("click", () => { setTimeout(syncRecorderControls, 100); });

// Keep the dropdown and recorder controls aligned with the browser tab the user
// has just switched to. Recording itself remains owned by each individual page.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  followActiveTab = true;
  refreshTabs(tabId).then(() => syncRecorderControls()).catch(error => {
    addLog("warning", `Could not follow active tab: ${error.message || error}`);
  });
});

// Refresh labels when a page title or URL changes, without changing the current
// selection. Include a removed-tab refresh so stale entries disappear promptly.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title || changeInfo.url) refreshTabs();
});
chrome.tabs.onRemoved.addListener(() => refreshTabs());

setInterval(() => {
  if (recordingStartedAt !== null) recordingTimerEl.textContent = formatDuration(Date.now() - recordingStartedAt);
  syncRecorderControls();
}, 1000);

// A newly created diagnostic player becomes available after the test finishes.
// Keep controls safe if the extension panel is closed/reopened during a recording.
setRecordingStatus("Select a playlist and click Inject Player to set up this tab.", "idle");
testCustomPlayerButton.disabled = false;
startRecordingButton.disabled = true;
stopRecordingButton.disabled = true;
removeSitePlayerButton.disabled = true;
syncRecorderControls();

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
    const playlistUrl = selectedButton?.dataset?.playlistUrl || selectedButton?.textContent?.trim();
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
