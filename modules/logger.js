import { SEGMENT_CONFIG } from "./config.js";

/**
 * Session logger for the side panel.
 * Keeps structured entries for copying, renders a bounded visual history, and
 * uses textContent rather than HTML interpolation so diagnostic text is safe.
 */
export function createLogger({
  logsArea,
  visibleLimit = SEGMENT_CONFIG.visibleLogEntries,
  retainedLimit = SEGMENT_CONFIG.retainedLogEntries,
} = {}) {
  const entries = [];

  /** Adds a timestamped entry to the in-memory log and displays it in the bounded log panel. */
  function add(level = "info", message = "") {
    const timestamp = new Date().toLocaleTimeString();
    const text = typeof message === "string" ? message : String(message);
    entries.push({ level, message: text, timestamp });
    if (entries.length > retainedLimit) entries.splice(0, entries.length - retainedLimit);

    if (!logsArea) return;
    const entry = document.createElement("div");
    entry.className = `log-entry level-${level}`;
    const time = document.createElement("span");
    time.className = "timestamp";
    time.textContent = `[${timestamp}]`;
    entry.append(time, document.createTextNode(` ${text}`));
    logsArea.insertBefore(entry, logsArea.firstChild);
    while (logsArea.children.length > visibleLimit) logsArea.removeChild(logsArea.lastChild);
  }

  /** Clears both the in-memory log history and the visible log panel. */
  function clear() {
    entries.length = 0;
    if (logsArea) logsArea.replaceChildren();
  }

  /** Serializes the complete in-memory log history into copyable plain text. */
  function toText() {
    return entries
      .map((item) => `[${item.timestamp}] [${item.level.toUpperCase()}] ${item.message}`)
      .join("\n");
  }

  return { add, clear, toText, getEntries: () => entries.slice() };
}
