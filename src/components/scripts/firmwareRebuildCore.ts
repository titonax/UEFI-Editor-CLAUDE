import { type FirmwareArtifactLocation, type FirmwareBufferNode, type FirmwareEncapsulationEdge, type FirmwareFileReference, type FirmwareProvenanceGraph, assessFirmwareReconstruction } from "./firmwareProvenance";
import { type LzmaCodec, readLzmaHeader, reencodeLzma } from "./lzmaSection";
import { type TianoCodec, builtInTianoCodec, reencodeTiano, tianoStreamProblems } from "./tianoSection";

// Shared parts of the full-image rebuild (see firmwareRebuild.ts): the edit
// types, where an edit lands, the path from an artifact back to the source
// image, the stream formats and the padding rules. Used by both the rebuild and
// its verification, which must agree on these without sharing the rebuild.

export interface ArtifactEdit {
  // Index into `graph.artifacts`.
  artifactIndex: number;
  // Offset inside the artifact's payload, the same offsets the patcher uses.
  offset: number;
  // The bytes the caller believes are there. A mismatch refuses the rebuild.
  expected: Uint8Array;
  replacement: Uint8Array;
}

// Bytes of one decoded buffer by position, for changes that live outside every
// artifact: the Setup PE32's root registration vector, say. `file` is the FFS
// file of that buffer whose body holds the bytes, so its data checksum is
// repaired; the offset is inside the buffer, not an artifact.
export interface BufferEdit {
  bufferId: number;
  offset: number;
  expected: Uint8Array;
  replacement: Uint8Array;
  file: FirmwareFileReference;
  // What the edit is, for messages.
  label: string;
}

export type RebuildEdit = ArtifactEdit | BufferEdit;

export function isBufferEdit(edit: RebuildEdit): edit is BufferEdit {
  return "bufferId" in edit;
}

// Where an edit lands, whichever kind it is.
export interface EditSite {
  label: string;
  bufferId: number;
  // Where `offset` counts from in the buffer, and the span the edit must stay in.
  base: number;
  spanEnd: number;
  sourceFile: FirmwareFileReference;
  // Whether the buffer has an unbroken path back to the source image.
  connected: boolean;
}

// Whether the edit stays where it is allowed to: an artifact edit inside the
// artifact's payload; a buffer edit in the buffer of its FFS file inside that
// file's body (the file repaired), and in a buffer decoded from a section
// inside that buffer (wholly the section's output; the file must then be one
// the path back to the image passes through, which `pathOf` checks).
export function editInsideBounds(edit: RebuildEdit, site: EditSite) {
  if (!Number.isInteger(edit.offset) || edit.offset < 0) return false;
  const bounded = isBufferEdit(edit) && edit.file.bufferId === edit.bufferId;
  if (bounded && !(Number.isInteger(edit.file.bodyStart) && Number.isInteger(edit.file.end))) return false;
  const lowest = bounded ? edit.file.bodyStart : site.base;
  const highest = bounded ? edit.file.end : site.spanEnd;
  const start = site.base + edit.offset;
  return start >= lowest && start + edit.expected.length <= highest;
}

// The file a buffer edit names has to be the file of an artifact the extractor
// found in that very buffer: the checksum to repair is the one the extractor's
// own trace says depends on those bytes, not whichever file the caller names.
export function fileOfBufferArtifact(graph: FirmwareProvenanceGraph, edit: BufferEdit) {
  return graph.artifacts.some((artifact) => artifact.bufferId === edit.bufferId && fileKey(artifact.sourceFile) === fileKey(edit.file));
}

export function connectedToRoot(nodes: Map<number, FirmwareBufferNode>, rootId: number, id: number) {
  let current = nodes.get(id);
  for (let hops = 0; current && hops <= nodes.size; hops++) {
    if (current.id === rootId) return true;
    current = current.parent ? nodes.get(current.parent.parentBufferId) : undefined;
  }
  return false;
}

