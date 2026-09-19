import {
  ConsoleStdout,
  File as WasiFile,
  OpenFile,
  PreopenDirectory,
  WASI,
} from "@bjorn3/browser_wasi_shim";
import {
  encapsulatedFirmwareSection,
  readFirmwareSection,
  type FirmwareSection,
} from "./firmwareSections";
import type {
  FirmwareArtifactCoherence,
  FirmwareArtifactKind,
  FirmwareArtifactLocation,
  FirmwareArtifactSetSummary,
  FirmwareBufferNode,
  FirmwareFileReference,
  FirmwareProvenanceGraph,
} from "./firmwareProvenance";

const setupGuid = "899407D7-99FE-43D8-9A21-79EC328CAC21";
const amitseGuid = "B1DA0ADF-4F77-4070-A88E-BFFE1C60529A";
const hiiGuid = "97E409E6-4CC1-11D9-81F6-000000000000";
const setupDataGuid = "FE612B72-203C-47B1-8560-A66D946EB371";

export interface AptioIvArtifacts {
  hii: Uint8Array;
  ifrText: string;
  amitse?: Uint8Array;
  setupData?: Uint8Array;
  formPackageCount: number;
  extractionDepth: number;
  // Every coherent Setup/AMITSE/SetupData context this image contains (see
  // locateArtifactSets), and which one these artifacts came from. A modern
  // image can carry more than one firmware slot under the same AMI GUIDs -
  // GUID identity alone never proves two files belong to the same slot.
  artifactSets: FirmwareArtifactSetSummary[];
  selectedArtifactSetId: string;
  // Every decoded buffer on the way from the source image to each artifact,
  // kept so the root-visibility detector can read the Setup PE32 in place
  // and so a future full-image rebuild knows exactly what to put back where.
  provenance: FirmwareProvenanceGraph;
}

export interface AptioIvExtractionOptions {
  artifactSetId?: string;
}

function u24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}

