import { describe, expect, it } from "vitest";
import { inspectAptioIvImage } from "./aptioIvImage";

const setupFfsGuidBytes = Uint8Array.from(
  "D7079489FE99D8439A2179EC328CAC21".match(/../g) ?? [],
  (pair) => Number.parseInt(pair, 16),
);
const amitseFfsGuidBytes = Uint8Array.from(
  "DF0ADAB1774F7040A88EBFFE1C60529A".match(/../g) ?? [],
  (pair) => Number.parseInt(pair, 16),
);

// A minimal, checksum-valid firmware volume header (the shallow pre-scan
// only looks for aligned GUID signatures inside it - it doesn't need real
// FFS file/section structure). Setup and/or AMITSE FFS signatures are
// placed at caller-chosen 8-byte-aligned offsets inside the volume body.
function firmwareVolumeImage(payloads: { offset: number; bytes: Uint8Array }[]) {
  const bytes = new Uint8Array(0x100);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0x20, 0x100n, true); // volume length
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28); // "_FVH"
  view.setUint16(0x30, 0x38, true); // header length

  for (const payload of payloads) {
    bytes.set(payload.bytes, payload.offset);
  }

  let checksum = 0;
  for (let offset = 0; offset < 0x38; offset += 2) {
    checksum = (checksum + view.getUint16(offset, true)) & 0xffff;
  }
  view.setUint16(0x32, -checksum & 0xffff, true);
  return bytes;
}

function fileFrom(bytes: Uint8Array) {
  return new File([bytes], "image.bin");
}

describe("inspectAptioIvImage", () => {
  it("does not require a deep scan when both Setup and AMITSE FFS are visible", async () => {
    const bytes = firmwareVolumeImage([
      { offset: 0x40, bytes: setupFfsGuidBytes },
      { offset: 0x60, bytes: amitseFfsGuidBytes },
    ]);

    const report = await inspectAptioIvImage(fileFrom(bytes));

    expect(report.setupFfs).toEqual([0x40]);
    expect(report.amitseFfs).toEqual([0x60]);
    expect(report.deepScanRequired).toBe(false);
  });

  // Setup and AMITSE can each independently be hidden behind GUID-defined
  // encapsulation (see firmwareSections.ts / the aptioIvExtractor deep
  // scan): a deep scan is needed whenever either is missing from this
  // shallow byte-signature pass, not only when Setup is.
  it("requires a deep scan when Setup FFS is visible but AMITSE FFS is not", async () => {
    const bytes = firmwareVolumeImage([{ offset: 0x40, bytes: setupFfsGuidBytes }]);

    const report = await inspectAptioIvImage(fileFrom(bytes));

    expect(report.setupFfs).toEqual([0x40]);
    expect(report.amitseFfs).toEqual([]);
    expect(report.deepScanRequired).toBe(true);
  });

  it("requires a deep scan when neither Setup nor AMITSE FFS is visible", async () => {
    const bytes = firmwareVolumeImage([]);

    const report = await inspectAptioIvImage(fileFrom(bytes));

    expect(report.setupFfs).toEqual([]);
    expect(report.amitseFfs).toEqual([]);
    expect(report.deepScanRequired).toBe(true);
  });

  it("does not require a deep scan when there is no firmware volume at all", async () => {
    const report = await inspectAptioIvImage(fileFrom(new Uint8Array(0x40)));

    expect(report.firmwareVolumes).toEqual([]);
    expect(report.deepScanRequired).toBe(false);
  });
});
