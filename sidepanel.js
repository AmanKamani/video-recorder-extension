import { createLogger } from "./modules/logger.js";
import { createRecorderController } from "./modules/recorder.js";
import { repairWebmFile } from "./modules/webm-repair.js";
import { registerHlsAnalysis } from "./modules/hls-analysis.js";
import { isHttpUrl, isM3u8 } from "./modules/url-utils.js";

// Main side-panel coordinator: wires UI events to focused feature modules.
const tabSelect = document.getElementById("tabSelect");
const refreshButton = document.getElementById("refreshTabs");
const scanButton = document.getElementById("scan");
const injectButton = document.getElementById("injectSitePlayer");
const statusEl = document.getElementById("status");
const streamsEl = document.getElementById("streams");
const logsArea = document.getElementById("logsArea");
const logger = createLogger({ logsArea });
const addLog = logger.add;

// The recorder module owns per-tab sessions, file writing, finalization, and its
// controls. These small wrappers let tab/player coordination request status updates.
let recorderController = null;
/** Keeps the recording buttons aligned with the selected tab and its current player/recorder state. */
function syncRecorderControls() {
  return recorderController ? recorderController.syncRecorderControls() : Promise.resolve();
}
/** Updates the recorder status message and visual state. */
function setRecordingStatus(message, state = "idle") {
  if (recorderController) recorderController.setRecordingStatus(message, state);
}
/** Installs the page-to-extension bridge used to report recording completion for a tab. */
function installNotificationBridge(tabId) {
  if (!recorderController) throw new Error("Recorder controller is not initialized.");
  return recorderController.installNotificationBridge(tabId);
}

// Tab navigation elements
const tabNav = document.getElementById("tabNav");
const tabStreamBtn = document.querySelector('[data-tab="streams"]');
const tabLogsBtn = document.querySelector('[data-tab="logs"]');
const tabContentStreams = document.getElementById("tabStreams");
const tabContentLogs = document.getElementById("tabLogs");

let scanId = 0;
let selectedButton = null;
let selectedPlaylistTabId = null;
let tabRefreshGeneration = 0;
let followActiveTab = true;

/** Updates the main status line and records the same message in the operation log. */
function setStatus(message) {
  statusEl.textContent = message;
  addLog("info", message);
}

// Tab discovery and selection. Generation tokens prevent stale async refreshes
// from replacing a more recent active-tab selection.
async function refreshTabs(preferredTabId = null) {
  const refreshGeneration = ++tabRefreshGeneration;
  const previousId = tabSelect.value;
  try {
    const tabs = await chrome.tabs.query({});
    // A slower, older refresh must never overwrite a newer tab-switch result.
    if (refreshGeneration !== tabRefreshGeneration) return;

    const websiteTabs = tabs.filter((tab) => isHttpUrl(tab.url));

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

    // Checks whether a tab ID is still present in the refreshed website-tab list.
    const exists = (id) => id !== null && websiteTabs.some((tab) => String(tab.id) === String(id));
    const activeTab = websiteTabs.find((tab) => tab.active);
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

/** Switches between the Streams and Logs panels and updates the active navigation button. */
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
  // Switches the side panel to the Streams view when the Streams tab is clicked.
  tabStreamBtn.addEventListener("click", () => switchTab("streams"));
}
if (tabLogsBtn) {
  // Switches the side panel to the Logs view when the Logs tab is clicked.
  tabLogsBtn.addEventListener("click", () => switchTab("logs"));
}

// Clear the retained log history using the dedicated UI control.
const clearLogsBtn = document.getElementById("clearLogs");
if (clearLogsBtn) {
  // Clears the visible and exportable operation log history.
  clearLogsBtn.addEventListener("click", () => {
    logger.clear();
    addLog("info", "Logs cleared");
  });
}

/** Looks up and validates the website tab currently selected in the side panel. */
async function getSelectedTab() {
  const tabId = Number(tabSelect.value);

  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("No website tab selected. Click Refresh tabs.");
  }

  const tab = await chrome.tabs.get(tabId);

  if (!isHttpUrl(tab.url)) {
    throw new Error("Select a normal HTTP or HTTPS website tab.");
  }

  return tab;
}