export function siteOf(
  graph: FirmwareProvenanceGraph,
  nodes: Map<number, FirmwareBufferNode>,
  traces: ReturnType<typeof assessFirmwareReconstruction>["traces"] | undefined,
  edit: RebuildEdit,
): EditSite | undefined {
  if (isBufferEdit(edit)) {
    return {
      label: edit.label,
      bufferId: edit.bufferId,
      base: 0,
      spanEnd: nodes.get(edit.bufferId)?.bytes.length ?? 0,
      sourceFile: edit.file,
      connected: connectedToRoot(nodes, graph.rootBufferId, edit.bufferId),
    };
  }
  const artifact = graph.artifacts[edit.artifactIndex] as (typeof graph.artifacts)[number] | undefined;
  if (!artifact) return undefined;
  return {
    label: `${artifact.kind} payload`,
    bufferId: artifact.bufferId,
    base: artifact.payloadStart,
    spanEnd: artifact.payloadEnd,
    sourceFile: artifact.sourceFile,
    connected: traces ? traces[edit.artifactIndex].complete : true,
  };
}

export type RebuildRefusalCode =
  | "artifact-missing"
  | "edit-out-of-range"
  | "size-change"
  | "precondition-mismatch"
  | "overlapping-edits"
  | "incomplete-path"
  | "compressed-section"
  | "unsupported-section"
  | "source-file-elsewhere"
  | "conflicting-edit"
  | "invalid-file-header"
  | "invalid-file-checksum"
  | "unsupported-file-attributes"
  | "lzma-recompression"
  | "tiano-recompression"
  | "section-not-terminal"
  | "compressed-does-not-fit"
  | "compressed-padding-change"
  | "section-too-large"
  | "descriptor-invalid"
  | "outside-bios-region"
  | "verification-failed";

export interface RebuildRefusal {
  code: RebuildRefusalCode;
  message: string;
}

export interface RebuildCodecs {
  // Without it, an LZMA section on the path is refused.
  lzma?: LzmaCodec;
  // The EFI/Tiano codec; the built-in one when omitted.
  tiano?: TianoCodec;
}

