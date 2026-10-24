import { SEGMENT_CONFIG } from "./config.js";

/** Bounded random-access reader over a Blob. */
export class WebmBlobReader {
  constructor(blob, cacheSize = SEGMENT_CONFIG.webmReadCacheBytes) {
    this.blob = blob;
    this.cacheSize = cacheSize;
    this.cacheStart = -1;
    this.cache = new Uint8Array(0);
  }

  /** Returns a bounded byte range, reusing the current read-through cache when possible. */
  async bytes(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.blob.size) {
      throw new Error("Unexpected end of WebM file.");
    }
    if (this.cacheStart <= offset && offset + length <= this.cacheStart + this.cache.length) {
      return this.cache.subarray(offset - this.cacheStart, offset - this.cacheStart + length);
    }
    const start = Math.floor(offset / this.cacheSize) * this.cacheSize;
    const end = Math.min(this.blob.size, Math.max(start + this.cacheSize, offset + length));
    this.cache = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
    this.cacheStart = start;
    return this.cache.subarray(offset - start, offset - start + length);
  }
}

/** Decodes an EBML variable-length integer. */
export async function readVint(reader, offset, isId = false) {
  const first = (await reader.bytes(offset, 1))[0];
  if (!first) throw new Error("Invalid EBML variable integer.");
  // The first set bit selects the encoded width; size values exclude that marker from their value.
  let mask = 0x80;
  let length = 1;
  while (!(first & mask)) {
    mask >>= 1;
    length += 1;
    if (length > (isId ? 4 : 8)) throw new Error("Invalid EBML variable integer length.");
  }
  const raw = await reader.bytes(offset, length);
  let value = BigInt(isId ? raw[0] : raw[0] & (mask - 1));
  for (let index = 1; index < length; index += 1) value = (value << 8n) | BigInt(raw[index]);
  const unknown = !isId && value === (1n << BigInt(7 * length)) - 1n;
  return { value, length, unknown };
}

/** Reads an EBML element header and resolves its payload bounds. */
export async function readElement(reader, offset, parentEnd) {
  const id = await readVint(reader, offset, true);
  const size = await readVint(reader, offset + id.length, false);
  const dataStart = offset + id.length + size.length;
  const end = size.unknown ? parentEnd : dataStart + Number(size.value);
  if (end < dataStart || end > parentEnd) throw new Error("Invalid EBML element bounds.");
  return {
    id: id.value,
    offset,
    idLength: id.length,
    sizeOffset: offset + id.length,
    sizeLength: size.length,
    sizeValue: size.value,
    unknownSize: size.unknown,
    dataStart,
    end,
  };
}

/** Reads an EBML unsigned integer payload. */
export async function readUint(reader, element) {
  const length = element.end - element.dataStart;
  if (length < 1 || length > 8) throw new Error("Invalid EBML integer element.");
  const bytes = await reader.bytes(element.dataStart, length);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Encodes an EBML element size. */
export function encodeSize(value, requestedLength = 0) {
  const number = BigInt(value);
  let length = requestedLength;
  if (!length) {
    for (length = 1; length <= 8; length += 1) {
      if (number < (1n << BigInt(7 * length)) - 1n) break;
    }
  }
  if (length < 1 || length > 8 || number >= (1n << BigInt(7 * length)) - 1n) {
    throw new Error("EBML element size is too large for its existing header.");
  }
  let remaining = number;
  const output = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  // Reinsert the width marker without consuming any of the encoded size bits.
  output[0] |= 1 << (8 - length);
  return output;
}

/** Encodes an EBML variable integer value, including its leading length marker. */
export function encodeVint(value, requestedLength = 0) {
  return encodeSize(value, requestedLength);
}

/** Encodes an unsigned integer using the smallest big-endian representation. */
export function encodeUint(value) {
  let number = BigInt(value);
  let length = 1;
  while (number >= 1n << BigInt(8 * length)) length += 1;
  const output = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(number & 255n);
    number >>= 8n;
  }
  return output;
}

/** Concatenates byte arrays. */
export function concatBytes(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Creates one complete EBML element. */
export function makeElement(idHex, payload) {
  const id = new Uint8Array(idHex.match(/../g).map((part) => Number.parseInt(part, 16)));
  return concatBytes([id, encodeSize(payload.length), payload]);
}

export {
  concatBytes as webmConcat,
  encodeSize as webmEncodeSize,
  encodeVint as webmEncodeVint,
  encodeUint as webmEncodeUint,
  makeElement as webmElement,
  readElement as webmReadElement,
  readUint as webmReadUint,
  readVint as webmReadVint,
};