/** Requests the optional host permission needed to inspect or interact with the selected website. */
async function ensurePagePermission(tab) {
  const url = new URL(tab.url);

  const originPattern = `${url.protocol}//${url.host}/*`;

  const alreadyGranted = await chrome.permissions.contains({
    origins: [originPattern],
  });

  if (alreadyGranted) {
    return true;
  }

  return await chrome.permissions.request({
    origins: [originPattern],
  });
}

// Initialize the recorder after the tab/permission helpers exist. The module
// registers recording buttons and the background-message bridge on creation.
recorderController = createRecorderController({
  tabSelect,
  injectButton,
  getSelectedTab,
  ensurePagePermission,
  isHttpUrl,
  addLog,
  setStatus,
  repairWebmFile,
});

// Scan only the selected tab, and discard results if the selection changes mid-scan.
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
      throw new Error("Website permission was denied. Allow access and try again.");
    }

    setStatus("Scanning the selected website...");

    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
      },

      // Executes a small, read-only diagnostic in the selected website page.
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
            if (
              !["http:", "https:"].includes(url.protocol) ||
              !url.pathname.toLowerCase().endsWith(".m3u8")
            )
              continue;
            const previous = latestByUrl.get(name);
            if (!previous || resource.startTime >= previous.lastSeen) {
              latestByUrl.set(name, { url: name, lastSeen: resource.startTime });
            }
          } catch (_) {}
        }
        return [...latestByUrl.values()]
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .slice(0, 60)
          .map((item) => item.url);
      },
    });

    if (currentScan !== scanId) {
      return;
    }
    if (Number(tabSelect.value) !== tab.id) {
      setStatus(
        `Scan discarded because the selected tab changed. Scan Tab ${tabSelect.value} again.`,
      );
      return;
    }

    const urls = results?.[0]?.result || [];

    if (!urls.length) {
      setStatus(
        "No .m3u8 playlists found. Start or resume the video " +
          "in the selected tab, wait a few seconds, and scan again.",
      );
      return;
    }

    setStatus(`${urls.length} playlist(s) found. Select one to play.`);

    for (const url of urls) {
      const button = document.createElement("button");

      button.className = "stream";
      button.textContent = url;
      button.dataset.playlistUrl = url;
      button.dataset.tabId = String(tab.id);
      button.title = `Playlist from Tab ${tab.id}; newest resource requests are listed first`;

      // Selects this discovered playlist and records which browser tab it belongs to.
      button.addEventListener("click", () => {
        if (selectedButton) {
          selectedButton.classList.remove("selected");
        }

        selectedButton = button;
        selectedPlaylistTabId = tab.id;
        button.classList.add("selected");
        setStatus(
          "Playlist selected for this tab. Use Analyze Selected HLS or WebM Recorder > Inject Player.",
        );
      });

      streamsEl.appendChild(button);
    }
  } catch (error) {
    setStatus(`Could not scan this tab: ${error.message || error}`);
  } finally {
    if (currentScan === scanId) {
      scanButton.disabled = false;
    }
  }
}

/** Requests host permission for the origin that serves a selected playlist or stream. */
async function ensureStreamPermission(urlString) {
  const url = new URL(urlString);

  const originPattern = `${url.protocol}//${url.host}/*`;

  const alreadyGranted = await chrome.permissions.contains({
    origins: [originPattern],
  });

  if (alreadyGranted) {
    return true;
  }

  return await chrome.permissions.request({
    origins: [originPattern],
  });
}

// Override console.log to capture logs in the extension
const originalConsoleLog = console.log;
const originalConsoleWarning = console.warn;
const originalConsoleError = console.error;

console.log = function (...args) {
  originalConsoleLog.apply(console, args);
  addLog("info", Array.from(args).join(" "));
};

console.warn = function (...args) {
  originalConsoleWarning.apply(console, args);
  addLog("warning", Array.from(args).join(" "));
};

console.error = function (...args) {
  originalConsoleError.apply(console, args);
  addLog("error", Array.from(args).join(" "));
};

