import { type AptioIvArtifacts, type FirmwareDecompressor, extractAptioIvBytes } from "./aptioIvExtractor";
import { type FfsFileBounds, ffsFileChecksumValid, ffsHeaderChecksumValid } from "./ffsIntegrity";
import { biosRegionOf } from "./flashDescriptor";
import { type FirmwareArtifactKind, type FirmwareBufferNode, type FirmwareEncapsulationEdge, type FirmwareFileReference, type FirmwareProvenanceGraph } from "./firmwareProvenance";
import { type RebuildEdit, type RebuildOptions, type RebuiltFirmware, type StreamFormat, allErased, differingOffsets, editInsideBounds, fileKey, fileOfBufferArtifact, formatOf, hex, isBufferEdit, mergeRanges, paddingVerdict, pathOf, readSectionSize, sameBytes, siteOf } from "./firmwareRebuildCore";

// Verification of a rebuilt image (see firmwareRebuild.ts): a structural check
// against the source and the edits, and a read-back with the extractor.

export function verifyCompressedLink(
  edge: FirmwareEncapsulationEdge,
  parentCopy: Uint8Array,
  parentOriginal: Uint8Array,
  childCopy: Uint8Array,
  childOriginal: Uint8Array,
  format: StreamFormat | undefined,
): { problems: string[]; packedAfter: number | null; layout: string } {
  const label = format?.label ?? (edge.compression === "lzma" ? "LZMA" : "EFI/Tiano");
  const at = `The ${label} section at ${hex(edge.sectionStart)} of buffer ${String(edge.parentBufferId)}`;
  const owner = edge.ownerFile;
  if (!owner) return { problems: [`${at} is not inside an FFS file.`], packedAfter: null, layout: "" };
  // Nothing changed below this section: it must be the source's own bytes.
  if (
    sameBytes(childCopy, childOriginal) &&
    sameBytes(parentCopy.subarray(edge.sectionStart, owner.end), parentOriginal.subarray(edge.sectionStart, owner.end))
  ) {
    return { problems: [], packedAfter: null, layout: "" };
  }
  if (!format) return { problems: [`${at} cannot be checked without a ${label} codec.`], packedAfter: null, layout: "" };
  const problems: string[] = [];
  const size = readSectionSize(parentCopy, edge);
  const end = edge.sectionStart + size;
  if (end < edge.payloadStart || end > owner.end) {
    return { problems: [`${at} declares a size that does not fit inside its file.`], packedAfter: null, layout: "" };
  }
  if (!allErased(parentOriginal, edge.sectionEnd, owner.end)) {
    problems.push(`${at} was not followed by erased padding in the source.`);
  }
  if (!allErased(parentCopy, end, owner.end)) {
    problems.push(`${at} is not followed by erased padding in the rebuilt image.`);
  }
  const padding = paddingVerdict(edge, owner.end, end, parentOriginal, owner.volumeStart, format);
  if (!padding.ok) problems.push(`${at}: ${padding.reason}.`);
  const stream = parentCopy.slice(edge.payloadStart, end);
  for (const problem of format.streamProblems(
    parentOriginal.subarray(edge.payloadStart, edge.payloadEnd),
    childOriginal,
    stream,
    childCopy,
    owner.end - edge.payloadStart,
  )) {
    problems.push(`${at}: ${problem}`);
  }
  // What a layout report must say, read from the bytes.
  const layout = [
    edge.payloadEnd - edge.payloadStart,
    stream.length,
    owner.end - edge.sectionEnd,
    owner.end - end,
    padding.ok && padding.createdPadding,
  ].join(":");
  return { problems, packedAfter: stream.length, layout };
}

