import { describe, expect, it } from "vitest";
import {
  AWARD_ITEM_FLAG_HIDDEN,
  AWARD_ITEM_RECORD_BYTES,
  decodeAwardItemTable,
  summarizeAwardItemPages,
} from "./awardItemTable";

interface Fields {
  flags?: number;
  id: number;
  group?: number;
  mode?: number;
  mask: number;
  cmos: number;
  maxValue?: number;
  page: number;
  column?: number;
  failSafe?: number;
  optimal?: number;
}

function table(records: Fields[], header = "_ITEM.BIN") {
  const bytes = new Uint8Array(0x10 + records.length * AWARD_ITEM_RECORD_BYTES + 8);
  bytes.set(new TextEncoder().encode(header));
  records.forEach((fields, index) => {
    // The first record's flags word sits right after the 16-byte header.
    const base = 0x10 + index * AWARD_ITEM_RECORD_BYTES;
    const view = new DataView(bytes.buffer);
    view.setUint16(base, fields.flags ?? 0, true);
    bytes[base + 2] = fields.id;
    bytes[base + 3] = fields.group ?? 1;
    bytes[base + 4] = 0x81;
    bytes[base + 5] = fields.mode ?? 0xf8;
    view.setUint16(base + 6, fields.mask, true);
    bytes[base + 8] = fields.cmos;
    view.setUint16(base + 9, fields.mask, true);
    view.setUint16(base + 0x0f, fields.maxValue ?? 1, true);
    view.setUint16(base + 0x11, (fields.page & 0x3f) | ((fields.column ?? 0) << 6) | 0x200, true);
    view.setUint16(base + 0x13, fields.failSafe ?? 0, true);
    view.setUint16(base + 0x15, fields.optimal ?? 0, true);
  });
  return bytes;
}

describe("decodeAwardItemTable", () => {
  it("decodes the fields at the offsets the setup code reads them from", () => {
    const decoded = decodeAwardItemTable(
      table([
        { id: 7, group: 4, mask: 0x0f, cmos: 0x65, maxValue: 8, page: 3, column: 10, failSafe: 1, optimal: 2 },
        { id: 8, group: 4, mask: 0xf0, cmos: 0x65, maxValue: 8, page: 3, failSafe: 3, optimal: 3 },
      ]),
    );
    expect(decoded?.records).toHaveLength(2);
    expect(decoded?.records[0]).toMatchObject({
      id: 7,
      group: 4,
      mask: 0x0f,
      cmosAddress: 0x65,
      maxValue: 8,
      page: 3,
      column: 10,
      failSafe: 1,
      optimal: 2,
      hidden: false,
    });
    expect(decoded?.explainedBytes).toBe(2 * AWARD_ITEM_RECORD_BYTES);
  });

  it("reports the statically hidden bit and virtual items with no CMOS byte", () => {
    const decoded = decodeAwardItemTable(
      table([
        { id: 1, mask: 0x01, cmos: 0x3c, page: 4 },
        { id: 2, mask: 0x01, cmos: 0xfd, page: 4, flags: AWARD_ITEM_FLAG_HIDDEN | 0x4 },
      ]),
    );
    expect(decoded?.records[1]).toMatchObject({ hidden: true, cmosAddress: null, flags: 0xc });
    expect(decoded?.records[0].hidden).toBe(false);
  });

  it("summarizes items and hidden items per page, in page order", () => {
    const decoded = decodeAwardItemTable(
      table([
        { id: 1, mask: 1, cmos: 0x3c, page: 12 },
        { id: 2, mask: 1, cmos: 0x3d, page: 3, flags: AWARD_ITEM_FLAG_HIDDEN },
        { id: 3, mask: 2, cmos: 0x3d, page: 12 },
      ]),
    );
    expect(decoded && summarizeAwardItemPages(decoded)).toEqual([
      { page: 3, items: 1, hidden: 1 },
      { page: 12, items: 2, hidden: 0 },
    ]);
  });

  it("refuses a module that is not named _ITEM.BIN or holds no record", () => {
    expect(decodeAwardItemTable(table([{ id: 1, mask: 1, cmos: 0x3c, page: 1 }], "_DMI.BIN"))).toBeNull();
    expect(decodeAwardItemTable(table([]))).toBeNull();
    expect(decodeAwardItemTable(new Uint8Array(4))).toBeNull();
  });
});
