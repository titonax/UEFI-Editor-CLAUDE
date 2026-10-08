import { describe, expect, it } from "vitest";
import { extractAptioIvBytes, type FirmwareDecompressor } from "./aptioIvExtractor";
import {
  AMITSE_GUID,
  FFS_ATTRIB_CHECKSUM,
  FFS_ATTRIB_TAIL_PRESENT,
  LZMA_CUSTOM_DECOMPRESS_GUID,
  PASS_THROUGH_GUID,
  compressionSection,
  concat,
  firmwareVolume,
  guidDefinedSection,
  patternBytes,
  sectionStream,
  setupFiles,
  spiImage,
  sum8,
  volumeHeaderChecksumValid,
} from "./firmwareImageFixtures";
import type { FirmwareProvenanceGraph } from "./firmwareProvenance";
import {
  rebuildFirmware,
  verifyByReextraction,
  verifyRebuiltFirmware,
  type ArtifactEdit,
  type RebuiltFirmware,
} from "./firmwareRebuild";

const noIfr = () => Promise.resolve("");
const refuseDecompression: FirmwareDecompressor = () => Promise.reject(new Error("not available"));
// Stands in for a real decompressor: the fixtures store the "compressed"
// payload as the raw inner volume, so decoding is the identity.
const identityDecompression: FirmwareDecompressor = (input) => Promise.resolve(input);

const payloads = {
  hii: patternBytes(96, 1),
  amitse: patternBytes(64, 2),
  setupData: patternBytes(48, 3),
};

async function graphOf(image: Uint8Array, decompress = refuseDecompression): Promise<FirmwareProvenanceGraph> {
  return (await extractAptioIvBytes(image, noIfr, decompress)).provenance;
}

function artifactIndex(graph: FirmwareProvenanceGraph, kind: string) {
  const index = graph.artifacts.findIndex((artifact) => artifact.kind === kind);
  if (index < 0) throw new Error(`no ${kind} artifact`);
  return index;
}

// An edit that flips the bytes at `offset` of one artifact, with the
// precondition read from the graph's own copy of the source.
function flipEdit(graph: FirmwareProvenanceGraph, kind: string, offset: number, length = 4): ArtifactEdit {
  const index = artifactIndex(graph, kind);
  const artifact = graph.artifacts[index];
  const node = graph.buffers.find((buffer) => buffer.id === artifact.bufferId);
  if (!node) throw new Error("no buffer");
  const start = artifact.payloadStart + offset;
  const expected = node.bytes.slice(start, start + length);
  return { artifactIndex: index, offset, expected, replacement: expected.map((byte) => byte ^ 0xff) };
}

function unwrap(result: ReturnType<typeof rebuildFirmware>): RebuiltFirmware {
  if (!result.ok) throw new Error(result.refusals.map((refusal) => refusal.message).join("; "));
  return result.value;
}

function differingOffsets(a: Uint8Array, b: Uint8Array) {
  return [...a.keys()].filter((index) => a[index] !== b[index]);
}

const checksummed = FFS_ATTRIB_CHECKSUM;

