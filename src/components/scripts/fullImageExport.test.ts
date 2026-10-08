import { describe, expect, it, vi } from "vitest";
import { extractAptioIvBytes, type AptioIvArtifacts, type FirmwareDecompressor } from "./aptioIvExtractor";
import { downloadModifiedFiles, computeModifiedFiles } from "./binaryPatcher";
import { changesFromPlan, checkFullImageOutput, planArtifactEdits, type ArtifactChange, type FullImageRequest } from "./fullImageExport";
import {
  compressionSection,
  concat,
  firmwareVolume,
  patternBytes,
  sectionStream,
  setupFiles,
} from "./firmwareImageFixtures";
import { parseData } from "./ifrParser";
import { lzmaJsCodec } from "./lzmaJs";
import { buildPopulatedFilesFromArtifacts } from "./populatedFilesFromArtifacts";
import { sha256Hex } from "./hashing";
import { buildFixtureFiles } from "./testFixtures";
import { decodeTiano, encodeTiano } from "./tianoCodec";

const saveAsMock = vi.hoisted(() => vi.fn());
vi.mock("file-saver", () => ({
  saveAs: (blob: Blob, name: string) => {
    saveAsMock(blob, name);
  },
}));

const noIfr = () => Promise.resolve("");
const checksummed = 0x40;
const erasedTail = (length: number) => new Uint8Array(length).fill(0xff);

function readStandard(input: Uint8Array) {
  for (const variant of ["tiano", "efi"] as const) {
    try {
      return decodeTiano(input, variant);
    } catch {
      // the next variant is tried, as the extractor does
    }
  }
  throw new Error("neither variant reads the stream");
}
const decompress: FirmwareDecompressor = (input, mode) =>
  Promise.resolve(mode === "lzma" ? lzmaJsCodec.decode(input) : readStandard(input));
const deps = { codecs: { lzma: lzmaJsCodec }, decompress };

const payloads = { hii: new Uint8Array(1200).fill(0x41), amitse: patternBytes(64, 2), setupData: patternBytes(48, 3) };
const plain = () => firmwareVolume(setupFiles(payloads, checksummed));

function wrapped(kind: "none" | "lzma" | "efi" | "tiano") {
  if (kind === "none") return plain();
  const inner = plain();
  const stream =
    kind === "lzma" ? lzmaJsCodec.encode(inner, 8) : encodeTiano(inner, kind);
  const section = compressionSection(kind === "lzma" ? 2 : 1, inner.length, stream);
  return firmwareVolume([
    { guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: concat(sectionStream(section), erasedTail(64)) },
  ]);
}

async function requestFor(image: Uint8Array, edit: (kind: "hii" | "setupData") => Uint8Array | null): Promise<{ request: FullImageRequest; artifacts: AptioIvArtifacts }> {
  const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
  const changes: ArtifactChange[] = [];
  const hii = edit("hii");
  if (hii) changes.push({ kind: "setup-hii", fileName: "setup-ami-aptio.bin", original: artifacts.hii, modified: hii, changeLog: "Unsuppressed 0x1A\n" });
  const setupData = edit("setupData");
  if (setupData && artifacts.setupData) {
    changes.push({ kind: "setupdata", fileName: "setupdata-ami-aptio.bin", original: artifacts.setupData, modified: setupData, changeLog: "Access Level 05 -> 00\n" });
  }
  return {
    request: { graph: artifacts.provenance, artifactSetId: artifacts.selectedArtifactSetId, context: artifacts.artifactSets[0], sourceName: "board.rom", changes },
    artifacts,
  };
}

const flip = (bytes: Uint8Array, at: number, length = 4) => bytes.map((byte, index) => (index >= at && index < at + length ? byte ^ 0xff : byte));

