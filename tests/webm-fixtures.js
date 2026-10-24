import { concatBytes, encodeUint, makeElement } from "../modules/webm-ebml.js";

/** Encodes textual fixture metadata as UTF-8 bytes. */
const textBytes = (value) => new TextEncoder().encode(value);

/** Builds a minimal SimpleBlock payload with a signed relative timestamp. */
function blockPayload(relativeTimecode, payloadByte = 1, trackNumber = 1) {
  const payload = new Uint8Array(5);
  payload[0] = 0x80 | trackNumber;
  new DataView(payload.buffer).setInt16(1, relativeTimecode, false);
  payload[3] = 0x80;
  payload[4] = payloadByte;
  return payload;
}

/** Builds a configurable, structurally minimal WebM fixture for remuxing scenarios. */
export function makeWebmFixture({
  codecId = "V_VP8",
  codecPrivateBytes = null,
  tracks = null,
  timecodeScale = 1_000_000,
  clusters = [{ timecode: 0, blocks: [0, 100, 200] }],
  blockGroups = false,
  unknownSizedClusters = false,
} = {}) {
  const ebml = makeElement("1A45DFA3", new Uint8Array());
  const info = makeElement("1549A966", makeElement("2AD7B1", encodeUint(timecodeScale)));
  const trackSpecs = tracks || [{ number: 1, type: 1, codecId, codecPrivateBytes }];
  const tracksElement = makeElement(
    "1654AE6B",
    concatBytes(
      trackSpecs.map((track) =>
        makeElement(
          "AE",
          concatBytes([
            makeElement("D7", encodeUint(track.number)),
            makeElement("83", encodeUint(track.type)),
            makeElement("86", textBytes(track.codecId)),
            ...(track.codecPrivateBytes
              ? [makeElement("63A2", new Uint8Array(track.codecPrivateBytes))]
              : []),
            ...(track.extraElements || []).map(({ id, payload }) =>
              makeElement(id, new Uint8Array(payload)),
            ),
          ]),
        ),
      ),
    ),
  );
  const clusterBytes = clusters.map(({ timecode, blocks }, clusterIndex) => {
    const payload = concatBytes([
      makeElement("E7", encodeUint(timecode)),
      ...blocks.map((block, blockIndex) => {
        const relative = typeof block === "number" ? block : block.timecode;
        const trackNumber = typeof block === "number" ? 1 : block.trackNumber;
        return blockGroups
          ? makeElement(
              "A0",
              makeElement(
                "A1",
                blockPayload(relative, clusterIndex * 10 + blockIndex + 1, trackNumber),
              ),
            )
          : makeElement(
              "A3",
              blockPayload(relative, clusterIndex * 10 + blockIndex + 1, trackNumber),
            );
      }),
    ]);
    return unknownSizedClusters
      ? // A one-byte all-ones size VINT models streaming MediaRecorder Cluster output.
        concatBytes([new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0xff]), payload])
      : makeElement("1F43B675", payload);
  });
  return new Blob(
    [ebml, makeElement("18538067", concatBytes([info, tracksElement, ...clusterBytes]))],
    {
      type: "video/webm",
    },
  );
}

/** Creates an in-memory file handle with the writable operations used by WebM code. */
export function createMemoryFileHandle(name = "output.webm") {
  let bytes = new Uint8Array();
  return {
    name,
    async getFile() {
      return new Blob([bytes], { type: "video/webm" });
    },
    async createWritable() {
      let position = 0;
      return {
        async write(value) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          const required = position + chunk.length;
          if (required > bytes.length) {
            const expanded = new Uint8Array(required);
            expanded.set(bytes);
            bytes = expanded;
          }
          bytes.set(chunk, position);
          position += chunk.length;
        },
        async seek(nextPosition) {
          position = nextPosition;
        },
        async truncate(size) {
          bytes = bytes.slice(0, size);
          position = Math.min(position, size);
        },
        async close() {},
        async abort() {},
      };
    },
  };
}
