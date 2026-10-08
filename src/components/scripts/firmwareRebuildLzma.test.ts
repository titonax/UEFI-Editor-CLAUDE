import { describe, expect, it } from "vitest";
import * as lzma from "lzma";
import { extractAptioIvBytes, type FirmwareDecompressor } from "./aptioIvExtractor";
import {
  LZMA_CUSTOM_DECOMPRESS_GUID,
  compressionSection,
  compressionSectionExtended,
  concat,
  firmwareVolume,
  guidDefinedSection,
  patternBytes,
  pe32Section,
  sectionStream,
  setupFiles,
  sum8,
} from "./firmwareImageFixtures";
import type { FirmwareProvenanceGraph } from "./firmwareProvenance";
import {
  paddingAfterSection,
  paddingChangeAllowed,
  rebuildFirmware,
  verifyByReextraction,
  verifyRebuiltFirmware,
  type ArtifactEdit,
  type RebuiltFirmware,
} from "./firmwareRebuild";
import { lzmaJsCodec } from "./lzmaJs";
import { referenceLzmaAvailable, referenceLzmaDecode } from "./referenceLzma";

const hasXz = await referenceLzmaAvailable();
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
      expect((sum8(rebuilt.image, owner.bodyStart, owner.end) + rebuilt.image[owner.fileStart + 17]) & 0xff).toBe(0);
      // Every changed byte is in the section's payload or padding, or is the
      // file's data checksum; nothing in the section's own header but its size.
      const sizeStart = edge.sectionHeaderSize === 4 ? edge.sectionStart : edge.sectionStart + 4;
      const sizeEnd = edge.sectionHeaderSize === 4 ? edge.sectionStart + 3 : edge.sectionStart + 8;
      for (const range of rebuilt.changedRanges) {
        for (let offset = range.start; offset < range.end; offset++) {
          const inPayload = offset >= edge.payloadStart && offset < owner.end;
          const inSize = offset >= sizeStart && offset < sizeEnd;
          expect(inPayload || inSize || offset === owner.fileStart + 17, `byte ${String(offset)}`).toBe(true);
        }
      }
      expect(verifyRebuiltFirmware(graph, [edit], rebuilt, { codecs })).toEqual([]);
      expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress: lzmaDecompress })).toEqual([]);
    });
  }

  it.skipIf(!hasXz)("writes a stream a reference decoder reads back to the rebuilt inner volume", async () => {
    const image = wrapInLzma(innerVolume());
    const graph = await graphOf(image);
    const edge = graph.buffers[1].parent;
    if (!edge) throw new Error("no edge");
    const rebuilt = unwrap(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100, 8)], { codecs }));
    const stream = rebuilt.image.slice(edge.payloadStart, edge.payloadStart + rebuilt.layoutChanges[0].packedAfter);

    expect(await referenceLzmaDecode(stream)).toEqual(rebuilt.buffers.get(1));
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

    expect(codesOf(result)).toEqual(["compressed-does-not-fit"]);
  });

  it("refuses to create padding where the source had none", async () => {
    const image = wrapInLzma(innerVolume({ ...compressible, hii: randomBytes(2000, 9) }), { tail: 0 });
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [replaceEdit(graph, "setup-hii", 100, new Uint8Array(1500))], { codecs });

    expect(codesOf(result)).toEqual(["compressed-padding-change"]);
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

describe("an edit that changes nothing", () => {
  it("leaves the image byte for byte as it was, vendor stream and all", async () => {
    // A stream the vendor tool wrote (here: with an end marker) is not what
    // this encoder writes; rewriting it for an edit that changed nothing would
    // alter bytes nobody asked to alter.
    const inner = innerVolume();
    const vendorStream = Uint8Array.from(lzma.compress(inner, 8), (value) => value & 0xff);
    const image = firmwareVolume([
      { guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(compressionSection(2, inner.length, vendorStream)), erasedTail(64)) },
    ]);
    const graph = await graphOf(image);
    const same = replaceEdit(graph, "setup-hii", 100, graph.buffers[1].bytes.slice(graph.artifacts[0].payloadStart + 100, graph.artifacts[0].payloadStart + 108));

    const rebuilt = unwrap(rebuildFirmware(graph, [same], { codecs }));

    expect(rebuilt.image).toEqual(image);
    expect(rebuilt.changedBytes).toBe(0);
    expect(rebuilt.layoutChanges).toEqual([]);
    expect(verifyRebuiltFirmware(graph, [same], rebuilt, { codecs })).toEqual([]);
  });

  it("re-encodes a vendor stream that has both a size and an end marker, without the marker", async () => {
    const inner = innerVolume();
    const vendorStream = Uint8Array.from(lzma.compress(inner, 8), (value) => value & 0xff);
    const image = firmwareVolume([
      { guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(compressionSection(2, inner.length, vendorStream)), erasedTail(64)) },
    ]);
    const graph = await graphOf(image);
    const edit = flipEdit(graph, "setup-hii", 100, 8);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit], { codecs }));

    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress: lzmaDecompress })).toEqual([]);
  });
});

describe("padding rules", () => {
  it("accepts any padding where the source showed room for a section header, and keeps it small where it did not", () => {
    expect(paddingChangeAllowed(0, 3)).toBe(true);
    expect(paddingChangeAllowed(3, 3)).toBe(true);
    expect(paddingChangeAllowed(3, 4)).toBe(false);
    expect(paddingChangeAllowed(0, 4)).toBe(false);
    expect(paddingChangeAllowed(4, 0)).toBe(true);
    expect(paddingChangeAllowed(4, 5000)).toBe(true);
  });

  it("measures padding from where the next section would start: the next 4-byte boundary", () => {
    expect(paddingAfterSection(100, 104)).toBe(4);
    expect(paddingAfterSection(101, 105)).toBe(1); // next section at 104
    expect(paddingAfterSection(101, 103)).toBe(0); // nothing fits past 104
    expect(paddingAfterSection(100, 100)).toBe(0);
  });
});

