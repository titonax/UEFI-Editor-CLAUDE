// Synthetic firmware images for the rebuild tests: real-shaped firmware
// volumes, FFS files and PI sections with VALID checksums, so a rebuild that
// forgets to repair one is caught. Nothing here is firmware; every byte is
// built from small, known payloads. Not itself a test file.

export const SETUP_GUID = "899407D7-99FE-43D8-9A21-79EC328CAC21";
export const AMITSE_GUID = "B1DA0ADF-4F77-4070-A88E-BFFE1C60529A";
export const HII_GUID = "97E409E6-4CC1-11D9-81F6-000000000000";
export const SETUP_DATA_GUID = "FE612B72-203C-47B1-8560-A66D946EB371";
export const LZMA_CUSTOM_DECOMPRESS_GUID = "EE4E5898-3914-4259-9D6E-DC7BD79403CF";
export const PASS_THROUGH_GUID = "11111111-2222-3333-4444-555555555555";

export const FFS_ATTRIB_CHECKSUM = 0x40;
export const FFS_ATTRIB_TAIL_PRESENT = 0x01;

export function writeGuid(bytes: Uint8Array, offset: number, guid: string) {
  const [data1, data2, data3, data4, data5] = guid.split("-");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(offset, Number.parseInt(data1, 16), true);
  view.setUint16(offset + 4, Number.parseInt(data2, 16), true);
  view.setUint16(offset + 6, Number.parseInt(data3, 16), true);
  bytes.set(
    Uint8Array.from(`${data4}${data5}`.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
    offset + 8,
  );
}

function align(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}

function writeUint24(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

// A PI section: 4-byte header (24-bit size including the header, then type).
export function section(type: number, payload: Uint8Array) {
  const bytes = new Uint8Array(4 + payload.length);
  writeUint24(bytes, 0, bytes.length);
  bytes[3] = type;
  bytes.set(payload, 4);
  return bytes;
}

export function pe32Section(payload: Uint8Array) {
  return section(0x10, payload);
}

export function freeformSection(subtypeGuid: string, payload: Uint8Array) {
  const body = new Uint8Array(16 + payload.length);
  writeGuid(body, 0, subtypeGuid);
  body.set(payload, 16);
  return section(0x18, body);
}

// A GUID-defined section (type 0x02). `guidSpecific` is the data between the
// 20 fixed metadata bytes and the payload (for example a CRC32).
export function guidDefinedSection(
  definitionGuid: string,
  attributes: number,
  payload: Uint8Array,
  guidSpecific: Uint8Array = new Uint8Array(0),
) {
  const metadata = new Uint8Array(20 + guidSpecific.length);
  writeGuid(metadata, 0, definitionGuid);
  new DataView(metadata.buffer).setUint16(16, 4 + 20 + guidSpecific.length, true);
  new DataView(metadata.buffer).setUint16(18, attributes, true);
  metadata.set(guidSpecific, 20);
  const body = new Uint8Array(metadata.length + payload.length);
  body.set(metadata, 0);
  body.set(payload, metadata.length);
  return section(0x02, body);
}

// A Compression Section (type 0x01): 4 bytes of uncompressed length, one byte
// of compression type (0 none, 1 EFI/Tiano, 2 LZMA), then the payload.
export function compressionSection(compressionType: number, uncompressedLength: number, payload: Uint8Array) {
  const body = new Uint8Array(5 + payload.length);
  new DataView(body.buffer).setUint32(0, uncompressedLength, true);
  body[4] = compressionType;
  body.set(payload, 5);
  return section(0x01, body);
}

export function concat(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}

// Sections laid out back to back, each starting on a 4-byte boundary.
export function sectionStream(...sections: Uint8Array[]) {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const part of sections) {
    const padding = align(length, 4) - length;
    if (padding > 0) parts.push(new Uint8Array(padding).fill(0));
    parts.push(part);
    length = align(length, 4) + part.length;
  }
  return concat(...parts);
}

export function sum8(bytes: Uint8Array, start = 0, end = bytes.length) {
  let total = 0;
  for (let index = start; index < end; index++) total = (total + bytes[index]) & 0xff;
  return total;
}

export interface FixtureFile {
  guid: string;
  body: Uint8Array;
  type?: number;
  attributes?: number;
  // Leave the stored checksums wrong, to prove they are checked.
  badHeaderChecksum?: boolean;
  badFileChecksum?: boolean;
}

function fileBytes(file: FixtureFile) {
  const size = 24 + file.body.length;
  const bytes = new Uint8Array(size);
  writeGuid(bytes, 0, file.guid);
  bytes[18] = file.type ?? 0x07;
  bytes[19] = file.attributes ?? 0;
  writeUint24(bytes, 20, size);
  bytes[23] = 0xf8;
  bytes.set(file.body, 24);
  // Header checksum: the header sums to zero with the file-checksum and state
  // bytes counted as zero.
  const headerSum = sum8(bytes, 0, 24) - bytes[17] - bytes[23];
  bytes[16] = (0x100 - (headerSum & 0xff)) & 0xff;
  if (file.badHeaderChecksum) bytes[16] ^= 0x5a;
  bytes[17] =
    ((file.attributes ?? 0) & FFS_ATTRIB_CHECKSUM) !== 0
      ? (0x100 - sum8(bytes, 24, size)) & 0xff
      : 0xaa;
  if (file.badFileChecksum) bytes[17] ^= 0x33;
  return bytes;
}

// A firmware volume holding the files back to back on 8-byte boundaries, then
// erased (0xFF) space. The header is 0x48 bytes with a valid 16-bit checksum.
export function firmwareVolume(files: FixtureFile[], trailingFree = 0x40) {
  const headerSize = 0x48;
  const placed = files.map(fileBytes);
  let cursor = headerSize;
  const offsets: number[] = [];
  for (const file of placed) {
    offsets.push(cursor);
    cursor = align(cursor + file.length, 8);
  }
  const volumeSize = align(cursor + trailingFree, 8);
  const bytes = new Uint8Array(volumeSize).fill(0xff);
  bytes.fill(0, 0, headerSize);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0x20, BigInt(volumeSize), true);
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28);
  view.setUint16(0x30, headerSize, true);
  let headerSum = 0;
  for (let offset = 0; offset < headerSize; offset += 2) headerSum = (headerSum + view.getUint16(offset, true)) & 0xffff;
  view.setUint16(0x32, (0x10000 - headerSum) & 0xffff, true);
  for (const [index, file] of placed.entries()) bytes.set(file, offsets[index]);
  return bytes;
}