function u64(bytes: Uint8Array, offset: number) {
  const value = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

function align(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}

function hex(value: number, width: number) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function guid(bytes: Uint8Array, offset: number) {
  return `${hex(u32(bytes, offset), 8)}-${hex(u16(bytes, offset + 4), 4)}-${hex(
    u16(bytes, offset + 6),
    4,
  )}-${hex(bytes[offset + 8], 2)}${hex(bytes[offset + 9], 2)}-${Array.from(
    bytes.slice(offset + 10, offset + 16),
    (byte) => hex(byte, 2),
  ).join("")}`;
}

const decompressorModules = new Map<string, Promise<WebAssembly.Module>>();

function loadDecompressor(name: string) {
  let pending = decompressorModules.get(name);
  if (!pending) {
    pending = fetch(`${import.meta.env.BASE_URL}${name}`).then((response) => {
      if (!response.ok) {
        throw new Error(
          `Firmware decompressor WebAssembly could not be loaded (${String(response.status)}).`,
        );
      }
      return WebAssembly.compileStreaming(response);
    });
    decompressorModules.set(name, pending);
  }
  return pending;
}

async function runFirmwareDecompress(
  input: Uint8Array,
  wasmName: string,
  mode: "lzma" | "tiano" | "efi",
) {
  const directory = new Map<string, WasiFile>();
  directory.set("input.bin", new WasiFile(input));
  const messages: string[] = [];
  const wasi = new WASI(
    [wasmName, "input.bin", "output.bin", mode],
    [],
    [
      new OpenFile(new WasiFile([])),
      ConsoleStdout.lineBuffered((line) => messages.push(line)),
      ConsoleStdout.lineBuffered((line) => messages.push(line)),
      new PreopenDirectory(".", directory),
    ],
  );
  const module = await loadDecompressor(wasmName);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const exitCode = wasi.start(
    instance as WebAssembly.Instance & {
      exports: { memory: WebAssembly.Memory; _start: () => unknown };
    },
  );
  const output = directory.get("output.bin");
  if (exitCode !== 0 || !output) {
    throw new Error(
      messages.join("\n") || `Firmware decompressor exited with ${String(exitCode)}.`,
    );
  }
  return output.data;
}

async function firmwareDecompress(
  input: Uint8Array,
  mode: "lzma" | "standard",
) {
  if (mode === "lzma") {
    return runFirmwareDecompress(input, "firmware-decompress.wasm", "lzma");
  }

  const failures: string[] = [];
  for (const algorithm of ["tiano", "efi"] as const) {
    try {
      return await runFirmwareDecompress(
        input,
        "tiano-decompress.wasm",
        algorithm,
      );
    } catch (error) {
      failures.push(
        `${algorithm}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(`EFI/Tiano decompression failed (${failures.join("; ")}).`);
}

function validVolume(bytes: Uint8Array, start: number) {
  if (start + 0x38 > bytes.length) return false;
  const length = u64(bytes, start + 0x20);
  const headerLength = u16(bytes, start + 0x30);
  return (
    bytes[start + 0x28] === 0x5f &&
    bytes[start + 0x29] === 0x46 &&
    bytes[start + 0x2a] === 0x56 &&
    bytes[start + 0x2b] === 0x48 &&
    length >= headerLength &&
    start + length <= bytes.length
  );
}

function findVolumes(bytes: Uint8Array) {
  const volumes: number[] = [];
  for (let signature = 0x28; signature + 4 <= bytes.length; signature += 4) {
    const start = signature - 0x28;
    if (validVolume(bytes, start)) volumes.push(start);
  }
  return volumes;
}

interface FirmwareFileBounds {
  bodyStart: number;
  end: number;
  size: number;
  headerSize: number;
}

// An FFS file header is 24 bytes unless its 24-bit size field is the
// 0xFFFFFF escape, in which case the real size follows as 64 bits and the
// header grows to 32 bytes (FFS3 large files).
function firmwareFileBounds(
  bytes: Uint8Array,
  fileStart: number,
  volumeEnd: number,
): FirmwareFileBounds | null {
  if (fileStart + 24 > volumeEnd) return null;
  const size24 = u24(bytes, fileStart + 20);
  const extended = size24 === 0xffffff;
  const headerSize = extended ? 32 : 24;
  if (fileStart + headerSize > volumeEnd) return null;
  const size = extended ? u64(bytes, fileStart + 24) : size24;
  if (size < headerSize || fileStart + size > volumeEnd) return null;
  return { bodyStart: fileStart + headerSize, end: fileStart + size, size, headerSize };
}

function isEmptyFileHeader(bytes: Uint8Array, fileStart: number) {
  return bytes.slice(fileStart, fileStart + 24).every((byte) => byte === 0xff);
}

// A firmware volume embedded (uncompressed) inside an FFS file body has to
// be reached through that file's section, never treated as a peer of the
// outer volumes: otherwise its provenance would skip the enclosing file and
// section, which a rebuild would need.
function findTopLevelVolumes(bytes: Uint8Array) {
  const volumes = findVolumes(bytes);
  const nested = new Set<number>();
  for (const parentStart of volumes) {
    const parentEnd = parentStart + u64(bytes, parentStart + 0x20);
    let fileStart = parentStart + align(u16(bytes, parentStart + 0x30), 8);
    while (fileStart + 24 <= parentEnd) {
      if (isEmptyFileHeader(bytes, fileStart)) break;
      const file = firmwareFileBounds(bytes, fileStart, parentEnd);
      if (!file) break;
      for (const candidateStart of volumes) {
        if (candidateStart === parentStart) continue;
        const candidateEnd = candidateStart + u64(bytes, candidateStart + 0x20);
        if (candidateStart >= file.bodyStart && candidateEnd <= file.end) {
          nested.add(candidateStart);
        }
      }
      fileStart = parentStart + align(fileStart - parentStart + file.size, 8);
    }
  }
  return volumes.filter((start) => !nested.has(start));
}

interface LocatedFile extends FirmwareFileReference {
  depth: number;
}

// Every buffer decoded so far, keyed by id, plus a cache so the same
// section is never decompressed twice (the BFS below and the per-file
// payload search can both reach it).
// Decodes one encapsulated payload. The browser build runs the WebAssembly
// decompressors; tests and tooling can inject their own.
export type FirmwareDecompressor = (
  input: Uint8Array,
  mode: "lzma" | "standard",
) => Promise<Uint8Array>;

interface ExtractionGraph {
  nodes: Map<number, FirmwareBufferNode>;
  decodedSections: Map<string, number>;
  nextId: number;
  decompress: FirmwareDecompressor;
}

function createExtractionGraph(
  image: Uint8Array,
  decompress: FirmwareDecompressor,
): ExtractionGraph {
  return {
    nodes: new Map([[0, { id: 0, bytes: image, depth: 0 }]]),
    decodedSections: new Map(),
    nextId: 1,
    decompress,
  };
}

function nodeBytes(graph: ExtractionGraph, bufferId: number) {
  const node = graph.nodes.get(bufferId);
  if (!node) {
    throw new Error(`Decoded firmware buffer ${String(bufferId)} is unavailable.`);
  }
  return node.bytes;
}

function fileReference(file: LocatedFile): FirmwareFileReference {
  return {
    bufferId: file.bufferId,
    guid: file.guid,
    volumeStart: file.volumeStart,
    volumeEnd: file.volumeEnd,
    fileStart: file.fileStart,
    bodyStart: file.bodyStart,
    end: file.end,
    headerSize: file.headerSize,
  };
}

function* filesInVolumes(node: FirmwareBufferNode): Generator<LocatedFile> {
  const bytes = node.bytes;
  for (const volumeStart of findTopLevelVolumes(bytes)) {
    const volumeEnd = volumeStart + u64(bytes, volumeStart + 0x20);
    let fileStart = volumeStart + align(u16(bytes, volumeStart + 0x30), 8);
    while (fileStart + 24 <= volumeEnd) {
      if (isEmptyFileHeader(bytes, fileStart)) break;
      const file = firmwareFileBounds(bytes, fileStart, volumeEnd);
      if (!file) break;
      yield {
        bufferId: node.id,
        guid: guid(bytes, fileStart),
        volumeStart,
        volumeEnd,
        fileStart,
        bodyStart: file.bodyStart,
        end: file.end,
        headerSize: file.headerSize,
        depth: node.depth,
      };
      fileStart = volumeStart + align(fileStart - volumeStart + file.size, 8);
    }
  }
}

function findFiles(node: FirmwareBufferNode, wantedGuids: Set<string>) {
  const found: LocatedFile[] = [];
  for (const file of filesInVolumes(node)) {
    if (wantedGuids.has(file.guid)) found.push(file);
  }
  return found;
}

// Decodes an encapsulation section's payload (Compression Section or
// GUID-Defined Section - see firmwareSections.ts) into a new buffer node
// that records exactly which bytes of which parent it came from.
async function decodeEncapsulation(
  graph: ExtractionGraph,
  parent: FirmwareBufferNode,
  section: FirmwareSection,
  ownerFile?: LocatedFile,
) {
  const cacheKey = `${String(parent.id)}:${String(section.start)}:${String(section.end)}`;
  const cachedId = graph.decodedSections.get(cacheKey);
  if (cachedId !== undefined) return graph.nodes.get(cachedId) ?? null;

  const encapsulated = encapsulatedFirmwareSection(parent.bytes, section);
  if (!encapsulated) return null;
  const decoded =
    encapsulated.compression === "none"
      ? encapsulated.bytes
      : await graph.decompress(encapsulated.bytes, encapsulated.compression);
  const node: FirmwareBufferNode = {
    id: graph.nextId++,
    bytes: decoded,
    depth: parent.depth + 1,
    parent: {
      parentBufferId: parent.id,
      sectionStart: section.start,
      sectionEnd: section.end,
      sectionHeaderSize: section.headerSize,
      sectionType: section.type,
      payloadStart: encapsulated.payloadStart,
      payloadEnd: encapsulated.payloadEnd,
      compression: encapsulated.compression,
      definitionGuid: encapsulated.definitionGuid,
      attributes: encapsulated.attributes,
      ownerFile: ownerFile ? fileReference(ownerFile) : undefined,
    },
  };
  graph.nodes.set(node.id, node);
  graph.decodedSections.set(cacheKey, node.id);
  return node;
}

async function nestedBuffers(graph: ExtractionGraph, node: FirmwareBufferNode) {
  const nested: FirmwareBufferNode[] = [];
  for (const file of filesInVolumes(node)) {
    let sectionStart = file.bodyStart;
    while (sectionStart + 4 <= file.end) {
      const section = readFirmwareSection(node.bytes, sectionStart, file.end);
      if (!section) break;
      const child = await decodeEncapsulation(graph, node, section, file);
      if (child) nested.push(child);
      sectionStart = align(section.end, 4);
    }
  }
  return nested;
}

// Breadth-first through the image and every buffer decoded out of it,
// looking for every occurrence of the wanted FFS files (not just the first
// of each GUID - a modern image can carry more than one firmware slot under
// the same AMI GUIDs, so every candidate has to survive long enough for
// locateArtifactSets to tell them apart by provenance, not GUID identity).
async function locateFirmwareFiles(
  image: Uint8Array,
  wantedGuids: string[],
  decompress: FirmwareDecompressor,
) {
  const graph = createExtractionGraph(image, decompress);
  const root = graph.nodes.get(0);
  if (!root) throw new Error("Source image is unavailable.");
  const queue = [root];
  const wanted = new Set(wantedGuids);
  const located = new Map<string, LocatedFile[]>(
    wantedGuids.map((fileGuid) => [fileGuid, []]),
  );
  for (let index = 0; index < queue.length && index < 64; index++) {
    const current = queue[index];
    for (const file of findFiles(current, wanted)) {
      located.get(file.guid)?.push(file);
    }
    queue.push(...(await nestedBuffers(graph, current)));
  }
  return { graph, located };
}

interface CompanionMatch {
  file?: LocatedFile;
  coherence?: Exclude<FirmwareArtifactCoherence, "setup-only">;
  warning?: string;
}

const coherenceRank: Record<Exclude<FirmwareArtifactCoherence, "setup-only">, number> = {
  "same-firmware-volume": 0,
  "same-decoded-buffer": 1,
  "shared-encapsulation-branch": 2,
};

// The chain of buffer ids from the source image (buffer 0) down to
// `bufferId`, following each buffer's own single parent edge.
function bufferLineage(graph: ExtractionGraph, bufferId: number) {
  const lineage: number[] = [];
  const visited = new Set<number>();
  let currentId = bufferId;
  while (!visited.has(currentId)) {
    visited.add(currentId);
    lineage.push(currentId);
    const parent = graph.nodes.get(currentId)?.parent;
    if (!parent) break;
    currentId = parent.parentBufferId;
  }
  return lineage.reverse();
}

// How far two buffers' lineages agree before diverging - 0 means they only
// share the source image itself.
function sharedLineageDepth(graph: ExtractionGraph, leftBufferId: number, rightBufferId: number) {
  const left = bufferLineage(graph, leftBufferId);
  const right = bufferLineage(graph, rightBufferId);
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) {
    depth++;
  }
  return depth;
}

function companionRelationship(graph: ExtractionGraph, setup: LocatedFile, candidate: LocatedFile) {
  if (setup.bufferId === candidate.bufferId && setup.volumeStart === candidate.volumeStart) {
    return { coherence: "same-firmware-volume" as const, sharedDepth: Number.MAX_SAFE_INTEGER };
  }
  if (setup.bufferId === candidate.bufferId) {
    return { coherence: "same-decoded-buffer" as const, sharedDepth: Number.MAX_SAFE_INTEGER };
  }
  return {
    coherence: "shared-encapsulation-branch" as const,
    sharedDepth: sharedLineageDepth(graph, setup.bufferId, candidate.bufferId),
  };
}

// Picks this Setup context's AMITSE/SetupData companion out of every
// occurrence found anywhere in the image: the closest-provenance candidate
// (same FV, then same decoded buffer, then the deepest shared encapsulation
// branch), refusing anything that only shares the source image itself (a
// "shared branch" of depth <= 1) since that's not evidence of belonging to
// the same slot. Two equally close candidates are left unattached rather
// than guessed between - see docs/ami/firmware-context-selection.md.
function selectCompanion(
  graph: ExtractionGraph,
  setup: LocatedFile,
  candidates: LocatedFile[],
  label: string,
): CompanionMatch {
  if (candidates.length === 0) {
    return { warning: `${label} was not found for this Setup context.` };
  }
  const ranked = candidates
    .map((file) => ({ file, ...companionRelationship(graph, setup, file) }))
    .filter(
      (candidate) =>
        candidate.coherence !== "shared-encapsulation-branch" || candidate.sharedDepth > 1,
    )
    .sort(
      (left, right) =>
        coherenceRank[left.coherence] - coherenceRank[right.coherence] ||
        right.sharedDepth - left.sharedDepth,
    );
  if (ranked.length === 0) {
    return {
      warning: `${label} does not share a decoded buffer or encapsulation branch with this Setup context.`,
    };
  }
  const best = ranked[0];
  const tied = ranked.filter(
    (candidate) => candidate.coherence === best.coherence && candidate.sharedDepth === best.sharedDepth,
  );
  if (tied.length !== 1) {
    return {
      warning: `${label} has ${String(tied.length)} equally plausible matches; none was attached across firmware contexts.`,
    };
  }
  return {
    file: best.file,
    coherence: best.coherence,
    warning:
      best.coherence === "same-decoded-buffer"
        ? `${label} is the only buffer-level match outside this Setup firmware volume; verify the selected firmware context before editing.`
        : best.coherence === "shared-encapsulation-branch"
          ? `${label} is the only branch-level match; verify the selected firmware context before editing.`
          : undefined,
  };
}

function artifactSetId(file: LocatedFile) {
  return `buffer-${String(file.bufferId)}-fv-${file.volumeStart.toString(16)}-ffs-${file.fileStart.toString(16)}`;
}

function artifactSetCoherence(matches: CompanionMatch[]): FirmwareArtifactCoherence {
  const relationships = matches.flatMap((match) => (match.coherence ? [match.coherence] : []));
  if (relationships.length === 0) return "setup-only";
  return relationships.sort((left, right) => coherenceRank[right] - coherenceRank[left])[0];
}

type SectionPayloadLocator = (bytes: Uint8Array, section: FirmwareSection) => number | null;

interface LocatedPayload {
  bytes: Uint8Array;
  location: FirmwareArtifactLocation;
}

// A Setup/AMITSE/SetupData FFS file's wanted section (the HII body, a
// freeform blob, or the PE32 executable itself) is not always at the top
// level: it's commonly hidden behind one or more layers of encapsulation
// that must be opened first. This walks a file's section list looking for a
// section `locatePayload` recognizes, recursing into every encapsulation
// section it can open along the way. Real firmware has been seen nesting
// these eight deep (see docs/ami/sample-corpus.md), so recursion is bounded
// rather than unlimited.
async function locateSectionPayload(
  graph: ExtractionGraph,
  file: LocatedFile,
  artifactKind: FirmwareArtifactKind,
  locatePayload: SectionPayloadLocator,
  sourceFile = fileReference(file),
  recursionDepth = 0,
): Promise<LocatedPayload | null> {
  const bytes = nodeBytes(graph, file.bufferId);
  let sectionStart = file.bodyStart;
  while (sectionStart + 4 <= file.end) {
    const section = readFirmwareSection(bytes, sectionStart, file.end);
    if (!section) break;
    const payloadStart = locatePayload(bytes, section);
    if (payloadStart !== null && payloadStart <= section.end) {
      return {
        bytes: bytes.slice(payloadStart, section.end),
        location: {
          kind: artifactKind,
          bufferId: file.bufferId,
          payloadStart,
          payloadEnd: section.end,
          sourceFile,
        },
      };
    }
    if (recursionDepth < 16) {
      const parent = graph.nodes.get(file.bufferId);
      if (!parent) throw new Error("Decoded section parent is missing.");
      // Only a section directly inside the FFS file records that file as
      // its owner; a section found inside an already-decoded buffer has no
      // FFS header of its own around it.
      const nested = await decodeEncapsulation(
        graph,
        parent,
        section,
        recursionDepth === 0 ? file : undefined,
      );
      const result = nested
        ? await locateSectionPayload(
            graph,
            {
              ...file,
              bufferId: nested.id,
              fileStart: 0,
              bodyStart: 0,
              end: nested.bytes.length,
              headerSize: 0,
              depth: nested.depth,
            },
            artifactKind,
            locatePayload,
            sourceFile,
            recursionDepth + 1,
          )
        : null;
      if (result) return result;
    }
    sectionStart = align(section.end, 4);
  }
  return null;
}

function freeformLocator(wantedGuid: string): SectionPayloadLocator {
  return (bytes, section) =>
    section.type === 0x18 &&
    section.size >= section.headerSize + 16 &&
    guid(bytes, section.start + section.headerSize) === wantedGuid
      ? section.start + section.headerSize + 16
      : null;
}

const pe32Locator: SectionPayloadLocator = (_bytes, section) =>
  section.type === 0x10 ? section.start + section.headerSize : null;

function locateHii(graph: ExtractionGraph, file: LocatedFile) {
  return locateSectionPayload(graph, file, "setup-hii", freeformLocator(hiiGuid));
}

function locateSetupData(graph: ExtractionGraph, file: LocatedFile) {
  return locateSectionPayload(graph, file, "setupdata", freeformLocator(setupDataGuid));
}

function locatePe32(
  graph: ExtractionGraph,
  file: LocatedFile,
  artifactKind: Extract<FirmwareArtifactKind, "setup-hii" | "amitse">,
) {
  return locateSectionPayload(graph, file, artifactKind, pe32Locator);
}

interface LocatedArtifactSet {
  summary: FirmwareArtifactSetSummary;
  setup: LocatedFile;
  hii: LocatedPayload;
  amitse: LocatedPayload | null;
  setupData: LocatedPayload | null;
}

// Every usable Setup occurrence in the image, each paired with its best
// AMITSE/SetupData companion (see selectCompanion) and labelled with how
// confidently those companions were matched - one entry per coherent
// firmware context/slot, not one per GUID.
async function locateArtifactSets(graph: ExtractionGraph, files: Map<string, LocatedFile[]>) {
  const setups = [...(files.get(setupGuid) ?? [])].sort(
    (left, right) =>
      left.depth - right.depth ||
      left.bufferId - right.bufferId ||
      left.volumeStart - right.volumeStart ||
      left.fileStart - right.fileStart,
  );
  const sets: LocatedArtifactSet[] = [];
  for (const setup of setups) {
    const hii = (await locateHii(graph, setup)) ?? (await locatePe32(graph, setup, "setup-hii"));
    if (!hii) continue;

    const amitseMatch = selectCompanion(graph, setup, files.get(amitseGuid) ?? [], "AMITSE");
    let setupDataMatch = selectCompanion(
      graph,
      setup,
      files.get(setupDataGuid) ?? [],
      "SetupData",
    );
    const warnings = [amitseMatch.warning].filter((warning): warning is string =>
      Boolean(warning),
    );
    const amitse = amitseMatch.file ? await locatePe32(graph, amitseMatch.file, "amitse") : null;
    if (amitseMatch.file && !amitse) {
      warnings.push("The paired AMITSE FFS does not contain a PE32 section.");
    }
    // SetupData is usually a freeform section inside the AMITSE FFS file,
    // but some images give it its own FFS file under the same GUID instead
    // - try the matched SetupData file first and fall back to AMITSE's.
    let setupData = setupDataMatch.file
      ? await locateSetupData(graph, setupDataMatch.file)
      : null;
    if (!setupData && amitseMatch.file) {
      const embedded = await locateSetupData(graph, amitseMatch.file);
      if (embedded) {
        setupData = embedded;
        setupDataMatch = { file: amitseMatch.file, coherence: amitseMatch.coherence };
      }
    }
    if (setupDataMatch.warning) warnings.push(setupDataMatch.warning);
    if (setupDataMatch.file && !setupData) {
      warnings.push("The paired SetupData source does not contain the expected freeform section.");
    }
    const id = artifactSetId(setup);
    const coherence = artifactSetCoherence([amitseMatch, setupDataMatch]);
    sets.push({
      summary: {
        id,
        label: "",
        coherence,
        setupFile: fileReference(setup),
        amitseFile: amitse ? amitse.location.sourceFile : undefined,
        setupDataFile: setupData ? setupData.location.sourceFile : undefined,
        warnings,
      },
      setup,
      hii,
      amitse,
      setupData,
    });
  }
  for (const [index, set] of sets.entries()) {
    set.summary.label = `Firmware context ${String(index + 1)} · layer ${String(set.setup.depth)} · buffer ${String(set.setup.bufferId)} · FV 0x${set.setup.volumeStart.toString(16).toUpperCase()}`;
  }
  return sets;
}

async function runIfrExtractor(hii: Uint8Array) {
  const directory = new Map<string, WasiFile>();
  directory.set("setup.bin", new WasiFile(hii));
  const stdout: string[] = [];
  const wasi = new WASI(
    ["ifrextractor", "setup.bin", "verbose"],
    [],
    [
      new OpenFile(new WasiFile([])),
      ConsoleStdout.lineBuffered((line) => stdout.push(line)),
      ConsoleStdout.lineBuffered((line) => stdout.push(line)),
      new PreopenDirectory(".", directory),
    ],
  );
  const url = `${import.meta.env.BASE_URL}ifrextractor.wasm`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("IFRExtractor WebAssembly is not available.");
  const module = await WebAssembly.compileStreaming(response);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const exitCode = wasi.start(instance as WebAssembly.Instance & { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  if (exitCode !== 0) throw new Error(stdout.join("\n") || `IFRExtractor exited with ${String(exitCode)}.`);
  const outputs = [...directory.entries()].filter(([name]) => name.endsWith(".ifr.txt"));
  if (outputs.length === 0) throw new Error("IFRExtractor did not generate a verbose IFR file.");
  return outputs.map(([, output]) => new TextDecoder().decode(output.data)).join("\n");
}

// Only the source image and the buffers on some artifact's path back to it
// are kept; every other decoded buffer was a dead end and just costs memory.
function retainArtifactBranches(
  graph: ExtractionGraph,
  artifacts: FirmwareArtifactLocation[],
  sourceSize: number,
): FirmwareProvenanceGraph {
  const retained = new Set<number>([0]);
  for (const artifact of artifacts) {
    let bufferId = artifact.bufferId;
    while (!retained.has(bufferId)) {
      retained.add(bufferId);
      const parent = graph.nodes.get(bufferId)?.parent;
      if (!parent) break;
      bufferId = parent.parentBufferId;
    }
  }

  return {
    rootBufferId: 0,
    sourceSize,
    buffers: [...retained]
      .sort((left, right) => left - right)
      .flatMap((id) => {
        const node = graph.nodes.get(id);
        return node ? [node] : [];
      }),
    artifacts,
  };
}

export async function extractAptioIvBytes(
  image: Uint8Array,
  extractIfr: (hii: Uint8Array) => Promise<string> = runIfrExtractor,
  decompress: FirmwareDecompressor = firmwareDecompress,
  options: AptioIvExtractionOptions = {},
): Promise<AptioIvArtifacts> {
  const { graph, located: files } = await locateFirmwareFiles(
    image,
    [setupGuid, amitseGuid, setupDataGuid],
    decompress,
  );
  if ((files.get(setupGuid) ?? []).length === 0) {
    throw new Error("Setup FFS was not found after recursive decompression.");
  }
  const sets = await locateArtifactSets(graph, files);
  if (sets.length === 0) {
    throw new Error(
      "No Setup context contains a usable HII package or Setup PE32 section.",
    );
  }
  const selected = options.artifactSetId
    ? sets.find((set) => set.summary.id === options.artifactSetId)
    : sets[0];
  if (!selected) {
    throw new Error("The selected firmware context no longer exists in this image.");
  }
  const ifrText = await extractIfr(selected.hii.bytes);
  const formPackageCount = (ifrText.match(/FormSet Guid:/g) ?? []).length;
  const locations = [
    selected.hii.location,
    selected.amitse?.location,
    selected.setupData?.location,
  ].filter((location): location is FirmwareArtifactLocation => location !== undefined);
  return {
    hii: selected.hii.bytes,
    ifrText,
    amitse: selected.amitse?.bytes,
    setupData: selected.setupData?.bytes,
    formPackageCount,
    extractionDepth: selected.setup.depth,
    artifactSets: sets.map((set) => set.summary),
    selectedArtifactSetId: selected.summary.id,
    provenance: retainArtifactBranches(graph, locations, image.length),
  };
}

export async function extractAptioIvArtifacts(
  file: File,
  options: AptioIvExtractionOptions = {},
): Promise<AptioIvArtifacts> {
  return extractAptioIvBytes(
    new Uint8Array(await file.arrayBuffer()),
    runIfrExtractor,
    firmwareDecompress,
    options,
  );
}
