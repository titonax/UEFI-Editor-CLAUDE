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
  type FirmwareBufferNode,
  type FirmwareEncapsulationEdge,
  type FirmwareFileReference,
  type FirmwareProvenanceGraph,
} from "./firmwareProvenance";

// Full-image reconstruction, stage 1: same-size edits on a path where every
// encapsulation is uncompressed. The edited bytes are written into the
// artifact's decoded buffer, copied up through each uncompressed section into
// its parent, and the data checksum of every FFS file on the way is repaired.
// Nothing here changes a length, so no section, file or volume header moves.
//
// This module only builds and checks an image. Nothing calls it from the
// export yet, and a rebuilt image proves the structure survived, not that the
// firmware will boot: other integrity layers (vendor signatures, ME, Boot
// Guard) are not known to this code, and a physical flash is the only test of
// those.

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
  | "descriptor-invalid"
  | "outside-bios-region"
  | "verification-failed";

export interface RebuildRefusal {
  code: RebuildRefusalCode;
  message: string;
}

export interface ByteRange {
  start: number;
  // Exclusive.
  end: number;
}

export interface RepairedFile {
  bufferId: number;
  guid: string;
  fileStart: number;
  // The same file in the coordinates of the whole image.
  rootBounds: FfsFileBounds;
  checksumRootOffset: number;
  changed: boolean;
}

