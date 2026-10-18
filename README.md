# Page HLS Side Panel v1.3

1. Add the browser build `hls.min.js` from https://github.com/video-dev/hls.js/releases beside `sidepanel.html`.
2. Open `chrome://extensions`, enable Developer mode, and click **Load unpacked**. Select this folder.
3. Open your logged-in website in a normal HTTP(S) tab.
4. Click the extension icon to open the side panel. Click **Grant page access & scan active tab**, then approve the site's permission prompt.
5. Start or resume the video and scan again if needed. Click a detected playlist to attempt playback.

This build requests optional host access only for the active website when the user clicks Scan. It separately requests permission for a selected stream host. Permissions do not bypass authentication, CORS, expiring URLs, or DRM. Some browser-internal pages cannot be inspected.
