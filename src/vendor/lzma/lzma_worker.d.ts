export interface LzmaMode {
  // Dictionary size as a power of two.
  s: number;
  // Fast bytes (2..273).
  f: number;
  // Match finder: 0 = bt2, 1 = bt4.
  m: 0 | 1;
}

export interface LzmaEngine {
  disableEndMark?: boolean;
  compress(data: Uint8Array | string, mode: number | LzmaMode): number[];
  decompress(data: ArrayLike<number>): string | number[];
}
export const LZMA_WORKER: LzmaEngine;
