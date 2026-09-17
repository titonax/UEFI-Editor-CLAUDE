// Binary-level discovery of HII Forms Packages (the containers of the IFR
// opcode stream) inside a Setup HII buffer, independent of the IFRExtractor
// text dump. Used to characterize a Setup layout before parsing (how many
// packages, which FormSet GUIDs) and to find the package boundaries a
// cross-package Ref move has to keep balanced.

const HII_PACKAGE_FORMS = 0x02;
const HII_PACKAGE_END = 0xdf;
const HII_PACKAGE_HEADER_SIZE = 4;
const HII_PACKAGE_LIST_HEADER_SIZE = 20;

const OPCODE_FORM = 0x01;
const OPCODE_FORM_SET = 0x0e;
const OPCODE_REF = 0x0f;
const OPCODE_END = 0x29;

export interface HiiFormsPackage {
  offset: number;
  end: number;
  length: number;
  payloadOffset: number;
  // Offset of the EFI_HII_PACKAGE_LIST_HEADER this package sits in, or null
  // for a bare package with no list around it.
  packageListOffset: number | null;
  formSetGuids: string[];
  formCount: number;
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
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

interface OpcodeStreamSummary {
  formSetGuids: string[];
  formCount: number;
}

// Walks an IFR opcode stream checking it is well-formed: every opcode's
// declared length fits, every scope opened is closed by exactly one End,
// and the opcodes this app relies on (FormSet, Form, Ref) are at least as
// long as their fixed fields. Returns null for anything else so a stray
// 0x02 byte in unrelated data is never mistaken for a Forms Package.
function summarizeOpcodeStream(
  bytes: Uint8Array,
  start: number,
  end: number,
): OpcodeStreamSummary | null {
  const formSetGuids: string[] = [];
  let formCount = 0;
  let depth = 0;
  let cursor = start;

  while (cursor < end) {
    if (cursor + 2 > end) return null;
    const opcode = bytes[cursor];
    const length = bytes[cursor + 1] & 0x7f;
    const scoped = (bytes[cursor + 1] & 0x80) !== 0;
    if (length < 2 || cursor + length > end) return null;

    if (opcode === OPCODE_END) {
      if (scoped || length !== 2 || depth === 0) return null;
      depth--;
    } else {
      if (opcode === OPCODE_FORM_SET) {
        if (length < 23) return null;
        formSetGuids.push(guid(bytes, cursor + 2));
      } else if (opcode === OPCODE_FORM) {
        if (length < 6) return null;
        formCount++;
      } else if (opcode === OPCODE_REF && length < 15) {
        return null;
      }
      if (scoped) depth++;
    }
    cursor += length;
  }

  return depth === 0 ? { formSetGuids, formCount } : null;
}

function formsPackageAt(
  bytes: Uint8Array,
  offset: number,
  length: number,
  packageListOffset: number | null,
): HiiFormsPackage | null {
  const payloadOffset = offset + HII_PACKAGE_HEADER_SIZE;
  const end = offset + length;
  const summary = summarizeOpcodeStream(bytes, payloadOffset, end);
  return summary
    ? { offset, end, length, payloadOffset, packageListOffset, ...summary }
    : null;
}

interface PackageListScan {
  packages: HiiFormsPackage[];
  // A list is only trusted when it ends with an END package exactly at its
  // declared length; a truncated or inconsistent list still yields the
  // packages read before the inconsistency, but is not "well formed".
  wellFormed: boolean;
  length: number;
}

function scanPackageList(bytes: Uint8Array, listOffset: number): PackageListScan | null {
  if (listOffset < 0 || listOffset + HII_PACKAGE_LIST_HEADER_SIZE > bytes.length) {
    return null;
  }
  const listLength = u32(bytes, listOffset + 16);
  if (
    listLength < HII_PACKAGE_LIST_HEADER_SIZE ||
    listOffset + listLength > bytes.length
  ) {
    return null;
  }

  const packages: HiiFormsPackage[] = [];
  const listEnd = listOffset + listLength;
  let cursor = listOffset + HII_PACKAGE_LIST_HEADER_SIZE;
  let wellFormed = false;
  while (cursor + HII_PACKAGE_HEADER_SIZE <= listEnd) {
    const packageLength = u24(bytes, cursor);
    const packageType = bytes[cursor + 3];
    if (packageLength < HII_PACKAGE_HEADER_SIZE || cursor + packageLength > listEnd) {
      break;
    }
    if (packageType === HII_PACKAGE_FORMS) {
      const formsPackage = formsPackageAt(bytes, cursor, packageLength, listOffset);
      if (!formsPackage) break;
      packages.push(formsPackage);
    }
    cursor += packageLength;
    if (packageType === HII_PACKAGE_END) {
      wellFormed = packageLength === HII_PACKAGE_HEADER_SIZE && cursor === listEnd;
      break;
    }
  }
  return { packages, wellFormed, length: listLength };
}

// The package whose opcode stream contains `offset`, if any.
export function packageContaining(packages: HiiFormsPackage[], offset: number) {
  return packages.find((pkg) => offset >= pkg.payloadOffset && offset < pkg.end);
}

// Finds every Forms Package in a Setup HII buffer: the package list the
// buffer itself is (the usual freeform HII body), a bare Forms Package at
// offset 0, and then any well-formed package lists or bare FormSet-led
// packages embedded anywhere inside (the Setup PE32 case, where the HII
// data sits in the executable's resources). Sorted by offset, no duplicates.
export function scanHiiFormsPackages(bytes: Uint8Array): HiiFormsPackage[] {
  const packages: HiiFormsPackage[] = [];
  const knownOffsets = new Set<number>();
  const add = (candidate: HiiFormsPackage) => {
    if (!knownOffsets.has(candidate.offset)) {
      knownOffsets.add(candidate.offset);
      packages.push(candidate);
    }
  };

  const leadingList = scanPackageList(bytes, 0);
  if (leadingList) {
    leadingList.packages.forEach(add);
  } else if (
    bytes.length >= HII_PACKAGE_HEADER_SIZE &&
    bytes[3] === HII_PACKAGE_FORMS
  ) {
    const length = u24(bytes, 0);
    const bare =
      length >= HII_PACKAGE_HEADER_SIZE && length <= bytes.length
        ? formsPackageAt(bytes, 0, length, null)
        : null;
    if (bare) add(bare);
  }

  let cursor = 0;
  while (cursor + HII_PACKAGE_LIST_HEADER_SIZE <= bytes.length) {
    const list = scanPackageList(bytes, cursor);
    if (list?.wellFormed && list.packages.length > 0) {
      list.packages.forEach(add);
      cursor += list.length;
    } else {
      cursor++;
    }
  }

  cursor = 0;
  while (cursor + HII_PACKAGE_HEADER_SIZE <= bytes.length) {
    const length = u24(bytes, cursor);
    const candidate =
      bytes[cursor + 3] === HII_PACKAGE_FORMS &&
      length >= HII_PACKAGE_HEADER_SIZE + 2 &&
      cursor + length <= bytes.length &&
      bytes[cursor + HII_PACKAGE_HEADER_SIZE] === OPCODE_FORM_SET
        ? formsPackageAt(bytes, cursor, length, null)
        : null;
    if (candidate && candidate.formSetGuids.length > 0 && candidate.formCount > 0) {
      add(candidate);
      cursor += length;
    } else {
      cursor++;
    }
  }

  return packages.sort((left, right) => left.offset - right.offset);
}
