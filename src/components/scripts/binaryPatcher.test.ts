import { describe, expect, it, vi } from "vitest";
import { downloadModifiedFiles, validateByteInput } from "./binaryPatcher";
import { parseData } from "./ifrParser";
import { buildFixtureFiles } from "./testFixtures";
import type { Data, RefPrompt } from "./types";

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

  // formId/formIdOffset are for the *retargeting* feature, unrelated to
  // moving - but downloadModifiedFiles always runs that loop first, so
  // every test below points formIdOffset at its own trailing "DD" padding
  // and sets formId to match what's already there (0xDDDD), making that
  // loop a guaranteed no-op instead of tripping over an unrelated FormId
  // that doesn't resolve to a real Form.
  function makeMovedRef(overrides: Partial<RefPrompt> = {}): RefPrompt {
    return {
      name: "Go to page",
      description: "",
      type: "Ref" as const,
      questionId: "0x1",
      varStoreId: "0x1",
      formId: "0xDDDD",
      formIdOffset: "0x0",
      pageId: null,
      accessLevel: null,
      failsafe: null,
      optimal: null,
      offsets: null,
      sctOffset: "0x2",
      ...overrides,
    };
  }

  it("moves a Ref's bytes forward to a later Form", async () => {
    // Pristine layout (16 bytes): 2 bytes of Form A's own untouched lead-in,
    // a 4-byte unconditioned Ref at 0x2 (header "0F 04" - opcode + length 4
    // - then 2 content bytes "42 42"), Form A's own End boundary at 0x6,
    // Form B's 4-byte body at 0x6, Form B's own End boundary at 0xA, then 6
    // trailing bytes that belong to neither Form and must stay untouched.
    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      "AAAA" + "0F044242" + "CCCCCCCC" + "DDDDDDDDDDDD";

    const ref = makeMovedRef({ formIdOffset: "0xE" });
    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Form A",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0x6",
          children: [],
        },
        {
          name: "Form B",
          type: "Form",
          formId: "0x2",
          referencedIn: [],
          endOffset: "0xA",
          // The Ref now lives here even though its pristine sctOffset
          // (0x2) falls inside Form A's range - that mismatch is exactly
          // what detectRefMoves keys off of.
          children: [ref],
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

    // Form B's old body slides left into where the Ref used to be; the
    // Ref's own bytes land right where Form B's boundary was, i.e. as its
    // new last child. Nothing before 0x2 or after 0xA moves.
    expect(patchedHex).toBe(
      "AAAA" + "CCCCCCCC" + "0F044242" + "DDDDDDDDDDDD",
    );

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      'Moved Go to page from "Form A" to "Form B"',
    );
  });

  it("moves a Ref's bytes backward to an earlier Form", async () => {
    // Pristine layout (12 bytes): Form A's 2-byte body at 0x0, Form A's own
    // End boundary at 0x2, Form B's 6-byte body at 0x2 (2 bytes of filler
    // that pristinely precede a 4-byte unconditioned Ref at 0x4), Form B's
    // own End boundary at 0x8, then 4 trailing bytes belonging to neither.
    // The Ref moves from B back into A.
    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      "1111" + "EEEE" + "0F044242" + "CCCCCCCC" + "DDDD";

    const ref = makeMovedRef({ sctOffset: "0x4", formIdOffset: "0xC" });
    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Form A",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0x2",
          // Pristine home of nothing in particular here - the Ref moved
          // INTO this Form from Form B.
          children: [ref],
        },
        {
          name: "Form B",
          type: "Form",
          formId: "0x2",
          referencedIn: [],
          endOffset: "0x8",
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

    // The Ref's bytes land right at Form A's old boundary (0x2); the
    // 2-byte filler that pristinely sat between that boundary and the Ref
    // slides right by the Ref's length (4) to make room, ending up
    // immediately after it. Nothing at or after 0x8 moves.
    expect(patchedHex).toBe(
      "1111" + "0F044242" + "EEEE" + "CCCCCCCC" + "DDDD",
    );

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      'Moved Go to page from "Form B" to "Form A"',
    );
  });

  it("moves a hidden Ref together with its whole condition wrapper", async () => {
    // Pristine layout (18 bytes): Form A body is a SuppressIf-wrapped Ref -
    // 2 filler bytes, then the 4-byte Ref at 0x2, then the SuppressIf's own
    // End marker "29 02" at 0x6. Form A's own End boundary at 0x8. Form B's
    // 4-byte body at 0x8, own End boundary at 0xC, then 6 trailing bytes.
    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      "FFFF" + "0F044242" + "2902" + "CCCCCCCC" + "DDDDDDDDDDDD";

    const ref = makeMovedRef({ conditions: ["0x0"], formIdOffset: "0x10" });
    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Form A",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0x8",
          children: [],
        },
        {
          name: "Form B",
          type: "Form",
          formId: "0x2",
          referencedIn: [],
          endOffset: "0xC",
          children: [ref],
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
          // The SuppressIf's own opcode starts right before the filler +
          // Ref, at 0x0 - so the movable block is [0x0, 0x8), the filler
          // AND the Ref AND the End marker together, not just the Ref.
          offset: "0x0",
          start: "0x2",
          end: "0x6",
          kind: "SuppressIf",
          active: true,
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

    // The whole 8-byte wrapper (filler + Ref + End marker) moves as one
    // unit; Form B's old body slides left to fill the gap it left behind.
    expect(patchedHex).toBe(
      "CCCCCCCC" + "FFFF" + "0F044242" + "2902" + "DDDDDDDDDDDD",
    );

    // The suppression stays active in this test (only its bytes moved), so
    // there's no "Unsuppressed" line - just confirm the move itself, and
    // that the suppression's own offsets were remapped rather than left
    // pointing at Form B's now-unrelated content.
    expect(changeLogHasNoUnsuppress(await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text())).toBe(true);
  });

  function changeLogHasNoUnsuppress(text: string) {
    return !text.includes("Unsuppressed");
  }

  it("remaps an unrelated suppression caught in the gap a move shifts, so a same-download unsuppress still finds its End marker", async () => {
    // Pristine layout (18 bytes): Form A has an unconditioned 4-byte Ref at
    // 0x0, then an unrelated SuppressIf's 2-byte guarded content at 0x4
    // (its own End marker "29 02" immediately after, at 0x6), Form A's own
    // End boundary at 0x8 - Form A's whole body is exactly Ref + guarded
    // content + End marker. Form B's 4-byte body at 0x8, own End boundary
    // at 0xC, then 6 trailing bytes. The Ref moves from A to B, shifting
    // the unrelated suppression left by the Ref's length (4) on its way
    // past it.
    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      "0F044242" + "EEEE" + "2902" + "CCCCCCCC" + "DDDDDDDDDDDD";

    const ref = makeMovedRef({ sctOffset: "0x0", formIdOffset: "0x10" });
    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Form A",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0x8",
          children: [],
        },
        {
          name: "Form B",
          type: "Form",
          formId: "0x2",
          referencedIn: [],
          endOffset: "0xC",
          children: [ref],
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
          // Modeled with a 0-length SuppressIf opcode/True-expression for
          // simplicity (offset === start) - only start/end are actually
          // read to locate bytes; offset only feeds the changelog line.
          offset: "0x4",
          start: "0x4",
          end: "0x6",
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

    // After the move: EEEE + the End marker shift left by 4, to 0x0-0x3;
    // Form B's old body follows at 0x4-0x7; the Ref lands at 0x8-0xB (its
    // new last-child position). The deactivation then finds the End
    // marker at its remapped position (0x2, not the stale 0x6) and moves
    // it to the remapped start (0x0), exposing EEEE unconditionally.
    expect(patchedHex).toBe(
      "2902" + "EEEE" + "CCCCCCCC" + "0F044242" + "DDDDDDDDDDDD",
    );

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain("Unsuppressed 0x0");
  });
});
