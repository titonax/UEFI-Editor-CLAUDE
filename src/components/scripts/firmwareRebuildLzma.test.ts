import { describe, expect, it } from "vitest";
import { extractAptioIvBytes, type FirmwareDecompressor } from "./aptioIvExtractor";
import {
  LZMA_CUSTOM_DECOMPRESS_GUID,
  compressionSection,
  compressionSectionExtended,
  concat,
  firmwareVolume,
  guidDefinedSection,
  patternBytes,
  sectionStream,
  setupFiles,
  sum8,
} from "./firmwareImageFixtures";
import type { FirmwareProvenanceGraph } from "./firmwareProvenance";
import {
  rebuildFirmware,
  verifyByReextraction,
  verifyRebuiltFirmware,
  type ArtifactEdit,
  type RebuiltFirmware,
} from "./firmwareRebuild";
import { lzmaJsCodec } from "./lzmaJs";
import { referenceLzmaDecode } from "./referenceLzma";

const codecs = { lzma: lzmaJsCodec };
const noIfr = () => Promise.resolve("");
const lzmaDecompress: FirmwareDecompressor = (input, mode) =>
  mode === "lzma" ? Promise.resolve(lzmaJsCodec.decode(input)) : Promise.reject(new Error("no EFI/Tiano decoder"));
// Reads an LZMA section as if its stream were the raw inner data: lets a test
// build a graph for a stream it has deliberately damaged.
const rawDecompress: (inner: Uint8Array) => FirmwareDecompressor = (inner) => () => Promise.resolve(inner);

const checksummed = 0x40;

// Bytes LZMA cannot compress (a deterministic xorshift), unlike patternBytes,
// whose period of 256 it compresses well.
function randomBytes(length: number, seed: number) {
  let state = seed >>> 0 || 1;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  });
}
const erasedTail = (length: number) => new Uint8Array(length).fill(0xff);

async function graphOf(image: Uint8Array, decompress: FirmwareDecompressor = lzmaDecompress): Promise<FirmwareProvenanceGraph> {
  return (await extractAptioIvBytes(image, noIfr, decompress)).provenance;
}

function flipEdit(graph: FirmwareProvenanceGraph, kind: string, offset: number, length = 4): ArtifactEdit {
  const index = graph.artifacts.findIndex((artifact) => artifact.kind === kind);
  const artifact = graph.artifacts[index];
  const node = graph.buffers.find((buffer) => buffer.id === artifact.bufferId);
  if (!node) throw new Error("no buffer");
  const start = artifact.payloadStart + offset;
  const expected = node.bytes.slice(start, start + length);
  return { artifactIndex: index, offset, expected, replacement: expected.map((byte) => byte ^ 0xff) };
}

function replaceEdit(graph: FirmwareProvenanceGraph, kind: string, offset: number, replacement: Uint8Array): ArtifactEdit {
  const index = graph.artifacts.findIndex((artifact) => artifact.kind === kind);
  const artifact = graph.artifacts[index];
  const node = graph.buffers.find((buffer) => buffer.id === artifact.bufferId);
  if (!node) throw new Error("no buffer");
  const start = artifact.payloadStart + offset;
  return { artifactIndex: index, offset, expected: node.bytes.slice(start, start + replacement.length), replacement };
}

function unwrap(result: ReturnType<typeof rebuildFirmware>): RebuiltFirmware {
  if (!result.ok) throw new Error(result.refusals.map((refusal) => refusal.message).join("; "));
  return result.value;
}

type Wrapper = "compression" | "guided" | "extended";

function lzmaSection(decoded: Uint8Array, wrapper: Wrapper = "compression", preset = 8) {
  const stream = lzmaJsCodec.encode(decoded, preset);
  if (wrapper === "guided") return guidDefinedSection(LZMA_CUSTOM_DECOMPRESS_GUID, 1, stream);
  if (wrapper === "extended") return compressionSectionExtended(2, decoded.length, stream);
  return compressionSection(2, decoded.length, stream);
}

