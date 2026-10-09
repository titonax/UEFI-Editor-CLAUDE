import { describe, expect, it } from "vitest";
import { extractAptioIvBytes, type FirmwareDecompressor } from "./aptioIvExtractor";
import {
  TIANO_CUSTOM_DECOMPRESS_GUID,
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
  rebuildFirmware,
  verifyByReextraction,
  verifyRebuiltFirmware,
  type ArtifactEdit,
  type RebuiltFirmware,
} from "./firmwareRebuild";
import { lzmaJsCodec } from "./lzmaJs";
import { referenceTianoAvailable, referenceTianoDecode } from "./referenceTiano";
import { decodeTiano, encodeTiano, type TianoVariant } from "./tianoCodec";

const hasReference = await referenceTianoAvailable();
const variants: TianoVariant[] = ["efi", "tiano"];
const checksummed = 0x40;
const noIfr = () => Promise.resolve("");
const erasedTail = (length: number) => new Uint8Array(length).fill(0xff);

// The extractor's order: Tiano first, then EFI, the first stream that parses.
function readStandard(input: Uint8Array) {
  for (const variant of ["tiano", "efi"] as const) {
    try {
      return decodeTiano(input, variant);
    } catch {
      // not this variant; the next one is tried, as the extractor does
    }
  }
  throw new Error("neither variant reads the stream");
}
const decompress: FirmwareDecompressor = (input, mode) =>
  Promise.resolve(mode === "lzma" ? lzmaJsCodec.decode(input) : readStandard(input));
const codecs = { lzma: lzmaJsCodec };

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

async function graphOf(image: Uint8Array, reader: FirmwareDecompressor = decompress): Promise<FirmwareProvenanceGraph> {
  return (await extractAptioIvBytes(image, noIfr, reader)).provenance;
}

function editOf(graph: FirmwareProvenanceGraph, kind: string, offset: number, replace: (expected: Uint8Array) => Uint8Array, length = 8): ArtifactEdit {
  const index = graph.artifacts.findIndex((artifact) => artifact.kind === kind);
  const artifact = graph.artifacts[index];
  const node = graph.buffers.find((buffer) => buffer.id === artifact.bufferId);
  if (!node) throw new Error("no buffer");
  const start = artifact.payloadStart + offset;
  const expected = node.bytes.slice(start, start + length);
  return { artifactIndex: index, offset, expected, replacement: replace(expected) };
}
const flipEdit = (graph: FirmwareProvenanceGraph, kind: string, offset: number, length = 8) =>
  editOf(graph, kind, offset, (expected) => expected.map((byte) => byte ^ 0xff), length);
const replaceEdit = (graph: FirmwareProvenanceGraph, kind: string, offset: number, replacement: Uint8Array) =>
  editOf(graph, kind, offset, () => replacement, replacement.length);

function unwrap(result: ReturnType<typeof rebuildFirmware>): RebuiltFirmware {
  if (!result.ok) throw new Error(result.refusals.map((refusal) => refusal.message).join("; "));
  return result.value;
}

function codesOf(result: ReturnType<typeof rebuildFirmware>) {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

type Wrapper = "compression" | "guided" | "extended";

function tianoSection(decoded: Uint8Array, variant: TianoVariant, wrapper: Wrapper = "compression", options: { blockSymbols?: number } = {}) {
  const stream = encodeTiano(decoded, variant, options);
  if (wrapper === "guided") return guidDefinedSection(TIANO_CUSTOM_DECOMPRESS_GUID, 1, stream);
  if (wrapper === "extended") return compressionSectionExtended(1, decoded.length, stream);
  return compressionSection(1, decoded.length, stream);
}

function fileWith(section: Uint8Array, tail = 64) {
  return { guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(section), erasedTail(tail)) };
}

function wrapInTiano(inner: Uint8Array, variant: TianoVariant, options: { wrapper?: Wrapper; tail?: number; erasePolarityOnes?: boolean } = {}) {
  return firmwareVolume([fileWith(tianoSection(inner, variant, options.wrapper ?? "compression"), options.tail ?? 64)], 0x40, {
    erasePolarityOnes: options.erasePolarityOnes ?? true,
  });
}

const compressible = { hii: new Uint8Array(2000).fill(0x41), amitse: patternBytes(64, 2), setupData: patternBytes(48, 3) };
const innerVolume = (payloads = compressible) => firmwareVolume(setupFiles(payloads, checksummed));

