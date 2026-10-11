import { describe, expect, it } from "vitest";
import { extractAptioIvBytes, type FirmwareDecompressor } from "./aptioIvExtractor";
import { inspectAmiRootVisibility } from "./amiRootVisibility";
import {
  HII_GUID,
  SETUP_GUID,
  compressionSection,
  concat,
  firmwareVolume,
  freeformSection,
  patternBytes,
  pe32Section,
  sectionStream,
  sum8,
} from "./firmwareImageFixtures";
import type { FirmwareProvenanceGraph } from "./firmwareProvenance";
import {
  isBufferEdit,
  rebuildFirmware,
  verifyByReextraction,
  verifyRebuiltFirmware,
  type ArtifactEdit,
  type BufferEdit,
  type RebuiltFirmware,
} from "./firmwareRebuild";
import { lzmaJsCodec } from "./lzmaJs";
import { buildPe, rootMenu } from "./rootVectorFixtures";

const noIfr = () => Promise.resolve("");
const decompress: FirmwareDecompressor = (input, mode) =>
  mode === "lzma" ? Promise.resolve(lzmaJsCodec.decode(input)) : Promise.reject(new Error("no EFI/Tiano here"));
const codecs = { lzma: lzmaJsCodec };
const checksummed = 0x40;
const erasedTail = (length: number) => new Uint8Array(length).fill(0xff);
const roots = rootMenu(3);

// A Setup file as AMI builds it: an HII section and the PE32 whose code reads
// the one-byte-per-FormSet root vector.
function setupVolume(values: number[]) {
  const body = sectionStream(freeformSection(HII_GUID, patternBytes(900, 5)), pe32Section(buildPe(values)));
  return firmwareVolume([{ guid: SETUP_GUID, attributes: checksummed, body }]);
}

function lzmaWrapped(values: number[]) {
  const inner = setupVolume(values);
  const section = compressionSection(2, inner.length, lzmaJsCodec.encode(inner, 8));
  return firmwareVolume([{ guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(section), erasedTail(300)) }]);
}

async function opened(image: Uint8Array) {
  const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
  const report = inspectAmiRootVisibility(roots, artifacts.provenance);
  if (report.status !== "detected" || !report.vector) throw new Error(`no root vector: ${report.reason}`);
  const hii = artifacts.provenance.artifacts.find((artifact) => artifact.kind === "setup-hii");
  if (!hii) throw new Error("no HII artifact");
  return { artifacts, graph: artifacts.provenance, report, vector: report.vector, file: hii.sourceFile };
}

function rootEdit(opened_: Awaited<ReturnType<typeof opened>>, rootIndex: number, replacement: number): BufferEdit {
  const entry = opened_.report.entries[rootIndex];
  return {
    bufferId: opened_.vector.bufferId,
    offset: entry.bufferOffset,
    expected: Uint8Array.of(entry.value),
    replacement: Uint8Array.of(replacement),
    file: opened_.file,
    label: `root visibility of ${entry.name}`,
  };
}

function unwrap(result: ReturnType<typeof rebuildFirmware>): RebuiltFirmware {
  if (!result.ok) throw new Error(result.refusals.map((refusal) => refusal.message).join("; "));
  return result.value;
}
const codesOf = (result: ReturnType<typeof rebuildFirmware>) => (result.ok ? [] : result.refusals.map((refusal) => refusal.code));

// What a fresh code analysis of the rebuilt image says the vector now holds.
function vectorOf(extracted: Awaited<ReturnType<typeof extractAptioIvBytes>>) {
  const report = inspectAmiRootVisibility(roots, extracted.provenance);
  return report.status === "detected" ? report.entries.map((entry) => entry.value) : report.reason;
}

