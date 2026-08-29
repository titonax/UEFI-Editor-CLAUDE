import { describe, expect, it } from "vitest";
import { normalizedHexId, parseHexId, sameHexId } from "./hexId";

describe("parseHexId", () => {
  it("parses 0x-prefixed hex strings", () => {
    expect(parseHexId("0x0001")).toBe(1);
    expect(parseHexId("0xFF")).toBe(255);
  });

  it("does not misread a value as octal or decimal", () => {
    // Without an explicit radix, parseInt("010") would already be decimal
    // in modern JS, but a bare "08"/"09" is exactly the case an implicit
    // radix can get wrong on some engines - pin the intended base 16.
    expect(parseHexId("08")).toBe(8);
    expect(parseHexId("0x08")).toBe(8);
  });
});

describe("sameHexId", () => {
  it("treats differently-formatted equal ids as equal", () => {
    expect(sameHexId("0x0001", "0x1")).toBe(true);
    expect(sameHexId("0x01", "0x0001")).toBe(true);
  });

  it("distinguishes different ids", () => {
    expect(sameHexId("0x0001", "0x0002")).toBe(false);
  });
});

describe("normalizedHexId", () => {
  it("normalizes to a plain decimal string", () => {
    expect(normalizedHexId("0x0001")).toBe("1");
    expect(normalizedHexId("0x000A")).toBe("10");
  });

  it("falls back to the original string when unparsable", () => {
    expect(normalizedHexId("not-a-number")).toBe("not-a-number");
  });
});
