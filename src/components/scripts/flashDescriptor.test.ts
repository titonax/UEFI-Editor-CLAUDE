import { describe, expect, it } from "vitest";
import { biosRegionOf } from "./flashDescriptor";
import { patternBytes, spiImage } from "./firmwareImageFixtures";

describe("biosRegionOf", () => {
  it("reports no region constraint for an image without an Intel descriptor", () => {
    expect(biosRegionOf(patternBytes(0x2000, 1))).toEqual({ kind: "none" });
  });

  it("reads the BIOS region the descriptor declares", () => {
    const image = spiImage(patternBytes(0x3000, 1));

    expect(biosRegionOf(image)).toEqual({ kind: "region", start: 0x1000, end: 0x4000 });
  });

  it("follows a descriptor that declares a smaller BIOS region", () => {
    const image = spiImage(patternBytes(0x3000, 1), { biosBaseBlock: 2, biosLimitBlock: 2 });

    expect(biosRegionOf(image)).toEqual({ kind: "region", start: 0x2000, end: 0x3000 });
  });

  it("says why it cannot read the region, instead of guessing one", () => {
    const broken = biosRegionOf(spiImage(patternBytes(0x3000, 1), { brokenMap: true }));
    const disabled = biosRegionOf(spiImage(patternBytes(0x3000, 1), { biosBaseBlock: 3, biosLimitBlock: 1 }));
    const beyond = biosRegionOf(spiImage(patternBytes(0x3000, 1), { biosLimitBlock: 40 }));

    expect(broken).toMatchObject({ kind: "invalid" });
    expect(disabled).toMatchObject({ kind: "invalid" });
    expect(beyond).toMatchObject({ kind: "invalid" });
    for (const result of [broken, disabled, beyond]) {
      if (result.kind === "invalid") expect(result.reason.length).toBeGreaterThan(10);
    }
  });
});
