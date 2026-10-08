import * as lzma from "lzma";
import type { LzmaCodec } from "./lzmaSection";

// LZMA-JS fixes lc=3, lp=0, pb=2 (properties byte 0x5D) and chooses the
// dictionary from a preset 1..9. These are the dictionary sizes of those
// presets as the library defines them (2^bits), index = preset - 1.
const presetDictionaryBits = [16, 20, 19, 20, 21, 22, 23, 24, 25] as const;

function toBytes(values: ArrayLike<number>) {
  return Uint8Array.from(values, (value) => value & 0xff);
}

export const lzmaJsCodec: LzmaCodec = {
  propsByte: 0x5d,
  presetDictionaryBits,
  // No end-of-stream marker: the size in the header is the terminator, which is
  // how the firmware's own compressor writes it.
  encode(data, preset) {
    lzma.LZMA().disableEndMark = true;
    return toBytes(lzma.compress(data, preset));
  },
  // The library hands back a string when the output happens to be valid UTF-8.
  // Re-encoding a valid UTF-8 string reproduces its bytes exactly, and the
  // caller compares the result with the data it expects, so a lossy case is a
  // refusal, never a silent change.
  decode(stream) {
    const result = lzma.decompress(Array.from(stream));
    return typeof result === "string" ? new TextEncoder().encode(result) : toBytes(result);
  },
};
