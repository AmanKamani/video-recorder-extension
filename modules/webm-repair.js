/**
 * WebM container repair utilities.
 * Adds duration metadata and seek cues after MediaRecorder has finished writing.
 * All file reads are bounded; this module does not load the entire video into RAM.
 */
import { SEGMENT_CONFIG } from "./config.js";
import {
  WebmBlobReader,
  webmConcat,
  webmElement,
  webmEncodeSize,
  webmEncodeUint,
  webmReadElement,
  webmReadUint,
  webmReadVint,
} from "./webm-ebml.js";

const WEBM_REPAIR_COPY_CHUNK = SEGMENT_CONFIG.webmCopyChunkBytes;

/** Builds the WebM Duration element for the supplied duration in timecode ticks. */
function webmMakeDurationElement(durationTicks) {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, durationTicks, false);
  return webmElement("4489", payload);
}

/** Builds a WebM Cues index from the supplied seek points. */
function webmMakeCues(cues) {
  const points = [];
  for (const cue of cues) {
    const cueTime = webmElement("B3", webmEncodeUint(Math.max(0, Math.round(cue.time))));
    const cueTrack = webmElement("F7", webmEncodeUint(cue.track));
    const cuePosition = webmElement("F1", webmEncodeUint(cue.position));
    const trackPositions = webmElement("B7", webmConcat([cueTrack, cuePosition]));
    points.push(webmElement("BB", webmConcat([cueTime, trackPositions])));
  }
  return webmElement("1C53BB6B", webmConcat(points));
}

/** Finds a direct child element with the requested EBML ID. */
async function webmFindChild(reader, parent, wantedId) {
  let offset = parent.dataStart;
  while (offset < parent.end) {
    const child = await webmReadElement(reader, offset, parent.end);
    if (child.id === wantedId) return child;
    if (child.end <= offset) throw new Error("Invalid EBML child traversal.");
    offset = child.end;
  }
  return null;
}

