// AMI's known "custom decompress" processing GUIDs for a PI GUID-Defined
// Section (type 0x02) - the two encapsulation formats actually used to wrap
// compressed payloads in Aptio IV/V images, alongside the older, simpler
// Compression Section (type 0x01).
const lzmaCustomDecompressGuid = "EE4E5898-3914-4259-9D6E-DC7BD79403CF";
const tianoCustomDecompressGuid = "A31280AD-481E-41B6-95E8-127F4C984779";

export interface FirmwareSection {
  start: number;
  end: number;
  size: number;
  type: number;
  headerSize: 4 | 8;
}

export type FirmwareSectionCompression = "none" | "standard" | "lzma";

export interface EncapsulatedFirmwareSection {
  bytes: Uint8Array;
  compression: FirmwareSectionCompression;
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}

function hex(value: number, width: number) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function guid(bytes: Uint8Array, offset: number) {
  return `${hex(u32(bytes, offset), 8)}-${hex(u16(bytes, offset + 4), 4)}-${hex(
    u16(bytes, offset + 6),
    4,
  )}-${hex(bytes[offset + 8], 2)}${hex(bytes[offset + 9], 2)}-${Array.from(
    bytes.slice(offset + 10, offset + 16),
    (byte) => hex(byte, 2),
  ).join("")}`;
}

// Reads either the standard 4-byte PI section header or its extended-size
// form (EFI_COMMON_SECTION_HEADER2): a 24-bit size of 0xFFFFFF means the
// real size doesn't fit in 24 bits and instead follows as a 32-bit value,
// pushing the header to 8 bytes. A null result means the remaining bytes
// aren't a complete PI section, so the caller should stop scanning instead
// of misreading past the end.
export function readFirmwareSection(
  bytes: Uint8Array,
  start: number,
  streamEnd: number,
): FirmwareSection | null {
  if (start < 0 || streamEnd > bytes.length || start + 4 > streamEnd) {
    return null;
  }

  const size24 = u24(bytes, start);
  const extended = size24 === 0xffffff;
  const headerSize = extended ? 8 : 4;
  if (start + headerSize > streamEnd) {
    return null;
  }

  const size = extended ? u32(bytes, start + 4) : size24;
  if (size < headerSize || start + size > streamEnd) {
    return null;
  }

  return {
    start,
    end: start + size,
    size,
    type: bytes[start + 3],
    headerSize,
  };
}

// Describes an encapsulation section's inner payload without decompressing
// it: a Compression Section (0x01); a GUID-Defined Section (0x02) - AMI
// wraps compressed AMITSE/SetupData/Setup payloads in this format at least
// as often as the plain Compression Section, using its own LZMA/Tiano
// custom-decompress GUIDs, or (absent a recognized GUID) its "processing
// required" attribute bit to tell a pass-through section from one this
// reader can't open; or a pass-through Disposable Section (0x03). Any other
// section type returns null - there's no payload to recurse into.
export function encapsulatedFirmwareSection(
  bytes: Uint8Array,
  section: FirmwareSection,
): EncapsulatedFirmwareSection | null {
  if (section.type === 0x01) {
    const metadata = section.start + section.headerSize;
    if (metadata + 5 > section.end) {
      return null;
    }
    const compressionType = bytes[metadata + 4];
    const compression: FirmwareSectionCompression | null =
      compressionType === 0
        ? "none"
        : compressionType === 1
          ? "standard"
          : compressionType === 2
            ? "lzma"
            : null;
    if (!compression) {
      return null;
    }
    return { bytes: bytes.slice(metadata + 5, section.end), compression };
  }

  if (section.type === 0x02) {
    const metadata = section.start + section.headerSize;
    if (metadata + 20 > section.end) {
      return null;
    }
    const definitionGuid = guid(bytes, metadata);
    const dataOffset = u16(bytes, metadata + 16);
    const attributes = u16(bytes, metadata + 18);
    const minimumDataOffset = section.headerSize + 20;
    if (dataOffset < minimumDataOffset || dataOffset > section.size) {
      return null;
    }

    let compression: FirmwareSectionCompression | null = null;
    if (definitionGuid === lzmaCustomDecompressGuid) {
      compression = "lzma";
    } else if (definitionGuid === tianoCustomDecompressGuid) {
      compression = "standard";
    } else if ((attributes & 0x01) === 0) {
      compression = "none";
    }
    if (!compression) {
      return null;
    }

    return {
      bytes: bytes.slice(section.start + dataOffset, section.end),
      compression,
    };
  }

  if (section.type === 0x03) {
    return {
      bytes: bytes.slice(section.start + section.headerSize, section.end),
      compression: "none",
    };
  }

  return null;
}
