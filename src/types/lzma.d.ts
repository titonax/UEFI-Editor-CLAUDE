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

// The engine file itself, without the package's Node-only entry point (which
// resolves it with require(path) at import time and cannot load in a browser).
declare module "lzma/src/lzma_worker.js" {
  export interface LzmaEngine {
    disableEndMark?: boolean;
    compress(data: Uint8Array | string, mode: number): number[];
    decompress(data: ArrayLike<number>): string | number[];
  }
  export const LZMA_WORKER: LzmaEngine | undefined;
  const moduleExports: { LZMA_WORKER?: LzmaEngine } | undefined;
  export default moduleExports;
}
