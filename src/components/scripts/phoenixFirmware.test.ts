import { describe, expect, it } from "vitest";
import {
  findNamedPhoenixModule,
  inspectPhoenixLegacyBytes,
  inspectPhoenixUefiBytes,
} from "./phoenixFirmware";

const ascii = (value: string) => new TextEncoder().encode(value);

function writeGuid(bytes: Uint8Array, offset: number, guid: string) {
  const [a, b, c, d, e] = guid.split("-");
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, Number.parseInt(a, 16), true);
  view.setUint16(offset + 4, Number.parseInt(b, 16), true);
  view.setUint16(offset + 6, Number.parseInt(c, 16), true);
  bytes.set(
    Uint8Array.from(`${d}${e}`.match(/../g) ?? [], (part) => Number.parseInt(part, 16)),
    offset + 8,
  );
}

// A minimal but bounds-valid PhoenixBIOS 4.0 FFV image: BCPSYS -> BCPFFV ->
// BCPCMP records, a volumedir.bin2 FFV module pointing at one FFV volume
// (matched by the real ffvVolumeGuid) containing three compressed modules
// (Setup, template, strings) - the exact shape docs/phoenix/README.md's
// Acer sample has.
function phoenixFfvImage() {
  const bytes = new Uint8Array(0x40000);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii("PhoenixBIOS 4.0 Release 6.1"), 0x3d000);
  const sys = 0x3f000;
  bytes.set(ascii("BCPSYS"), sys);
  view.setUint16(sys + 8, 0x83, true);
  bytes.set(ascii("12/05/07"), sys + 0x0f);
  bytes.set(ascii("DEVEL97G"), sys + 0x37);
  const ffv = sys + 0x83;
  bytes.set(ascii("BCPFFV"), ffv);
  view.setUint16(ffv + 8, 14, true);
  view.setUint32(ffv + 10, 0xfff30008, true);
  const cmp = ffv + 14;
  bytes.set(ascii("BCPCMP"), cmp);
  view.setUint16(cmp + 8, 33, true);
  bytes[cmp + 11] = 3;

  const directory = 0x30008;
  bytes[directory] = 0xf8;
  bytes[directory + 4] = 0x58;
  bytes[directory + 7] = 1;
  bytes.set(ascii("volumedi"), directory + 8);
  bytes[directory + 16] = 0xff;
  bytes.set(ascii("r.bin2"), directory + 17);
  view.setUint32(directory + 28, 56, true);
  const entry = directory + 32;
  writeGuid(bytes, entry, "FED91FBA-D37B-4EEA-8729-2EF29FB37A78");
  view.setUint32(entry + 16, 0xfff10000, true);
  view.setUint32(entry + 20, 0xc0, true);
  for (const [index, name] of ["_E00", "_T00", "_S00"].entries()) {
    const moduleStart = 0x10000 + index * 0x40;
    bytes[moduleStart] = 0xf8;
    bytes[moduleStart + 4] = 0x40;
    bytes[moduleStart + 7] = 2;
    bytes.set(ascii(name), moduleStart + 8);
    bytes[moduleStart + 16] = 0xff;
    bytes[moduleStart + 24] = 0x28;
    bytes[moduleStart + 27] = 1;
    bytes[moduleStart + 28] = 0x1c;
    bytes[moduleStart + 32] = 0x78;
  }
  return bytes;
}

describe("inspectPhoenixLegacyBytes", () => {
  it("follows a bounded Phoenix FFV directory to Setup, template and strings", () => {
    const report = inspectPhoenixLegacyBytes(phoenixFfvImage());

    expect(report).toMatchObject({
      format: "phoenix-ffv",
      buildCode: "DEVEL97G",
      buildDate: "12/05/07",
      compressionAlgorithm: 3,
      directoryOffset: 0x30008,
      volumeCount: 2,
      warnings: [],
    });
    expect(report?.modules.map((module) => module.name)).toEqual([
      "SETUP0.ROM",
      "TEMPLAT0.ROM",
      "STRINGS0.ROM",
    ]);
    expect(report?.modules[0]).toMatchObject({
      offset: 0x10000,
      size: 0x40,
      compression: "lh5",
      packedSize: 28,
      unpackedSize: 120,
    });
  });

  it("rejects malformed directory ranges and reports corrupt compressed sections", () => {
    const bytes = phoenixFfvImage();
    new DataView(bytes.buffer).setUint32(0x30008 + 28, 0xfffffff0, true);
    expect(inspectPhoenixLegacyBytes(bytes)).toBeNull();

    const valid = phoenixFfvImage();
    valid[0x10000 + 28] = 0xff;
    const report = inspectPhoenixLegacyBytes(valid);
    expect(report?.warnings).toEqual([expect.stringContaining("SETUP0.ROM")]);
    expect(report?.modules[0]?.compression).toBe("unknown");
  });

  it("returns null for anything that isn't a bounded PhoenixBIOS 4.0 image", () => {
    expect(inspectPhoenixLegacyBytes(new Uint8Array(0x10000))).toBeNull();
  });
});

