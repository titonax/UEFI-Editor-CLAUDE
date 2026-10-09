import { extractAptioIvBytes, type FirmwareDecompressor } from "./aptioIvExtractor";
import {
  ffsFileChecksumValid,
  ffsHeaderChecksumValid,
  repairFfsFileChecksum,
  type FfsFileBounds,
} from "./ffsIntegrity";
import { biosRegionOf } from "./flashDescriptor";
import {
  assessFirmwareReconstruction,
  type FirmwareArtifactKind,
  type FirmwareArtifactLocation,
  type FirmwareBufferNode,
  type FirmwareEncapsulationEdge,
  type FirmwareFileReference,
  type FirmwareProvenanceGraph,
} from "./firmwareProvenance";
import { readLzmaHeader, reencodeLzma, type LzmaCodec } from "./lzmaSection";
import { builtInTianoCodec, reencodeTiano, tianoStreamProblems, type TianoCodec } from "./tianoSection";

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

export interface ArtifactEdit {
  // Index into `graph.artifacts`.
  artifactIndex: number;
  // Offset inside the artifact's payload, the same offsets the patcher uses.
  offset: number;
  // The bytes the caller believes are there. A mismatch refuses the rebuild.
  expected: Uint8Array;
  replacement: Uint8Array;
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

export interface RebuildOptions {
  codecs?: RebuildCodecs;
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

function hex(value: number) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function fileKey(file: FirmwareFileReference) {
  return `${String(file.bufferId)}:${String(file.fileStart)}`;
}

const erased = 0xff;
// Below this a parent cannot even hold a section header, so a tail that short
// behaves the same however long it is.
const sectionHeaderBytes = 4;

function allErased(bytes: Uint8Array, start: number, end: number) {
  for (let index = start; index < end; index++) if (bytes[index] !== erased) return false;
  return true;
}

// What differs between the compressed formats a section can carry. Everything
// else about resizing a section inside its file is shared.
interface StreamFormat {
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

function lzmaFormat(codec: LzmaCodec): StreamFormat {
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

function tianoFormat(codec: TianoCodec): StreamFormat {
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
function formatOf(edge: FirmwareEncapsulationEdge, codecs: RebuildCodecs): StreamFormat | undefined {
  if (edge.compression === "lzma") return codecs.lzma ? lzmaFormat(codecs.lzma) : undefined;
  if (edge.compression === "standard") return tianoFormat(codecs.tiano ?? builtInTianoCodec);
  return undefined;
}

function checkEdge(
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

interface ArtifactPath {
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
function pathOf(
  nodes: Map<number, FirmwareBufferNode>,
  rootId: number,
  artifact: FirmwareArtifactLocation,
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

function mergeRanges(offsets: number[]): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (const offset of offsets) {
    const last = ranges[ranges.length - 1] as ByteRange | undefined;
    if (last?.end === offset) last.end = offset + 1;
    else ranges.push({ start: offset, end: offset + 1 });
  }
  return ranges;
}

function differingOffsets(a: Uint8Array, b: Uint8Array) {
  const offsets: number[] = [];
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) offsets.push(index);
  return offsets;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function writeSectionSize(bytes: Uint8Array, edge: FirmwareEncapsulationEdge, size: number) {
  if (edge.sectionHeaderSize === 4) {
    bytes[edge.sectionStart] = size & 0xff;
    bytes[edge.sectionStart + 1] = (size >>> 8) & 0xff;
    bytes[edge.sectionStart + 2] = (size >>> 16) & 0xff;
  } else {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(edge.sectionStart + 4, size, true);
  }
}

function readSectionSize(bytes: Uint8Array, edge: FirmwareEncapsulationEdge) {
  if (edge.sectionHeaderSize === 4) {
    return bytes[edge.sectionStart] | (bytes[edge.sectionStart + 1] << 8) | (bytes[edge.sectionStart + 2] << 16);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(edge.sectionStart + 4, true);
}

function alignUp4(value: number) {
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

type PaddingVerdict = { ok: true; createdPadding: boolean } | { ok: false; reason: string };

// Whether the padding a rebuilt section leaves is acceptable. Padding the
// source already had room for (a section header or more) is shown to be
// tolerated and needs nothing. Any padding appearing where the source had less
// than that is "created": it needs a format with evidence for it and a volume
// header that declares erased bytes as ones, and it is reported as created.
function paddingVerdict(
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

interface ValidEdit {
  edit: ArtifactEdit;
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
  edits: ArtifactEdit[],
  options: RebuildOptions = {},
): RebuildResult {
  const codecs = options.codecs ?? {};
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
    const artifact = graph.artifacts[edit.artifactIndex] as (typeof graph.artifacts)[number] | undefined;
    if (!artifact) {
      refuse("artifact-missing", `${label} names artifact ${String(edit.artifactIndex)}, which this image does not have.`);
      continue;
    }
    const length = artifact.payloadEnd - artifact.payloadStart;
    if (edit.replacement.length !== edit.expected.length) {
      refuse("size-change", `${label} would change the length of the data; the rebuild cannot resize a section.`);
      continue;
    }
    if (!Number.isInteger(edit.offset) || edit.offset < 0 || edit.offset + edit.expected.length > length) {
      refuse("edit-out-of-range", `${label} reaches outside the ${artifact.kind} payload.`);
      continue;
    }
    const node = nodes.get(artifact.bufferId);
    if (!node || !traces[edit.artifactIndex].complete) {
      refuse("incomplete-path", `${label}: the ${artifact.kind} artifact has no complete path back to the source image.`);
      continue;
    }
    const bufferStart = artifact.payloadStart + edit.offset;
    if (!sameBytes(node.bytes.subarray(bufferStart, bufferStart + edit.expected.length), edit.expected)) {
      refuse("precondition-mismatch", `${label}: the ${artifact.kind} bytes at ${hex(edit.offset)} are not the bytes the edit expects.`);
      continue;
    }
    valid.push({ edit, bufferId: artifact.bufferId, bufferStart });
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
    const path = pathOf(nodes, graph.rootBufferId, graph.artifacts[item.edit.artifactIndex], codecs);
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
  const problems = verifyRebuiltFirmware(graph, edits, value, options);
  if (problems.length > 0) {
    return { ok: false, refusals: problems.map((message) => ({ code: "verification-failed", message })) };
  }
  return { ok: true, value };
}

function verifyCompressedLink(
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
  edits: ArtifactEdit[],
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
    const artifact = graph.artifacts[edit.artifactIndex] as (typeof graph.artifacts)[number] | undefined;
    if (!artifact) continue;
    const start = artifact.payloadStart + edit.offset;
    const copy = copyOf(artifact.bufferId);
    if (!copy) {
      problems.push(`Buffer ${String(artifact.bufferId)} is missing from the rebuilt image.`);
      continue;
    }
    allow(artifact.bufferId, start, start + edit.replacement.length);
    if (!sameBytes(copy.subarray(start, start + edit.replacement.length), edit.replacement)) {
      problems.push(`The replacement of edit ${String(position + 1)} is not in place at ${hex(start)} of buffer ${String(artifact.bufferId)}.`);
    }
    const path = pathOf(nodes, graph.rootBufferId, artifact, codecs);
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

const refuseDecompression: FirmwareDecompressor = () =>
  Promise.reject(new Error("no decompressor was supplied for this check"));

const artifactPayloadOf: Record<FirmwareArtifactKind, "hii" | "amitse" | "setupData"> = {
  "setup-hii": "hii",
  amitse: "amitse",
  setupdata: "setupData",
};

export interface ReextractionOptions {
  artifactSetId?: string;
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
  edits: ArtifactEdit[],
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
      if (edit.artifactIndex === index) expected.set(edit.replacement, edit.offset);
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
  return problems;
}