// Reads back the 16-bit sum of a volume header, which must be zero.
export function volumeHeaderChecksumValid(volume: Uint8Array, start = 0, headerSize = 0x48) {
  const view = new DataView(volume.buffer, volume.byteOffset, volume.byteLength);
  let total = 0;
  for (let offset = 0; offset < headerSize; offset += 2) total = (total + view.getUint16(start + offset, true)) & 0xffff;
  return total === 0;
}

export interface SetupPayloads {
  hii: Uint8Array;
  amitse?: Uint8Array;
  setupData?: Uint8Array;
}

// The three AMI files as the extractor expects them: Setup holds the HII
// freeform section, AMITSE a PE32 section plus the SetupData freeform
// section (the common layout).
export function setupFiles(payloads: SetupPayloads, attributes = 0): FixtureFile[] {
  const files: FixtureFile[] = [
    {
      guid: SETUP_GUID,
      attributes,
      body: sectionStream(freeformSection(HII_GUID, payloads.hii)),
    },
  ];
  if (payloads.amitse) {
    files.push({
      guid: AMITSE_GUID,
      attributes,
      body: sectionStream(
        pe32Section(payloads.amitse),
        ...(payloads.setupData ? [freeformSection(SETUP_DATA_GUID, payloads.setupData)] : []),
      ),
    });
  }
  return files;
}

export function patternBytes(length: number, seed: number) {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 7) & 0xff);
}

export interface SpiOptions {
  // Block indexes (4 KiB) of the BIOS region; defaults to everything after
  // the descriptor.
  biosBaseBlock?: number;
  biosLimitBlock?: number;
  // Corrupt the descriptor map so the region cannot be read.
  brokenMap?: boolean;
}

// A complete SPI image: a 4 KiB Intel descriptor declaring a BIOS region, then
// the BIOS bytes, padded with erased space to a 4 KiB multiple.
export function spiImage(bios: Uint8Array, options: SpiOptions = {}) {
  const blocks = Math.ceil(bios.length / 0x1000);
  const image = new Uint8Array(0x1000 + blocks * 0x1000).fill(0xff);
  image.fill(0, 0, 0x1000);
  image.set(bios, 0x1000);
  const view = new DataView(image.buffer);
  view.setUint32(0x10, 0x0ff0a55a, true);
  // FLMAP0: FRBA = 0x40 (stored >> 4 in bits 23:16).
  view.setUint32(0x14, options.brokenMap ? 0 : 0x00040000, true);
  const base = options.biosBaseBlock ?? 1;
  const limit = options.biosLimitBlock ?? blocks;
  view.setUint32(0x40, 0, true); // descriptor region: block 0..0
  view.setUint32(0x44, (limit << 16) | base, true); // BIOS region
  view.setUint32(0x48, 0x00007fff, true); // ME region: disabled
  view.setUint32(0x4c, 0x00007fff, true); // GbE region: disabled
  return image;
}
