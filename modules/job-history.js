import { SEGMENT_CONFIG } from "./config.js";

const STORAGE_KEY = "hlsSegmentJobHistoryV1";
const VERSION = 1;
const OMIT_KEYS = /^(playlistUrl|cookie|cookies|key|keys|media|blob|base64)$/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/** Removes query parameters and fragments from one URL-like value. */
function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value).split("?")[0].split("#")[0];
  }
}

/** Sanitizes any embedded absolute URLs in a string. */
function sanitizeString(value) {
  return value.replace(URL_PATTERN, (match) => sanitizeUrl(match));
}

/** Recursively removes sensitive or binary values from persisted data. */
function sanitizeValue(value, key = "") {
  // Key filtering happens before recursion so credential containers are omitted whole.
  if (OMIT_KEYS.test(key)) return undefined;
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return /url$/i.test(key) ? sanitizeUrl(value) : sanitizeString(value);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    // Rebuild objects so sanitization never mutates the caller's live summary.
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)])
        .filter(([, childValue]) => childValue !== undefined),
    );
  }
  return String(value);
}

/** Removes stream credentials and binary values before a job summary is persisted. */
export function sanitizeJobSummary(summary) {
  return sanitizeValue(summary);
}

/** Creates bounded, versioned job-history persistence around chrome.storage.local. */
export function createJobHistory({
  storageArea = chrome.storage.local,
  limit = SEGMENT_CONFIG.retainedJobHistory,
} = {}) {
  /** Reads a valid history document or returns an empty current-version document. */
  async function readDocument() {
    try {
      const stored = (await storageArea.get(STORAGE_KEY))?.[STORAGE_KEY];
      if (stored?.version !== VERSION || !Array.isArray(stored.entries)) {
        return { version: VERSION, entries: [] };
      }
      return stored;
    } catch {
      return { version: VERSION, entries: [] };
    }
  }

  return {
    /** Lists stored history entries in newest-first order. */
    async list() {
      return (await readDocument()).entries;
    },
    /** Sanitizes and prepends one bounded history entry. */
    async append(summary) {
      const document = await readDocument();
      const entry = sanitizeJobSummary({
        ...summary,
        recordedAt: summary.recordedAt || Date.now(),
      });
      document.entries = [entry, ...document.entries].slice(0, limit);
      await storageArea.set({ [STORAGE_KEY]: document });
      return entry;
    },
    /** Replaces persisted history with an empty current-version document. */
    async clear() {
      await storageArea.set({ [STORAGE_KEY]: { version: VERSION, entries: [] } });
    },
  };
}
