import { describe, expect, it } from "vitest";
import { encapsulatedFirmwareSection, readFirmwareSection } from "./firmwareSections";

const lzmaCustomDecompressGuid = "EE4E5898-3914-4259-9D6E-DC7BD79403CF";

function writeGuid(bytes: Uint8Array, offset: number, guid: string) {
  const [data1, data2, data3, data4, data5] = guid.split("-");
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, Number.parseInt(data1, 16), true);
  view.setUint16(offset + 4, Number.parseInt(data2, 16), true);
  view.setUint16(offset + 6, Number.parseInt(data3, 16), true);
  bytes.set(
    Uint8Array.from(`${data4}${data5}`.match(/../g) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    ),
    offset + 8,
  );
}

describe("readFirmwareSection", () => {
  it("reads the standard 4-byte PI section header", () => {
    const bytes = new Uint8Array(12);
    bytes.set([12, 0, 0, 0x01]);

    const section = readFirmwareSection(bytes, 0, bytes.length);

    expect(section).toEqual({ start: 0, end: 12, size: 12, type: 0x01, headerSize: 4 });
  });

  it("reads the extended 8-byte header when the 24-bit size escapes to 0xFFFFFF", () => {
    const bytes = new Uint8Array(20);
    bytes.set([0xff, 0xff, 0xff, 0x02]);
    new DataView(bytes.buffer).setUint32(4, 20, true);

    const section = readFirmwareSection(bytes, 0, bytes.length);

    expect(section).toEqual({ start: 0, end: 20, size: 20, type: 0x02, headerSize: 8 });
  });

  it("returns null for a truncated header", () => {
    const bytes = new Uint8Array(2);
    expect(readFirmwareSection(bytes, 0, bytes.length)).toBeNull();
  });

  it("returns null when the declared size overruns the stream", () => {
    const bytes = new Uint8Array(8);
    bytes.set([20, 0, 0, 0x01]);
    expect(readFirmwareSection(bytes, 0, bytes.length)).toBeNull();
  });
});

describe("encapsulatedFirmwareSection", () => {
  it("opens a standard Compression Section", () => {
    const bytes = new Uint8Array(12);
    bytes.set([12, 0, 0, 0x01]);
    new DataView(bytes.buffer).setUint32(4, 3, true);
    bytes[8] = 1;
    bytes.set([0xaa, 0xbb, 0xcc], 9);
    const section = readFirmwareSection(bytes, 0, bytes.length);
    if (!section) throw new Error("expected a valid section");

    expect(encapsulatedFirmwareSection(bytes, section)).toEqual({
      bytes: new Uint8Array([0xaa, 0xbb, 0xcc]),
      compression: "standard",
      payloadStart: 9,
      payloadEnd: 12,
    });
  });

  it("opens an LZMA GUID-Defined Section at its declared DataOffset", () => {
    const bytes = new Uint8Array(28);
    bytes.set([28, 0, 0, 0x02]);
    writeGuid(bytes, 4, lzmaCustomDecompressGuid);
    new DataView(bytes.buffer).setUint16(20, 24, true);
    new DataView(bytes.buffer).setUint16(22, 1, true);
    bytes.set([0x11, 0x22, 0x33, 0x44], 24);
    const section = readFirmwareSection(bytes, 0, bytes.length);
    if (!section) throw new Error("expected a valid section");

    expect(encapsulatedFirmwareSection(bytes, section)).toEqual({
      bytes: new Uint8Array([0x11, 0x22, 0x33, 0x44]),
      compression: "lzma",
      payloadStart: 24,
      payloadEnd: 28,
      definitionGuid: lzmaCustomDecompressGuid,
      attributes: 1,
    });
  });

  it("opens an LZMA GUID-Defined Section under the extended header", () => {
    const bytes = new Uint8Array(31);
    bytes.set([0xff, 0xff, 0xff, 0x02]);
    new DataView(bytes.buffer).setUint32(4, bytes.length, true);
    writeGuid(bytes, 8, lzmaCustomDecompressGuid);
    new DataView(bytes.buffer).setUint16(24, 28, true);
    new DataView(bytes.buffer).setUint16(26, 1, true);
    bytes.set([0xaa, 0xbb, 0xcc], 28);
    const section = readFirmwareSection(bytes, 0, bytes.length);
    if (!section) throw new Error("expected a valid section");
    expect(section.headerSize).toBe(8);

    expect(encapsulatedFirmwareSection(bytes, section)).toEqual({
      bytes: new Uint8Array([0xaa, 0xbb, 0xcc]),
      compression: "lzma",
      payloadStart: 28,
      payloadEnd: 31,
      definitionGuid: lzmaCustomDecompressGuid,
      attributes: 1,
    });
  });

  it("refuses an unrecognized GUID-Defined processor when processing is required", () => {
    const bytes = new Uint8Array(25);
    bytes.set([25, 0, 0, 0x02]);
    writeGuid(bytes, 4, "11111111-2222-3333-4444-555555555555");
    new DataView(bytes.buffer).setUint16(20, 24, true);
    new DataView(bytes.buffer).setUint16(22, 1, true);
    const section = readFirmwareSection(bytes, 0, bytes.length);
    if (!section) throw new Error("expected a valid section");

    expect(encapsulatedFirmwareSection(bytes, section)).toBeNull();
  });

  it("opens an unrecognized GUID-Defined wrapper when its attributes say processing isn't required", () => {
    const bytes = new Uint8Array(26);
    bytes.set([26, 0, 0, 0x02]);
    writeGuid(bytes, 4, "11111111-2222-3333-4444-555555555555");
    new DataView(bytes.buffer).setUint16(20, 24, true);
    bytes.set([0x5a, 0xa5], 24);
    const section = readFirmwareSection(bytes, 0, bytes.length);
    if (!section) throw new Error("expected a valid section");

    expect(encapsulatedFirmwareSection(bytes, section)).toEqual({
      bytes: new Uint8Array([0x5a, 0xa5]),
      compression: "none",
      payloadStart: 24,
      payloadEnd: 26,
      definitionGuid: "11111111-2222-3333-4444-555555555555",
      attributes: 0,
    });
  });

  it("opens a Disposable Section as an uncompressed pass-through", () => {
    const bytes = new Uint8Array(8);
    bytes.set([8, 0, 0, 0x03]);
    bytes.set([1, 2, 3, 4], 4);
    const section = readFirmwareSection(bytes, 0, bytes.length);
    if (!section) throw new Error("expected a valid section");

    expect(encapsulatedFirmwareSection(bytes, section)).toEqual({
      bytes: new Uint8Array([1, 2, 3, 4]),
      compression: "none",
      payloadStart: 4,
      payloadEnd: 8,
    });
  });

  it("returns null for a section type it doesn't know how to open", () => {
    const bytes = new Uint8Array(8);
    bytes.set([8, 0, 0, 0x10]);
    const section = readFirmwareSection(bytes, 0, bytes.length);
    if (!section) throw new Error("expected a valid section");

    expect(encapsulatedFirmwareSection(bytes, section)).toBeNull();
  });
});
