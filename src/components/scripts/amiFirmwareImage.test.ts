import { describe, expect, it } from "vitest";
import {
  inspectAmiFirmwareBytes,
  inspectAmiFirmwareImage,
  inspectAmiSetupProfile,
  legacyFrameworkHiiGuess,
  reconcileAmiGeneration,
  sniffNonAmiFailure,
} from "./amiFirmwareImage";

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

const setupFfsGuidBytes = hexBytes("D7079489FE99D8439A2179EC328CAC21");
const amitseFfsGuidBytes = hexBytes("DF0ADAB1774F7040A88EBFFE1C60529A");
const ffs2GuidBytes = hexBytes("78E58C8C3D8A1C4F9935896185C32DD3");

// A minimal, checksum-valid FFS2 firmware volume (0x100 bytes inside a
// 0x180 image). The shallow scan only looks for aligned signatures inside
// it - it doesn't need real FFS file/section structure - so payloads are
// dropped at caller-chosen offsets.
function firmwareVolumeImage(...payloads: { offset: number; bytes: Uint8Array }[]) {
  const bytes = new Uint8Array(0x180);
  const view = new DataView(bytes.buffer);
  bytes.set(ffs2GuidBytes, 0x10);
  view.setBigUint64(0x20, 0x100n, true);
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28);
  view.setUint16(0x30, 0x38, true);
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

const classicAmiImage = () =>
  firmwareVolumeImage(
    { offset: 0x40, bytes: setupFfsGuidBytes },
    { offset: 0x58, bytes: new TextEncoder().encode("AMITSESetup") },
  );

