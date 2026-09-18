import { describe, expect, it } from "vitest";
import { decodeControlFlags, describeControlFlags } from "./setupDataFlags";

describe("decodeControlFlags", () => {
  it("decodes the seven values seen across the reference corpus", () => {
    expect(decodeControlFlags("01")).toEqual({ value: 1, bits: [0] });
    expect(decodeControlFlags("09")).toEqual({ value: 9, bits: [0, 3] });
    expect(decodeControlFlags("11")).toEqual({ value: 0x11, bits: [0, 4] });
    expect(decodeControlFlags("21")).toEqual({ value: 0x21, bits: [0, 5] });
    expect(decodeControlFlags("29")).toEqual({ value: 0x29, bits: [0, 3, 5] });
    expect(decodeControlFlags("41")).toEqual({ value: 0x41, bits: [0, 6] });
    expect(decodeControlFlags("49")).toEqual({ value: 0x49, bits: [0, 3, 6] });
  });

  it("returns null for no record or malformed input", () => {
    expect(decodeControlFlags(null)).toBeNull();
    expect(decodeControlFlags("zz")).toBeNull();
    expect(decodeControlFlags("123")).toBeNull();
  });

  it("describes the flags without claiming a verdict", () => {
    expect(describeControlFlags("29")).toBe(
      "SetupData control flags 0x29: bits 0, 3, 5 set. This byte's meaning is not established - see docs/ami/setupdata-control-flags.md - and is reported for reference only.",
    );
    expect(describeControlFlags(null)).toBe("No SetupData control record was matched for this item.");
  });
});