/** Adds or updates duration metadata and creates seek cues when safe, preserving the original file if repair cannot proceed. */
async function repairWebmFile(fileHandle, durationMs, log = () => {}) {
  const originalFile = await fileHandle.getFile();
  if (!originalFile.size) return { ok: false, message: "The WebM file is empty." };
  const reader = new WebmBlobReader(originalFile);
  let offset = 0,
    segment = null,
    info = null,
    tracks = null,
    existingCues = null;
  while (offset < originalFile.size) {
    const element = await webmReadElement(reader, offset, originalFile.size);
    if (element.id === 0x18538067n) {
      segment = element;
      break;
    }
    if (element.end <= offset) throw new Error("Could not locate the WebM Segment.");
    offset = element.end;
  }
  if (!segment)
    return { ok: false, message: "No WebM Segment was found; original file was left unchanged." };
  if (!segment.unknownSize && segment.end !== originalFile.size) {
    return {
      ok: false,
      message:
        "This WebM has data after its finite Segment; repair was skipped to avoid changing file structure.",
    };
  }
  let childOffset = segment.dataStart;
  while (childOffset < segment.end) {
    const element = await webmReadElement(reader, childOffset, segment.end);
    if (element.id === 0x1549a966n) info = element;
    else if (element.id === 0x1654ae6bn) tracks = element;
    else if (element.id === 0x1c53bb6bn) existingCues = element;
    if (element.end <= childOffset) throw new Error("Invalid WebM Segment structure.");
    childOffset = element.end;
  }
  if (!info)
    return {
      ok: false,
      message: "WebM Info metadata was not found; original file was left unchanged.",
    };

  const infoChildren = [];
  childOffset = info.dataStart;
  let timecodeScale = 1000000n,
    durationElement = null;
  while (childOffset < info.end) {
    const element = await webmReadElement(reader, childOffset, info.end);
    if (element.id === 0x2ad7b1n) timecodeScale = await webmReadUint(reader, element);
    if (element.id === 0x4489n) durationElement = element;
    infoChildren.push(element);
    childOffset = element.end;
  }
  const durationTicks = Math.max(
    0,
    (Number(durationMs) * 1000000) / Number(timecodeScale || 1000000n),
  );
  let infoReplacement = null;
  let insertionDelta = 0;
  if (durationElement) {
    // Preserve the existing Info layout when Duration can be updated in place.
    const size = durationElement.end - durationElement.dataStart;
    if (size !== 4 && size !== 8)
      return {
        ok: false,
        message: "Unsupported existing WebM Duration encoding; original file was left unchanged.",
      };
    const durationPayload = new Uint8Array(size);
    const view = new DataView(durationPayload.buffer);
    if (size === 8) view.setFloat64(0, durationTicks, false);
    else view.setFloat32(0, durationTicks, false);
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(durationElement.dataStart);
      await writable.write(durationPayload);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort();
      } catch (_) {}
      throw error;
    }
  } else {
    if (existingCues)
      return {
        ok: false,
        message:
          "This WebM already contains Cues but has no Duration. Repair was skipped to avoid invalidating its existing seek index.",
      };
    const oldInfoBytes = new Uint8Array(
      await originalFile.slice(info.offset, info.end).arrayBuffer(),
    );
    const idBytes = oldInfoBytes.slice(0, info.idLength);
    const oldSizeHeaderLength = info.sizeLength;
    const payload = oldInfoBytes.slice(info.idLength + oldSizeHeaderLength);
    const newPayload = webmConcat([payload, webmMakeDurationElement(durationTicks)]);
    const newSize = webmEncodeSize(newPayload.length);
    const newInfoBytes = webmConcat([idBytes, newSize, newPayload]);
    // Growing Info shifts every following Cluster, so cue positions include this delta.
    infoReplacement = newInfoBytes;
    insertionDelta = newInfoBytes.length - oldInfoBytes.length;
  }

  const cues = [];
  if (!existingCues) {
    let videoTrack = 1;
    if (tracks) {
      let trackOffset = tracks.dataStart;
      while (trackOffset < tracks.end) {
        const trackEntry = await webmReadElement(reader, trackOffset, tracks.end);
        if (trackEntry.id === 0xaen) {
          let trackNumber = null,
            trackType = null,
            subOffset = trackEntry.dataStart;
          while (subOffset < trackEntry.end) {
            const sub = await webmReadElement(reader, subOffset, trackEntry.end);
            if (sub.id === 0xd7n) trackNumber = Number(await webmReadUint(reader, sub));
            if (sub.id === 0x83n) trackType = Number(await webmReadUint(reader, sub));
            subOffset = sub.end;
          }
          if (trackType === 1 && trackNumber) {
            videoTrack = trackNumber;
            break;
          }
        }
        trackOffset = trackEntry.end;
      }
    }

    childOffset = segment.dataStart;
    // Build one seek point per Cluster from its first keyframe on the selected video track.
    while (childOffset < segment.end) {
      const element = await webmReadElement(reader, childOffset, segment.end);
      if (element.id === 0x1f43b675n) {
        let clusterTime = 0,
          firstKeyframe = null,
          inner = element.dataStart;
        while (inner < element.end) {
          const sub = await webmReadElement(reader, inner, element.end);
          if (sub.id === 0xe7n) clusterTime = Number(await webmReadUint(reader, sub));
          else if (sub.id === 0xa3n && !firstKeyframe) {
            const trackVint = await webmReadVint(reader, sub.dataStart, false);
            const flagOffset = sub.dataStart + trackVint.length + 2;
            if (flagOffset < sub.end) {
              const blockHead = await reader.bytes(flagOffset, 1);
              if (Number(trackVint.value) === videoTrack && blockHead[0] & 0x80) {
                const relativeBytes = await reader.bytes(sub.dataStart + trackVint.length, 2);
                let relative = (relativeBytes[0] << 8) | relativeBytes[1];
                if (relative & 0x8000) relative -= 0x10000;
                firstKeyframe = Math.max(0, clusterTime + relative);
              }
            }
          }
          if (sub.end <= inner) throw new Error("Invalid WebM Cluster structure.");
          inner = sub.end;
        }
        if (firstKeyframe !== null) {
          cues.push({
            time: firstKeyframe,
            track: videoTrack,
            position: element.offset - segment.dataStart + insertionDelta,
          });
        }
      }
      if (element.end <= childOffset) throw new Error("Invalid WebM Segment traversal.");
      childOffset = element.end;
    }
    if (!cues.length)
      return {
        ok: false,
        message: "No video keyframe clusters were found. The original file was left unchanged.",
      };
  }

  const cuesBytes = existingCues ? new Uint8Array(0) : webmMakeCues(cues);
  const finalSize = originalFile.size + insertionDelta + cuesBytes.length;
  const newSegmentSize = segment.unknownSize
    ? null
    : segment.sizeValue + BigInt(insertionDelta + cuesBytes.length);
  let segmentSizeBytes = null;
  if (newSegmentSize !== null)
    segmentSizeBytes = webmEncodeSize(newSegmentSize, segment.sizeLength);

  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    if (infoReplacement) {
      await writable.truncate(finalSize);
      // Copy backward in bounded chunks so the inserted metadata cannot overwrite unread bytes.
      let cursor = originalFile.size;
      while (cursor > info.end) {
        const start = Math.max(info.end, cursor - WEBM_REPAIR_COPY_CHUNK);
        const bytes = new Uint8Array(await originalFile.slice(start, cursor).arrayBuffer());
        await writable.seek(start + insertionDelta);
        await writable.write(bytes);
        cursor = start;
      }
      await writable.seek(info.offset);
      await writable.write(infoReplacement);
    } else {
      await writable.truncate(finalSize);
    }
    if (segmentSizeBytes) {
      // Finite Segments must account for both the expanded Info element and appended Cues.
      await writable.seek(segment.sizeOffset);
      await writable.write(segmentSizeBytes);
    }
    if (cuesBytes.length) {
      await writable.seek(originalFile.size + insertionDelta);
      await writable.write(cuesBytes);
    }
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch (_) {}
    throw error;
  }
  log(
    `WebM metadata repaired: duration set, ${cues.length} seek cue(s) added${insertionDelta ? `, ${insertionDelta} byte(s) inserted` : ""}.`,
  );
  return {
    ok: true,
    durationSet: true,
    cuesAdded: cues.length,
    bytesAdded: insertionDelta + cuesBytes.length,
  };
}

export { repairWebmFile };
