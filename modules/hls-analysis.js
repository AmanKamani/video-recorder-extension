/**
 * Read-only HLS analysis UI.
 * Dependencies are injected by the side-panel coordinator to keep tab/permission
 * state owned by the main application and make this module independently testable.
 */
export function registerHlsAnalysis({
  getSelectedPlaylist,
  isM3u8,
  getSelectedTab,
  ensurePagePermission,
  ensureStreamPermission,
  addLog,
  setStatus,
}) {
  /******** Direct-download feasibility analysis (read-only diagnostics) ********/
  const analyzeHlsButton = document.getElementById("analyzeHls");
  const hlsAnalysisStatus = document.getElementById("hlsAnalysisStatus");
  const hlsAnalysisDetails = document.getElementById("hlsAnalysisDetails");

  /** Updates the analysis status message and its visual state. */
  function setHlsAnalysisStatus(message, state = "idle") {
    if (!hlsAnalysisStatus) return;
    hlsAnalysisStatus.textContent = message;
    hlsAnalysisStatus.dataset.state = state;
  }

  /** Formats a value as readable JSON and falls back to a string if serialization fails. */
  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  if (analyzeHlsButton) {
    // Runs the read-only HLS analysis when the user clicks Analyze Selected HLS.
    analyzeHlsButton.addEventListener("click", async () => {
      const playlistUrl = getSelectedPlaylist();
      if (!playlistUrl || !isM3u8(playlistUrl)) {
        setHlsAnalysisStatus("Scan the page and select an HLS playlist first.", "error");
        return;
      }

      analyzeHlsButton.disabled = true;
      setHlsAnalysisStatus("Inspecting playlists from the extension context...", "working");
      hlsAnalysisDetails.hidden = true;
      hlsAnalysisDetails.textContent = "";

      try {
        const tab = await getSelectedTab();
        if (!(await ensurePagePermission(tab)))
          throw new Error("Website permission was not granted.");
        if (!(await ensureStreamPermission(playlistUrl)))
          throw new Error("Stream-host permission was not granted.");

        // Fetch from the extension page, not the website's MAIN world. Host permissions
        // can authorize cross-origin requests that page-world fetch rejects with CORS.
        // Removes query strings and fragments before displaying URLs so signed tokens are not exposed in logs.
        const sanitizeUrl = (value) => {
          try {
            const u = new URL(value);
            return `${u.origin}${u.pathname}`;
          } catch {
            return String(value).split("?")[0].split("#")[0];
          }
        };
        // Fetches playlist text from the extension context using the granted host permission.
        const fetchText = async (url) => {
          const response = await fetch(url, { credentials: "include", cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${sanitizeUrl(url)}`);
          return {
            text: await response.text(),
            status: response.status,
            contentType: response.headers.get("content-type") || "",
          };
        };
        // Parses key/value attributes from an HLS tag such as EXT-X-STREAM-INF or EXT-X-KEY.
        const parseAttrs = (line) => {
          const result = {};
          const raw = line.slice(line.indexOf(":") + 1);
          const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
          let m;
          while ((m = regex.exec(raw))) {
            let value = m[2].trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            result[m[1]] = value;
          }
          return result;
        };
        // Converts an HLS playlist into structured metadata about variants, renditions, segments, and encryption.
        const parsePlaylist = (url, text, meta) => {
          const lines = text
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean);
          const variants = [],
            renditions = [],
            segments = [];
          let pendingVariant = null,
            currentKey = null,
            initMap = null;
          let totalDuration = 0,
            targetDuration = null,
            mediaSequence = null;
          for (const line of lines) {
            if (line.startsWith("#EXT-X-STREAM-INF:")) pendingVariant = parseAttrs(line);
            else if (line.startsWith("#EXT-X-MEDIA:")) {
              const a = parseAttrs(line);
              renditions.push({
                type: a.TYPE || null,
                groupId: a["GROUP-ID"] || null,
                name: a.NAME || null,
                language: a.LANGUAGE || null,
                default: a.DEFAULT || null,
                uri: a.URI ? new URL(a.URI, url).href : null,
              });
            } else if (line.startsWith("#EXT-X-KEY:")) {
              const a = parseAttrs(line);
              currentKey = {
                method: a.METHOD || null,
                keyFormat: a.KEYFORMAT || "identity",
                keyUri: a.URI ? new URL(a.URI, url).href : null,
                hasExplicitIv: !!a.IV,
              };
            } else if (line.startsWith("#EXT-X-MAP:")) {
              const a = parseAttrs(line);
              initMap = a.URI ? new URL(a.URI, url).href : null;
            } else if (line.startsWith("#EXT-X-TARGETDURATION:"))
              targetDuration = Number(line.split(":")[1]) || null;
            else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:"))
              mediaSequence = Number(line.split(":")[1]) || 0;
            else if (line.startsWith("#EXTINF:")) {
              const duration = Number(line.slice(8).split(",")[0]) || 0;
              segments.push({ duration, uri: null, key: currentKey });
              totalDuration += duration;
            } else if (!line.startsWith("#") && pendingVariant) {
              variants.push({
                bandwidth: Number(pendingVariant.BANDWIDTH) || null,
                averageBandwidth: Number(pendingVariant["AVERAGE-BANDWIDTH"]) || null,
                resolution: pendingVariant.RESOLUTION || null,
                codecs: pendingVariant.CODECS || null,
                audioGroup: pendingVariant.AUDIO || null,
                uri: new URL(line, url).href,
              });
              pendingVariant = null;
            } else if (
              !line.startsWith("#") &&
              segments.length &&
              !segments[segments.length - 1].uri
            ) {
              segments[segments.length - 1].uri = new URL(line, url).href;
            }
          }
          const extensions = {};
          for (const seg of segments) {
            if (!seg.uri) continue;
            let ext = "(no extension)";
            try {
              const path = new URL(seg.uri).pathname;
              if (path.includes(".")) ext = path.slice(path.lastIndexOf(".")).toLowerCase();
            } catch {}
            extensions[ext] = (extensions[ext] || 0) + 1;
          }
          return {
            url: sanitizeUrl(url),
            httpStatus: meta.status,
            contentType: meta.contentType,
            playlistType: variants.length ? "master" : "media",
            targetDuration,
            mediaSequence,
            variantCount: variants.length,
            variants: variants
              .map((v) => ({ ...v, uri: sanitizeUrl(v.uri) }))
              .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)),
            renditions: renditions.map((r) => ({ ...r, uri: r.uri ? sanitizeUrl(r.uri) : null })),
            segmentCount: segments.filter((x) => x.uri).length,
            totalDurationSeconds: Math.round(totalDuration * 1000) / 1000,
            segmentExtensions: extensions,
            hasInitMap: !!initMap,
            initMapUri: initMap ? sanitizeUrl(initMap) : null,
            encryption: currentKey
              ? {
                  method: currentKey.method,
                  keyFormat: currentKey.keyFormat,
                  keyUri: currentKey.keyUri ? sanitizeUrl(currentKey.keyUri) : null,
                  hasExplicitIv: currentKey.hasExplicitIv,
                }
              : { method: "none detected" },
            _variants: variants,
            _segments: segments,
            _key: currentKey,
          };
        };
        const report = {
          selectedPlaylist: sanitizeUrl(playlistUrl),
          note: "Metadata only. Key bytes, cookies, and signed query parameters are not included.",
          playlists: [],
        };
        const masterMeta = await fetchText(playlistUrl);
        const master = parsePlaylist(playlistUrl, masterMeta.text, masterMeta);
        report.playlists.push(master);
        const toInspect = [];
        if (master.playlistType === "master" && master._variants.length) {
          const variant = [...master._variants].sort(
            (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0),
          )[0];
          const variantMeta = await fetchText(variant.uri);
          const video = parsePlaylist(variant.uri, variantMeta.text, variantMeta);
          video.selectedVariant = {
            bandwidth: variant.bandwidth,
            resolution: variant.resolution,
            codecs: variant.codecs,
          };
          report.playlists.push(video);
          toInspect.push(video);
          const audio = master.renditions.find(
            (r) =>
              r.type === "AUDIO" &&
              r.uri &&
              (!variant.audioGroup || r.groupId === variant.audioGroup),
          );
          if (audio) {
            const audioMeta = await fetchText(audio.uri);
            const audioPlaylist = parsePlaylist(audio.uri, audioMeta.text, audioMeta);
            audioPlaylist.trackType = "audio";
            report.playlists.push(audioPlaylist);
            toInspect.push(audioPlaylist);
          }
        } else toInspect.push(master);

        for (const playlist of toInspect) {
          const seg = playlist._segments.find((s) => s.uri);
          if (seg) {
            try {
              const response = await fetch(seg.uri, { credentials: "include", cache: "no-store" });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const sample = new Uint8Array(await response.arrayBuffer()).slice(0, 512);
              playlist.firstSegmentProbe = {
                httpStatus: response.status,
                contentType: response.headers.get("content-type") || "",
                sampleBytesRead: sample.length,
                tsSyncPatternDetected: [0, 188, 376].every(
                  (o) => sample.length > o && sample[o] === 0x47,
                ),
                firstBytesAscii: Array.from(sample.slice(0, 12))
                  .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
                  .join("."),
                url: sanitizeUrl(seg.uri),
                note: "Encrypted media may not reveal its container signature.",
              };
            } catch (e) {
              playlist.firstSegmentProbe = { error: String(e?.message || e) };
            }
          }
          if (playlist._key?.keyUri) {
            try {
              const response = await fetch(playlist._key.keyUri, {
                credentials: "include",
                cache: "no-store",
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const buffer = await response.arrayBuffer();
              playlist.keyResponseProbe = {
                httpStatus: response.status,
                contentType: response.headers.get("content-type") || "",
                bytesObserved: buffer.byteLength,
                expectedRawAes128KeyBytes: 16,
                appearsWrappedOrCustom: buffer.byteLength > 0 && buffer.byteLength !== 16,
              };
            } catch (e) {
              playlist.keyResponseProbe = { error: String(e?.message || e) };
            }
          }
        }
        for (const playlist of report.playlists) {
          delete playlist._variants;
          delete playlist._segments;
          delete playlist._key;
        }
        hlsAnalysisDetails.textContent = safeJson(report);
        hlsAnalysisDetails.hidden = false;
        addLog("info", "Direct HLS analysis: " + safeJson(report));
        const media = report.playlists.filter((p) => p.playlistType === "media");
        const segments = media.reduce((sum, p) => sum + (p.segmentCount || 0), 0);
        setHlsAnalysisStatus(
          `Analysis complete: ${media.length} media playlist(s), ${segments} segment(s) across tracks.`,
          "success",
        );
        setStatus("HLS analysis complete. Review Direct Download Analysis and Logs.");
      } catch (error) {
        const message = error?.message || String(error);
        setHlsAnalysisStatus(`Analysis failed: ${message}`, "error");
        addLog("error", `Direct HLS analysis failed: ${message}`);
      } finally {
        analyzeHlsButton.disabled = false;
      }
    });
  }
}
