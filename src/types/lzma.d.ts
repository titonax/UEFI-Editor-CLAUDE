// The `lzma` package (LZMA-JS) ships no types. Only the synchronous calls this
// project uses are declared.
declare module "lzma" {
  export interface LzmaWorker {
    // When set, `compress` writes no end-of-stream marker (the size in the
    // header is the only terminator), which is how EDK2's LzmaCompress writes.
    disableEndMark?: boolean;
  }
  export function LZMA(): LzmaWorker;
  // Bytes come back as numbers that may be negative (signed 8-bit).
  export function compress(data: Uint8Array | string, mode: number): number[];
  // Returns a string instead of bytes when the data happens to be valid UTF-8.
  export function decompress(data: ArrayLike<number>): string | number[];
}