describe("rebuildFirmware on an uncompressed image", () => {
  const volume = firmwareVolume(setupFiles(payloads, checksummed));

  it("returns the source image byte for byte when there is nothing to change", async () => {
    const graph = await graphOf(volume);

    const rebuilt = unwrap(rebuildFirmware(graph, []));

    expect(rebuilt.image).toEqual(volume);
    expect(rebuilt.changedBytes).toBe(0);
    expect(rebuilt.repairedFiles).toEqual([]);
  });

  it("changes only the edited bytes and the data checksum of the file that holds them", async () => {
    const graph = await graphOf(volume);
    const edit = flipEdit(graph, "setup-hii", 10);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    const artifact = graph.artifacts[edit.artifactIndex];
    const editStart = artifact.payloadStart + edit.offset;
    const file = artifact.sourceFile;
    expect(differingOffsets(volume, rebuilt.image)).toEqual([
      file.fileStart + 17,
      editStart,
      editStart + 1,
      editStart + 2,
      editStart + 3,
    ]);
    expect(rebuilt.image.slice(editStart, editStart + 4)).toEqual(edit.replacement);
    // An independent check of the repaired byte: the file's data sums to zero.
    expect(sum8(rebuilt.image, file.bodyStart, file.end) + rebuilt.image[file.fileStart + 17]).toBe(256);
    expect(volumeHeaderChecksumValid(rebuilt.image, file.volumeStart)).toBe(true);
    expect(rebuilt.repairedFiles).toHaveLength(1);
    expect(rebuilt.changedBytes).toBe(5);
  });

  it("repairs nothing for a file that carries no data checksum", async () => {
    const plain = firmwareVolume(setupFiles(payloads, 0));
    const graph = await graphOf(plain);
    const edit = flipEdit(graph, "setup-hii", 10);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    expect(rebuilt.changedBytes).toBe(4);
    expect(rebuilt.repairedFiles.every((file) => !file.changed)).toBe(true);
  });

  it("rebuilds several artifacts in different files in one pass", async () => {
    const graph = await graphOf(volume);
    const edits = [
      flipEdit(graph, "setup-hii", 0, 2),
      flipEdit(graph, "amitse", 8, 2),
      flipEdit(graph, "setupdata", 4, 3),
    ];

    const rebuilt = unwrap(rebuildFirmware(graph, edits));

    expect(rebuilt.changedBytes).toBe(2 + 2 + 3 + 2);
    expect(rebuilt.repairedFiles.map((file) => file.guid).sort()).toEqual(
      [AMITSE_GUID, "899407D7-99FE-43D8-9A21-79EC328CAC21"].sort(),
    );
    expect(await verifyByReextraction(graph, edits, rebuilt.image)).toEqual([]);
  });

  it("treats an edit that writes the bytes already there as no change", async () => {
    const graph = await graphOf(volume);
    const index = artifactIndex(graph, "setup-hii");
    const expected = graph.buffers[0].bytes.slice(
      graph.artifacts[index].payloadStart,
      graph.artifacts[index].payloadStart + 4,
    );

    const rebuilt = unwrap(rebuildFirmware(graph, [{ artifactIndex: index, offset: 0, expected, replacement: expected.slice() }]));

    expect(rebuilt.image).toEqual(volume);
  });

  it("never touches the source image it was given", async () => {
    const graph = await graphOf(volume);
    const before = graph.buffers[0].bytes.slice();

    unwrap(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 10)]));

    expect(graph.buffers[0].bytes).toEqual(before);
  });
});