describe("inspectAmiFirmwareBytes", () => {
  it("detects AMI evidence without pretending shared GUIDs prove a generation", () => {
    const report = inspectAmiFirmwareBytes(classicAmiImage());

    expect(report.firmwareVolumes).toEqual([0]);
    expect(report.ffs2Volumes).toEqual([0]);
    expect(report.ffs3Volumes).toEqual([]);
    expect(report.setupFfs).toEqual([0x40]);
    expect(report.container).toBe("firmware-volume-image");
    expect(report.amiAptioCandidate).toBe(true);
    expect(report.generation).toBe("unresolved");
    expect(report.confidence).toBe("unresolved");
    expect(report.evidence.map((entry) => entry.code)).toEqual([
      "valid-fv",
      "amitse-setup",
      "classic-ami-modules",
    ]);
  });

  it("does not require a deep scan when both Setup and AMITSE FFS are visible", () => {
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage(
        { offset: 0x40, bytes: setupFfsGuidBytes },
        { offset: 0x60, bytes: amitseFfsGuidBytes },
      ),
    );

    expect(report.amitseFfs).toEqual([0x60]);
    expect(report.deepScanRequired).toBe(false);
    expect(report.nestedFirmwareCandidate).toBe(false);
  });

  // Setup and AMITSE can each independently be hidden behind GUID-defined
  // encapsulation: a deep scan is needed whenever either is missing from
  // this shallow byte-signature pass, not only when Setup is.
  it("requires a deep scan when Setup FFS is visible but AMITSE FFS is not", () => {
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage({ offset: 0x40, bytes: setupFfsGuidBytes }),
    );

    expect(report.amitseFfs).toEqual([]);
    expect(report.deepScanRequired).toBe(true);
  });

  it("flags a nested-firmware candidate when only AMI markers are visible", () => {
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage({
        offset: 0x58,
        bytes: new TextEncoder().encode("AMITSESetup"),
      }),
    );

    expect(report.setupFfs).toEqual([]);
    expect(report.nestedFirmwareCandidate).toBe(true);
    expect(report.deepScanRequired).toBe(true);
    expect(report.amiAptioCandidate).toBe(true);
  });

  it("accepts an explicit Aptio V marker as probable evidence", () => {
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage({ offset: 0x80, bytes: new TextEncoder().encode("Aptio V") }),
    );

    expect(report.generation).toBe("aptio-v");
    expect(report.confidence).toBe("probable");
    expect(report.evidence).toContainEqual(
      expect.objectContaining({ code: "explicit-generation", supports: "aptio-v" }),
    );
  });

  it("matches generation strings case-insensitively but refuses to pick between both", () => {
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage(
        { offset: 0x80, bytes: new TextEncoder().encode("aptio iv") },
        { offset: 0xa0, bytes: new TextEncoder().encode("APTIO 5") },
      ),
    );

    expect(report.generation).toBe("unresolved");
    expect(report.evidence).toContainEqual(
      expect.objectContaining({
        code: "explicit-generation",
        summary: "Conflicting Aptio generation strings",
      }),
    );
  });

  it("treats the $SPF SetupData profile as shared AMI evidence", () => {
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage(
        { offset: 0x80, bytes: new TextEncoder().encode("$SPF") },
        { offset: 0x90, bytes: hexBytes("722B61FE3C20B1478560A66D946EB371") },
      ),
    );

    expect(report.setupDataProfiles).toEqual([0x80]);
    expect(report.generation).toBe("unresolved");
    expect(report.evidence).toContainEqual(
      expect.objectContaining({
        code: "spf-profile",
        supports: "ami-aptio",
        strength: "strong",
      }),
    );
  });

  it("marks GUID-defined LZMA nesting as evidence for the deep scan", () => {
    const section = new Uint8Array(40);
    section.set([0x28, 0x00, 0x00, 0x02], 0);
    section.set(hexBytes("98584EEE143959429D6EDC7BD79403CF"), 4);
    new DataView(section.buffer).setUint16(20, 0x18, true); // DataOffset
    new DataView(section.buffer).setUint16(22, 0x01, true); // processing required
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage({ offset: 0x7c, bytes: section }),
    );

    expect(report.guidedLzmaSections).toEqual([0x7c]);
    expect(report.deepScanRequired).toBe(true);
    expect(report.evidence).toContainEqual(
      expect.objectContaining({
        code: "guided-lzma",
        summary: "1 LZMA GUID-defined section(s)",
      }),
    );
  });

  it("ignores the LZMA GUID when no consistent section header precedes it", () => {
    const report = inspectAmiFirmwareBytes(
      firmwareVolumeImage({
        offset: 0x80,
        bytes: hexBytes("98584EEE143959429D6EDC7BD79403CF"),
      }),
    );

    expect(report.guidedLzmaSections).toEqual([]);
  });

  it("rejects signature-shaped data with an invalid volume checksum", () => {
    const bytes = classicAmiImage();
    bytes[0] = 1;

    const report = inspectAmiFirmwareBytes(bytes);

    expect(report.firmwareVolumes).toEqual([]);
    expect(report.container).toBe("unknown");
    expect(report.deepScanRequired).toBe(false);
    expect(report.amiAptioCandidate).toBe(false);
  });

  it("recognizes an Intel flash descriptor container", () => {
    const bytes = new Uint8Array(0x40);
    bytes.set(hexBytes("5AA5F00F"), 0x10);

    const report = inspectAmiFirmwareBytes(bytes);

    expect(report.intelDescriptor).toBe(true);
    expect(report.container).toBe("intel-flash");
  });

  it("reads the image from a File", async () => {
    const report = await inspectAmiFirmwareImage(
      new File([classicAmiImage()], "image.bin"),
    );

    expect(report.size).toBe(0x180);
    expect(report.setupFfs).toEqual([0x40]);
  });

  it("guesses AMI Aptio as the vendor once it is a candidate, regardless of other strings", () => {
    const report = inspectAmiFirmwareBytes(classicAmiImage());

    expect(report.vendorGuess).toEqual({ family: "ami-aptio", label: "AMI Aptio", evidence: [] });
  });

  it("recognizes an Award/Phoenix-Award BIOS that is never an AMI Aptio candidate", () => {
    const bytes = new Uint8Array(0x60);
    bytes.set(new TextEncoder().encode("AwardBIOS"), 0x10);

    const report = inspectAmiFirmwareBytes(bytes);

    expect(report.amiAptioCandidate).toBe(false);
    expect(report.vendorGuess.family).toBe("award");
    expect(report.vendorGuess.evidence).toContain("AwardBIOS");
  });

  it("recognizes a Phoenix BIOS", () => {
    const bytes = new Uint8Array(0x60);
    bytes.set(new TextEncoder().encode("Phoenix Technologies"), 0x10);

    const report = inspectAmiFirmwareBytes(bytes);

    expect(report.vendorGuess.family).toBe("phoenix");
    expect(report.vendorGuess.evidence).toContain("Phoenix Technologies");
  });

  it("recognizes an Insyde H2O BIOS", () => {
    const bytes = new Uint8Array(0x60);
    bytes.set(new TextEncoder().encode("InsydeH2O"), 0x10);

    const report = inspectAmiFirmwareBytes(bytes);

    expect(report.vendorGuess.family).toBe("insyde");
    expect(report.vendorGuess.evidence).toContain("InsydeH2O");
  });

  it("recognizes embedded Linux firmware (router/IoT) as never having been a PC BIOS", () => {
    const bytes = new Uint8Array(0x60);
    bytes.set(new TextEncoder().encode("U-Boot"), 0x10);

    const report = inspectAmiFirmwareBytes(bytes);

    expect(report.vendorGuess).toEqual({
      family: "embedded-non-bios",
      label: "Embedded Linux firmware (router/IoT, not a PC BIOS)",
      evidence: ["U-Boot"],
    });
  });

  it("falls back to generic UEFI when firmware volumes exist but no vendor string matches", () => {
    const report = inspectAmiFirmwareBytes(firmwareVolumeImage());

    expect(report.amiAptioCandidate).toBe(false);
    expect(report.vendorGuess).toEqual({
      family: "uefi-generic",
      label: "Generic/unbranded UEFI (no AMI Aptio Setup found)",
      evidence: [],
    });
  });

  it("falls back to unknown when nothing at all is recognized", () => {
    const report = inspectAmiFirmwareBytes(new Uint8Array(0x40));

    expect(report.vendorGuess).toEqual({
      family: "unknown",
      label: "Unrecognized firmware",
      evidence: [],
    });
  });
});

