// Initializes extension behavior when Chrome installs or updates the extension.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Handles messages from the recorder bridge, including recording completion and user notifications.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "HLS_SIDEPANEL_RECORDING_CHUNK") {
    chrome.runtime
      .sendMessage({
        type: "HLS_SIDEPANEL_RECORDING_CHUNK_PANEL",
        sessionId: message.sessionId,
        sequence: message.sequence,
        base64: message.base64,
      })
      .then((response) => {
        sendResponse(
          response || {
            ok: false,
            message: "The recorder side panel did not acknowledge the chunk.",
          },
        );
      })
      .catch((error) =>
        sendResponse({
          ok: false,
          message: error?.message || "Could not reach the recorder side panel.",
        }),
      );
    return true;
  }

  if (message?.type !== "HLS_SIDEPANEL_RECORDING_FINISHED") return;
  const detail = message.detail || {};

  // Queries the page for the final recording result and notifies the user when the file is ready.
  const finishAndNotify = async () => {
    let finalDetail = detail;
    if (detail.sessionId) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "HLS_SIDEPANEL_RECORDING_FINISHED_PANEL",
          detail,
        });
        if (response?.detail) finalDetail = response.detail;
      } catch (error) {
        finalDetail = {
          ...detail,
          ok: false,
          message: "The recording side panel closed before the file could be finalized.",
        };
      }
    }

    const tabTitle = finalDetail.pageTitle || sender.tab?.title || "Website tab";
    const ended = finalDetail.reason === "ended";
    const savedDirectly = finalDetail.savedToFile === true;
    const title =
      finalDetail.ok === false
        ? "WebM recording issue"
        : ended
          ? "Video ended — recording saved"
          : "WebM recording saved";
    const messageText =
      finalDetail.ok === false
        ? finalDetail.message || "The recording could not be saved."
        : `${tabTitle}: ${finalDetail.filename || "WebM recording"}${savedDirectly ? " saved successfully" : " download started"}`;
    chrome.notifications
      .create(`hls-recording-${sender.tab?.id || "tab"}-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title,
        message: messageText,
        priority: 1,
      })
      .catch((error) => console.warn("Could not show recording notification:", error));
    sendResponse({ ok: finalDetail.ok !== false, detail: finalDetail });
  };

  finishAndNotify().catch((error) => {
    console.error("Could not finalize recording notification:", error);
    sendResponse({ ok: false, message: error?.message || String(error) });
  });
  return true;
});
