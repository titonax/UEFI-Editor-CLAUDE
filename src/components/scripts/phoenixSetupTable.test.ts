import { describe, expect, it } from "vitest";
import {
  buildPhoenixSetupMenu,
  parsePhoenixStringTable,
  resolvePhoenixString,
  scanPhoenixSetupSections,
} from "./phoenixSetupTable";

const ascii = (value: string) => new TextEncoder().encode(value);

function writeCString(bytes: Uint8Array, offset: number, value: string) {
  bytes.set(ascii(value), offset);
  bytes[offset + value.length] = 0;
}

// A minimal STRPACK-BIOS string table: signature, zero padding, one
// declared language (matching the real "01 00 02 00" = 1 language, id 2
// (EN-US) pattern), then the table region itself. Byte shapes below mirror
// a real decompressed Phoenix STRINGS.ROM, independently confirmed by
// resolving real Prompt/Help pairs through this exact double indirection
// (table slot -> text offset -> C string) - see docs/phoenix/README.md.
function stringTableImage() {
  const bytes = new Uint8Array(0xa0);
  bytes.set(ascii("STRPACK-BIOS"), 0);
  // 8 bytes of zero padding (already zero), then language count/id.
  new DataView(bytes.buffer).setUint16(0x14, 1, true); // 1 language
  new DataView(bytes.buffer).setUint16(0x16, 2, true); // language id
  const tableBase = 0x18;
  // Slot at table-relative 0x10 holds the text's table-relative offset (0x20).
  new DataView(bytes.buffer).setUint16(tableBase + 0x10, 0x20, true);
  writeCString(bytes, tableBase + 0x20, "Main");
  // A second slot/text pair for a Pick Field's help text.
  new DataView(bytes.buffer).setUint16(tableBase + 0x12, 0x28, true);
  writeCString(bytes, tableBase + 0x28, "Enabled or Disabled");
  // Two more slot/text pairs for a Pick Field's own option list (see
  // PhoenixSetupItem.options) - confirmed against real "Disabled"/"Enabled"
  // option pairs from two independent real Phoenix images.
  new DataView(bytes.buffer).setUint16(tableBase + 0x14, 0x60, true);
  writeCString(bytes, tableBase + 0x60, "Disabled");
  new DataView(bytes.buffer).setUint16(tableBase + 0x16, 0x6a, true);
  writeCString(bytes, tableBase + 0x6a, "Enabled");
  return bytes;
}

describe("parsePhoenixStringTable / resolvePhoenixString", () => {
  it("resolves a string through the table's slot -> text-offset double indirection", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    if (!table) throw new Error("expected a parsed string table");
    expect(resolvePhoenixString(table, 0x10)).toBe("Main");
    expect(resolvePhoenixString(table, 0x12)).toBe("Enabled or Disabled");
  });

  it("returns null for a reference whose slot or text falls outside the table", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    if (!table) throw new Error("expected a parsed string table");
    expect(resolvePhoenixString(table, 0x7000)).toBeNull();
  });

  it("returns null when the STRPACK-BIOS signature isn't present", () => {
    expect(parsePhoenixStringTable(new Uint8Array(0x40))).toBeNull();
  });
});

// A single Pick Field record: type(1) + length(1) + promptRef(2) +
// helpRef(2) + 4 more unconfirmed fields + an option-reference array from
// +16 to the record's end - confirmed against a real "F12 Boot Menu:" / its
// help text pair, and real Enabled/Disabled-style option lists, from real
// Phoenix images.
function pickFieldItem(promptRef: number, helpRef: number, length = 20, optionRefs: number[] = []) {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x00;
  bytes[1] = length;
  const view = new DataView(bytes.buffer);
  view.setUint16(2, promptRef, true);
  view.setUint16(4, helpRef, true);
  optionRefs.forEach((ref, index) => {
    view.setUint16(16 + index * 2, ref, true);
  });
  return bytes;
}

// A Generic Text record: type(1) + length(1) + stringRef(2) + 6 more
// unconfirmed bytes - confirmed against a real "Main" tab-title record
// (type 0x10, length 10).
function genericTextItem(stringRef: number) {
  const bytes = new Uint8Array(10);
  bytes[0] = 0x10;
  bytes[1] = 10;
  new DataView(bytes.buffer).setUint16(2, stringRef, true);
  return bytes;
}

