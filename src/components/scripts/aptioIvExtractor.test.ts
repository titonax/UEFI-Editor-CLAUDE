import { describe, expect, it } from "vitest";
import { extractAptioIvArtifacts, extractAptioIvBytes } from "./aptioIvExtractor";

const setupGuid = "899407D7-99FE-43D8-9A21-79EC328CAC21";
const hiiGuid = "97E409E6-4CC1-11D9-81F6-000000000000";

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

// A minimal firmware volume holding exactly one FFS file whose body is
// `section`. The volume header is 0x48 bytes; the extractor only needs the
// _FVH signature, the 64-bit length and the header length to accept it.
function firmwareVolumeWithFile(fileGuid: string, section: Uint8Array) {
  const headerSize = 0x48;
  const fileStart = headerSize;
  const fileSize = 24 + section.length;
  const volumeSize = 0x80 + fileSize;
  const bytes = new Uint8Array(volumeSize);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0x20, BigInt(volumeSize), true);
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28);
  view.setUint16(0x30, headerSize, true);
  writeGuid(bytes, fileStart, fileGuid);
  writeUint24(bytes, fileStart + 20, fileSize);
  bytes.set(section, fileStart + 24);
  return bytes;
}

function setupVolume(hii: Uint8Array) {
  const section = new Uint8Array(4 + 16 + hii.length);
  writeUint24(section, 0, section.length);
  section[3] = 0x18;
  writeGuid(section, 4, hiiGuid);
  section.set(hii, 20);
  return firmwareVolumeWithFile(setupGuid, section);
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
          end: image.length - 0x80 + 0x48,
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
});