describe("rebuildFirmware refuses more LZMA layouts", () => {
  it("refuses a section that is not the last one in its file", async () => {
    const inner = innerVolume();
    const body = concat(sectionStream(lzmaSection(inner), pe32Section(patternBytes(8, 1))), erasedTail(16));
    const image = firmwareVolume([{ guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body }]);
    const graph = await graphOf(image);

    expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)], { codecs }))).toEqual(["section-not-terminal"]);
  });

  it("refuses a section with no FFS file around it to absorb a change of size", async () => {
    const graph = await graphOf(wrapInLzma(innerVolume()));
    const child = graph.buffers[1];
    const broken: FirmwareProvenanceGraph = {
      ...graph,
      buffers: [graph.buffers[0], { ...child, parent: child.parent && { ...child.parent, ownerFile: undefined } }],
    };

    expect(codesOf(rebuildFirmware(broken, [flipEdit(broken, "setup-hii", 100)], { codecs }))).toContain("incomplete-path");
  });

  it("refuses an LZMA wrapper file that carries a tail", async () => {
    const graph = await graphOf(wrapInLzma(innerVolume(), { attributes: checksummed | 0x01 }));

    expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)], { codecs }))).toEqual(["unsupported-file-attributes"]);
  });

  for (const wrapper of ["guided", "extended"] as const) {
    it(`refuses a ${wrapper} LZMA section without a codec`, async () => {
      const graph = await graphOf(wrapInLzma(innerVolume(), { wrapper }));

      expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)]))).toEqual(["compressed-section"]);
    });
  }
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

  // Re-fixes the file's data checksum after a tamper, so only the structure
  // being tested is wrong.
  function refixChecksum(image: Uint8Array, file: { bodyStart: number; end: number; fileStart: number }) {
    image[file.fileStart + 17] = (0x100 - sum8(image, file.bodyStart, file.end)) & 0xff;
  }

  it("flags a changed byte in the section's own header, even with the file checksum fixed", async () => {
    const { graph, edit, value } = await rebuilt();
    const edge = graph.buffers[1].parent;
    if (!edge?.ownerFile) throw new Error("no edge");
    // type byte, uncompressed-length field and compression-type byte
    for (const offset of [edge.sectionStart + 3, edge.payloadStart - 5, edge.payloadStart - 1]) {
      const tampered = { ...value, image: value.image.slice() };
      tampered.image[offset] ^= 0x01;
      refixChecksum(tampered.image, edge.ownerFile);

      expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).join(" "), `byte ${String(offset)}`).toMatch(/outside the edits/);
    }
  });

  it("flags garbage appended after the stream inside the section", async () => {
    const { graph, edit, value } = await rebuilt();
    const edge = graph.buffers[1].parent;
    if (!edge?.ownerFile) throw new Error("no edge");
    const change = value.layoutChanges[0];
    const streamEnd = edge.payloadStart + change.packedAfter;
    const tampered = { ...value, image: value.image.slice() };
    tampered.image.fill(0xde, streamEnd, streamEnd + 20);
    const size = streamEnd + 20 - edge.sectionStart;
    tampered.image[edge.sectionStart] = size & 0xff;
    tampered.image[edge.sectionStart + 1] = (size >> 8) & 0xff;
    refixChecksum(tampered.image, edge.ownerFile);

    expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).join(" ")).toMatch(/canonical|extra/);
  });

  it("flags a buffer, a range count or a layout record that disagree with the image", async () => {
    const { graph, edit, value } = await rebuilt();
    const otherRoot = { ...value, buffers: new Map(value.buffers) };
    otherRoot.buffers.set(0, value.image.map((byte, index) => (index === 3 ? byte ^ 1 : byte)));
    const badCount = { ...value, changedBytes: value.changedBytes + 1 };
    const badRanges = { ...value, changedRanges: [] };
    const badLayout = { ...value, layoutChanges: [{ ...value.layoutChanges[0], packedAfter: value.layoutChanges[0].packedAfter + 1 }] };
    const missingLayout = { ...value, layoutChanges: [] };
    const extraLayout = { ...value, layoutChanges: [...value.layoutChanges, { ...value.layoutChanges[0], sectionStart: 1 }] };

    for (const tampered of [otherRoot, badCount, badRanges, badLayout, missingLayout, extraLayout]) {
      expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).length).toBeGreaterThan(0);
    }
  });

  it("flags a byte changed outside the section it rebuilt", async () => {
    const { graph, edit, value } = await rebuilt();
    const tampered = { ...value, image: value.image.slice() };
    tampered.image[0x20] ^= 0x01;

    expect(verifyRebuiltFirmware(graph, [edit], tampered, { codecs }).join(" ")).toMatch(/outside the edits/);
  });
});

describe("verifyRebuiltFirmware on two LZMA levels", () => {
  it("flags a tampered intermediate buffer", async () => {
    const outer = wrapInLzma(wrapInLzma(innerVolume(), { tail: 64 }), { tail: 64 });
    const graph = await graphOf(outer);
    const edit = flipEdit(graph, "setup-hii", 100, 8);
    const value = unwrap(rebuildFirmware(graph, [edit], { codecs }));
    const middle = value.buffers.get(1);
    if (!middle) throw new Error("no middle buffer");
    const buffers = new Map(value.buffers);
    buffers.set(1, middle.map((byte, index) => (index === 0x30 ? byte ^ 1 : byte)));

    expect(verifyRebuiltFirmware(graph, [edit], { ...value, buffers }, { codecs }).length).toBeGreaterThan(0);
  });
});