// Checks a rebuilt image against the source it was built from, without
// trusting how it was built. Buffer by buffer: the same length, every changed
// byte explained by an edit, a repaired checksum or a section that was rebuilt
// from its child, and every replacement in place. Link by link: an
// uncompressed section carries its child unchanged, a compressed section
// decodes to its child in the original's format, followed by erased padding. For a
// complete SPI image, nothing outside the BIOS region.
export function verifyRebuiltFirmware(
  graph: FirmwareProvenanceGraph,
  edits: RebuildEdit[],
  rebuilt: RebuiltFirmware,
  options: RebuildOptions = {},
): string[] {
  const codecs = options.codecs ?? {};
  const problems: string[] = [];
  const nodes = new Map(graph.buffers.map((node) => [node.id, node]));
  const root = nodes.get(graph.rootBufferId);
  if (!root) return ["The provenance graph has no source image."];
  if (rebuilt.image.length !== root.bytes.length) {
    return [`The rebuilt image has size ${String(rebuilt.image.length)}, the source ${String(root.bytes.length)}.`];
  }
  const copyOf = (id: number) => (id === graph.rootBufferId ? rebuilt.image : rebuilt.buffers.get(id));

  const allowed = new Map<number, Set<number>>();
  const allow = (bufferId: number, start: number, end: number) => {
    let set = allowed.get(bufferId);
    if (!set) {
      set = new Set<number>();
      allowed.set(bufferId, set);
    }
    for (let index = start; index < end; index++) set.add(index);
  };
  const expectedFiles = new Map<string, FirmwareFileReference>();
  const links = new Map<number, FirmwareEncapsulationEdge>();
  const actualLayouts = new Map<string, string>();
  const reported = new Set<string>();
  for (const [position, edit] of edits.entries()) {
    const site = siteOf(graph, nodes, undefined, edit);
    if (!site) continue;
    const start = site.base + edit.offset;
    if (!editInsideBounds(edit, site)) {
      problems.push(`Edit ${String(position + 1)} reaches outside the ${site.label}.`);
      continue;
    }
    if (isBufferEdit(edit) && !fileOfBufferArtifact(graph, edit)) {
      problems.push(`Edit ${String(position + 1)} names an FFS file that is not the file of any artifact in buffer ${String(edit.bufferId)}.`);
      continue;
    }
    const copy = copyOf(site.bufferId);
    if (!copy) {
      problems.push(`Buffer ${String(site.bufferId)} is missing from the rebuilt image.`);
      continue;
    }
    allow(site.bufferId, start, start + edit.replacement.length);
    if (!sameBytes(copy.subarray(start, start + edit.replacement.length), edit.replacement)) {
      problems.push(`The replacement of edit ${String(position + 1)} is not in place at ${hex(start)} of buffer ${String(site.bufferId)}.`);
    }
    if (!site.connected) {
      problems.push(`The ${site.label} of edit ${String(position + 1)} has no path back to the source image.`);
      continue;
    }
    const path = pathOf(nodes, graph.rootBufferId, { bufferId: site.bufferId, sourceFile: site.sourceFile, kind: site.label }, codecs);
    for (const problem of path.refusals) {
      if (!reported.has(problem.message)) {
        reported.add(problem.message);
        problems.push(problem.message);
      }
    }
    for (const link of path.links) links.set(link.childId, link.edge);
    for (const file of path.files) expectedFiles.set(fileKey(file), file);
  }

  for (const [childId, edge] of links) {
    const parentOriginal = nodes.get(edge.parentBufferId);
    const parentCopy = copyOf(edge.parentBufferId);
    const childCopy = copyOf(childId);
    if (!parentOriginal || !parentCopy || !childCopy) {
      problems.push(`Buffer ${String(childId)} or its parent is missing from the rebuilt image.`);
      continue;
    }
    if (edge.compression === "none") {
      allow(edge.parentBufferId, edge.payloadStart, edge.payloadEnd);
      if (!sameBytes(parentCopy.subarray(edge.payloadStart, edge.payloadEnd), childCopy)) {
        problems.push(`The section at ${hex(edge.sectionStart)} of buffer ${String(edge.parentBufferId)} does not carry its rebuilt child unchanged.`);
      }
    } else if (edge.ownerFile) {
      // Only the section's size field, its payload and the padding behind it
      // may differ; the rest of its header must be the source's.
      const sizeStart = edge.sectionHeaderSize === 4 ? edge.sectionStart : edge.sectionStart + 4;
      allow(edge.parentBufferId, sizeStart, edge.sectionHeaderSize === 4 ? sizeStart + 3 : sizeStart + 4);
      allow(edge.parentBufferId, edge.payloadStart, edge.ownerFile.end);
      const childOriginal = nodes.get(childId);
      if (!childOriginal) {
        problems.push(`Buffer ${String(childId)} is missing from the source graph.`);
        continue;
      }
      const link = verifyCompressedLink(edge, parentCopy, parentOriginal.bytes, childCopy, childOriginal.bytes, formatOf(edge, codecs));
      problems.push(...link.problems);
      if (link.packedAfter !== null) {
        actualLayouts.set(`${String(edge.parentBufferId)}:${String(edge.sectionStart)}`, link.layout);
      }
    }
  }

  // Every file the edits depend on must be consistent in the rebuilt buffer,
  // whether or not the rebuild says it repaired it.
  for (const file of expectedFiles.values()) {
    const copy = copyOf(file.bufferId);
    if (!copy) {
      problems.push(`Buffer ${String(file.bufferId)} is missing from the rebuilt image.`);
      continue;
    }
    allow(file.bufferId, file.fileStart + 17, file.fileStart + 18);
    const bounds: FfsFileBounds = file;
    if (!ffsHeaderChecksumValid(copy, bounds)) {
      problems.push(`The FFS file at ${hex(file.fileStart)} of buffer ${String(file.bufferId)} has an invalid header checksum in the rebuilt image.`);
    }
    if (!ffsFileChecksumValid(copy, bounds)) {
      problems.push(`The FFS file at ${hex(file.fileStart)} of buffer ${String(file.bufferId)} has an invalid data checksum in the rebuilt image.`);
    }
    if (!rebuilt.repairedFiles.some((one) => one.bufferId === file.bufferId && one.fileStart === file.fileStart)) {
      problems.push(`The FFS file at ${hex(file.fileStart)} of buffer ${String(file.bufferId)} was not among the files the rebuild repaired.`);
    }
  }

  const rebuiltIds = new Set<number>([graph.rootBufferId, ...rebuilt.buffers.keys(), ...allowed.keys()]);
  for (const id of rebuiltIds) {
    const original = nodes.get(id);
    const copy = copyOf(id);
    if (!original || !copy) continue;
    if (copy.length !== original.bytes.length) {
      problems.push(`Buffer ${String(id)} changed length from ${String(original.bytes.length)} to ${String(copy.length)}.`);
      continue;
    }
    const permitted = allowed.get(id);
    const unexplained = differingOffsets(original.bytes, copy).filter((offset) => !permitted?.has(offset));
    if (unexplained.length > 0) {
      const first = unexplained.slice(0, 3).map(hex).join(", ");
      problems.push(
        `${String(unexplained.length)} byte(s) of buffer ${String(id)} changed outside the edits and the repaired checksums (first: ${first}).`,
      );
    }
  }

  const changed = differingOffsets(root.bytes, rebuilt.image);
  // What the rebuild reports about itself must match what the bytes show.
  const rootCopy = rebuilt.buffers.get(graph.rootBufferId);
  if (rootCopy && !sameBytes(rootCopy, rebuilt.image)) {
    problems.push("The rebuilt buffers hold a different image than the one returned.");
  }
  if (rebuilt.changedBytes !== changed.length) {
    problems.push(`The rebuild reports ${String(rebuilt.changedBytes)} changed byte(s); the image differs in ${String(changed.length)}.`);
  }
  if (JSON.stringify(rebuilt.changedRanges) !== JSON.stringify(mergeRanges(changed))) {
    problems.push("The reported changed ranges are not the ranges in which the image differs from the source.");
  }
  const reportedLayouts = new Map(
    rebuilt.layoutChanges.map((change) => [
      `${String(change.parentBufferId)}:${String(change.sectionStart)}`,
      [change.packedBefore, change.packedAfter, change.paddingBefore, change.paddingAfter, change.createdPadding].join(":"),
    ]),
  );
  if (
    reportedLayouts.size !== actualLayouts.size ||
    [...actualLayouts].some(([key, layout]) => reportedLayouts.get(key) !== layout)
  ) {
    problems.push("The reported layout changes of compressed sections are not the ones in the rebuilt image.");
  }
  const region = biosRegionOf(root.bytes);
  if (region.kind === "region" && changed.some((offset) => offset < region.start || offset >= region.end)) {
    problems.push("A byte changed outside the BIOS region the flash descriptor declares.");
  } else if (region.kind === "invalid" && changed.length > 0) {
    problems.push(region.reason);
  }
  return problems;
}

