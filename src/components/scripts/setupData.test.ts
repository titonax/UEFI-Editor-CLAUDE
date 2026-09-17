import { describe, expect, it } from "vitest";
import {
  SETUP_DATA_RECORD_BYTES,
  getAdditionalData,
  indexSetupData,
} from "./setupData";

// A record whose anchors match the opcode dump "00 00 AA BB CC DD EE FF":
// bytes 6..7 (EE FF) at the record start, bytes 4..5 (CC DD) at +20 and
// bytes 2..3 (AA BB) at +48.
function buildRecord(fill: Partial<Record<"pageId" | "accessLevel" | "failsafe" | "optimal", number[]>> = {}) {
  const record = new Uint8Array(SETUP_DATA_RECORD_BYTES);
  record.set([0xee, 0xff], 0);
  record.set(fill.pageId ?? [0x12, 0x34], 12);
  record[16] = fill.accessLevel?.[0] ?? 0x05;
  record.set([0xcc, 0xdd], 20);
  record.set([0xaa, 0xbb], 48);
  record[52] = fill.failsafe?.[0] ?? 0x01;
  record[53] = fill.optimal?.[0] ?? 0x02;
  return record;
}

function toHex(bytes: Uint8Array, lowercase = false) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return lowercase ? hex : hex.toUpperCase();
}

const OPCODE = "00 00 AA BB CC DD EE FF";

describe("indexSetupData", () => {
  it("keys every record-sized window by its first two bytes", () => {
    const bytes = new Uint8Array(SETUP_DATA_RECORD_BYTES + 2);
    bytes.set([0xee, 0xff], 0);
    bytes.set([0xee, 0xff], 2);
    const index = indexSetupData(toHex(bytes));

    expect(index.bytes.length).toBe(bytes.length);
    // Offsets 0 and 2 start with EE FF (2 + 54 still fits the buffer),
    // offset 1 with FF EE; offset 3 onwards can no longer hold a record.
    expect(index.offsetsByPrefix.get(0xeeff)).toEqual([0, 2]);
    expect(index.offsetsByPrefix.get(0xffee)).toEqual([1]);
    expect(index.offsetsByPrefix.get(0xff00)).toBeUndefined();
  });

  it("decodes nothing from malformed hex", () => {
    expect(indexSetupData("ABC").bytes.length).toBe(0);
    expect(indexSetupData("ZZZZ").bytes.length).toBe(0);
    expect(indexSetupData("").offsetsByPrefix.size).toBe(0);
  });
});

describe("getAdditionalData", () => {
  it("resolves an unaligned unique record, reporting bytes and their offsets", () => {
    const bytes = new Uint8Array(3 + SETUP_DATA_RECORD_BYTES);
    bytes.set(buildRecord(), 3);

    expect(getAdditionalData(OPCODE, indexSetupData(toHex(bytes)), true)).toEqual({
      pageId: "1234",
      accessLevel: "05",
      failsafe: "01",
      optimal: "02",
      offsets: {
        pageId: "0xF",
        accessLevel: "0x13",
        failsafe: "0x37",
        optimal: "0x38",
      },
    });
  });

  it("reports uppercase hex whatever the casing of the SetupData dump", () => {
    const result = getAdditionalData(
      OPCODE,
      indexSetupData(toHex(buildRecord({ pageId: [0xab, 0xcd], accessLevel: [0x0e] }), true)),
      true,
    );

    expect(result.pageId).toBe("ABCD");
    expect(result.accessLevel).toBe("0E");
  });

  it("omits the page id offset for a non-Ref question", () => {
    const result = getAdditionalData(OPCODE, indexSetupData(toHex(buildRecord())), false);

    expect(result.pageId).toBe("1234");
    expect(result.offsets).toEqual({
      accessLevel: "0x10",
      failsafe: "0x34",
      optimal: "0x35",
    });
  });

  it("keeps duplicate question metadata ambiguous", () => {
    const bytes = new Uint8Array(SETUP_DATA_RECORD_BYTES * 2);
    bytes.set(buildRecord(), 0);
    bytes.set(buildRecord(), SETUP_DATA_RECORD_BYTES);

    expect(getAdditionalData(OPCODE, indexSetupData(toHex(bytes)), false)).toEqual({
      pageId: null,
      accessLevel: null,
      failsafe: null,
      optimal: null,
      offsets: null,
    });
  });

  it("ignores a window that only matches the leading anchor", () => {
    const record = buildRecord();
    record.set([0x00, 0x00], 48);

    expect(getAdditionalData(OPCODE, indexSetupData(toHex(record)), true).offsets).toBeNull();
  });

  it("returns nothing for an opcode dump too short to anchor", () => {
    expect(getAdditionalData("0F 0F 01", indexSetupData(toHex(buildRecord())), true).offsets).toBeNull();
    expect(getAdditionalData("", indexSetupData(toHex(buildRecord())), true).pageId).toBeNull();
  });
});