// A progress report must not be able to decide the outcome silently: if the
// caller's callback throws, the rebuild stops and says so.
export function reportProgress(onProgress: ((message: string) => void) | undefined, message: string) {
  if (!onProgress) return;
  try {
    onProgress(message);
  } catch (error) {
    throw new Error(`The progress report failed (${message}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface RebuildOptions {
  codecs?: RebuildCodecs;
  // Told, in words, what a long step is about to do (rebuildFirmware is
  // synchronous, so this is the only way a caller can show progress).
  onProgress?: (message: string) => void;
}

export interface ByteRange {
  start: number;
  // Exclusive.
  end: number;
}

export interface RepairedFile {
  bufferId: number;
  guid: string;
  // Offset of the file in its own decoded buffer.
  fileStart: number;
  changed: boolean;
}

// One compressed section that changed size inside its file.
export interface SectionLayoutChange {
  format: "lzma" | "standard";
  parentBufferId: number;
  sectionStart: number;
  packedBefore: number;
  packedAfter: number;
  // Bytes of erased padding between the section and the end of its file.
  paddingBefore: number;
  paddingAfter: number;
  // The source left less than a section header of room after the section in its
  // file and the rebuilt one leaves erased padding after it: the firmware has not
  // been shown to accept that, so every report says so.
  createdPadding: boolean;
}

export interface RebuiltFirmware {
  // The whole image; the same bytes as `buffers.get(0)`.
  image: Uint8Array;
  // Every decoded buffer the edits touched, rebuilt, by buffer id.
  buffers: Map<number, Uint8Array>;
  changedRanges: ByteRange[];
  changedBytes: number;
  repairedFiles: RepairedFile[];
  layoutChanges: SectionLayoutChange[];
}

export type RebuildResult =
  | { ok: true; value: RebuiltFirmware }
  | { ok: false; refusals: RebuildRefusal[] };

export function hex(value: number) {
  return `0x${value.toString(16).toUpperCase()}`;
}

export function fileKey(file: FirmwareFileReference) {
  return `${String(file.bufferId)}:${String(file.fileStart)}`;
}

export const erased = 0xff;
// Below this a parent cannot even hold a section header, so a tail that short
// behaves the same however long it is.
export const sectionHeaderBytes = 4;

export function allErased(bytes: Uint8Array, start: number, end: number) {
  for (let index = start; index < end; index++) if (bytes[index] !== erased) return false;
  return true;
}

// What differs between the compressed formats a section can carry. Everything
// else about resizing a section inside its file is shared.
export interface StreamFormat {
  kind: "lzma" | "standard";
  label: string;
  // Whether a stream shorter than the source's may leave erased padding where
  // the source had none. That rests on evidence from real firmware, and has it
  // for LZMA only.
  mayCreatePadding: boolean;
  recompressionCode: "lzma-recompression" | "tiano-recompression";
  // The stream for `decoded` in place of `originalStream` (which decodes to
  // `originalDecoded`), or why there is none.
  // `room` is the most bytes the stream may take in its file.
  reencode(
    originalStream: Uint8Array,
    originalDecoded: Uint8Array,
    decoded: Uint8Array,
    room: number,
  ): { ok: true; stream: Uint8Array } | { ok: false; message: string };
  // What is wrong with `stream` as the replacement, reading it independently.
  streamProblems(
    originalStream: Uint8Array,
    originalDecoded: Uint8Array,
    stream: Uint8Array,
    decoded: Uint8Array,
    room: number,
  ): string[];
}

export function lzmaFormat(codec: LzmaCodec): StreamFormat {
  return {
    kind: "lzma",
    label: "LZMA",
    mayCreatePadding: true,
    recompressionCode: "lzma-recompression",
    reencode: (originalStream, _originalDecoded, decoded, room) =>
      reencodeLzma(originalStream, decoded, codec, { maxBytes: room }),
    streamProblems: (originalStream, _originalDecoded, stream, decoded, room) => {
      const at = "The stream";
      const problems: string[] = [];
      const before = readLzmaHeader(originalStream);
      const after = readLzmaHeader(stream);
      if (!before || !after) {
        problems.push(`${at} does not start with an LZMA header.`);
      } else if (
        after.propsByte !== before.propsByte ||
        after.dictionarySize !== before.dictionarySize ||
        after.uncompressedSize !== BigInt(decoded.length)
      ) {
        problems.push(`${at} does not keep the original's LZMA properties, dictionary size and declared length.`);
      }
      try {
        if (!sameBytes(codec.decode(stream), decoded)) {
          problems.push(`${at} does not decode to the buffer it is meant to carry.`);
        }
      } catch (error) {
        problems.push(`${at} could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Bytes the decoder never reads (after the end of the data) would pass
      // the checks above, so the stream must be exactly what the encoder writes.
      const canonical = reencodeLzma(originalStream, decoded, codec, { maxBytes: room });
      if (!canonical.ok) {
        problems.push(`${at} cannot be re-derived from its buffer: ${canonical.message}`);
      } else if (!sameBytes(stream, canonical.stream)) {
        problems.push(`${at} is not the canonical re-encoding of its buffer (it holds extra or altered bytes).`);
      }
      return problems;
    },
  };
}

export function tianoFormat(codec: TianoCodec): StreamFormat {
  return {
    kind: "standard",
    label: "EFI/Tiano",
    mayCreatePadding: false,
    recompressionCode: "tiano-recompression",
    reencode: (originalStream, originalDecoded, decoded) => reencodeTiano(originalStream, originalDecoded, decoded, codec),
    streamProblems: (originalStream, originalDecoded, stream, decoded) =>
      tianoStreamProblems(originalStream, originalDecoded, stream, decoded, codec),
  };
}

// The format of a compressed edge, or undefined when this rebuild has no codec
// for it.
export function formatOf(edge: FirmwareEncapsulationEdge, codecs: RebuildCodecs): StreamFormat | undefined {
  if (edge.compression === "lzma") return codecs.lzma ? lzmaFormat(codecs.lzma) : undefined;
  if (edge.compression === "standard") return tianoFormat(codecs.tiano ?? builtInTianoCodec);
  return undefined;
}

export function checkEdge(
  edge: FirmwareEncapsulationEdge,
  child: FirmwareBufferNode,
  codecs: RebuildCodecs,
): RebuildRefusal | null {
  const at = `the section at ${hex(edge.sectionStart)} of buffer ${String(edge.parentBufferId)}`;
  if (edge.compression !== "none") {
    const format = formatOf(edge, codecs);
    if (!format) {
      return { code: "compressed-section", message: `${at} is LZMA compressed and no LZMA codec was supplied.` };
    }
    if (edge.ownerFile?.bufferId !== edge.parentBufferId) {
      return {
        code: "incomplete-path",
        message: `${at} is not inside an FFS file, so there is no file end to absorb a change of size.`,
      };
    }
    if (edge.sectionType !== 0x01 && edge.sectionType !== 0x02) {
      return { code: "unsupported-section", message: `${at} has type ${hex(edge.sectionType)}, which is not a ${format.label} wrapper this rebuild handles.` };
    }
    return null;
  }
  if (child.bytes.length !== edge.payloadEnd - edge.payloadStart) {
    return {
      code: "incomplete-path",
      message: `The decoded buffer ${String(child.id)} does not have the length of ${at}.`,
    };
  }
  if (edge.sectionType === 0x02) {
    // A GUID-defined section can carry data that depends on its payload (a
    // CRC32, a signature). Only one with no such data and no attributes is a
    // plain pass-through.
    const dataOffset = edge.payloadStart - edge.sectionStart;
    if (dataOffset !== edge.sectionHeaderSize + 20 || (edge.attributes ?? 0) !== 0) {
      return {
        code: "unsupported-section",
        message: `${at} is a GUID-defined section with data or attributes of its own (a checksum or signature may depend on its payload).`,
      };
    }
    return null;
  }
  if (edge.sectionType !== 0x01 && edge.sectionType !== 0x03) {
    return {
      code: "unsupported-section",
      message: `${at} has type ${hex(edge.sectionType)}, which the rebuild does not pass through.`,
    };
  }
  return null;
}

export interface ArtifactPath {
  // The buffers from the artifact's own up to, but not including, the image,
  // each with the edge that joins it to its parent.
  links: { childId: number; edge: FirmwareEncapsulationEdge }[];
  // The FFS files whose data checksum depends on the artifact's bytes.
  files: FirmwareFileReference[];
  refusals: RebuildRefusal[];
}

// What an edit to this artifact touches on the way back to the source image:
// the links to rebuild, the FFS files to repair, and why the path cannot be
// rebuilt if it cannot. Used both to rebuild and to verify, so the two agree
// on which files must be consistent without sharing the rebuild's bookkeeping.
export function pathOf(
  nodes: Map<number, FirmwareBufferNode>,
  rootId: number,
  artifact: Pick<FirmwareArtifactLocation, "bufferId" | "sourceFile"> & { kind: string },
  codecs: RebuildCodecs,
): ArtifactPath {
  const path: ArtifactPath = { links: [], files: [], refusals: [] };
  let id = artifact.bufferId;
  for (let hops = 0; hops <= nodes.size && id !== rootId; hops++) {
    const node = nodes.get(id);
    const edge = node?.parent;
    if (!node || !edge) break;
    path.links.push({ childId: id, edge });
    const problem = checkEdge(edge, node, codecs);
    if (problem) path.refusals.push(problem);
    if (edge.ownerFile) {
      path.files.push(edge.ownerFile);
    } else if (edge.parentBufferId === rootId) {
      // A section directly in the image with no FFS file around it has no
      // data checksum to repair; the extractor never produces one, so refuse.
      path.refusals.push({
        code: "incomplete-path",
        message: `The section at ${hex(edge.sectionStart)} of the image is not inside an FFS file.`,
      });
    }
    id = edge.parentBufferId;
  }
  // A file in the artifact's own buffer holds the payload directly. A file in
  // an ancestor must be one the walk already reached as an owner.
  if (artifact.sourceFile.bufferId === artifact.bufferId) {
    path.files.push(artifact.sourceFile);
  } else if (!path.files.some((file) => fileKey(file) === fileKey(artifact.sourceFile))) {
    path.refusals.push({
      code: "source-file-elsewhere",
      message: `The ${artifact.kind} payload's file is not on its path back to the image.`,
    });
  }
  return path;
}

