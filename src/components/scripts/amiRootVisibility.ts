import { readFirmwareSection } from "./firmwareSections";
import type {
  FirmwareArtifactLocation,
  FirmwareBufferNode,
  FirmwareProvenanceGraph,
} from "./firmwareProvenance";
import type { AmiRootVisibilityEntry, AmiRootVisibilityReport, Menu } from "./types";

// Some AMI Setup executables keep one Boolean byte per HII FormSet: 01 keeps
// the corresponding root page, 00 drops it from the live Setup page list.
// This is a root-page registration mechanism inside the Setup PE32, not an
// IFR SuppressIf. The bytes follow IFR FormSet order.
//
// The GUID commonly catalogued as AMITSE "user password valid" tends to sit
// near the vector, but corpus samples place it before, after or well away
// from it (and it also appears in single-FormSet images that have no vector
// at all), so it is only ever a landmark here, never the detector. The
// detector instead follows the x86-64 loop that consumes the vector: two
// RIP-relative LEAs (vector and a companion page table), a compare of each
// byte with zero, a one-byte vector step, a 0x20-byte table step, a
// backward branch, and a loop count equal to the parsed FormSet count.

const PE_MACHINE_X64 = 0x8664;
const PE32_PLUS_MAGIC = 0x20b;
const PE_SECTION_HEADER_SIZE = 40;
const PE_MEM_EXECUTE = 0x20000000;
const PE_MEM_WRITE = 0x80000000;
const PAGE_RECORD_STRIDE = 0x20;
const MECHANISM = "setup-pe32-root-byte-vector";
const AMITSE_USER_PASSWORD_VALID_GUID = Uint8Array.from([
  0xee, 0x2e, 0x20, 0x71, 0x53, 0x5f, 0xd9, 0x40, 0xab, 0x3d, 0x9e, 0x0c, 0x26, 0xd9,
  0x66, 0x57,
]);

interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawStart: number;
  rawSize: number;
  characteristics: number;
}

interface PeImage {
  start: number;
  end: number;
  imageBase: number;
  sections: PeSection[];
}

