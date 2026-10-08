import { describe, expect, it } from "vitest";
import {
  FFS_ATTRIB_CHECKSUM,
  FFS_ATTRIB_TAIL_PRESENT,
  SETUP_GUID,
  firmwareVolume,
  patternBytes,
} from "./firmwareImageFixtures";
import { ffsFileChecksumValid, ffsHeaderChecksumValid, repairFfsFileChecksum } from "./ffsIntegrity";

// The first (only) file of a volume built by the fixtures starts at 0x48.
const fileStart = 0x48;
function fileOf(volume: Uint8Array) {
  const size = volume[fileStart + 20] | (volume[fileStart + 21] << 8) | (volume[fileStart + 22] << 16);
  return { fileStart, bodyStart: fileStart + 24, end: fileStart + size, headerSize: 24 };
}

function volumeWith(attributes: number, overrides: Record<string, boolean> = {}) {
  return firmwareVolume([{ guid: SETUP_GUID, attributes, body: patternBytes(40, 3), ...overrides }]);
}

describe("FFS file checksums", () => {
  it("accepts the header and data checksums the fixtures write", () => {
    const volume = volumeWith(FFS_ATTRIB_CHECKSUM);
    const file = fileOf(volume);

    expect(ffsHeaderChecksumValid(volume, file)).toBe(true);
    expect(ffsFileChecksumValid(volume, file)).toBe(true);
  });

  it("expects 0xAA as the file checksum when the file does not carry a data checksum", () => {
    const volume = volumeWith(0);
    const file = fileOf(volume);

    expect(volume[fileStart + 17]).toBe(0xaa);
    expect(ffsFileChecksumValid(volume, file)).toBe(true);
    volume[fileStart + 17] = 0x00;
    expect(ffsFileChecksumValid(volume, file)).toBe(false);
  });

  it("detects a wrong header checksum and a wrong data checksum", () => {
    const badHeader = volumeWith(FFS_ATTRIB_CHECKSUM, { badHeaderChecksum: true });
    const badData = volumeWith(FFS_ATTRIB_CHECKSUM, { badFileChecksum: true });

    expect(ffsHeaderChecksumValid(badHeader, fileOf(badHeader))).toBe(false);
    expect(ffsFileChecksumValid(badData, fileOf(badData))).toBe(false);
  });

  it("ignores the state byte when summing the header", () => {
    const volume = volumeWith(FFS_ATTRIB_CHECKSUM);
    volume[fileStart + 23] = 0xc0;

    expect(ffsHeaderChecksumValid(volume, fileOf(volume))).toBe(true);
  });
});

describe("repairFfsFileChecksum", () => {
  it("recomputes the data checksum after the body changed, and only that byte", () => {
    const original = volumeWith(FFS_ATTRIB_CHECKSUM);
    const working = original.slice();
    working[fileStart + 24 + 5] ^= 0xff;

    const result = repairFfsFileChecksum(original, working, fileOf(original));

    expect(result).toMatchObject({ ok: true, changed: true, checksumOffset: fileStart + 17 });
    expect(ffsFileChecksumValid(working, fileOf(original))).toBe(true);
    const differing = [...working.keys()].filter((index) => working[index] !== original[index]);
    expect(differing).toEqual([fileStart + 17, fileStart + 24 + 5]);
  });

  it("changes nothing for a file without a data checksum", () => {
    const original = volumeWith(0);
    const working = original.slice();
    working[fileStart + 24 + 5] ^= 0xff;

    expect(repairFfsFileChecksum(original, working, fileOf(original))).toMatchObject({ ok: true, changed: false });
    expect(working[fileStart + 17]).toBe(0xaa);
  });

  it("is a no-op when nothing changed", () => {
    const original = volumeWith(FFS_ATTRIB_CHECKSUM);
    const working = original.slice();

    expect(repairFfsFileChecksum(original, working, fileOf(original))).toMatchObject({ ok: true, changed: false });
    expect(working).toEqual(original);
  });

  it("refuses a source file whose own checksums were already wrong, instead of fixing what was not asked", () => {
    const badHeader = volumeWith(FFS_ATTRIB_CHECKSUM, { badHeaderChecksum: true });
    const badData = volumeWith(FFS_ATTRIB_CHECKSUM, { badFileChecksum: true });

    expect(repairFfsFileChecksum(badHeader, badHeader.slice(), fileOf(badHeader))).toMatchObject({
      ok: false,
      code: "invalid-file-header",
    });
    expect(repairFfsFileChecksum(badData, badData.slice(), fileOf(badData))).toMatchObject({
      ok: false,
      code: "invalid-file-checksum",
    });
  });

  it("refuses a file with a tail, which this repair does not model", () => {
    const volume = volumeWith(FFS_ATTRIB_CHECKSUM | FFS_ATTRIB_TAIL_PRESENT);

    expect(repairFfsFileChecksum(volume, volume.slice(), fileOf(volume))).toMatchObject({
      ok: false,
      code: "unsupported-file-attributes",
    });
  });
});