describe("rebuildFirmware refuses edits it cannot prove", () => {
  const volume = firmwareVolume(setupFiles(payloads, checksummed));

  async function refusalCodes(edits: (graph: FirmwareProvenanceGraph) => ArtifactEdit[], image = volume) {
    const graph = await graphOf(image);
    const result = rebuildFirmware(graph, edits(graph));
    return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
  }

  it("refuses when the bytes it was told to replace are not the bytes in the image", async () => {
    const codes = await refusalCodes((graph) => {
      const edit = flipEdit(graph, "setup-hii", 10);
      return [{ ...edit, expected: edit.expected.map((byte) => byte ^ 0x01) }];
    });

    expect(codes).toEqual(["precondition-mismatch"]);
  });

  it("refuses a replacement of a different length: nothing here can resize a section", async () => {
    const codes = await refusalCodes((graph) => {
      const edit = flipEdit(graph, "setup-hii", 10);
      return [{ ...edit, replacement: new Uint8Array(5) }];
    });

    expect(codes).toEqual(["size-change"]);
  });

  it("refuses an edit outside the artifact, even if it is inside the image", async () => {
    const codes = await refusalCodes((graph) => {
      const index = artifactIndex(graph, "setup-hii");
      const length = graph.artifacts[index].payloadEnd - graph.artifacts[index].payloadStart;
      return [{ artifactIndex: index, offset: length - 2, expected: new Uint8Array(4), replacement: new Uint8Array(4) }];
    });

    expect(codes).toEqual(["edit-out-of-range"]);
  });

  it("refuses an edit for an artifact the graph does not have", async () => {
    const codes = await refusalCodes(() => [
      { artifactIndex: 9, offset: 0, expected: new Uint8Array(1), replacement: new Uint8Array(1) },
    ]);

    expect(codes).toEqual(["artifact-missing"]);
  });

  it("refuses overlapping edits instead of choosing a winner", async () => {
    const codes = await refusalCodes((graph) => [flipEdit(graph, "setup-hii", 10, 4), flipEdit(graph, "setup-hii", 12, 4)]);

    expect(codes).toEqual(["overlapping-edits"]);
  });

  it("reports every refusal, not just the first", async () => {
    const graph = await graphOf(volume);
    const bad = flipEdit(graph, "setup-hii", 10);
    const result = rebuildFirmware(graph, [
      { ...bad, expected: bad.expected.map((byte) => byte ^ 1) },
      { artifactIndex: 7, offset: 0, expected: new Uint8Array(1), replacement: new Uint8Array(1) },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((refusal) => refusal.code).sort()).toEqual(["artifact-missing", "precondition-mismatch"]);
  });

  it("refuses a file whose own checksums were already wrong in the source", async () => {
    const files = setupFiles(payloads, checksummed);
    files[0].badFileChecksum = true;

    expect(await refusalCodes((graph) => [flipEdit(graph, "setup-hii", 10)], firmwareVolume(files))).toEqual([
      "invalid-file-checksum",
    ]);
  });

  it("refuses a file with a tail attribute", async () => {
    const image = firmwareVolume(setupFiles(payloads, checksummed | FFS_ATTRIB_TAIL_PRESENT));

    expect(await refusalCodes((graph) => [flipEdit(graph, "setup-hii", 10)], image)).toEqual([
      "unsupported-file-attributes",
    ]);
  });
});

describe("rebuildFirmware through an uncompressed encapsulation", () => {
  const inner = firmwareVolume(setupFiles(payloads, checksummed));
  const wrap = (section: Uint8Array) =>
    firmwareVolume([{ guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: sectionStream(section) }]);

  it("repairs the inner file and the outer file that carries the section", async () => {
    const image = wrap(guidDefinedSection(PASS_THROUGH_GUID, 0, inner));
    const graph = await graphOf(image);
    expect(graph.buffers).toHaveLength(2);
    const edit = flipEdit(graph, "setup-hii", 6);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    expect(rebuilt.repairedFiles.map((file) => file.bufferId).sort()).toEqual([0, 1]);
    const outer = graph.buffers[1].parent?.ownerFile;
    if (!outer) throw new Error("no owner file");
    expect(sum8(rebuilt.image, outer.bodyStart, outer.end) + rebuilt.image[outer.fileStart + 17]).toBe(256);
    // The inner checksum byte compensates the edit exactly, so the outer
    // file's data sum does not move: both files are consistent, and only the
    // edited bytes and the inner checksum byte changed.
    expect(rebuilt.changedBytes).toBe(4 + 1);
    expect(rebuilt.repairedFiles.find((file) => file.bufferId === 0)?.changed).toBe(false);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image)).toEqual([]);
  });

  it("repairs the outer file's checksum when the inner file has none to compensate", async () => {
    const innerPlain = firmwareVolume(setupFiles(payloads, 0));
    const image = wrap(guidDefinedSection(PASS_THROUGH_GUID, 0, innerPlain));
    const graph = await graphOf(image);
    const edit = flipEdit(graph, "setup-hii", 6);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    const outer = graph.buffers[1].parent?.ownerFile;
    if (!outer) throw new Error("no owner file");
    expect(rebuilt.repairedFiles.find((file) => file.bufferId === 0)?.changed).toBe(true);
    expect(sum8(rebuilt.image, outer.bodyStart, outer.end) + rebuilt.image[outer.fileStart + 17]).toBe(256);
    expect(rebuilt.changedBytes).toBe(4 + 1);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image)).toEqual([]);
  });

  it("refuses to go through an LZMA or EFI/Tiano section: recompression does not exist yet", async () => {
    const image = wrap(compressionSection(2, inner.length, inner));
    const graph = await graphOf(image, identityDecompression);
    expect(graph.buffers[1].parent?.compression).toBe("lzma");

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 6)]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((refusal) => refusal.code)).toEqual(["compressed-section"]);
  });

  it("refuses a GUID-defined section that carries data of its own, such as a CRC32 or a signature", async () => {
    const image = wrap(guidDefinedSection(PASS_THROUGH_GUID, 0, inner, new Uint8Array([1, 2, 3, 4])));
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 6)]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((refusal) => refusal.code)).toEqual(["unsupported-section"]);
  });

  it("refuses a GUID-defined section with attribute bits set, even if it needs no processing", async () => {
    const image = wrap(guidDefinedSection(PASS_THROUGH_GUID, 0x02, inner));
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 6)]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((refusal) => refusal.code)).toEqual(["unsupported-section"]);
  });

  it("does not mistake the LZMA GUID for a pass-through section", async () => {
    const image = wrap(guidDefinedSection(LZMA_CUSTOM_DECOMPRESS_GUID, 1, inner));
    const graph = await graphOf(image, identityDecompression);

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 6)]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((refusal) => refusal.code)).toEqual(["compressed-section"]);
  });
});

