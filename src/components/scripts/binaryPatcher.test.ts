import { describe, expect, it, vi } from "vitest";
import { downloadModifiedFiles, validateByteInput } from "./binaryPatcher";
import { parseData } from "./ifrParser";
import { buildFixtureFiles, buildMoveFixture } from "./testFixtures";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import type { Data } from "./types";

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

describe("downloadModifiedFiles", () => {
  it("reports no changes when every suppression stays active", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "no-changes" });
    expect(saveAsMock).not.toHaveBeenCalled();
  });

  it("refuses to export extracted files while a root visibility plan is pending", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);
    data.rootVisibilityEdits = [
      {
        kind: "set-root-visibility",
        rootIndex: 0,
        formId: "0x1",
        bufferId: 0,
        bufferOffset: 0x40,
        expected: 0,
        replacement: 1,
        description: "Show root FormSet Main Setup",
      },
    ];

    saveAsMock.mockClear();
    expect(() => downloadModifiedFiles(data, files)).toThrow(
      /verified full-image reconstruction path/,
    );
    expect(saveAsMock).not.toHaveBeenCalled();
  });

  // The move fixture's AMITSE table holds each root's FormId at the offset
  // its menu entry names, so the AMITSE loop sees nothing to change.
  function moveFixtureFiles(bytes: Uint8Array): PopulatedFiles {
    const toHex = (value: Uint8Array) =>
      Array.from(value, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
    const amitse = new Uint8Array(0x20);
    amitse[0x10] = 0x01;
    amitse[0x12] = 0x02;
    const setupData = new Uint8Array(4);
    return {
      setupSctContainer: { file: new File([bytes], "Setup.sct"), textContent: toHex(bytes), isWrongFile: false },
      setupTxtContainer: { file: new File([""], "setup.ifr.txt"), textContent: "", isWrongFile: false },
      amitseSctContainer: { file: new File([amitse], "AmiTse.sct"), textContent: toHex(amitse), isWrongFile: false },
      setupdataBinContainer: { file: new File([setupData], "SetupData.bin"), textContent: toHex(setupData), isWrongFile: false },
    };
  }

  async function savedBytes(name: string) {
    const call = saveAsMock.mock.calls.find((candidate) => candidate[1] === name);
    if (!call) throw new Error(`expected ${name} to be saved`);
    return new Uint8Array(await (call[0] as Blob).arrayBuffer());
  }

  async function changelogText() {
    const call = saveAsMock.mock.calls.find((candidate) => candidate[1] === "changelog.txt");
    if (!call) throw new Error("expected changelog.txt to be saved");
    return (call[0] as Blob).text();
  }

  function required(offset: number | undefined) {
    if (offset === undefined) throw new Error("fixture offset missing");
    return offset;
  }

  const REF_LENGTH = 15;

  it("rebalances both Forms Package lengths when a Ref moves across packages", async () => {
    const { bytes, data, offsets } = buildMoveFixture({ explicitTargetGuid: true });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[2].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    // Expected layout: the 15-byte Ref leaves package A and lands right
    // before Other's End; A shrinks and B (whose header shifted left by
    // the Ref's length) grows by the same 15 bytes; the shared package
    // list keeps its total length.
    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, 15);
    expected.splice(offsets.form2End - 15, 0, ...refBytes);
    const readUint24 = (source: number[], offset: number) =>
      source[offset] | (source[offset + 1] << 8) | (source[offset + 2] << 16);
    const writeUint24 = (target: number[], offset: number, value: number) => {
      target[offset] = value & 0xff;
      target[offset + 1] = (value >>> 8) & 0xff;
      target[offset + 2] = (value >>> 16) & 0xff;
    };
    writeUint24(expected, offsets.packageA, readUint24(expected, offsets.packageA) - 15);
    writeUint24(expected, offsets.packageB - 15, readUint24(expected, offsets.packageB - 15) + 15);

    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain(
      'Moved Go to Sub from "Main" to "Other" across HII Forms Packages',
    );
    expect(Array.from(await savedBytes("Setup.sct")).length).toBe(bytes.length);
  });

  it("moves a Ref's bytes forward to a later Form inside one package, leaving package lengths untouched", async () => {
    // The Ref (pointing at Other, so Sub is a plain destination) leaves
    // Main and lands right before Sub's End: Sub's old body slides left
    // into the gap, the Ref becomes its new last child, and nothing before
    // the Ref's old position or after Sub's End moves.
    const { bytes, data, offsets } = buildMoveFixture({ refTarget: "other" });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[1].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, REF_LENGTH);
    expected.splice(offsets.form3End - REF_LENGTH, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    const changelog = await changelogText();
    expect(changelog).toContain('Moved Go to Other from "Main" to "Sub"');
    expect(changelog).not.toContain("across HII Forms Packages");
  });

  it("moves a Ref's bytes backward to an earlier Form", async () => {
    // The Ref pristinely sits in Sub; moving it into Main lands its bytes
    // right at Main's old End boundary, and everything between that
    // boundary and the Ref's old position slides right by the Ref's length
    // to make room. Nothing at or after Sub's End moves.
    const { bytes, data, offsets } = buildMoveFixture({ refHome: "sub", refTarget: "other" });
    const [moved] = data.forms[1].children.splice(0, 1);
    data.forms[0].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, REF_LENGTH);
    expected.splice(offsets.form1End, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain('Moved Go to Other from "Sub" to "Main"');
  });

  it("moves a hidden Ref together with its whole condition wrapper", async () => {
    // The movable block is the SuppressIf opcode, its True expression, the
    // Ref and the SuppressIf's own End marker, as one unit - so the item
    // stays hidden in its new Form instead of arriving unconditionally
    // visible. The suppression's own offsets are remapped along with it,
    // so nothing is reported as unsuppressed.
    const { bytes, data, offsets } = buildMoveFixture({
      refHome: "sub",
      refTarget: "other",
      hiddenRef: true,
    });
    const [moved] = data.forms[1].children.splice(0, 1);
    data.forms[0].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const wrapperLength = 4 + REF_LENGTH + 2;
    const expected = [...bytes];
    const block = expected.splice(required(offsets.suppressIf), wrapperLength);
    expected.splice(offsets.form1End, 0, ...block);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).not.toContain("Unsuppressed");
  });

  it("remaps an unrelated suppression caught in the gap a move shifts, so a same-download unsuppress still finds its End marker", async () => {
    // Main pristinely holds the Ref followed by an unrelated SuppressIf-
    // wrapped Subtitle. Moving the Ref forward into Sub shifts that whole
    // wrapper left by the Ref's length; the deactivation applied in the
    // same download must then find the wrapper's End marker at its shifted
    // position and move it to the shifted start - exposing the Subtitle
    // unconditionally - rather than patching the stale pristine offsets.
    const { bytes, data, offsets } = buildMoveFixture({
      refTarget: "other",
      trailingHiddenSubtitle: true,
    });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[1].children.push(moved);
    data.suppressions[0].active = false;
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, REF_LENGTH);
    expected.splice(offsets.form3End - REF_LENGTH, 0, ...refBytes);
    const endMarker = expected.splice(required(offsets.trailingEnd) - REF_LENGTH, 2);
    expected.splice(required(offsets.trailingStart) - REF_LENGTH, 0, ...endMarker);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    const shiftedSuppressIf = required(offsets.trailingSuppressIf) - REF_LENGTH;
    expect(await changelogText()).toContain(
      `Unsuppressed 0x${shiftedSuppressIf.toString(16).toUpperCase()}`,
    );
  });

  it("refuses a cross-package move between packages of different provenance", () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true, bareSecondPackage: true });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[2].children.push(moved);

    saveAsMock.mockClear();
    expect(() => downloadModifiedFiles(data, moveFixtureFiles(bytes))).toThrow(
      /Something went wrong/,
    );
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
    // Padded through byte 60 (0x3C) so the fixture's Ref FormId bytes (0x2,
    // little-endian, at formIdOffset 0x3B - see testFixtures.ts) fall
    // within this buffer and read as unchanged, instead of an out-of-range
    // read that would look like a spurious Ref retarget. afterEnd starts at
    // byte 32; bytes 59-60 need to be "02 00", so that's 27 filler bytes
    // then the two FormId bytes.
    const afterEnd = `${"CC".repeat(27)}0200`;
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
    // Padded through byte 60 with the fixture's correct, unchanged Ref
    // FormId bytes at 59-60 (see testFixtures.ts) so the Ref check finds
    // nothing to retarget, leaving the missing end-marker as the only
    // reason this should throw.
    files.setupSctContainer.textContent = `${"00".repeat(59)}0200`;
    data.suppressions[0].active = false;

    expect(() => downloadModifiedFiles(data, files)).toThrow(
      /Something went wrong/,
    );
  });

  it("patches a Ref's FormId bytes when it's retargeted", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    const ref = data.forms[0].children.find((child) => child.type === "Ref");
    if (!ref) throw new Error("expected a Ref child");
    expect(ref.formId).toBe("0x2");
    expect(ref.formIdOffset).toBe("0x3B");

    ref.formId = "0x1"; // the user retargeted this Ref to Form 0x1 instead

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.setupSctContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    // formIdOffset 0x3B = byte 59, little-endian 0x0001.
    expect([...patchedBytes.slice(0x3b, 0x3d)]).toEqual([0x01, 0x00]);

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      'Go to Advanced in "Main Page" | FormId 0x2 (Advanced Page) -> 0x1 (Main Page)',
    );
  });

  it("carries a retargeted Ref's new FormId through a suppression shift it falls inside", async () => {
    // The Ref's formIdOffset (byte 20) sits inside a SuppressIf's guarded
    // range (start=10, end=30) that gets deactivated in the same download.
    // Ref-patching must run before the shift so the new FormId - not the
    // old one - is what the shift's copyWithin carries to its new position.
    const beforeStart = "AA".repeat(10); // bytes 0-9
    const startToFormId = "BB".repeat(10); // bytes 10-19
    const oldFormIdBytes = "0100"; // bytes 20-21: old FormId 0x1, little-endian
    const formIdToEnd = "CC".repeat(8); // bytes 22-29
    const endMarker = "2902"; // bytes 30-31: the SuppressIf's own End opcode
    const afterEnd = "DD".repeat(8); // bytes 32-39

    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      beforeStart +
      startToFormId +
      oldFormIdBytes +
      formIdToEnd +
      endMarker +
      afterEnd;

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Main Page",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0x28",
          children: [
            {
              name: "Go to Advanced",
              description: "",
              type: "Ref",
              questionId: "0x0004",
              varStoreId: "0x0001",
              formId: "0x2", // retargeted from 0x1 to 0x2
              formIdOffset: "0x14", // byte 20
              pageId: null,
              accessLevel: null,
              failsafe: null,
              optimal: null,
              offsets: null,
              sctOffset: "0x7",
            },
          ],
        },
        {
          name: "Advanced Page",
          type: "Form",
          formId: "0x2",
          referencedIn: [],
          endOffset: "0x28",
          children: [],
        },
      ],
      varStores: [],
      version: "test",
      hashes: {
        setupTxt: "",
        setupSct: "",
        amitseSct: "",
        setupdataBin: "",
        offsetChecksum: "",
      },
      suppressions: [
        {
          offset: "0x0",
          start: "0xA", // byte 10
          end: "0x1E", // byte 30
          kind: "SuppressIf",
          active: false,
        },
      ],
    };

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const patchedBlob = (saveAsMock.mock.calls[0] as [Blob, string])[0];
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    const patchedHex = Array.from(patchedBytes, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");

    // The End opcode moves to where the suppression starts (byte 10). The
    // Ref's new FormId (0x0002, already written in place at byte 20/21
    // before the shift ran) is carried along by that shift like any other
    // guarded byte, landing at byte 22/23 instead of being lost or left
    // holding the pre-shift value.
    expect(patchedHex).toBe(
      beforeStart + endMarker + startToFormId + "0200" + formIdToEnd + afterEnd,
    );

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      'Go to Advanced in "Main Page" | FormId 0x1 (Main Page) -> 0x2 (Advanced Page)',
    );
    expect(changelogText).toContain("Unsuppressed 0x0");
  });

  it("patches the AMITSE menu table's little-endian FormId bytes", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    // Byte-swapped (little-endian) 0x0001, i.e. the executable table
    // currently points at form 0x1 ("Main Page").
    files.amitseSctContainer.textContent = "0100";
    data.menu = [
      {
        name: "Main Page",
        formId: "0x2", // the user retargeted this root to form 0x2
        offset: "0x0",
        formSetGuid: "12345678-1234-1234-1234-123456789ABC",
        source: "amitse",
      },
    ];

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.amitseSctContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    // Little-endian 0x0002.
    expect([...patchedBytes]).toEqual([0x02, 0x00]);

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      "Main Page | FormId 0x1 -> Advanced Page | FormId 0x2",
    );
  });

  it("patches SetupData access-level/failsafe/optimal bytes", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    files.setupdataBinContainer.textContent = "000000";
    const checkBox = data.forms[0].children.find(
      (child) => child.type === "CheckBox",
    );
    if (!checkBox) throw new Error("expected a CheckBox child");
    checkBox.offsets = {
      accessLevel: "0x0",
      failsafe: "0x1",
      optimal: "0x2",
    };
    checkBox.accessLevel = "05";
    checkBox.failsafe = "0A";
    checkBox.optimal = "0F";

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.setupdataBinContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    expect([...patchedBytes]).toEqual([0x05, 0x0a, 0x0f]);

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain("Access Level 00 -> 05");
    expect(changelogText).toContain("Failsafe 00 -> 0A");
    expect(changelogText).toContain("Optimal 00 -> 0F");
  });

  it("shifts a nested suppression's offsets by exactly one End opcode's width", async () => {
    // A SuppressIf ("outer", bytes 10..26) that itself guards a second,
    // fully nested SuppressIf ("child", bytes 14..20). Both are toggled
    // inactive, and the suppressions array is deliberately given in
    // parent-before-child order - the opposite of what parseData() would
    // ever produce (it always closes the inner scope first) - so that
    // outer's bookkeeping for "other suppressions nested inside me" is
    // actually exercised instead of being dead code.
    const beforeOuterStart = "AA".repeat(10); // 0..9
    const outerStartToChildStart = "BB".repeat(4); // 10..13
    const childGuarded = "CC".repeat(6); // 14..19
    const childEndMarker = "2902"; // 20..21
    const childEndToOuterEnd = "DD".repeat(4); // 22..25
    const outerEndMarker = "2902"; // 26..27
    const afterOuterEnd = "EE".repeat(6); // 28..33

    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      beforeOuterStart +
      outerStartToChildStart +
      childGuarded +
      childEndMarker +
      childEndToOuterEnd +
      outerEndMarker +
      afterOuterEnd;

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [],
      varStores: [],
      version: "test",
      hashes: {
        setupTxt: "",
        setupSct: "",
        amitseSct: "",
        setupdataBin: "",
        offsetChecksum: "",
      },
      suppressions: [
        {
          offset: "0x0",
          start: "0xA",
          end: "0x1A",
          kind: "SuppressIf",
          active: false,
        },
        {
          offset: "0x1",
          start: "0xE",
          end: "0x14",
          kind: "SuppressIf",
          active: false,
        },
      ],
    };

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const patchedBlob = (saveAsMock.mock.calls[0] as [Blob, string])[0];
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    const patchedHex = Array.from(patchedBytes, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");

    // Both End opcodes move to where their own suppression starts; the
    // child's marker now sits right after outer's, exposing both
    // previously-guarded regions.
    expect(patchedHex).toBe(
      beforeOuterStart +
        "2902" +
        outerStartToChildStart +
        "2902" +
        childGuarded +
        childEndToOuterEnd +
        afterOuterEnd,
    );
  });
});