describe("rebuildFirmware with an edit to a byte of a decoded buffer", () => {
  for (const [name, make] of [["an uncompressed", setupVolume], ["an LZMA-wrapped", lzmaWrapped]] as const) {
    it(`flips one root byte in ${name} image, repairs the file's checksum and reads back as intended`, async () => {
      const image = make([1, 1, 1]);
      const open = await opened(image);
      const edit = rootEdit(open, 1, 0);

      const rebuilt = unwrap(rebuildFirmware(open.graph, [edit], { codecs }));

      expect(rebuilt.image.length).toBe(image.length);
      expect(verifyRebuiltFirmware(open.graph, [edit], rebuilt, { codecs })).toEqual([]);
      const problems = await verifyByReextraction(open.graph, [edit], rebuilt.image, {
        decompress,
        inspect: (extracted) => {
          const values = vectorOf(extracted);
          return Array.isArray(values) && values.join() === "1,0,1" ? [] : [`vector reads ${String(values)}`];
        },
      });
      expect(problems).toEqual([]);
      const again = await extractAptioIvBytes(rebuilt.image, noIfr, decompress);
      expect(vectorOf(again)).toEqual([1, 0, 1]);
    });
  }

  it("changes only the byte and the checksum of its file when nothing is compressed", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const image = open.graph.buffers[0].bytes;

    const rebuilt = unwrap(rebuildFirmware(open.graph, [rootEdit(open, 2, 0)], { codecs }));

    const changed = Array.from(rebuilt.image, (byte, index) => (byte === image[index] ? -1 : index)).filter((index) => index >= 0);
    // The root byte itself, and the file's data checksum byte.
    expect(changed).toEqual([open.file.fileStart + 17, open.report.entries[2].bufferOffset]);
    expect((sum8(rebuilt.image, open.file.bodyStart, open.file.end) + rebuilt.image[open.file.fileStart + 17]) & 0xff).toBe(0);
  });

  it("combines with an edit to the HII artifact in the same file", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const hiiIndex = open.graph.artifacts.findIndex((artifact) => artifact.kind === "setup-hii");
    const hii = open.graph.artifacts[hiiIndex];
    const node = open.graph.buffers.find((buffer) => buffer.id === hii.bufferId);
    if (!node) throw new Error("no buffer");
    const expected = node.bytes.slice(hii.payloadStart + 10, hii.payloadStart + 14);
    const artifactEdit: ArtifactEdit = { artifactIndex: hiiIndex, offset: 10, expected, replacement: expected.map((byte) => byte ^ 0xff) };
    const edits = [artifactEdit, rootEdit(open, 0, 0)];

    const rebuilt = unwrap(rebuildFirmware(open.graph, edits, { codecs }));

    expect(rebuilt.repairedFiles.filter((file) => file.changed)).toHaveLength(1);
    expect(verifyRebuiltFirmware(open.graph, edits, rebuilt, { codecs })).toEqual([]);
    const again = await extractAptioIvBytes(rebuilt.image, noIfr, decompress);
    expect(Array.from(again.hii.slice(10, 14))).toEqual(Array.from(artifactEdit.replacement));
    expect(vectorOf(again)).toEqual([0, 1, 1]);
  });

  it("is told apart from an artifact edit", async () => {
    const open = await opened(setupVolume([1, 1, 1]));

    expect(isBufferEdit(rootEdit(open, 0, 0))).toBe(true);
    expect(isBufferEdit({ artifactIndex: 0, offset: 0, expected: new Uint8Array(1), replacement: new Uint8Array(1) })).toBe(false);
  });
});

