import * as engineModule from "lzma/src/lzma_worker.js";
import type { LzmaEngine } from "lzma/src/lzma_worker.js";
import type { LzmaCodec } from "./lzmaSection";

// LZMA-JS fixes lc=3, lp=0, pb=2 (properties byte 0x5D) and chooses the
// dictionary from a preset 1..9. These are the dictionary sizes of those
// presets as the library defines them (2^bits), index = preset - 1.
const presetDictionaryBits = [16, 20, 19, 20, 21, 22, 23, 24, 25] as const;

// The library's decoder refuses a declared dictionary above this.
const maxDictionarySize = 99_999_999;

// The engine file is a plain script that attaches itself to `this`. A bundler
// exposes that as the module's exports, Node as its default export.
function engine(): LzmaEngine {
  const found = engineModule.LZMA_WORKER ?? engineModule.default?.LZMA_WORKER;
  if (!found) throw new Error("The LZMA-JS engine did not load.");
  return found;
}

function toBytes(values: ArrayLike<number>) {
  return Uint8Array.from(values, (value) => value & 0xff);
}

export const lzmaJsCodec: LzmaCodec = {
  propsByte: 0x5d,
  presetDictionaryBits,
  maxDictionarySize,
  // No end-of-stream marker: the size in the header is the terminator, which is
  // how the firmware's own compressor writes it. The library keeps this as a
  // flag on its single shared object, so it is put back as it was.
  encode(data, preset) {
    const lzma = engine();
    const previous = lzma.disableEndMark;
    lzma.disableEndMark = true;
    try {
      return toBytes(lzma.compress(data, preset));
    } finally {
      lzma.disableEndMark = previous;
    }
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