// Refreshes the website-tab selector on demand.
refreshButton.addEventListener("click", refreshTabs);
// Starts scanning the currently selected website tab for HLS playlists.
scanButton.addEventListener("click", scanSelectedTab);
refreshTabs();

/*********** APPROACH 1 START */

const inspectPlayerButton = document.createElement("button");
inspectPlayerButton.className = "icon-button";
inspectPlayerButton.innerHTML =
  '<i class="fa-solid fa-magnifying-glass-chart" aria-hidden="true"></i> Inspect Site Player';
inspectPlayerButton.style.marginTop = "8px";
document.getElementById("advancedDiagnosticsActions")?.appendChild(inspectPlayerButton);

// Collects diagnostic information about the page’s existing video/player environment.
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
      // Executes a small, read-only diagnostic in the selected website page.
      func: () => {
        const videos = [...document.querySelectorAll("video")];

        return {
          pageUrl: location.origin,
          hlsGlobal: typeof window.Hls,
          hlsVersion: window.Hls?.version ?? null,
          cryptoGlobal: typeof window.cjs,
          apkIdAvailable: typeof window.apkId === "string",
          apkIdLength: typeof window.apkId === "string" ? window.apkId.length : null,
          base64Helper: typeof window.convertArrayToBase64,
          videos: videos.map((video, index) => ({
            index,
            src: video.currentSrc ? new URL(video.currentSrc, location.href).origin : null,
            paused: video.paused,
            readyState: video.readyState,
            hasMediaKeys: !!video.mediaKeys,
          })),
          scriptCount: document.scripts.length,
        };
      },
    });

    const info = results?.[0]?.result;
    const libraryInfo = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      // Executes a small, read-only diagnostic in the selected website page.
      func: () => {
        const H = window.Hls;
        const config = H?.DefaultConfig;

        return {
          constructorName: H?.name ?? null,
          isSupported: typeof H?.isSupported === "function" ? H.isSupported() : null,
          eventNames: H?.Events
            ? Object.keys(H.Events).filter((k) =>
                [
                  "ERROR",
                  "MANIFEST_PARSED",
                  "KEY_LOADING",
                  "KEY_LOADED",
                  "FRAG_PARSING_ERROR",
                ].includes(k),
              )
            : [],
          defaultLoader: config?.loader?.name ?? null,
          defaultFragmentLoader: config?.fLoader?.name ?? null,
          defaultPlaylistLoader: config?.pLoader?.name ?? null,
          scriptUrls: [...document.scripts]
            .map((s) => s.src)
            .filter(Boolean)
            .filter((src) => /hls|player|video/i.test(src))
            .slice(0, 30),
          videoCount: document.querySelectorAll("video").length,
        };
      },
    });

    addLog(
      "info",
      "HLS library details: " + JSON.stringify(libraryInfo?.[0]?.result ?? {}, null, 2),
    );

    if (!info) {
      throw new Error("The page returned no diagnostic results.");
    }

    addLog("info", "Site-player diagnostic results:");
    addLog("info", JSON.stringify(info, null, 2));

    const loaderCheck = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      // Executes a small, read-only diagnostic in the selected website page.
      func: () => {
        const H = window.Hls;
        const loaderSource = H?.DefaultConfig?.loader?.toString() ?? "";

        return {
          loaderName: H?.DefaultConfig?.loader?.name ?? null,
          loaderSourceLength: loaderSource.length,
          mentionsApkId: loaderSource.includes("apkId"),
          mentionsConvertArrayToBase64: loaderSource.includes("convertArrayToBase64"),
          mentionsKEY_LOADING: loaderSource.includes("KEY_LOADING"),
          configKeys: H?.DefaultConfig
            ? Object.keys(H.DefaultConfig).filter((k) => /loader|decrypt|worker/i.test(k))
            : [],
        };
      },
    });

    addLog(
      "info",
      "Custom loader check: " + JSON.stringify(loaderCheck?.[0]?.result ?? {}, null, 2),
    );

    setStatus("Inspection complete. Open the Logs tab and share the diagnostic results.");
  } catch (error) {
    setStatus(`Player inspection failed: ${error.message || error}`);
  } finally {
    inspectPlayerButton.disabled = false;
  }
});

