import test from "node:test";
import assert from "node:assert/strict";

import {
  WebmBlobReader,
  concatBytes,
  encodeSize,
  encodeUint,
  makeElement,
  readElement,
  readVint,
} from "../modules/webm-ebml.js";
import * as webmEbml from "../modules/webm-ebml.js";

test("encodes and reads EBML variable-size integers at width boundaries", async () => {
  // 126 is the largest one-byte value because the all-ones payload is reserved for unknown size.
  assert.deepEqual([...encodeSize(126)], [0xfe]);
  assert.deepEqual([...encodeSize(127)], [0x40, 0x7f]);

  // A one-byte cache verifies that a wider VINT request expands the bounded read window as needed.
  const reader = new WebmBlobReader(new Blob([encodeSize(127)]), 1);
  const value = await readVint(reader, 0, false);
  assert.deepEqual(value, { value: 127n, length: 2, unknown: false });
});

test("encodes block track numbers as EBML variable integers", () => {
  assert.equal(typeof webmEbml.encodeVint, "function");
  assert.deepEqual([...webmEbml.encodeVint(1)], [0x81]);
  assert.deepEqual([...webmEbml.encodeVint(126)], [0xfe]);
  assert.deepEqual([...webmEbml.encodeVint(127)], [0x40, 0x7f]);
});

test("reads complete element bounds and rejects truncated payloads", async () => {
  const elementBytes = makeElement("A3", new Uint8Array([1, 2, 3]));
  const reader = new WebmBlobReader(new Blob([elementBytes]), 2);
  const element = await readElement(reader, 0, elementBytes.length);

  assert.equal(element.id, 0xa3n);
  assert.equal(element.dataStart, 2);
  assert.equal(element.end, 5);
  await assert.rejects(() => reader.bytes(4, 2), /end of WebM/i);
});

test("encodes unsigned integers minimally and concatenates byte arrays", () => {
  assert.deepEqual([...encodeUint(255)], [255]);
  assert.deepEqual([...encodeUint(256)], [1, 0]);
  assert.deepEqual([...concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])])], [1, 2, 3]);
});
