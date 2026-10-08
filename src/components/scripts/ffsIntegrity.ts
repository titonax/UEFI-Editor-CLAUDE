// Integrity bytes of a PI firmware file (FFS) header. A same-size edit to a
// file's body never changes its header, so the only byte a rebuild has to
// repair is the data checksum - and only for files that carry one.

export interface FfsFileBounds {
  fileStart: number;
  bodyStart: number;
  end: number;
  headerSize: number;
}

const attributesOffset = 19;
const fileChecksumOffset = 17;
const stateOffset = 23;
const checksumAttribute = 0x40;
// In the 24-byte header, attribute bit 0 means "tail present" (a two-byte
// inverse of the integrity bytes after the data). This repair does not model
// the tail, so such a file is refused rather than half-repaired.
const tailPresentAttribute = 0x01;

function sum8(bytes: Uint8Array, start: number, end: number) {
  let total = 0;
  for (let index = start; index < end; index++) total = (total + bytes[index]) & 0xff;
  return total;
}

function validBounds(bytes: Uint8Array, file: FfsFileBounds) {
  return (
    (file.headerSize === 24 || file.headerSize === 32) &&
    file.fileStart >= 0 &&
    file.bodyStart === file.fileStart + file.headerSize &&
    file.end >= file.bodyStart &&
    file.end <= bytes.length
  );
}

// The header sums to zero when the file-checksum and state bytes are counted
// as zero (the state byte changes as the file is erased and programmed).
export function ffsHeaderChecksumValid(bytes: Uint8Array, file: FfsFileBounds) {
  if (!validBounds(bytes, file)) return false;
  const total =
    sum8(bytes, file.fileStart, file.fileStart + file.headerSize) -
    bytes[file.fileStart + fileChecksumOffset] -
    bytes[file.fileStart + stateOffset];
  return (total & 0xff) === 0;
}

export function expectedFfsFileChecksum(bytes: Uint8Array, file: FfsFileBounds) {
  const attributes = bytes[file.fileStart + attributesOffset];
  if ((attributes & checksumAttribute) === 0) return 0xaa;
  return (0x100 - sum8(bytes, file.bodyStart, file.end)) & 0xff;
}

// With the checksum attribute the byte covers the file's data; without it the
// byte is the fixed value 0xAA.
export function ffsFileChecksumValid(bytes: Uint8Array, file: FfsFileBounds) {
  if (!validBounds(bytes, file)) return false;
  return bytes[file.fileStart + fileChecksumOffset] === expectedFfsFileChecksum(bytes, file);
}

export type FfsRepair =
  | { ok: true; changed: boolean; before: number; after: number; checksumOffset: number }
  | {
      ok: false;
      code: "invalid-file-header" | "invalid-file-checksum" | "unsupported-file-attributes";
      message: string;
    };

// Brings the data checksum of `working` up to date after its body was edited.
// `original` is the same buffer before any edit: the file must have been
// consistent there, otherwise the repair would be correcting something nobody
// asked it to touch, so it refuses and says why.
export function repairFfsFileChecksum(
  original: Uint8Array,
  working: Uint8Array,
  file: FfsFileBounds,
): FfsRepair {
  const at = `0x${file.fileStart.toString(16).toUpperCase()}`;
  if (!validBounds(original, file) || !validBounds(working, file)) {
    return {
      ok: false,
      code: "invalid-file-header",
      message: `The FFS file at ${at} does not fit its buffer.`,
    };
  }
  if (!ffsHeaderChecksumValid(original, file)) {
    return {
      ok: false,
      code: "invalid-file-header",
      message: `The header checksum of the FFS file at ${at} is already wrong in the source image.`,
    };
  }
  const attributes = original[file.fileStart + attributesOffset];
  if (file.headerSize === 24 && (attributes & tailPresentAttribute) !== 0) {
    return {
      ok: false,
      code: "unsupported-file-attributes",
      message: `The FFS file at ${at} carries a tail, which the rebuild does not model.`,
    };
  }
  const offset = file.fileStart + fileChecksumOffset;
  const before = working[offset];
  if (!ffsFileChecksumValid(original, file)) {
    return {
      ok: false,
      code: "invalid-file-checksum",
      message: `The data checksum of the FFS file at ${at} is already wrong in the source image.`,
    };
  }
  if ((attributes & checksumAttribute) === 0) {
    // Nothing depends on the body: the byte is the fixed 0xAA, already checked.
    return { ok: true, changed: false, before, after: before, checksumOffset: offset };
  }
  const after = expectedFfsFileChecksum(working, file);
  working[offset] = after;
  return { ok: true, changed: after !== before, before, after, checksumOffset: offset };
}
