import { type FirmwareSection, encapsulatedFirmwareSection, readFirmwareSection } from "./firmwareSections";
import { type FirmwareArtifactCoherence, type FirmwareArtifactKind, type FirmwareArtifactLocation, type FirmwareArtifactSetSummary, type FirmwareBufferNode, type FirmwareFileReference } from "./firmwareProvenance";
import { align, amitseGuid, findTopLevelVolumes, firmwareFileBounds, guid, hiiGuid, isEmptyFileHeader, setupDataGuid, setupGuid, u16, u64 } from "./aptioIvVolumes";
import { SectionDecodeFailure, type FirmwareDecompressor } from "./aptioIvDecompress";

// Locating the Setup, AMITSE and SetupData artifacts: the graph of decoded
// buffers, encapsulation sections, companion selection between files and the
// artifact sets that result. Reads bytes; runs no extractor.
export interface LocatedFile extends FirmwareFileReference {
  depth: number;
}


export interface ExtractionGraph {
  nodes: Map<number, FirmwareBufferNode>;
  decodedSections: Map<string, number>;
  nextId: number;
  decompress: FirmwareDecompressor;
  // Every SectionDecodeFailure tryDecodeEncapsulation swallowed to keep
  // walking the rest of the image - one bad section (a trapped decompressor,
  // an unsupported scheme) should not cost every other branch's evidence.
  decodeFailures: string[];
  // Decoded buffers left in the breadth-first queue when the search limit was
  // reached. Anything inside them was never looked at, so it is reported
  // instead of being treated as absent.
  unsearchedBuffers: number;
}


// Upper bound on how many buffers (the image plus everything decoded out of
// it) locateFirmwareFiles will search for Setup/AMITSE/SetupData.
export const maxSearchedBuffers = 64;


export function createExtractionGraph(
  image: Uint8Array,
  decompress: FirmwareDecompressor,
): ExtractionGraph {
  return {
    nodes: new Map([[0, { id: 0, bytes: image, depth: 0 }]]),
    decodedSections: new Map(),
    nextId: 1,
    decompress,
    decodeFailures: [],
    unsearchedBuffers: 0,
  };
}


export function nodeBytes(graph: ExtractionGraph, bufferId: number) {
  const node = graph.nodes.get(bufferId);
  if (!node) {
    throw new Error(`Decoded firmware buffer ${String(bufferId)} is unavailable.`);
  }
  return node.bytes;
}