describe("checkFullImageOutput", () => {
  for (const kind of ["none", "lzma", "efi", "tiano"] as const) {
    it(`puts the edits back into a ${kind} image and reads it back`, async () => {
      const image = wrapped(kind);
      const { request } = await requestFor(image, (which) => (which === "hii" ? null : null));
      const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
      const withEdits = await requestFor(image, (which) => {
        if (which === "hii") return flip(artifacts.hii, 100);
        return flip(artifacts.setupData ?? new Uint8Array(), 4, 2);
      });
      expect(request.changes).toHaveLength(0);

      const result = await checkFullImageOutput(withEdits.request, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.image.length).toBe(image.length);
      expect(result.summary.changedBytes).toBeGreaterThan(0);
      expect(result.summary.recompressedSections).toBe(kind === "none" ? 0 : 1);
      // The image reads back with the edits, and nothing else moved.
      const again = await extractAptioIvBytes(result.image, noIfr, decompress);
      expect(again.hii).toEqual(flip(artifacts.hii, 100));
      expect(again.amitse).toEqual(artifacts.amitse);
    });
  }

  it("writes a changelog that names every file, the hashes and what is not proven", async () => {
    const image = wrapped("lzma");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : null));

    const result = await checkFullImageOutput(request, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changelog).toContain("Firmware image: board.rom");
    expect(result.changelog).toContain(`Source SHA-256: ${await sha256Hex(image)}`);
    expect(result.changelog).toContain(`Output SHA-256: ${await sha256Hex(result.image)}`);
    expect(result.changelog).toContain("========== setup-ami-aptio.bin ==========");
    expect(result.changelog).toContain("Unsuppressed 0x1A");
    expect(result.changelog).toMatch(/LZMA section re-encoded at 0x[0-9A-F]+ of decoded buffer 0: \d+ -> \d+ bytes/);
    expect(result.changelog).toMatch(/FFS data checksum repaired/);
    expect(result.changelog).toMatch(/NOT tested: this image has not been flashed/);
  });

  it("refuses an empty plan", async () => {
    const { request } = await requestFor(wrapped("none"), () => null);

    expect(await checkFullImageOutput(request, deps)).toMatchObject({ ok: false, stage: "plan" });
  });

  it("refuses an extracted file that is not what the image holds", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : null));
    request.changes[0] = { ...request.changes[0], original: flip(artifacts.hii, 7) };

    const result = await checkFullImageOutput(request, deps);

    expect(result).toMatchObject({ ok: false, stage: "plan" });
    if (!result.ok) expect(result.messages[0]).toMatch(/not what the image holds/);
  });

  it("refuses a change of length", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? artifacts.hii.slice(0, 10) : null));

    const result = await checkFullImageOutput(request, deps);

    expect(result).toMatchObject({ ok: false, stage: "plan" });
    if (!result.ok) expect(result.messages[0]).toMatch(/same-size/);
  });

  it("reports what the rebuild refuses, in its words", async () => {
    // No room after the compressed section for it to grow into.
    const inner = firmwareVolume(setupFiles({ ...payloads, hii: patternBytes(1200, 9) }, checksummed));
    const section = compressionSection(2, inner.length, lzmaJsCodec.encode(inner, 8));
    const image = firmwareVolume([{ guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", attributes: checksummed, body: sectionStream(section) }]);
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const noisy = Uint8Array.from({ length: artifacts.hii.length }, (_, index) => (index * 2654435761) >>> 24);
    const { request } = await requestFor(image, (which) => (which === "hii" ? noisy : null));

    const result = await checkFullImageOutput(request, deps);

    expect(result).toMatchObject({ ok: false, stage: "rebuild" });
  });

  it("does not offer an image the read-back disagrees with", async () => {
    const image = wrapped("lzma");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : null));
    const inside = request.graph.artifacts[0].payloadStart + 500;
    const liar: FirmwareDecompressor = (input, mode) =>
      mode === "lzma" ? Promise.resolve(lzmaJsCodec.decode(input).map((byte, index) => (index === inside ? byte ^ 1 : byte))) : decompress(input, mode);

    const result = await checkFullImageOutput(request, { ...deps, decompress: liar });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(["read-back", "rebuild"]).toContain(result.stage);
  });

  it("does not offer an image whose structural verification fails, even if it reads back", async () => {
    const image = wrapped("lzma");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : null));
    // The encoder answers differently the second time it is asked (the
    // verification's own canonical re-encode): the stream still reads back.
    let calls = 0;
    const unstable = {
      ...lzmaJsCodec,
      encode: (data: Uint8Array, preset: number) => {
        const stream = lzmaJsCodec.encode(data, preset);
        return ++calls % 2 === 0 ? Uint8Array.from([...stream, 0]) : stream;
      },
    };

    const result = await checkFullImageOutput(request, { ...deps, codecs: { lzma: unstable } });

    expect(result).toMatchObject({ ok: false, stage: "rebuild" });
    if (!result.ok) expect(result.messages.join("\n")).toMatch(/canonical re-encoding/);
  });

  it("does not offer anything when the read-back cannot decompress", async () => {
    const image = wrapped("lzma");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : null));
    const none: FirmwareDecompressor = () => Promise.reject(new Error("decoder missing"));

    const result = await checkFullImageOutput(request, { ...deps, decompress: none });

    expect(result).toMatchObject({ ok: false, stage: "read-back" });
  });
});