describe("sniffNonAmiFailure", () => {
  it("recognizes all three structurally-understood non-AMI extraction failures", () => {
    expect(
      sniffNonAmiFailure("Setup FFS was not found after recursive decompression."),
    ).toBe(true);
    expect(
      sniffNonAmiFailure(
        "No Setup context contains a usable HII package or Setup PE32 section.",
      ),
    ).toBe(true);
    // ifrParser.ts's parseData throws this exact message for a Setup module
    // IFRExtractor-RS decoded as legacy Framework HII rather than UEFI HII
    // (seen on a pre-UEFI2.0 early-2010s ultrabook in the real corpus).
    expect(sniffNonAmiFailure("Only UEFI is supported.")).toBe(true);
  });

  it("does not flag an unrelated/unexpected error message", () => {
    expect(sniffNonAmiFailure("Extraction timed out after 90s.")).toBe(false);
  });

  it("exposes a distinct vendor guess for the legacy Framework HII case", () => {
    expect(legacyFrameworkHiiGuess.family).toBe("legacy-framework-hii");
  });
});

function guidBytes(value: string) {
  const parts = value.split("-");
  const reverse = (hex: string) => hex.match(/../g)?.reverse().join("") ?? "";
  return hexBytes(
    reverse(parts[0]) + reverse(parts[1]) + reverse(parts[2]) + parts[3] + parts[4],
  );
}

function formsPackage(guid: string, formId: number) {
  const bytes = new Uint8Array(37);
  bytes.set([37, 0, 0, 0x02], 0);
  bytes.set([0x0e, 0x97], 4);
  bytes.set(guidBytes(guid), 6);
  bytes.set([0x01, 0x86, formId & 0xff, formId >> 8, 0, 0], 27);
  bytes.set([0x29, 0x02, 0x29, 0x02], 33);
  return bytes;
}

function setupDataProfile() {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("$SPF"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 0x200, true);
  view.setUint32(8, 0x210, true);
  return bytes;
}

describe("inspectAmiSetupProfile", () => {
  it("recognizes the unified Aptio V Setup FormSet profile", () => {
    const report = inspectAmiSetupProfile(
      formsPackage("7B59104A-C00D-4158-87FF-F04D6396A915", 0x2710),
      setupDataProfile(),
    );

    expect(report).toMatchObject({
      spfPresent: true,
      spfField04: 0x200,
      spfField08: 0x210,
      formPackageCount: 1,
      formSetGuids: ["7B59104A-C00D-4158-87FF-F04D6396A915"],
      layout: "unified-setup-formset",
      generation: "aptio-v",
      confidence: "probable",
    });
    expect(report.evidence.map((entry) => entry.code)).toEqual([
      "spf-profile",
      "unified-setup-formset",
    ]);
    expect(report.evidence[0].detail).toContain(
      "field +0x04 0x0200, field +0x08 0x0210",
    );
  });

  it("recognizes the split multi-FormSet Aptio IV profile", () => {
    const first = formsPackage("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", 0x400);
    const second = formsPackage("BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", 0x401);
    const hii = Uint8Array.from([...first, ...second]);

    expect(inspectAmiSetupProfile(hii, setupDataProfile())).toMatchObject({
      formPackageCount: 2,
      layout: "split-form-packages",
      generation: "aptio-iv",
      confidence: "probable",
    });
  });

  it("leaves an unknown single FormSet unresolved", () => {
    expect(
      inspectAmiSetupProfile(formsPackage("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", 1)),
    ).toMatchObject({
      spfPresent: false,
      spfField04: null,
      formPackageCount: 1,
      layout: "unresolved",
      generation: "unresolved",
      confidence: "unresolved",
    });
  });

  it("reports nothing to classify when no Forms Package is found", () => {
    const report = inspectAmiSetupProfile(new Uint8Array(16));

    expect(report.formPackageCount).toBe(0);
    expect(report.evidence).toEqual([]);
  });
});

describe("reconcileAmiGeneration", () => {
  it("prefers the deep Setup profile when only it has an opinion", () => {
    expect(
      reconcileAmiGeneration(
        { generation: "unresolved", confidence: "unresolved" },
        { generation: "aptio-v", confidence: "probable" },
      ),
    ).toEqual({ generation: "aptio-v", confidence: "probable", conflict: false });
  });

  it("keeps the outer assessment without a Setup profile", () => {
    expect(
      reconcileAmiGeneration({ generation: "aptio-iv", confidence: "probable" }),
    ).toEqual({ generation: "aptio-iv", confidence: "probable", conflict: false });
  });

  it("does not hide a conflict between outer metadata and the deep HII profile", () => {
    expect(
      reconcileAmiGeneration(
        { generation: "aptio-iv", confidence: "probable" },
        { generation: "aptio-v", confidence: "probable" },
      ),
    ).toEqual({ generation: "unresolved", confidence: "unresolved", conflict: true });
  });
});
