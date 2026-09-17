import type { PopulatedFiles } from "../FileUploads/fileModel";
import type { Data, RefPrompt } from "./types";

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
export const FIXTURE_FORM_SET_GUID = "12345678-1234-1234-1234-123456789ABC";

export async function buildFixtureFiles(
  overrides: { setupdataBin?: string; amitseSct?: string; lines?: string[] } = {},
): Promise<PopulatedFiles> {
  const formSetGuid = FIXTURE_FORM_SET_GUID;

  const lines = overrides.lines ?? [
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

  const setupSctBytes = new Uint8Array(64);
  setupSctBytes.set(new TextEncoder().encode("dummy-setup-sct-bytes"), 0);
  // Not a real encoding of the opcodes in `lines` above - just long enough
  // filler. But the Ref at 0x0000002E has FormId: 0x2, and binaryPatcher
  // reads that Ref's actual FormId bytes at formIdOffset (opcode start +
  // 0xD, i.e. 0x2E + 0xD = 0x3B) to detect a retarget. Keep those two bytes
  // (little-endian 0x0002) consistent so an unmodified fixture doesn't look
  // like the Ref was already changed.
  setupSctBytes[0x3b] = 0x02;
  setupSctBytes[0x3c] = 0x00;
  const setupSctHash = await sha256Hex(setupSctBytes);

  const setupTxt = [
    "Program version: 1.6.1",
    "Extraction mode: UEFI",
    `SHA256: ${setupSctHash}`,
    ...lines,
  ].join("\n");

  const setupdataBin = overrides.setupdataBin ?? "00000000";
  const amitseSct = overrides.amitseSct ?? "";

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

export const MOVE_FIXTURE_GUID_A = "AAAAAAAA-1111-2222-3333-444444444444";
export const MOVE_FIXTURE_GUID_B = "BBBBBBBB-1111-2222-3333-444444444444";

export interface MoveFixtureOptions {
  // Give the Ref an explicit target FormSetGuid (a REF3/REF4 variant), so
  // it may cross into another FormSet.
  explicitTargetGuid?: boolean;
  // Set the Ref opcode's scope bit (it would own nested opcodes).
  scopedRef?: boolean;
  // Wrap the Ref in a SuppressIf it is the sole occupant of.
  hiddenRef?: boolean;
  // Put the second Forms Package after the package list as a bare package
  // instead of inside it, so the two packages have different provenance.
  bareSecondPackage?: boolean;
  // Which Form holds the Ref: Main (0x1, the default) or Sub (0x3).
  refHome?: "main" | "sub";
  // Which Form the Ref points at: Sub (0x3, the default, same FormSet) or
  // Other (0x2 in FormSet B, always named with an explicit target GUID).
  refTarget?: "sub" | "other";
  // Follow the Ref with an unrelated SuppressIf-wrapped Subtitle in the
  // same Form, so a move shifts that suppression's bytes along the way.
  trailingHiddenSubtitle?: boolean;
}

export interface MoveFixture {
  bytes: Uint8Array;
  data: Data;
  offsets: {
    packageA: number;
    packageB: number;
    ref: number;
    suppressIf?: number;
    suppressEnd?: number;
    trailingSuppressIf?: number;
    trailingStart?: number;
    trailingEnd?: number;
    form1End: number;
    form3End: number;
    form2End: number;
    listLength: number;
  };
}

function guidBytes(guid: string) {
  const parts = guid.split("-");
  const reverse = (hex: string) => hex.match(/../g)?.reverse().join("") ?? "";
  const encoded =
    reverse(parts[0]) + reverse(parts[1]) + reverse(parts[2]) + parts[3] + parts[4];
  return Array.from(encoded.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

// A real-shaped Setup HII buffer for move tests: one package list holding
// Forms Package A (FormSet A: Form 0x1 with a Ref to Form 0x3, Form 0x3) and
// Forms Package B (FormSet B: Form 0x2), with `data` describing it exactly
// the way parseData would (pristine offsets, array order = physical order).
export function buildMoveFixture(options: MoveFixtureOptions = {}): MoveFixture {
  const parts: number[] = [];
  const marks = new Map<string, number>();
  const push = (mark: string | null, bytes: number[]) => {
    if (mark) marks.set(mark, parts.length);
    parts.push(...bytes);
  };
  const writeUint24 = (offset: number, value: number) => {
    parts[offset] = value & 0xff;
    parts[offset + 1] = (value >>> 8) & 0xff;
    parts[offset + 2] = (value >>> 16) & 0xff;
  };
  const END = [0x29, 0x02];
  const formSet = (guid: string) => [0x0e, 0x97, ...guidBytes(guid), 0, 0, 0, 0, 0];
  const form = (id: number) => [0x01, 0x86, id & 0xff, id >> 8, 0, 0];
  const ref = (targetId: number) => [
    0x0f,
    options.scopedRef ? 0x8f : 0x0f,
    ...new Array<number>(11).fill(0),
    targetId & 0xff,
    targetId >> 8,
  ];

  push("list", new Array<number>(20).fill(0));

  const packageAStart = parts.length;
  push("packageA", [0, 0, 0, 0x02]);
  push(null, formSet(MOVE_FIXTURE_GUID_A));
  const refHome = options.refHome ?? "main";
  const targetId = options.refTarget === "other" ? 2 : 3;
  const SUPPRESS_IF_TRUE = [0x0a, 0x82, 0x46, 0x02];
  const refBlock = () => {
    if (options.hiddenRef) push("suppressIf", SUPPRESS_IF_TRUE);
    push("ref", ref(targetId));
    if (options.scopedRef) push(null, END);
    if (options.hiddenRef) push("suppressEnd", END);
    if (options.trailingHiddenSubtitle) {
      push("trailingSuppressIf", SUPPRESS_IF_TRUE);
      push("trailingStart", [0x02, 0x07, 0, 0, 0, 0, 0]);
      push("trailingEnd", END);
    }
  };
  push("form1", form(1));
  if (refHome === "main") refBlock();
  push("form1End", END);
  push("form3", form(3));
  if (refHome === "sub") refBlock();
  push("form3End", END);
  push(null, END);
  writeUint24(packageAStart, parts.length - packageAStart);

  const buildPackageB = () => {
    const start = parts.length;
    push("packageB", [0, 0, 0, 0x02]);
    push(null, formSet(MOVE_FIXTURE_GUID_B));
    push("form2", form(2));
    push("form2End", END);
    push(null, END);
    writeUint24(start, parts.length - start);
  };
  if (!options.bareSecondPackage) buildPackageB();
  push(null, [4, 0, 0, 0xdf]);
  const listLength = parts.length;
  parts[16] = listLength & 0xff;
  parts[17] = (listLength >>> 8) & 0xff;
  parts[18] = (listLength >>> 16) & 0xff;
  parts[19] = 0;
  if (options.bareSecondPackage) buildPackageB();

  const at = (mark: string) => {
    const offset = marks.get(mark);
    if (offset === undefined) throw new Error(`fixture mark ${mark} missing`);
    return offset;
  };
  const hex = (value: number) => `0x${value.toString(16).toUpperCase()}`;
  const conditions = options.hiddenRef ? [hex(at("suppressIf"))] : undefined;
  const homeFormId = refHome === "main" ? "0x1" : "0x3";
  const targetFormSetGuid =
    targetId === 2
      ? MOVE_FIXTURE_GUID_B
      : options.explicitTargetGuid
        ? MOVE_FIXTURE_GUID_A
        : undefined;
  const refPrompt: RefPrompt = {
    name: targetId === 2 ? "Go to Other" : "Go to Sub",
    description: "",
    type: "Ref",
    questionId: "0x0001",
    varStoreId: "0x0001",
    formId: hex(targetId),
    formIdOffset: hex(at("ref") + 13),
    targetFormSetGuid,
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    sctOffset: hex(at("ref")),
    conditions,
    suppressIf: conditions,
  };

  const data: Data = {
    firmwareFamily: "aptio-v",
    menu: [
      { name: "Main", formId: "0x1", offset: "0x10", formSetGuid: MOVE_FIXTURE_GUID_A, source: "amitse" },
      { name: "Other", formId: "0x2", offset: "0x12", formSetGuid: MOVE_FIXTURE_GUID_B, source: "amitse" },
    ],
    forms: [
      {
        name: "Main",
        type: "Form",
        formId: "0x1",
        formSetGuid: MOVE_FIXTURE_GUID_A,
        formSetTitle: "Setup A",
        referencedIn: [],
        children: refHome === "main" ? [refPrompt] : [],
        endOffset: hex(at("form1End")),
      },
      {
        name: "Sub",
        type: "Form",
        formId: "0x3",
        formSetGuid: MOVE_FIXTURE_GUID_A,
        formSetTitle: "Setup A",
        referencedIn: targetId === 3 ? [homeFormId] : [],
        children: refHome === "sub" ? [refPrompt] : [],
        endOffset: hex(at("form3End")),
      },
      {
        name: "Other",
        type: "Form",
        formId: "0x2",
        formSetGuid: MOVE_FIXTURE_GUID_B,
        formSetTitle: "Setup B",
        referencedIn: targetId === 2 ? [homeFormId] : [],
        children: [],
        endOffset: hex(at("form2End")),
      },
    ],
    varStores: [],
    suppressions: [
      ...(options.hiddenRef
        ? [
            {
              offset: hex(at("suppressIf")),
              active: true,
              start: hex(at("ref")),
              end: hex(at("suppressEnd")),
              kind: "SuppressIf" as const,
              constant: true,
              source: "constant" as const,
              expression: "True",
              varStoreNames: [],
            },
          ]
        : []),
      ...(options.trailingHiddenSubtitle
        ? [
            {
              offset: hex(at("trailingSuppressIf")),
              active: true,
              start: hex(at("trailingStart")),
              end: hex(at("trailingEnd")),
              kind: "SuppressIf" as const,
              constant: true,
              source: "constant" as const,
              expression: "True",
              varStoreNames: [],
            },
          ]
        : []),
    ],
    version: "test",
    hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
  };

  return {
    bytes: Uint8Array.from(parts),
    data,
    offsets: {
      packageA: at("packageA"),
      packageB: at("packageB"),
      ref: at("ref"),
      suppressIf: marks.get("suppressIf"),
      suppressEnd: marks.get("suppressEnd"),
      trailingSuppressIf: marks.get("trailingSuppressIf"),
      trailingStart: marks.get("trailingStart"),
      trailingEnd: marks.get("trailingEnd"),
      form1End: at("form1End"),
      form3End: at("form3End"),
      form2End: at("form2End"),
      listLength,
    },
  };
}