describe("planArtifactEdits", () => {
  it("bridges small gaps into one edit and keeps far-apart changes separate", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const modified = artifacts.hii.slice();
    modified[100] ^= 1;
    modified[110] ^= 1;
    modified[900] ^= 1;

    const plan = planArtifactEdits(artifacts.provenance, [
      { kind: "setup-hii", fileName: "x", original: artifacts.hii, modified, changeLog: "" },
    ]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits.map((edit) => [edit.offset, edit.expected.length])).toEqual([[100, 11], [900, 1]]);
  });
});

describe("changesFromPlan", () => {
  it("derives the changed files from the applied plan, the way the per-file export does", async () => {
    const fixture = await buildFixtureFiles({ setupdataBin: "00000000", amitseSct: "" });
    const hii = Uint8Array.from(fixture.setupSctContainer.textContent.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
    // The SuppressIf at 0x1A..0x1E ends with the End opcode the patch moves.
    hii.set([0x29, 0x02], 0x1e);
    fixture.setupSctContainer.textContent = Array.from(hii, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
    const image = firmwareVolume(setupFiles({ hii, setupData: new Uint8Array(4) }, checksummed));
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const files = { ...fixture, firmwareSource: { fileName: "board.rom", artifacts, generation: "unresolved" as const } };
    const data = await parseData(files);
    data.suppressions[0].active = false;

    const changes = changesFromPlan(data, files);

    expect(changes.map((change) => change.kind)).toEqual(["setup-hii"]);
    expect(changes[0].changeLog).toMatch(/Unsuppressed/);
    const result = await checkFullImageOutput(
      { graph: artifacts.provenance, artifactSetId: artifacts.selectedArtifactSetId, context: artifacts.artifactSets[0], sourceName: "board.rom", changes },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses files that did not come from a complete image", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    expect(() => changesFromPlan(data, files)).toThrow(/complete firmware image/);
  });

  it("refuses a pending root visibility plan, as the per-file export does", async () => {
    const fixture = await buildFixtureFiles();
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const files = buildPopulatedFilesFromArtifacts(artifacts, "board.rom", "unresolved");
    const data = await parseData(fixture);
    data.rootVisibilityEdits = [
      { kind: "set-root-visibility", rootIndex: 0, formId: "0x1", bufferId: 0, bufferOffset: 0x40, expected: 0, replacement: 1, description: "Show root" },
    ];

    expect(() => changesFromPlan(data, files)).toThrow(/verified full-image reconstruction path/);
  });
});

describe("checkFullImageOutput: what it refuses and what it records", () => {
  it("refuses a change that leaves every byte as it was, however it is flagged", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? artifacts.hii.slice() : null));

    const result = await checkFullImageOutput(request, deps);

    expect(result).toMatchObject({ ok: false, stage: "plan" });
    if (!result.ok) expect(result.messages[0]).toMatch(/changes nothing/);
  });

  it("does not list in the changelog a file the plan flagged but left as it was", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : artifacts.setupData?.slice() ?? null));

    const result = await checkFullImageOutput(request, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changelog).toContain("========== setup-ami-aptio.bin ==========");
    expect(result.changelog).not.toContain("setupdata-ami-aptio.bin");
  });

  it("refuses when the page cannot hash, before the long work", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : null));
    vi.stubGlobal("crypto", {});
    try {
      const result = await checkFullImageOutput(request, deps);

      expect(result).toMatchObject({ ok: false, stage: "plan" });
      if (!result.ok) expect(result.messages[0]).toMatch(/SHA-256/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("changes exactly the bytes of the edits and the repaired checksum, in every artifact at once", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const graph = artifacts.provenance;
    const where = (kind: string) => graph.artifacts.find((one) => one.kind === kind)?.payloadStart ?? -1;
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100, 4) : flip(artifacts.setupData ?? new Uint8Array(), 4, 2)));
    const amitse = artifacts.amitse ?? new Uint8Array();
    request.changes.push({ kind: "amitse", fileName: "amitse.bin", original: amitse, modified: flip(amitse, 8, 2), changeLog: "Menu entry 0x10 -> 0x20\n" });

    const result = await checkFullImageOutput(request, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const differing = Array.from(result.image, (byte, index) => (byte === image[index] ? -1 : index)).filter((index) => index >= 0);
    const edited = new Set([100, 101, 102, 103].map((offset) => where("setup-hii") + offset));
    for (const offset of [4, 5]) edited.add(where("setupdata") + offset);
    for (const offset of [8, 9]) edited.add(where("amitse") + offset);
    const outside = differing.filter((index) => !edited.has(index));
    // The only other changes are the data checksum bytes of the files edited.
    expect(outside.length).toBeLessThanOrEqual(2);
    for (const index of edited) expect(differing).toContain(index);
    expect(result.changelog).toContain("Menu entry 0x10 -> 0x20");
    expect(result.changelog).toContain("========== amitse.bin ==========");
    expect(result.changelog).toContain("========== setupdata-ami-aptio.bin ==========");
  });

  it("names the firmware context it patched, with its warnings", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => (which === "hii" ? flip(artifacts.hii, 100) : null));
    request.context = { ...request.context, warnings: ["Only a branch-level match."] };

    const result = await checkFullImageOutput(request, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changelog).toContain(`Firmware context patched: ${request.context.label} (${request.context.id})`);
    expect(result.changelog).toContain("Warning: Only a branch-level match.");
  });

  it("writes every changelog line of every changed file and counts the ranges it does not list", async () => {
    const image = wrapped("none");
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const { request } = await requestFor(image, (which) => {
      if (which !== "hii") return null;
      const many = artifacts.hii.slice();
      for (let offset = 10; offset < 10 + 70 * 17; offset += 17) many[offset] ^= 1;
      return many;
    });
    request.changes[0].changeLog = "First line\nSecond line\n";

    const result = await checkFullImageOutput(request, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changelog).toContain("First line\nSecond line");
    expect(result.changelog).toMatch(/… \d+ more range\(s\)/);
    expect(result.summary.changedRanges).toBeGreaterThan(64);
  });
});