export const refuseDecompression: FirmwareDecompressor = () =>
  Promise.reject(new Error("no decompressor was supplied for this check"));

export const artifactPayloadOf: Record<FirmwareArtifactKind, "hii" | "amitse" | "setupData"> = {
  "setup-hii": "hii",
  amitse: "amitse",
  setupdata: "setupData",
};

export interface ReextractionOptions {
  artifactSetId?: string;
  // Extra checks on what the read-back found, by a caller who knows what else
  // the edits were meant to change (for example a fresh code analysis of the
  // root registration vector). Each string is a problem.
  inspect?: (extracted: AptioIvArtifacts) => string[];
  // The decompressor used to read the rebuilt image back. In the app this is
  // the project's WebAssembly decoder, which shares no code with the encoder;
  // without one, any compressed section on the way makes the check fail.
  decompress?: FirmwareDecompressor;
}

// Reads the rebuilt image back with the real extractor and checks that every
// artifact is exactly the source's artifact with the requested edits applied,
// at the same place. This is the independent half of the verification: it does
// not share the rebuild's own bookkeeping.
export async function verifyByReextraction(
  graph: FirmwareProvenanceGraph,
  edits: RebuildEdit[],
  image: Uint8Array,
  options: ReextractionOptions = {},
): Promise<string[]> {
  let extracted;
  try {
    extracted = await extractAptioIvBytes(
      image,
      () => Promise.resolve(""),
      options.decompress ?? refuseDecompression,
      options.artifactSetId === undefined ? {} : { artifactSetId: options.artifactSetId },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`The rebuilt image could not be read back: ${reason}`];
  }
  const problems: string[] = [];
  for (const [index, artifact] of graph.artifacts.entries()) {
    const node = graph.buffers.find((buffer) => buffer.id === artifact.bufferId);
    if (!node) continue;
    const expected = node.bytes.slice(artifact.payloadStart, artifact.payloadEnd);
    for (const edit of edits) {
      if (isBufferEdit(edit)) {
        // A buffer edit that lands inside this artifact's payload is part of it.
        const at = edit.offset - artifact.payloadStart;
        if (edit.bufferId === artifact.bufferId && at >= 0 && at + edit.replacement.length <= expected.length) {
          expected.set(edit.replacement, at);
        }
      } else if (edit.artifactIndex === index) {
        expected.set(edit.replacement, edit.offset);
      }
    }
    const actual = extracted[artifactPayloadOf[artifact.kind]];
    if (!actual) {
      problems.push(`The ${artifact.kind} artifact was not found when the rebuilt image was read back.`);
    } else if (!sameBytes(actual, expected)) {
      problems.push(`The ${artifact.kind} artifact reads back differently from the requested edit.`);
    }
    const found = extracted.provenance.artifacts.find((one) => one.kind === artifact.kind);
    if (
      found &&
      (found.payloadStart !== artifact.payloadStart ||
        found.payloadEnd !== artifact.payloadEnd ||
        found.sourceFile.fileStart !== artifact.sourceFile.fileStart)
    ) {
      problems.push(`The ${artifact.kind} artifact moved when the rebuilt image was read back.`);
    }
  }
  problems.push(...bufferEditProblems(graph, edits, extracted));
  if (options.inspect) problems.push(...options.inspect(extracted));
  return problems;
}

