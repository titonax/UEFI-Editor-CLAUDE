import * as engineModule from "../../vendor/lzma/lzma_worker.js";
import type { LzmaEngine, LzmaMode } from "../../vendor/lzma/lzma_worker.js";
import type { LzmaCodec } from "./lzmaSection";

// LZMA-JS fixes lc=3, lp=0, pb=2 (properties byte 0x5D) and chooses the
// dictionary from a preset 1..9. These are the dictionary sizes of those
// presets as the library defines them (2^bits), index = preset - 1.
const presetDictionaryBits = [16, 20, 19, 20, 21, 22, 23, 24, 25] as const;

// Presets 8-9, 5-7, 3-4 and 1-2 search identically (the library pairs a match
// finder and a fast-byte count with each); they differ only in window size.
// Best search first. Measured on real firmware, the best group varies from one
// section to the next by around 1%.
const presetGroups = [[8, 9], [5, 6, 7], [3, 4], [1, 2]] as const;

// Fast-byte counts tried, after the presets, when a stream does not fit. Each
// is its own encode of the buffer, and which one packs a given buffer smallest
// is not predictable (on real firmware sections they differ by up to a few
// percent on small ones and by hundredths of a percent on large ones), so the
// order is only the order they are tried in.
const fastByteVariants = [96, 112, 144, 160, 192, 224, 273] as const;

// The library's decoder refuses a declared dictionary above this.
const maxDictionarySize = 99_999_999;

function engine(): LzmaEngine {
  return engineModule.LZMA_WORKER;
}

function toBytes(values: ArrayLike<number>) {
  return Uint8Array.from(values, (value) => value & 0xff);
}

function compressWith(data: Uint8Array, mode: number | LzmaMode) {
  const lzma = engine();
  const previous = lzma.disableEndMark;
  lzma.disableEndMark = true;
  try {
    return toBytes(lzma.compress(data, mode));
  } finally {
    lzma.disableEndMark = previous;
  }
}

export const lzmaJsCodec: LzmaCodec = {
  propsByte: 0x5d,
  presetDictionaryBits,
  presetGroups,
  maxDictionarySize,
  fastByteVariants,
  // No end-of-stream marker: the size in the header is the terminator, which is
  // how the firmware's own compressor writes it. The library keeps this as a
  // flag on its single shared object, so it is put back as it was.
  encode(data, preset) {
    return compressWith(data, preset);
  },
  // The best match finder (bt4) with an explicit dictionary and fast-byte count.
  encodeVariant(data, dictionaryBits, fastBytes) {
    return compressWith(data, { s: dictionaryBits, f: fastBytes, m: 1 });
  },
  // The library hands back a string when the output happens to be valid UTF-8.
  // Re-encoding a valid UTF-8 string reproduces its bytes exactly, and the
  // caller compares the result with the data it expects, so a lossy case is a
  // refusal, never a silent change.
  decode(stream) {
    const result = engine().decompress(Array.from(stream));
    return typeof result === "string" ? new TextEncoder().encode(result) : toBytes(result);
  },
};