describe("planArtifactEdits: placement", () => {
  it("bridges a gap of exactly 16 unchanged bytes and not one of 17", async () => {
    const artifacts = await extractAptioIvBytes(wrapped("none"), noIfr, decompress);
    const change = (gap: number) => {
      const modified = artifacts.hii.slice();
      modified[100] ^= 1;
      modified[100 + gap + 1] ^= 1;
      return { kind: "setup-hii" as const, fileName: "x", original: artifacts.hii, modified, changeLog: "" };
    };

    const joined = planArtifactEdits(artifacts.provenance, [change(16)]);
    const apart = planArtifactEdits(artifacts.provenance, [change(17)]);

    expect(joined.ok && joined.edits).toHaveLength(1);
    expect(apart.ok && apart.edits).toHaveLength(2);
  });

  it("refuses a file whose kind the image does not hold", async () => {
    const image = firmwareVolume(setupFiles({ hii: new Uint8Array(1200).fill(0x41) }, checksummed));
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);

    const plan = planArtifactEdits(artifacts.provenance, [
      { kind: "amitse", fileName: "amitse.bin", original: new Uint8Array(4), modified: new Uint8Array(4).fill(1), changeLog: "" },
    ]);

    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.message).toMatch(/no amitse artifact/);
  });
});

describe("parity with the per-file export", () => {
  it("downloads exactly the bytes changesFromPlan starts from", async () => {
    const fixture = await buildFixtureFiles({ setupdataBin: "00000000", amitseSct: "" });
    const hii = Uint8Array.from(fixture.setupSctContainer.textContent.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
    hii.set([0x29, 0x02], 0x1e);
    fixture.setupSctContainer.textContent = Array.from(hii, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
    const image = firmwareVolume(setupFiles({ hii, setupData: new Uint8Array(4) }, checksummed));
    const artifacts = await extractAptioIvBytes(image, noIfr, decompress);
    const files = { ...fixture, firmwareSource: { fileName: "board.rom", artifacts, generation: "unresolved" as const } };
    const data = await parseData(files);
    data.suppressions[0].active = false;

    const changes = changesFromPlan(data, files);

    expect(changes).toHaveLength(1);
    expect(changes[0].modified).toEqual(computeModifiedFiles(data, files).setupSct);
    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);
    const [blob, name] = saveAsMock.mock.calls[0] as [Blob, string];
    expect(name).toBe(files.setupSctContainer.file.name);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(changes[0].modified);
  });
});
