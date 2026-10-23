HLS Side Panel Pro v1.9.0 — UI and module refactor

WHAT CHANGED
- Added locally bundled Font Awesome Free 6.7.2 icons (no CDN or runtime network dependency).
- Split recording control, logging, URL validation, WebM repair, and HLS analysis into focused ES modules under modules/.
- Added code comments around tab isolation, scan cancellation, recording bridges, and finalization.
- Added extension version in the side-panel footer, sourced from the manifest.
- Added Copy all logs, Clear logs, and Advanced Diagnostics controls.
- The Advanced Diagnostics section keeps player inspection, detailed HLS event counts/history, fragment metadata probes, and FRAG_DECRYPTED payload metadata.
- Removed the unused embedded side-panel preview player. The HLS player remains injected into the selected website tab.
- Preserved the recording and WebM repair flow from v1.8.4.

MODULE LAYOUT
- sidepanel.js: app startup, tab selection, player injection, diagnostics UI wiring.
- modules/recorder.js: per-tab recording sessions, incremental file writes, auto-stop, refresh guard coordination, and recording UI.
- modules/webm-repair.js: bounded-memory WebM duration/cue repair.
- modules/hls-analysis.js: read-only playlist/track/key-response analysis.
- modules/logger.js: structured logs, bounded visible history, and export/copy text.
- modules/url-utils.js: shared URL validation helpers.

INSTALL
1. Back up the current extension folder.
2. Extract this ZIP.
3. Replace sidepanel.html, sidepanel.js, background.js, and manifest.json with the supplied files.
4. Copy the modules/ and assets/ directories into the same extension folder, preserving their folder structure.
5. Keep any existing icon.png and other site-specific files you use; they are not included in this update.
6. Open chrome://extensions and click Reload for HLS Side Panel Pro.

NOTES
- This package intentionally uses local Font Awesome assets due to Chrome extension CSP restrictions on remote assets.
- Font Awesome Free license: icons CC BY 4.0, fonts SIL OFL 1.1, code MIT. See assets/fontawesome/LICENSE.txt.
- Validate with short recordings first. Syntax and manifest validation do not replace an end-to-end Chrome test against the course site.