describe("rebuildFirmware refuses a buffer edit it cannot place", () => {
  it("refuses bytes that are not the ones the edit expects", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const edit = { ...rootEdit(open, 0, 0), expected: Uint8Array.of(0) };

    expect(codesOf(rebuildFirmware(open.graph, [edit], { codecs }))).toEqual(["precondition-mismatch"]);
  });

  it("refuses bytes outside the body of the file it names", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const before = { ...rootEdit(open, 0, 0), offset: open.file.fileStart, expected: open.graph.buffers[0].bytes.slice(open.file.fileStart, open.file.fileStart + 1) };

    expect(codesOf(rebuildFirmware(open.graph, [before], { codecs }))).toEqual(["edit-out-of-range"]);
    const past = { ...rootEdit(open, 0, 0), offset: open.file.end, expected: Uint8Array.of(0xff) };
    expect(codesOf(rebuildFirmware(open.graph, [past], { codecs }))).toEqual(["edit-out-of-range"]);
  });

  it("refuses a file that is not in the buffer the edit names", async () => {
    const open = await opened(lzmaWrapped([1, 1, 1]));
    const wrong = { ...rootEdit(open, 0, 0), file: { ...open.file, bufferId: 0 } };

    expect(codesOf(rebuildFirmware(open.graph, [wrong], { codecs }))).toContain("source-file-elsewhere");
  });

  it("refuses a buffer the image does not have", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const missing = { ...rootEdit(open, 0, 0), bufferId: 99, file: { ...open.file, bufferId: 99 } };

    expect(codesOf(rebuildFirmware(open.graph, [missing], { codecs }))).toEqual(["incomplete-path"]);
  });

  it("refuses a change of length", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const longer = { ...rootEdit(open, 0, 0), replacement: Uint8Array.of(0, 0) };

    expect(codesOf(rebuildFirmware(open.graph, [longer], { codecs }))).toEqual(["size-change"]);
  });

  it("refuses two edits to the same byte", async () => {
    const open = await opened(setupVolume([1, 1, 1]));

    expect(codesOf(rebuildFirmware(open.graph, [rootEdit(open, 0, 0), rootEdit(open, 0, 0)], { codecs }))).toEqual(["overlapping-edits"]);
  });

  it("refuses a buffer that has no path back to the image", async () => {
    const open = await opened(lzmaWrapped([1, 1, 1]));
    const cut: FirmwareProvenanceGraph = {
      ...open.graph,
      buffers: open.graph.buffers.map((node) => (node.id === open.vector.bufferId && node.parent ? { ...node, parent: { ...node.parent, parentBufferId: 77 } } : node)),
    };

    expect(codesOf(rebuildFirmware(cut, [rootEdit(open, 0, 0)], { codecs })).length).toBeGreaterThan(0);
  });
});

describe("the verification of a buffer edit", () => {
  it("catches a replacement that is not in the rebuilt image", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const edit = rootEdit(open, 1, 0);
    const rebuilt = unwrap(rebuildFirmware(open.graph, [edit], { codecs }));
    const undone = { ...rebuilt, image: rebuilt.image.slice(), buffers: new Map(rebuilt.buffers) };
    undone.image[edit.offset] = 1;
    undone.buffers.set(0, undone.image);

    expect(verifyRebuiltFirmware(open.graph, [edit], undone, { codecs }).join("\n")).toMatch(/not in place/);
  });

  it("catches an extra change next to the edited byte", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const edit = rootEdit(open, 1, 0);
    const rebuilt = unwrap(rebuildFirmware(open.graph, [edit], { codecs }));
    const extra = { ...rebuilt, image: rebuilt.image.slice(), buffers: new Map(rebuilt.buffers) };
    extra.image[edit.offset + 1] ^= 1;
    extra.buffers.set(0, extra.image);

    expect(verifyRebuiltFirmware(open.graph, [edit], extra, { codecs }).length).toBeGreaterThan(0);
  });

  it("catches, at read-back, a byte that reads back other than requested", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const edit = rootEdit(open, 1, 0);
    const rebuilt = unwrap(rebuildFirmware(open.graph, [edit], { codecs }));
    const lie = { ...edit, replacement: Uint8Array.of(1) };

    const problems = await verifyByReextraction(open.graph, [lie], rebuilt.image, { decompress });

    expect(problems.join("\n")).toMatch(/reads back differently from the requested edit/);
  });

  it("catches, at read-back, a buffer that is no longer there", async () => {
    const open = await opened(lzmaWrapped([1, 1, 1]));
    const edit = rootEdit(open, 1, 0);
    const rebuilt = unwrap(rebuildFirmware(open.graph, [edit], { codecs }));
    const bad: FirmwareDecompressor = (input, mode) => (mode === "lzma" ? Promise.resolve(new Uint8Array(10)) : decompress(input, mode));

    const problems = await verifyByReextraction(open.graph, [edit], rebuilt.image, { decompress: bad });

    expect(problems.length).toBeGreaterThan(0);
  });

  it("lets the caller add its own check of what was read back", async () => {
    const open = await opened(setupVolume([1, 1, 1]));
    const edit = rootEdit(open, 1, 0);
    const rebuilt = unwrap(rebuildFirmware(open.graph, [edit], { codecs }));

    const problems = await verifyByReextraction(open.graph, [edit], rebuilt.image, { decompress, inspect: () => ["the caller does not like it"] });

    expect(problems).toEqual(["the caller does not like it"]);
  });
});
