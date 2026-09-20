import { describe, expect, it } from "vitest";
import { extractAptioIvArtifacts, extractAptioIvBytes } from "./aptioIvExtractor";

const setupGuid = "899407D7-99FE-43D8-9A21-79EC328CAC21";
const amitseGuid = "B1DA0ADF-4F77-4070-A88E-BFFE1C60529A";
const hiiGuid = "97E409E6-4CC1-11D9-81F6-000000000000";
const setupDataGuid = "FE612B72-203C-47B1-8560-A66D946EB371";

function writeGuid(bytes: Uint8Array, offset: number, guid: string) {
  const [data1, data2, data3, data4, data5] = guid.split("-");
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, Number.parseInt(data1, 16), true);
  view.setUint16(offset + 4, Number.parseInt(data2, 16), true);
  view.setUint16(offset + 6, Number.parseInt(data3, 16), true);
  bytes.set(
    Uint8Array.from(`${data4}${data5}`.match(/../g) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    ),
    offset + 8,
  );
}

function writeUint24(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

// A minimal firmware volume holding one or more FFS files whose bodies are
// `section`s. The volume header is 0x48 bytes; the extractor only needs the
// _FVH signature, the 64-bit length and the header length to accept it.
function firmwareVolumeWithFiles(files: { guid: string; section: Uint8Array }[]) {
  const headerSize = 0x48;
  const aligned = (value: number) => (value + 7) & ~7;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const file of files) {
    offsets.push(cursor);
    cursor = aligned(cursor + 24 + file.section.length);
  }
  const volumeSize = aligned(cursor + 0x40);
  const bytes = new Uint8Array(volumeSize);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0x20, BigInt(volumeSize), true);
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28);
  view.setUint16(0x30, headerSize, true);
  for (const [index, file] of files.entries()) {
    const fileStart = offsets[index];
    const fileSize = 24 + file.section.length;
    writeGuid(bytes, fileStart, file.guid);
    writeUint24(bytes, fileStart + 20, fileSize);
    bytes.set(file.section, fileStart + 24);
  }
  return bytes;
}

function firmwareVolumeWithFile(fileGuid: string, section: Uint8Array) {
  return firmwareVolumeWithFiles([{ guid: fileGuid, section }]);
}

function freeformSection(sectionGuid: string, payload: Uint8Array) {
  const section = new Uint8Array(4 + 16 + payload.length);
  writeUint24(section, 0, section.length);
  section[3] = 0x18;
  writeGuid(section, 4, sectionGuid);
  section.set(payload, 20);
  return section;
}

function pe32Section(payload: Uint8Array) {
  const section = new Uint8Array(4 + payload.length);
  writeUint24(section, 0, section.length);
  section[3] = 0x10;
  section.set(payload, 4);
  return section;
}

// A GUID-Defined Section (type 0x02): headerSize(4) + definitionGuid(16) +
// dataOffset(2) + attributes(2), then the payload at dataOffset.
function guidDefinedSection(definitionGuid: string, payload: Uint8Array) {
  const dataOffset = 4 + 16 + 2 + 2;
  const section = new Uint8Array(dataOffset + payload.length);
  writeUint24(section, 0, section.length);
  section[3] = 0x02;
  writeGuid(section, 4, definitionGuid);
  new DataView(section.buffer).setUint16(4 + 16, dataOffset, true);
  section.set(payload, dataOffset);
  return section;
}

function setupVolume(hii: Uint8Array) {
  return firmwareVolumeWithFile(setupGuid, freeformSection(hiiGuid, hii));
}

// A whole firmware slot: Setup, AMITSE and SetupData, each carrying `marker`
// as their first byte so two contexts concatenated into one image can be
// told apart by which bytes actually got selected.
function artifactContext(marker: number) {
  return firmwareVolumeWithFiles([
    { guid: setupGuid, section: freeformSection(hiiGuid, new Uint8Array([marker, 0x01])) },
    { guid: amitseGuid, section: pe32Section(new Uint8Array([marker, 0x02])) },
    {
      guid: setupDataGuid,
      section: freeformSection(setupDataGuid, new Uint8Array([marker, 0x03])),
    },
  ]);
}