export function mergeRanges(offsets: number[]): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (const offset of offsets) {
    const last = ranges[ranges.length - 1] as ByteRange | undefined;
    if (last?.end === offset) last.end = offset + 1;
    else ranges.push({ start: offset, end: offset + 1 });
  }
  return ranges;
}

export function differingOffsets(a: Uint8Array, b: Uint8Array) {
  const offsets: number[] = [];
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) offsets.push(index);
  return offsets;
}

export function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function writeSectionSize(bytes: Uint8Array, edge: FirmwareEncapsulationEdge, size: number) {
  if (edge.sectionHeaderSize === 4) {
    bytes[edge.sectionStart] = size & 0xff;
    bytes[edge.sectionStart + 1] = (size >>> 8) & 0xff;
    bytes[edge.sectionStart + 2] = (size >>> 16) & 0xff;
  } else {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(edge.sectionStart + 4, size, true);
  }
}

export function readSectionSize(bytes: Uint8Array, edge: FirmwareEncapsulationEdge) {
  if (edge.sectionHeaderSize === 4) {
    return bytes[edge.sectionStart] | (bytes[edge.sectionStart + 1] << 8) | (bytes[edge.sectionStart + 2] << 16);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(edge.sectionStart + 4, true);
}

export function alignUp4(value: number) {
  return Math.ceil(value / 4) * 4;
}

// Padding is measured from where the next section would start: sections begin
// on 4-byte boundaries, so a byte or two between a section and that boundary
// is never looked at as a header.
export function paddingAfterSection(sectionEnd: number, fileEnd: number) {
  return Math.max(0, fileEnd - alignUp4(sectionEnd));
}

// Whether a change in the length of the erased padding after a section is
// something the firmware has already shown it tolerates. With room for a
// section header the parser has met this kind of padding; with less it never
// looks, so the padding may change as long as it stays that short.
export function paddingChangeAllowed(before: number, after: number) {
  return before >= sectionHeaderBytes || after < sectionHeaderBytes;
}

// Whether the firmware volume at `volumeStart` declares that erased bytes read
// as ones (EFI_FVB2_ERASE_POLARITY, bit 0x800 of the volume attributes), the
// only evidence this rebuild accepts that 0xFF is what padding in it looks like.
export function volumeErasesToOnes(bytes: Uint8Array, volumeStart: number) {
  if (volumeStart < 0 || volumeStart + 0x30 > bytes.length) return false;
  // Only a real volume header ("_FVH" at +0x28) says anything about erasure.
  if (bytes[volumeStart + 0x28] !== 0x5f || bytes[volumeStart + 0x29] !== 0x46 || bytes[volumeStart + 0x2a] !== 0x56 || bytes[volumeStart + 0x2b] !== 0x48) {
    return false;
  }
  const attributes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(volumeStart + 0x2c, true);
  return (attributes & 0x800) !== 0;
}

// Padding that the source did not have, but that a shorter stream leaves.
export function createsPadding(before: number, after: number) {
  return !paddingChangeAllowed(before, after);
}

export type PaddingVerdict = { ok: true; createdPadding: boolean } | { ok: false; reason: string };

// Whether the padding a rebuilt section leaves is acceptable. Padding the
// source already had room for (a section header or more) is shown to be
// tolerated and needs nothing. Any padding appearing where the source had less
// than that is "created": it needs a format with evidence for it and a volume
// header that declares erased bytes as ones, and it is reported as created.
export function paddingVerdict(
  edge: FirmwareEncapsulationEdge,
  fileEnd: number,
  newEnd: number,
  volumeBytes: Uint8Array,
  volumeStart: number,
  format: StreamFormat,
): PaddingVerdict {
  const alignedBefore = paddingAfterSection(edge.sectionEnd, fileEnd);
  const alignedAfter = paddingAfterSection(newEnd, fileEnd);
  const rawBefore = fileEnd - edge.sectionEnd;
  const rawAfter = fileEnd - newEnd;
  const created = alignedBefore < sectionHeaderBytes && rawAfter > rawBefore;
  if (!created) {
    if (!paddingChangeAllowed(alignedBefore, alignedAfter)) {
      return { ok: false, reason: "its padding would change in a way the source does not show is tolerated" };
    }
    return { ok: true, createdPadding: false };
  }
  if (!format.mayCreatePadding) {
    return {
      ok: false,
      reason: `it would leave ${String(rawAfter)} bytes of padding where there were ${String(rawBefore)}, and creating padding is not accepted for ${format.label} sections (no real ${format.label} firmware has shown it is safe)`,
    };
  }
  if (!volumeErasesToOnes(volumeBytes, volumeStart)) {
    return {
      ok: false,
      reason: `it would leave ${String(rawAfter)} bytes of padding where there were ${String(rawBefore)}, and its firmware volume has no valid header declaring erased bytes as 0xFF, so nothing shows what that padding should be or that the firmware accepts it`,
    };
  }
  return { ok: true, createdPadding: true };
}

