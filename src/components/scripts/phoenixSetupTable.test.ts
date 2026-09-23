import { describe, expect, it } from "vitest";
import {
  buildPhoenixSetupMenu,
  forceItemsVisible,
  parsePhoenixRootTable,
  parsePhoenixStringTable,
  resolvePhoenixString,
  scanPhoenixSetupSections,
  toPbeModuleBytes,
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

// A Date record: type(1) + length(1) + promptRef(2) + helpRef(2) + 4 bytes
// of filler - confirmed against a real "System Date:" record (type 0x20,
// length 10), the Main screen's companion to a Time record (type 0x21).
function dateItem(promptRef: number, helpRef: number) {
  const bytes = new Uint8Array(10);
  bytes[0] = 0x20;
  bytes[1] = 10;
  new DataView(bytes.buffer).setUint16(2, promptRef, true);
  new DataView(bytes.buffer).setUint16(4, helpRef, true);
  return bytes;
}

// An Action record: type(1) + length(1) + promptRef(2) + helpRef(2) + up to
// 12 bytes of unconfirmed trailing data (kept as rawBytes, never guessed
// at as options) - confirmed against real Security ("Set Supervisor
// Password", type 0x22, length 18) and Exit ("Exit Saving Changes", type
// 0x24, length 14) records: a triggerable action with no editable value of
// its own.
function actionItem(promptRef: number, helpRef: number, typeByte: 0x22 | 0x24, length: number) {
  const bytes = new Uint8Array(length);
  bytes[0] = typeByte;
  bytes[1] = length;
  new DataView(bytes.buffer).setUint16(2, promptRef, true);
  new DataView(bytes.buffer).setUint16(4, helpRef, true);
  return bytes;
}

// A Boot Device Slot record: type(1) + length(1) + 12 bytes of unconfirmed
// data, no string reference of its own - confirmed against the real Boot
// screen's device-slot entries (type 0x27, length 14): the actual device
// name isn't static text Phoenix could store at ROM-build time, since it
// depends on what's plugged in at boot.
function bootDeviceSlotItem() {
  const bytes = new Uint8Array(14);
  bytes[0] = 0x27;
  bytes[1] = 14;
  return bytes;
}

// A Generic Text record carrying the real visibility-callback hook in its
// own last 4 bytes: type(1) + length(1) + stringRef(2) + reserved(2) +
// callbackPointer(2, PBE-relative) + hidePatchOffset(2, raw). Confirmed
// field-for-field against the real "Intel" item this mechanism was
// disassembled from - see PhoenixVisibilityPatch's own doc comment and
// docs/phoenix/README.md's "Menu visibility" section.
function genericTextItemWithVisibilityHook(stringRef: number, callbackRaw: number, hidePatchRaw: number) {
  const bytes = new Uint8Array(10);
  bytes[0] = 0x10;
  bytes[1] = 10;
  const view = new DataView(bytes.buffer);
  view.setUint16(2, stringRef, true);
  view.setUint16(6, callbackRaw - 4, true);
  view.setUint16(8, hidePatchRaw, true);
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

describe("date / action / boot-device-slot item types", () => {
  it("parses a Date record (type 0x20) with the same prompt/help shape as Time", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      dateItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const sections = scanPhoenixSetupSections(templat, table);

    expect(sections[0].items[0].type).toBe("date");
    expect(sections[0].items[0].prompt).toBe("Main");
    expect(sections[0].items[0].help).toBe("Enabled or Disabled");
    expect(sections[0].items[0].options).toEqual([]);
  });

  it("parses an Action record (types 0x22 and 0x24) with a resolved prompt/help and no options", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      actionItem(0x10, 0x12, 0x22, 18),
      actionItem(0x10, 0x12, 0x24, 14),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const sections = scanPhoenixSetupSections(templat, table);

    expect(sections[0].items[0].type).toBe("action");
    expect(sections[0].items[0].prompt).toBe("Main");
    expect(sections[0].items[0].help).toBe("Enabled or Disabled");
    expect(sections[0].items[0].options).toEqual([]);
    expect(sections[0].items[1].type).toBe("action");
  });

  it("parses a Boot Device Slot record (type 0x27) with no prompt or help - the device name isn't static text", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      bootDeviceSlotItem(),
      bootDeviceSlotItem(),
      bootDeviceSlotItem(),
      bootDeviceSlotItem(),
      bootDeviceSlotItem(),
    );

    const sections = scanPhoenixSetupSections(templat, table);

    expect(sections[0].items[0].type).toBe("boot-device-slot");
    expect(sections[0].items[0].prompt).toBeNull();
    expect(sections[0].items[0].help).toBeNull();
    expect(sections[0].items[0].options).toEqual([]);
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
  it("combines the string table and the item scan into one read-only menu, falling back to the contiguous-run scan when there's no root table", () => {
    const templat = concat(
      genericTextItem(0x10),
      pickFieldItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const menu = buildPhoenixSetupMenu(templat, stringTableImage());

    expect(menu.source).toBe("contiguous-scan");
    expect(menu.sections).toHaveLength(1);
    expect(menu.sections[0].name).toBeNull();
    expect(menu.sections[0].items[0].prompt).toBe("Main");
  });
});

// Field/pointer layout below mirrors TEMPLAT.ROM's real root/tab table
// (Phoenix BIOS Editor offset 0x0068), confirmed against two independent
// real firmware samples - see parsePhoenixRootTable's own doc comment.
// Every pointer field here (the root field's own value, and every
// label/content/item pointer the table holds) is PBE-relative: `raw - 4`,
// exactly like a string reference.
const ROOT_FIELD_RAW_OFFSET = 0x6c;

function writeU16(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

// Builds a synthetic TEMPLAT.ROM whose root table has two tabs, each
// pointing (via its content list) at item records placed well away from
// both the tab array and each other - proving the root table resolves a
// tab's real items even when they aren't physically contiguous, exactly
// like a real image (see readTabItems's doc comment).
function rootTableTemplat() {
  const bytes = new Uint8Array(0x100);

  // Root field (raw 0x6c, fixed) holds a PBE pointer to the tab array at
  // raw 0x30. Every other block below is placed with a wide enough gap
  // that nothing overlaps raw 0x6c/0x6d - a real record placed across that
  // boundary would silently corrupt the root field itself.
  writeU16(bytes, ROOT_FIELD_RAW_OFFSET, 0x30 - 4);

  // Tab 0: label "Main" at raw 0x10, content list at raw 0xc0.
  bytes.set(genericTextItem(0x10), 0x10);
  writeU16(bytes, 0x30, 0x10 - 4); // label pointer
  writeU16(bytes, 0x32, 0xc0 - 4); // content pointer
  // Tab 1: label "Main" at raw 0x20 (reusing the same string, a second
  // record so both tabs are independently addressable), content at 0xf0.
  bytes.set(genericTextItem(0x10), 0x20);
  writeU16(bytes, 0x34, 0x20 - 4);
  writeU16(bytes, 0x36, 0xf0 - 4);
  // (0, 0) end-of-table sentinel.
  writeU16(bytes, 0x38, 0);
  writeU16(bytes, 0x3a, 0);

  // Tab 0's items: a Pick Field at raw 0x90 and a Time record at raw 0xb0 -
  // not contiguous with each other or with the content list itself.
  bytes.set(pickFieldItem(0x10, 0x12, 20, [0x14, 0x16]), 0x90);
  bytes.set(timeItem(0x10, 0x12), 0xb0);
  writeU16(bytes, 0xc0, 0x90 - 4);
  writeU16(bytes, 0xc2, 0);
  writeU16(bytes, 0xc4, 0xb0 - 4);
  writeU16(bytes, 0xc6, 0);
  writeU16(bytes, 0xc8, 0); // end-of-list sentinel

  // Tab 1's items: a single Date record at raw 0xe0.
  bytes.set(dateItem(0x10, 0x12), 0xe0);
  writeU16(bytes, 0xf0, 0xe0 - 4);
  writeU16(bytes, 0xf2, 0);
  writeU16(bytes, 0xf4, 0); // end-of-list sentinel

  return bytes;
}

describe("parsePhoenixRootTable", () => {
  it("resolves each tab's real name and its non-contiguous item list", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = rootTableTemplat();

    const sections = parsePhoenixRootTable(templat, table);

    expect(sections).not.toBeNull();
    expect(sections).toHaveLength(2);
    expect(sections?.[0].name).toBe("Main");
    expect(sections?.[0].items.map((item) => item.type)).toEqual(["pick-field", "time"]);
    expect(sections?.[0].items[0].options).toEqual(["Disabled", "Enabled"]);
    expect(sections?.[1].name).toBe("Main");
    expect(sections?.[1].items.map((item) => item.type)).toEqual(["date"]);
  });

  it("returns null when the root field is zero, so callers fall back to the contiguous-run scan", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = new Uint8Array(0x100); // root field left at 0

    expect(parsePhoenixRootTable(templat, table)).toBeNull();
  });
});