function codesOf(result: ReturnType<typeof rebuildFirmware>) {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

// A volume whose single file holds one LZMA section carrying `inner`, then
// `tail` bytes of padding.
function wrapInLzma(inner: Uint8Array, options: { wrapper?: Wrapper; tail?: number; attributes?: number } = {}) {
  return firmwareVolume([
    {
      guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      attributes: options.attributes ?? checksummed,
      body: concat(sectionStream(lzmaSection(inner, options.wrapper ?? "compression")), erasedTail(options.tail ?? 64)),
    },
  ]);
}

// Setup content that compresses visibly: runs of one byte.
const compressible = { hii: new Uint8Array(2000).fill(0x41), amitse: patternBytes(64, 2), setupData: patternBytes(48, 3) };
const innerVolume = (payloads = compressible, attributes = checksummed) => firmwareVolume(setupFiles(payloads, attributes));

describe("rebuildFirmware through an LZMA section", () => {
  for (const wrapper of ["compression", "guided", "extended"] as const) {
    it(`re-encodes a ${wrapper} LZMA section inside its file and keeps the file's size`, async () => {
      const image = wrapInLzma(innerVolume(), { wrapper });
      const graph = await graphOf(image);
      const edge = graph.buffers[1].parent;
      if (!edge?.ownerFile) throw new Error("no edge");
      expect(edge.compression).toBe("lzma");
      const edit = flipEdit(graph, "setup-hii", 100, 8);

      const rebuilt = unwrap(rebuildFirmware(graph, [edit], { codecs }));

      expect(rebuilt.image.length).toBe(image.length);
      expect(rebuilt.layoutChanges).toHaveLength(1);
      const change = rebuilt.layoutChanges[0];
      const owner = edge.ownerFile;
      // The file keeps its header (except the data checksum) and its size.
      expect(rebuilt.image.slice(owner.fileStart, owner.fileStart + 17)).toEqual(image.slice(owner.fileStart, owner.fileStart + 17));
      expect(rebuilt.image.slice(owner.fileStart + 18, owner.bodyStart)).toEqual(image.slice(owner.fileStart + 18, owner.bodyStart));
      // The section's size matches the new stream; the padding after it is erased.
      const newEnd = edge.payloadStart + change.packedAfter;
      const sizeField = edge.sectionHeaderSize === 4
        ? rebuilt.image[edge.sectionStart] | (rebuilt.image[edge.sectionStart + 1] << 8) | (rebuilt.image[edge.sectionStart + 2] << 16)
        : new DataView(rebuilt.image.buffer).getUint32(edge.sectionStart + 4, true);
      expect(edge.sectionStart + sizeField).toBe(newEnd);
      expect(rebuilt.image.slice(newEnd, owner.end).every((byte) => byte === 0xff)).toBe(true);
      expect(change.paddingBefore + change.packedBefore).toBe(change.paddingAfter + change.packedAfter);
      expect(sum8(rebuilt.image, owner.bodyStart, owner.end) + rebuilt.image[owner.fileStart + 17]).toBe(256);
      expect(verifyRebuiltFirmware(graph, [edit], rebuilt, { codecs })).toEqual([]);
      expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress: lzmaDecompress })).toEqual([]);
    });
  }

  it("writes a stream a reference decoder reads back to the rebuilt inner volume", async () => {
    const image = wrapInLzma(innerVolume());
    const graph = await graphOf(image);
    const edge = graph.buffers[1].parent;
    if (!edge) throw new Error("no edge");
    const rebuilt = unwrap(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100, 8)], { codecs }));
    const stream = rebuilt.image.slice(edge.payloadStart, edge.payloadStart + rebuilt.layoutChanges[0].packedAfter);

    const reference = await referenceLzmaDecode(stream);
    if (reference === null) return; // xz is not installed here; CI has it

    expect(reference).toEqual(rebuilt.buffers.get(1));
  });

  it("lets the section shrink into the padding", async () => {
    const image = wrapInLzma(innerVolume({ ...compressible, hii: randomBytes(2000, 9) }), { tail: 400 });
    const graph = await graphOf(image);
    const edit = replaceEdit(graph, "setup-hii", 100, new Uint8Array(1500));

    const rebuilt = unwrap(rebuildFirmware(graph, [edit], { codecs }));

    const change = rebuilt.layoutChanges[0];
    expect(change.packedAfter).toBeLessThan(change.packedBefore);
    expect(change.paddingAfter).toBeGreaterThan(change.paddingBefore);
    expect(change.packedBefore + change.paddingBefore).toBe(change.packedAfter + change.paddingAfter);
    expect(rebuilt.image.length).toBe(image.length);
    expect(verifyRebuiltFirmware(graph, [edit], rebuilt, { codecs })).toEqual([]);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress: lzmaDecompress })).toEqual([]);
  });

  it("lets the section grow into the padding", async () => {
    const image = wrapInLzma(innerVolume(), { tail: 400 });
    const graph = await graphOf(image);
    const edit = replaceEdit(graph, "setup-hii", 100, randomBytes(300, 3));

    const rebuilt = unwrap(rebuildFirmware(graph, [edit], { codecs }));

    const change = rebuilt.layoutChanges[0];
    expect(change.packedAfter).toBeGreaterThan(change.packedBefore);
    expect(change.paddingAfter).toBeLessThan(change.paddingBefore);
    expect(verifyRebuiltFirmware(graph, [edit], rebuilt, { codecs })).toEqual([]);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress: lzmaDecompress })).toEqual([]);
  });

  it("is deterministic", async () => {
    const graph = await graphOf(wrapInLzma(innerVolume()));
    const edit = flipEdit(graph, "setup-hii", 100, 8);

    expect(unwrap(rebuildFirmware(graph, [edit], { codecs })).image).toEqual(
      unwrap(rebuildFirmware(graph, [edit], { codecs })).image,
    );
  });

  it("returns the source byte for byte when nothing changes, even through an LZMA section", async () => {
    const image = wrapInLzma(innerVolume());
    const graph = await graphOf(image);

    expect(unwrap(rebuildFirmware(graph, [], { codecs })).image).toEqual(image);
  });
});