// A Time record: type(1) + length(1) + promptRef(2) + helpRef(2) + 4 bytes
// of filler - confirmed against a real record from the tutorial this was
// reverse-engineered against.
function timeItem(promptRef: number, helpRef: number) {
  const bytes = new Uint8Array(10);
  bytes[0] = 0x21;
  bytes[1] = 10;
  new DataView(bytes.buffer).setUint16(2, promptRef, true);
  new DataView(bytes.buffer).setUint16(4, helpRef, true);
  return bytes;
}

function concat(...chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("Pick Field options", () => {
  it("resolves the option-reference array filling a record's own tail", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      pickFieldItem(0x10, 0x12, 20, [0x14, 0x16]),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const sections = scanPhoenixSetupSections(templat, table);

    expect(sections[0].items[0].options).toEqual(["Disabled", "Enabled"]);
  });

  it("skips an unused trailing slot (reference 0) rather than showing it as a blank option", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      pickFieldItem(0x10, 0x12, 24, [0x14, 0x16, 0]),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const sections = scanPhoenixSetupSections(templat, table);

    expect(sections[0].items[0].options).toEqual(["Disabled", "Enabled"]);
  });

  it("is always empty for every other item type", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      genericTextItem(0x10),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const sections = scanPhoenixSetupSections(templat, table);

    for (const item of sections[0].items) {
      expect(item.options).toEqual([]);
    }
  });
});

describe("scanPhoenixSetupSections", () => {
  it("finds one section from a contiguous run of valid item records", () => {
    const templat = concat(
      genericTextItem(0x10),
      pickFieldItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );
    const table = parsePhoenixStringTable(stringTableImage());

    const sections = scanPhoenixSetupSections(templat, table);

    expect(sections).toHaveLength(1);
    expect(sections[0].offset).toBe(0);
    expect(sections[0].items.map((item) => item.type)).toEqual([
      "generic-text",
      "pick-field",
      "time",
      "time",
      "time",
    ]);
    expect(sections[0].items[0].prompt).toBe("Main");
    expect(sections[0].items[1].prompt).toBe("Main");
    expect(sections[0].items[1].help).toBe("Enabled or Disabled");
    expect(sections[0].items[2].prompt).toBe("Main");
    expect(sections[0].items[2].help).toBe("Enabled or Disabled");
  });

  it("splits into separate sections when non-item bytes (e.g. embedded code) sit between two runs", () => {
    const firstSection = concat(genericTextItem(0x10), pickFieldItem(0x10, 0x12), timeItem(0x10, 0x12), timeItem(0x10, 0x12), timeItem(0x10, 0x12));
    // Bytes that don't frame as a valid item record anywhere in this span -
    // a real TEMPLAT.ROM carries exactly this kind of gap (observed to be
    // executable code) between two screens' item lists.
    const gap = new Uint8Array([0x55, 0x8b, 0xec, 0xe8, 0x02, 0x00, 0x5d, 0xcb, 0x33, 0xc0]);
    const secondSection = concat(pickFieldItem(0x10, 0x12), timeItem(0x10, 0x12), timeItem(0x10, 0x12), timeItem(0x10, 0x12), timeItem(0x10, 0x12));
    const templat = concat(firstSection, gap, secondSection);

    const sections = scanPhoenixSetupSections(templat, null);

    expect(sections).toHaveLength(2);
    expect(sections[0].offset).toBe(0);
    expect(sections[0].items).toHaveLength(5);
    expect(sections[1].offset).toBe(firstSection.length + gap.length);
    expect(sections[1].items).toHaveLength(5);
  });

  it("ignores a short run below the minimum section size (avoids false positives from incidental byte patterns)", () => {
    const templat = concat(genericTextItem(0x10), pickFieldItem(0x10, 0x12));

    expect(scanPhoenixSetupSections(templat, null)).toEqual([]);
  });
});

describe("buildPhoenixSetupMenu", () => {
  it("combines the string table and the item scan into one read-only menu", () => {
    const templat = concat(
      genericTextItem(0x10),
      pickFieldItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const menu = buildPhoenixSetupMenu(templat, stringTableImage());

    expect(menu.sections).toHaveLength(1);
    expect(menu.sections[0].items[0].prompt).toBe("Main");
  });
});
