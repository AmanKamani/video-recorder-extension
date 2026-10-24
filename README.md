# HLS Side Panel Pro — v1.9.0

This extension uses native JavaScript ES modules and Manifest V3.

## Module structure

- `sidepanel.html` loads `sidepanel.js` as a module (`type="module"`).
- `sidepanel.js` imports the feature modules under `modules/`.
- `background.js` runs as a Manifest V3 ES-module service worker.
- Shared helpers and feature modules use native `import` / `export`; no transpilation or bundler is required for the current code.

## Load the extension

1. Extract this ZIP to a folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted `video-recorder-extension` folder.
4. Open the authorized website in a regular HTTP(S) tab.
5. Open the extension side panel and use **Grant page access & scan active tab** when you want to scan the selected tab. Approve the host permission if Chrome asks.

## Parallel segmented recording

For a finite VOD stream, select a value up to the configured maximum with the **Recording
segments** slider after selecting a playlist, then click the checkmark Apply icon. The
extension creates that many website players, divides the full timeline evenly, and displays
each segment's start, end, duration, progress, and state. The website player box can be
dragged or minimized. **Start All Segments** starts every player and recorder in parallel,
and the recorder timer shows wall-clock time until the last segment finishes.

Each segment is written to temporary browser storage. The extension waits for every segment,
merges them in timeline order into the chosen WebM file, repairs duration and seek metadata,
and then sends one completion notification. A failed or incompatible segment keeps successful
temporary files intact and shows a refresh icon for re-recording only that range. A transient
merge failure can be retried without recording the segments again. No partial recording is
published. Sanitized job failures are retained in extension storage and copied into the Logs
view on the next side-panel session.

Equivalent WebM audio/video tracks are matched by codec configuration during merging. If
independent MediaRecorder instances assign different track numbers, block references are
remapped automatically and each segment's allocation is reported in the Logs view.

Segmented mode supports finite VOD streams only. Running several players increases network,
CPU, and encoder usage. Background playback is best-effort because Chrome may throttle hidden
tabs; stalled segments can be retried individually after the other ranges finish. Keep the side
panel open until merging and metadata repair finish. Different user-opened website tabs can run
independent segmented jobs.

Apply **Recording segments** value 1 to use the original single-player recording workflow.

## Development checks

Node.js is required for the syntax check. Run:

```sh
npm test
```

To format supported source files, run the repository's configured Prettier workflow. Avoid formatting minified vendor bundles such as `hls.min.js`.

## Notes

- The extension version intentionally remains **1.9.0** during testing.
- Optional host access is requested for user-initiated actions. Permissions do not bypass authentication, CORS, expiring URLs, or DRM.
- Syntax checks do not replace runtime testing in Chrome.