// A single standalone FFV module header, with no BCPSYS/BCPFFV directory
// and no "PhoenixBIOS" banner string anywhere - the shape a modern Phoenix
// SecureCore UEFI build's legacy CMOS Setup Table modules actually have
// (confirmed against a real 2 MiB laptop firmware sample whose only
// Phoenix evidence was a \Phoenix\...\*.pdb debug path; see
// docs/phoenix/README.md).
function standaloneFfvModule(name: string, offset: number) {
  const bytes = new Uint8Array(offset + 0x40);
  bytes[offset] = 0xf8;
  bytes[offset + 4] = 0x40;
  bytes[offset + 7] = 2;
  bytes.set(ascii(name), offset + 8);
  bytes[offset + 16] = 0xff;
  bytes[offset + 24] = 0x28;
  bytes[offset + 27] = 1;
  bytes[offset + 28] = 0x1c;
  bytes[offset + 32] = 0x78;
  return bytes;
}

describe("findNamedPhoenixModule", () => {
  it("finds a named module by its own FFV header, with no directory to walk through", () => {
    const bytes = standaloneFfvModule("_T00", 0x5000);

    const module = findNamedPhoenixModule(bytes, "TEMPLAT0.ROM");

    expect(module).toMatchObject({
      name: "TEMPLAT0.ROM",
      offset: 0x5000,
      size: 0x40,
      compression: "lh5",
      packedSize: 0x1c,
      unpackedSize: 0x78,
      payloadOffset: 0x5000 + 24 + 12,
    });
  });

  it("returns null when the named module isn't present", () => {
    const bytes = standaloneFfvModule("_T00", 0x5000);

    expect(findNamedPhoenixModule(bytes, "STRINGS0.ROM")).toBeNull();
  });

  it("rejects a module whose compressed section exceeds its own bounds", () => {
    const bytes = standaloneFfvModule("_T00", 0x5000);
    // packedSize 0x1c + unpackedSize field's own 12-byte header would run
    // past the module - shrink the module's declared size to trigger it.
    bytes[0x5000 + 4] = 0x20;

    expect(findNamedPhoenixModule(bytes, "TEMPLAT0.ROM")).toBeNull();
  });
});

describe("inspectPhoenixUefiBytes", () => {
  it("accepts a real RSDS Phoenix SecCore module path without exposing directories", () => {
    const bytes = new Uint8Array(256);
    bytes.set(ascii("RSDS"), 16);
    bytes.set(ascii("C:\\Build\\Phoenix\\SecCore\\Sec\\SecCore.pdb\0"), 40);

    expect(inspectPhoenixUefiBytes(bytes)).toEqual({
      secureCore: true,
      debugModules: ["SecCore"],
    });

    bytes.fill(0, 16, 20);
    expect(inspectPhoenixUefiBytes(bytes)).toBeNull();
  });

  // A PDB path is module provenance, not a Setup-format verdict: a real
  // Lenovo Flex 2 sample carried Phoenix SecCore PDB paths alongside an
  // unrelated Insyde copyright string (see docs/phoenix/README.md). This
  // only asserts what it actually found - reconciling that with other
  // vendor evidence is CorpusRunner's job, not this function's.
  it("ignores a PDB path that names some other vendor", () => {
    const bytes = new Uint8Array(256);
    bytes.set(ascii("RSDS"), 16);
    bytes.set(ascii("C:\\Build\\Insyde\\Core\\DxeCore.pdb\0"), 40);

    expect(inspectPhoenixUefiBytes(bytes)).toBeNull();
  });
});