describe("rebuildFirmware through an EFI/Tiano section", () => {
  for (const variant of variants) {
    for (const wrapper of ["compression", "guided", "extended"] as const) {
      it(`re-encodes a ${wrapper} ${variant} section inside its file and keeps the file's size`, async () => {
        const image = wrapInTiano(innerVolume(), variant, { wrapper });
        const graph = await graphOf(image);
        const edge = graph.buffers[1].parent;
        if (!edge?.ownerFile) throw new Error("no edge");
        expect(edge.compression).toBe("standard");
        const edit = flipEdit(graph, "setup-hii", 100);

        const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

        expect(rebuilt.image.length).toBe(image.length);
        expect(rebuilt.layoutChanges).toHaveLength(1);
        const change = rebuilt.layoutChanges[0];
        expect(change.format).toBe("standard");
        const owner = edge.ownerFile;
        expect(rebuilt.image.slice(owner.fileStart, owner.fileStart + 17)).toEqual(image.slice(owner.fileStart, owner.fileStart + 17));
        const newEnd = edge.payloadStart + change.packedAfter;
        expect(rebuilt.image.slice(newEnd, owner.end).every((byte) => byte === 0xff)).toBe(true);
        expect(change.paddingBefore + change.packedBefore).toBe(change.paddingAfter + change.packedAfter);
        expect((sum8(rebuilt.image, owner.bodyStart, owner.end) + rebuilt.image[owner.fileStart + 17]) & 0xff).toBe(0);
        const sizeStart = edge.sectionHeaderSize === 4 ? edge.sectionStart : edge.sectionStart + 4;
        const sizeEnd = edge.sectionHeaderSize === 4 ? edge.sectionStart + 3 : edge.sectionStart + 8;
        for (const range of rebuilt.changedRanges) {
          for (let offset = range.start; offset < range.end; offset++) {
            const inPayload = offset >= edge.payloadStart && offset < owner.end;
            const inSize = offset >= sizeStart && offset < sizeEnd;
            expect(inPayload || inSize || offset === owner.fileStart + 17, `byte ${String(offset)}`).toBe(true);
          }
        }
        expect(verifyRebuiltFirmware(graph, [edit], rebuilt)).toEqual([]);
        expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress })).toEqual([]);
      });
    }

    it.skipIf(!hasReference)(`writes a ${variant} stream the project's C decoder reads back to the rebuilt inner volume`, async () => {
      const graph = await graphOf(wrapInTiano(innerVolume(), variant));
      const edge = graph.buffers[1].parent;
      if (!edge) throw new Error("no edge");
      const rebuilt = unwrap(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)]));
      const stream = rebuilt.image.slice(edge.payloadStart, edge.payloadStart + rebuilt.layoutChanges[0].packedAfter);

      expect(await referenceTianoDecode(stream, variant)).toEqual(rebuilt.buffers.get(1));
    });

    it.skipIf(!hasReference)(`reads the rebuilt ${variant} image back with the C decoder as the extractor's decompressor`, async () => {
      const graph = await graphOf(wrapInTiano(innerVolume(), variant));
      const edit = flipEdit(graph, "setup-hii", 100);
      const rebuilt = unwrap(rebuildFirmware(graph, [edit]));
      const cDecompress: FirmwareDecompressor = async (input, mode) => {
        if (mode !== "standard") throw new Error("no LZMA here");
        for (const attempt of ["tiano", "efi"] as const) {
          try {
            return await referenceTianoDecode(input, attempt);
          } catch {
            // the next variant is tried, as the extractor does
          }
        }
        throw new Error("the C decoder rejected both variants");
      };

      expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress: cDecompress })).toEqual([]);
    });
  }

  it("lets the section shrink into the padding", async () => {
    const image = wrapInTiano(innerVolume({ ...compressible, hii: randomBytes(2000, 9) }), "efi", { tail: 400 });
    const graph = await graphOf(image);
    const edit = replaceEdit(graph, "setup-hii", 100, new Uint8Array(1500));

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    const change = rebuilt.layoutChanges[0];
    expect(change.packedAfter).toBeLessThan(change.packedBefore);
    expect(change.paddingAfter).toBeGreaterThan(change.paddingBefore);
    expect(rebuilt.image.length).toBe(image.length);
    expect(verifyRebuiltFirmware(graph, [edit], rebuilt)).toEqual([]);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress })).toEqual([]);
  });

  it("lets the section grow into the padding", async () => {
    const image = wrapInTiano(innerVolume(), "tiano", { tail: 400 });
    const graph = await graphOf(image);
    const edit = replaceEdit(graph, "setup-hii", 100, randomBytes(300, 3));

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    const change = rebuilt.layoutChanges[0];
    expect(change.packedAfter).toBeGreaterThan(change.packedBefore);
    expect(verifyRebuiltFirmware(graph, [edit], rebuilt)).toEqual([]);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress })).toEqual([]);
  });

  it("rebuilds two edits in one volume, in two files, through one re-encode of their shared section", async () => {
    const graph = await graphOf(wrapInTiano(innerVolume(), "tiano"));
    const edits = [flipEdit(graph, "setup-hii", 100), flipEdit(graph, "amitse", 8, 4)];

    const rebuilt = unwrap(rebuildFirmware(graph, edits));

    expect(rebuilt.layoutChanges).toHaveLength(1);
    expect(rebuilt.repairedFiles.length).toBeGreaterThanOrEqual(3);
    expect(verifyRebuiltFirmware(graph, edits, rebuilt)).toEqual([]);
    expect(await verifyByReextraction(graph, edits, rebuilt.image, { decompress })).toEqual([]);
  });

  it("is deterministic", async () => {
    const graph = await graphOf(wrapInTiano(innerVolume(), "efi"));
    const edit = flipEdit(graph, "setup-hii", 100);

    expect(unwrap(rebuildFirmware(graph, [edit])).image).toEqual(unwrap(rebuildFirmware(graph, [edit])).image);
  });

  it("returns the source byte for byte when nothing changes", async () => {
    const image = wrapInTiano(innerVolume(), "efi");
    const graph = await graphOf(image);

    expect(unwrap(rebuildFirmware(graph, [])).image).toEqual(image);
  });

  it("leaves a vendor stream alone when the edit changes nothing, and re-encodes it when it does", async () => {
    // A valid stream this encoder would not write (other block sizes).
    const inner = innerVolume({ ...compressible, hii: randomBytes(2000, 5) });
    const image = firmwareVolume([fileWith(tianoSection(inner, "efi", "compression", { blockSymbols: 300 }))]);
    expect(image).not.toEqual(wrapInTiano(inner, "efi"));
    const graph = await graphOf(image);
    const artifact = graph.artifacts[0];
    const bytes = graph.buffers[1].bytes.slice(artifact.payloadStart + 100, artifact.payloadStart + 108);
    const same = replaceEdit(graph, "setup-hii", 100, bytes);

    const untouched = unwrap(rebuildFirmware(graph, [same]));

    expect(untouched.image).toEqual(image);
    expect(untouched.layoutChanges).toEqual([]);
    const edit = flipEdit(graph, "setup-hii", 100);
    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));
    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress })).toEqual([]);
  });
});

