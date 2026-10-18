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

        playStream(url);
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

    addLog(
      "info",
      "Site HLS test: " +
        JSON.stringify(results?.[0]?.result ?? {}, null, 2)
    );

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


/****** Approach 2 A - recording controls */

const startRecordingButton = document.createElement("button");
startRecordingButton.textContent = "Start Recording";
startRecordingButton.style.margin = "8px 4px";
startRecordingButton.style.padding = "8px";

const stopRecordingButton = document.createElement("button");
stopRecordingButton.textContent = "Stop Recording";
stopRecordingButton.style.margin = "8px 4px";
stopRecordingButton.style.padding = "8px";
stopRecordingButton.disabled = true;

tabContentStreams.append(startRecordingButton, stopRecordingButton);

async function controlPageRecording(action) {
  try {
    const tabId = Number(tabSelect.value);

    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new Error("Select the original website tab first.");
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [action],
      func: async (action) => {
        const probe = window.__hlsSidePanelProbe;
        const video = probe?.video;

        if (!video) {
          return {
            ok: false,
            message:
              "Test Site HLS Player has not created its video. Run that test first."
          };
        }

        if (action === "start") {
          if (probe.recording?.recorder?.state === "recording") {
            return { ok: false, message: "Recording is already running." };
          }

          if (typeof video.captureStream !== "function") {
            return {
              ok: false,
              message: "This browser does not support video.captureStream()."
            };
          }

          if (typeof MediaRecorder === "undefined") {
            return {
              ok: false,
              message: "MediaRecorder is not supported."
            };
          }

          const stream = video.captureStream();
          const tracks = stream.getTracks();

          if (!tracks.some(track => track.kind === "video")) {
            stream.getTracks().forEach(track => track.stop());
            return {
              ok: false,
              message: "No video track is available to record."
            };
          }

          const mimeTypes = [
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm"
          ];

          const mimeType = mimeTypes.find(type =>
            MediaRecorder.isTypeSupported(type)
          );

          if (!mimeType) {
            stream.getTracks().forEach(track => track.stop());
            return {
              ok: false,
              message: "No supported WebM recording format was found."
            };
          }

          const chunks = [];
          const recorder = new MediaRecorder(stream, { mimeType });

          recorder.ondataavailable = event => {
            if (event.data?.size > 0) chunks.push(event.data);
          };

          recorder.onerror = event => {
            console.error("Recording error:", event.error?.message);
          };

          recorder.onstop = () => {
            const blob = new Blob(chunks, { type: recorder.mimeType });
            const downloadUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");

            link.href = downloadUrl;
            link.download = `hls-recording-${Date.now()}.webm`;
            document.body.appendChild(link);
            link.click();
            link.remove();

            setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
            stream.getTracks().forEach(track => track.stop());
            probe.recording = null;

            console.info("Recording saved; bytes:", blob.size);
          };

          probe.recording = { recorder, chunks, stream };
          recorder.start(1000);

          return {
            ok: true,
            message: "Recording started.",
            audioTracks: tracks.filter(track => track.kind === "audio").length,
            videoTracks: tracks.filter(track => track.kind === "video").length
          };
        }

        const recording = probe.recording;

        if (!recording || recording.recorder.state !== "recording") {
          return { ok: false, message: "There is no active recording." };
        }

        recording.recorder.stop();

        return {
          ok: true,
          message: "Recording stopped. The browser should prepare the WebM download."
        };
      }
    });

    const result = results?.[0]?.result;

    if (!result?.ok) {
      throw new Error(result?.message || "The page recording failed.");
    }

    addLog("info", JSON.stringify(result));
    setStatus(result.message);
    return result;
  } catch (error) {
    setStatus(`Recording error: ${error.message}`);
    addLog("error", error.message);
    return null;
  }
}

startRecordingButton.addEventListener("click", async () => {
  const result = await controlPageRecording("start");

  if (result?.ok) {
    startRecordingButton.disabled = true;
    stopRecordingButton.disabled = false;
  }
});

stopRecordingButton.addEventListener("click", async () => {
  const result = await controlPageRecording("stop");

  if (result?.ok) {
    startRecordingButton.disabled = false;
    stopRecordingButton.disabled = true;
  }
});

/** Approach 2 A - OVER */