import { repairFfsFileChecksum } from "./ffsIntegrity";
import { biosRegionOf } from "./flashDescriptor";
import { type FirmwareEncapsulationEdge, type FirmwareFileReference, type FirmwareProvenanceGraph, assessFirmwareReconstruction } from "./firmwareProvenance";
import { memoizeLzmaEncode } from "./lzmaSection";
import { builtInTianoCodec, memoizeTianoEncode } from "./tianoSection";
import { type ArtifactEdit, type RebuildCodecs, type RebuildEdit, type RebuildOptions, type RebuildRefusal, type RebuildRefusalCode, type RebuildResult, type RebuiltFirmware, type RepairedFile, type SectionLayoutChange, type StreamFormat, allErased, differingOffsets, editInsideBounds, erased, fileKey, fileOfBufferArtifact, formatOf, hex, isBufferEdit, mergeRanges, paddingVerdict, pathOf, reportProgress, sameBytes, siteOf, writeSectionSize } from "./firmwareRebuildCore";
import { verifyRebuiltFirmware } from "./firmwareRebuildVerify";

// Full-image reconstruction (stages 1 to 3): same-size edits to a decoded
// artifact, carried back up to the source image. The edited bytes are written
// into the artifact's decoded buffer, then copied up through each section into
// its parent, repairing the data checksum of every FFS file on the way.
//   - Through an uncompressed section the payload is copied back unchanged.
//   - Through an LZMA section (when an LZMA codec is supplied) the buffer is
//     re-encoded with the original's properties and dictionary. The section
//     may change size only if it is the last one in its file and the bytes
//     after it are erased (0xFF) padding; the file keeps its size.
//   - Through an EFI/Tiano section the buffer is re-encoded in the variant
//     (EFI or Tiano) that reads the original stream back to the original
//     bytes, under the same rules about size and padding.
// Every other length stays put, so no file or volume header moves.
//
// This module only builds and checks an image (fullImageExport.ts drives it
// for the UI). A rebuilt image proves the structure survived, not that the
// firmware will boot: whether the platform's own LZMA or EFI/Tiano decoder
// accepts a re-encoded stream, and the other integrity layers (vendor
// signatures, ME, Boot Guard), are not known to this code. A physical flash is
// the only test.

interface ValidEdit {
  edit: RebuildEdit;
  bufferId: number;
  bufferStart: number;
}

type Propagation =
  | { ok: true; change: SectionLayoutChange }
  | { ok: false; refusal: RebuildRefusal };

// Writes the re-encoded stream of `childCopy` into `parentCopy` in place of
// the section's original payload, resizing the section within its file.
function propagateCompressed(
  edge: FirmwareEncapsulationEdge,
  childOriginal: Uint8Array,
  childCopy: Uint8Array,
  parentOriginal: Uint8Array,
  parentCopy: Uint8Array,
  format: StreamFormat,
): Propagation {
  const owner = edge.ownerFile;
  const at = `the ${format.label} section at ${hex(edge.sectionStart)} of buffer ${String(edge.parentBufferId)}`;
  if (!owner) {
    return { ok: false, refusal: { code: "incomplete-path", message: `${at} is not inside an FFS file.` } };
  }
  if (!allErased(parentOriginal, edge.sectionEnd, owner.end)) {
    return {
      ok: false,
      refusal: {
        code: "section-not-terminal",
        message: `${at} is followed by data other than erased padding, so it cannot change size without moving it.`,
      },
    };
  }
  const room = owner.end - edge.payloadStart;
  const reencoded = format.reencode(parentOriginal.subarray(edge.payloadStart, edge.payloadEnd), childOriginal, childCopy, room);
  if (!reencoded.ok) {
    return { ok: false, refusal: { code: format.recompressionCode, message: `${at}: ${reencoded.message}` } };
  }
  const stream = reencoded.stream;
  if (stream.length > room) {
    return {
      ok: false,
      refusal: {
        code: "compressed-does-not-fit",
        message: `${at} would need ${String(stream.length)} bytes and its file has room for ${String(room)}.`,
      },
    };
  }
  const paddingBefore = owner.end - edge.sectionEnd;
  const paddingAfter = room - stream.length;
  const padding = paddingVerdict(edge, owner.end, edge.payloadStart + stream.length, parentOriginal, owner.volumeStart, format);
  if (!padding.ok) {
    return {
      ok: false,
      refusal: { code: "compressed-padding-change", message: `${at}: ${padding.reason}.` },
    };
  }
  const createdPadding = padding.createdPadding;
  const size = edge.payloadStart - edge.sectionStart + stream.length;
  if (edge.sectionHeaderSize === 4 && size >= 0xffffff) {
    return { ok: false, refusal: { code: "section-too-large", message: `${at} would not fit a 4-byte section header.` } };
  }
  parentCopy.fill(erased, edge.payloadStart, owner.end);
  parentCopy.set(stream, edge.payloadStart);
  writeSectionSize(parentCopy, edge, size);
  return {
    ok: true,
    change: {
      format: format.kind,
      parentBufferId: edge.parentBufferId,
      sectionStart: edge.sectionStart,
      packedBefore: edge.payloadEnd - edge.payloadStart,
      packedAfter: stream.length,
      paddingBefore,
      paddingAfter,
      createdPadding,
    },
  };
}