describe("rebuildFirmware through several compressed levels", () => {
  it("re-encodes two EFI/Tiano levels, repairing the file at each", async () => {
    const middle = wrapInTiano(innerVolume(), "efi");
    const outer = wrapInTiano(middle, "tiano");
    const graph = await graphOf(outer);
    expect(graph.buffers.map((buffer) => buffer.depth)).toEqual([0, 1, 2]);
    const edit = flipEdit(graph, "setup-hii", 100);

    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));

    expect(rebuilt.layoutChanges.map((change) => change.format)).toEqual(["standard", "standard"]);
    expect(rebuilt.image.length).toBe(outer.length);
    expect(verifyRebuiltFirmware(graph, [edit], rebuilt)).toEqual([]);
    expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress })).toEqual([]);
  });

  it("mixes LZMA and EFI/Tiano in either order", async () => {
    const lzmaSection = (decoded: Uint8Array) => compressionSection(2, decoded.length, lzmaJsCodec.encode(decoded, 8));
    const inner = innerVolume();
    const cases: [string, Uint8Array, string[]][] = [
      ["Tiano inside LZMA", firmwareVolume([fileWith(lzmaSection(wrapInTiano(inner, "efi")))]), ["standard", "lzma"]],
      ["LZMA inside Tiano", firmwareVolume([fileWith(tianoSection(firmwareVolume([fileWith(lzmaSection(inner))]), "tiano"))]), ["lzma", "standard"]],
    ];
    for (const [name, image, order] of cases) {
      const graph = await graphOf(image);
      const edit = flipEdit(graph, "setup-hii", 100);

      const rebuilt = unwrap(rebuildFirmware(graph, [edit], { codecs }));

      expect(rebuilt.layoutChanges.map((change) => change.format), name).toEqual(order);
      expect(verifyRebuiltFirmware(graph, [edit], rebuilt, { codecs }), name).toEqual([]);
      expect(await verifyByReextraction(graph, [edit], rebuilt.image, { decompress }), name).toEqual([]);
    }
  });
});

