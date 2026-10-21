HLS Side Panel Pro 1.8.4 — WebM duration and seeking repair

WHAT CHANGED
- After each recording finishes, repair WebM metadata when possible: set Duration and append a Cues seek index built from video keyframe clusters. This is intended to make duration/progress seeking work in more media players without transcoding to MP4.
- Repair reads and shifts the file in bounded chunks; it does not load the entire multi-hour recording into memory. It may add a small amount of finalization time for large files.
- If the file structure is unsupported or safe repair cannot be completed, the original recording remains saved and the Logs show a warning. A repair failure does not mean the recording itself was lost.
- Fixed cross-tab selection races: the newest tab refresh wins, browser tab activation selects that tab, and manually choosing a dropdown tab remains stable until the next browser tab activation.
- Playlist scans are invalidated when the selected tab changes, playlist results are tagged with their owning tab ID, and recent playlist requests are listed first to reduce stale SPA playlist selection. Injection verifies that the playlist and target tab IDs match before creating the player.
- Fixed Inject/Remove player button state: Inject is disabled while a player exists, and Remove is enabled; after removal, the stale green ready message is cleared and Inject becomes available again.
- Player status polling now returns a valid no-player state after cleanup.
- Recordings now stream MediaRecorder's periodic WebM chunks to the file selected at recording start. The extension no longer accumulates the complete video in a page-memory array for this mode.
- Each tab has an independent session ID, file writer, byte count, and finalization path, so multiple tabs can record concurrently.
- The file is closed/finalized when the user stops recording or when the temporary video's `ended` event fires.
- Completion notification is sent after the side panel confirms that the file was finalized.
- Existing player injection, tab selection, and auto-stop behavior are retained.

INSTALL
1. Close the extension side panel.
2. Back up your current extension folder.
3. Replace sidepanel.html, sidepanel.js, background.js, and manifest.json with the files in this ZIP. The manifest version is now 1.8.3.
4. Keep your existing hls.min.js and icon.png in the same extension folder; those assets are not included.
5. Open chrome://extensions and click Reload for HLS Side Panel Pro.
6. Reopen the course tabs and extension side panel.

USE
1. Select the correct website tab, select its playlist, and click Inject Player.
2. Press Play on the temporary player.
3. Click Start Recording (Choose File) and choose the destination/name for that tab's WebM file.
4. Repeat in other tabs for simultaneous recordings; choose a separate file for each session.
5. Stop each recording manually, or let the video end. The file is finalized and a Chrome notification appears.

RECORDING REFRESH WARNING (NEW IN 1.8.3)
- When a recording starts, the extension installs a beforeunload handler in that tab's page context.
- If the user refreshes, closes the tab, or navigates away, Chrome may show its native leave-site confirmation. Chrome controls the dialog wording and whether it appears.
- The guard is removed when the recording stops or the video's ended event stops it, so ordinary navigation works again afterward.
- This is a warning, not an absolute lock: it cannot protect against crashes, force quit, browser termination, or every script/browser navigation path. Single-page-app route changes that do not unload the document may not trigger the prompt.

IMPORTANT LIMITATIONS
- Keep the extension side panel open throughout recording. This first direct-to-file version writes chunks through the open side panel; closing it can interrupt the writing pipeline and prevent proper finalization.
- Keep Chrome running and avoid reloading/navigating the temporary player tab during a recording.
- Requires a desktop Chromium browser with the File System Access API (`showSaveFilePicker`). If unsupported, the extension reports an error rather than silently falling back to memory-heavy recording.
- Chunk writes reduce memory use substantially, but they do not guarantee every three-hour session: disk space, browser stability, encoder behavior, site playback, and OS sleep still matter. Test with short sessions first, then a longer session before relying on unattended recording.
- WebM chunks are written sequentially as parts of one MediaRecorder session; they are not separate standalone WebM files.
- Chrome may show notifications according to the operating system's notification settings.
- This extension records playback from the temporary player using video.captureStream()/MediaRecorder. It does not bypass login or DRM.

WEBM METADATA REPAIR NOTES (NEW IN 1.8.4)
- Metadata repair runs after the file writer is closed, before completion is reported. It attempts to add Duration and Cues (keyframe seek index).
- This does not transcode the recording and does not change the WebM codecs. It is a container metadata repair, not MP4 conversion.
- The repair is designed for the WebM structure emitted by Chromium MediaRecorder. Unsupported structures are skipped with a warning in Logs.
- Test with a short recording first. Verify duration and seeking in your target media player before relying on the repair for long sessions. Different players may still have differing WebM support.
