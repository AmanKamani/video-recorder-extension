import {
  WebmBlobReader,
  concatBytes,
  encodeUint,
  encodeVint,
  makeElement,
  readElement,
  readUint,
  readVint,
} from "./webm-ebml.js";

const IDS = Object.freeze({
  EBML: 0x1a45dfa3n,
  SEGMENT: 0x18538067n,
  INFO: 0x1549a966n,
  TIMECODE_SCALE: 0x2ad7b1n,
  TRACKS: 0x1654ae6bn,
  TRACK_ENTRY: 0xaen,
  TRACK_NUMBER: 0xd7n,
  TRACK_UID: 0x73c5n,
  TRACK_TYPE: 0x83n,
  CODEC_ID: 0x86n,
  CODEC_PRIVATE: 0x63a2n,
  AUDIO: 0xe1n,
  VIDEO: 0xe0n,
  CLUSTER: 0x1f43b675n,
  TIMECODE: 0xe7n,
  SIMPLE_BLOCK: 0xa3n,
  BLOCK_GROUP: 0xa0n,
});
const VIDEO_DIMENSION_IDS = new Set([0xb0n, 0xban, 0x54b0n, 0x54ban]);

const UNKNOWN_SEGMENT_HEADER = new Uint8Array([
  0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);
const SEGMENT_LEVEL_IDS = new Set([
  0x114d9b74n,
  IDS.INFO,
  IDS.TRACKS,
  IDS.CLUSTER,
  0x1c53bb6bn,
  0x1941a469n,
  0x1043a770n,
  0x1254c367n,
]);

/** Resolves a Blob or file-system handle to an immutable input Blob. */
async function sourceBlob(source) {
  if (source instanceof Blob) return source;
  if (source?.getFile) return source.getFile();
  throw new Error("A WebM Blob or file handle is required.");
}

/** Copies one complete parsed element from its source Blob. */
async function bytesFor(blob, element) {
  return new Uint8Array(await blob.slice(element.offset, element.end).arrayBuffer());
}

/** Decodes an element payload as UTF-8 text. */
async function readText(reader, element) {
  return new TextDecoder().decode(
    await reader.bytes(element.dataStart, element.end - element.dataStart),
  );
}

/** Serializes an element payload for stable compatibility comparisons. */
async function readHex(reader, element) {
  const bytes = await reader.bytes(element.dataStart, element.end - element.dataStart);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Captures video metadata that affects decoding while ignoring display dimensions. */
async function readVideoCompatibilityMetadata(reader, videoElement) {
  const metadata = [];
  let offset = videoElement.dataStart;
  while (offset < videoElement.end) {
    const child = await readElement(reader, offset, videoElement.end);
    if (!VIDEO_DIMENSION_IDS.has(child.id)) {
      metadata.push(`video/${child.id.toString(16)}:${await readHex(reader, child)}`);
    }
    offset = child.end;
  }
  return metadata.sort();
}

/** Extracts track identities and decoding parameters from a Tracks element. */
async function inspectTracks(reader, tracksElement) {
  const tracks = [];
  let offset = tracksElement.dataStart;
  while (offset < tracksElement.end) {
    const entry = await readElement(reader, offset, tracksElement.end);
    if (entry.id === IDS.TRACK_ENTRY) {
      const track = { number: null, type: null, codecId: null };
      const compatibilityMetadata = [];
      let childOffset = entry.dataStart;
      while (childOffset < entry.end) {
        const child = await readElement(reader, childOffset, entry.end);
        if (child.id === IDS.TRACK_NUMBER) track.number = Number(await readUint(reader, child));
        else if (child.id === IDS.TRACK_TYPE) track.type = Number(await readUint(reader, child));
        else if (child.id === IDS.CODEC_ID) track.codecId = await readText(reader, child);
        else if (child.id === IDS.CODEC_PRIVATE) track.codecPrivate = await readHex(reader, child);
        else if (child.id === IDS.AUDIO) track.audioParameters = await readHex(reader, child);
        else if (child.id === IDS.VIDEO) {
          compatibilityMetadata.push(...(await readVideoCompatibilityMetadata(reader, child)));
        } else if (child.id !== IDS.TRACK_UID) {
          compatibilityMetadata.push(`${child.id.toString(16)}:${await readHex(reader, child)}`);
        }
        childOffset = child.end;
      }
      if (!(track.number > 0)) throw new Error("WebM track number must be a positive integer.");
      if (compatibilityMetadata.length) {
        track.compatibilityMetadata = compatibilityMetadata.sort();
      }
      tracks.push(track);
    }
    offset = entry.end;
  }
  if (new Set(tracks.map((track) => track.number)).size !== tracks.length) {
    throw new Error("WebM track numbers must be unique.");
  }
  return tracks;
}

/** Reads a Cluster's absolute timecode and rejects unsupported packet containers. */
async function readClusterTimecode(reader, cluster) {
  let offset = cluster.dataStart;
  let timecode = 0;
  while (offset < cluster.end) {
    const child = await readElement(reader, offset, cluster.end);
    if (child.id === IDS.BLOCK_GROUP) {
      throw new Error("WebM BlockGroup packets are not supported for segmented remuxing.");
    }
    if (child.id === IDS.TIMECODE) timecode = Number(await readUint(reader, child));
    offset = child.end;
  }
  return timecode;
}

/**
 * Streaming WebM writers may omit Cluster sizes. In that layout, the next
 * Segment-level element marks the end of the current Cluster.
 */
async function resolveUnknownClusterEnd(reader, cluster, segmentEnd) {
  let offset = cluster.dataStart;
  while (offset < segmentEnd) {
    const child = await readElement(reader, offset, segmentEnd);
    // Unknown-sized Clusters end where the next sibling-level element begins.
    if (SEGMENT_LEVEL_IDS.has(child.id)) return offset;
    if (child.unknownSize) {
      throw new Error("An unknown-sized WebM Cluster child cannot be remuxed safely.");
    }
    if (child.end <= offset) throw new Error("Invalid unknown-sized WebM Cluster structure.");
    offset = child.end;
  }
  return segmentEnd;
}

/** Reads the metadata required to validate and remux one MediaRecorder WebM. */
export async function inspectWebmSegment(source) {
  const blob = await sourceBlob(source);
  if (!blob.size) throw new Error("The WebM segment is empty.");
  const reader = new WebmBlobReader(blob);
  let offset = 0;
  let ebml = null;
  let segment = null;
  while (offset < blob.size) {
    const element = await readElement(reader, offset, blob.size);
    if (element.id === IDS.EBML) ebml = element;
    if (element.id === IDS.SEGMENT) {
      segment = element;
      break;
    }
    offset = element.end;
  }
  if (!ebml || !segment) throw new Error("The input is not a supported WebM file.");

  let info = null;
  let tracksElement = null;
  const clusters = [];
  let timecodeScale = 1_000_000;
  offset = segment.dataStart;
  while (offset < segment.end) {
    let element = await readElement(reader, offset, segment.end);
    if (element.id === IDS.CLUSTER && element.unknownSize) {
      element = {
        ...element,
        end: await resolveUnknownClusterEnd(reader, element, segment.end),
        streamedUnknownSize: true,
        unknownSize: false,
      };
    }
    if (element.id === IDS.INFO) info = element;
    else if (element.id === IDS.TRACKS) tracksElement = element;
    else if (element.id === IDS.CLUSTER) {
      clusters.push({ element, timecode: await readClusterTimecode(reader, element) });
    }
    offset = element.end;
  }
  if (!info || !tracksElement || !clusters.length) {
    throw new Error("WebM Info, Tracks, or Clusters are missing.");
  }

  offset = info.dataStart;
  while (offset < info.end) {
    const element = await readElement(reader, offset, info.end);
    if (element.id === IDS.TIMECODE_SCALE) timecodeScale = Number(await readUint(reader, element));
    offset = element.end;
  }

  return {
    blob,
    reader,
    ebml,
    segment,
    info,
    tracksElement,
    tracks: await inspectTracks(reader, tracksElement),
    clusters,
    timecodeScale,
  };
}

/** Produces a stable identity for matching semantically equivalent tracks. */
function semanticTrackSignature(track) {
  return JSON.stringify({
    type: track.type,
    codecId: track.codecId,
    codecPrivate: track.codecPrivate || null,
    audioParameters: track.audioParameters || null,
    compatibilityMetadata: track.compatibilityMetadata || [],
  });
}

/** Produces an order-independent signature for a segment's remuxing constraints. */
function compatibilitySignature(inspection) {
  return JSON.stringify({
    timecodeScale: inspection.timecodeScale,
    tracks: inspection.tracks.map(semanticTrackSignature).sort(),
  });
}

/** Maps source track numbers onto the canonical layout by semantic track identity. */
function buildTrackNumberMap(canonical, inspection) {
  if (canonical.timecodeScale !== inspection.timecodeScale) return null;
  const canonicalSignatures = canonical.tracks.map(semanticTrackSignature);
  const inspectionSignatures = inspection.tracks.map(semanticTrackSignature);
  if (
    new Set(canonicalSignatures).size !== canonicalSignatures.length ||
    new Set(inspectionSignatures).size !== inspectionSignatures.length
  ) {
    return null;
  }
  const available = canonical.tracks.map((track) => ({
    number: track.number,
    signature: semanticTrackSignature(track),
  }));
  const mapping = new Map();
  for (const track of inspection.tracks) {
    // Track numbers may change between recordings even when the encoded streams are equivalent.
    const signature = semanticTrackSignature(track);
    const matchIndex = available.findIndex((candidate) => candidate.signature === signature);
    if (matchIndex < 0) return null;
    mapping.set(track.number, available[matchIndex].number);
    available.splice(matchIndex, 1);
  }
  return available.length ? null : mapping;
}

/** Formats one inspected track for diagnostic logging. */
function describeTrack(track) {
  const kind = track.type === 1 ? "video" : track.type === 2 ? "audio" : `type-${track.type}`;
  return `#${track.number} ${kind} ${track.codecId || "unknown"}`;
}

/** Identifies the segment files that differ from the most common track layout. */
export function findIncompatibleSegmentIndexes(inspections) {
  const groups = new Map();
  inspections.forEach((inspection, index) => {
    const signature = compatibilitySignature(inspection);
    const group = groups.get(signature) || [];
    group.push(index);
    groups.set(signature, group);
  });
  if (groups.size <= 1) return [];
  const ranked = [...groups.values()].sort(
    (left, right) => right.length - left.length || left[0] - right[0],
  );
  if (ranked[1]?.length === ranked[0].length) {
    return inspections.map((_, index) => index);
  }
  const canonical = ranked[0];
  const compatible = new Set(canonical);
  return inspections.map((_, index) => index).filter((index) => !compatible.has(index));
}

/** Reports which segments cannot share one canonical WebM track layout. */
export class WebmCompatibilityError extends Error {
  constructor(incompatibleSegmentIndexes, inspections) {
    super("The segments have incompatible WebM tracks or timecode scales.");
    this.name = "WebmCompatibilityError";
    this.code = "INCOMPATIBLE_WEBM_TRACKS";
    this.incompatibleSegmentIndexes = incompatibleSegmentIndexes;
    this.trackLayouts = inspections.map((inspection) => ({
      timecodeScale: inspection.timecodeScale,
      tracks: inspection.tracks,
    }));
  }
}

/** Associates a structural validation failure with its source segment. */
export class WebmSegmentValidationError extends Error {
  constructor(segmentIndex, cause) {
    super(`Segment ${segmentIndex + 1} is not a valid remuxable WebM: ${cause?.message || cause}`);
    this.name = "WebmSegmentValidationError";
    this.code = "INVALID_WEBM_SEGMENT";
    this.segmentIndex = segmentIndex;
    this.cause = cause;
  }
}

/** Rewrites one Cluster onto the merged timeline, retaining only in-range SimpleBlocks. */
async function rebuildCluster(inspection, cluster, range, firstClusterTimecode, trackNumberMap) {
  const { reader, blob, timecodeScale } = inspection;
  const durationTicks = (range.duration * 1_000_000_000) / timecodeScale;
  const startTicks = Math.round((range.startTime * 1_000_000_000) / timecodeScale);
  const localClusterTime = cluster.timecode - firstClusterTimecode;
  const parts = [];
  let blocksDropped = 0;
  let blocksWritten = 0;
  let offset = cluster.element.dataStart;

  while (offset < cluster.element.end) {
    const child = await readElement(reader, offset, cluster.element.end);
    if (child.id === IDS.SIMPLE_BLOCK) {
      const track = await readVint(reader, child.dataStart, false);
      const relativeOffset = child.dataStart + track.length;
      const relativeBytes = await reader.bytes(relativeOffset, 2);
      let relative = (relativeBytes[0] << 8) | relativeBytes[1];
      if (relative & 0x8000) relative -= 0x10000;
      const localTime = localClusterTime + relative;
      // The half-open segment range drops overlap packets exactly at the trimmed end boundary.
      if (localTime >= 0 && localTime < durationTicks) {
        const mappedTrackNumber = trackNumberMap.get(Number(track.value));
        if (!mappedTrackNumber) {
          throw new Error(`WebM block references unknown track ${track.value}.`);
        }
        const blockTail = await reader.bytes(
          child.dataStart + track.length,
          child.end - child.dataStart - track.length,
        );
        parts.push(
          makeElement(
            "A3",
            concatBytes([encodeVint(mappedTrackNumber), new Uint8Array(blockTail)]),
          ),
        );
        blocksWritten += 1;
      } else {
        blocksDropped += 1;
      }
    }
    offset = child.end;
  }

  if (!blocksWritten) return { bytes: null, blocksDropped, blocksWritten };
  const outputTimecode = Math.max(0, startTicks + localClusterTime);
  return {
    bytes: makeElement(
      "1F43B675",
      concatBytes([makeElement("E7", encodeUint(outputTimecode)), ...parts]),
    ),
    blocksDropped,
    blocksWritten,
  };
}

/**
 * Validates and joins independently recorded WebM segments into one ordered WebM.
 * The destination is not opened until every input has passed structural validation.
 */
export async function remuxWebmSegments({ sources, ranges, destinationHandle, log = () => {} }) {
  if (!Array.isArray(sources) || !sources.length || sources.length !== ranges?.length) {
    throw new Error("Matching WebM sources and timeline ranges are required.");
  }
  if (!destinationHandle?.createWritable) throw new Error("A destination file handle is required.");

  const inspections = [];
  for (let index = 0; index < sources.length; index += 1) {
    try {
      inspections.push(await inspectWebmSegment(sources[index]));
    } catch (error) {
      throw new WebmSegmentValidationError(index, error);
    }
  }
  const incompatibleSegmentIndexes = findIncompatibleSegmentIndexes(inspections);
  if (incompatibleSegmentIndexes.length) {
    throw new WebmCompatibilityError(incompatibleSegmentIndexes, inspections);
  }

  const first = inspections[0];
  const trackNumberMaps = inspections.map((inspection, index) => {
    const mapping = buildTrackNumberMap(first, inspection);
    if (!mapping) {
      throw new WebmCompatibilityError([index], inspections);
    }
    const remaps = [...mapping.entries()]
      .filter(([source, target]) => source !== target)
      .map(([source, target]) => `#${source}→#${target}`);
    log(
      `Segment ${index + 1} WebM tracks: ${inspection.tracks
        .map(describeTrack)
        .join(", ")}${remaps.length ? `; remap ${remaps.join(", ")}` : ""}.`,
    );
    return mapping;
  });
  const header = await bytesFor(first.blob, first.ebml);
  const info = await bytesFor(first.blob, first.info);
  const tracks = await bytesFor(first.blob, first.tracksElement);
  const writable = await destinationHandle.createWritable();
  let bytesWritten = 0;
  let clustersWritten = 0;
  let blocksDropped = 0;
  // Emit each rebuilt element immediately so merged recordings are never buffered as one Blob.
  const write = async (bytes) => {
    await writable.write(bytes);
    bytesWritten += bytes.byteLength;
  };

  try {
    await write(header);
    await write(UNKNOWN_SEGMENT_HEADER);
    await write(info);
    await write(tracks);
    for (let index = 0; index < inspections.length; index += 1) {
      const inspection = inspections[index];
      const firstClusterTimecode = inspection.clusters[0].timecode;
      for (const cluster of inspection.clusters) {
        const rebuilt = await rebuildCluster(
          inspection,
          cluster,
          ranges[index],
          firstClusterTimecode,
          trackNumberMaps[index],
        );
        blocksDropped += rebuilt.blocksDropped;
        if (rebuilt.bytes) {
          await write(rebuilt.bytes);
          clustersWritten += 1;
        }
      }
    }
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch (_) {}
    throw error;
  }

  const durationMs = Math.round(ranges.at(-1).endTime * 1000);
  log(
    `Merged ${sources.length} WebM segment(s), wrote ${clustersWritten} cluster(s), and trimmed ${blocksDropped} boundary block(s).`,
  );
  return { ok: true, bytesWritten, clustersWritten, blocksDropped, durationMs };
}