describe("rebuildFirmware refuses an EFI/Tiano section it cannot resize safely", () => {
  it("refuses a section followed by anything but erased padding", async () => {
    const tail = erasedTail(64);
    tail[10] = 0x00;
    const image = firmwareVolume([
      { guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(tianoSection(innerVolume(), "efi")), tail) },
    ]);
    const graph = await graphOf(image);

    expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)]))).toEqual(["section-not-terminal"]);
  });

  it("refuses a result that does not fit before the end of the file", async () => {
    const graph = await graphOf(wrapInTiano(innerVolume(), "efi", { tail: 0 }));

    const result = rebuildFirmware(graph, [replaceEdit(graph, "setup-hii", 100, randomBytes(1800, 7))]);

    expect(codesOf(result)).toEqual(["compressed-does-not-fit"]);
  });

  it("refuses to create padding where the source had none, in a volume that does not declare erased bytes as 0xFF", async () => {
    const graph = await graphOf(wrapInTiano(innerVolume({ ...compressible, hii: randomBytes(2000, 9) }), "efi", { tail: 0, erasePolarityOnes: false }));

    const result = rebuildFirmware(graph, [replaceEdit(graph, "setup-hii", 100, new Uint8Array(1500))]);

    expect(codesOf(result)).toEqual(["compressed-padding-change"]);
  });

  it("does not create padding even in a volume that declares erased bytes as ones: no real Tiano firmware has shown it is safe", async () => {
    const image = wrapInTiano(innerVolume({ ...compressible, hii: randomBytes(2000, 9) }), "efi", { tail: 0 });
    const graph = await graphOf(image);

    const result = rebuildFirmware(graph, [replaceEdit(graph, "setup-hii", 100, new Uint8Array(1500))]);

    expect(codesOf(result)).toEqual(["compressed-padding-change"]);
    if (!result.ok) expect(result.refusals[0].message).toMatch(/not accepted for EFI\/Tiano/);
  });

  it("refuses a section that is not the last one in its file", async () => {
    const body = concat(sectionStream(tianoSection(innerVolume(), "efi"), pe32Section(patternBytes(8, 1))), erasedTail(16));
    const graph = await graphOf(firmwareVolume([{ guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body }]));

    expect(codesOf(rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)]))).toEqual(["section-not-terminal"]);
  });

  it("refuses a stream that is not an EFI/Tiano stream", async () => {
    const inner = innerVolume();
    const image = firmwareVolume([fileWith(compressionSection(1, inner.length, inner))]);
    const graph = await graphOf(image, () => Promise.resolve(inner));
    expect(graph.buffers[1].parent?.compression).toBe("standard");

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)]);

    expect(codesOf(result)).toEqual(["tiano-recompression"]);
  });

  it("refuses a stream with bytes after its packed data", async () => {
    const inner = innerVolume();
    const stream = concat(encodeTiano(inner, "efi"), Uint8Array.of(1, 2, 3, 4));
    const image = firmwareVolume([fileWith(compressionSection(1, inner.length, stream))]);
    const graph = await graphOf(image, () => Promise.resolve(inner));

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)]);

    expect(codesOf(result)).toEqual(["tiano-recompression"]);
    if (!result.ok) expect(result.refusals[0].message).toMatch(/bytes after it/);
  });

  it("refuses when the codec cannot encode", async () => {
    const graph = await graphOf(wrapInTiano(innerVolume(), "efi"));
    const broken = { encode: () => { throw new Error("out of memory"); }, decode: decodeTiano };

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)], { codecs: { tiano: broken } });

    expect(codesOf(result)).toEqual(["tiano-recompression"]);
    if (!result.ok) expect(result.refusals[0].message).toMatch(/out of memory/);
  });

  it("refuses an encoder whose stream does not read back", async () => {
    const graph = await graphOf(wrapInTiano(innerVolume(), "efi"));
    const lying = {
      encode: (data: Uint8Array, variant: TianoVariant) => encodeTiano(data.map((byte) => byte ^ 1), variant),
      decode: decodeTiano,
    };

    const result = rebuildFirmware(graph, [flipEdit(graph, "setup-hii", 100)], { codecs: { tiano: lying } });

    expect(codesOf(result)).toEqual(["tiano-recompression"]);
  });
});

