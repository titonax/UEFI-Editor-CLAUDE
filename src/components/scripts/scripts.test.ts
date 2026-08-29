import { describe, expect, it, vi } from "vitest";
import {
  calculateJsonChecksum,
  downloadModifiedFiles,
  parseData,
  validateByteInput,
  version,
} from "./scripts";
import type { PopulatedFiles } from "../FileUploads/FileUploads";

const saveAsMock = vi.fn();
vi.mock("file-saver", () => ({
  saveAs: (blob: Blob, name: string) => {
    saveAsMock(blob, name);
  },
}));

describe("validateByteInput", () => {
  it("accepts an empty string", () => {
    expect(validateByteInput("")).toBe(true);
  });

  it("accepts one or two hex digits, any case", () => {
    expect(validateByteInput("A")).toBe(true);
    expect(validateByteInput("ab")).toBe(true);
    expect(validateByteInput("F0")).toBe(true);
  });

  it("rejects more than two characters", () => {
    expect(validateByteInput("ABC")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(validateByteInput("G0")).toBe(false);
    expect(validateByteInput("Z")).toBe(false);
  });
});

describe("calculateJsonChecksum", () => {
  it("is deterministic for the same inputs", async () => {
    const menu = [{ name: "Main", formId: "0x1", offset: "0x10" }];
    const forms = [
      {
        name: "Main",
        type: "Form" as const,
        formId: "0x1",
        referencedIn: [],
        children: [],
      },
    ];
    const first = await calculateJsonChecksum(menu, forms, []);
    const second = await calculateJsonChecksum(menu, forms, []);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when an offset changes", async () => {
    const forms = [
      {
        name: "Main",
        type: "Form" as const,
        formId: "0x1",
        referencedIn: [],
        children: [],
      },
    ];
    const before = await calculateJsonChecksum(
      [{ name: "Main", formId: "0x1", offset: "0x10" }],
      forms,
      [],
    );
    const after = await calculateJsonChecksum(
      [{ name: "Main", formId: "0x1", offset: "0x12" }],
      forms,
      [],
    );
    expect(before).not.toBe(after);
  });
});

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Builds a minimal-but-representative IFRExtractor-RS "verbose" dump: one
// FormSet with two Forms sharing a VarStore. Form 1 has a CheckBox hidden
// behind an always-true SuppressIf, a Numeric with a default, a OneOf with
// two options, and a Ref pointing at Form 2 - enough to exercise the scope
// stack, suppression bookkeeping, and cross-form reference tracking that
// `parseData` relies on.
async function buildFixtureFiles(): Promise<PopulatedFiles> {
  const formSetGuid = "12345678-1234-1234-1234-123456789ABC";

  const lines = [
    `0x00000010: FormSet Guid: ${formSetGuid}, Title: "Main Setup", Help: "Root help"`,
    `0x00000012: VarStore Guid: 87654321-4321-4321-4321-CBA987654321, VarStoreId: 0x0001, Size: 0x0010, Name: "Setup" {`,
    `0x00000014: Form FormId: 0x1, Title: "Main Page" { 01 86 }`,
    `0x00000016: \tSuppressIf { 05 82 }`,
    `0x00000018: \t\tTrue { 01 06 }`,
    `0x0000001A: \t\tCheckBox Prompt: "Enable Feature", Help: "Toggles feature", QuestionFlags: 0x00, QuestionId: 0x0001, VarStoreId: 0x0001, VarOffset: 0x0000, Flags: 0x00 { 06 86 }`,
    `0x0000001C: \t\tEnd { 29 02 }`,
    `0x0000001E: \tEnd { 29 02 }`,
    `0x00000020: \tNumeric Prompt: "Numeric Value", Help: "A number", QuestionFlags: 0x00, QuestionId: 0x0002, VarStoreId: 0x0001, VarOffset: 0x0001, Flags: 0x00, Size: 0x01, Min: 0x00, Max: 0x0A, Step: 0x01 { 07 86 }`,
    `0x00000022: \t\tDefault DefaultId: 0x0000 Value: 0x05 {`,
    `0x00000024: \tEnd { 29 02 }`,
    `0x00000026: \tOneOf Prompt: "Choice", Help: "Pick one", QuestionFlags: 0x00, QuestionId: 0x0003, VarStoreId: 0x0001, VarOffset: 0x0002, Flags: 0x00, Size: 0x01, Min: 0x00, Max: 0x02, Step: 0x01 { 08 86 }`,
    `0x00000028: \t\tOneOfOption Option: "Option A" Value: 0x00 {`,
    `0x0000002A: \t\tOneOfOption Option: "Option B" Value: 0x01 {`,
    `0x0000002C: \tEnd { 29 02 }`,
    `0x0000002E: \tRef Prompt: "Go to Advanced", Help: "Advanced settings", QuestionFlags: 0x00, QuestionId: 0x0004, VarStoreId: 0x0001, VarStoreInfo: 0x0000, FormId: 0x2, FormSetGuid: ${formSetGuid} { 09 06 }`,
    `0x00000030: End { 29 02 }`,
    `0x00000032: Form FormId: 0x2, Title: "Advanced Page" { 01 86 }`,
    `0x00000034: End { 29 02 }`,
  ];

  const setupSctBytes = new TextEncoder().encode("dummy-setup-sct-bytes");
  const setupSctHash = await sha256Hex(setupSctBytes);

  const setupTxt = [
    "Program version: 1.6.1",
    "Extraction mode: UEFI",
    `SHA256: ${setupSctHash}`,
    ...lines,
  ].join("\n");

  const setupdataBin = "00000000";
  const amitseSct = "";

  return {
    setupTxtContainer: {
      file: new File([setupTxt], "combined-1-ifr-outputs.txt"),
      textContent: setupTxt,
      isWrongFile: false,
    },
    setupSctContainer: {
      file: new File([setupSctBytes], "SetupSct.sct"),
      textContent: Array.from(setupSctBytes, (byte) =>
        byte.toString(16).toUpperCase().padStart(2, "0"),
      ).join(""),
      isWrongFile: false,
    },
    amitseSctContainer: {
      file: new File([], "AmiTseSct.sct"),
      textContent: amitseSct,
      isWrongFile: false,
    },
    setupdataBinContainer: {
      file: new File([], "SetupDataVar.bin"),
      textContent: setupdataBin,
      isWrongFile: false,
    },
  };
}

describe("parseData", () => {
  it("parses forms, suppressions, and cross-form references from a verbose IFR dump", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    expect(data.version).toBe(version);
    expect(data.firmwareFamily).toBe("aptio-v");
    expect(data.varStores).toEqual([
      {
        varStoreId: "0x0001",
        size: "0x0010",
        name: "Setup",
        formSetGuid: "12345678-1234-1234-1234-123456789ABC",
      },
    ]);

    expect(data.forms).toHaveLength(2);
    const form1 = data.forms.find((form) => form.formId === "0x1");
    const form2 = data.forms.find((form) => form.formId === "0x2");
    if (!form1 || !form2) throw new Error("expected both forms to be parsed");

    expect(form1.children).toHaveLength(4);

    const checkBox = form1.children.find((child) => child.type === "CheckBox");
    if (!checkBox) {
      throw new Error("expected a CheckBox child");
    }
    expect(checkBox.name).toBe("Enable Feature");
    expect(checkBox.questionId).toBe("0x0001");
    expect(checkBox.varStoreName).toBe("Setup");
    expect(checkBox.conditions).toEqual(["0x00000016"]);
    expect(checkBox.suppressIf).toEqual(["0x00000016"]);
    // No matching byte pattern exists in the (deliberately tiny) SetupData
    // fixture, so the access-level/failsafe/optimal lookup must degrade to
    // null instead of throwing.
    expect(checkBox.accessLevel).toBeNull();
    expect(checkBox.offsets).toBeNull();

    const numeric = form1.children.find((child) => child.type === "Numeric");
    if (!numeric) {
      throw new Error("expected a Numeric child");
    }
    expect(numeric.min).toBe("0x00");
    expect(numeric.max).toBe("0x0A");
    expect(numeric.defaults).toEqual([{ defaultId: "0x0000", value: "0x05" }]);
    expect(numeric.conditions).toBeUndefined();

    const oneOf = form1.children.find((child) => child.type === "OneOf");
    if (!oneOf) {
      throw new Error("expected a OneOf child");
    }
    expect(oneOf.options).toEqual([
      { option: "Option A", value: "0x00" },
      { option: "Option B", value: "0x01" },
    ]);

    const ref = form1.children.find((child) => child.type === "Ref");
    if (!ref) {
      throw new Error("expected a Ref child");
    }
    expect(ref.formId).toBe("0x2");
    expect(ref.targetFormSetGuid).toBe("12345678-1234-1234-1234-123456789ABC");

    expect(form2.referencedIn).toEqual(["0x1"]);

    expect(data.suppressions).toHaveLength(1);
    const suppression = data.suppressions[0];
    expect(suppression).toMatchObject({
      offset: "0x00000016",
      start: "0x0000001A",
      end: "0x0000001E",
      kind: "SuppressIf",
      active: true,
      constant: true,
      source: "constant",
      expression: "True",
      varStoreNames: [],
    });

    // The menu falls back to the structural FormSet root because neither
    // the AMITSE executable menu nor the SetupData page list contains any
    // evidence in this fixture.
    expect(data.menu).toEqual([
      {
        name: "Main Setup",
        formId: "0x1",
        offset: null,
        formSetGuid: "12345678-1234-1234-1234-123456789ABC",
        source: "formset",
      },
    ]);

    const recomputedChecksum = await calculateJsonChecksum(
      data.menu,
      data.forms,
      data.suppressions,
    );
    expect(data.hashes.offsetChecksum).toBe(recomputedChecksum);
  });
});