// The way into a buffer from the source image, by the sections that hold it:
// stable across a rebuild, unlike buffer ids, which are numbered as the
// extractor meets them.
export function bufferLineage(graph: FirmwareProvenanceGraph, id: number): string | null {
  return lineageOf(new Map(graph.buffers.map((node) => [node.id, node])), graph.rootBufferId, id);
}

export function lineageOf(nodes: Map<number, FirmwareBufferNode>, rootId: number, id: number): string | null {
  const steps: string[] = [];
  let current = nodes.get(id);
  for (let hops = 0; current && hops <= nodes.size; hops++) {
    if (current.id === rootId) return steps.reverse().join(">");
    const edge = current.parent;
    if (!edge) return null;
    steps.push(`${edge.compression}/${String(edge.sectionType)}/${String(edge.sectionStart)}/${String(edge.payloadStart)}`);
    current = nodes.get(edge.parentBufferId);
  }
  return null;
}

// Each buffer edit must be found, by the same way into its buffer, in what the
// extractor reads out of the rebuilt image.
export function bufferEditProblems(graph: FirmwareProvenanceGraph, edits: RebuildEdit[], extracted: AptioIvArtifacts): string[] {
  const problems: string[] = [];
  const before = new Map(graph.buffers.map((node) => [node.id, node]));
  const after = new Map(extracted.provenance.buffers.map((node) => [node.id, node]));
  for (const edit of edits) {
    if (!isBufferEdit(edit)) continue;
    const lineage = lineageOf(before, graph.rootBufferId, edit.bufferId);
    const found =
      lineage === null
        ? undefined
        : extracted.provenance.buffers.find((node) => lineageOf(after, extracted.provenance.rootBufferId, node.id) === lineage);
    if (!found) {
      problems.push(`The buffer of "${edit.label}" was not found when the rebuilt image was read back.`);
    } else if (!sameBytes(found.bytes.subarray(edit.offset, edit.offset + edit.replacement.length), edit.replacement)) {
      problems.push(`"${edit.label}" reads back differently from the requested edit.`);
    }
  }
  return problems;
}