describe("rebuildFirmware refuses an LZMA section it cannot resize safely", () => {
  it("refuses without an LZMA codec, naming it", async () => {
    const graph = await graphOf(wrapInLzma(innerVolume()));

    expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)]))).toEqual(["compressed-section"]);
  });

  it("refuses a section followed by anything but erased padding", async () => {
    const section = sectionStream(lzmaSection(innerVolume()));
    const tail = erasedTail(64);
    tail[10] = 0x00;
    const image = firmwareVolume([{ guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(section, tail) }]);
    const graph = await graphOf(image);

    expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)], { codecs }))).toEqual(["section-not-terminal"]);
  });

  it("refuses a result that does not fit before the end of the file", async () => {
    const image = wrapInLzma(innerVolume(), { tail: 0 });
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [replaceEdit(graph, "setup-hii", 100, randomBytes(1800, 7))], { codecs });

    expect(codesOf(result)).toEqual(["lzma-does-not-fit"]);
  });

  it("refuses to create padding where the source had none", async () => {
    const image = wrapInLzma(innerVolume({ ...compressible, hii: randomBytes(2000, 9) }), { tail: 0 });
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [replaceEdit(graph, "setup-hii", 100, new Uint8Array(1500))], { codecs });

    expect(codesOf(result)).toEqual(["lzma-padding-change"]);
  });

  it("refuses a stream whose properties this encoder cannot reproduce", async () => {
    const inner = innerVolume();
    const stream = lzmaJsCodec.encode(inner, 8).slice();
    stream[0] = 0x5e;
    const image = firmwareVolume([
      { guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(compressionSection(2, inner.length, stream)), erasedTail(64)) },
    ]);
    const graph = await graphOf(image, rawDecompress(inner));

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)], { codecs });

    expect(codesOf(result)).toEqual(["lzma-recompression"]);
    if (!result.ok) expect(result.refusals[0].message).toMatch(/properties/);
  });

  it("still refuses an EFI/Tiano section, codec or not", async () => {
    const inner = innerVolume();
    const image = firmwareVolume([
      { guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(compressionSection(1, inner.length, inner)), erasedTail(64)) },
    ]);
    const graph = await graphOf(image, rawDecompress(inner));
    expect(graph.buffers[1].parent?.compression).toBe("standard");

    expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)], { codecs }))).toEqual(["compressed-section"]);
  });
});

describe("rebuildFirmware through two LZMA levels", () => {
  it("re-encodes both, repairs the file at each level and reads back", async () => {
    const innerFv = innerVolume();
    const middle = wrapInLzma(innerFv, { tail: 64 });
    const outer = wrapInLzma(middle, { tail: 64 });
    const graph = await graphOf(outer);
    expect(graph.buffers.map((buffer) => buffer.depth)).toEqual([0, 1, 2]);
    const edit = flipEdit(graph, "setup-hii", 100, 8);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit], { codecs }));

    expect(rebuilt.layoutChanges).toHaveLength(2);
    expect(rebuilt.image.length).toBe(outer.length);
    expect(verifyRebuiltFirmware(graph, [edit], rebuilt, { codecs })).toEqual([]);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress: lzmaDecompress })).toEqual([]);
  });
});

describe("verifyRebuiltFirmware on an LZMA rebuild", () => {
  async function rebuilt() {
    const graph = await graphOf(wrapInLzma(innerVolume()));
    const edit = flipEdit(graph, "setup-hii", 100, 8);
    return { graph, edit, value: unwrap(rebuildFirmware(graph, [edit], { codecs })) };
  }

  it("flags padding that is no longer erased", async () => {
    const { graph, edit, value } = await rebuilt();
    const edge = graph.buffers[1].parent;
    const end = edge?.ownerFile?.end ?? 0;
    const tampered = { ...value, image: value.image.slice() };
    tampered.image[end - 1] = 0x00;

    expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).join(" ")).toMatch(/erased padding/);
  });

  it("flags a stream that no longer decodes to the buffer it carries", async () => {
    const { graph, edit, value } = await rebuilt();
    const edge = graph.buffers[1].parent;
    if (!edge) throw new Error("no edge");
    const tampered = { ...value, image: value.image.slice() };
    tampered.image[edge.payloadStart + 40] ^= 0x01;

    expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).join(" ")).toMatch(/decode/);
  });

  it("flags a section size that disagrees with its stream", async () => {
    const { graph, edit, value } = await rebuilt();
    const edge = graph.buffers[1].parent;
    if (!edge) throw new Error("no edge");
    const tampered = { ...value, image: value.image.slice() };
    tampered.image[edge.sectionStart] = (tampered.image[edge.sectionStart] + 3) & 0xff;

    expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).length).toBeGreaterThan(0);
  });

  it("flags a byte changed outside the section it rebuilt", async () => {
    const { graph, edit, value } = await rebuilt();
    const tampered = { ...value, image: value.image.slice() };
    tampered.image[0x20] ^= 0x01;

    expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).join(" ")).toMatch(/outside the edits/);
  });
});