describe("rebuildFirmware on a complete SPI image", () => {
  const bios = firmwareVolume(setupFiles(payloads, checksummed));

  it("changes bytes only inside the BIOS region and leaves the descriptor untouched", async () => {
    const image = spiImage(bios);
    const graph = await graphOf(image);
    const edit = flipEdit(graph, "setup-hii", 10);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    expect(rebuilt.image.length).toBe(image.length);
    expect(rebuilt.image.slice(0, 0x1000)).toEqual(image.slice(0, 0x1000));
    expect(differingOffsets(image, rebuilt.image).every((offset) => offset >= 0x1000)).toBe(true);
    expect(rebuilt.changedBytes).toBe(5);
  });

  it("refuses to change a byte the descriptor does not put in the BIOS region", async () => {
    // The BIOS region is declared as the third block only, so the volume at
    // the start of the BIOS bytes (the second block) lies outside it.
    const padded = concat(bios, new Uint8Array(0x3000 - bios.length).fill(0xff));
    const image = spiImage(padded, { biosBaseBlock: 3, biosLimitBlock: 3 });
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 10)]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((refusal) => refusal.code)).toEqual(["outside-bios-region"]);
  });

  it("refuses when the descriptor's BIOS region cannot be read, instead of assuming one", async () => {
    const image = spiImage(bios, { brokenMap: true });
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 10)]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((refusal) => refusal.code)).toEqual(["descriptor-invalid"]);
  });

  it("does not ask the descriptor anything when there is nothing to change", async () => {
    const graph = await graphOf(spiImage(bios, { brokenMap: true }));

    expect(rebuildFirmware(graph, []).ok).toBe(true);
  });
});

describe("verifyRebuiltFirmware", () => {
  const volume = firmwareVolume(setupFiles(payloads, checksummed));

  async function rebuilt() {
    const graph = await graphOf(volume);
    const edits = [flipEdit(graph, "setup-hii", 10)];
    return { graph, edits, value: unwrap(rebuildFirmware(graph, edits)) };
  }

  it("finds nothing wrong with a faithful rebuild", async () => {
    const { graph, edits, value } = await rebuilt();

    expect(verifyRebuiltFirmware(graph, edits, value)).toEqual([]);
  });

  it("flags a byte that changed outside the edits and the repaired checksums", async () => {
    const { graph, edits, value } = await rebuilt();
    const tampered = { ...value, image: value.image.slice() };
    tampered.image[tampered.image.length - 3] ^= 0x01;

    expect(verifyRebuiltFirmware(graph, edits, tampered).join(" ")).toMatch(/outside the edits/);
  });

  it("flags an edit that did not land", async () => {
    const { graph, edits, value } = await rebuilt();
    const tampered = { ...value, image: value.image.slice() };
    const start = graph.artifacts[edits[0].artifactIndex].payloadStart + edits[0].offset;
    tampered.image.set(edits[0].expected, start);

    expect(verifyRebuiltFirmware(graph, edits, tampered).join(" ")).toMatch(/replacement/);
  });

  it("flags a file checksum that was not repaired", async () => {
    const { graph, edits, value } = await rebuilt();
    const tampered = { ...value, image: value.image.slice() };
    tampered.image[graph.artifacts[0].sourceFile.fileStart + 17] ^= 0xff;

    expect(verifyRebuiltFirmware(graph, edits, tampered).join(" ")).toMatch(/checksum/);
  });

  it("flags an image of a different size", async () => {
    const { graph, edits, value } = await rebuilt();

    expect(verifyRebuiltFirmware(graph, edits, { ...value, image: value.image.slice(0, -1) }).join(" ")).toMatch(/size/);
  });
});

describe("verifyByReextraction", () => {
  const volume = firmwareVolume(setupFiles(payloads, checksummed));

  it("reads the rebuilt image back with the extractor and finds exactly the requested edit", async () => {
    const graph = await graphOf(volume);
    const edits = [flipEdit(graph, "setup-hii", 10)];
    const rebuilt = unwrap(rebuildFirmware(graph, edits));

    expect(await verifyByReextraction(graph, edits, rebuilt.image)).toEqual([]);
  });

  it("reports an image that reads back differently from what was asked for", async () => {
    const graph = await graphOf(volume);
    const edits = [flipEdit(graph, "setup-hii", 10)];
    const rebuilt = unwrap(rebuildFirmware(graph, edits));
    const tampered = rebuilt.image.slice();
    tampered[graph.artifacts[0].payloadStart + 50] ^= 0x01;

    expect((await verifyByReextraction(graph, edits, tampered)).join(" ")).toMatch(/setup-hii/);
  });

  it("reports an image that no longer contains the Setup it was built from", async () => {
    const graph = await graphOf(volume);

    expect((await verifyByReextraction(graph, [], new Uint8Array(volume.length).fill(0xff))).join(" ")).toMatch(/could not be read back/);
  });
});