describe("an edit made from outside a section that another edit rebuilds", () => {
  // Where, relative to the section, a second edit in the OUTER buffer lands.
  const places: [string, (edge: NonNullable<FirmwareProvenanceGraph["buffers"][number]["parent"]>) => [number, number]][] = [
    ["the compressed payload", (edge) => [edge.payloadStart + 10, edge.payloadStart + 14]],
    ["the section header's size field", (edge) => [edge.sectionStart, edge.sectionStart + 2]],
    ["the padding the rebuild rewrites", (edge) => [edge.payloadEnd + 4, edge.payloadEnd + 8]],
  ];
  for (const [name, locate] of places) {
    it(`refuses an edit that lands in ${name}`, async () => {
      const graph = await graphOf(wrapInTiano(innerVolume(), "efi", { tail: 64 }));
      const edge = graph.buffers[1].parent;
      if (!edge?.ownerFile) throw new Error("no edge");
      const [start, end] = locate(edge);
      const inside = { kind: "amitse" as const, bufferId: 0, payloadStart: start, payloadEnd: end, sourceFile: edge.ownerFile };
      const crowded: FirmwareProvenanceGraph = { ...graph, artifacts: [...graph.artifacts, inside] };
      const outside: ArtifactEdit = {
        artifactIndex: crowded.artifacts.length - 1,
        offset: 0,
        expected: graph.buffers[0].bytes.slice(start, start + 2),
        replacement: Uint8Array.of(0xde, 0xad),
      };

      const result = rebuildFirmware(crowded, [flipEdit(crowded, "setup-hii", 100), outside]);

      expect(codesOf(result)).toContain("conflicting-edit");
    });
  }
});

describe("verifyRebuiltFirmware on EFI/Tiano sections", () => {
  async function rebuiltCase() {
    const graph = await graphOf(wrapInTiano(innerVolume({ ...compressible, hii: randomBytes(2000, 5) }), "efi", { tail: 4000 }));
    const edit = flipEdit(graph, "setup-hii", 100);
    const rebuilt = unwrap(rebuildFirmware(graph, [edit]));
    const edge = graph.buffers[1].parent;
    if (!edge) throw new Error("no edge");
    return { graph, edit, rebuilt, edge };
  }

  it("catches a damaged compressed stream", async () => {
    const { graph, edit, rebuilt, edge } = await rebuiltCase();
    const damaged: RebuiltFirmware = { ...rebuilt, image: rebuilt.image.slice(), buffers: new Map(rebuilt.buffers) };
    damaged.image[edge.payloadStart + 40] ^= 0x10;
    damaged.buffers.set(0, damaged.image);

    expect(verifyRebuiltFirmware(graph, [edit], damaged).length).toBeGreaterThan(0);
  });

  it("catches a stream that is valid but not what the encoder writes", async () => {
    const { graph, edit, rebuilt } = await rebuiltCase();
    const other = { encode: (data: Uint8Array, variant: TianoVariant) => encodeTiano(data, variant, { blockSymbols: 300 }), decode: decodeTiano };

    const problems = verifyRebuiltFirmware(graph, [edit], rebuilt, { codecs: { tiano: other } });

    expect(problems.join("\n")).toMatch(/canonical re-encoding/);
  });

  it("catches a section whose tail holds something other than erased padding", async () => {
    const { graph, edit, rebuilt, edge } = await rebuiltCase();
    const owner = edge.ownerFile;
    if (!owner) throw new Error("no owner");
    const damaged: RebuiltFirmware = { ...rebuilt, image: rebuilt.image.slice(), buffers: new Map(rebuilt.buffers) };
    damaged.image[owner.end - 1] = 0x00;
    damaged.buffers.set(0, damaged.image);

    expect(verifyRebuiltFirmware(graph, [edit], damaged).join("\n")).toMatch(/erased padding/);
  });
});