function binaryFile(bytes: Uint8Array): File {
  return {
    name: "firmware.bin",
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  } as File;
}

describe("extractAptioIvArtifacts", () => {
  it("fails clearly when the Setup FFS cannot be located anywhere", async () => {
    await expect(extractAptioIvArtifacts(binaryFile(new Uint8Array(0x80)))).rejects.toThrow(
      /Setup FFS was not found/,
    );
  });

  it("finds Setup HII at the top level and records where it came from", async () => {
    const hii = new Uint8Array([0x01, 0x02, 0x03]);
    const image = setupVolume(hii);

    const artifacts = await extractAptioIvBytes(image, () =>
      Promise.resolve("FormSet Guid: a\nFormSet Guid: b"),
    );

    expect(artifacts.hii).toEqual(hii);
    expect(artifacts.formPackageCount).toBe(2);
    expect(artifacts.extractionDepth).toBe(0);
    expect(artifacts.provenance).toMatchObject({
      rootBufferId: 0,
      sourceSize: image.length,
    });
    expect(artifacts.provenance.buffers).toHaveLength(1);
    expect(artifacts.provenance.artifacts).toEqual([
      {
        kind: "setup-hii",
        bufferId: 0,
        payloadStart: 0x48 + 24 + 20,
        payloadEnd: 0x48 + 24 + 20 + hii.length,
        sourceFile: {
          bufferId: 0,
          guid: setupGuid,
          volumeStart: 0,
          volumeEnd: image.length,
          fileStart: 0x48,
          bodyStart: 0x48 + 24,
          end: 0x48 + 24 + 20 + hii.length,
          headerSize: 24,
        },
      },
    ]);
  });

  it("retains the exact branch from a nested volume back to the source image", async () => {
    const hii = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const innerVolume = setupVolume(hii);
    // The inner volume travels inside a Disposable Section (0x03) of an
    // unrelated outer FFS file, so it must be reached through that section
    // rather than treated as a peer volume.
    const wrapper = new Uint8Array(4 + innerVolume.length);
    writeUint24(wrapper, 0, wrapper.length);
    wrapper[3] = 0x03;
    wrapper.set(innerVolume, 4);
    const image = firmwareVolumeWithFile("11111111-2222-3333-4444-555555555555", wrapper);

    const artifacts = await extractAptioIvBytes(image, () =>
      Promise.resolve("FormSet Guid: synthetic"),
    );

    expect(artifacts.hii).toEqual(hii);
    expect(artifacts.extractionDepth).toBe(1);
    expect(artifacts.provenance.buffers).toHaveLength(2);
    expect(artifacts.provenance.buffers[1].parent).toMatchObject({
      parentBufferId: 0,
      sectionType: 0x03,
      compression: "none",
      ownerFile: {
        bufferId: 0,
        guid: "11111111-2222-3333-4444-555555555555",
      },
    });
    expect(artifacts.provenance.artifacts).toHaveLength(1);
    expect(artifacts.provenance.artifacts[0].kind).toBe("setup-hii");
    expect(artifacts.provenance.artifacts[0].bufferId).toBe(
      artifacts.provenance.buffers[1].id,
    );
    expect(artifacts.provenance.artifacts[0].sourceFile.guid).toBe(setupGuid);
  });

  it("falls back to a Setup PE32 section when there is no freeform HII body", async () => {
    const pe = new Uint8Array([0x4d, 0x5a, 0x90]);
    const section = new Uint8Array(4 + pe.length);
    writeUint24(section, 0, section.length);
    section[3] = 0x10;
    section.set(pe, 4);
    const image = firmwareVolumeWithFile(setupGuid, section);

    const artifacts = await extractAptioIvBytes(image, () => Promise.resolve(""));

    expect(artifacts.hii).toEqual(pe);
    expect(artifacts.provenance.artifacts[0]).toMatchObject({
      kind: "setup-hii",
      payloadStart: 0x48 + 24 + 4,
    });
  });

  it("names the failing section's definition GUID, owning file and location when decompression rejects a stream", async () => {
    const lzmaGuid = "EE4E5898-3914-4259-9D6E-DC7BD79403CF";
    const hii = freeformSection(hiiGuid, new Uint8Array([0x01, 0x02, 0x03]));
    const image = firmwareVolumeWithFile(setupGuid, guidDefinedSection(lzmaGuid, hii));
    const failingDecompress = () =>
      Promise.reject(new Error("LZMA decompression rejected the stream"));

    // A bare "decompression rejected the stream" is useless across a real
    // 16-32 MiB image with dozens of firmware volumes; this should be
    // locatable directly in a byte-level tool instead of hand-scanned for.
    let thrown: unknown;
    try {
      await extractAptioIvBytes(image, () => Promise.resolve(""), failingDecompress);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Failed to decompress a lzma");
    expect(message).toContain(lzmaGuid);
    expect(message).toContain(`FFS file ${setupGuid}`);
    expect(message).toContain("buffer 0, depth 0");
    expect(message).toContain("LZMA decompression rejected the stream");
  });

  it("keeps recovering other firmware contexts after one section fails to decompress, with a warning attached", async () => {
    const lzmaGuid = "EE4E5898-3914-4259-9D6E-DC7BD79403CF";
    const workingHii = new Uint8Array([0xaa, 0xbb, 0xcc]);
    // One context whose only Setup section is undecodable, next to a
    // perfectly normal one - a trapped/rejected decompressor should cost
    // only its own branch's evidence, never the whole image's.
    const failingContext = firmwareVolumeWithFile(
      setupGuid,
      guidDefinedSection(lzmaGuid, freeformSection(hiiGuid, new Uint8Array([0x01]))),
    );
    const workingContext = setupVolume(workingHii);
    const image = new Uint8Array(failingContext.length + workingContext.length);
    image.set(failingContext);
    image.set(workingContext, failingContext.length);
    const decompress = () =>
      Promise.reject(new Error("LZMA decompression rejected the stream"));

    const artifacts = await extractAptioIvBytes(
      image,
      () => Promise.resolve("FormSet Guid: recovered"),
      decompress,
    );

    expect(artifacts.hii).toEqual(workingHii);
    expect(artifacts.artifactSets).toHaveLength(1);
    expect(
      artifacts.artifactSets[0].warnings.some((warning) =>
        warning.includes("could not be decoded"),
      ),
    ).toBe(true);
  });

  it("keeps duplicated firmware slots coherent and selects them explicitly", async () => {
    const firstContext = artifactContext(0xa1);
    const secondContext = artifactContext(0xb2);
    const image = new Uint8Array(firstContext.length + secondContext.length);
    image.set(firstContext);
    image.set(secondContext, firstContext.length);
    const extractIfr = (hii: Uint8Array) =>
      Promise.resolve(`FormSet Guid: marker-${String(hii[0])}`);

    const first = await extractAptioIvBytes(image, extractIfr);

    expect(first.artifactSets).toHaveLength(2);
    expect(first.hii).toEqual(new Uint8Array([0xa1, 0x01]));
    expect(first.amitse).toEqual(new Uint8Array([0xa1, 0x02]));
    expect(first.setupData).toEqual(new Uint8Array([0xa1, 0x03]));
    expect(first.artifactSets[0]).toMatchObject({
      coherence: "same-firmware-volume",
      warnings: [],
    });
    expect(first.artifactSets[0].setupFile.volumeStart).toBe(
      first.artifactSets[0].amitseFile?.volumeStart,
    );
    expect(first.artifactSets[0].setupFile.volumeStart).toBe(
      first.artifactSets[0].setupDataFile?.volumeStart,
    );

    const secondId = first.artifactSets[1].id;
    const second = await extractAptioIvBytes(image, extractIfr, undefined, {
      artifactSetId: secondId,
    });
    expect(second.selectedArtifactSetId).toBe(secondId);
    expect(second.hii).toEqual(new Uint8Array([0xb2, 0x01]));
    expect(second.amitse).toEqual(new Uint8Array([0xb2, 0x02]));
    expect(second.setupData).toEqual(new Uint8Array([0xb2, 0x03]));
  });
});