export function fileReference(file: LocatedFile): FirmwareFileReference {
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


export function findFiles(node: FirmwareBufferNode, wantedGuids: Set<string>) {
  const found: LocatedFile[] = [];
  for (const file of filesInVolumes(node)) {
    if (wantedGuids.has(file.guid)) found.push(file);
  }
  return found;
}


// Decodes an encapsulation section's payload (Compression Section or
// GUID-Defined Section - see firmwareSections.ts) into a new buffer node
// that records exactly which bytes of which parent it came from.
export async function decodeEncapsulation(
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
  let decoded: Uint8Array;
  if (encapsulated.compression === "none") {
    decoded = encapsulated.bytes;
  } else {
    try {
      decoded = await graph.decompress(encapsulated.bytes, encapsulated.compression);
    } catch (error) {
      // A bare "decompression rejected the stream" is nearly useless across
      // a 16-32 MiB image with dozens of firmware volumes: name exactly
      // which section failed (its GUID-defined definition when it has one,
      // the owning FFS file, and its offset/size in its parent buffer) so a
      // real corpus failure can be located directly in a byte-level tool
      // instead of hand-scanned for.
      const cause = error instanceof Error ? error.message : String(error);
      const definition = encapsulated.definitionGuid ? ` ${encapsulated.definitionGuid}` : "";
      const owner = ownerFile ? ` in FFS file ${ownerFile.guid}` : "";
      throw new SectionDecodeFailure(
        `Failed to decompress a ${encapsulated.compression}${definition} section${owner} ` +
          `(buffer ${String(parent.id)}, depth ${String(parent.depth)}, offset 0x${section.start.toString(16).toUpperCase()}, size 0x${(section.end - section.start).toString(16).toUpperCase()}): ${cause}`,
      );
    }
  }
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


// Runs decodeEncapsulation but keeps a trapped/rejected decompressor from
// aborting the whole extraction: only a SectionDecodeFailure is swallowed
// (recorded in graph.decodeFailures and treated as "no child here"), so a
// bug or a genuinely unsupported error elsewhere still propagates normally.
export async function tryDecodeEncapsulation(
  graph: ExtractionGraph,
  parent: FirmwareBufferNode,
  section: FirmwareSection,
  ownerFile?: LocatedFile,
) {
  try {
    return await decodeEncapsulation(graph, parent, section, ownerFile);
  } catch (error) {
    if (!(error instanceof SectionDecodeFailure)) throw error;
    graph.decodeFailures.push(error.message);
    return null;
  }
}


export async function nestedBuffers(graph: ExtractionGraph, node: FirmwareBufferNode) {
  const nested: FirmwareBufferNode[] = [];
  for (const file of filesInVolumes(node)) {
    let sectionStart = file.bodyStart;
    while (sectionStart + 4 <= file.end) {
      const section = readFirmwareSection(node.bytes, sectionStart, file.end);
      if (!section) break;
      const child = await tryDecodeEncapsulation(graph, node, section, file);
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
export async function locateFirmwareFiles(
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
  for (let index = 0; index < queue.length && index < maxSearchedBuffers; index++) {
    const current = queue[index];
    for (const file of findFiles(current, wanted)) {
      located.get(file.guid)?.push(file);
    }
    queue.push(...(await nestedBuffers(graph, current)));
  }
  graph.unsearchedBuffers = Math.max(0, queue.length - maxSearchedBuffers);
  return { graph, located };
}


export interface CompanionMatch {
  file?: LocatedFile;
  coherence?: Exclude<FirmwareArtifactCoherence, "setup-only">;
  warning?: string;
}


export const coherenceRank: Record<Exclude<FirmwareArtifactCoherence, "setup-only">, number> = {
  "same-firmware-volume": 0,
  "same-decoded-buffer": 1,
  "shared-encapsulation-branch": 2,
};


// The chain of buffer ids from the source image (buffer 0) down to
// `bufferId`, following each buffer's own single parent edge.
export function bufferLineage(graph: ExtractionGraph, bufferId: number) {
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
export function sharedLineageDepth(graph: ExtractionGraph, leftBufferId: number, rightBufferId: number) {
  const left = bufferLineage(graph, leftBufferId);
  const right = bufferLineage(graph, rightBufferId);
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) {
    depth++;
  }
  return depth;
}


export function companionRelationship(graph: ExtractionGraph, setup: LocatedFile, candidate: LocatedFile) {
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
export function selectCompanion(
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


export function artifactSetId(file: LocatedFile) {
  return `buffer-${String(file.bufferId)}-fv-${file.volumeStart.toString(16)}-ffs-${file.fileStart.toString(16)}`;
}


export function artifactSetCoherence(matches: CompanionMatch[]): FirmwareArtifactCoherence {
  const relationships = matches.flatMap((match) => (match.coherence ? [match.coherence] : []));
  if (relationships.length === 0) return "setup-only";
  return relationships.sort((left, right) => coherenceRank[right] - coherenceRank[left])[0];
}


export type SectionPayloadLocator = (bytes: Uint8Array, section: FirmwareSection) => number | null;


export interface LocatedPayload {
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
export async function locateSectionPayload(
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
      const nested = await tryDecodeEncapsulation(
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


export function freeformLocator(wantedGuid: string): SectionPayloadLocator {
  return (bytes, section) =>
    section.type === 0x18 &&
    section.size >= section.headerSize + 16 &&
    guid(bytes, section.start + section.headerSize) === wantedGuid
      ? section.start + section.headerSize + 16
      : null;
}


export const pe32Locator: SectionPayloadLocator = (_bytes, section) =>
  section.type === 0x10 ? section.start + section.headerSize : null;


export function locateHii(graph: ExtractionGraph, file: LocatedFile) {
  return locateSectionPayload(graph, file, "setup-hii", freeformLocator(hiiGuid));
}


export function locateSetupData(graph: ExtractionGraph, file: LocatedFile) {
  return locateSectionPayload(graph, file, "setupdata", freeformLocator(setupDataGuid));
}


export function locatePe32(
  graph: ExtractionGraph,
  file: LocatedFile,
  artifactKind: Extract<FirmwareArtifactKind, "setup-hii" | "amitse">,
) {
  return locateSectionPayload(graph, file, artifactKind, pe32Locator);
}


export interface LocatedArtifactSet {
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
export async function locateArtifactSets(graph: ExtractionGraph, files: Map<string, LocatedFile[]>) {
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