describe("parseData validation", () => {
  it("rejects an incompatible IFRExtractor-RS version", async () => {
    const files = await buildFixtureFiles();
    files.setupTxtContainer.textContent = files.setupTxtContainer.textContent
      .replace("Program version: 1.6.1", "Program version: 9.9.9");

    await expect(parseData(files)).rejects.toThrow(
      /Wrong IFRExtractor-RS version/,
    );
  });

  it("rejects a non-UEFI extraction mode", async () => {
    const files = await buildFixtureFiles();
    files.setupTxtContainer.textContent = files.setupTxtContainer.textContent
      .replace("Extraction mode: UEFI", "Extraction mode: DOS");

    await expect(parseData(files)).rejects.toThrow(/Only UEFI is supported/);
  });

  it("rejects a dump that was not extracted in verbose mode", async () => {
    const files = await buildFixtureFiles();
    files.setupTxtContainer.textContent = files.setupTxtContainer.textContent
      .replace(/\{ [0-9A-F ]+ \}/g, "");

    await expect(parseData(files)).rejects.toThrow(/verbose/);
  });

  it("rejects a SHA256 mismatch between Setup SCT and the IFR dump", async () => {
    const files = await buildFixtureFiles();
    files.setupTxtContainer.textContent = files.setupTxtContainer.textContent
      .replace(/SHA256: [0-9a-f]{64}/, "SHA256: 0".repeat(64).slice(0, 64));

    await expect(parseData(files)).rejects.toThrow(/SHA256 mismatch/);
  });
});

