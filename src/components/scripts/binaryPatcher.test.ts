import { describe, expect, it, vi } from "vitest";
import { downloadModifiedFiles, validateByteInput } from "./binaryPatcher";
import { parseData } from "./ifrParser";
import { buildFixtureFiles } from "./testFixtures";
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

  it("reorders a Form's children by physically rearranging their pristine bytes", async () => {
    // Pristine layout: A at 0x0 (4 bytes), B at 0x4 (4 bytes), C at 0x8 (4
    // bytes), the Form's own End at 0xC. The user reordered them in memory
    // to [C, B, A] - this should show up as the same three 4-byte chunks
    // physically rearranged into that order, nothing added or removed.
    const aBytes = "AA".repeat(4);
    const bBytes = "BB".repeat(4);
    const cBytes = "CC".repeat(4);

    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent = aBytes + bBytes + cBytes;

    function makeItem(name: string, sctOffset: string) {
      return {
        name,
        description: "",
        type: "String" as const,
        questionId: "0x1",
        varStoreId: "0x1",
        accessLevel: null,
        failsafe: null,
        optimal: null,
        offsets: null,
        sctOffset,
      };
    }

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Page",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0xC",
          children: [
            makeItem("C", "0x8"),
            makeItem("B", "0x4"),
            makeItem("A", "0x0"),
          ],
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
      suppressions: [],
    };

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const patchedBlob = (saveAsMock.mock.calls[0] as [Blob, string])[0];
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    const patchedHex = Array.from(patchedBytes, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");
    expect(patchedHex).toBe(cBytes + bBytes + aBytes);

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain('Reordered "Page": C, B, A');
  });

  it("remaps a suppression carried inside a reordered block, so a same-download unsuppress still finds its End marker", async () => {
    // Pristine layout (16 bytes): A at 0x0 (4 bytes, unconditioned), B at
    // 0x4 (4 bytes, unconditioned), then a SuppressIf-wrapped block C
    // opening at 0x8 (8 bytes: 2 filler, a 4-byte guarded CheckBox at 0xA,
    // then the SuppressIf's own End marker "29 02" at 0xE). Form's own End
    // at 0x10. The user reordered to [C, A, B] - C's whole conditioned
    // block, End marker included, moves from 0x8 to 0x0.
    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      "AAAAAAAA" + // A: 0x0-0x3
      "BBBBBBBB" + // B: 0x4-0x7
      "F0F1" + // C's filler: 0x8-0x9
      "CCCCCCCC" + // C's guarded content: 0xA-0xD
      "2902"; // C's own SuppressIf End marker: 0xE-0xF

    function makeItem(
      name: string,
      sctOffset: string,
      conditions?: string[],
    ) {
      return {
        name,
        description: "",
        type: "String" as const,
        questionId: "0x1",
        varStoreId: "0x1",
        accessLevel: null,
        failsafe: null,
        optimal: null,
        offsets: null,
        sctOffset,
        conditions,
      };
    }

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Page",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0x10",
          children: [
            makeItem("C", "0xA", ["0x8"]),
            makeItem("A", "0x0"),
            makeItem("B", "0x4"),
          ],
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
          offset: "0x8",
          start: "0xA",
          end: "0xE",
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

    // C's block (filler + guarded content + End marker) physically moves to
    // the front; the SuppressIf deactivation then finds its End marker at
    // its remapped position (0x6, not the stale pristine 0xE) and moves it
    // to the remapped start (0x2), unconditionally exposing the CC bytes.
    expect(patchedHex).toBe(
      "F0F1" + // filler, unmoved by the unsuppress
        "2902" + // the End marker, relocated to the (remapped) start
        "CCCCCCCC" + // the guarded content, now unconditionally reachable
        "AAAAAAAA" + // A, shifted from 0x0 to 0x8
        "BBBBBBBB", // B, shifted from 0x4 to 0xC
    );

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain('Reordered "Page": C, A, B');
    // suppression.offset (the condition opcode's own pristine offset, 0x8)
    // gets remapped the same way start/end do: 0x8 was inside the moved
    // block's old [0x8, 0x10) range, shifted by the block's own -8 delta.
    expect(changelogText).toContain("Unsuppressed 0x0");
  });
});