export interface RebuiltFirmware {
  image: Uint8Array;
  changedRanges: ByteRange[];
  changedBytes: number;
  repairedFiles: RepairedFile[];
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

// Where a byte of a decoded buffer sits in the whole image. Valid only while
// every edge on the way is uncompressed, which is checked before it is used.
function rootOffsetOf(nodes: Map<number, FirmwareBufferNode>, rootId: number, bufferId: number, offset: number) {
  let id = bufferId;
  let result = offset;
  for (let hops = 0; hops <= nodes.size && id !== rootId; hops++) {
    const edge = nodes.get(id)?.parent;
    if (!edge) return null;
    result += edge.payloadStart;
    id = edge.parentBufferId;
  }
  return id === rootId ? result : null;
}

function compressionName(edge: FirmwareEncapsulationEdge) {
  return edge.compression === "lzma" ? "LZMA" : "EFI/Tiano";
}

function checkEdge(
  edge: FirmwareEncapsulationEdge,
  child: FirmwareBufferNode,
): RebuildRefusal | null {
  const at = `the section at ${hex(edge.sectionStart)} of buffer ${String(edge.parentBufferId)}`;
  if (edge.compression !== "none") {
    return {
      code: "compressed-section",
      message: `${at} is ${compressionName(edge)} compressed, and recompression is not implemented.`,
    };
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

interface ValidEdit {
  edit: ArtifactEdit;
  bufferId: number;
  bufferStart: number;
}

export function rebuildFirmware(graph: FirmwareProvenanceGraph, edits: ArtifactEdit[]): RebuildResult {
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
  const affected = new Set<number>();
  const checkedEdges = new Set<number>();
  for (const item of valid) {
    const artifact = graph.artifacts[item.edit.artifactIndex];
    if (artifact.sourceFile.bufferId !== artifact.bufferId) {
      refuse("source-file-elsewhere", `The ${artifact.kind} payload is not inside a file of its own buffer.`);
      continue;
    }
    files.set(fileKey(artifact.sourceFile), artifact.sourceFile);
    let id = item.bufferId;
    for (let hops = 0; hops <= nodes.size && id !== graph.rootBufferId; hops++) {
      affected.add(id);
      const node = nodes.get(id);
      const edge = node?.parent;
      if (!node || !edge) break;
      if (!checkedEdges.has(id)) {
        checkedEdges.add(id);
        const problem = checkEdge(edge, node);
        if (problem) refusals.push(problem);
      }
      if (edge.ownerFile) files.set(fileKey(edge.ownerFile), edge.ownerFile);
      id = edge.parentBufferId;
    }
  }
  affected.add(graph.rootBufferId);

  if (valid.length > 0 && refusals.length === 0) {
    const region = biosRegionOf(root.bytes);
    if (region.kind === "invalid") refuse("descriptor-invalid", region.reason);
  }
  if (refusals.length > 0) return { ok: false, refusals };
  if (valid.length === 0) {
    return { ok: true, value: { image: root.bytes.slice(), changedRanges: [], changedBytes: 0, repairedFiles: [] } };
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
      const rootStart = rootOffsetOf(nodes, graph.rootBufferId, id, file.fileStart);
      if (rootStart === null) {
        refuse("incomplete-path", `The FFS file at ${hex(file.fileStart)} of buffer ${String(id)} cannot be placed in the image.`);
        continue;
      }
      repairedFiles.push({
        bufferId: id,
        guid: file.guid,
        fileStart: file.fileStart,
        rootBounds: {
          fileStart: rootStart,
          bodyStart: rootStart + (file.bodyStart - file.fileStart),
          end: rootStart + (file.end - file.fileStart),
          headerSize: file.headerSize,
        },
        checksumRootOffset: rootStart + (repair.checksumOffset - file.fileStart),
        changed: repair.changed,
      });
    }
    const edge = node.parent;
    if (edge) {
      const parentOriginal = nodes.get(edge.parentBufferId);
      const parentCopy = copyOf(edge.parentBufferId);
      // The section being rebuilt must still be untouched in its parent: an
      // edit that landed inside it from outside would be overwritten here.
      if (
        !parentOriginal ||
        !sameBytes(
          parentCopy.subarray(edge.payloadStart, edge.payloadEnd),
          parentOriginal.bytes.subarray(edge.payloadStart, edge.payloadEnd),
        )
      ) {
        refuse("conflicting-edit", `An edit lands inside the section at ${hex(edge.sectionStart)} that another edit rebuilds.`);
        continue;
      }
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
    changedRanges: mergeRanges(changed),
    changedBytes: changed.length,
    repairedFiles,
  };
  const problems = verifyRebuiltFirmware(graph, edits, value);
  if (problems.length > 0) {
    return { ok: false, refusals: problems.map((message) => ({ code: "verification-failed", message })) };
  }
  return { ok: true, value };
}

// Checks a rebuilt image against the source it was built from, without
// trusting how it was built: same size, every changed byte explained by an
// edit or a repaired checksum, every replacement in place, every repaired file
// consistent, and (for a complete SPI image) nothing outside the BIOS region.
export function verifyRebuiltFirmware(
  graph: FirmwareProvenanceGraph,
  edits: ArtifactEdit[],
  rebuilt: RebuiltFirmware,
): string[] {
  const problems: string[] = [];
  const nodes = new Map(graph.buffers.map((node) => [node.id, node]));
  const root = nodes.get(graph.rootBufferId);
  if (!root) return ["The provenance graph has no source image."];
  if (rebuilt.image.length !== root.bytes.length) {
    return [`The rebuilt image has size ${String(rebuilt.image.length)}, the source ${String(root.bytes.length)}.`];
  }

  const allowed = new Set<number>();
  for (const [position, edit] of edits.entries()) {
    const artifact = graph.artifacts[edit.artifactIndex] as (typeof graph.artifacts)[number] | undefined;
    if (!artifact) continue;
    const start = rootOffsetOf(nodes, graph.rootBufferId, artifact.bufferId, artifact.payloadStart + edit.offset);
    if (start === null) continue;
    for (let index = 0; index < edit.replacement.length; index++) allowed.add(start + index);
    if (!sameBytes(rebuilt.image.subarray(start, start + edit.replacement.length), edit.replacement)) {
      problems.push(`The replacement of edit ${String(position + 1)} is not in place at ${hex(start)} of the rebuilt image.`);
    }
  }
  for (const file of rebuilt.repairedFiles) {
    if (file.changed) allowed.add(file.checksumRootOffset);
    if (!ffsHeaderChecksumValid(rebuilt.image, file.rootBounds)) {
      problems.push(`The FFS file at ${hex(file.rootBounds.fileStart)} has an invalid header checksum in the rebuilt image.`);
    }
    if (!ffsFileChecksumValid(rebuilt.image, file.rootBounds)) {
      problems.push(`The FFS file at ${hex(file.rootBounds.fileStart)} has an invalid data checksum in the rebuilt image.`);
    }
  }

  const changed = differingOffsets(root.bytes, rebuilt.image);
  const unexplained = changed.filter((offset) => !allowed.has(offset));
  if (unexplained.length > 0) {
    const first = unexplained.slice(0, 3).map(hex).join(", ");
    problems.push(
      `${String(unexplained.length)} byte(s) changed outside the edits and the repaired checksums (first: ${first}).`,
    );
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
  Promise.reject(new Error("recompression is not part of this check"));

const artifactPayloadOf: Record<FirmwareArtifactKind, "hii" | "amitse" | "setupData"> = {
  "setup-hii": "hii",
  amitse: "amitse",
  setupdata: "setupData",
};

// Reads the rebuilt image back with the real extractor and checks that every
// artifact is exactly the source's artifact with the requested edits applied,
// at the same place. This is the independent half of the verification: it does
// not share the rebuild's own bookkeeping.
export async function verifyByReextraction(
  graph: FirmwareProvenanceGraph,
  edits: ArtifactEdit[],
  image: Uint8Array,
  options: { artifactSetId?: string } = {},
): Promise<string[]> {
  let extracted;
  try {
    extracted = await extractAptioIvBytes(image, () => Promise.resolve(""), refuseDecompression, options);
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