describe("downloadModifiedFiles", () => {
  it("reports no changes when every suppression stays active", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "no-changes" });
    expect(saveAsMock).not.toHaveBeenCalled();
  });

  it("patches the SuppressIf end marker when a suppression is deactivated", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    // suppression.start = 0x0000001A (byte 26 -> hex index 52),
    // suppression.end   = 0x0000001E (byte 30 -> hex index 60).
    const beforeStart = "AA".repeat(26);
    const startToEndGap = "BB".repeat(4);
    const endMarker = "2902";
    const afterEnd = "CC".repeat(5);
    files.setupSctContainer.textContent =
      beforeStart + startToEndGap + endMarker + afterEnd;

    data.suppressions[0].active = false;

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    expect(saveAsMock).toHaveBeenCalledTimes(2);

    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.setupSctContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    const patchedHex = Array.from(patchedBytes, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");
    // The end marker moves to where the suppression starts, and the old
    // end position collapses - the SuppressIf's guarded bytes become
    // unconditionally reachable instead of being skipped.
    expect(patchedHex).toBe(beforeStart + endMarker + startToEndGap + afterEnd);

    const [changelogBlob, changelogName] = saveAsMock.mock.calls[1] as [
      Blob,
      string,
    ];
    expect(changelogName).toBe("changelog.txt");
    const changelogText = await changelogBlob.text();
    expect(changelogText).toContain("Unsuppressed 0x00000016");
  });

  it("throws when the expected end marker bytes are missing (corrupted state)", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    // No "2902" bytes anywhere near the suppression's recorded end offset.
    files.setupSctContainer.textContent = "00".repeat(40);
    data.suppressions[0].active = false;

    expect(() => downloadModifiedFiles(data, files)).toThrow(
      /Something went wrong/,
    );
  });
});