export function rebuildFirmware(
  graph: FirmwareProvenanceGraph,
  edits: RebuildEdit[],
  options: RebuildOptions = {},
): RebuildResult {
  // The rebuild and its own structural check below encode the same buffers; the
  // codecs remember what they encoded so the second ask costs nothing. The
  // check still decodes every stream afresh, and callers who want it fully
  // independent call verifyRebuiltFirmware with their own codecs.
  const given = options.codecs ?? {};
  const codecs: RebuildCodecs = {
    ...given,
    ...(given.lzma ? { lzma: memoizeLzmaEncode(given.lzma) } : {}),
    tiano: memoizeTianoEncode(given.tiano ?? builtInTianoCodec),
  };
  const refusals: RebuildRefusal[] = [];
  const refuse = (code: RebuildRefusalCode, message: string) => refusals.push({ code, message });
  const nodes = new Map(graph.buffers.map((node) => [node.id, node]));
  const root = nodes.get(graph.rootBufferId);
  if (root?.bytes.length !== graph.sourceSize) {
    return {
      ok: false,
      refusals: [{ code: "incomplete-path", message: "The provenance graph has no intact source image." }],
    };
  }
  const traces = assessFirmwareReconstruction(graph).traces;

  const valid: ValidEdit[] = [];
  for (const [position, edit] of edits.entries()) {
    const label = `Edit ${String(position + 1)}`;
    const site = siteOf(graph, nodes, traces, edit);
    if (!site) {
      refuse("artifact-missing", `${label} names artifact ${String((edit as ArtifactEdit).artifactIndex)}, which this image does not have.`);
      continue;
    }
    if (edit.replacement.length !== edit.expected.length) {
      refuse("size-change", `${label} would change the length of the data; the rebuild cannot resize a section.`);
      continue;
    }
    const bufferStart = site.base + edit.offset;
    if (isBufferEdit(edit) && !fileOfBufferArtifact(graph, edit)) {
      refuse("source-file-elsewhere", `${label}: the FFS file it names is not the file of any artifact the extractor found in buffer ${String(edit.bufferId)}.`);
      continue;
    }
    // An artifact edit stays inside the artifact's payload. A buffer edit in the
    // buffer of its FFS file stays inside that file's body, which is the file
    // repaired; in a buffer decoded from a section it stays inside that buffer
    // (wholly the section's output), and the file must be one the path back to
    // the image passes through (checked with the path below).
    if (!editInsideBounds(edit, site)) {
      refuse("edit-out-of-range", `${label} reaches outside the ${site.label}.`);
      continue;
    }
    const node = nodes.get(site.bufferId);
    if (!node || !site.connected) {
      refuse("incomplete-path", `${label}: the ${site.label} has no complete path back to the source image.`);
      continue;
    }
    if (!sameBytes(node.bytes.subarray(bufferStart, bufferStart + edit.expected.length), edit.expected)) {
      refuse("precondition-mismatch", `${label}: the ${site.label} bytes at ${hex(edit.offset)} are not the bytes the edit expects.`);
      continue;
    }
    valid.push({ edit, bufferId: site.bufferId, bufferStart });
  }

  const byBuffer = new Map<number, ValidEdit[]>();
  for (const item of valid) byBuffer.set(item.bufferId, [...(byBuffer.get(item.bufferId) ?? []), item]);
  for (const [bufferId, items] of byBuffer) {
    const sorted = [...items].sort((left, right) => left.bufferStart - right.bufferStart);
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1];
      if (previous.bufferStart + previous.edit.expected.length > sorted[index].bufferStart) {
        refuse("overlapping-edits", `Two edits overlap at ${hex(sorted[index].bufferStart)} of buffer ${String(bufferId)}.`);
        break;
      }
    }
  }

  // Every file whose data checksum has to be repaired, and every buffer that
  // has to be copied into its parent, found by walking each edited artifact
  // back to the source image.
  const files = new Map<string, FirmwareFileReference>();
  const affected = new Set<number>([graph.rootBufferId]);
  const reported = new Set<string>();
  for (const item of valid) {
    const site = siteOf(graph, nodes, traces, item.edit);
    if (!site) continue;
    const path = pathOf(nodes, graph.rootBufferId, { bufferId: site.bufferId, sourceFile: site.sourceFile, kind: site.label }, codecs);
    for (const problem of path.refusals) {
      if (reported.has(problem.message)) continue;
      reported.add(problem.message);
      refusals.push(problem);
    }
    for (const link of path.links) affected.add(link.childId);
    for (const file of path.files) files.set(fileKey(file), file);
  }

  if (valid.length > 0 && refusals.length === 0) {
    const region = biosRegionOf(root.bytes);
    if (region.kind === "invalid") refuse("descriptor-invalid", region.reason);
  }
  if (refusals.length > 0) return { ok: false, refusals };
  if (valid.length === 0) {
    const image = root.bytes.slice();
    return {
      ok: true,
      value: {
        image,
        buffers: new Map([[graph.rootBufferId, image]]),
        changedRanges: [],
        changedBytes: 0,
        repairedFiles: [],
        layoutChanges: [],
      },
    };
  }

  const copies = new Map<number, Uint8Array>();
  const copyOf = (id: number) => {
    let copy = copies.get(id);
    if (!copy) {
      const node = nodes.get(id);
      if (!node) throw new Error(`Decoded firmware buffer ${String(id)} is unavailable.`);
      copy = node.bytes.slice();
      copies.set(id, copy);
    }
    return copy;
  };
  for (const item of valid) copyOf(item.bufferId).set(item.edit.replacement, item.bufferStart);

  const repairedFiles: RepairedFile[] = [];
  const layoutChanges: SectionLayoutChange[] = [];
  const deepestFirst = [...affected].sort((left, right) => (nodes.get(right)?.depth ?? 0) - (nodes.get(left)?.depth ?? 0));
  for (const id of deepestFirst) {
    const node = nodes.get(id);
    if (!node) continue;
    const copy = copyOf(id);
    for (const file of files.values()) {
      if (file.bufferId !== id) continue;
      const repair = repairFfsFileChecksum(node.bytes, copy, file);
      if (!repair.ok) {
        refuse(repair.code, repair.message);
        continue;
      }
      repairedFiles.push({ bufferId: id, guid: file.guid, fileStart: file.fileStart, changed: repair.changed });
    }
    const edge = node.parent;
    if (!edge) continue;
    // A buffer no edit actually changed leaves its section exactly as the
    // vendor wrote it: re-encoding it would alter bytes nobody asked to alter.
    if (sameBytes(copy, node.bytes)) continue;
    const parentOriginal = nodes.get(edge.parentBufferId);
    const parentCopy = copyOf(edge.parentBufferId);
    // The part of the parent this edge rewrites must still be untouched there:
    // an edit that landed inside it from outside would be overwritten.
    const regionEnd = edge.compression !== "none" && edge.ownerFile ? edge.ownerFile.end : edge.payloadEnd;
    const regionStart = edge.compression !== "none" ? edge.sectionStart : edge.payloadStart;
    if (
      !parentOriginal ||
      !sameBytes(parentCopy.subarray(regionStart, regionEnd), parentOriginal.bytes.subarray(regionStart, regionEnd))
    ) {
      refuse("conflicting-edit", `An edit lands inside the section at ${hex(edge.sectionStart)} that another edit rebuilds.`);
      continue;
    }
    if (edge.compression !== "none") {
      const format = formatOf(edge, codecs);
      if (!format) continue; // refused above by checkEdge
      reportProgress(
        options.onProgress,
        `Re-encoding the ${format.label} section at ${hex(edge.sectionStart)} of buffer ${String(edge.parentBufferId)} (${String(copy.length)} bytes of data)`,
      );
      const propagated = propagateCompressed(edge, node.bytes, copy, parentOriginal.bytes, parentCopy, format);
      if (propagated.ok) layoutChanges.push(propagated.change);
      else refusals.push(propagated.refusal);
    } else {
      parentCopy.set(copy.subarray(0, edge.payloadEnd - edge.payloadStart), edge.payloadStart);
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const image = copyOf(graph.rootBufferId);
  const changed = differingOffsets(root.bytes, image);
  const region = biosRegionOf(root.bytes);
  if (region.kind === "region" && changed.some((offset) => offset < region.start || offset >= region.end)) {
    return {
      ok: false,
      refusals: [
        {
          code: "outside-bios-region",
          message: `The rebuild would change bytes outside the BIOS region ${hex(region.start)}-${hex(region.end)} the flash descriptor declares.`,
        },
      ],
    };
  }
  const value: RebuiltFirmware = {
    image,
    buffers: copies,
    changedRanges: mergeRanges(changed),
    changedBytes: changed.length,
    repairedFiles,
    layoutChanges,
  };
  reportProgress(options.onProgress, "Checking the rebuilt image against the source");
  const problems = verifyRebuiltFirmware(graph, edits, value, { ...options, codecs });
  if (problems.length > 0) {
    return { ok: false, refusals: problems.map((message) => ({ code: "verification-failed", message })) };
  }
  return { ok: true, value };
}

export { type ArtifactEdit, type BufferEdit, type RebuildEdit, isBufferEdit, type RebuildRefusalCode, type RebuildRefusal, type RebuildCodecs, reportProgress, type RebuildOptions, type ByteRange, type RepairedFile, type SectionLayoutChange, type RebuiltFirmware, type RebuildResult, paddingAfterSection, paddingChangeAllowed, volumeErasesToOnes, createsPadding } from "./firmwareRebuildCore";
export { verifyRebuiltFirmware, type ReextractionOptions, verifyByReextraction, bufferLineage } from "./firmwareRebuildVerify";