/** Outcome: Not able to find the decoding logic in the existing file */
/*********** APPROACH 1 OVER */

/*********** APPROACH 2 START - create video player inside the website and play the video there */

const testCustomPlayerButton = injectButton;
testCustomPlayerButton.textContent = "Inject Player";

// Runs the temporary HLS diagnostic-player test and records detailed HLS events.
testCustomPlayerButton.addEventListener("click", async () => {
  const targetTabId = Number(tabSelect.value);
  const playlistUrl = selectedButton?.dataset?.playlistUrl || selectedButton?.textContent?.trim();

  if (
    !playlistUrl ||
    !isM3u8(playlistUrl) ||
    selectedPlaylistTabId !== targetTabId ||
    selectedButton?.dataset?.tabId !== String(targetTabId)
  ) {
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
      // Runs the HLS test in the website page’s main world so it can use the page’s Hls constructor.
      func: async (url) => {
        // Clean up a previous test instance, if any.
        window.__hlsSidePanelProbe?.hls?.destroy();
        window.__hlsSidePanelProbe?.video?.remove();

        const state = {
          events: [],
          fatalError: null,
          manifestParsed: false,
          keyLoaded: false,
          fragmentParsed: false,
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

        // Collect a broad, bounded HLS event history for diagnostics. Store only
        // event names and safe metadata; never read or clone media payload bytes.
        state.eventCounts = {};
        state.recentHlsEvents = [];
        state.availableEventConstants = Object.fromEntries(Object.entries(H.Events || {}));
        state.decryptionProbe = { eventSeen: false, byteLength: null, valueType: null };
        state.fragmentLoadProbe = { count: 0, last: null };
        state.parsingProbe = { count: 0, last: null };
        // Extracts only safe payload metadata for logs; it does not dump raw media bytes.
        const safePayloadMetadata = (value) => {
          try {
            if (value == null) return { byteLength: null, valueType: String(value) };
            let valueType = typeof value;
            try {
              valueType = value.constructor?.name ?? valueType;
            } catch (_) {}
            let byteLength = null;
            try {
              if (typeof value.byteLength === "number") byteLength = value.byteLength;
              else if (typeof value.length === "number") byteLength = value.length;
            } catch (error) {
              return { byteLength: null, valueType, accessError: String(error?.message || error) };
            }
            return { byteLength, valueType };
          } catch (error) {
            return {
              byteLength: null,
              valueType: "unavailable",
              accessError: String(error?.message || error),
            };
          }
        };
        const uniqueEvents = new Map();
        for (const [eventKey, eventName] of Object.entries(H.Events || {})) {
          if (typeof eventName === "string" && !uniqueEvents.has(eventName))
            uniqueEvents.set(eventName, eventKey);
        }
        for (const [eventName, eventKey] of uniqueEvents) {
          // Captures each selected HLS event with guarded metadata so diagnostics remain useful even for unusual payloads.
          hls.on(eventName, (_, data) => {
            state.eventCounts[eventKey] = (state.eventCounts[eventKey] || 0) + 1;
            const eventRecord = {
              name: eventKey,
              details: data?.details ?? null,
              fatal: data?.fatal ?? false,
            };
            state.recentHlsEvents.push(eventRecord);
            if (state.recentHlsEvents.length > 100) state.recentHlsEvents.shift();
            if (eventKey === "FRAG_LOADED") {
              const frag = data?.frag;
              // Reads the event payload defensively because some HLS versions expose unusual payload objects.
              const payload = (() => {
                try {
                  return data?.payload;
                } catch (error) {
                  return { __readError: String(error?.message || error) };
                }
              })();
              state.fragmentLoadProbe.count += 1;
              state.fragmentLoadProbe.last = {
                type: frag?.type || null,
                urlPresent: !!(frag?.url || frag?._url || frag?.relurl),
                fragKeys: (() => {
                  try {
                    return Object.keys(frag || {}).slice(0, 40);
                  } catch (_) {
                    return [];
                  }
                })(),
                dataKeys: (() => {
                  try {
                    return Object.keys(data || {});
                  } catch (_) {
                    return [];
                  }
                })(),
                payload: payload?.__readError
                  ? { byteLength: null, valueType: "unavailable", accessError: payload.__readError }
                  : safePayloadMetadata(payload),
              };
            }
            if (eventKey === "FRAG_PARSING_DATA") {
              state.parsingProbe.count += 1;
              state.parsingProbe.last = {
                type: data?.type || null,
                startPTS: data?.startPTS ?? null,
                endPTS: data?.endPTS ?? null,
              };
            }
            if (eventKey === "FRAG_DECRYPTED") {
              const payload = (() => {
                try {
                  return data?.payload;
                } catch (error) {
                  return { __readError: String(error?.message || error) };
                }
              })();
              state.decryptionProbe = payload?.__readError
                ? {
                    eventSeen: true,
                    byteLength: null,
                    valueType: "unavailable",
                    accessError: payload.__readError,
                  }
                : { eventSeen: true, ...safePayloadMetadata(payload) };
            }
          });
        }

        // Stores a compact HLS event summary and caps the event list to keep diagnostics bounded.
        const record = (name, data) => {
          state.events.push({
            name,
            details: data?.details ?? null,
            fatal: data?.fatal ?? false,
          });
          if (state.events.length > 30) state.events.shift();
        };

        // Records when HLS has parsed the playlist and is ready to choose media tracks.
        hls.on(H.Events.MANIFEST_PARSED, (_, data) => {
          state.manifestParsed = true;
          record("MANIFEST_PARSED", data);
        });

        // Records key-load success without logging the key bytes themselves.
        hls.on(H.Events.KEY_LOADED, (_, data) => {
          state.keyLoaded = true;
          record("KEY_LOADED", {
            details: `key length: ${data?.frag?.decryptdata?.key?.length ?? "unknown"}`,
          });
        });

        // Records when a media fragment has been parsed by the HLS pipeline.
        hls.on(H.Events.FRAG_PARSED, (_, data) => {
          state.fragmentParsed = true;
          record("FRAG_PARSED", data);
        });

        // Captures HLS errors and stores fatal errors in the diagnostic result.
        hls.on(H.Events.ERROR, (_, data) => {
          record("ERROR", data);
          if (data?.fatal) {
            state.fatalError = data.details || data.type || "Fatal HLS error";
          }
        });

        hls.loadSource(url);
        hls.attachMedia(video);

        // Give the test time to load the playlist, key and initial segments.
        await new Promise((resolve) => setTimeout(resolve, 12000));

        return {
          manifestParsed: state.manifestParsed,
          keyLoaded: state.keyLoaded,
          fragmentParsed: state.fragmentParsed,
          fatalError: state.fatalError,
          events: state.events,
          eventCounts: state.eventCounts,
          recentHlsEvents: state.recentHlsEvents,
          decryptionProbe: state.decryptionProbe,
          fragmentLoadProbe: state.fragmentLoadProbe,
          parsingProbe: state.parsingProbe,
          availableEventConstants: state.availableEventConstants,
          videoReadyState: video.readyState,
          videoError: video.error?.message ?? null,
        };
      },
    });

    const testResult = results?.[0]?.result ?? {};
    addLog("info", "Site HLS test: " + JSON.stringify(testResult, null, 2));

    if (testResult.manifestParsed && !testResult.fatalError && testResult.videoReadyState > 0) {
      setRecordingStatus(
        "Player injected. Press Play on this tab, then start recording. You can repeat this on other tabs.",
        "success",
      );
      await syncRecorderControls();
    } else {
      setRecordingStatus(
        "Player injection did not confirm readiness. Check Logs and the page player.",
        "error",
      );
      await syncRecorderControls();
    }

    setStatus(
      "Player injection finished for the selected tab. Select another tab to set up another recording.",
    );
  } catch (error) {
    setStatus(`Site HLS test failed: ${error.message || error}`);
  } finally {
    testCustomPlayerButton.disabled = false;
  }
});