describe("buildPhoenixSetupMenu with a root table", () => {
  it("prefers the root table's real tab names and item membership over the contiguous-run scan", () => {
    const table = stringTableImage();
    const templat = rootTableTemplat();

    const menu = buildPhoenixSetupMenu(templat, table);

    expect(menu.source).toBe("root-table");
    expect(menu.sections).toHaveLength(2);
    expect(menu.sections[0].name).toBe("Main");
    expect(menu.sections[1].name).toBe("Main");
  });
});

describe("visibility-callback patch (forceItemsVisible)", () => {
  const CALLBACK_RAW = 0x60;
  const HIDE_PATCH_RAW = 0x70;

  // A hidden item (the hook's structural checks both pass) followed by 4
  // plain items, so scanPhoenixSetupSections's 5-item minimum finds it as
  // a section - the callback stub and patch target sit well past the item
  // records themselves, exactly like real TEMPLAT.ROM (see
  // readTabItems's own doc comment on items never being contiguous with
  // what references them).
  function templatWithHiddenItem() {
    const items = concat(
      genericTextItemWithVisibilityHook(0x10, CALLBACK_RAW, HIDE_PATCH_RAW),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );
    const bytes = new Uint8Array(0x80);
    bytes.set(items, 0);
    bytes[CALLBACK_RAW] = 0x55; // push bp - a real function prologue
    bytes[CALLBACK_RAW + 1] = 0x89; // mov bp, sp - harmless filler
    bytes[CALLBACK_RAW + 2] = 0xe5;
    bytes[HIDE_PATCH_RAW] = 0xb8; // mov ax, imm16
    bytes[HIDE_PATCH_RAW + 1] = 0x13; // the "hidden" sentinel's low byte
    bytes[HIDE_PATCH_RAW + 2] = 0x00;
    return bytes;
  }

  it("detects the hook via its two structural checks: a real callback prologue and a mov-ax-imm16 opcode", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = templatWithHiddenItem();

    const sections = scanPhoenixSetupSections(templat, table);
    const item = sections[0].items[0];

    expect(item.visibilityPatch).toEqual({
      callbackOffset: CALLBACK_RAW,
      hidePatchOffset: HIDE_PATCH_RAW,
      hiddenImmediate: 0x13,
    });
  });

  it("is null for an item that doesn't carry the hook", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      genericTextItem(0x10),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );

    const sections = scanPhoenixSetupSections(templat, table);

    expect(sections[0].items[0].visibilityPatch).toBeNull();
  });

  it("overwrites only the hide path's immediate operand, never mutating the input buffer", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = templatWithHiddenItem();
    const sections = scanPhoenixSetupSections(templat, table);
    const item = sections[0].items[0];

    const patched = forceItemsVisible(templat, [item]);

    expect(Array.from(patched.subarray(HIDE_PATCH_RAW, HIDE_PATCH_RAW + 3))).toEqual([0xb8, 0x00, 0x00]);
    expect(templat[HIDE_PATCH_RAW + 1]).toBe(0x13); // the input buffer is untouched
    let diffCount = 0;
    for (let i = 0; i < templat.length; i++) {
      if (templat[i] !== patched[i]) diffCount++;
    }
    // Only the immediate's low byte actually differs - its high byte was
    // already 0, exactly like the real "Intel" item's own confirmed patch.
    expect(diffCount).toBe(1);
  });

  it("skips an item with no detected hook rather than throwing", () => {
    const table = parsePhoenixStringTable(stringTableImage());
    const templat = concat(
      genericTextItem(0x10),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
      timeItem(0x10, 0x12),
    );
    const sections = scanPhoenixSetupSections(templat, table);

    const patched = forceItemsVisible(templat, sections[0].items);

    expect(patched).toEqual(templat);
  });
});

describe("toPbeModuleBytes", () => {
  it("strips the 4-byte LH5-container header this codebase's decompression keeps but PBE's own extracted module never has", () => {
    const templat = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0x01, 0x02, 0x03]);

    expect(Array.from(toPbeModuleBytes(templat))).toEqual([0x01, 0x02, 0x03]);
  });
});