interface RootVectorCandidate {
  bufferId: number;
  vectorOffset: number;
  codeOffset: number;
  pageTableOffset: number;
  values: number[];
  countEvidence: "immediate" | "data";
  landmarkOffset?: number;
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

function i32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(
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

function sectionName(bytes: Uint8Array, offset: number) {
  let name = "";
  for (let index = offset; index < Math.min(offset + 8, bytes.length); index++) {
    if (bytes[index] === 0) break;
    name += String.fromCharCode(bytes[index]);
  }
  return name;
}

function parsePeImage(bytes: Uint8Array, start: number, end: number): PeImage | null {
  if (
    start < 0 ||
    end > bytes.length ||
    start + 0x40 > end ||
    bytes[start] !== 0x4d ||
    bytes[start + 1] !== 0x5a
  ) {
    return null;
  }

  const peHeader = start + u32(bytes, start + 0x3c);
  if (
    peHeader + 24 > end ||
    bytes[peHeader] !== 0x50 ||
    bytes[peHeader + 1] !== 0x45 ||
    bytes[peHeader + 2] !== 0 ||
    bytes[peHeader + 3] !== 0 ||
    u16(bytes, peHeader + 4) !== PE_MACHINE_X64
  ) {
    return null;
  }

  const sectionCount = u16(bytes, peHeader + 6);
  const optionalHeaderSize = u16(bytes, peHeader + 20);
  const optionalHeader = peHeader + 24;
  const sectionTable = optionalHeader + optionalHeaderSize;
  if (
    optionalHeader + optionalHeaderSize > end ||
    optionalHeaderSize < 32 ||
    u16(bytes, optionalHeader) !== PE32_PLUS_MAGIC ||
    sectionCount === 0 ||
    sectionCount > 96 ||
    sectionTable + sectionCount * PE_SECTION_HEADER_SIZE > end
  ) {
    return null;
  }

  const imageBase = u64(bytes, optionalHeader + 24);
  if (imageBase === 0) return null;

  const sections: PeSection[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const header = sectionTable + index * PE_SECTION_HEADER_SIZE;
    const rawSize = u32(bytes, header + 16);
    const rawStart = start + u32(bytes, header + 20);
    if (rawSize === 0 || rawStart < start || rawStart + rawSize > end) continue;
    sections.push({
      name: sectionName(bytes, header),
      virtualSize: u32(bytes, header + 8),
      virtualAddress: u32(bytes, header + 12),
      rawStart,
      rawSize,
      characteristics: u32(bytes, header + 36),
    });
  }

  return sections.length > 0 ? { start, end, imageBase, sections } : null;
}

function mapAddressToOffset(pe: PeImage, address: number) {
  const rva = address - pe.imageBase;
  if (!Number.isSafeInteger(rva) || rva < 0) return null;
  for (const section of pe.sections) {
    const mappedSize = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva >= section.virtualAddress + mappedSize) {
      continue;
    }
    const delta = rva - section.virtualAddress;
    return delta < section.rawSize ? section.rawStart + delta : null;
  }
  return null;
}

function sectionContaining(pe: PeImage, offset: number) {
  return pe.sections.find(
    (section) => offset >= section.rawStart && offset < section.rawStart + section.rawSize,
  );
}

function isExecutable(section: PeSection) {
  return (section.characteristics & PE_MEM_EXECUTE) !== 0;
}

function isWritable(section: PeSection) {
  return (section.characteristics & PE_MEM_WRITE) !== 0;
}

// Resolves the target of a 7-byte `lea reg, [rip+disp32]` at `instructionOffset`.
function resolveRipRelativeTarget(bytes: Uint8Array, pe: PeImage, instructionOffset: number) {
  const instructionSection = sectionContaining(pe, instructionOffset);
  if (!instructionSection || instructionOffset + 7 > pe.end) return null;
  const instructionRva =
    instructionSection.virtualAddress + instructionOffset - instructionSection.rawStart;
  const nextAddress = pe.imageBase + instructionRva + 7;
  return mapAddressToOffset(pe, nextAddress + i32(bytes, instructionOffset + 3));
}

function indexOfSequence(
  bytes: Uint8Array,
  sequence: ArrayLike<number>,
  start: number,
  end: number,
) {
  const limit = Math.min(end, bytes.length) - sequence.length;
  outer: for (let offset = Math.max(0, start); offset <= limit; offset++) {
    for (let index = 0; index < sequence.length; index++) {
      if (bytes[offset + index] !== sequence[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function findAll(bytes: Uint8Array, needle: Uint8Array, start: number, end: number) {
  const matches: number[] = [];
  let cursor = start;
  while (cursor + needle.length <= end) {
    const match = indexOfSequence(bytes, needle, cursor, end);
    if (match < 0) break;
    matches.push(match);
    cursor = match + 1;
  }
  return matches;
}

// A short (jb/jne rel8) or near (jb/jne rel32) branch with a negative
// displacement somewhere in [start, end) - the loop's back edge.
function hasBackwardBranch(bytes: Uint8Array, start: number, end: number) {
  for (let offset = start; offset + 2 <= end; offset++) {
    if (
      (bytes[offset] === 0x72 || bytes[offset] === 0x75) &&
      (bytes[offset + 1] & 0x80) !== 0
    ) {
      return true;
    }
    if (
      offset + 6 <= end &&
      bytes[offset] === 0x0f &&
      (bytes[offset + 1] === 0x82 || bytes[offset + 1] === 0x85) &&
      i32(bytes, offset + 2) < 0
    ) {
      return true;
    }
  }
  return false;
}

// `mov r32, imm32` with the FormSet count, shortly before the vector LEA.
function hasImmediateCount(
  bytes: Uint8Array,
  rootCount: number,
  textStart: number,
  vectorLea: number,
) {
  for (let offset = Math.max(textStart, vectorLea - 192); offset + 5 <= vectorLea; offset++) {
    if (bytes[offset] >= 0xb8 && bytes[offset] <= 0xbf && u32(bytes, offset + 1) === rootCount) {
      return true;
    }
  }
  return false;
}

// `mov r32, [rip+disp32]` loading a 32-bit value equal to the FormSet count
// from the image's own data.
function hasDataCount(
  bytes: Uint8Array,
  pe: PeImage,
  rootCount: number,
  start: number,
  end: number,
) {
  for (let offset = Math.max(0, start); offset + 6 <= Math.min(end, pe.end); offset++) {
    if (bytes[offset] !== 0x8b || (bytes[offset + 1] & 0xc7) !== 0x05) continue;
    const instructionSection = sectionContaining(pe, offset);
    if (!instructionSection) continue;
    const instructionRva =
      instructionSection.virtualAddress + offset - instructionSection.rawStart;
    const target = mapAddressToOffset(
      pe,
      pe.imageBase + instructionRva + 6 + i32(bytes, offset + 2),
    );
    if (target !== null && target + 4 <= pe.end && u32(bytes, target) === rootCount) {
      return true;
    }
  }
  return false;
}

function nearestLandmark(bytes: Uint8Array, pe: PeImage, vectorOffset: number) {
  return pe.sections
    .filter(isWritable)
    .flatMap((section) =>
      findAll(
        bytes,
        AMITSE_USER_PASSWORD_VALID_GUID,
        section.rawStart,
        section.rawStart + section.rawSize,
      ),
    )
    .map((offset) => ({ offset, distance: Math.abs(offset - vectorOffset) }))
    .filter(({ distance }) => distance <= 0x400)
    .sort((left, right) => left.distance - right.distance)[0]?.offset;
}

function scanPeForRootVector(
  bytes: Uint8Array,
  pe: PeImage,
  bufferId: number,
  rootCount: number,
) {
  const candidates: RootVectorCandidate[] = [];
  for (const text of pe.sections.filter(isExecutable)) {
    const textEnd = text.rawStart + text.rawSize;
    for (let vectorLea = text.rawStart; vectorLea + 14 <= textEnd; vectorLea++) {
      // Two consecutive `lea r64, [rip+disp32]` into different registers.
      const vectorModRm = bytes[vectorLea + 2];
      if (
        bytes[vectorLea] !== 0x48 ||
        bytes[vectorLea + 1] !== 0x8d ||
        (vectorModRm & 0xc7) !== 0x05
      ) {
        continue;
      }
      const vectorRegister = (vectorModRm >> 3) & 0x07;
      const tableLea = vectorLea + 7;
      const tableModRm = bytes[tableLea + 2];
      if (
        bytes[tableLea] !== 0x48 ||
        bytes[tableLea + 1] !== 0x8d ||
        (tableModRm & 0xc7) !== 0x05
      ) {
        continue;
      }
      const tableRegister = (tableModRm >> 3) & 0x07;
      if (tableRegister === vectorRegister) continue;

      const vectorOffset = resolveRipRelativeTarget(bytes, pe, vectorLea);
      const pageTableOffset = resolveRipRelativeTarget(bytes, pe, tableLea);
      if (vectorOffset === null || pageTableOffset === null) continue;
      const vectorSection = sectionContaining(pe, vectorOffset);
      const tableSection = sectionContaining(pe, pageTableOffset);
      if (
        !vectorSection ||
        !tableSection ||
        !isWritable(vectorSection) ||
        !isWritable(tableSection) ||
        vectorOffset + rootCount > vectorSection.rawStart + vectorSection.rawSize ||
        pageTableOffset + (rootCount - 1) * PAGE_RECORD_STRIDE + 8 >
          tableSection.rawStart + tableSection.rawSize
      ) {
        continue;
      }

      const values = [...bytes.slice(vectorOffset, vectorOffset + rootCount)];
      if (values.length !== rootCount || !values.every((value) => value <= 1)) continue;
      if (!values.includes(1)) continue;

      // The consuming loop: `cmp byte [vectorReg], 0`, `inc vectorReg`,
      // `add tableReg, 0x20`, then a backward branch.
      const loopStart = tableLea + 7;
      const loopEnd = Math.min(loopStart + 96, textEnd);
      const comparison = indexOfSequence(
        bytes,
        [0x80, 0x38 | vectorRegister, 0x00],
        loopStart,
        loopEnd,
      );
      const searchFrom = comparison < 0 ? loopStart : comparison;
      const vectorIncrement = indexOfSequence(
        bytes,
        [0x48, 0xff, 0xc0 | vectorRegister],
        searchFrom,
        loopEnd,
      );
      const tableStride = indexOfSequence(
        bytes,
        [0x48, 0x83, 0xc0 | tableRegister, PAGE_RECORD_STRIDE],
        searchFrom,
        loopEnd,
      );
      if (
        comparison < 0 ||
        vectorIncrement < comparison ||
        tableStride < comparison ||
        !hasBackwardBranch(bytes, Math.max(vectorIncrement, tableStride), loopEnd)
      ) {
        continue;
      }

      const countEvidence: RootVectorCandidate["countEvidence"] | null =
        hasImmediateCount(bytes, rootCount, text.rawStart, vectorLea)
          ? "immediate"
          : hasDataCount(bytes, pe, rootCount, vectorLea - 96, loopEnd)
            ? "data"
            : null;
      if (!countEvidence) continue;

      candidates.push({
        bufferId,
        vectorOffset,
        codeOffset: vectorLea,
        pageTableOffset,
        values,
        countEvidence,
        landmarkOffset: nearestLandmark(bytes, pe, vectorOffset),
      });
    }
  }
  return candidates;
}

// Every PE32 section of the Setup FFS file (or of the decoded buffer the
// artifact was found in, when it isn't the file's own buffer).
function setupPeImages(node: FirmwareBufferNode, artifact: FirmwareArtifactLocation) {
  const { start, end } =
    artifact.bufferId === artifact.sourceFile.bufferId
      ? { start: artifact.sourceFile.bodyStart, end: artifact.sourceFile.end }
      : { start: 0, end: node.bytes.length };
  const images: PeImage[] = [];
  let cursor = start;
  while (cursor + 4 <= end) {
    const section = readFirmwareSection(node.bytes, cursor, end);
    if (!section) break;
    if (section.type === 0x10) {
      const pe = parsePeImage(node.bytes, section.start + section.headerSize, section.end);
      if (pe) images.push(pe);
    }
    cursor = align(section.end, 4);
  }
  return images;
}

function entriesFor(roots: Menu, candidate: RootVectorCandidate): AmiRootVisibilityEntry[] {
  return roots.map((root, index) => ({
    rootIndex: index,
    name: root.name,
    formId: root.formId,
    formSetGuid: root.formSetGuid,
    value: candidate.values[index] === 1 ? 1 : 0,
    visible: candidate.values[index] === 1,
    bufferOffset: candidate.vectorOffset + index,
  }));
}

function unresolved(reason: string): AmiRootVisibilityReport {
  return { status: "unresolved", mechanism: MECHANISM, confidence: "unresolved", reason, entries: [] };
}

export function inspectAmiRootVisibility(
  roots: Menu,
  provenance: FirmwareProvenanceGraph,
): AmiRootVisibilityReport {
  if (roots.length <= 1) {
    return {
      status: "not-applicable",
      mechanism: MECHANISM,
      confidence: "corroborated",
      reason:
        "The HII uses one FormSet. Its menus are Forms inside that FormSet, so no per-FormSet root vector is required. This describes the HII layout; it does not identify or exclude an Aptio generation.",
      entries: [],
    };
  }

  const artifact = provenance.artifacts.find((candidate) => candidate.kind === "setup-hii");
  const node = provenance.buffers.find((candidate) => candidate.id === artifact?.bufferId);
  if (!artifact || !node) {
    return unresolved("The Setup HII provenance branch is incomplete.");
  }

  let candidates: RootVectorCandidate[];
  try {
    candidates = setupPeImages(node, artifact).flatMap((pe) =>
      scanPeForRootVector(node.bytes, pe, node.id, roots.length),
    );
  } catch {
    return unresolved("The Setup PE32 layout could not be validated safely.");
  }

  const uniqueCandidates = [
    ...new Map(
      candidates.map((candidate) => [
        `${String(candidate.bufferId)}:${String(candidate.vectorOffset)}`,
        candidate,
      ]),
    ).values(),
  ];
  if (uniqueCandidates.length === 0) {
    return unresolved(
      "No code-referenced Boolean vector matched the FormSet count and the 0x20-byte page-table loop.",
    );
  }
  if (uniqueCandidates.length > 1) {
    return {
      status: "ambiguous",
      mechanism: MECHANISM,
      confidence: "unresolved",
      reason: `${String(uniqueCandidates.length)} code-referenced vectors matched; no root state was selected.`,
      entries: [],
    };
  }

  const candidate = uniqueCandidates[0];
  return {
    status: "detected",
    mechanism: MECHANISM,
    confidence: "corroborated",
    reason:
      "Setup code consumes one Boolean byte per IFR FormSet and removes pages whose byte is zero.",
    vector: {
      bufferId: candidate.bufferId,
      offset: candidate.vectorOffset,
      length: roots.length,
      codeReferenceOffset: candidate.codeOffset,
      pageTableOffset: candidate.pageTableOffset,
      countEvidence: candidate.countEvidence,
      landmarkOffset: candidate.landmarkOffset,
    },
    entries: entriesFor(roots, candidate),
  };
}