/*********** APPROACH 2 OVER */

/****** Recording controls: sidebar-managed WebM recording */

// Handles manual tab selection and refreshes tab-specific playlist and recorder state.
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
// Reconciles recorder controls after a manual tab-list refresh.
refreshButton.addEventListener("click", () => {
  setTimeout(syncRecorderControls, 100);
});

// Keep the dropdown and recorder controls aligned with the browser tab the user
// has just switched to. Recording itself remains owned by each individual page.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  followActiveTab = true;
  refreshTabs(tabId)
    .then(() => syncRecorderControls())
    .catch((error) => {
      addLog("warning", `Could not follow active tab: ${error.message || error}`);
    });
});

// Refresh labels when a page title or URL changes, without changing the current
// selection. Include a removed-tab refresh so stale entries disappear promptly.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title || changeInfo.url) refreshTabs();
});
// Refreshes the selector after a browser tab is closed.
chrome.tabs.onRemoved.addListener(() => refreshTabs());

// Read the extension version from the manifest so the footer cannot drift from package metadata.
const versionEl = document.getElementById("extensionVersion");
if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

// Register the detailed, read-only playlist analysis module with live state accessors.
registerHlsAnalysis({
  getSelectedPlaylist: () =>
    selectedButton?.dataset?.playlistUrl || selectedButton?.textContent?.trim() || null,
  isM3u8,
  getSelectedTab,
  ensurePagePermission,
  ensureStreamPermission,
  addLog,
  setStatus,
});

