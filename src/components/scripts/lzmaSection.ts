// LZMA streams as the firmware stores them: the 13-byte "LZMA alone" header
// (properties byte, 32-bit dictionary size, 64-bit uncompressed size) then the
// range-coded data. A re-encode has to reproduce what the firmware's decoder
// was built around: the same properties, a declared size, and a dictionary no
// larger than the original's.

export interface LzmaStreamHeader {
  propsByte: number;
  lc: number;
  lp: number;
  pb: number;
  dictionarySize: number;
  // Null when the header declares no size (all ones), which means the stream
  // is terminated by an end marker instead.
  uncompressedSize: bigint | null;
}

export interface LzmaCodec {
  // The properties byte this encoder always produces.
  propsByte: number;
  // Dictionary size of each preset, as a power of two; index = preset - 1.
  presetDictionaryBits: readonly number[];
  // The largest declared dictionary this codec's decoder can check a stream
  // for; a larger one is valid LZMA but could not be verified here.
  maxDictionarySize: number;
  // Writes a stream with a declared size and no end marker.
  encode(data: Uint8Array, preset: number): Uint8Array;
  decode(stream: Uint8Array): Uint8Array;
}

export type ReencodeRefusalCode =
  | "lzma-header"
  | "lzma-properties"
  | "lzma-size"
  | "lzma-dictionary"
  | "lzma-codec"
  | "lzma-roundtrip";

export type ReencodeResult =
  | { ok: true; stream: Uint8Array; preset: number }
  | { ok: false; code: ReencodeRefusalCode; message: string };

const headerSize = 13;

export function readLzmaHeader(bytes: Uint8Array): LzmaStreamHeader | null {
  if (bytes.length < headerSize) return null;
  const propsByte = bytes[0];
  if (propsByte >= 225) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getBigUint64(5, true);
  return {
    propsByte,
    lc: propsByte % 9,
    lp: Math.floor(propsByte / 9) % 5,
    pb: Math.floor(propsByte / 45),
    dictionarySize: view.getUint32(1, true),
    uncompressedSize: size === 0xffffffffffffffffn ? null : size,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// Re-encodes `decoded` so it can replace `originalStream` in the firmware.
// Refuses anything the original's decoder could treat differently: other
// properties, a stream that relied on an end marker, a different length, or a
// stream its own decoder does not read back to `decoded`.
export function reencodeLzma(
  originalStream: Uint8Array,
  decoded: Uint8Array,
  codec: LzmaCodec,
): ReencodeResult {
  const original = readLzmaHeader(originalStream);
  if (!original) {
    return { ok: false, code: "lzma-header", message: "The original section does not start with an LZMA header." };
  }
  if (original.propsByte !== codec.propsByte) {
    return {
      ok: false,
      code: "lzma-properties",
      message: `The original uses LZMA properties 0x${original.propsByte.toString(16)} (lc=${String(original.lc)}, lp=${String(original.lp)}, pb=${String(original.pb)}); this encoder only writes 0x${codec.propsByte.toString(16)}.`,
    };
  }
  if (original.uncompressedSize === null) {
    return {
      ok: false,
      code: "lzma-size",
      message: "The original LZMA stream declares no size, so it relies on an end marker this rebuild does not reproduce.",
    };
  }
  if (decoded.length === 0) {
    return { ok: false, code: "lzma-size", message: "There is nothing to compress: an empty buffer has no LZMA stream to rebuild." };
  }
  if (original.uncompressedSize !== BigInt(decoded.length)) {
    return {
      ok: false,
      code: "lzma-size",
      message: `The original declares ${String(original.uncompressedSize)} bytes; the data to compress has ${String(decoded.length)}.`,
    };
  }
  if (original.dictionarySize > codec.maxDictionarySize) {
    return {
      ok: false,
      code: "lzma-dictionary",
      message: `The original declares a ${String(original.dictionarySize)}-byte dictionary, larger than the ${String(codec.maxDictionarySize)} this codec's decoder can check.`,
    };
  }
  // The largest preset whose dictionary the original's decoder already has.
  let preset = 0;
  for (const [index, bits] of codec.presetDictionaryBits.entries()) {
    if (2 ** bits <= original.dictionarySize) preset = index + 1;
  }
  if (preset === 0) {
    return {
      ok: false,
      code: "lzma-dictionary",
      message: `The original dictionary (${String(original.dictionarySize)} bytes) is smaller than any this encoder can use.`,
    };
  }
  let stream: Uint8Array;
  try {
    stream = codec.encode(decoded, preset).slice();
  } catch (error) {
    return codecFailure("encode", error);
  }
  // The stream only uses distances inside the preset's window, so declaring the
  // original's (larger or equal) dictionary is valid and keeps the decoder's
  // memory exactly as it was.
  new DataView(stream.buffer, stream.byteOffset, stream.byteLength).setUint32(1, original.dictionarySize, true);
  let readBack: Uint8Array;
  try {
    readBack = codec.decode(stream);
  } catch (error) {
    return codecFailure("decode", error);
  }
  if (!sameBytes(readBack, decoded)) {
    return {
      ok: false,
      code: "lzma-roundtrip",
      message: "The re-encoded LZMA stream does not decode back to the data it was made from.",
    };
  }
  return { ok: true, stream, preset };
}

function codecFailure(step: "encode" | "decode", error: unknown): ReencodeResult {
  const reason = error instanceof Error ? error.message : String(error);
  return { ok: false, code: "lzma-codec", message: `The LZMA codec failed to ${step}: ${reason}` };
}
