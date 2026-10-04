import { describe, expect, it } from "vitest";
import {
  findAwardModule,
  inspectAwardBytes,
  inspectAwardImage,
  readAwardModule,
} from "./awardFirmware";
import { AWARD_ITEM_RECORD_BYTES } from "./awardItemTable";
import { awardLhaEntry as entry } from "./testFixtures";

function image(...parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total + 0x40).fill(0xff);
  let cursor = 0x10;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);

describe("inspectAwardBytes", () => {
  it("walks a chain of checksum-verified level-1 entries", () => {
    const bytes = image(
      entry("awardext.rom", text("EXTENSION")),
      entry("_ITEM.BIN", text("ITEMS")),
      entry("ACPITBL.BIN", text("ACPI")),
    );
    const inventory = inspectAwardBytes(bytes);
    expect(inventory?.modules.map((module) => module.name)).toEqual([
      "awardext.rom",
      "_ITEM.BIN",
      "ACPITBL.BIN",
    ]);
    const first = inventory?.modules[0];
    expect(first).toMatchObject({ method: "-lh0-", packedSize: 9, originalSize: 9 });
    expect(new TextDecoder().decode(bytes.subarray(first?.dataOffset, (first?.dataOffset ?? 0) + 9))).toBe(
      "EXTENSION",
    );
  });

  it("skips an extended-header chain when locating the payload", () => {
    const bytes = image(
      entry("a.bin", text("AAA"), true),
      entry("b.bin", text("BBBB")),
      entry("c.bin", text("CC")),
    );
    const module = inspectAwardBytes(bytes)?.modules[0];
    expect(module).toMatchObject({ name: "a.bin", packedSize: 3 });
    expect(new TextDecoder().decode(bytes.subarray(module?.dataOffset, (module?.dataOffset ?? 0) + 3))).toBe("AAA");
  });

  it("ignores an entry whose header checksum is wrong", () => {
    const broken = entry("bad.bin", text("X"));
    broken[1] ^= 0xff;
    const bytes = image(
      entry("a.bin", text("A")),
      broken,
      entry("b.bin", text("B")),
      entry("c.bin", text("C")),
    );
    expect(inspectAwardBytes(bytes)?.modules.map((module) => module.name)).toEqual(["a.bin", "b.bin", "c.bin"]);
  });

  it("returns null for fewer than three entries or unrelated bytes", () => {
    expect(inspectAwardBytes(image(entry("a.bin", text("A")), entry("b.bin", text("B"))))).toBeNull();
    expect(inspectAwardBytes(new Uint8Array(4096).fill(0x5a))).toBeNull();
  });
});

describe("module reading and the item table", () => {
  it("reads a stored module back and finds modules case-insensitively", async () => {
    const bytes = image(entry("a.bin", text("A")), entry("Hello.Rom", text("WORLD")), entry("c.bin", text("C")));
    const inventory = inspectAwardBytes(bytes);
    const module = inventory && findAwardModule(inventory, "hello.rom");
    expect(module && new TextDecoder().decode(await readAwardModule(bytes, module))).toBe("WORLD");
  });

  it("decodes _ITEM.BIN when the image carries one", async () => {
    const itemTable = new Uint8Array(0x10 + AWARD_ITEM_RECORD_BYTES + 8);
    itemTable.set(text("_ITEM.BIN"));
    const base = 0x10;
    itemTable[base + 2] = 5;
    itemTable[base + 3] = 4;
    itemTable[base + 5] = 0xf8;
    itemTable[base + 8] = 0x3c;
    itemTable[base + 0x11] = 0x03;
    itemTable[base + 0x12] = 0x02;
    const inspection = await inspectAwardImage(
      image(entry("a.bin", text("A")), entry("_ITEM.BIN", itemTable), entry("c.bin", text("C"))),
    );
    expect(inspection?.itemTable?.records).toHaveLength(1);
    expect(inspection?.itemTable?.records[0]).toMatchObject({ id: 5, cmosAddress: 0x3c, page: 3 });
    expect(inspection?.itemTableError).toBeNull();
  });

  it("reports an inventory without a table when there is no _ITEM.BIN", async () => {
    const inspection = await inspectAwardImage(
      image(entry("a.bin", text("A")), entry("b.bin", text("B")), entry("c.bin", text("C"))),
    );
    expect(inspection?.itemTable).toBeNull();
    expect(await inspectAwardImage(new Uint8Array(1024))).toBeNull();
  });
});
