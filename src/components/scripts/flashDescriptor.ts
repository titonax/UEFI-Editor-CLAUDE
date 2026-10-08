// The BIOS region declared by an Intel flash descriptor. A rebuild of a
// complete SPI image may only change bytes inside it: the descriptor, ME and
// GbE regions must come back untouched.

export type BiosRegion =
  | { kind: "none" }
  | { kind: "region"; start: number; end: number }
  | { kind: "invalid"; reason: string };

const descriptorSignatureOffset = 0x10;
const blockSize = 0x1000;

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

// `end` is exclusive. An image without the descriptor signature is a BIOS-only
// or vendor image and carries no region constraint; one that has it but whose
// region cannot be read is reported as invalid, never guessed.
export function biosRegionOf(image: Uint8Array): BiosRegion {
  if (image.length < descriptorSignatureOffset + 4 || u32(image, descriptorSignatureOffset) !== 0x0ff0a55a) {
    return { kind: "none" };
  }
  if (image.length < 0x18) {
    return { kind: "invalid", reason: "The Intel flash descriptor is truncated." };
  }
  const flashRegionBase = ((u32(image, 0x14) >>> 16) & 0xff) << 4;
  const biosRegionOffset = flashRegionBase + 4;
  if (flashRegionBase === 0 || biosRegionOffset + 4 > image.length) {
    return {
      kind: "invalid",
      reason: "The Intel flash descriptor does not point at a readable flash region table.",
    };
  }
  const register = u32(image, biosRegionOffset);
  const base = (register & 0x7fff) * blockSize;
  const limit = ((register >>> 16) & 0x7fff) * blockSize + (blockSize - 1);
  if (limit < base) {
    return { kind: "invalid", reason: "The Intel flash descriptor declares no BIOS region." };
  }
  if (limit + 1 > image.length) {
    return {
      kind: "invalid",
      reason: "The Intel flash descriptor declares a BIOS region that extends past the end of the image.",
    };
  }
  return { kind: "region", start: base, end: limit + 1 };
}
