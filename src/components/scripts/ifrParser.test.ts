import { describe, expect, it } from "vitest";
import { calculateJsonChecksum, sha256Hex } from "./hashing";
import { parseData, version } from "./ifrParser";
import { buildFixtureFiles } from "./testFixtures";
import type { PopulatedFiles } from "../FileUploads/FileUploads";

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
    // The fixture's Ref opcode starts at 0x0000002E; FormId sits 13 bytes
    // into the opcode (Header + QuestionHeader), at 0x2E + 0xD = 0x3B.
    expect(ref.formIdOffset).toBe("0x3B");

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

// A second, independent fixture covering opcode paths the main fixture
// doesn't exercise: a String prompt, and a GrayOutIf (as opposed to
// SuppressIf) condition - which sets `conditions` on its guarded child but
// must NOT set `suppressIf`, since only SuppressIf actually hides anything.
async function buildGrayOutAndStringFixtureFiles(): Promise<PopulatedFiles> {
  const formSetGuid = "AAAAAAAA-1111-2222-3333-444444444444";

  const lines = [
    `0x00000010: FormSet Guid: ${formSetGuid}, Title: "Ext Setup", Help: "Root help"`,
    `0x00000012: VarStore Guid: BBBBBBBB-5555-6666-7777-888888888888, VarStoreId: 0x0001, Size: 0x0010, Name: "Setup" {`,
    `0x00000014: Form FormId: 0x1, Title: "Main" { 01 86 }`,
    `0x00000016: \tGrayOutIf { 05 82 }`,
    `0x00000018: \t\tTrue { 01 06 }`,
    `0x0000001A: \t\tNumeric Prompt: "Grayed Number", Help: "Grayed help", QuestionFlags: 0x00, QuestionId: 0x0001, VarStoreId: 0x0001, VarOffset: 0x0000, Flags: 0x00, Size: 0x01, Min: 0x00, Max: 0x0A, Step: 0x01 { 07 86 }`,
    `0x0000001C: \t\tEnd { 29 02 }`,
    `0x0000001E: \tEnd { 29 02 }`,
    `0x00000020: \tString Prompt: "A String", Help: "String help", QuestionFlags: 0x00, QuestionId: 0x0002, VarStoreId: 0x0001, VarStoreInfo: 0x0000, MinSize: 0x00, MaxSize: 0x10, Flags: 0x00 { 0A 86 }`,
    `0x00000022: \tEnd { 29 02 }`,
    `0x00000024: End { 29 02 }`,
  ];

  const setupSctBytes = new TextEncoder().encode("dummy-setup-sct-bytes-2");
  const setupSctHash = await sha256Hex(setupSctBytes);

  const setupTxt = [
    "Program version: 1.6.1",
    "Extraction mode: UEFI",
    `SHA256: ${setupSctHash}`,
    ...lines,
  ].join("\n");

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
      textContent: "",
      isWrongFile: false,
    },
    setupdataBinContainer: {
      file: new File([], "SetupDataVar.bin"),
      textContent: "00000000",
      isWrongFile: false,
    },
  };
}

describe("parseData - GrayOutIf and String prompts", () => {
  it("sets conditions but not suppressIf for a GrayOutIf-guarded child", async () => {
    const files = await buildGrayOutAndStringFixtureFiles();
    const data = await parseData(files);

    expect(data.forms).toHaveLength(1);
    const [form] = data.forms;
    expect(form.children).toHaveLength(2);

    const numeric = form.children.find((child) => child.type === "Numeric");
    if (!numeric) throw new Error("expected a Numeric child");
    expect(numeric.conditions).toEqual(["0x00000016"]);
    expect(numeric.suppressIf).toBeUndefined();

    const string = form.children.find((child) => child.type === "String");
    if (!string) throw new Error("expected a String child");
    expect(string.name).toBe("A String");
    expect(string.description).toBe("String help");
    expect(string.conditions).toBeUndefined();

    expect(data.suppressions).toHaveLength(1);
    expect(data.suppressions[0]).toMatchObject({
      kind: "GrayOutIf",
      active: true,
      constant: true,
      source: "constant",
    });
  });
});
