/** Converts a page-bridge segmented message into its side-panel relay form. */
export function toSegmentPanelMessage(message) {
  if (message?.type === "HLS_SIDEPANEL_SEGMENT_CHUNK") {
    return {
      type: "HLS_SIDEPANEL_SEGMENT_CHUNK_PANEL",
      jobId: message.jobId,
      segmentId: message.segmentId,
      sequence: message.sequence,
      base64: message.base64,
    };
  }
  if (message?.type === "HLS_SIDEPANEL_SEGMENT_EVENT") {
    return {
      type: "HLS_SIDEPANEL_SEGMENT_EVENT_PANEL",
      eventType: message.eventType,
      jobId: message.jobId,
      segmentId: message.segmentId,
      detail: message.detail || {},
    };
  }
  return null;
}
