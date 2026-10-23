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
