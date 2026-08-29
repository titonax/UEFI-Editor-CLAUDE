import { describe, expect, it, vi } from "vitest";
import { downloadModifiedFiles, validateByteInput } from "./binaryPatcher";
import { parseData } from "./ifrParser";
import { buildFixtureFiles } from "./testFixtures";

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
});
