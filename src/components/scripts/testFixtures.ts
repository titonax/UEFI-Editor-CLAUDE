import type { PopulatedFiles } from "../FileUploads/FileUploads";

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
// parseData() relies on.
export async function buildFixtureFiles(): Promise<PopulatedFiles> {
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
