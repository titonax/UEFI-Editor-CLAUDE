

// Reading firmware volumes and FFS files from raw bytes: little-endian readers,
// GUID formatting, volume validation and the top-level volume scan, and the
// GUIDs of the Setup, AMITSE, HII and SetupData files.
export const setupGuid = "899407D7-99FE-43D8-9A21-79EC328CAC21";

export const amitseGuid = "B1DA0ADF-4F77-4070-A88E-BFFE1C60529A";

export const hiiGuid = "97E409E6-4CC1-11D9-81F6-000000000000";

export const setupDataGuid = "FE612B72-203C-47B1-8560-A66D946EB371";


export function u24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}


export function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}


export function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}


export function u64(bytes: Uint8Array, offset: number) {
  const value = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}


export function align(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}


export function hex(value: number, width: number) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}


export function guid(bytes: Uint8Array, offset: number) {
  return `${hex(u32(bytes, offset), 8)}-${hex(u16(bytes, offset + 4), 4)}-${hex(
    u16(bytes, offset + 6),
    4,
  )}-${hex(bytes[offset + 8], 2)}${hex(bytes[offset + 9], 2)}-${Array.from(
    bytes.slice(offset + 10, offset + 16),
    (byte) => hex(byte, 2),
  ).join("")}`;
}


export function validVolume(bytes: Uint8Array, start: number) {
  if (start + 0x38 > bytes.length) return false;
  const length = u64(bytes, start + 0x20);
  const headerLength = u16(bytes, start + 0x30);
  return (
    bytes[start + 0x28] === 0x5f &&
    bytes[start + 0x29] === 0x46 &&
    bytes[start + 0x2a] === 0x56 &&
    bytes[start + 0x2b] === 0x48 &&
    length >= headerLength &&
    start + length <= bytes.length
  );
}


export function findVolumes(bytes: Uint8Array) {
  const volumes: number[] = [];
  for (let signature = 0x28; signature + 4 <= bytes.length; signature += 4) {
    const start = signature - 0x28;
    if (validVolume(bytes, start)) volumes.push(start);
  }
  return volumes;
}


export interface FirmwareFileBounds {
  bodyStart: number;
  end: number;
  size: number;
  headerSize: number;
}


// An FFS file header is 24 bytes unless its 24-bit size field is the
// 0xFFFFFF escape, in which case the real size follows as 64 bits and the
// header grows to 32 bytes (FFS3 large files).
export function firmwareFileBounds(
  bytes: Uint8Array,
  fileStart: number,
  volumeEnd: number,
): FirmwareFileBounds | null {
  if (fileStart + 24 > volumeEnd) return null;
  const size24 = u24(bytes, fileStart + 20);
  const extended = size24 === 0xffffff;
  const headerSize = extended ? 32 : 24;
  if (fileStart + headerSize > volumeEnd) return null;
  const size = extended ? u64(bytes, fileStart + 24) : size24;
  if (size < headerSize || fileStart + size > volumeEnd) return null;
  return { bodyStart: fileStart + headerSize, end: fileStart + size, size, headerSize };
}


export function isEmptyFileHeader(bytes: Uint8Array, fileStart: number) {
  return bytes.slice(fileStart, fileStart + 24).every((byte) => byte === 0xff);
}


// A firmware volume embedded (uncompressed) inside an FFS file body has to
// be reached through that file's section, never treated as a peer of the
// outer volumes: otherwise its provenance would skip the enclosing file and
// section, which a rebuild would need.
export function findTopLevelVolumes(bytes: Uint8Array) {
  const volumes = findVolumes(bytes);
  const nested = new Set<number>();
  for (const parentStart of volumes) {
    const parentEnd = parentStart + u64(bytes, parentStart + 0x20);
    let fileStart = parentStart + align(u16(bytes, parentStart + 0x30), 8);
    while (fileStart + 24 <= parentEnd) {
      if (isEmptyFileHeader(bytes, fileStart)) break;
      const file = firmwareFileBounds(bytes, fileStart, parentEnd);
      if (!file) break;
      for (const candidateStart of volumes) {
        if (candidateStart === parentStart) continue;
        const candidateEnd = candidateStart + u64(bytes, candidateStart + 0x20);
        if (candidateStart >= file.bodyStart && candidateEnd <= file.end) {
          nested.add(candidateStart);
        }
      }
      fileStart = parentStart + align(fileStart - parentStart + file.size, 8);
    }
  }
  return volumes.filter((start) => !nested.has(start));
}
