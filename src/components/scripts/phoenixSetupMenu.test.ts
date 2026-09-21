import { describe, expect, it } from "vitest";
import { inspectPhoenixSetupMenu } from "./phoenixSetupMenu";

const ascii = (value: string) => new TextEncoder().encode(value);

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

// The real -lh5- compressed body of a documented Phoenix FFV module
// (ACPI1.ROM, packed 0x58/unpacked 0x78 bytes - see phoenixLh5.test.ts and
// docs/phoenix/README.md's Acer sample). Used here only to exercise the
// real decompression step end to end; its decompressed content isn't a
// Setup Table, so inspectPhoenixSetupMenu is expected to come back with an
// empty (but non-throwing) result for it - the Setup Table content itself
// is covered by phoenixSetupTable.test.ts's own fixtures.
const acpi1CompressedBody = hexBytes(
  "00414b56da187fdfe640890f428d4902025ee7336ed9cdfc0c95e00204244f031e1b15" +
    "ff88110e80412d0092d634f30010bf1758e63da74d533e5248cf0bb25d718f4884ea0" +
    "39e87e6eafa12ed611e50506bb508fc27a000",
);

function standaloneFfvModule(bytes: Uint8Array, name: string, offset: number, compressedBody: Uint8Array, unpackedSize: number) {
  bytes[offset] = 0xf8;
  const size = 24 + 12 + compressedBody.length;
  bytes[offset + 4] = size & 0xff;
  bytes[offset + 5] = (size >> 8) & 0xff;
  bytes[offset + 6] = (size >> 16) & 0xff;
  bytes[offset + 7] = 2;
  bytes.set(ascii(name), offset + 8);
  bytes[offset + 16] = 0xff;
  const section = offset + 24;
  const sectionSize = 12 + compressedBody.length;
  bytes[section] = sectionSize & 0xff;
  bytes[section + 1] = (sectionSize >> 8) & 0xff;
  bytes[section + 3] = 1;
  bytes[section + 4] = compressedBody.length & 0xff;
  bytes[section + 5] = (compressedBody.length >> 8) & 0xff;
  bytes[section + 8] = unpackedSize & 0xff;
  bytes[section + 9] = (unpackedSize >> 8) & 0xff;
  bytes.set(compressedBody, section + 12);
}

describe("inspectPhoenixSetupMenu", () => {
  it("returns null when neither TEMPLAT nor STRINGS modules are present", async () => {
    expect(await inspectPhoenixSetupMenu(new Uint8Array(0x1000))).toBeNull();
  });

  it("returns null when only one of the two modules is present", async () => {
    const bytes = new Uint8Array(0x1000);
    standaloneFfvModule(bytes, "_T00", 0x100, acpi1CompressedBody, 0x78);

    expect(await inspectPhoenixSetupMenu(bytes)).toBeNull();
  });

  it("locates both modules via the standalone FFV scan (no BCPSYS/BCPFFV directory) and runs the full decompress+parse pipeline", async () => {
    const bytes = new Uint8Array(0x1000);
    standaloneFfvModule(bytes, "_T00", 0x100, acpi1CompressedBody, 0x78);
    standaloneFfvModule(bytes, "_S00", 0x300, acpi1CompressedBody, 0x78);

    const menu = await inspectPhoenixSetupMenu(bytes);

    // The decompressed ACPI table isn't a Setup Table, so this correctly
    // finds no STRPACK-BIOS header and no item records - the point of this
    // test is that discovery, LH5 decompression and parsing all ran
    // without throwing, not that this particular payload looks like menus.
    expect(menu).toEqual({ sections: [] });
  });
});