// Read a safe snapshot of the currently injected page-player diagnostics. This
// never copies or constructs a view over media buffers, which may be detached.
const readLiveProbeButton = document.getElementById("readLiveProbe");
if (readLiveProbeButton) {
  // Reads the current diagnostic probe state from the selected page and adds it to the logs.
  readLiveProbeButton.addEventListener("click", async () => {
    readLiveProbeButton.disabled = true;
    try {
      const tab = await getSelectedTab();
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        // Executes a small, read-only diagnostic in the selected website page.
        func: () => {
          const probe = window.__hlsSidePanelProbe;
          if (!probe)
            return { exists: false, message: "No injected HLS player was found in this tab." };
          const state = probe.state || {};
          const video = probe.video;
          return {
            exists: true,
            pageUrl: location.href,
            manifestParsed: !!state.manifestParsed,
            keyLoaded: !!state.keyLoaded,
            fragmentParsed: !!state.fragmentParsed,
            fatalError: state.fatalError || null,
            availableEventConstants: state.availableEventConstants || {},
            eventCounts: state.eventCounts || {},
            recentHlsEvents: state.recentHlsEvents || state.events || [],
            decryptionProbe: state.decryptionProbe || {
              eventSeen: false,
              byteLength: null,
              valueType: null,
            },
            fragmentLoadProbe: state.fragmentLoadProbe || { count: 0, last: null },
            parsingProbe: state.parsingProbe || { count: 0, last: null },
            video: video
              ? {
                  currentTime: video.currentTime,
                  duration: Number.isFinite(video.duration) ? video.duration : null,
                  paused: video.paused,
                  readyState: video.readyState,
                  networkState: video.networkState,
                  error: video.error?.message || null,
                }
              : null,
          };
        },
      });
      const snapshot = result?.[0]?.result || { error: "No diagnostic result returned." };
      addLog("info", "Live HLS diagnostic probe: " + JSON.stringify(snapshot, null, 2));
      setStatus(
        snapshot.exists
          ? "Live probe captured. See Logs for the detailed HLS event dump and decryption probe."
          : snapshot.message,
      );
    } catch (error) {
      addLog("error", `Live probe failed: ${error?.message || error}`);
      setStatus(`Live probe failed: ${error?.message || error}`);
    } finally {
      readLiveProbeButton.disabled = false;
    }
  });
}

// Copy all retained log entries, including detailed diagnostic JSON snapshots.
const copyLogsButton = document.getElementById("copyLogs");
if (copyLogsButton) {
  // Copies the accumulated operation and diagnostic logs for troubleshooting.
  copyLogsButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(logger.toText());
      addLog("info", "All retained logs copied to clipboard.");
    } catch (error) {
      addLog("error", `Could not copy logs: ${error?.message || error}`);
    }
  });
}

/** Recording controls end */
