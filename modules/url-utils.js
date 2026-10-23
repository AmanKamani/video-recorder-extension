/** Shared URL validators used by scanning, playlist analysis, and tab selection. */
export function isHttpUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

/** Identifies likely HLS playlist URLs, including playlist URLs with query parameters. */
export function isM3u8(value) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}
